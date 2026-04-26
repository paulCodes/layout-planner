# Layout Planner

A vanilla HTML/JS, browser-based interactive layout planner. Drag, resize, and snap small elements (pixels, icons, bars, groups, text) on a canvas, then export the positions as Lua snippets or generic JSON.

Originally built to plan WeakAura "pixel bridge" layouts for a WoW bot project, but generic enough for any small-element layout work: game HUDs, dashboards, sprite atlases, and similar.

## No build step

Single-file ES module page. No bundler, no framework, no dependencies. Launch with a static file server:

```bash
cd C:/Users/airet/workspaces/tools/layout-planner
python -m http.server 8000
```

Then open <http://localhost:8000/>. The server is required because the page uses `fetch()` to load the JSON files in `layouts/`. Opening `index.html` over `file://` works for everything except the layouts dropdown.

## Features

- Drag and resize with snap-to-grid
- Per-layout grid size stored in the JSON, with a toolbar input that overrides it live
- Nested groups with `TOPLEFT` and `CENTER` anchors
- Undo / redo: `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`
- Arrow-key nudge: 1 px, or one grid cell with `Shift`
- Background image overlay with opacity slider (drop a screenshot, lay pixels on top)
- Multi-layout dropdown with version-based stale-state detection and a "Reload from disk" button
- Exports to Lua snippets and generic JSON, each with a copy-to-clipboard button
- localStorage autosave on every change

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

## Layouts

Built-in layouts live in `layouts/`:

- `wa-pixel-bridge.json`: positions for every dot, bar, and icon in the Shadow Priest WeakAura pixel bridge. Mirrors `addons/ShadowPriestTrackerInstaller/ShadowPriestTrackerInstaller.lua` from the wow-bot project. `gridSize: 10` to match the addon's 10 px dot spacing.
- `godot-hud-example.json`: empty 1920x1080 stub for HUD planning over a screenshot.

### Adding a new layout

1. Drop a JSON file into `layouts/` (see schema below).
2. Add a `<option>` entry to the `LAYOUT_FILES` array near the top of `script.js`:

   ```js
   const LAYOUT_FILES = [
     { slug: "wa-pixel-bridge",   path: "layouts/wa-pixel-bridge.json"   },
     { slug: "godot-hud-example", path: "layouts/godot-hud-example.json" },
     // add yours here
   ];
   ```

   The dropdown in `index.html` is empty in the source and gets populated at runtime from this array, so no HTML edit is needed.

3. Refresh the page. The new layout appears in the dropdown.

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

- `version`: bump this when you update the on-disk file (see Versioning).
- `canvas.gridSize`: snap step in pixels. Per-layout. The toolbar's grid input writes back to this field.
- `canvas.originOffset`: canvas-space anchor for top-level (parentless) elements. Exports compute offsets as `element-anchor minus parent-anchor`.
- `elements[].type`: one of `pixel`, `icon`, `bar`, `group`, `text`.
- `elements[].parent`: id of a `group` element, or `null` for top-level.
- `elements[].anchorPoint`: `TOPLEFT` or `CENTER`. Drives anchor math and exports.
- `elements[].lua_template`: optional. If the template's numeric `xOffset` matches the computed export, the export uses the template expression (e.g. `BAR_X + 30`) instead of the literal number.
- `exportConfig.barX` / `barY`: convenience constants for shorthand Lua rendering.

## Versioning

Each layout JSON has a top-level `version` integer. localStorage caches the active layout including its `version`. On boot, the planner compares the on-disk version to the cached one. If the file is newer, the user is prompted to discard local changes and reload.

To publish an update that should propagate to existing browsers, bump `version` in the JSON file. The "Reload" toolbar button does the same thing manually.

## Round-trip test

```bash
node test_export.js
```

Loads `layouts/wa-pixel-bridge.json`, runs the same anchor math the in-page exporter uses, and asserts every named element exports to its source-of-truth WA `xOffset` / `yOffset` values extracted from `ShadowPriestTrackerInstaller.lua`. Run this after any change to export math or to that layout.

## Original use case

Built to plan a WoW WeakAura pixel bridge for the wow-bot project at `~/workspaces/mono-time-savers/`. The `wa-pixel-bridge.json` layout mirrors the actual addon at `addons/ShadowPriestTrackerInstaller/ShadowPriestTrackerInstaller.lua`. Workflow: drag elements visually to plan a new layout, then copy the exported `xOffset` / `yOffset` values back into the Lua addon source.

## Adding a new project

1. Create a new layout JSON sized for your project (e.g. 1920x1080).
2. Set `canvas.gridSize` to your project's natural pixel scale (8 for general use, 10 for the WA pixel bridge, 1 for pixel-perfect work).
3. Optionally set a per-element `lua_template` so the export emits your own constants or macros instead of literal numbers.
4. Register the layout in `LAYOUT_FILES` in `script.js`.
