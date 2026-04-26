// =============================================================
// Layout Planner -- vanilla JS
// One state object, one render pass per change. Persists to
// localStorage on every change. Loads layouts from layouts/*.json.
// =============================================================

const LAYOUT_FILES = [
  { slug: "wa-pixel-bridge",   path: "layouts/wa-pixel-bridge.json"   },
  { slug: "godot-hud-example", path: "layouts/godot-hud-example.json" },
];
const LS_KEY        = "layout-planner.state.v1";
const LS_LAST_LAYOUT = "layout-planner.lastLayout";

// =============================================================
// Realtime sync (server-coordinated, optional)
//
// When the page is served by serve.py, both this browser AND any external
// process (e.g. Claude Code editing current-state.json directly) can read +
// write the layout, with changes propagated in near-realtime via SSE.
//
// Protocol invariants (mirrored in serve.py):
//   - Version is server-assigned. We send the version we last KNEW about;
//     server validates + increments.
//   - We optimistically apply local mutations to the UI immediately. After a
//     debounce, we POST. Server's version-bumped echo (via SSE or POST 200) is
//     canonical.
//   - SSE updates received during a drag are queued and applied on dragend
//     (drop intermediate). This avoids snapping the element out from under
//     the user mid-drag.
//   - On 409 conflict the server returns canonical state; we apply it and
//     LOSE our local change. Single-user system, "last writer wins" with
//     server arbitrating order.
// =============================================================
const sync = {
  enabled: false,             // becomes true on successful initial fetch
  localVersion: 0,            // last server version we know about
  dragInProgress: false,      // mouse-button-down on a drag/resize
  pendingSseEvent: null,      // latest queued SSE event during drag
  postTimer: null,            // setTimeout handle for the 500ms debounce
  postInFlight: false,        // a POST is currently awaiting response
  postPending: false,         // another change came in while postInFlight; chase it
  evtSource: null,            // EventSource instance
  reconnectAttempts: 0,
};
const SYNC_DEBOUNCE_MS = 500;

// ----- State -----
const state = {
  layout: null,            // current layout object (mutated in place)
  layoutSlug: null,        // active layout key
  builtins: {},            // slug -> loaded JSON
  selection: new Set(),    // selected element ids
  zoom: 1,
  pan:  { x: 0, y: 0 },    // canvas-stage translate, in viewport pixels
  bgImage: null,
  bgOpacity: 0.8,
  isPanning: false,
  spaceDown: false,
  drag: null,              // { mode, startMouse, startEls }
};

// ----- DOM -----
const $ = (id) => document.getElementById(id);
const stage      = $("canvas-stage");
const viewport   = $("canvas-viewport");
const elementsLayer = $("elements-layer");
const gridLayer  = $("grid-layer");
const bgCanvas   = $("bg-canvas");
const marqueeEl  = $("marquee");
const outlineEl  = $("outline");
const propsEl    = $("props");
const layoutSel  = $("layout-select");
const hudCoords  = $("hud-coords");
const status     = $("status");

// =============================================================
// Boot
// =============================================================
init();

async function init() {
  // Populate layouts dropdown
  for (const l of LAYOUT_FILES) {
    const opt = document.createElement("option");
    opt.value = l.slug;
    opt.textContent = l.slug;
    layoutSel.appendChild(opt);
  }

  // Load all built-in layouts (best-effort)
  for (const l of LAYOUT_FILES) {
    try {
      const r = await fetch(l.path, { cache: "no-store" });
      if (r.ok) state.builtins[l.slug] = await r.json();
    } catch (e) {
      console.warn(`Could not load ${l.path}:`, e);
    }
  }

  // Restore from localStorage if present, otherwise pick last layout (or first)
  const saved = localStorage.getItem(LS_KEY);
  const lastSlug = localStorage.getItem(LS_LAST_LAYOUT) || LAYOUT_FILES[0].slug;
  if (saved) {
    try {
      const obj = JSON.parse(saved);
      state.layout = obj.layout;
      state.layoutSlug = obj.slug || lastSlug;
    } catch (e) {
      console.warn("Bad localStorage state, resetting:", e);
    }
  }
  if (!state.layout) {
    state.layoutSlug = lastSlug;
    state.layout = deepClone(state.builtins[lastSlug] || newBlankLayout());
  }
  layoutSel.value = state.layoutSlug;

  $("canvas-w").value = state.layout.canvas.width;
  $("canvas-h").value = state.layout.canvas.height;
  $("grid-size").value = state.layout.canvas.gridSize ?? 8;
  $("bar-x").value    = state.layout.exportConfig?.barX ?? -55;
  $("bar-y").value    = state.layout.exportConfig?.barY ?? 0;

  recomputeAllGroupBboxes();
  bindUi();
  centerStage();
  renderAll();
  updateUndoButtons();
  setStatus(`Loaded "${state.layoutSlug}" (${state.layout.elements.length} elements).`);

  // Stale-state detection: if the on-disk file for the active layout has a
  // higher `version` than the localStorage-saved copy, the user is looking at
  // an outdated layout. Prompt to reload. Bumping `version` in the JSON file
  // is how we "publish" updates that should propagate to existing browsers.
  // Done last so the UI is fully bound before the modal appears.
  maybePromptVersionUpgrade();

  // Realtime sync. Only meaningful when served by serve.py; if /state 404s
  // we silently stay in static-only mode.
  await syncInit();
}

