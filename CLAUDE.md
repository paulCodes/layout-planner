# CLAUDE.md

Guidance for future Claude / Anthropic agents working in this repo.

## Repo purpose

A vanilla browser-based interactive layout planner. Drag, resize, and snap small elements (pixels, icons, bars, groups, text) on a canvas; export positions to Lua snippets or JSON. Originally built to plan a WoW WeakAura pixel bridge that mirrors the Shadow Priest tracker addon, but generic enough for HUDs, dashboards, and any small-element layout work.

## Tech stack

- Vanilla ES module (`type="module"` in index.html, single `script.js`)
- No build step
- No dependencies
- No framework

NEVER add a framework (React, Vue, Svelte, Solid, etc.). NEVER add a build tool (Vite, webpack, esbuild, Parcel, etc.). NEVER add `npm`, `yarn`, `pnpm`, or `poetry`. The whole point of this project is that you can read every line of source in one sitting.

## File layout

```
index.html          single HTML page, no inline JS
script.js           all behavior, ~1300 LoC, one state object
style.css           styles
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

`current-state.json` itself is `{version: int, state: <layout object>}` -- the same shape as `GET /state`.

### How to write to `current-state.json` from this terminal

The mtime watcher in `serve.py` polls every 250 ms and ingests external writes. To make a change:

1. **Read** `current-state.json` first.
2. **Modify** the `state` field as needed. You may keep the `version` field as-is OR bump it; the watcher will increment the server's authoritative `current_version` regardless and rewrite the file with the new version. Don't try to predict what the version will be -- just write something coherent.
3. **Write atomically.** Write to a `.tmp` file then rename, OR rewrite directly (mtime/hash dedup is forgiving). Don't leave the file half-flushed for >50 ms.

The server detects the mtime change, reads, computes a SHA-1 of the bytes, and:
- if the hash matches the last byte sequence the server itself wrote, it ignores the change (echo-suppression);
- otherwise it parses, increments `current_version`, rewrites the file with the bumped version, and broadcasts to all SSE subscribers.

So your write doesn't need to assign a correct version field -- the server overwrites it with the canonical one within ~250-300 ms. Just don't write malformed JSON.

### Foot-gun invariants (preserve these in any future edit)

1. **Version is server-assigned.** Clients propose; server validates and increments. Never trust a client-supplied version as authoritative.
2. **Read-modify-write-broadcast is atomic.** A single `state_lock` covers the whole critical section in `serve.py`. Don't release the lock between writing the file and updating `last_written_hash`, or you'll lose the echo-suppression.
3. **Self-write dedup uses content hash, NOT mtime alone.** The mtime watcher's first check is `hash == last_written_hash`. mtime is just the trigger to look.
4. **JSON parse retries once on failure** (50 ms sleep) to tolerate writers that flush in two syscalls.
5. **SSE socket errors are silent** -- the handler removes its subscriber and exits. Don't propagate.
6. **Heartbeat every 15 s** keeps Windows + corporate proxies from idle-killing the SSE connection.
7. **Browser queues SSE updates mid-drag** and applies the latest on dragend, dropping intermediate. Don't change this without thinking through "user is dragging the same element Claude just moved" cases.
8. **On EventSource reconnect, browser GETs `/state`** to close any gap from missed events. Server doesn't replay history.
9. **Browser optimistically applies local mutations**, then POSTs (debounced 500 ms). Echo (via SSE or POST 200) just bumps `localVersion`.
10. **Never order events by wall clock.** The monotonic server-assigned `version` is the only source of order.

## Key invariants

- **Round-trip is sacred.** Dragging an element on canvas, then exporting, MUST produce a value that round-trips back to the same canvas position. `node test_export.js` verifies this for `wa-pixel-bridge.json`. Run it after any change to export math or layout JSON.
- **Element math is parent-relative.** `computeWaOffset(el) = computeAnchor(el) - computeParentAnchor(el)`. Top-level elements use `canvas.originOffset` as the parent anchor. Y is flipped on export to match the WA convention.
- **Anchor types supported: `TOPLEFT` and `CENTER` only.** Adding more (e.g. `RIGHT`, `BOTTOMLEFT`) requires updating `computeAnchor()` and the anchor select options in `renderProps()`. `computeParentAnchor()` delegates to `computeAnchor(parent)`, so it picks up new branches automatically.
- **All canvas-space mouse math goes through `pageToCanvas(clientX, clientY)`.** It accounts for stage CSS positioning + the transform's translate + zoom in one shot. NEVER use raw `clientX` / `clientY` for hit-test, drag, resize, or marquee math.
- **Grid size is per-layout.** Lives at `state.layout.canvas.gridSize`. Snap math (drag, resize, arrow nudge) reads from this value. The toolbar input writes back to it.
- **Undo entries are atomic operations.** Bracket every mutation with `beginOp()` / `commitOp()`. One drag = one entry; one arrow press = one entry; one property edit = one entry. Multi-event mutations (typing in a number field) collapse into one entry via focus / blur snapshot brackets.

## Common gotchas

- The WA layout uses **10 px** dot spacing, not 8. The default grid for new layouts is 8, but `wa-pixel-bridge.json` sets `gridSize: 10`. Do not "normalize" this.
- **Stale-state issue**: localStorage holds the active layout's full state including its `version`. To force browsers holding an old copy to be prompted to reload, bump the `version` field in the JSON file. The "Reload" toolbar button is the manual escape hatch.
- **WeakAura sandbox forbids `pcall`.** If you ever modify the source-of-truth Lua addon for the WA, do not introduce `pcall` in `init_code` strings. The WA loader will refuse it.
- **Y-axis convention differs.** WA uses Y-up (negative-down anchored from `TOPLEFT` means "below the anchor"). Canvas uses Y-down. The exporter flips Y; any future importer must too.
- **`Icon_SF`** is defined in the WA Lua source but excluded from the active creators list. It is in the planner for completeness and flagged in its `notes`. Don't remove it; don't promote it.
- **`POM` overlaps `NextCast`** in real WA: same `xOffset` / `yOffset`, toggled via shadowform load condition. The planner nudges POM by `+3, +3` for visibility, and the export math acknowledges the nudged canvas position as the source of truth (round-trips to `(-119, -57)`, not `(ICON_X, -54)`).
- **`BUFF_GROUP` children are `CENTER`-anchored relative to `BUFF_GROUP` center**, not relative to `PREFIX_GROUP` or `PB_GROUP`. Verify this when reading code or computing positions by hand.

## How to add features

- **New element types**: extend the type list in `addElement()` defaults, add a render branch in `makeElNode()`, add to the type `<select>` options in `renderProps()`, and add an "Add" button in `index.html`.
- **New anchor types**: add a branch in `computeAnchor()` (and update the anchor `<select>` in `renderProps()`).
- **New export formats**: add to `renderExports()`. Keep the existing Lua and JSON exports intact.
- **New layouts**: drop a JSON file in `layouts/`, add an entry to `LAYOUT_FILES` in `script.js`, and bump `version` in any updated JSON.

## What NOT to do

- Don't add a build step.
- Don't add npm / yarn / pnpm / poetry dependencies.
- Don't switch to a framework.
- Don't break the round-trip. Always run `node test_export.js` after changes that touch export math or layout JSON.
- Don't store coordinates in any non-canvas space in the JSON. Canvas pixels are the source of truth; export math is computed at render time.
