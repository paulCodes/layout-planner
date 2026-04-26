# Layout Planner

A vanilla HTML/JS, browser-based interactive layout planner. Drag, resize, snap, group, and align small UI elements (pixels, icons, bars, text, nested groups) on a canvas, then export the positions as Lua snippets or JSON. Useful for any small-element UI design work: game HUDs, dashboards, telemetry overlays, sprite atlases, and similar.

## Quick start

No build step. Single ES module page, no bundler, no framework, no dependencies. Two launch options.

### Realtime sync mode (preferred)

```bash
cd C:/Users/airet/workspaces/tools/layout-planner
python serve.py
```

Open <http://localhost:8000/>. `serve.py` is a stdlib-only Python server that adds bidirectional realtime sync on top of static file serving. Browser edits propagate to disk, and external edits to `current-state.json` propagate back to the browser. See "Realtime sync" below.

### Static-only mode

```bash
python -m http.server 8000
```

Same URL. Loads layouts and lets you edit them, but no realtime sync. The bottom-right indicator shows `static-only`.

A server is required either way: the page uses `fetch()` to load JSON files in `layouts/`. Opening `index.html` over `file://` works for everything except the layouts dropdown.

## Features

### Editing

- Drag and resize with snap-to-grid (hold `Alt` to drag freely without snap).
- Per-layout grid size stored in the JSON. Toolbar input (1 to 64 px) overrides it live and persists back into the layout.
- Arrow-key nudge: 1 px, or one grid cell with `Shift`.
- Marquee multi-select, `Shift`-click to extend selection, `Ctrl+D` to duplicate, `Del` / `Backspace` to delete.
- Property panel for direct numeric editing of the selected element's `x`, `y`, `w`, `h`, `anchor`, `parent`, color, and notes.
- Pan with `Space` + drag. Zoom with mouse wheel (zoom-toward-cursor, clamped 0.5x to 8x).
- Hit-priority for tiny elements: 16x16 minimum hit-target with 4 px slack, smallest-area-wins for overlapping clicks. Render order is groups, then larger elements, then smaller, so small elements stay visually on top and clickable.
- Background image upload for tracing or aligning over a reference screenshot, with an opacity slider.
- Group bounding boxes auto-recompute to wrap their children.

### Layout management

- Multi-layout dropdown populated at runtime from a list in `script.js`.
- Per-layout JSON files in `layouts/`.
- Undo / redo with a 100-entry stack. Atomic per operation: one drag = one entry, one arrow nudge = one entry, one property edit = one entry. Multi-event mutations (typing into a number field) collapse into one entry via focus / blur snapshot brackets.
- Reload-from-file toolbar button to discard local changes and re-fetch from disk.
- Version-based stale-state detection: bump `version` in the JSON file to prompt any browser holding an outdated `localStorage` copy to reload.
- localStorage autosave on every change.

### Realtime sync (when running `serve.py`)

- Browser POSTs state changes to `/state`, debounced 500 ms.
- Server broadcasts changes to all SSE subscribers via `/events`.
- File watcher detects external edits to `current-state.json` and broadcasts.
- Server-assigned monotonic version, conflict resolution via 409 plus reconciliation.
- Heartbeat every 15 s, auto-reconnect with gap-closing `GET /state`.
- Loop prevention via version comparison and a "drag in progress" SSE queue.
- Sync status indicator in the toolbar (green = live, yellow = connecting, gray = offline / static-only).

### Exports

- Lua snippet export and generic JSON export, each with copy-to-clipboard.
- Round-trip verification via `node test_export.js`.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+D` | Duplicate selection |
| `Del` / `Backspace` | Delete selection |
| Arrow keys | Nudge selection 1 px |
| `Shift` + arrows | Nudge selection one grid cell |
| Drag | Move (snap on) |
| `Alt` + drag | Move freely (no snap) |
| `Shift` + click | Add to selection |
| Drag empty space | Marquee select |
| `Space` + drag | Pan canvas |
| Mouse wheel | Zoom (clamped 0.5x to 8x) |

Live cursor coordinates are shown in the top bar.

## JSON layout schema

Minimal example:

```jsonc
{
  "version": 1,
  "schemaVersion": 1,
  "name": "My layout",
  "description": "freeform notes",
  "canvas": {
    "width": 800,
    "height": 300,
    "gridSize": 8,
    "originOffset": { "x": 0, "y": 0 },
    "backgroundImage": null
  },
  "exportConfig": { "barX": -55, "barY": 0 },
  "elements": [
    {
      "id": "MyPixel",
      "type": "pixel",
      "name": "MyPixel",
      "parent": null,
      "anchorPoint": "TOPLEFT",
      "x": 100, "y": 50, "w": 8, "h": 8,
      "color": "rgba(0,200,0,1)",
      "lua_template": "xOffset = BAR_X + 0, yOffset = -50",
      "notes": "freeform"
    }
  ]
}
```

Field notes:

- `version`: bump this when you update the on-disk file (see "Versioning" under Realtime sync).
- `canvas.gridSize`: snap step in pixels. Per-layout. The toolbar's grid input writes back to this field.
- `canvas.originOffset`: canvas-space anchor for top-level (parentless) elements. Exports compute offsets as `element-anchor minus parent-anchor`.
- `elements[].type`: one of `pixel`, `icon`, `bar`, `group`, `text`.
- `elements[].parent`: id of a `group` element, or `null` for top-level.
- `elements[].anchorPoint`: `TOPLEFT` or `CENTER`. Drives anchor math and exports.
- `elements[].lua_template`: optional. If the template's numeric `xOffset` matches the computed export, the export uses the template expression (e.g. `BAR_X + 30`) instead of the literal number.
- `exportConfig.barX` / `barY`: convenience constants for shorthand Lua rendering.

## Realtime sync details

When run via `python serve.py`, the planner participates in a bidirectional realtime channel between the browser and a single shared state file (`current-state.json`). Any external process (a terminal editor, a script, a downstream consumer) can read and write that file, and the browser will see changes within ~250 ms. Conversely, browser edits write through the server and propagate via Server-Sent Events.

Single user only: there is no conflict resolution beyond "last writer wins, server arbitrates order via a monotonic version counter." See `CLAUDE.md` for the wire protocol and the agent-side editing recipe.

The status indicator at the bottom-right of the page shows the connection state: `live` (green), `connecting...` (yellow), `offline` / `reconnect #N` (gray), `static-only` (no sync server).