// =============================================================
// Sync implementation
// =============================================================
async function syncInit() {
  setSyncStatus("connecting");
  try {
    const r = await fetch("/state", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    sync.localVersion = Number(body.version) || 0;
    if (body.state) {
      // Server has a non-null state -- this becomes our active layout.
      // Don't go through commitOp; this isn't a user mutation.
      // Deep-clone to avoid mutation aliasing with the parsed fetch body.
      state.layout = deepClone(body.state);
      // Sync the form widgets to the new layout
      $("canvas-w").value = state.layout.canvas.width;
      $("canvas-h").value = state.layout.canvas.height;
      $("grid-size").value = state.layout.canvas.gridSize ?? 8;
      $("bar-x").value = state.layout.exportConfig?.barX ?? -55;
      $("bar-y").value = state.layout.exportConfig?.barY ?? 0;
      recomputeAllGroupBboxes();
      persist();
      clearHistory();
      renderAll();
      setStatus(`Loaded state from server (v${sync.localVersion}).`);
    }
    sync.enabled = true;
    syncOpenEventSource();
  } catch (e) {
    // Server unreachable / not a sync server. Fall back to static-only mode.
    console.info("[sync] disabled (no server):", e.message);
    setSyncStatus("disconnected", "static-only");
  }
}

function syncOpenEventSource() {
  if (sync.evtSource) {
    try { sync.evtSource.close(); } catch (_) {}
  }
  const es = new EventSource("/events");
  sync.evtSource = es;

  es.addEventListener("open", () => {
    sync.reconnectAttempts = 0;
    setSyncStatus("connected");
    // On (re)connect always GET /state once to close any gap from missed events.
    // Skip the very first open right after init -- syncInit already seeded.
    if (sync._everOpened) {
      fetch("/state", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(body => { if (body) syncApplySnapshot(body); })
        .catch(() => {});
    }
    sync._everOpened = true;
  });

  es.addEventListener("state", (ev) => {
    let body;
    try { body = JSON.parse(ev.data); } catch (_) { return; }
    syncApplySnapshot(body);
  });

  es.addEventListener("error", () => {
    sync.reconnectAttempts++;
    setSyncStatus("disconnected", `reconnect #${sync.reconnectAttempts}`);
    // EventSource auto-reconnects with last-event-id. We just update the dot.
  });
}

function syncApplySnapshot(body) {
  const v = Number(body.version) || 0;
  // Echo of our own POST (or older). Discard.
  if (v <= sync.localVersion) return;

  // Mid-drag: queue the latest, drop intermediate. Apply on dragend.
  if (sync.dragInProgress) {
    sync.pendingSseEvent = body;
    return;
  }
  syncApplyState(body);
}

function syncApplyState(body) {
  const v = Number(body.version) || 0;
  if (body.state) {
    // Deep-clone to avoid mutation aliasing -- mirrors the pattern used by
    // localStorage restore, layout switch, and reload-from-disk. If body.state
    // is null we leave state.layout unchanged (don't overwrite with null).
    state.layout = deepClone(body.state);
    // re-bind form values so widgets reflect the new layout
    $("canvas-w").value = state.layout.canvas.width;
    $("canvas-h").value = state.layout.canvas.height;
    $("grid-size").value = state.layout.canvas.gridSize ?? 8;
    $("bar-x").value = state.layout.exportConfig?.barX ?? -55;
    $("bar-y").value = state.layout.exportConfig?.barY ?? 0;
  }
  sync.localVersion = v;
  // Drop selection that no longer exists
  for (const id of [...state.selection]) {
    if (!findEl(id)) state.selection.delete(id);
  }
  recomputeAllGroupBboxes();
  persist();   // localStorage backup; we do NOT re-POST here
  renderAll();
}

// Called from commitOp(), undo(), redo(), and any other mutation site.
// Coalesces rapid mutations into one POST every SYNC_DEBOUNCE_MS.
function syncSchedulePost() {
  if (!sync.enabled) return;
  if (sync.postTimer) clearTimeout(sync.postTimer);
  sync.postTimer = setTimeout(syncDoPost, SYNC_DEBOUNCE_MS);
}

async function syncDoPost() {
  sync.postTimer = null;
  if (!sync.enabled) return;
  if (sync.postInFlight) {
    // A POST is already in flight; mark that another is needed and let the
    // current one's continuation re-fire.
    sync.postPending = true;
    return;
  }
  sync.postInFlight = true;
  const versionToSend = sync.localVersion;
  const stateToSend = state.layout;
  try {
    const r = await fetch("/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: versionToSend, state: stateToSend }),
    });
    if (r.status === 200) {
      const body = await r.json();
      sync.localVersion = Number(body.version) || sync.localVersion;
    } else if (r.status === 409) {
      // Conflict: server returns canonical state. Apply it; lose our edit.
      const body = await r.json();
      // Honor the dragInProgress guard so we don't yank the canvas mid-drag.
      if (sync.dragInProgress) {
        sync.pendingSseEvent = body;
      } else {
        syncApplyState(body);
      }
      setStatus(`Sync conflict; remote state applied (v${body.version}).`);
    } else {
      console.warn("[sync] POST got status", r.status);
    }
  } catch (e) {
    console.warn("[sync] POST failed:", e);
  } finally {
    sync.postInFlight = false;
    if (sync.postPending) {
      sync.postPending = false;
      // Fire another debounce to coalesce further changes that piled up.
      syncSchedulePost();
    }
  }
}

function setSyncStatus(kind, label) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.classList.remove("sync-connected", "sync-disconnected", "sync-connecting");
  el.classList.add(`sync-${kind}`);
  const lbl = el.querySelector(".sync-label");
  if (lbl) {
    lbl.textContent = label || ({
      connected: "live",
      connecting: "connecting...",
      disconnected: "offline",
    }[kind] || kind);
  }
  el.title = `Realtime sync: ${kind}${label ? " (" + label + ")" : ""}`;
}

// Called from mousedown that starts a drag/resize, and from mouseup.
function syncSetDragInProgress(flag) {
  sync.dragInProgress = !!flag;
  if (!flag && sync.pendingSseEvent) {
    const ev = sync.pendingSseEvent;
    sync.pendingSseEvent = null;
    syncApplyState(ev);
  }
}

// =============================================================
// Layout helpers
// =============================================================
function newBlankLayout() {
  return {
    schemaVersion: 1,
    name: "Untitled",
    description: "",
    canvas: { width: 800, height: 300, background: "#101015", gridSize: 8, gridVisible: true, originOffset: { x: 0, y: 0 } },
    exportConfig: { barX: -55, barY: 0 },
    elements: [],
  };
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function uid(prefix = "el") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
function findEl(id) { return state.layout.elements.find(e => e.id === id); }
function childrenOf(groupId) {
  return state.layout.elements.filter(e => e.parent === groupId);
}

// =============================================================
// Group bbox auto-recompute
//
// Group elements have an x/y/w/h that is purely VISUAL (the dashed outline
// the user sees on canvas). Export math uses each group's `anchor` override
// (or, if absent, its anchorPoint-derived position from x/y/w/h) -- see
// computeAnchor(). To keep the dashed outline wrapping the children as the
// user drags them, we recompute the bbox after every mutation.
//
// Important: we never touch a group's `anchor` override here -- only x/y/w/h.
// For groups WITH an `anchor` override (the WA layout's PREFIX_GROUP, PB_GROUP,
// BUFF_GROUP all have one), recomputing the bbox cannot affect exports.
// For groups WITHOUT an override, the bbox is the anchor -- so the recomputed
// bbox WILL shift export offsets. This is acceptable: the bbox-as-anchor
// fallback is only for ad-hoc groups, and "wrap your children" is the
// expected behavior there too.
// =============================================================
function elementBoundingRect(el) {
  // Returns {x1, y1, x2, y2} in canvas coords. For groups, recurse through
  // children so a parent group wraps the union of its descendants' visuals.
  if (el.type === "group") {
    const kids = childrenOf(el.id);
    if (kids.length === 0) {
      return { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h };
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const k of kids) {
      const r = elementBoundingRect(k);
      if (r.x1 < x1) x1 = r.x1;
      if (r.y1 < y1) y1 = r.y1;
      if (r.x2 > x2) x2 = r.x2;
      if (r.y2 > y2) y2 = r.y2;
    }
    return { x1, y1, x2, y2 };
  }
  return { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h };
}

function recomputeGroupBbox(groupId, padding = 4) {
  const g = findEl(groupId);
  if (!g || g.type !== "group") return;

  const kids = childrenOf(groupId);
  if (kids.length === 0) return; // leave bbox alone

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const k of kids) {
    const r = elementBoundingRect(k);
    if (r.x1 < x1) x1 = r.x1;
    if (r.y1 < y1) y1 = r.y1;
    if (r.x2 > x2) x2 = r.x2;
    if (r.y2 > y2) y2 = r.y2;
  }
  if (!isFinite(x1)) return;
  g.x = Math.round(x1 - padding);
  g.y = Math.round(y1 - padding);
  g.w = Math.round((x2 - x1) + padding * 2);
  g.h = Math.round((y2 - y1) + padding * 2);
}

