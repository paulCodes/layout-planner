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
python -m http.server 8000   # serve the page
node test_export.js          # round-trip exporter test
```

The test runner has no dependencies; just Node.

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
