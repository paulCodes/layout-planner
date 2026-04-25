# Layout Planner

A tiny, dependency-free, browser-based layout planner. Drag pixels, icons, and bars on a snap-to-grid canvas. Useful for planning WeakAura pixel bridges (WoW bot use case) and Godot HUDs.

No build step. Pure HTML/CSS/JS. Run a local static server and open the page.

## Launch

```bash
cd C:/Users/airet/workspaces/tools/layout-planner
python -m http.server 8000
```

Then open <http://localhost:8000/> in any modern browser.

(`python -m http.server` is required so the page can `fetch()` the JSON files in `layouts/`. Opening `index.html` directly via `file://` will work for everything except the layouts dropdown.)

## Layouts

- `layouts/wa-pixel-bridge.json` -- preloaded with the actual current positions of every dot/bar/icon in `mono-time-savers/addons/ShadowPriestTrackerInstaller/ShadowPriestTrackerInstaller.lua`. Includes 4 RESERVED placeholders for planning future expansion.
- `layouts/godot-hud-example.json` -- empty 1920x1080 stub for HUD planning.

Switch layouts with the dropdown in the top bar. Layouts auto-save to `localStorage` on every change, so a refresh keeps your work. Use **Save JSON** / **Load JSON** to round-trip files on disk.

## Background Image

Click the **BG Image** file picker to drop a screenshot behind the canvas at 1:1 scale. Adjust opacity with the slider. Useful for laying pixels over an actual screen capture.

## Keyboard Shortcuts

| Key                         | Action                            |
|-----------------------------|-----------------------------------|
| `Del` / `Backspace`         | Delete selection                  |
| `Ctrl+D`                    | Duplicate selection               |
| Arrow keys                  | Nudge selection 1 px              |
| `Shift` + Arrow keys        | Nudge selection 8 px (one grid)   |
| Drag                        | Move (snap to 8 px)               |
| `Alt` + drag                | Move freely (no snap)             |
| `Shift` + click             | Add to selection                  |
| Drag empty space            | Marquee select                    |
| `Space` + drag              | Pan canvas                        |
| Mouse wheel                 | Zoom (clamped 0.5x .. 8x)         |

Coordinates of the cursor (in canvas pixels) are shown in the top bar.

## Export

The right sidebar live-updates two exports:

- **Lua snippet** -- for each named element, prints `xOffset = BAR_X + N, yOffset = M` so you can paste positions back into a WeakAura installer. The reference `BAR_X` value is editable (default `-55`, matching the Shadow Priest tracker). The Y axis is flipped to match WeakAuras' convention (negative-down from origin).
- **Generic JSON** -- full layout dump.

Each export has a **Copy** button.

## JSON Layout Schema

```jsonc
{
  "schemaVersion": 1,
  "name": "Layout name",
  "description": "freeform notes",
  "canvas": {
    "width":  800,        // px
    "height": 300,        // px
    "background": "#101015",
    "gridSize": 8,        // snap step
    "gridVisible": true,
    "originOffset": { "x": 0, "y": 0 }   // optional reference origin used by exports
  },
  "exportConfig": {
    "barX": -55,          // BAR_X used for the Lua export
    "barY": 0
  },
  "elements": [
    {
      "id":     "MC0",
      "type":   "pixel",  // pixel | icon | bar | group | text
      "name":   "MC0_HP_Mana_THP",
      "parent": "PB_GROUP",          // null or another element id
      "x": 475, "y": 71, "w": 8, "h": 8,
      "color":  "rgba(0,200,0,1)",   // any CSS colour
      "text":   "label text",        // text type only
      "lua_template": "xOffset = BAR_X + 230, yOffset = -79",  // optional comment in Lua export
      "notes":  "freeform"
    }
  ]
}
```

Element rules:

- IDs must be unique inside a layout.
- A `group` element acts as a folder; child elements set `"parent": "<group-id>"`. Moving the group moves all children.
- `pixel`, `icon`, `bar`, and `text` are leaf elements.
- The planner stores absolute canvas coordinates; the Lua exporter computes offsets relative to `BAR_X` / `BAR_Y` and the canvas's `originOffset`. To match the WA addon's convention, set `originOffset` so that `(BAR_X, BAR_Y)` lines up with where you'd want the WA group origin on the canvas.

## Hand-editing

Everything is a single page (`index.html`), one stylesheet (`style.css`), and one script (`script.js`). The script keeps a single `state` object, persists it to `localStorage` after every mutation, and re-renders by rebuilding the elements/outline DOM. Easy to fork. Easy to break. No frameworks.