function recomputeAllGroupBboxes() {
  if (!state.layout || !Array.isArray(state.layout.elements)) return;
  // Bottom-up: groups with no group-children first, then their parent groups.
  // Compute depth = number of group ancestors, then sort descending.
  const groups = state.layout.elements.filter(e => e.type === "group");
  function depth(g) {
    let d = 0;
    let p = g.parent;
    const seen = new Set();
    while (p && !seen.has(p)) {
      seen.add(p);
      const pe = findEl(p);
      if (!pe || pe.type !== "group") break;
      d++;
      p = pe.parent;
    }
    return d;
  }
  groups.sort((a, b) => depth(b) - depth(a));
  for (const g of groups) recomputeGroupBbox(g.id);
}

// =============================================================
// Undo / Redo history
//
// History stores deep-cloned snapshots of state.layout. An "operation" is
// bracketed by beginOp() / commitOp() so multi-step mutations (drag, resize,
// property edits with multiple input events) collapse into a single undo
// entry. Atomic ops (add/delete/duplicate) call beginOp() then commitOp()
// around the mutation.
//
// Pushing a new entry clears the redo (future) stack -- standard linear
// undo. Stack is capped at HISTORY_LIMIT.
// =============================================================
const HISTORY_LIMIT = 100;
const history = {
  past: [],     // stack of layout snapshots
  future: [],   // redo stack
  pending: null // snapshot taken at op start, committed on op end
};

function snapshotLayout() {
  return JSON.parse(JSON.stringify(state.layout));
}

function beginOp() {
  // If an op is already pending (e.g. nested call), keep the earliest
  // snapshot so we capture the true pre-op state.
  if (history.pending) return;
  history.pending = snapshotLayout();
}

function commitOp() {
  if (!history.pending) return;
  // Auto-recompute group bboxes BEFORE we diff against the pending snapshot,
  // so a child move that also resizes its parent group counts as one change.
  recomputeAllGroupBboxes();
  const cur = JSON.stringify(state.layout);
  if (JSON.stringify(history.pending) === cur) {
    history.pending = null;
    return;
  }
  history.past.push(history.pending);
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future = [];
  history.pending = null;
  updateUndoButtons();
  // Realtime sync: push our change to the server (debounced).
  syncSchedulePost();
}

function cancelOp() {
  history.pending = null;
}

function clearHistory() {
  history.past = [];
  history.future = [];
  history.pending = null;
  updateUndoButtons();
}

function undo() {
  if (!history.past.length) return;
  // Discard any in-flight op so we don't double-commit a half-state
  history.pending = null;
  history.future.push(snapshotLayout());
  state.layout = history.past.pop();
  // Clear selection of any ids that no longer exist
  for (const id of [...state.selection]) {
    if (!findEl(id)) state.selection.delete(id);
  }
  persist();
  renderAll();
  updateUndoButtons();
  setStatus("Undo.");
  syncSchedulePost();
}

function redo() {
  if (!history.future.length) return;
  history.pending = null;
  history.past.push(snapshotLayout());
  state.layout = history.future.pop();
  for (const id of [...state.selection]) {
    if (!findEl(id)) state.selection.delete(id);
  }
  persist();
  renderAll();
  updateUndoButtons();
  setStatus("Redo.");
  syncSchedulePost();
}

function updateUndoButtons() {
  const u = document.getElementById("btn-undo");
  const r = document.getElementById("btn-redo");
  if (u) u.disabled = history.past.length === 0;
  if (r) r.disabled = history.future.length === 0;
}

// =============================================================
// Persistence
// =============================================================
function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ slug: state.layoutSlug, layout: state.layout }));
    localStorage.setItem(LS_LAST_LAYOUT, state.layoutSlug);
  } catch (e) {
    console.warn("persist failed:", e);
  }
}

// =============================================================
// Reload from disk + version-based stale detection
//
// Each layout JSON file carries a top-level `version: <integer>`. The version
// is preserved when the layout is deep-cloned into state.layout and round-trips
// through localStorage via persist(). On boot, we compare the on-disk version
// (from state.builtins[slug]) against the localStorage-saved version. If the
// file is newer, we prompt the user to discard local changes and reload.
//
// To "publish" an update that should propagate to existing browsers, bump the
// `version` field in the layout's JSON file.
// =============================================================
function fileVersionFor(slug) {
  const b = state.builtins[slug];
  return (b && typeof b.version === "number") ? b.version : 0;
}
function localVersionOf(layout) {
  return (layout && typeof layout.version === "number") ? layout.version : 0;
}

function maybePromptVersionUpgrade() {
  const fileV = fileVersionFor(state.layoutSlug);
  const localV = localVersionOf(state.layout);
  if (fileV > localV) {
    const name = state.layout?.name || state.layoutSlug;
    const ok = confirm(`The ${name} file has been updated (file v${fileV}, local v${localV}). Reload from disk and discard local changes?`);
    if (ok) reloadCurrentLayoutFromDisk({ silent: true });
  }
}

