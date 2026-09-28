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
function makeHass(tempState = "73.94", humState = "40.4", agoSec = 0) {
  const stamp = new Date(Date.now() - agoSec * 1000).toISOString();
  return {
    language: "en",
    states: {
      [TEMP]: {
        state: tempState,
        attributes: { unit_of_measurement: "\u00b0F" },
        last_updated: stamp,
        last_changed: stamp,
      },
      [HUM]: {
        state: humState,
        attributes: { unit_of_measurement: "%" },
        last_updated: stamp,
        last_changed: stamp,
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

console.log("\n=== 8. banded temperature colours ===");
{
  const parseRgb = (s) => {
    const m = String(s).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const colorAt = (t, extra) => {
    const el = build(Object.assign({}, BASE, extra || {}), makeHass(String(t)));
    return {
      fill: el._fillEl.getAttribute("fill"),
      bulb: el._bulbEl.getAttribute("fill"),
    };
  };
  const GREEN = "rgb(67,160,71)";

  // Comfort band 65..76 F is flat green at both edges and in the middle.
  check("comfort low edge (65F) green", colorAt(65).fill, GREEN);
  check("comfort middle (70F) green", colorAt(70).fill, GREEN);
  check("comfort high edge (76F) green", colorAt(76).fill, GREEN);

  // The bulb must track the column instead of being permanently red.
  check("bulb matches column in comfort", colorAt(70).bulb, GREEN);
  checkTrue("bulb is no longer hardcoded red",
    colorAt(70).bulb !== "var(--error-color)", colorAt(70).bulb);

  // Hot: above comfort it must get redder monotonically.
  const hot90 = parseRgb(colorAt(90).fill);
  checkTrue(`hot (90F) is warm, not green (${colorAt(90).fill})`,
    hot90[0] > hot90[2] && hot90[0] > 200, colorAt(90).fill);
  check("scale max (110F) is red", colorAt(110).fill, "rgb(211,47,47)");
  // "Redder" means greenness (G-R) falls; the raw red channel dips slightly
  // from gold to red, so comparing R alone would be misleading.
  const greenness = [76, 80, 90, 100, 110].map((t) => {
    const c = parseRgb(colorAt(t).fill);
    return c[1] - c[0];
  });
  checkTrue(`greenness falls as it heats (${greenness.join(" > ")})`,
    greenness.every((g, i) => i === 0 || g < greenness[i - 1]),
    greenness.join(","));
  const top = parseRgb(colorAt(110).fill);
  checkTrue("hot end is red-dominant", top[0] > top[1] + 100 && top[0] > top[2] + 100,
    colorAt(110).fill);

  // Cold: between freeze (35F) and comfort_min it must be blue-dominant.
  const cold50 = parseRgb(colorAt(50).fill);
  checkTrue(`cold (50F) is blue-dominant (${colorAt(50).fill})`,
    cold50[2] > cold50[0], colorAt(50).fill);

  // Snow: below 35F it must be near-white and brighter the colder it gets.
  const snow30 = parseRgb(colorAt(30).fill);
  const snow0 = parseRgb(colorAt(0).fill);
  checkTrue(`snow (30F) is pale (${colorAt(30).fill})`,
    snow30[0] > 180 && snow30[1] > 210 && snow30[2] > 240, colorAt(30).fill);
  check("coldest (0F) is snow white", colorAt(0).fill, "rgb(255,255,255)");
  checkTrue("colder means whiter", snow0[0] > snow30[0],
    `${colorAt(30).fill} -> ${colorAt(0).fill}`);

  // Freezing is a distinct state, so the snow and cold bands are meant to be
  // visibly different either side of the threshold rather than blended.
  const atFreeze = parseRgb(colorAt(35).fill);
  const belowFreeze = parseRgb(colorAt(34).fill);
  checkTrue(`at freeze (35F) is deep blue (${colorAt(35).fill})`,
    atFreeze[2] > 150 && atFreeze[0] < 80, colorAt(35).fill);
  checkTrue(`just below freeze (34F) is snowy (${colorAt(34).fill})`,
    belowFreeze[0] > 180, colorAt(34).fill);

  // Thresholds are configurable.
  check("custom comfort band applies",
    colorAt(60, { comfort_min: 55, comfort_max: 62 }).fill, GREEN);
  const customFreeze = parseRgb(colorAt(45, { freeze_below: 50 }).fill);
  checkTrue(`custom freeze threshold applies (45F snowy when freeze=50)`,
    customFreeze[0] > 180 && customFreeze[2] > 240, customFreeze.join(","));
  const defaultAt45 = parseRgb(colorAt(45).fill);
  checkTrue("same 45F is blue, not snow, with the default freeze of 35",
    defaultAt45[2] > defaultAt45[0] && defaultAt45[0] < 180,
    defaultAt45.join(","));

  // REGRESSION: the first cut blended the cold ramp into green at
  // comfort_min, so a real 24 h span of 61.2-72.1 degF rendered green or
  // green-teal throughout and the card never appeared to change colour.
  const realRange = [61.2, 63, 64.9, 65.1, 68, 72.1];
  const seen = realRange.map((t) => colorAt(t).fill);
  console.log("        observed 24h range ->",
    realRange.map((t, i) => `${t}:${seen[i]}`).join("  "));
  const belowBand = realRange
    .map((t, i) => ({ t, c: parseRgb(seen[i]) }))
    .filter((x) => x.t < 65);
  checkTrue("every reading just below the band is blue-dominant",
    belowBand.every((x) => x.c[2] > x.c[0] && x.c[2] > x.c[1]),
    belowBand.map((x) => `${x.t}=${x.c}`).join(" "));
  checkTrue("cold and comfortable are clearly different colours",
    seen[2] !== seen[3], `${seen[2]} vs ${seen[3]}`);
  checkTrue("the real 24h range spans more than one colour",
    new Set(seen).size >= 3, `only ${new Set(seen).size} distinct`);

  // Other colour modes still work.
  check("static mode honours theme_colors.fill",
    colorAt(70, { color_mode: "static", theme_colors: { fill: "#abcdef" } }).fill,
    "#abcdef");
  checkTrue("spectrum mode still available",
    colorAt(70, { color_mode: "spectrum" }).fill !== GREEN,
    "spectrum returned the band green");

  // Unknown temperature must not be shown as a confident green/red.
  const un = build(BASE, makeHass("unavailable"));
  check("unavailable temp is greyed",
    un._fillEl.getAttribute("fill"), "var(--disabled-text-color,#9e9e9e)");
  check("unavailable bulb is greyed",
    un._bulbEl.getAttribute("fill"), "var(--disabled-text-color,#9e9e9e)");
}

console.log("\n=== 9. live updates on an existing card ===");
{
  // Every earlier group built a fresh card, so none of them would notice a
  // card that renders once and then ignores later hass updates.
  const el = build(BASE, makeHass("71.8", "44"));
  const read = () => ({
    value: el.querySelector(".value").textContent,
    secondary: el.querySelector(".secondary").textContent,
    humidity: el.querySelector(".humidity span").textContent,
    fill: el._fillEl.getAttribute("fill"),
    bulb: el._bulbEl.getAttribute("fill"),
    height: Number(el._fillEl.getAttribute("height")),
  });

  const first = read();
  check("initial readout", first.value, "71.8 \u00b0F");
  check("initial colour is comfort green", first.fill, "rgb(67,160,71)");

  // Same element, new hass object -- exactly what HA does on a state change.
  el.hass = makeHass("95.0", "20");
  const hot = read();
  check("readout follows the new state", hot.value, "95.0 \u00b0F");
  check("secondary follows the new state", hot.secondary, "35.0 \u00b0C");
  check("humidity follows the new state", hot.humidity, "20 %");
  checkTrue(`colour left the comfort band (${hot.fill})`,
    hot.fill !== first.fill, `still ${hot.fill}`);
  check("bulb followed too", hot.bulb, hot.fill);
  checkTrue(`bar grew (${first.height.toFixed(1)} -> ${hot.height.toFixed(1)})`,
    hot.height > first.height, `${first.height} -> ${hot.height}`);

  el.hass = makeHass("20.0", "90");
  const snow = read();
  check("readout follows a freezing state", snow.value, "20.0 \u00b0F");
  checkTrue(`colour went snowy (${snow.fill})`,
    snow.fill !== hot.fill && snow.fill !== first.fill, snow.fill);
  checkTrue(`bar shrank (${hot.height.toFixed(1)} -> ${snow.height.toFixed(1)})`,
    snow.height < hot.height, `${hot.height} -> ${snow.height}`);

  // Going back to a previously seen value must still track.
  el.hass = makeHass("71.8", "44");
  check("returns to green when comfortable", read().fill, "rgb(67,160,71)");
  check("readout returns too", read().value, "71.8 \u00b0F");

  // A card must not silently stop updating after many ticks.
  for (let i = 0; i < 25; i++) el.hass = makeHass(String(60 + i), "50");
  check("still updating after 25 ticks", read().value, "84.0 \u00b0F");
}

console.log("\n=== 10. freshness indicator ===");
{
  const ageOf = (sec, extra) => {
    const el = build(Object.assign({}, BASE, extra || {}),
      makeHass("70.0", "50", sec));
    const a = el.querySelector(".age");
    return { text: a.textContent, shown: a.style.display !== "none",
             stale: a.classList.contains("stale") };
  };

  check("fresh reading", ageOf(10).text, "just now");
  check("minutes", ageOf(20 * 60).text, "20 min ago");
  check("hours and minutes", ageOf(2 * 3600 + 10 * 60).text, "2 h 10 min ago");
  check("whole hours", ageOf(3 * 3600).text, "3 h ago");
  check("days", ageOf(49 * 3600).text, "2 d 1 h ago");

  checkTrue("a recent reading is not flagged stale", !ageOf(10 * 60).stale,
    "flagged stale");
  checkTrue("an old reading is flagged stale", ageOf(4 * 3600).stale,
    "not flagged");
  checkTrue("stale_after is configurable",
    ageOf(10 * 60, { stale_after: 60 }).stale, "not flagged with stale_after=60");
  checkTrue("stale_after 0 disables the warning",
    !ageOf(99 * 3600, { stale_after: 0 }).stale, "flagged with stale_after=0");

  checkTrue("age line can be hidden", !ageOf(10, { show_age: false }).shown,
    "still shown");

  // The age must keep counting up between sensor reports, which is what makes
  // the card visibly alive when the sensor only reports every ~20 minutes.
  const el = build(BASE, makeHass("70.0", "50", 60));
  const before = el.querySelector(".age").textContent;
  el.hass = makeHass("70.0", "50", 45 * 60);
  const after = el.querySelector(".age").textContent;
  checkTrue(`age tracks the newest report (${before} -> ${after})`,
    before !== after, `${before} == ${after}`);
  checkTrue("card exposes a hass getter",
    el.hass && el.hass.states !== undefined, "hass getter missing");
  checkTrue("a ticker is installed while connected", !!el._timer,
    "no timer");
  el.remove();
  checkTrue("ticker is cleared on disconnect", !el._timer, "timer leaked");
}

console.log(`\n==== ${pass}/${pass + fail} checks passed ====`);
process.exit(fail === 0 ? 0 : 1);
