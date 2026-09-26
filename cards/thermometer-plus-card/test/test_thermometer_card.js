/**
 * Headless test for thermometer-plus-card.js.
 *
 * Loads the real card file into a jsdom document, registers it as a custom
 * element, feeds it a fake `hass` plus recorded statistics, and asserts on the
 * rendered DOM. Covers the three requested features plus the scale fix.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const CARD_FILE = process.argv[2];
const src = fs.readFileSync(CARD_FILE, "utf8");

const dom = new JSDOM("<!DOCTYPE html><body></body>", {
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

// `ha-card`, `ha-icon` and `ha-form` are Home Assistant elements; plain
// unknown elements behave well enough for structural assertions.
window.eval(src);

const CARD = "thermometer-plus-card";
const Ctor = window.customElements.get(CARD);
if (!Ctor) {
  console.error("FAIL: custom element not registered");
  process.exit(1);
}

let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = String(got) === String(want);
  if (ok) pass++;
  else fail++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}: got=${JSON.stringify(got)}` +
    (ok ? "" : ` want=${JSON.stringify(want)}`));
}

function checkTrue(label, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}` +
    (cond ? "" : ` -- ${detail}`));
}

const TEMP = "sensor.thermostat_sensor_patio_temperature";
const HUM = "sensor.thermostat_sensor_patio_humidity";

// Real values pulled from the live install.
function makeHass(tempState = "73.94", humState = "40.4") {
  return {
    language: "en",
    states: {
      [TEMP]: {
        state: tempState,
        attributes: { unit_of_measurement: "\u00b0F" },
      },
      [HUM]: {
        state: humState,
        attributes: { unit_of_measurement: "%" },
      },
    },
    callWS: async () => {
      throw new Error("no statistics in test");
    },
    callApi: async () => [[]],
  };
}

function build(config, hass) {
  const el = new Ctor();
  window.document.body.appendChild(el);
  el.setConfig(config);
  el.hass = hass || makeHass();
  return el;
}

const BASE = {
  entity: TEMP,
  humidity_entity: HUM,
  title: "Outdoor",
  unit: "F",
  secondary_unit: "C",
  windows: [6, 12, 24],
  scale_min: 0,
  scale_max: 110,
  optimum: 72,
  stats_interval: 60,
};

console.log("=== 1. requested features ===");
{
  const el = build(BASE);
  const q = (s) => el.querySelector(s);

  check("primary temperature readout", q(".value").textContent, "73.9 \u00b0F");

  // 73.94F -> 23.3C
  check("secondary unit line (C)", q(".secondary").textContent, "23.3 \u00b0C");
  checkTrue("secondary line visible", q(".secondary").style.display !== "none",
    "display=" + q(".secondary").style.display);

  const valueRem = parseFloat(q(".value").style.fontSize);
  const secRem = parseFloat(q(".secondary").style.fontSize);
  checkTrue(`secondary font smaller than primary (${secRem} < ${valueRem})`,
    secRem < valueRem, `${secRem} !< ${valueRem}`);

  check("humidity readout", q(".humidity span").textContent, "40 %");
  checkTrue("humidity visible", q(".humidity").style.display !== "none",
    "hidden");

  check("card header", el.querySelector("ha-card").getAttribute("header"),
    "Outdoor");
}

console.log("\n=== 2. rolling windows replace daily/monthly/yearly ===");
{
  const el = build(BASE);
  // Inject a synthetic series so window filtering is deterministic.
  const now = Date.now();
  const H = 3600000;
  el._series = {
    [TEMP]: [
      { t: now - 23 * H, min: 55.0, max: 60.0 }, // only in 24h
      { t: now - 11 * H, min: 62.0, max: 80.0 }, // in 12h + 24h
      { t: now - 2 * H, min: 70.0, max: 74.0 },  // in all three
    ],
    [HUM]: [
      { t: now - 23 * H, min: 20, max: 90 },
      { t: now - 11 * H, min: 30, max: 70 },
      { t: now - 2 * H, min: 40.4, max: 56.6 },
    ],
  };
  el._renderTable("\u00b0F", "%");

  const labels = [...el.querySelectorAll(".body .row .lbl")]
    .map((d) => d.textContent);
  check("window labels", JSON.stringify(labels),
    JSON.stringify(["6 h", "12 h", "24 h"]));

  const rows = [...el.querySelectorAll(".body .row")].map((r) =>
    [...r.children].map((c) => c.textContent));

  check("6h  temp max", rows[0][1], "74.0 \u00b0F");
  check("6h  temp min", rows[0][2], "70.0 \u00b0F");
  check("12h temp max", rows[1][1], "80.0 \u00b0F");
  check("12h temp min", rows[1][2], "62.0 \u00b0F");
  check("24h temp max", rows[2][1], "80.0 \u00b0F");
  check("24h temp min", rows[2][2], "55.0 \u00b0F");

  check("6h  hum max", rows[0][3], "57 %");
  check("6h  hum min", rows[0][4], "40 %");
  check("24h hum max", rows[2][3], "90 %");
  check("24h hum min", rows[2][4], "20 %");

  const grp = el.querySelector(".grp").textContent;
  checkTrue("group header names both metrics",
    grp.includes("Temp") && grp.includes("Humidity"), grp);
}

console.log("\n=== 3. thermometer scale (the -20..40 vs \u00b0F bug) ===");
{
  // Upstream default scale is -20..40, so 73.94 \u00b0F pegs the bar at 100%.
  const pegged = build(Object.assign({}, BASE, {
    scale_min: -20, scale_max: 40,
  }));
  const hPeg = Number(pegged.querySelector(".fill, rect[fill]")
    ? pegged._fillEl.getAttribute("height") : -1);
  check("old scale pegs bar at full height", hPeg, 140);

  const fixed = build(BASE); // 0..110
  const hFix = Number(fixed._fillEl.getAttribute("height"));
  const expected = 140 * ((73.94 - 0) / (110 - 0));
  checkTrue(`fixed scale is proportional (${hFix.toFixed(1)} ~ ` +
    `${expected.toFixed(1)})`, Math.abs(hFix - expected) < 0.51,
    `${hFix} vs ${expected}`);
  checkTrue("fixed bar is not pegged", hFix < 140, `${hFix}`);
}

console.log("\n=== 4. unit conversion correctness ===");
{
  const cases = [
    ["32", "0.0 \u00b0C"],
    ["212", "100.0 \u00b0C"],
    ["-40", "-40.0 \u00b0C"],
    ["98.6", "37.0 \u00b0C"],
  ];
  for (const [f, want] of cases) {
    const el = build(BASE, makeHass(f));
    check(`${f}\u00b0F -> C`, el.querySelector(".secondary").textContent, want);
  }

  // Same unit => no secondary line.
  const same = build(Object.assign({}, BASE, { secondary_unit: "F" }));
  check("secondary hidden when unit matches",
    same.querySelector(".secondary").style.display, "none");
}

console.log("\n=== 5. graceful degradation ===");
{
  const noHum = build(Object.assign({}, BASE, { humidity_entity: null }));
  check("humidity hidden when unconfigured",
    noHum.querySelector(".humidity").style.display, "none");
  noHum._series = { [TEMP]: [] };
  noHum._renderTable("\u00b0F", "");
  const cells = noHum.querySelectorAll(".body .row")[0].children.length;
  check("table drops humidity columns", cells, 3);
  check("group header hidden with one metric",
    noHum.querySelector(".grp").style.display, "none");

  const unavail = build(BASE, makeHass("unavailable", "unknown"));
  check("unavailable temp shows dash",
    unavail.querySelector(".value").textContent, "\u2014 \u00b0F");
  check("unknown humidity shows dash",
    unavail.querySelector(".humidity span").textContent, "\u2014 %");

  // Empty series -> dashes, not crashes.
  const empty = build(BASE);
  empty._series = { [TEMP]: [], [HUM]: [] };
  empty._renderTable("\u00b0F", "%");
  const r0 = [...empty.querySelectorAll(".body .row")[0].children]
    .map((c) => c.textContent);
  check("empty window renders dashes", JSON.stringify(r0.slice(1)),
    JSON.stringify(["\u2014", "\u2014", "\u2014", "\u2014"]));
}

console.log("\n=== 6. legacy config compatibility ===");
{
  // The old config used sections: [daily, monthly] - must not explode and must
  // fall back to the 6/12/24 defaults.
  const legacy = build({
    entity: TEMP,
    title: "Outdoor",
    sections: ["daily", "monthly"],
    unit: "F",
  });
  check("legacy sections fall back to defaults",
    JSON.stringify(legacy._config.windows), JSON.stringify([6, 12, 24]));

  // Numeric / suffixed window forms.
  const mixed = build(Object.assign({}, BASE, {
    windows: ["6h", 12, "1d", "30m"],
  }));
  check("window parsing", JSON.stringify(mixed._config.windows),
    JSON.stringify([6, 12, 24, 0.5]));
  mixed._series = { [TEMP]: [], [HUM]: [] };
  mixed._renderTable("\u00b0F", "%");
  const labels = [...mixed.querySelectorAll(".body .row .lbl")]
    .map((d) => d.textContent);
  check("mixed window labels", JSON.stringify(labels),
    JSON.stringify(["6 h", "12 h", "24 h", "30 min"]));
}

console.log("\n=== 7. multiple instances do not collide ===");
{
  const a = build(BASE);
  const b = build(BASE);
  const idA = a.querySelector("clipPath").getAttribute("id");
  const idB = b.querySelector("clipPath").getAttribute("id");
  checkTrue(`clip ids unique (${idA} != ${idB})`, idA !== idB, "ids collide");
}

console.log(`\n==== ${pass}/${pass + fail} checks passed ====`);
process.exit(fail === 0 ? 0 : 1);