// Re-fetch the active layout's JSON file fresh from disk, blow away undo
// history, and overwrite the localStorage entry with the freshly-loaded data.
// `silent` skips the confirm() prompt (used when the user already accepted a
// version-upgrade prompt).
async function reloadCurrentLayoutFromDisk({ silent = false } = {}) {
  const slug = state.layoutSlug;
  const meta = LAYOUT_FILES.find(l => l.slug === slug);
  if (!meta) {
    setStatus(`No file mapping for layout "${slug}".`);
    return;
  }
  const name = state.layout?.name || slug;
  if (!silent && !confirm(`Discard local changes and reload ${name} from disk?`)) return;

  try {
    const r = await fetch(meta.path, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const fresh = await r.json();
    state.builtins[slug] = fresh;       // refresh cache so version checks line up
    state.layout = deepClone(fresh);
    clearSelection();
    $("canvas-w").value = state.layout.canvas.width;
    $("canvas-h").value = state.layout.canvas.height;
    $("grid-size").value = state.layout.canvas.gridSize ?? 8;
    $("bar-x").value = state.layout.exportConfig?.barX ?? -55;
    $("bar-y").value = state.layout.exportConfig?.barY ?? 0;
    recomputeAllGroupBboxes();
    persist();                          // overwrites LS_KEY with freshly-loaded data (incl. version)
    clearHistory();
    centerStage();
    renderAll();
    setStatus(`Reloaded "${slug}" from disk (v${localVersionOf(state.layout)}).`);
  } catch (e) {
    setStatus(`Reload failed: ${e.message}`);
  }
}

// =============================================================
// Render
// =============================================================
function renderAll() {
  renderStage();
  renderElements();
  renderOutline();
  renderProps();
  renderExports();
  applyTransform();
}

function renderStage() {
  const { width, height, gridVisible } = state.layout.canvas;
  stage.style.width  = `${width}px`;
  stage.style.height = `${height}px`;
  bgCanvas.width = width;
  bgCanvas.height = height;
  gridLayer.style.display = gridVisible ? "block" : "none";
  $("grid-toggle").checked = gridVisible;
  // Drive grid overlay spacing from canvas.gridSize. Major grid line every 8 cells.
  const g = clampGrid(state.layout.canvas.gridSize ?? 8);
  const major = g * 8;
  gridLayer.style.backgroundSize = `${g}px ${g}px, ${g}px ${g}px, ${major}px ${major}px, ${major}px ${major}px`;
  redrawBg();
}

function clampGrid(v) {
  const n = Math.max(1, Math.min(64, Math.round(Number(v) || 8)));
  return n;
}

function redrawBg() {
  const ctx = bgCanvas.getContext("2d");
  ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  if (state.bgImage) {
    ctx.globalAlpha = state.bgOpacity;
    ctx.drawImage(state.bgImage, 0, 0);
    ctx.globalAlpha = 1;
  }
}

function renderElements() {
  elementsLayer.innerHTML = "";
  // Paint order: groups first (so their bbox sits behind everything), then
  // non-groups sorted from LARGEST area to SMALLEST, so small elements paint
  // on top of overlapping larger ones (e.g. dots on top of bars). DOM hit
  // testing also walks last-sibling-first, but we use a custom hit-test in
  // onMouseDown -- this ordering is purely about visual occlusion.
  const groups = state.layout.elements.filter(e => e.type === "group");
  const others = state.layout.elements.filter(e => e.type !== "group")
    .slice()
    .sort((a, b) => (b.w * b.h) - (a.w * a.h));
  for (const e of groups) elementsLayer.appendChild(makeElNode(e));
  for (const e of others) elementsLayer.appendChild(makeElNode(e));
}

function makeElNode(e) {
  const node = document.createElement("div");
  node.className = `el ${e.type}` + (state.selection.has(e.id) ? " selected" : "");
  node.dataset.id = e.id;
  node.style.left   = `${e.x}px`;
  node.style.top    = `${e.y}px`;
  node.style.width  = `${e.w}px`;
  node.style.height = `${e.h}px`;
  if (e.type !== "text") node.style.background = e.color || "rgba(124,58,237,0.6)";

  if (e.type === "icon") {
    node.textContent = e.name || "";
  } else if (e.type === "text") {
    node.textContent = e.text || e.name || "label";
  } else if (e.type === "group") {
    const lbl = document.createElement("div");
    lbl.className = "group-label";
    lbl.textContent = e.name || e.id;
    node.appendChild(lbl);
  }

  // Show name as floating label for pixels/icons/bars when selected or w >= 30
  if ((e.type === "pixel" || e.type === "bar") && e.name && (state.selection.has(e.id) || e.w >= 24)) {
    const lbl = document.createElement("div");
    lbl.className = "label";
    lbl.textContent = e.name;
    node.appendChild(lbl);
  }

  // Resize handles when selected and not a group (groups auto-fit children)
  if (state.selection.has(e.id) && e.type !== "group" && e.type !== "text") {
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("div");
      h.className = `handle ${corner}`;
      h.dataset.handle = corner;
      node.appendChild(h);
    }
  }

  return node;
}

function renderOutline() {
  outlineEl.innerHTML = "";
  const top = state.layout.elements.filter(e => !e.parent);
  for (const e of top) {
    renderOutlineNode(e, 0, outlineEl);
  }
}
function renderOutlineNode(e, depth, container) {
  container.appendChild(outlineRow(e, depth));
  if (e.type === "group") {
    for (const c of childrenOf(e.id)) renderOutlineNode(c, depth + 1, container);
  }
}
function outlineRow(e, depth) {
  const li = document.createElement("li");
  if (depth > 0) li.classList.add("child");
  li.style.paddingLeft = `${4 + depth * 14}px`;
  if (state.selection.has(e.id)) li.classList.add("selected");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.style.background = e.color || "transparent";
  li.appendChild(badge);
  const txt = document.createElement("span");
  const ap = e.anchorPoint ? ` <${e.anchorPoint}>` : "";
  txt.textContent = `${e.name || e.id} [${e.type}]${ap}`;
  li.appendChild(txt);
  li.addEventListener("click", (ev) => {
    if (ev.shiftKey) toggleSelection(e.id); else setSelection([e.id]);
    renderAll();
  });
  return li;
}

function renderProps() {
  if (state.selection.size === 0) {
    propsEl.innerHTML = `<p class="muted">Select an element.</p>`;
    return;
  }
  if (state.selection.size > 1) {
    propsEl.innerHTML = `<p class="muted">${state.selection.size} elements selected.</p>`;
    return;
  }
  const id = [...state.selection][0];
  const e = findEl(id);
  if (!e) { propsEl.innerHTML = `<p class="muted">Missing.</p>`; return; }

  const groups = state.layout.elements.filter(g => g.type === "group" && g.id !== e.id);
  const groupOpts = [`<option value="">(none)</option>`,
    ...groups.map(g => `<option value="${g.id}" ${e.parent === g.id ? "selected" : ""}>${g.name || g.id}</option>`)
  ].join("");

  const ap = e.anchorPoint || "TOPLEFT";
  const anchorOpts = ["TOPLEFT", "CENTER"].map(a => `<option ${a===ap?"selected":""}>${a}</option>`).join("");

  // Show explicit anchor override only for groups
  const anchorOverrideRow = e.type === "group"
    ? `<div class="row split"><label>anchor x / y</label>
        <input type="number" data-k="anchor.x" value="${e.anchor ? e.anchor.x : ""}" placeholder="(bbox)" />
        <input type="number" data-k="anchor.y" value="${e.anchor ? e.anchor.y : ""}" placeholder="(bbox)" />
      </div>`
    : "";

  propsEl.innerHTML = `
    <div class="row"><label>id</label><input data-k="id" value="${escAttr(e.id)}" /></div>
    <div class="row"><label>name</label><input data-k="name" value="${escAttr(e.name || "")}" /></div>
    <div class="row"><label>type</label>
      <select data-k="type">
        ${["pixel","icon","bar","group","text"].map(t => `<option ${t===e.type?"selected":""}>${t}</option>`).join("")}
      </select>
    </div>
    <div class="row split"><label>x / y</label>
      <input type="number" data-k="x" value="${e.x}" />
      <input type="number" data-k="y" value="${e.y}" />
    </div>
    <div class="row split"><label>w / h</label>
      <input type="number" data-k="w" value="${e.w}" />
      <input type="number" data-k="h" value="${e.h}" />
    </div>
    <div class="row"><label>anchorPoint</label><select data-k="anchorPoint">${anchorOpts}</select></div>
    ${anchorOverrideRow}
    <div class="row"><label>color</label><input data-k="color" value="${escAttr(e.color || "")}" /></div>
    <div class="row"><label>parent</label><select data-k="parent">${groupOpts}</select></div>
    ${e.type === "text" ? `<div class="row"><label>text</label><input data-k="text" value="${escAttr(e.text || "")}" /></div>` : ""}
    <div class="row"><label>lua_template</label><input data-k="lua_template" value="${escAttr(e.lua_template || "")}" /></div>
    <div class="row"><label>notes</label><textarea data-k="notes">${escHtml(e.notes || "")}</textarea></div>
    <div class="row"><label></label>
      <div style="display:flex;gap:6px;">
        <button id="prop-dup">Duplicate</button>
        <button id="prop-del">Delete</button>
      </div>
    </div>
  `;

  for (const inp of propsEl.querySelectorAll("[data-k]")) {
    // Snapshot at focus, commit on blur or change -- collapses many input
    // events (typing in a number field) into one undo entry.
    inp.addEventListener("focus", () => beginOp());
    inp.addEventListener("blur", () => commitOp());
    inp.addEventListener("change", () => commitOp());
    inp.addEventListener("input", (ev) => {
      // Safety net: if focus event was missed (e.g. select dropdown that
      // fires input without focus), still capture pre-state.
      if (!history.pending) beginOp();
      const k = ev.target.dataset.k;
      let v = ev.target.value;
      if (["x","y","w","h"].includes(k)) v = Number(v);
      if (k === "id") {
        // Re-key: also update children's parent ref
        const oldId = e.id;
        for (const child of state.layout.elements) {
          if (child.parent === oldId) child.parent = v;
        }
        state.selection = new Set([v]);
      }
      if (k === "anchor.x" || k === "anchor.y") {
        const axis = k.split(".")[1];
        const raw = ev.target.value;
        if (raw === "" || raw === null) {
          // Clear override on this axis. If both axes empty, drop the anchor field.
          if (e.anchor) {
            delete e.anchor[axis];
            if (e.anchor.x === undefined && e.anchor.y === undefined) delete e.anchor;
          }
        } else {
          if (!e.anchor) e.anchor = {};
          e.anchor[axis] = Number(raw);
        }
      } else {
        e[k] = v;
      }
      persist();
      renderElements();
      renderOutline();
      renderExports();
      // re-render bg colour swatch in outline only (cheap to do whole)
    });
  }
  $("prop-dup").addEventListener("click", () => duplicateSelection());
  $("prop-del").addEventListener("click", () => deleteSelection());
}

