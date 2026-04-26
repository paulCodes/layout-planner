"""Tests for wa_addon exporter.

Run with:
    python -m pytest exporters/test_wa_addon.py -v

Stdlib-only; uses pytest if available, but falls back to plain asserts.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import wa_addon as wa

REPO = Path(__file__).resolve().parent.parent
LAYOUT_JSON = REPO / "layouts" / "wa-pixel-bridge.json"

# The Lua addon lives outside this repo and is consumer-specific. Set the
# LAYOUT_PLANNER_ADDON_LUA env var to enable addon-dependent tests; otherwise
# they're skipped.
_ADDON_ENV = os.environ.get("LAYOUT_PLANNER_ADDON_LUA")
ADDON_LUA = Path(_ADDON_ENV) if _ADDON_ENV else None


def _require_addon() -> Path:
    """Skip (or early-return for non-pytest runs) when LAYOUT_PLANNER_ADDON_LUA isn't set."""
    if ADDON_LUA is None:
        try:
            import pytest

            pytest.skip("LAYOUT_PLANNER_ADDON_LUA env var not set; skipping addon-dependent test")
        except ImportError:
            print("skipped (LAYOUT_PLANNER_ADDON_LUA not set)")
            raise _SkipTest()
    return ADDON_LUA


class _SkipTest(Exception):
    """Sentinel for the no-pytest fallback runner to treat as 'skipped'."""


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _load_layout() -> dict:
    return json.loads(LAYOUT_JSON.read_text(encoding="utf-8"))


def _origin(layout: dict) -> wa.Anchor:
    o = layout["canvas"].get("originOffset") or {"x": 0, "y": 0}
    return wa.Anchor(float(o["x"]), float(o["y"]))


# ---------------------------------------------------------------------------
# Parse / element list
# ---------------------------------------------------------------------------


def test_parse_returns_expected_element_set() -> None:
    layout = _load_layout()
    ids = {el["id"] for el in layout["elements"]}
    # A few must-have ids spanning all element classes.
    must_have = {
        "PREFIX_GROUP",
        "PB_GROUP",
        "BUFF_GROUP",
        "Bar_HP",
        "Bar_Mana",
        "Bar_ManaTick",
        "BeaconStrip0",
        "BeaconStrip5",
        "Dot0",
        "Dot22",
        "MC0",
        "MC4",
        "Buff_SF",
        "Buff_Food",
        "Icon_VT",
        "NextCast",
        "POM",
    }
    missing = must_have - ids
    assert not missing, f"missing expected ids: {missing}"


# ---------------------------------------------------------------------------
# Offset math
# ---------------------------------------------------------------------------


def test_compute_offset_matches_js_formula_for_known_dot() -> None:
    """Dot0_in_combat: canvas (x=265, y=198), parent PB_GROUP anchor=(200,20).
    JS: xOffset = 265 - 200 = 65; yOffset = -(198 - 20) = -178.
    """
    layout = _load_layout()
    by_id = {e["id"]: e for e in layout["elements"]}
    origin = _origin(layout)
    dot0 = by_id["Dot0"]
    x, y = wa.compute_wa_offset(dot0, by_id, origin)
    assert x == 65
    assert y == -178


def test_compute_offset_top_level_uses_origin_offset() -> None:
    """PREFIX_GROUP is parentless; its anchor IS originOffset, so it must
    export as (0, 0) (this is the planner's invariant).
    """
    layout = _load_layout()
    by_id = {e["id"]: e for e in layout["elements"]}
    origin = _origin(layout)
    pg = by_id["PREFIX_GROUP"]
    x, y = wa.compute_wa_offset(pg, by_id, origin)
    assert (x, y) == (0, 0), f"PREFIX_GROUP should export (0,0), got ({x},{y})"


def test_eval_simple_expr_handles_bar_x_plus_n() -> None:
    assert wa.eval_simple_expr("BAR_X + 30", {"BAR_X": -55}) == -25
    assert wa.eval_simple_expr("STRIP_X", {"STRIP_X": -66}) == -66
    assert wa.eval_simple_expr("ICON_X + 0", {"ICON_X": -122}) == -122


def test_eval_simple_expr_rejects_unsafe_strings() -> None:
    assert wa.eval_simple_expr("__import__('os')", {}) is None
    assert wa.eval_simple_expr("foo.bar", {}) is None


def test_preferred_x_expr_keeps_named_constant_when_value_matches() -> None:
    out = wa.preferred_x_expr("xOffset = BAR_X + 30, yOffset = -79", -25, {"BAR_X": -55})
    assert out == "BAR_X + 30"


def test_preferred_x_expr_falls_back_to_literal_when_value_drifts() -> None:
    # template says BAR_X+30 = -25, but actual numeric is 100 -> use literal.
    out = wa.preferred_x_expr("xOffset = BAR_X + 30, yOffset = -79", 100, {"BAR_X": -55})
    assert out == "100"


# ---------------------------------------------------------------------------
# Patch idempotency / safety
# ---------------------------------------------------------------------------


def _run_patch(text: str) -> tuple[str, wa.PatchResult]:
    layout = _load_layout()
    elements = layout["elements"]
    by_id = {e["id"]: e for e in elements}
    origin = _origin(layout)
    desired = wa.derive_constants(elements, by_id, origin, layout.get("exportConfig"))
    res = wa.patch_lua(text, elements, by_id, origin, desired)
    return res.new_text, res


