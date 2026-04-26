# CLAUDE.md

Guidance for future Claude / Anthropic agents working in this repo.

## Repo purpose

A vanilla browser-based interactive layout planner. Drag, resize, snap, group, and align small UI elements (pixels, icons, bars, text, nested groups) on a canvas; export positions to Lua snippets or JSON. Generic enough for HUDs, dashboards, telemetry overlays, sprite atlases, and any small-element layout work.

## Tech stack

- Vanilla ES module (`type="module"` in `index.html`, single `script.js`)
- No build step
- No dependencies
- No framework
- `serve.py` is stdlib-only Python (HTTP server + SSE + file watcher)

NEVER add a framework (React, Vue, Svelte, Solid, etc.). NEVER add a build tool (Vite, webpack, esbuild, Parcel, etc.). NEVER add `npm`, `yarn`, `pnpm`, or `poetry`. The whole point of this project is that you can read every line of source in one sitting.

## File layout

```
index.html          single HTML page, no inline JS
script.js           all client behavior, one state object
style.css           styles
serve.py            stdlib HTTP server with SSE + file-watcher sync
current-state.json  shared sync file (created/managed by serve.py)
layouts/*.json      built-in layouts
test_export.js      round-trip exporter test (Node, no deps)
README.md           user-facing
CLAUDE.md           this file
.gitignore
```

## Launch + test

```bash
python serve.py              # serve the page WITH realtime sync (preferred)
python -m http.server 8000   # serve the page WITHOUT realtime sync (static only)
node test_export.js          # round-trip exporter test
```

The test runner has no dependencies; just Node. `serve.py` is stdlib-only Python.

## Realtime sync

When `serve.py` is running, both the browser AND any external process (you, in a terminal) can read and write `current-state.json` and have changes propagate in near-realtime to all clients.

### Wire protocol

| Endpoint | Behavior |
|---|---|
| `GET /state` | Returns `{version: int, state: object|null}`. |
| `POST /state` | Body `{version: N, state: {...}}`. If `N == server's current version`, server bumps to N+1, writes file, broadcasts. Returns `{version: N+1}`. If mismatch, returns `409` with the current `{version, state}`. |
| `GET /events` | SSE stream. Sends current state immediately on connect; pushes `event: state` messages with `id: <version>` on every state change; heartbeats every 15 s. |

`current-state.json` itself is `{version: int, state: <layout object>}`, the same shape as `GET /state`.

### How to write to `current-state.json` from a terminal

The mtime watcher in `serve.py` polls every 250 ms and ingests external writes. To make a change:

1. **Read** `current-state.json` first.
2. **Modify** the `state` field as needed. You may keep the `version` field as-is OR bump it; the watcher will increment the server's authoritative `current_version` regardless and rewrite the file with the new version. Don't try to predict what the version will be, just write something coherent.
3. **Write atomically.** Write to a `.tmp` file then rename, OR rewrite directly (mtime/hash dedup is forgiving). Don't leave the file half-flushed for >50 ms.

The server detects the mtime change, reads, computes a SHA-1 of the bytes, and:

- if the hash matches the last byte sequence the server itself wrote, it ignores the change (echo-suppression);
- otherwise it parses, increments `current_version`, rewrites the file with the bumped version, and broadcasts to all SSE subscribers.

So your write doesn't need to assign a correct version field; the server overwrites it with the canonical one within ~250-300 ms. Just don't write malformed JSON.

### Foot-gun invariants (preserve these in any future edit)

1. **Version is server-assigned.** Clients propose; server validates and increments. Never trust a client-supplied version as authoritative.
2. **Read-modify-write-broadcast is atomic.** A single `state_lock` covers the whole critical section in `serve.py`. Don't release the lock between writing the file and updating `last_written_hash`, or you'll lose the echo-suppression.
3. **Self-write dedup uses content hash, NOT mtime alone.** The mtime watcher's first check is `hash == last_written_hash`. mtime is just the trigger to look.
4. **JSON parse retries once on failure** (50 ms sleep) to tolerate writers that flush in two syscalls.
5. **SSE socket errors are silent.** The handler removes its subscriber and exits. Don't propagate.
6. **Heartbeat every 15 s** keeps Windows + corporate proxies from idle-killing the SSE connection.
7. **Browser queues SSE updates mid-drag** and applies the latest on dragend, dropping intermediates. Don't change this without thinking through "user is dragging the same element another writer just moved" cases.
8. **On EventSource reconnect, browser GETs `/state`** to close any gap from missed events. Server doesn't replay history.
9. **Browser optimistically applies local mutations**, then POSTs (debounced 500 ms). Echo (via SSE or POST 200) just bumps `localVersion`.
10. **Never order events by wall clock.** The monotonic server-assigned `version` is the only source of order.
11. **POST with stale version returns 409 plus current state.** The browser must reconcile by overwriting its local copy with the server's, then re-applying any in-flight user mutation on top. Don't silently drop the 409.
12. **Static-only mode is a first-class fallback.** If `/events` 404s or `/state` is unreachable, the planner runs in static-only mode (status indicator: `static-only`). Don't make sync paths throw fatal errors.

