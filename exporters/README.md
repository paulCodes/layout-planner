# exporters/

One-way format adapters that read a layout-planner JSON and patch / generate
artifacts for downstream consumers. The planner is the source of truth; each
exporter knows about exactly one consumer.

## Pattern

- **One Python file per consumer.** Naming: `<consumer-slug>.py`.
- **Stdlib only.** No Poetry, no pip, no third-party deps. The planner repo is
  intentionally dependency-free; exporters live in the same boat.
- **Idempotent and surgical.** Re-running an exporter against an already-up-to-
  date target should produce zero changes. Never overwrite hand-written logic;
  only touch the specific fields the planner owns (positions, sizes, named
  constants).
- **Read-only on the planner JSON.** Never write back to `layouts/*.json` from
  an exporter; that's the planner's job.
- **Always supports `--dry-run`.** Print a diff summary without touching files.
  This is how callers gate "is the planner ahead of the addon?" CI checks.
- **CLI flags follow the same convention** as `wa_addon.py`:
  `--json PATH`, `--<target> PATH`, `--dry-run`, `--verbose`.

## Current exporters

| File | Reads | Writes |
|---|---|---|
| `wa_addon.py` | `layouts/wa-pixel-bridge.json` | `addons/ShadowPriestTrackerInstaller/ShadowPriestTrackerInstaller.lua` (numeric position constants and per-aura `xOffset` / `yOffset` / `width` / `height` fields only) |

## Adding a new exporter

1. Create `exporters/<slug>.py`.
2. Implement a `main(argv)` entry point with `--dry-run`, `--json`, the
   target-path flag, and `--verbose`.
3. Mirror the WA-convention math from `script.js:computeWaOffset` if your
   target uses anchor offsets:

   ```python
   xOffset = anchor.x - parent_anchor.x
   yOffset = -(anchor.y - parent_anchor.y)
   ```

   Top-level (parentless) elements use `canvas.originOffset` as the parent
   anchor.

4. **Preserve named-constant expressions** when the numeric value matches.
   The planner stores Lua-style hints in `lua_template`
   (e.g. `xOffset = BAR_X + 30, yOffset = -79`); if the computed numeric
   `xOffset` equals `BAR_X + 30`, prefer the symbolic form so the target's
   constant references survive round-tripping. See
   `wa_addon.preferred_x_expr` for reference.

5. Add `exporters/test_<slug>.py` with at minimum:
   - element-list parse sanity
   - one known-good offset assertion against the JS formula
   - idempotency (run twice -> identical output)
   - a "preserves hand-written logic" check (snapshot a non-position line)
   - audit: detect target items missing from the planner and vice versa

6. Document the exporter in this README's "Current exporters" table.

## Run

```bash
# dry-run / preview
python exporters/wa_addon.py --dry-run

# write
python exporters/wa_addon.py

# alternate paths
python exporters/wa_addon.py --json some.json --addon some.lua

# tests (pytest if installed; falls back to direct execution)
python -m pytest exporters/ -v
python exporters/test_wa_addon.py
```

## Why exporters live here, not in each consumer

- The translation rule (canvas-coords -> consumer-format) is owned by the
  planner. Putting exporters here keeps the math next to the JS that defines
  it (`script.js:computeWaOffset`), so drift between the planner and any
  exporter is caught by the planner's own tests.
- Consumers don't need to know about the planner's internal coordinate space.
  They just receive patches.
- Adding a new consumer (e.g. a different addon, a Python config file, a JSON
  manifest for a runtime overlay) is a pure additive change: drop a new file
  in this folder, no edits to the consumer.
