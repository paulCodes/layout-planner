// Round-trip exporter test for wa-pixel-bridge.json.
// Run: node test_export.js
//
// Loads the layout, runs the same anchor math as script.js's renderExports,
// and asserts each element exports to its source-of-truth WA xOffset/yOffset
// (extracted from the WeakAura installer).

const fs = require("fs");
const path = require("path");

const layoutPath = path.join(__dirname, "layouts", "wa-pixel-bridge.json");
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
const elements = layout.elements;
const originOffset = layout.canvas.originOffset || { x: 0, y: 0 };
const findEl = (id) => elements.find((e) => e.id === id);

function anchorPointOf(el) { return el.anchorPoint || "TOPLEFT"; }
function computeAnchor(el) {
  if (el.type === "group" && el.anchor && el.anchor.x !== undefined && el.anchor.y !== undefined) {
    return { x: el.anchor.x, y: el.anchor.y };
  }
  if (anchorPointOf(el) === "CENTER") return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  return { x: el.x, y: el.y };
}
function computeParentAnchor(el) {
  if (!el.parent) return { x: originOffset.x, y: originOffset.y };
  const parent = findEl(el.parent);
  if (!parent) return { x: originOffset.x, y: originOffset.y };
  return computeAnchor(parent);
}
function computeWaOffset(el) {
  const a = computeAnchor(el);
  const pa = computeParentAnchor(el);
  return { xOffset: a.x - pa.x, yOffset: -(a.y - pa.y) };
}

const BAR_X = -55;
const STRIP_X = -66;
const ICON_X = -122;

// Source-of-truth values extracted from ShadowPriestTrackerInstaller.lua
const expected = {
  PREFIX_GROUP:   [0, 0],

  Icon_VT:  [-39, -8],
  Icon_SWP: [3, -8],
  Icon_MB:  [45, -8],
  Icon_SWD: [87, -8],
  Icon_MF:  [129, -8],

  NextCast: [ICON_X, -54],
  // POM overlaps NextCast in real WA (toggles via shadowform load condition);
  // they share the same xOffset/yOffset.
  POM:      [ICON_X, -54],

  PB_GROUP: [0, 0],

  Bar_HP:       [BAR_X, -54],
  Bar_Mana:     [BAR_X, -90],
  Bar_ManaTick: [BAR_X, -90],

  BeaconStrip0: [STRIP_X, -54],
  BeaconStrip1: [STRIP_X, -63],
  BeaconStrip2: [STRIP_X, -72],
  BeaconStrip3: [STRIP_X, -81],
  BeaconStrip4: [STRIP_X, -90],
  BeaconStrip5: [STRIP_X, -99],

  MC0: [BAR_X + 230, -79],
  MC1: [BAR_X + 240, -79],
  MC3: [BAR_X + 230, -89],
  MC4: [BAR_X + 240, -89],

  BUFF_GROUP: [4, -129],

  Buff_SF:    [-35, 0],
  Buff_Fort:  [0, 0],
  Buff_IF:    [35, 0],
  Buff_Flask: [85, 0],
  Buff_Oil:   [120, 0],
  Buff_Food:  [155, 0],
};

// Add Dot0..Dot22
for (let i = 0; i <= 22; i++) {
  expected[`Dot${i}`] = [BAR_X + i * 10, -79];
}

let passed = 0;
let failed = 0;
const fails = [];

for (const el of elements) {
  if (!(el.id in expected)) continue;
  const { xOffset, yOffset } = computeWaOffset(el);
  const [eX, eY] = expected[el.id];
  if (xOffset === eX && yOffset === eY) {
    passed++;
  } else {
    failed++;
    fails.push(`  ${el.id}: got (${xOffset}, ${yOffset}), expected (${eX}, ${eY})`);
  }
}

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (fails.length) {
  console.log("Mismatches:");
  for (const f of fails) console.log(f);
  process.exit(1);
}
process.exit(0);