def test_patch_is_idempotent_on_real_addon() -> None:
    addon = _require_addon()
    text = addon.read_text(encoding="utf-8")
    once, _ = _run_patch(text)
    twice, second = _run_patch(once)
    assert once == twice, "second patch should be a no-op"
    assert not second.constant_changes, "no constants should change second pass"
    assert not second.aura_changes, "no aura blocks should change second pass"


def test_patch_preserves_handwritten_lua_logic() -> None:
    """Snapshot a non-position line and verify it survives patching unchanged."""
    addon = _require_addon()
    text = addon.read_text(encoding="utf-8")
    # Pick something distinctive that lives inside an aura init_code string.
    sentinel = "if region.SetVertexColor then"
    assert sentinel in text, "test sentinel not present in addon"
    new_text, _ = _run_patch(text)
    assert sentinel in new_text, "patcher destroyed handwritten Lua logic"
    # Also ensure the install function trampoline is intact.
    assert "WeakAuras.Add(aura)" in new_text


def test_patch_does_not_introduce_pcall() -> None:
    """WA sandbox forbids pcall in WA-eval'd code. Patcher must not change
    the count of pcall occurrences (addon-side install pcalls are fine).
    """
    addon = _require_addon()
    text = addon.read_text(encoding="utf-8")
    new_text, _ = _run_patch(text)
    assert text.count("pcall(") == new_text.count("pcall(")


# ---------------------------------------------------------------------------
# Audit / missing-aura detection
# ---------------------------------------------------------------------------


def test_lua_aura_ids_excludes_parameterized_ids() -> None:
    addon = _require_addon()
    text = addon.read_text(encoding="utf-8")
    ids = wa.lua_aura_ids(text)
    # Should not capture concatenation prefixes like "_Buff_" or "_Dot".
    assert "_Buff_" not in ids
    assert "_Dot" not in ids
    assert "_BeaconStrip" not in ids
    # Should capture concrete literals.
    assert "_Bar_HP" in ids
    assert "_NextCast" in ids
    assert "_Dot21" in ids  # Dot21 has a literal block
    assert "_MC0" in ids


def test_audit_reports_missing_planner_elements() -> None:
    """Pretend a planner element is missing from the Lua and confirm we flag
    it as 'planner element not in Lua'.
    """
    layout = _load_layout()
    elements = layout["elements"]
    # Inject a fake aura into a fresh planner copy.
    fake = {
        "id": "Bar_Imaginary",
        "type": "bar",
        "name": "Bar_Imaginary",
        "parent": "PB_GROUP",
        "anchorPoint": "TOPLEFT",
        "x": 100,
        "y": 100,
        "w": 50,
        "h": 4,
    }
    # Force it to map to a Lua suffix that doesn't exist by adding to map.
    wa.PLANNER_TO_LUA_ID["Bar_Imaginary"] = "_Bar_Imaginary"
    try:
        elements_with_fake = elements + [fake]
        by_id = {e["id"]: e for e in elements_with_fake}
        origin = _origin(layout)
        desired = wa.derive_constants(
            elements_with_fake, by_id, origin, layout.get("exportConfig")
        )
        addon = _require_addon()
        text = addon.read_text(encoding="utf-8")
        res = wa.patch_lua(text, elements_with_fake, by_id, origin, desired)
        assert "_Bar_Imaginary" in res.missing_auras
    finally:
        del wa.PLANNER_TO_LUA_ID["Bar_Imaginary"]


def test_planner_only_elements_are_excluded_from_patching() -> None:
    """Elements with NEW_/Reserved_ prefix shouldn't try to patch the Lua."""
    layout = _load_layout()
    elements = layout["elements"]
    by_id = {e["id"]: e for e in elements}
    origin = _origin(layout)
    desired = wa.derive_constants(elements, by_id, origin, layout.get("exportConfig"))
    addon = _require_addon()
    text = addon.read_text(encoding="utf-8")
    res = wa.patch_lua(text, elements, by_id, origin, desired)
    for change in res.aura_changes:
        assert not change.aura_id.startswith("_NEW_"), change.aura_id
        assert not change.aura_id.startswith("_Reserved_"), change.aura_id


# ---------------------------------------------------------------------------
# Constant derivation
# ---------------------------------------------------------------------------


def test_derive_constants_matches_planner_invariants() -> None:
    layout = _load_layout()
    elements = layout["elements"]
    by_id = {e["id"]: e for e in elements}
    origin = _origin(layout)
    out = wa.derive_constants(elements, by_id, origin, layout.get("exportConfig"))
    # BAR_W must come from Bar_HP width.
    assert out["BAR_W"] == int(by_id["Bar_HP"]["w"])
    # ICON_SIZE must come from NextCast width.
    assert out["ICON_SIZE"] == int(by_id["NextCast"]["w"])
    # BAR_X must come from exportConfig.barX.
    assert out["BAR_X"] == layout["exportConfig"]["barX"]


# Allow running this file directly without pytest.
if __name__ == "__main__":
    import inspect
    import sys

    # If pytest is importable, pytest.skip() raises pytest.skip.Exception
    # (a.k.a. _pytest.outcomes.Skipped). Treat that as a skip too.
    try:
        import pytest as _pytest_mod

        _PytestSkip: type[BaseException] = _pytest_mod.skip.Exception  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        _PytestSkip = _SkipTest  # alias so the except clause is harmless

    failed = 0
    passed = 0
    skipped = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn) and inspect.isfunction(fn):
            try:
                fn()
            except (_SkipTest, _PytestSkip):
                skipped += 1
                print(f"SKIP {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"ERROR {name}: {type(e).__name__}: {e}")
            else:
                passed += 1
                print(f"PASS {name}")
    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    sys.exit(1 if failed else 0)