## Key invariants

- **Round-trip is sacred.** Dragging an element on canvas, then exporting, MUST produce a value that round-trips back to the same canvas position. `node test_export.js` verifies this for `wa-pixel-bridge.json`. Run it after any change to export math or layout JSON.
- **Element math is parent-relative.** `computeWaOffset(el) = computeAnchor(el) - computeParentAnchor(el)`. Top-level elements use `canvas.originOffset` as the parent anchor. Y is flipped on export to match the Lua-style anchor convention (negative Y means "below").
- **Anchor types supported: `TOPLEFT` and `CENTER` only.** Adding more (e.g. `RIGHT`, `BOTTOMLEFT`) requires updating `computeAnchor()` and the anchor select options in `renderProps()`. `computeParentAnchor()` delegates to `computeAnchor(parent)`, so it picks up new branches automatically.
- **All canvas-space mouse math goes through `pageToCanvas(clientX, clientY)`.** It accounts for stage CSS positioning + the transform's translate + zoom in one shot. NEVER use raw `clientX` / `clientY` for hit-test, drag, resize, or marquee math. This is the most common source of "clicks land in the wrong place at non-1.0 zoom" bugs.
- **Grid size is per-layout.** Lives at `state.layout.canvas.gridSize`. Snap math (drag, resize, arrow nudge) reads from this value. The toolbar input writes back to it. Range: 1 to 64.
- **Undo entries are atomic operations.** Bracket every mutation with `beginOp()` / `commitOp()`. One drag = one entry; one arrow press = one entry; one property edit = one entry. Multi-event mutations (typing in a number field) collapse into one entry via focus / blur snapshot brackets. Stack is capped at `HISTORY_LIMIT = 100`.
- **Hit-testing prioritizes small elements.** Render order is groups, then larger non-group elements, then smaller. Hit-test enlarges any element below `MIN_HIT = 16` to a 16x16 virtual hit-target, adds 4 px slack, and resolves overlaps by smallest-area-wins. Don't reorder render or hit-test logic without re-checking the "tiny element on top of a big group" case.
- **Group bounding boxes auto-recompute from children.** A group's `x`, `y`, `w`, `h` are derived from its descendants' bbox at render / mutation time. Manually setting a group's geometry won't stick once children change. If you add new mutation paths that move children, re-trigger the group recompute.

## Common gotchas

- The included `wa-pixel-bridge.json` example layout uses **10 px** dot spacing, not 8. The default grid for new layouts is 8, but that file sets `gridSize: 10`. Do not "normalize" this.
- **Stale-state issue.** localStorage holds the active layout's full state including its `version`. To force browsers holding an old copy to be prompted to reload, bump the `version` field in the JSON file. The "Reload" toolbar button is the manual escape hatch.
- **Y-axis convention differs.** The export format uses Y-up (negative-down anchored from `TOPLEFT` means "below the anchor"). Canvas uses Y-down. The exporter flips Y; any future importer must too.
- **Mid-drag SSE updates are queued, not dropped silently.** When the user is dragging, the SSE handler stashes the latest update; on `pointerup` the browser applies it. If you change drag handling, preserve this dispatch.
- **localStorage and the sync server are independent.** localStorage is per-browser autosave. The sync server is the cross-process channel. They can disagree (e.g. browser has uncommitted edits). On boot, the sync GET wins, then localStorage is rehydrated only for layouts the server hasn't seen.

## How to add features

- **New element types**: extend the type list in `addElement()` defaults, add a render branch in `makeElNode()`, add to the type `<select>` options in `renderProps()`, and add an "Add" button in `index.html`.
- **New anchor types**: add a branch in `computeAnchor()` (and update the anchor `<select>` in `renderProps()`).
- **New export formats**: add to `renderExports()`. Keep the existing Lua and JSON exports intact.
- **New layouts**: drop a JSON file in `layouts/`, add an entry to `LAYOUT_FILES` in `script.js`, and bump `version` in any updated JSON.
- **New sync endpoints**: add to `serve.py`'s request handler. Hold `state_lock` across any read-modify-write that should appear atomic to clients. Broadcast via the existing SSE subscriber list.

## What NOT to do

- Don't add a build step.
- Don't add npm / yarn / pnpm / poetry dependencies.
- Don't switch to a framework.
- Don't break the round-trip. Always run `node test_export.js` after changes that touch export math or layout JSON.
- Don't store coordinates in any non-canvas space in the JSON. Canvas pixels are the source of truth; export math is computed at render time.
- Don't bypass `pageToCanvas()` for any mouse-derived coordinate.
- Don't release `state_lock` mid-broadcast in `serve.py`.
- Don't trust a client-supplied `version` as authoritative; the server assigns it.
- Don't order sync events by wall clock; use the monotonic version.
- Don't make sync errors fatal; static-only mode is a valid fallback.