function escAttr(s) { return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// =============================================================
// Anchor math helpers
//
// Each element has an `anchorPoint` (default "TOPLEFT") that selects
// which point on its bbox is the WA anchor in canvas space.
// Groups may additionally carry an explicit { anchor: {x,y} } override
// that decouples the anchor from the visual bbox -- needed when
// children are CENTER-anchored to a logical center that does not
// coincide with the bbox center (e.g. an asymmetric icon row).
// =============================================================
function anchorPointOf(el) { return el.anchorPoint || "TOPLEFT"; }

function computeAnchor(el) {
  // Group with explicit override wins
  if (el.type === "group" && el.anchor && el.anchor.x !== undefined && el.anchor.y !== undefined) {
    return { x: el.anchor.x, y: el.anchor.y };
  }
  if (anchorPointOf(el) === "CENTER") {
    return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  }
  return { x: el.x, y: el.y };
}

function computeParentAnchor(el, originOffset) {
  if (!el.parent) return { x: originOffset?.x || 0, y: originOffset?.y || 0 };
  const parent = findEl(el.parent);
  if (!parent) return { x: originOffset?.x || 0, y: originOffset?.y || 0 };
  return computeAnchor(parent);
}

function computeWaOffset(el, originOffset) {
  const a = computeAnchor(el);
  const pa = computeParentAnchor(el, originOffset);
  return { xOffset: a.x - pa.x, yOffset: -(a.y - pa.y) };
}

function renderExports() {
  // BAR_X / BAR_Y: convenience constants for shorthand rendering of
  // children whose lua_template uses "xOffset = BAR_X + N".
  const barX = Number($("bar-x").value || 0);
  const barY = Number($("bar-y").value || 0);
  state.layout.exportConfig = { barX, barY };

  const originOffset = state.layout.canvas.originOffset || { x: 0, y: 0 };
  const lines = [];
  lines.push(`-- BAR_X = ${barX}, BAR_Y = ${barY}`);
  lines.push(`-- Generated by layout-planner. Offsets are element-anchor minus parent-anchor (canvas), Y flipped to WA convention.`);
  lines.push("");

  for (const e of state.layout.elements) {
    if (!e.name) continue;
    if (e.type === "text") continue;
    const { xOffset, yOffset } = computeWaOffset(e, originOffset);
    const parentName = e.parent ? (findEl(e.parent)?.name || e.parent) : "(root)";
    const ap = anchorPointOf(e);

    let xLabel = `xOffset = ${xOffset}`;
    // If user encoded a BAR_X-relative or named-constant template, prefer it
    // when the numeric offset matches.
    if (e.lua_template) {
      // Extract the numeric x from the template's xOffset
      const m = e.lua_template.match(/xOffset\s*=\s*([^,]+?)\s*,/);
      if (m) {
        const tplExpr = m[1].trim();
        const numericFromTpl = evalSimpleExpr(tplExpr, { BAR_X: barX, STRIP_X: -66, ICON_X: -122 });
        if (numericFromTpl !== null && numericFromTpl === xOffset) {
          xLabel = `xOffset = ${tplExpr}`;
        }
      }
    }

    lines.push(`-- ${e.name} (parent: ${parentName}, anchor: ${ap})`);
    if (e.lua_template) lines.push(`-- template: ${e.lua_template}`);
    lines.push(`${xLabel}, yOffset = ${yOffset},`);
    lines.push("");
  }

  $("export-lua").value = lines.join("\n");
  $("export-json").value = JSON.stringify(state.layout, null, 2);
}

// Tiny evaluator for "BAR_X + 30", "STRIP_X", "-55", "ICON_X". Returns
// number or null on parse failure.
function evalSimpleExpr(expr, vars) {
  let s = String(expr).trim();
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\b${k}\\b`, "g"), `(${v})`);
  }
  if (!/^[-+*/().\d\s]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${s});`)();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// =============================================================
// Selection
// =============================================================
function setSelection(ids) {
  state.selection = new Set(ids);
}
function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
}
function clearSelection() { state.selection.clear(); }

// =============================================================
// Mouse / canvas interactions
// =============================================================
function applyTransform() {
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  hudCoords.textContent = `zoom: ${state.zoom.toFixed(2)}`;
}

function centerStage() {
  // Stage CSS positions it at left:50%/top:50% of the viewport, so pan is the
  // additional translate needed to put the canvas's top-left at the viewport's
  // visual center -- minus half the scaled canvas to truly center it.
  const cw = state.layout.canvas.width  * state.zoom;
  const ch = state.layout.canvas.height * state.zoom;
  state.pan.x = -cw / 2;
  state.pan.y = -ch / 2;
}

// Convert page (clientX,clientY) to canvas coords (in canvas pixels).
// Uses stage.getBoundingClientRect() so any CSS positioning (left:50%, etc.)
// plus the transform's translate are handled in one shot -- we just divide by
// zoom to get from screen-px-relative-to-stage to canvas px.
function pageToCanvas(px, py) {
  const r = stage.getBoundingClientRect();
  const x = (px - r.left) / state.zoom;
  const y = (py - r.top)  / state.zoom;
  return { x, y };
}

function snap(v) {
  if (!$("snap-toggle").checked) return v;
  const g = state.layout.canvas.gridSize || 8;
  return Math.round(v / g) * g;
}

