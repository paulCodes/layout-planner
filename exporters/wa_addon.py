"""WeakAura addon exporter for layout-planner JSON.

Reads a layout-planner JSON file and patches numeric position constants and
per-aura xOffset/yOffset/width/height values in the WoW WeakAura installer Lua
addon. One-way exporter; planner is the source of truth.

Translation rule (mirrors script.js:computeWaOffset):
    xOffset = anchor.x - parentAnchor.x
    yOffset = -(anchor.y - parentAnchor.y)

Where parentAnchor falls back to canvas.originOffset for top-level elements.
The planner's originOffset is positioned so PREFIX_GROUP exports as (0,0).

Idempotent and safe: only updates assignment values for known keys inside
known per-aura blocks. Hand-written Lua logic (triggers, init code, conditions,
text helpers, etc.) is never touched.

Usage:
    python wa_addon.py [--dry-run] [--json PATH] [--addon PATH] [--verbose]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_JSON = Path(__file__).resolve().parent.parent / "layouts" / "wa-pixel-bridge.json"
# No default addon path: the Lua addon lives outside this repo and is
# consumer-specific. Pass --addon explicitly (or set it in your own wrapper).
DEFAULT_ADDON: Path | None = None

# Top-level Lua constants we manage. Keys here are (lua-constant-name,
# planner-derived-value-source).
TOP_LEVEL_CONSTANTS = (
    "BAR_W",
    "BAR_X",
    "STRIP_X",
    "ICON_X",
    "ICON_SIZE",
    "DOT_Y_TARGET",
    "DOT_Y_PLAYER",
)

# Map from planner element name -> lua aura id suffix (the part after PREFIX..).
# Most are 1:1 (planner "Bar_HP" -> Lua "_Bar_HP"); ManaTick is the exception.
PLANNER_TO_LUA_ID: dict[str, str] = {
    "PREFIX_GROUP": "",  # top-level group; only for export-config sanity
    "PB_GROUP": "_PixelBridge",  # in Lua: id = PB_GROUP local
    "BUFF_GROUP": "_Buffs",  # in Lua: id = BUFF_GROUP local
    "Bar_HP": "_Bar_HP",
    "Bar_Mana": "_Bar_Mana",
    "Bar_ManaTick": "_ManaTick",
    "NextCast": "_NextCast",
    "POM": "_POM",
    "Icon_VT": "_Icon_VT",
    "Icon_SWP": "_Icon_SWP",
    "Icon_MB": "_Icon_MB",
    "Icon_SWD": "_Icon_SWD",
    "Icon_MF": "_Icon_MF",
    "Buff_SF": "_Buff_SF",
    "Buff_Fort": "_Buff_Fort",
    "Buff_IF": "_Buff_IF",
    "Buff_Flask": "_Buff_Flask",
    "Buff_Oil": "_Buff_Oil",
    "Buff_Food": "_Buff_Food",
    # NEW_ MC pixels: planner-side ids map to already-implemented Lua auras.
    "NEW_MC_TgtDebuff": "_MC_TgtDebuff",
    "NEW_MC_PlayerBuff": "_MC_PlayerBuff",
    "NEW_MC_BagHeartbeat": "_MC_BagHeartbeat",
    # MCs and beacons follow patterns; handled programmatically below.
}

# Element ids that are planner-side only (not yet ported to addon).
# Anything starting with these prefixes that ISN'T in PLANNER_TO_LUA_ID
# (above) is treated as planner-only and skipped.
PLANNER_ONLY_PREFIXES = ("NEW_", "Reserved_")


# ---------------------------------------------------------------------------
# Anchor math (mirrors script.js)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Anchor:
    x: float
    y: float


def anchor_point_of(el: dict) -> str:
    return el.get("anchorPoint", "TOPLEFT")


def compute_anchor(el: dict) -> Anchor:
    if (
        el.get("type") == "group"
        and isinstance(el.get("anchor"), dict)
        and "x" in el["anchor"]
        and "y" in el["anchor"]
    ):
        return Anchor(float(el["anchor"]["x"]), float(el["anchor"]["y"]))
    if anchor_point_of(el) == "CENTER":
        return Anchor(float(el["x"]) + float(el["w"]) / 2, float(el["y"]) + float(el["h"]) / 2)
    return Anchor(float(el["x"]), float(el["y"]))


def compute_parent_anchor(el: dict, by_id: dict[str, dict], origin: Anchor) -> Anchor:
    pid = el.get("parent")
    if not pid:
        return origin
    parent = by_id.get(pid)
    if not parent:
        return origin
    return compute_anchor(parent)


def compute_wa_offset(el: dict, by_id: dict[str, dict], origin: Anchor) -> tuple[int, int]:
    a = compute_anchor(el)
    pa = compute_parent_anchor(el, by_id, origin)
    return _to_int(a.x - pa.x), _to_int(-(a.y - pa.y))


def _to_int(v: float) -> int:
    """Numeric offsets are pixels; coerce to int for clean Lua output."""
    iv = int(round(v))
    return iv


# ---------------------------------------------------------------------------
# Lua-template handling
# ---------------------------------------------------------------------------

# Match the x part of a template string like "xOffset = BAR_X + 14, yOffset = -79"
# or "xOffset = -39, yOffset = -8".
_TPL_X_RE = re.compile(r"xOffset\s*=\s*([^,]+?)\s*,")
_SAFE_EXPR_RE = re.compile(r"^[-+*/().\d\s]+$")


def eval_simple_expr(expr: str, vars_: dict[str, int]) -> int | None:
    """Tiny evaluator for "BAR_X + 30", "STRIP_X", "-55", "ICON_X". Mirrors JS."""
    s = expr.strip()
    for k, v in vars_.items():
        s = re.sub(rf"\b{re.escape(k)}\b", f"({v})", s)
    if not _SAFE_EXPR_RE.match(s):
        return None
    try:
        v = eval(s, {"__builtins__": {}}, {})  # noqa: S307 - pre-validated regex
    except Exception:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(round(v))
    return None


def preferred_x_expr(
    template: str | None,
    numeric_x: int,
    constants: dict[str, int],
) -> str:
    """If the template encodes a named-constant-relative expression whose
    numeric value matches numeric_x, prefer the named expression so the patched
    Lua keeps its constants. Otherwise fall back to the literal int.
    """
    if not template or template.lstrip().startswith("//"):
        return str(numeric_x)
    m = _TPL_X_RE.search(template)
    if not m:
        return str(numeric_x)
    expr = m.group(1).strip()
    val = eval_simple_expr(expr, constants)
    if val is not None and val == numeric_x:
        return expr
    return str(numeric_x)


# ---------------------------------------------------------------------------
# Planner -> Lua aura id resolution
# ---------------------------------------------------------------------------


def lua_id_suffix(el: dict) -> str | None:
    """Return the suffix (e.g. "_Dot0", "_MC3") used in `id = PREFIX .. "<suffix>"`,
    or None for elements not present in the addon (planner-only or origin marker).
    """
    eid = el["id"]
    # Explicit map wins over the planner-only prefix filter (covers NEW_MC_*
    # ids that DO have a Lua aura).
    if eid in PLANNER_TO_LUA_ID:
        suf = PLANNER_TO_LUA_ID[eid]
        return suf if suf else None  # PREFIX_GROUP itself isn't a child aura
    if any(eid.startswith(p) for p in PLANNER_ONLY_PREFIXES):
        return None
    if eid.startswith("BeaconStrip"):
        return "_BeaconStrip" + eid[len("BeaconStrip") :]
    if eid.startswith("Dot"):
        # planner ids are "Dot0", "Dot22"; Lua ids are "_Dot0", "_Dot22".
        return "_Dot" + eid[len("Dot") :]
    if eid.startswith("MC"):
        return "_MC" + eid[len("MC") :]
    return None


# ---------------------------------------------------------------------------
# Lua patcher
# ---------------------------------------------------------------------------


@dataclass
class ConstantChange:
    name: str
    old: int
    new: int


@dataclass
class AuraChange:
    aura_id: str  # the suffix, e.g. "_Bar_HP"
    fields: dict[str, tuple[str, str]]  # field -> (old, new) raw strings


@dataclass
class PatchResult:
    new_text: str
    constant_changes: list[ConstantChange]
    aura_changes: list[AuraChange]
    missing_auras: list[str]  # planner elements with no matching block in Lua


# Match a `local <NAME> = <intliteral>` line (allow trailing comment).
def _const_re(name: str) -> re.Pattern[str]:
    return re.compile(
        rf"^(?P<lead>local\s+{re.escape(name)}\s*=\s*)(?P<val>-?\d+)(?P<tail>.*)$",
        re.MULTILINE,
    )


def patch_constants(text: str, desired: dict[str, int]) -> tuple[str, list[ConstantChange]]:
    changes: list[ConstantChange] = []
    out = text
    for name, new_val in desired.items():
        rx = _const_re(name)
        m = rx.search(out)
        if not m:
            continue
        old_val = int(m.group("val"))
        if old_val == new_val:
            continue
        out = rx.sub(lambda mm, nv=new_val: f"{mm.group('lead')}{nv}{mm.group('tail')}", out, count=1)
        changes.append(ConstantChange(name=name, old=old_val, new=new_val))
    return out, changes


def _find_aura_block(text: str, aura_suffix: str) -> tuple[int, int] | None:
    """Find the byte range of the table-constructor that defines the aura
    with the given id-suffix. Tries several Lua patterns:
        id = PREFIX .. "<suffix>"
        id = <LOCAL_VAR>          (for PB_GROUP, BUFF_GROUP)
        id = PREFIX .. "_Buff_" .. id      (parameterized; matched by call site)

    Returns (start, end) where end is the char position of the matching ``}``.
    """
    candidates: list[str] = [f'id = PREFIX .. "{aura_suffix}"']
    if aura_suffix == "_PixelBridge":
        candidates.append("id = PB_GROUP,")
    elif aura_suffix == "_Buffs":
        candidates.append("id = BUFF_GROUP,")
    pos = -1
    for needle in candidates:
        pos = text.find(needle)
        if pos != -1:
            break
    if pos == -1:
        return None
    # Walk back to the most recent unmatched `{` (start of the merge() table arg).
    depth = 0
    start = -1
    i = pos
    while i >= 0:
        ch = text[i]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                start = i
                break
            depth -= 1
        i -= 1
    if start == -1:
        return None
    # Now walk forward from start to the matching `}`.
    end = _match_brace(text, start)
    if end == -1:
        return None
    return start, end


def _match_brace(text: str, start: int) -> int:
    """Given ``text[start] == '{'``, return the index of the matching ``}``.
    Skips Lua long-string and short-string and line-comment tokens so braces
    inside string literals don't confuse the counter.
    """
    assert text[start] == "{"
    i = start + 1
    depth = 1
    n = len(text)
    while i < n:
        ch = text[i]
        # Long string [[ ... ]] or [=[ ... ]=] (any number of '=' between [ and [)
        if ch == "[":
            j = i + 1
            eqs = 0
            while j < n and text[j] == "=":
                eqs += 1
                j += 1
            if j < n and text[j] == "[":
                close = "]" + "=" * eqs + "]"
                k = text.find(close, j + 1)
                if k == -1:
                    return -1
                i = k + len(close)
                continue
        # Short string "..." or '...'
        if ch in ('"', "'"):
            quote = ch
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == quote:
                    break
                if text[j] == "\n":
                    break  # malformed; bail out, don't hang
                j += 1
            i = j + 1
            continue
        # Line comment --... (but not long-comment --[[ ... ]] which would have
        # been handled by long-string branch starting at the next char; for
        # line comments we just skip to EOL).
        if ch == "-" and i + 1 < n and text[i + 1] == "-":
            # Long comment --[[ ... ]]?
            if i + 3 < n and text[i + 2] == "[":
                j = i + 3
                eqs = 0
                while j < n and text[j] == "=":
                    eqs += 1
                    j += 1
                if j < n and text[j] == "[":
                    close = "]" + "=" * eqs + "]"
                    k = text.find(close, j + 1)
                    if k == -1:
                        return -1
                    i = k + len(close)
                    continue
            # Short line comment.
            nl = text.find("\n", i)
            i = nl + 1 if nl != -1 else n
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


# Match assignment lines inside a table constructor:
#   key = <expr>,
# where expr is everything up to the trailing comma (or newline). We only
# patch a known whitelist of keys, so we don't over-match.
_PATCH_KEYS = ("xOffset", "yOffset", "width", "height")


def _patch_aura_block(
    block: str,
    desired: dict[str, str],
) -> tuple[str, dict[str, tuple[str, str]]]:
    """Patch the given table-constructor text. Returns (new_text, changes)."""
    out = block
    changed: dict[str, tuple[str, str]] = {}
    for key, new_expr in desired.items():
        # Anchored: indent + key + = + value + , (allow trailing spaces / comment).
        rx = re.compile(
            rf"(?P<lead>(^|\n)(?P<indent>[ \t]*){re.escape(key)}\s*=\s*)"
            rf"(?P<val>[^,\n]+?)(?P<tail>\s*,)",
        )
        m = rx.search(out)
        if not m:
            continue
        old_expr = m.group("val").strip()
        if old_expr == new_expr:
            continue
        new_assign = f"{m.group('lead')}{new_expr}{m.group('tail')}"
        out = out[: m.start()] + new_assign + out[m.end() :]
        changed[key] = (old_expr, new_expr)
    return out, changed


_BUFF_CALL_RE_FMT = (
    r'(buffIcon\s*\(\s*"{tag}"\s*,\s*"[^"]+"\s*,\s*)'
    r'(-?\d+)'
    r'(\s*,)'
)


def patch_buff_call(
    text: str, tag: str, new_x: int
) -> tuple[str, tuple[str, str] | None]:
    """Patch the third positional arg (x) of buffIcon("<tag>", uid, x, ...).
    Returns (new_text, (old_x_str, new_x_str) | None).
    """
    rx = re.compile(_BUFF_CALL_RE_FMT.format(tag=re.escape(tag)))
    m = rx.search(text)
    if not m:
        return text, None
    old = m.group(2)
    if int(old) == new_x:
        return text, None
    new_text = text[: m.start()] + m.group(1) + str(new_x) + m.group(3) + text[m.end() :]
    return new_text, (old, str(new_x))


def patch_lua(
    lua_text: str,
    elements: list[dict],
    by_id: dict[str, dict],
    origin: Anchor,
    desired_constants: dict[str, int],
    verbose: bool = False,
) -> PatchResult:
    text = lua_text

    # 1. Top-level constants.
    text, const_changes = patch_constants(text, desired_constants)

    # 2. Per-aura blocks. Use the *new* constants for template-resolution so
    # named-constant expressions evaluate against the planner's intent.
    constants_for_eval: dict[str, int] = {}
    # Seed with values from desired (planner-derived); fall back to current Lua
    # text for any constant we didn't patch.
    for name in TOP_LEVEL_CONSTANTS:
        if name in desired_constants:
            constants_for_eval[name] = desired_constants[name]
            continue
        m = _const_re(name).search(text)
        if m:
            constants_for_eval[name] = int(m.group("val"))

    aura_changes: list[AuraChange] = []
    missing: list[str] = []

    for el in elements:
        # script.js skips name-less elements in renderExports; mirror that here
        # EXCEPT when the element has an explicit map entry (covers NEW_MC_*
        # planner ids that don't carry display names).
        if not el.get("name") and el.get("id") not in PLANNER_TO_LUA_ID:
            continue
        if el.get("type") == "text":
            continue
        suf = lua_id_suffix(el)
        if suf is None:
            continue

        x, y = compute_wa_offset(el, by_id, origin)
        x_expr = preferred_x_expr(el.get("lua_template"), x, constants_for_eval)

        # Buff_* icons are built via buffIcon(tag, uid, x, ...). Patch the
        # call site instead of looking for a table block.
        if suf.startswith("_Buff_") and suf != "_Buffs":
            tag = suf[len("_Buff_") :]
            text, change = patch_buff_call(text, tag, x)
            if change:
                aura_changes.append(
                    AuraChange(aura_id=suf, fields={"xOffset": change})
                )
            continue

        desired_fields: dict[str, str] = {
            "xOffset": x_expr,
            "yOffset": str(y),
        }
        # Bars and pixels carry width/height too.
        if el.get("type") in {"bar", "pixel", "icon"}:
            desired_fields["width"] = _width_expr(el, constants_for_eval)
            desired_fields["height"] = _height_expr(el, constants_for_eval)

        block_range = _find_aura_block(text, suf)
        if block_range is None:
            # Auras built inside loops (Dots, BeaconStrip) won't have a literal
            # `id = PREFIX .. "_DotN"` anywhere. Those are handled by patching
            # the call-site (BAR_X + N*10) and shared y/dimensions via the
            # constants and the prototype block. They're not "missing", just
            # not directly patchable — record as informational.
            if suf.startswith("_Dot") and suf not in {"_Dot21"}:
                # Dots are looped via create_dot calls; their y/x come from
                # DOT_Y_* constants and BAR_X + N*10. The constants block above
                # already handles y. X positions are formulaic, no per-call
                # patching needed unless spacing changed (out of scope).
                continue
            if suf.startswith("_BeaconStrip"):
                # BeaconStrips loop over an array with computed y; constants
                # handle x via STRIP_X. No per-aura patch needed.
                continue
            missing.append(suf)
            continue

        start, end = block_range
        block = text[start : end + 1]
        new_block, fld_changes = _patch_aura_block(block, desired_fields)
        if fld_changes:
            text = text[:start] + new_block + text[end + 1 :]
            aura_changes.append(AuraChange(aura_id=suf, fields=fld_changes))
        if verbose:
            sys.stderr.write(f"[wa_addon] {suf}: {fld_changes or 'no change'}\n")

    return PatchResult(
        new_text=text,
        constant_changes=const_changes,
        aura_changes=aura_changes,
        missing_auras=missing,
    )


def _width_expr(el: dict, constants: dict[str, int]) -> str:
    """Width is usually a literal int. For HP/Mana bars the addon uses BAR_W;
    for NextCast/POM it uses ICON_SIZE. Prefer the named constant when the
    numeric value matches.
    """
    w = int(round(float(el.get("w", 0))))
    bar_w = constants.get("BAR_W")
    icon_size = constants.get("ICON_SIZE")
    if el.get("type") == "bar" and bar_w is not None and w == bar_w:
        return "BAR_W"
    if el.get("type") == "icon" and icon_size is not None and w == icon_size:
        return "ICON_SIZE"
    return str(w)


def _height_expr(el: dict, constants: dict[str, int]) -> str:
    """Height: for NextCast/POM (ICON_SIZE icons), prefer ICON_SIZE."""
    h = int(round(float(el.get("h", 0))))
    icon_size = constants.get("ICON_SIZE")
    # Only square icons (NextCast, POM) use ICON_SIZE for height.
    if (
        el.get("type") == "icon"
        and icon_size is not None
        and h == icon_size
        and el.get("w") == el.get("h")
    ):
        return "ICON_SIZE"
    return str(h)


# ---------------------------------------------------------------------------
# Constant derivation from planner JSON
# ---------------------------------------------------------------------------


def derive_constants(
    elements: list[dict],
    by_id: dict[str, dict],
    origin: Anchor,
    export_config: dict | None,
) -> dict[str, int]:
    """Compute Lua top-level constants from the planner JSON.

    BAR_X     = exportConfig.barX
    BAR_W     = Bar_HP width
    STRIP_X   = BeaconStrip0 xOffset
    ICON_X    = NextCast xOffset (named-constant ICON_X has same semantics)
    ICON_SIZE = NextCast width
    DOT_Y_TARGET = computed yOffset of any "target row" dot (e.g. Dot2)
    DOT_Y_PLAYER = computed yOffset of any "player row" dot (e.g. Dot0)
    """
    out: dict[str, int] = {}
    if export_config and "barX" in export_config:
        out["BAR_X"] = int(export_config["barX"])

    bar_hp = by_id.get("Bar_HP")
    if bar_hp is not None:
        out["BAR_W"] = int(round(float(bar_hp.get("w", 0))))

    bs0 = by_id.get("BeaconStrip0")
    if bs0 is not None:
        sx, _ = compute_wa_offset(bs0, by_id, origin)
        out["STRIP_X"] = sx

    nextcast = by_id.get("NextCast")
    if nextcast is not None:
        ix, _ = compute_wa_offset(nextcast, by_id, origin)
        out["ICON_X"] = ix
        out["ICON_SIZE"] = int(round(float(nextcast.get("w", 0))))

    # Dot rows: Dot0 (in_combat) is on the player row, Dot2 (vt_on_target) is
    # on the target row in the post-2026-04-25 layout.
    dot0 = by_id.get("Dot0")
    if dot0 is not None:
        _, py = compute_wa_offset(dot0, by_id, origin)
        out["DOT_Y_PLAYER"] = py
    dot2 = by_id.get("Dot2")
    if dot2 is not None:
        _, ty = compute_wa_offset(dot2, by_id, origin)
        out["DOT_Y_TARGET"] = ty

    return out


# ---------------------------------------------------------------------------
# Audit: detect Lua-side auras with no planner element (and vice versa).
# ---------------------------------------------------------------------------

# Capture only the literal-string ids; require trailing comma so we don't grab
# the parameterized prefix ("_Buff_" .. id) or the _Dot..index forms.
_LUA_AURA_ID_RE = re.compile(r'id\s*=\s*PREFIX\s*\.\.\s*"(_[A-Za-z0-9_]+)"\s*,')


def lua_aura_ids(text: str) -> set[str]:
    ids = set(_LUA_AURA_ID_RE.findall(text))
    # PB_GROUP / BUFF_GROUP are assigned via local var, not literal string.
    if re.search(r"^\s*id\s*=\s*PB_GROUP\s*,", text, re.MULTILINE):
        ids.add("_PixelBridge")
    if re.search(r"^\s*id\s*=\s*BUFF_GROUP\s*,", text, re.MULTILINE):
        ids.add("_Buffs")
    return ids


def planner_aura_ids(elements: list[dict]) -> set[str]:
    out: set[str] = set()
    for el in elements:
        suf = lua_id_suffix(el)
        if suf:
            out.add(suf)
    return out


def expand_loop_ids() -> set[str]:
    """Auras built in loops or via parameterized helpers have no plain literal
    id-line. Add their canonical names so audit doesn't false-flag them.
    """
    out: set[str] = set()
    for i in range(6):
        out.add(f"_BeaconStrip{i}")
    for i in range(0, 23):
        if i == 11:
            continue  # Dot11 was removed.
        out.add(f"_Dot{i}")
    # Dot23/24/25 (new boolean dots) live in create_all_dots too.
    for i in (23, 24, 25):
        out.add(f"_Dot{i}")
    # Buffs are built via buffIcon helper using `_Buff_" .. id`.
    for tag in ("SF", "Fort", "IF", "Flask", "Oil", "Food"):
        out.add(f"_Buff_{tag}")
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    p.add_argument("--dry-run", action="store_true", help="Print diff, don't write.")
    p.add_argument("--json", type=Path, default=DEFAULT_JSON, help="Layout-planner JSON path.")
    p.add_argument(
        "--addon",
        type=Path,
        default=DEFAULT_ADDON,
        help=(
            "Path to the consumer's Lua addon file to patch. This path is "
            "consumer-specific (the addon lives outside this repo); required."
        ),
    )
    p.add_argument("--verbose", action="store_true", help="Per-aura logging on stderr.")
    args = p.parse_args(argv)

    json_path: Path = args.json
    addon_path: Path | None = args.addon

    if addon_path is None:
        sys.stderr.write(
            "error: --addon PATH is required (path to the consumer's Lua addon file).\n"
        )
        return 2
    if not json_path.is_file():
        sys.stderr.write(f"error: layout JSON not found: {json_path}\n")
        return 2
    if not addon_path.is_file():
        sys.stderr.write(f"error: addon Lua not found: {addon_path}\n")
        return 2

    layout = json.loads(json_path.read_text(encoding="utf-8"))
    elements: list[dict] = layout.get("elements", [])
    by_id = {el["id"]: el for el in elements}
    canvas = layout.get("canvas", {})
    origin_off = canvas.get("originOffset") or {"x": 0, "y": 0}
    origin = Anchor(float(origin_off.get("x", 0)), float(origin_off.get("y", 0)))
    export_config = layout.get("exportConfig")

    desired_constants = derive_constants(elements, by_id, origin, export_config)

    lua_text = addon_path.read_text(encoding="utf-8")

    result = patch_lua(
        lua_text,
        elements,
        by_id,
        origin,
        desired_constants,
        verbose=args.verbose,
    )

    # Audit aura coverage.
    lua_ids = lua_aura_ids(lua_text) | expand_loop_ids()
    planner_ids = planner_aura_ids(elements)
    lua_only = sorted(lua_ids - planner_ids)
    planner_only = sorted(planner_ids - lua_ids)

    print_summary(result, lua_only, planner_only, json_path, addon_path)

    if not args.dry_run and result.new_text != lua_text:
        addon_path.write_text(result.new_text, encoding="utf-8", newline="\n")
        print(f"\nWrote {addon_path}")
    elif args.dry_run:
        print("\n(dry-run; no files written)")
    else:
        print("\nNo changes needed.")

    return 0


def print_summary(
    result: PatchResult,
    lua_only: list[str],
    planner_only: list[str],
    json_path: Path,
    addon_path: Path,
) -> None:
    print(f"layout-planner JSON: {json_path}")
    print(f"WA addon Lua:        {addon_path}")
    print()
    print("Constant changes:")
    if result.constant_changes:
        for c in result.constant_changes:
            print(f"  {c.name}: {c.old} -> {c.new}")
    else:
        print("  (none)")
    print()
    print("Aura position changes:")
    if result.aura_changes:
        for a in result.aura_changes:
            parts = ", ".join(f"{k}: {old} -> {new}" for k, (old, new) in a.fields.items())
            print(f"  {a.aura_id}: {parts}")
    else:
        print("  (none)")
    if result.missing_auras:
        print()
        print("Planner elements with NO matching aura block in Lua (need handwork):")
        for n in result.missing_auras:
            print(f"  {n}")
    if lua_only:
        print()
        print("Auras in Lua with no planner element (potential dead code or planner gap):")
        for n in lua_only:
            print(f"  {n}")
    if planner_only:
        print()
        print("Planner elements with no Lua aura (planner-only / port pending):")
        for n in planner_only:
            print(f"  {n}")


if __name__ == "__main__":
    raise SystemExit(main())