### Wire protocol summary

| Endpoint | Behavior |
|---|---|
| `GET /state` | Returns `{version, state}`. |
| `POST /state` | Body `{version, state}`. If version matches, server bumps and broadcasts. If not, returns `409` with current `{version, state}` for client reconciliation. |
| `GET /events` | SSE stream. Sends current state on connect, pushes `event: state` with `id: <version>` on every change, heartbeats every 15 s. |

### Versioning

Each layout JSON has a top-level `version` integer. localStorage caches the active layout including its `version`. On boot, the planner compares the on-disk version to the cached one. If the file is newer, the user is prompted to discard local changes and reload. To publish an update that should propagate to existing browsers, bump `version` in the JSON file. The "Reload" toolbar button is the manual escape hatch.

## Built-in layouts and adding new ones

`layouts/` ships with:

- `wa-pixel-bridge.json`: an example layout demonstrating nested groups, mixed `CENTER` and `TOPLEFT` anchors, and 50+ elements. `gridSize: 10`.
- `godot-hud-example.json`: empty 1920x1080 stub for HUD planning over a screenshot.

To add a new layout:

1. Drop a JSON file into `layouts/` (see schema above).
2. Add an entry to the `LAYOUT_FILES` array near the top of `script.js`:

   ```js
   const LAYOUT_FILES = [
     { slug: "wa-pixel-bridge",   path: "layouts/wa-pixel-bridge.json"   },
     { slug: "godot-hud-example", path: "layouts/godot-hud-example.json" },
     // add yours here
   ];
   ```

   The dropdown in `index.html` is populated at runtime from this array, so no HTML edit is needed.

3. Refresh the page. The new layout appears in the dropdown.

For a fresh project, set `canvas.gridSize` to your project's natural pixel scale (8 for general use, 1 for pixel-perfect work). Optionally set a per-element `lua_template` so the export emits your own constants or macros instead of literal numbers.

## Round-trip test

```bash
node test_export.js
```

Loads `layouts/wa-pixel-bridge.json`, runs the same anchor math the in-page exporter uses, and asserts every named element exports to its expected `xOffset` / `yOffset` values. Run this after any change to export math or to the example layout.

## Element types and anchors

Element types: `pixel`, `icon`, `bar`, `group`, `text`. Groups can contain other elements (including other groups), and their bounding boxes auto-recompute to wrap their children.

Anchor points: `TOPLEFT` and `CENTER`. Exports compute a position as the element's anchor minus its parent's anchor (top-level elements use `canvas.originOffset` as the parent anchor). Y is flipped on export to match the Lua-style anchor convention where negative Y means "below."

## Hot tips and gotchas

- All canvas-space mouse math goes through `pageToCanvas(clientX, clientY)`, which accounts for stage CSS positioning, transform translate, and zoom. Hit-test, drag, resize, and marquee math all use it. Raw `clientX` / `clientY` would be wrong at any non-1.0 zoom.
- Render order is groups, then larger non-group elements, then smaller. This keeps small elements visually on top of larger backgrounds without sacrificing hit-testability.
- Tiny elements get a 16x16 minimum hit-target with 4 px slack; overlapping hits resolve to the smallest-area element.
- Grid size is per-layout, not global. Don't normalize one layout's grid to match another.
- Group bounding boxes are auto-recomputed from children. Don't manually edit a group's `w` / `h` and expect it to stick if children are added or moved later.
- The "Reload" button discards in-browser changes and re-fetches from disk. It is the manual version of the stale-state prompt.