function bindUi() {
  // Top-bar controls
  layoutSel.addEventListener("change", () => switchLayout(layoutSel.value));
  $("btn-new").addEventListener("click", () => {
    if (!confirm("Discard current layout and create a new blank one?")) return;
    state.layout = newBlankLayout();
    state.layoutSlug = "untitled";
    layoutSel.value = LAYOUT_FILES[0].slug; // visual reset
    clearSelection();
    persist();
    clearHistory();
    renderAll();
    centerStage();
    applyTransform();
  });
  $("btn-save").addEventListener("click", saveLayoutFile);
  $("btn-load").addEventListener("click", () => $("file-load").click());
  $("file-load").addEventListener("change", loadLayoutFile);
  $("btn-reload").addEventListener("click", () => reloadCurrentLayoutFromDisk());

  $("bg-file").addEventListener("change", loadBgImage);
  $("btn-clear-bg").addEventListener("click", () => { state.bgImage = null; redrawBg(); });
  $("bg-opacity").addEventListener("input", (e) => {
    state.bgOpacity = Number(e.target.value) / 100;
    redrawBg();
  });

  $("grid-toggle").addEventListener("change", (e) => {
    beginOp();
    state.layout.canvas.gridVisible = e.target.checked;
    persist();
    renderStage();
    commitOp();
  });
  $("snap-toggle").addEventListener("change", () => { /* no render needed */ });

  // Configurable grid size (per-layout, persists in canvas.gridSize). Drives
  // the grid overlay spacing AND the snap math used by drag/resize/arrow nudge.
  $("grid-size").addEventListener("focus", () => beginOp());
  $("grid-size").addEventListener("input", (e) => {
    if (!history.pending) beginOp();
    const g = clampGrid(e.target.value);
    state.layout.canvas.gridSize = g;
    persist();
    renderStage();
  });
  $("grid-size").addEventListener("blur", (e) => {
    // Normalize the visible value back to the clamped integer.
    e.target.value = clampGrid(state.layout.canvas.gridSize);
    commitOp();
  });
  $("grid-size").addEventListener("change", (e) => {
    e.target.value = clampGrid(state.layout.canvas.gridSize);
    commitOp();
  });

  $("canvas-w").addEventListener("focus", () => beginOp());
  $("canvas-w").addEventListener("change", (e) => {
    state.layout.canvas.width = Math.max(64, Number(e.target.value) || 64);
    persist();
    renderStage();
    commitOp();
  });
  $("canvas-h").addEventListener("focus", () => beginOp());
  $("canvas-h").addEventListener("change", (e) => {
    state.layout.canvas.height = Math.max(64, Number(e.target.value) || 64);
    persist();
    renderStage();
    commitOp();
  });

  // Add buttons
  for (const b of document.querySelectorAll("[data-add]")) {
    b.addEventListener("click", () => addElement(b.dataset.add));
  }

  // Export bar config
  $("bar-x").addEventListener("focus", () => beginOp());
  $("bar-x").addEventListener("input", () => { renderExports(); persist(); });
  $("bar-x").addEventListener("blur", () => commitOp());
  $("bar-x").addEventListener("change", () => commitOp());
  $("bar-y").addEventListener("focus", () => beginOp());
  $("bar-y").addEventListener("input", () => { renderExports(); persist(); });
  $("bar-y").addEventListener("blur", () => commitOp());
  $("bar-y").addEventListener("change", () => commitOp());

  // Undo / Redo buttons
  $("btn-undo").addEventListener("click", () => undo());
  $("btn-redo").addEventListener("click", () => redo());
  $("btn-copy-lua").addEventListener("click",  () => copyText($("export-lua").value, "Lua"));
  $("btn-copy-json").addEventListener("click", () => copyText($("export-json").value, "JSON"));

  // Pan / zoom on the viewport
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", () => { /* keep stage where it is */ });

  // If focus is yanked mid-drag (alt-tab, system dialog, tab switch), the
  // mouseup event may never reach us and sync.dragInProgress would stick true
  // forever -- queueing SSE updates that never apply. Force-clear here.
  // syncSetDragInProgress(false) also flushes any pendingSseEvent.
  window.addEventListener("blur", () => {
    if (sync.dragInProgress) syncSetDragInProgress(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && sync.dragInProgress) syncSetDragInProgress(false);
  });
}

function copyText(t, label) {
  navigator.clipboard.writeText(t).then(
    () => setStatus(`${label} copied to clipboard.`),
    (e) => setStatus(`Copy failed: ${e}`)
  );
}

function setStatus(msg) { status.textContent = msg; }

// ----- Switch layout -----
//
// NOTE: this deliberately deep-clones from state.builtins[slug], which holds
// the JSON fetched from disk during init(). We do NOT pull from localStorage
// when switching layouts -- localStorage only ever holds a single
// "active layout" snapshot under LS_KEY, keyed by slug. So switching to a
// different layout always lands on the on-disk version. The reload-from-disk
// flow + version check exists to handle the OTHER case: the active layout's
// file was updated and we need to detect that on next page load.
function switchLayout(slug) {
  const builtin = state.builtins[slug];
  if (!builtin) { setStatus(`No layout for ${slug}`); return; }
  // Persist current state before swapping (so it's the dropdown's last-known)
  persist();
  state.layout = deepClone(builtin);
  state.layoutSlug = slug;
  clearSelection();
  $("canvas-w").value = state.layout.canvas.width;
  $("canvas-h").value = state.layout.canvas.height;
  $("grid-size").value = state.layout.canvas.gridSize ?? 8;
  $("bar-x").value = state.layout.exportConfig?.barX ?? -55;
  $("bar-y").value = state.layout.exportConfig?.barY ?? 0;
  recomputeAllGroupBboxes();
  persist();
  // Layout switch is a pristine state -- clear undo history.
  clearHistory();
  centerStage();
  renderAll();
  setStatus(`Switched to "${slug}".`);
}

// ----- Save / load layout JSON -----
function saveLayoutFile() {
  const blob = new Blob([JSON.stringify(state.layout, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = (state.layout.name || state.layoutSlug || "layout").replace(/[^a-z0-9_-]+/gi, "-");
  a.href = url;
  a.download = `${safe}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Layout saved.");
}
function loadLayoutFile(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj.canvas || !Array.isArray(obj.elements)) throw new Error("Not a layout file");
      state.layout = obj;
      state.layoutSlug = obj.name || "loaded";
      clearSelection();
      $("canvas-w").value = state.layout.canvas.width;
      $("canvas-h").value = state.layout.canvas.height;
      $("grid-size").value = state.layout.canvas.gridSize ?? 8;
      $("bar-x").value = state.layout.exportConfig?.barX ?? -55;
      $("bar-y").value = state.layout.exportConfig?.barY ?? 0;
      recomputeAllGroupBboxes();
      persist();
      clearHistory();
      centerStage();
      renderAll();
      setStatus(`Loaded "${state.layoutSlug}" (${state.layout.elements.length} elements).`);
    } catch (e) {
      setStatus(`Load failed: ${e.message}`);
    }
  };
  reader.readAsText(f);
  ev.target.value = "";
}

// ----- Background image -----
function loadBgImage(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      state.bgImage = img;
      // resize canvas to image if smaller? no -- keep canvas as-is, draw at 1:1 from origin
      redrawBg();
      setStatus(`BG image loaded (${img.width}x${img.height}). Resize canvas if it doesn't fit.`);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

// ----- Add element -----
function addElement(type) {
  beginOp();
  const id = uid(type);
  const defaults = {
    pixel: { w: 8,  h: 8,  color: "rgba(124,58,237,0.9)" },
    icon:  { w: 32, h: 32, color: "rgba(6,182,212,0.6)" },
    bar:   { w: 200, h: 16, color: "rgba(236,72,153,0.7)" },
    group: { w: 100, h: 100, color: "rgba(124,58,237,0.10)" },
    text:  { w: 120, h: 20, color: "transparent", text: "label" },
  }[type] || { w: 32, h: 32, color: "rgba(255,255,255,0.4)" };
  const cx = state.layout.canvas.width  / 2;
  const cy = state.layout.canvas.height / 2;
  const e = {
    id,
    type,
    name: id,
    x: snap(cx - defaults.w / 2),
    y: snap(cy - defaults.h / 2),
    w: defaults.w,
    h: defaults.h,
    color: defaults.color,
    parent: null,
    notes: "",
  };
  if (type === "text") e.text = defaults.text;
  state.layout.elements.push(e);
  setSelection([id]);
  persist();
  renderAll();
  commitOp();
}

// ----- Hit testing -----
//
// Picks the element under canvas-space (cx, cy). Behavior:
//   - Tiny elements (< MIN_HIT) get an enlarged virtual hit-target around
//     their visual center, so 8x8 dots are not pixel-perfect-only.
//   - All hits get an extra TOL pixels of slack on every edge.
//   - Non-group hits beat group hits (so clicking a child inside a group
//     selects the child, never the group).
//   - Among multiple non-group hits, smallest visual area wins (so a dot
//     stacked on top of a bar resolves to the dot).
//   - If only groups are hit (e.g. clicking inside PB_GROUP's empty area),
//     the smallest group wins (so nested children's parent group beats
//     the outer ancestor).
function pickElementAt(cx, cy) {
  const TOL = 4;        // forgiving slack on every edge, in canvas px
  const MIN_HIT = 16;   // minimum hit-target side for tiny elements
  const candidates = [];
  for (const e of state.layout.elements) {
    let hx = e.x, hy = e.y, hw = e.w, hh = e.h;
    if (hw < MIN_HIT) { hx = e.x + e.w / 2 - MIN_HIT / 2; hw = MIN_HIT; }
    if (hh < MIN_HIT) { hy = e.y + e.h / 2 - MIN_HIT / 2; hh = MIN_HIT; }
    if (cx >= hx - TOL && cx <= hx + hw + TOL &&
        cy >= hy - TOL && cy <= hy + hh + TOL) {
      candidates.push({ id: e.id, area: Math.max(1, e.w * e.h), isGroup: e.type === "group" });
    }
  }
  if (candidates.length === 0) return null;
  const nonGroups = candidates.filter(c => !c.isGroup);
  if (nonGroups.length > 0) {
    nonGroups.sort((a, b) => a.area - b.area);
    return nonGroups[0].id;
  }
  candidates.sort((a, b) => a.area - b.area);
  return candidates[0].id;
}

// ----- Mouse handlers -----
function onMouseDown(ev) {
  if (ev.button !== 0) return;
  const isCanvasArea = ev.target.closest(".canvas-wrap");
  if (!isCanvasArea) return;

  // Pan with space
  if (state.spaceDown) {
    state.isPanning = true;
    state.drag = { mode: "pan", startMouse: { x: ev.clientX, y: ev.clientY }, startPan: { ...state.pan } };
    ev.preventDefault();
    return;
  }

  const handle = ev.target.closest(".handle");
  const handleElNode = handle ? handle.closest(".el") : null;
  const groupLabel = ev.target.closest(".group-label");
  const canvasPt = pageToCanvas(ev.clientX, ev.clientY);

  // Group label click -> select that group explicitly. The label sits 16px
  // above its group's bbox, so the canvas-coord hit-test below won't find
  // the group from a label click.
  if (groupLabel && !handle) {
    const groupNode = groupLabel.closest(".el.group");
    if (groupNode) {
      const id = groupNode.dataset.id;
      if (ev.shiftKey) {
        toggleSelection(id);
      } else if (!state.selection.has(id)) {
        setSelection([id]);
      }
      beginOp();
      syncSetDragInProgress(true);
      state.drag = {
        mode: "move",
        startMouse: canvasPt,
        free: ev.altKey,
        startEls: snapshotSelection(),
      };
      renderAll();
      ev.preventDefault();
      return;
    }
  }

  // Resize handles win unconditionally -- they only render on selected
  // elements and are explicit interaction zones.
  if (handle && handleElNode) {
    const id = handleElNode.dataset.id;
    if (!state.selection.has(id)) setSelection([id]);
    beginOp();
    syncSetDragInProgress(true);
    state.drag = {
      mode: "resize",
      corner: handle.dataset.handle,
      startMouse: canvasPt,
      startEls: snapshotSelection(),
    };
    ev.preventDefault();
    return;
  }

  // Custom hit-test by canvas coordinate. This bypasses native DOM hit
  // testing so we get smallest-on-top priority + click tolerance for tiny
  // elements regardless of paint order or pointer-events config.
  const hitId = pickElementAt(canvasPt.x, canvasPt.y);
  if (hitId) {
    if (ev.shiftKey) {
      toggleSelection(hitId);
    } else if (!state.selection.has(hitId)) {
      setSelection([hitId]);
    }
    beginOp();
    syncSetDragInProgress(true);
    state.drag = {
      mode: "move",
      startMouse: canvasPt,
      free: ev.altKey,
      startEls: snapshotSelection(),
    };
    renderAll();
    ev.preventDefault();
    return;
  }

  // Empty space => marquee
  if (!ev.shiftKey) clearSelection();
  state.drag = {
    mode: "marquee",
    startMouse: canvasPt,
    startPage: { x: ev.clientX, y: ev.clientY },
  };
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${canvasPt.x}px`;
  marqueeEl.style.top  = `${canvasPt.y}px`;
  marqueeEl.style.width = "0px";
  marqueeEl.style.height = "0px";
  renderAll();
  ev.preventDefault();
}

function snapshotSelection() {
  return [...state.selection].map(id => {
    const e = findEl(id);
    return { id, x: e.x, y: e.y, w: e.w, h: e.h, kids: snapshotChildren(id) };
  });
}
function snapshotChildren(parentId) {
  // For groups, snapshot all children to drag together
  const e = findEl(parentId);
  if (!e || e.type !== "group") return [];
  return childrenOf(parentId).map(c => ({ id: c.id, x: c.x, y: c.y }));
}

function onMouseMove(ev) {
  if (!state.drag) {
    // HUD coords
    const p = pageToCanvas(ev.clientX, ev.clientY);
    if (p.x >= 0 && p.y >= 0 && p.x <= state.layout.canvas.width && p.y <= state.layout.canvas.height) {
      hudCoords.textContent = `x: ${Math.round(p.x)}  y: ${Math.round(p.y)}  zoom: ${state.zoom.toFixed(2)}`;
    }
    return;
  }
  const d = state.drag;

  if (d.mode === "pan") {
    state.pan.x = d.startPan.x + (ev.clientX - d.startMouse.x);
    state.pan.y = d.startPan.y + (ev.clientY - d.startMouse.y);
    applyTransform();
    return;
  }

  const pt = pageToCanvas(ev.clientX, ev.clientY);

  if (d.mode === "move") {
    let dx = pt.x - d.startMouse.x;
    let dy = pt.y - d.startMouse.y;
    if (!d.free) {
      const g = state.layout.canvas.gridSize || 8;
      dx = Math.round(dx / g) * g;
      dy = Math.round(dy / g) * g;
    }
    for (const s of d.startEls) {
      const e = findEl(s.id);
      if (!e) continue;
      e.x = s.x + dx;
      e.y = s.y + dy;
      // Move group children too
      for (const k of s.kids) {
        const c = findEl(k.id);
        if (c) { c.x = k.x + dx; c.y = k.y + dy; }
      }
    }
    persist();
    renderElements();
    renderExports();
    return;
  }

  if (d.mode === "resize") {
    const g = state.layout.canvas.gridSize || 8;
    const dx = ev.altKey ? (pt.x - d.startMouse.x) : Math.round((pt.x - d.startMouse.x) / g) * g;
    const dy = ev.altKey ? (pt.y - d.startMouse.y) : Math.round((pt.y - d.startMouse.y) / g) * g;
    for (const s of d.startEls) {
      const e = findEl(s.id);
      if (!e) continue;
      let { x, y, w, h } = s;
      if (d.corner.includes("e")) w = Math.max(1, s.w + dx);
      if (d.corner.includes("s")) h = Math.max(1, s.h + dy);
      if (d.corner.includes("w")) { x = s.x + dx; w = Math.max(1, s.w - dx); }
      if (d.corner.includes("n")) { y = s.y + dy; h = Math.max(1, s.h - dy); }
      e.x = x; e.y = y; e.w = w; e.h = h;
    }
    persist();
    renderAll();
    return;
  }

  if (d.mode === "marquee") {
    const x1 = Math.min(d.startMouse.x, pt.x);
    const y1 = Math.min(d.startMouse.y, pt.y);
    const x2 = Math.max(d.startMouse.x, pt.x);
    const y2 = Math.max(d.startMouse.y, pt.y);
    marqueeEl.style.left = `${x1}px`;
    marqueeEl.style.top  = `${y1}px`;
    marqueeEl.style.width  = `${x2 - x1}px`;
    marqueeEl.style.height = `${y2 - y1}px`;
    return;
  }
}

function onMouseUp(ev) {
  if (!state.drag) return;
  const d = state.drag;
  if (d.mode === "marquee") {
    // Select elements whose bbox intersects marquee
    const r = marqueeEl.getBoundingClientRect();
    const a = pageToCanvas(r.left, r.top);
    const b = pageToCanvas(r.right, r.bottom);
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    for (const e of state.layout.elements) {
      if (e.type === "group") continue;
      const ix = e.x < x2 && e.x + e.w > x1;
      const iy = e.y < y2 && e.y + e.h > y1;
      if (ix && iy) state.selection.add(e.id);
    }
    marqueeEl.hidden = true;
    renderAll();
  }
  // Commit any drag/resize op (no-op safe if nothing actually changed)
  if (d.mode === "move" || d.mode === "resize") {
    commitOp();
  }
  // Clear the drag-in-progress flag and apply any SSE event we queued during
  // the drag. If a 409 conflict landed (queued by syncDoPost), that wins;
  // otherwise the latest external SSE state wins.
  syncSetDragInProgress(false);
  state.drag = null;
  state.isPanning = false;
}

function onWheel(ev) {
  ev.preventDefault();
  // Canvas coord under the mouse, BEFORE the zoom change. Use pageToCanvas so
  // we share its (correct) accounting for stage CSS positioning + transform.
  const before = pageToCanvas(ev.clientX, ev.clientY);
  const dz = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = clamp(state.zoom * dz, 0.5, 8);
  state.zoom = newZoom;
  // Now adjust pan so the same canvas point ends up under the mouse again.
  // Apply the transform first so getBoundingClientRect reflects the new zoom,
  // then compute how far the cursor has drifted from `before` in screen px.
  applyTransform();
  const after = pageToCanvas(ev.clientX, ev.clientY);
  state.pan.x += (after.x - before.x) * state.zoom;
  state.pan.y += (after.y - before.y) * state.zoom;
  applyTransform();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ----- Keyboard -----
function onKeyDown(ev) {
  // Ignore when typing in inputs (also covers contenteditable via activeElement)
  const ae = document.activeElement;
  const aeTag = (ae && ae.tagName) || "";
  const tag = (ev.target && ev.target.tagName) || "";
  const isTyping =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    aeTag === "INPUT" || aeTag === "TEXTAREA" || aeTag === "SELECT" ||
    (ae && ae.isContentEditable);

  // Undo / Redo. Allowed even without explicit selection. Bail when typing
  // so the browser's native input undo still works inside fields.
  if ((ev.ctrlKey || ev.metaKey) && !isTyping) {
    // Ctrl+Shift+Z OR Ctrl+Y => redo
    if ((ev.code === "KeyZ" && ev.shiftKey) || ev.code === "KeyY") {
      ev.preventDefault();
      redo();
      return;
    }
    // Ctrl+Z => undo
    if (ev.code === "KeyZ" && !ev.shiftKey) {
      ev.preventDefault();
      // If a drag is in flight, abort it cleanly first to avoid stuck state.
      if (state.drag) { cancelOp(); state.drag = null; syncSetDragInProgress(false); }
      undo();
      return;
    }
  }

  if (isTyping) return;

  if (ev.code === "Space") { state.spaceDown = true; viewport.style.cursor = "grab"; ev.preventDefault(); return; }

  // Ctrl+D duplicate
  if ((ev.ctrlKey || ev.metaKey) && ev.code === "KeyD") {
    ev.preventDefault();
    duplicateSelection();
    return;
  }

  // Delete / Backspace
  if (ev.code === "Delete" || ev.code === "Backspace") {
    if (state.selection.size === 0) return;
    ev.preventDefault();
    deleteSelection();
    return;
  }

  // Arrow nudge
  const arrow = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[ev.key];
  if (arrow && state.selection.size > 0) {
    ev.preventDefault();
    beginOp();
    const step = ev.shiftKey ? (state.layout.canvas.gridSize || 8) : 1;
    for (const id of state.selection) {
      const e = findEl(id);
      if (!e) continue;
      e.x += arrow[0] * step;
      e.y += arrow[1] * step;
      if (e.type === "group") {
        for (const c of childrenOf(id)) { c.x += arrow[0] * step; c.y += arrow[1] * step; }
      }
    }
    persist();
    renderAll();
    commitOp();
  }
}
function onKeyUp(ev) {
  if (ev.code === "Space") { state.spaceDown = false; viewport.style.cursor = ""; }
}

function deleteSelection() {
  if (state.selection.size === 0) return;
  beginOp();
  const ids = new Set(state.selection);
  // Also delete children of any deleted groups
  for (const id of [...ids]) {
    const e = findEl(id);
    if (e && e.type === "group") {
      for (const c of childrenOf(id)) ids.add(c.id);
    }
  }
  state.layout.elements = state.layout.elements.filter(e => !ids.has(e.id));
  clearSelection();
  persist();
  renderAll();
  commitOp();
}

function duplicateSelection() {
  if (state.selection.size === 0) return;
  beginOp();
  const newIds = [];
  for (const id of [...state.selection]) {
    const e = findEl(id);
    if (!e) continue;
    const copy = deepClone(e);
    copy.id = uid(e.type);
    copy.name = (e.name || e.id) + "_copy";
    copy.x += 12;
    copy.y += 12;
    state.layout.elements.push(copy);
    newIds.push(copy.id);
  }
  setSelection(newIds);
  persist();
  renderAll();
  commitOp();
}
