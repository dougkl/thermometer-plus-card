/**
 * Thermometer Plus Card
 * =====================
 * A fork of `temperature-thermometer-card` (v2.2.0) with the three features
 * that card cannot express through configuration:
 *
 *   1. Temperature AND humidity on one card (current value + min/max table).
 *   2. Arbitrary rolling time windows (6h / 12h / 24h) instead of the
 *      hardcoded daily / monthly / yearly buckets.
 *   3. A secondary temperature readout in a different unit (e.g. °C under
 *      °F) rendered in a smaller font.
 *
 * Plus banded colouring (color_mode "bands", the default): the column and the
 * bulb go snow-white below freezing, blue while cold, flat green through the
 * comfort band and amber/orange/red above it. Upstream painted the bulb red
 * permanently, which reads as "hot" even at freezing.
 *
 * Each band starts at its own distinct colour rather than easing into green at
 * the comfort edges. Blending looked smoother but made a real 24 h span of
 * 61-72 degF render as one shade of green, so the card never appeared to react
 * to temperature at all.
 *
 * A freshness line reports how long ago the sensor last updated, and the card
 * re-renders on a 30 s timer -- Home Assistant only pushes a new hass object
 * when an entity changes, and a sensor reporting every ~20 min otherwise makes
 * a healthy card look frozen.
 *
 * Lives in /config/www/ rather than /config/www/community/ so that a HACS
 * update of the upstream card cannot overwrite it.
 *
 * Data source
 * -----------
 * Primary: `recorder/statistics_during_period` with period="5minute", which
 * returns per-bucket min/max. The recorder computes those from every state in
 * the bucket, so bucket min/max is exactly as accurate as scanning raw history
 * -- verified against the history API on this install (24h min=72.14,
 * max=73.94 from both sources) -- but far cheaper and it survives the state
 * purge.
 *
 * Fallback: the raw `history/period` REST endpoint, used per entity whenever
 * statistics come back empty (e.g. a freshly added entity that has not been
 * rolled up yet).
 *
 * One fetch covers the largest configured window; the shorter windows are
 * derived by filtering that series client-side.
 */
(function () {
  "use strict";

  var CARD = "thermometer-plus-card";
  var VERSION = "1.2.0";

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpRgb(a, b, t) {
    return [
      Math.round(lerp(a[0], b[0], t)),
      Math.round(lerp(a[1], b[1], t)),
      Math.round(lerp(a[2], b[2], t)),
    ];
  }

  function rgb(c) {
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  /**
   * Interpolate across an array of RGB stops. t is normalised 0..1 across the
   * whole ramp, so the stops are evenly spaced.
   */
  function ramp(stops, t) {
    t = clamp01(t);
    var n = stops.length - 1;
    var x = t * n;
    var i = Math.min(n - 1, Math.floor(x));
    return rgb(lerpRgb(stops[i], stops[i + 1], x - i));
  }

  /* Colour anchors for the banded ("bands") colour mode.
   *
   * The ramps deliberately do NOT blend into green at the comfort edges.
   * Blending looked smooth but meant a 30-degree-wide cold zone rendered as
   * green-teal for most of its range: a real 24 h span of 61-72 degF showed no
   * visible colour change at all. Each band now starts at its own unmistakable
   * colour, so crossing a threshold is obvious. */
  var BAND_GREEN = [67, 160, 71];
  /* Below freezing: pale ice at the threshold, pure snow at the bottom. */
  var BAND_SNOW = [
    [255, 255, 255],
    [235, 248, 255],
    [214, 240, 253],
  ];
  /* Cold: deep blue at freezing, light blue just under the comfort band. */
  var BAND_COLD = [
    [21, 101, 192],
    [33, 150, 243],
    [129, 212, 250],
  ];
  /* Hot: amber just above the comfort band, through orange to red. */
  var BAND_HOT = [
    [255, 193, 7],
    [255, 112, 67],
    [211, 47, 47],
  ];

  /**
   * Normalise a unit string to a single letter: "°F" -> "F", "celsius" -> "C".
   */
  function unitKey(u) {
    if (!u) return "";
    var s = String(u).trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (s.indexOf("CELS") === 0 || s === "C") return "C";
    if (s.indexOf("FAHR") === 0 || s === "F") return "F";
    if (s.indexOf("KELV") === 0 || s === "K") return "K";
    return s.slice(-1);
  }

  /**
   * Pretty unit label for display: "C" -> "°C", "%" stays "%".
   */
  function unitLabel(u) {
    var k = unitKey(u);
    if (k === "C" || k === "F" || k === "K") return "°" + k;
    return String(u || "");
  }

  /**
   * Convert a temperature between C / F / K. Returns the input unchanged when
   * either unit is unknown or the units already match.
   */
  function convertTemp(value, from, to) {
    var f = unitKey(from);
    var t = unitKey(to);
    if (!f || !t || f === t) return value;
    if (["C", "F", "K"].indexOf(f) < 0 || ["C", "F", "K"].indexOf(t) < 0) {
      return value;
    }
    var c = f === "F" ? ((value - 32) * 5) / 9 : f === "K" ? value - 273.15 : value;
    return t === "F" ? (c * 9) / 5 + 32 : t === "K" ? c + 273.15 : c;
  }

  /**
   * Sensible thermometer scale defaults per unit. The upstream card always
   * defaulted to -20..40, which pegs the bar permanently at max for a °F
   * sensor.
   */
  function scaleDefaults(unit) {
    var k = unitKey(unit);
    if (k === "F") return { min: 0, max: 110, optimum: 72 };
    if (k === "K") return { min: 253, max: 313, optimum: 293 };
    return { min: -20, max: 40, optimum: 20 };
  }

  /**
   * Comfort-band defaults per unit, used by color_mode "bands":
   * green inside [comfort_min, comfort_max], warming to red above it, cooling
   * to blue below it, and turning to snow-white below freeze_below.
   */
  function bandDefaults(unit) {
    var k = unitKey(unit);
    if (k === "F") return { comfort_min: 65, comfort_max: 76, freeze_below: 35 };
    if (k === "K") {
      return { comfort_min: 291.5, comfort_max: 297.6, freeze_below: 274.8 };
    }
    return { comfort_min: 18.3, comfort_max: 24.4, freeze_below: 1.7 };
  }

  /**
   * Accept windows as 6, "6", "6h", "90m", "2d" -> hours as a number.
   */
  function parseWindow(w) {
    if (typeof w === "number" && isFinite(w)) return w;
    var s = String(w).trim().toLowerCase();
    var m = s.match(/^([0-9]*\.?[0-9]+)\s*([hmd]?)/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === "m") return n / 60;
    if (m[2] === "d") return n * 24;
    return n;
  }

  function windowLabel(hours) {
    if (hours >= 24 && hours % 24 === 0) {
      var d = hours / 24;
      return d === 1 ? "24 h" : d + " d";
    }
    if (hours < 1) return Math.round(hours * 60) + " min";
    return (Math.round(hours * 10) / 10) + " h";
  }

  /** "just now" / "5 min ago" / "2 h 10 min ago" / "3 d ago". */
  function ageLabel(seconds) {
    if (seconds < 90) return "just now";
    var mins = Math.round(seconds / 60);
    if (mins < 60) return mins + " min ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) {
      var rem = mins % 60;
      return rem ? hrs + " h " + rem + " min ago" : hrs + " h ago";
    }
    var days = Math.floor(hrs / 24);
    var remH = hrs % 24;
    return remH ? days + " d " + remH + " h ago" : days + " d ago";
  }

  function statBucketTime(b) {
    // HA has returned `start` as epoch ms (current) and as an ISO string
    // (older cores). Accept both.
    if (typeof b.start === "number") return b.start;
    var p = Date.parse(b.start);
    return isNaN(p) ? 0 : p;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */

  class ThermometerPlusCard extends HTMLElement {
    constructor() {
      super();
      this._config = null;
      this._hass = null;
      this._series = null;
      this._lastFetch = 0;
      this._fetching = false;
      this._timer = null;
    }

    static getConfigElement() {
      try {
        return document.createElement(CARD + "-editor");
      } catch (e) {
        return document.createElement("div");
      }
    }

    static getStubConfig(hass, entities) {
      var temp = (entities || []).find(function (e) {
        return e.indexOf("sensor.") === 0;
      });
      return {
        entity: temp || "sensor.example_temperature",
        title: "Temperature",
        windows: [6, 12, 24],
      };
    }

    setConfig(config) {
      if (!config || !config.entity) throw new Error("Required: entity");

      var defaults = {
        title: "Temperature",
        entity: null,
        humidity_entity: null,
        unit: undefined,
        secondary_unit: undefined,
        precision: 1,
        secondary_precision: 1,
        humidity_precision: 0,
        show_table: true,
        windows: [6, 12, 24],
        stats_interval: 300,
        theme_colors: {},
        font_sizes: {},
        value_position: "below",
        scale_min: undefined,
        scale_max: undefined,
        optimum: undefined,
        color_mode: "bands",
        comfort_min: undefined,
        comfort_max: undefined,
        freeze_below: undefined,
        show_age: true,
        stale_after: 3600,
        debug_banner: false,
      };

      var fontDefaults = {
        value_rem: 1.6,
        secondary_rem: 0.95,
        humidity_rem: 1.05,
        table_rem: 0.85,
      };

      var merged = Object.assign({}, defaults, config);

      // `sections` is accepted as an alias for `windows` so an existing
      // upstream config keeps working; the legacy daily/monthly/yearly values
      // have no meaning here and are ignored in favour of the defaults.
      if (!config.windows && Array.isArray(config.sections)) {
        var mapped = config.sections
          .map(parseWindow)
          .filter(function (h) {
            return h !== null;
          });
        if (mapped.length) merged.windows = mapped;
      }

      merged.windows = (merged.windows || [])
        .map(parseWindow)
        .filter(function (h) {
          return h !== null && h > 0;
        });
      if (!merged.windows.length) merged.windows = [6, 12, 24];

      merged.font_sizes = Object.assign(
        {},
        fontDefaults,
        config.font_sizes || {}
      );

      this._config = merged;
      this._series = null;
      this._lastFetch = 0;

      if (!this._card) this._build();
      this._applyStatic();
      if (this._hass) this._update();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._card) this._build();
      this._update();
    }

    /* A setter without a getter makes `element.hass` read back as undefined,
     * which breaks any caller that reads the property back (the config
     * preview does). */
    get hass() {
      return this._hass;
    }

    /* Home Assistant only pushes a new hass object when some entity changes.
     * This sensor reports roughly every 20 minutes, so without a ticker the
     * age line would sit at "5 min ago" indefinitely and the card would look
     * dead between reports. */
    connectedCallback() {
      if (this._timer) return;
      var self = this;
      this._timer = setInterval(function () {
        if (self._hass && self._config) self._update();
      }, 30000);
    }

    disconnectedCallback() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    getCardSize() {
      return 5;
    }

    /* ---------------------------------------------------------------- *
     * DOM
     * ---------------------------------------------------------------- */

    _build() {
      var card = document.createElement("ha-card");

      var style = document.createElement("style");
      style.textContent = [
        ".wrap{display:grid;gap:14px;align-items:center;padding:12px 16px 16px;}",
        ".wrap.below{grid-template-columns:auto 1fr;}",
        ".wrap.left{grid-template-columns:auto auto 1fr;}",
        ".thermo{display:flex;flex-direction:column;align-items:center;gap:6px;}",
        ".svg{width:56px;height:170px;}",
        ".readout{display:flex;flex-direction:column;align-items:center;line-height:1.15;}",
        ".value{font-weight:700;white-space:nowrap;}",
        ".secondary{opacity:.65;font-weight:500;white-space:nowrap;}",
        ".humidity{display:flex;align-items:center;gap:4px;white-space:nowrap;",
        "opacity:.9;margin-top:4px;color:var(--info-color,#2196f3);}",
        ".humidity ha-icon{--mdc-icon-size:18px;width:18px;height:18px;}",
        ".age{opacity:.55;white-space:nowrap;margin-top:4px;font-size:.72rem;}",
        ".age.stale{opacity:.9;color:var(--warning-color,#ffa726);font-weight:600;}",
        ".table{width:100%;}",
        ".grp,.head,.row{display:grid;gap:6px;align-items:center;}",
        ".grp{opacity:.8;font-weight:600;padding-bottom:2px;}",
        ".grp .g{text-align:center;}",
        ".head{font-weight:600;opacity:.75;padding:2px 0 4px;",
        "border-bottom:1px solid var(--divider-color);}",
        ".head div,.row div{text-align:center;white-space:nowrap;}",
        ".head .lbl,.row .lbl{text-align:left;}",
        ".row{padding:5px 0;}",
        ".row .lbl{opacity:.85;}",
        ".row .max{color:var(--error-color);font-weight:600;}",
        ".row .min{color:var(--primary-color);font-weight:600;}",
        ".row .hmax,.row .hmin{color:var(--info-color,#2196f3);font-weight:600;}",
        ".err{color:var(--error-color);padding:0 16px 12px;font-size:.85rem;}",
        ".banner{position:absolute;top:6px;right:8px;font-size:.7rem;opacity:.6;}",
      ].join("\n");

      var wrap = document.createElement("div");
      wrap.className = "wrap below";

      // --- thermometer + readouts ---
      var thermo = document.createElement("div");
      thermo.className = "thermo";

      var NS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "svg");
      svg.setAttribute("viewBox", "0 0 60 180");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

      // Unique clip id so multiple copies of the card on one dashboard do not
      // collide in the global SVG id namespace.
      var clipId = "tpc-clip-" + Math.random().toString(36).slice(2, 9);
      var defs = document.createElementNS(NS, "defs");
      var clip = document.createElementNS(NS, "clipPath");
      clip.setAttribute("id", clipId);
      var clipRect = document.createElementNS(NS, "rect");
      clipRect.setAttribute("x", "20");
      clipRect.setAttribute("y", "8");
      clipRect.setAttribute("width", "20");
      clipRect.setAttribute("height", "140");
      clipRect.setAttribute("rx", "10");
      clipRect.setAttribute("ry", "10");
      clip.appendChild(clipRect);
      defs.appendChild(clip);
      svg.appendChild(defs);

      var tube = document.createElementNS(NS, "rect");
      tube.setAttribute("x", "20");
      tube.setAttribute("y", "8");
      tube.setAttribute("width", "20");
      tube.setAttribute("height", "140");
      tube.setAttribute("rx", "10");
      tube.setAttribute("ry", "10");
      tube.setAttribute("fill", "white");
      tube.setAttribute("stroke", "var(--secondary-text-color)");
      tube.setAttribute("stroke-width", "3");
      svg.appendChild(tube);

      var g = document.createElementNS(NS, "g");
      g.setAttribute("clip-path", "url(#" + clipId + ")");
      var fill = document.createElementNS(NS, "rect");
      fill.setAttribute("x", "21");
      fill.setAttribute("y", "148");
      fill.setAttribute("width", "18");
      fill.setAttribute("height", "0");
      fill.setAttribute("fill", "var(--accent-color)");
      g.appendChild(fill);
      svg.appendChild(g);

      var bulb = document.createElementNS(NS, "circle");
      bulb.setAttribute("cx", "30");
      bulb.setAttribute("cy", "158");
      bulb.setAttribute("r", "18");
      bulb.setAttribute("fill", "var(--error-color)");
      bulb.setAttribute("stroke", "white");
      bulb.setAttribute("stroke-width", "3");
      svg.appendChild(bulb);

      thermo.appendChild(svg);

      var readout = document.createElement("div");
      readout.className = "readout";
      var value = document.createElement("div");
      value.className = "value";
      value.textContent = "—";
      var secondary = document.createElement("div");
      secondary.className = "secondary";
      secondary.style.display = "none";
      var humidity = document.createElement("div");
      humidity.className = "humidity";
      humidity.style.display = "none";
      var humIcon = document.createElement("ha-icon");
      humIcon.setAttribute("icon", "mdi:water-percent");
      var humText = document.createElement("span");
      humidity.appendChild(humIcon);
      humidity.appendChild(humText);
      var age = document.createElement("div");
      age.className = "age";
      age.style.display = "none";
      readout.appendChild(value);
      readout.appendChild(secondary);
      readout.appendChild(humidity);
      readout.appendChild(age);
      thermo.appendChild(readout);

      // --- table ---
      var right = document.createElement("div");
      var table = document.createElement("div");
      table.className = "table";
      var grp = document.createElement("div");
      grp.className = "grp";
      var head = document.createElement("div");
      head.className = "head";
      var body = document.createElement("div");
      body.className = "body";
      table.appendChild(grp);
      table.appendChild(head);
      table.appendChild(body);
      right.appendChild(table);

      var err = document.createElement("div");
      err.className = "err";
      err.style.display = "none";

      var banner = document.createElement("div");
      banner.className = "banner";
      banner.style.display = "none";

      wrap.appendChild(thermo);
      wrap.appendChild(right);
      card.appendChild(style);
      card.appendChild(wrap);
      card.appendChild(err);
      card.appendChild(banner);

      this._card = card;
      this._wrap = wrap;
      this._thermoEl = thermo;
      this._readoutEl = readout;
      this._valueEl = value;
      this._secondaryEl = secondary;
      this._humidityEl = humidity;
      this._humidityTextEl = humText;
      this._ageEl = age;
      this._fillEl = fill;
      this._bulbEl = bulb;
      this._tubeEl = tube;
      this._tableEl = table;
      this._grpEl = grp;
      this._headEl = head;
      this._bodyEl = body;
      this._errEl = err;
      this._bannerEl = banner;

      this.appendChild(card);
    }

    _applyStatic() {
      var cfg = this._config;
      var fs = cfg.font_sizes;

      try {
        this._card.setAttribute("header", cfg.title || "");
      } catch (e) {
        /* older ha-card */
      }

      this._valueEl.style.fontSize = (fs.value_rem || 1.6) + "rem";
      this._secondaryEl.style.fontSize = (fs.secondary_rem || 0.95) + "rem";
      this._humidityEl.style.fontSize = (fs.humidity_rem || 1.05) + "rem";
      this._tableEl.style.fontSize = (fs.table_rem || 0.85) + "rem";

      // Layout: "below" keeps the readout under the thermometer (default),
      // "left" puts it in its own column to the left, matching upstream.
      var pos = cfg.value_position === "left" ? "left" : "below";
      this._wrap.className = "wrap " + pos;
      if (pos === "left") {
        if (this._readoutEl.parentElement !== this._wrap) {
          this._wrap.insertBefore(this._readoutEl, this._wrap.firstChild);
        }
      } else if (this._readoutEl.parentElement !== this._thermoEl) {
        this._thermoEl.appendChild(this._readoutEl);
      }

      var tc = cfg.theme_colors || {};
      if (tc.tube) this._tubeEl.setAttribute("stroke", tc.tube);

      this._tableEl.style.display = cfg.show_table === false ? "none" : "";

      if (cfg.debug_banner) {
        this._bannerEl.style.display = "";
        this._bannerEl.textContent =
          "TPC " + VERSION + " • " + (cfg.entity || "");
      } else {
        this._bannerEl.style.display = "none";
      }
    }

    /* ---------------------------------------------------------------- *
     * Update
     * ---------------------------------------------------------------- */

    _num(entityId) {
      if (!this._hass || !entityId) return NaN;
      var st = this._hass.states ? this._hass.states[entityId] : null;
      if (!st) return NaN;
      var v = Number(st.state);
      return isNaN(v) ? NaN : v;
    }

    _entityUnit(entityId) {
      if (!this._hass || !entityId) return "";
      var st = this._hass.states ? this._hass.states[entityId] : null;
      return st && st.attributes
        ? st.attributes.unit_of_measurement || ""
        : "";
    }

    /** Epoch ms of the entity's last report, or 0 if unknown. */
    _lastUpdated(entityId) {
      if (!this._hass || !entityId) return 0;
      var st = this._hass.states ? this._hass.states[entityId] : null;
      if (!st) return 0;
      var raw = st.last_updated || st.last_changed;
      if (!raw) return 0;
      var t = typeof raw === "number" ? raw : Date.parse(raw);
      return isNaN(t) ? 0 : t;
    }

    _fmt(value, precision) {
      var p = precision;
      if (p === undefined || p === null) p = this._config.precision;
      if (p === undefined || p === null) p = 1;
      return Number(value).toFixed(p);
    }

    async _update() {
      if (!this._hass || !this._config) return;
      var cfg = this._config;

      var temp = this._num(cfg.entity);
      var nativeUnit = this._entityUnit(cfg.entity);
      var unit = cfg.unit !== undefined ? cfg.unit : nativeUnit;
      var unitTxt = unitLabel(unit);

      // --- primary readout ---
      this._valueEl.textContent =
        (isNaN(temp) ? "—" : this._fmt(temp, cfg.precision)) +
        (unitTxt ? " " + unitTxt : "");

      // --- secondary readout in another unit ---
      var secKey = unitKey(cfg.secondary_unit);
      var priKey = unitKey(unit);
      if (secKey && secKey !== priKey && !isNaN(temp)) {
        var conv = convertTemp(temp, priKey, secKey);
        this._secondaryEl.textContent =
          this._fmt(conv, cfg.secondary_precision) + " " + unitLabel(secKey);
        this._secondaryEl.style.display = "";
      } else {
        this._secondaryEl.style.display = "none";
      }

      // --- humidity readout ---
      var humUnit = "";
      if (cfg.humidity_entity) {
        var hum = this._num(cfg.humidity_entity);
        humUnit = this._entityUnit(cfg.humidity_entity) || "%";
        this._humidityTextEl.textContent =
          (isNaN(hum) ? "—" : this._fmt(hum, cfg.humidity_precision)) +
          " " +
          humUnit;
        this._humidityEl.style.display = "";
      } else {
        this._humidityEl.style.display = "none";
      }

      // --- freshness ---
      // An outdoor sensor that reports every ~20 min looks frozen, and a
      // sensor that has died looks identical to one that is merely quiet.
      // Showing the age of the reading distinguishes the two.
      if (cfg.show_age === false) {
        this._ageEl.style.display = "none";
      } else {
        var updated = this._lastUpdated(cfg.entity);
        if (cfg.humidity_entity) {
          var hu = this._lastUpdated(cfg.humidity_entity);
          if (hu && (!updated || hu > updated)) updated = hu;
        }
        if (!updated) {
          this._ageEl.style.display = "none";
        } else {
          var secs = Math.max(0, (Date.now() - updated) / 1000);
          this._ageEl.textContent = ageLabel(secs);
          var limit = Number(cfg.stale_after);
          if (isNaN(limit)) limit = 3600;
          if (limit > 0 && secs > limit) this._ageEl.classList.add("stale");
          else this._ageEl.classList.remove("stale");
          this._ageEl.style.display = "";
        }
      }

      // --- thermometer fill ---
      var sd = scaleDefaults(unit);
      var lo = Number(cfg.scale_min);
      if (isNaN(lo)) lo = sd.min;
      var hi = Number(cfg.scale_max);
      if (isNaN(hi)) hi = sd.max;
      if (hi <= lo) hi = lo + 1;

      var shown = isNaN(temp) ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, temp));
      var h = 140 * ((shown - lo) / (hi - lo));
      this._fillEl.setAttribute("y", String(148 - h));
      this._fillEl.setAttribute("height", String(h));

      // The bulb is the liquid reservoir, so it takes the same colour as the
      // column instead of being permanently red.
      var tc = cfg.theme_colors || {};
      var color;
      if (isNaN(temp)) {
        color = "var(--disabled-text-color,#9e9e9e)";
      } else if (cfg.color_mode === "static" && tc.fill) {
        color = tc.fill;
      } else if (cfg.color_mode === "spectrum") {
        var opt = Number(cfg.optimum);
        if (isNaN(opt)) opt = sd.optimum;
        color = this._spectrum(shown, lo, hi, opt);
      } else {
        var bd = bandDefaults(unit);
        var cMin = Number(cfg.comfort_min);
        if (isNaN(cMin)) cMin = bd.comfort_min;
        var cMax = Number(cfg.comfort_max);
        if (isNaN(cMax)) cMax = bd.comfort_max;
        var frz = Number(cfg.freeze_below);
        if (isNaN(frz)) frz = bd.freeze_below;
        color = this._bandColor(shown, lo, hi, cMin, cMax, frz);
      }
      this._fillEl.setAttribute("fill", color);
      this._bulbEl.setAttribute("fill", color);

      // --- history / statistics ---
      var every = 1000 * (cfg.stats_interval || 300);
      if (
        !this._fetching &&
        (!this._series || !this._lastFetch || Date.now() - this._lastFetch > every)
      ) {
        this._fetching = true;
        try {
          await this._fetchSeries();
          this._renderTable(unitTxt, humUnit);
          this._showErr("");
        } catch (e) {
          console.error("[TPC]", e);
          this._showErr(e && e.message ? e.message : String(e));
        } finally {
          this._fetching = false;
        }
      } else if (this._series) {
        this._renderTable(unitTxt, humUnit);
      }
    }

    /**
     * Banded colouring: flat green inside the comfort band, amber -> orange ->
     * red above it, light -> deep blue below it, and snow white below the
     * freezing threshold. Each band starts at its own distinct colour so that
     * crossing a threshold is visible at a glance.
     */
    _bandColor(value, lo, hi, comfortMin, comfortMax, freezeBelow) {
      if (comfortMax < comfortMin) {
        var swap = comfortMin;
        comfortMin = comfortMax;
        comfortMax = swap;
      }
      if (value >= comfortMin && value <= comfortMax) return rgb(BAND_GREEN);
      if (value > comfortMax) {
        return ramp(BAND_HOT, (value - comfortMax) / Math.max(1e-6, hi - comfortMax));
      }
      if (value >= freezeBelow) {
        return ramp(
          BAND_COLD,
          (value - freezeBelow) / Math.max(1e-6, comfortMin - freezeBelow)
        );
      }
      return ramp(BAND_SNOW, (value - lo) / Math.max(1e-6, freezeBelow - lo));
    }

    _spectrum(value, lo, hi, optimum) {
      if (hi <= lo) hi = lo + 1;
      var t = clamp01((value - lo) / (hi - lo));
      var o = clamp01((optimum - lo) / (hi - lo));
      var cold = [
        [0, 114, 255],
        [0, 200, 255],
        [0, 200, 0],
        [255, 215, 0],
      ];
      var hot = [
        [255, 215, 0],
        [255, 165, 0],
        [220, 0, 0],
      ];
      if (t <= o) {
        var a = 3 * (o > 0 ? t / o : 0);
        var ai = Math.min(2, Math.floor(a));
        return rgb(lerpRgb(cold[ai], cold[ai + 1], a - ai));
      }
      var b = 2 * ((t - o) / Math.max(1e-6, 1 - o));
      var bi = Math.min(1, Math.floor(b));
      return rgb(lerpRgb(hot[bi], hot[bi + 1], b - bi));
    }

    /* ---------------------------------------------------------------- *
     * Data
     * ---------------------------------------------------------------- */

    /**
     * Fetch one series per entity covering the largest configured window.
     * Each point is normalised to {t, min, max} so statistics buckets and raw
     * history states can be reduced by the same code path.
     */
    async _fetchSeries() {
      var cfg = this._config;
      var ids = [cfg.entity];
      if (cfg.humidity_entity) ids.push(cfg.humidity_entity);

      var maxHours = Math.max.apply(null, cfg.windows);
      var now = Date.now();
      var startIso = new Date(now - maxHours * 3600000).toISOString();
      var endIso = new Date(now).toISOString();

      var series = {};

      // 1) Long-term statistics: cheap and purge-proof.
      try {
        var stats = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: startIso,
          end_time: endIso,
          statistic_ids: ids,
          period: "5minute",
          types: ["min", "max"],
        });
        ids.forEach(function (id) {
          var rows = (stats && stats[id]) || [];
          series[id] = rows.map(function (b) {
            return { t: statBucketTime(b), min: b.min, max: b.max };
          });
        });
      } catch (e) {
        console.warn("[TPC] statistics unavailable, using history", e);
      }

      // 2) Per-entity fallback to raw history when statistics are empty.
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (series[id] && series[id].length) continue;
        try {
          var res = await this._hass.callApi(
            "GET",
            "history/period/" +
              startIso +
              "?filter_entity_id=" +
              encodeURIComponent(id) +
              "&minimal_response=1&no_attributes=1"
          );
          var pts = res && res[0] ? res[0] : [];
          series[id] = pts
            .map(function (p) {
              var v = Number(p.state);
              if (isNaN(v)) return null;
              var t = Date.parse(p.last_changed || p.last_updated || 0);
              return { t: isNaN(t) ? 0 : t, min: v, max: v };
            })
            .filter(Boolean);
        } catch (e2) {
          console.warn("[TPC] history failed for " + id, e2);
          series[id] = [];
        }
      }

      this._series = series;
      this._lastFetch = Date.now();
    }

    /** Reduce a cached series to {min,max} over the trailing `hours`. */
    _windowMinMax(entityId, hours) {
      var pts = (this._series && this._series[entityId]) || [];
      var cutoff = Date.now() - hours * 3600000;
      var mn = Infinity;
      var mx = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p.t < cutoff) continue;
        if (p.min !== null && p.min !== undefined && p.min < mn) mn = p.min;
        if (p.max !== null && p.max !== undefined && p.max > mx) mx = p.max;
      }
      return {
        min: mn === Infinity ? undefined : mn,
        max: mx === -Infinity ? undefined : mx,
      };
    }

    _renderTable(tempUnit, humUnit) {
      var cfg = this._config;
      if (cfg.show_table === false) return;

      var hasHum = !!cfg.humidity_entity;
      var cols = hasHum
        ? "minmax(34px,auto) repeat(4,1fr)"
        : "minmax(34px,auto) repeat(2,1fr)";

      this._grpEl.style.gridTemplateColumns = cols;
      this._headEl.style.gridTemplateColumns = cols;

      // Group header only earns its row when there are two metrics to label.
      if (hasHum) {
        this._grpEl.style.display = "grid";
        this._grpEl.innerHTML =
          '<div></div>' +
          '<div class="g" style="grid-column:span 2">Temp</div>' +
          '<div class="g" style="grid-column:span 2">Humidity</div>';
      } else {
        this._grpEl.style.display = "none";
        this._grpEl.innerHTML = "";
      }

      this._headEl.innerHTML =
        '<div class="lbl"></div><div>Max</div><div>Min</div>' +
        (hasHum ? "<div>Max</div><div>Min</div>" : "");

      var self = this;
      var body = this._bodyEl;
      body.innerHTML = "";

      cfg.windows.forEach(function (hours) {
        var t = self._windowMinMax(cfg.entity, hours);
        var row = document.createElement("div");
        row.className = "row";
        row.style.gridTemplateColumns = cols;

        var tu = tempUnit ? " " + tempUnit : "";
        var html =
          '<div class="lbl">' +
          windowLabel(hours) +
          "</div>" +
          '<div class="max">' +
          (t.max !== undefined ? self._fmt(t.max, cfg.precision) + tu : "—") +
          "</div>" +
          '<div class="min">' +
          (t.min !== undefined ? self._fmt(t.min, cfg.precision) + tu : "—") +
          "</div>";

        if (hasHum) {
          var h = self._windowMinMax(cfg.humidity_entity, hours);
          var hu = humUnit ? " " + humUnit : "";
          html +=
            '<div class="hmax">' +
            (h.max !== undefined
              ? self._fmt(h.max, cfg.humidity_precision) + hu
              : "—") +
            "</div>" +
            '<div class="hmin">' +
            (h.min !== undefined
              ? self._fmt(h.min, cfg.humidity_precision) + hu
              : "—") +
            "</div>";
        }

        row.innerHTML = html;
        body.appendChild(row);
      });
    }

    _showErr(msg) {
      if (!this._errEl) return;
      this._errEl.textContent = msg || "";
      this._errEl.style.display = msg ? "" : "none";
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */

  class ThermometerPlusCardEditor extends HTMLElement {
    constructor() {
      super();
      this._config = {};
      this._hass = null;
      this._root = null;
    }

    setConfig(config) {
      this._config = Object.assign({}, config || {});
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
    }

    _schema() {
      return [
        { name: "entity", selector: { entity: { domain: "sensor" } } },
        { name: "humidity_entity", selector: { entity: { domain: "sensor" } } },
        { name: "title", selector: { text: {} } },
        { name: "unit", selector: { text: {} } },
        { name: "secondary_unit", selector: { text: {} } },
        {
          name: "precision",
          selector: { number: { min: 0, max: 3, mode: "box" } },
        },
        {
          name: "humidity_precision",
          selector: { number: { min: 0, max: 3, mode: "box" } },
        },
        { name: "show_table", selector: { boolean: {} } },
        { name: "windows", selector: { object: {} } },
        {
          name: "stats_interval",
          selector: { number: { min: 30, max: 3600, step: 30, mode: "slider" } },
        },
        { name: "font_sizes", selector: { object: {} } },
        {
          name: "value_position",
          selector: {
            select: {
              options: [
                { value: "below", label: "Below thermometer" },
                { value: "left", label: "Left of thermometer" },
              ],
            },
          },
        },
        {
          name: "scale_min",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        {
          name: "scale_max",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        {
          name: "optimum",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        {
          name: "color_mode",
          selector: {
            select: {
              options: [
                { value: "bands", label: "Bands (snow / cold / comfort / hot)" },
                { value: "spectrum", label: "Spectrum" },
                { value: "static", label: "Static (theme_colors.fill)" },
              ],
            },
          },
        },
        {
          name: "comfort_min",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        {
          name: "comfort_max",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        {
          name: "freeze_below",
          selector: { number: { min: -100, max: 400, mode: "box" } },
        },
        { name: "show_age", selector: { boolean: {} } },
        {
          name: "stale_after",
          selector: { number: { min: 0, max: 86400, mode: "box" } },
        },
        { name: "theme_colors", selector: { object: {} } },
        { name: "debug_banner", selector: { boolean: {} } },
      ];
    }

    _render() {
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = "";
      var form = document.createElement("ha-form");
      form.hass = this._hass;
      form.data = this._config;
      form.schema = this._schema();
      var self = this;
      form.addEventListener("value-changed", function (ev) {
        if (ev.detail && ev.detail.value) {
          self._config = ev.detail.value;
          self.dispatchEvent(
            new CustomEvent("config-changed", {
              detail: { config: self._config },
            })
          );
        }
      });
      this._form = form;
      this._root.appendChild(form);
    }
  }

  /* ------------------------------------------------------------------ *
   * Registration
   * ------------------------------------------------------------------ */

  try {
    if (!customElements.get(CARD)) {
      customElements.define(CARD, ThermometerPlusCard);
    }
  } catch (e) {
    console.error("[TPC] Failed to define element:", e);
  }

  try {
    if (!customElements.get(CARD + "-editor")) {
      customElements.define(CARD + "-editor", ThermometerPlusCardEditor);
    }
  } catch (e) {
    /* editor is optional */
  }

  try {
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: CARD,
      name: "Thermometer Plus (Temp + Humidity)",
      description:
        "Thermometer with temperature + humidity, rolling min/max windows " +
        "(6h/12h/24h) and a secondary unit readout.",
      preview: true,
    });
  } catch (e) {
    /* non-fatal */
  }

  try {
    console.info("[TPC] Thermometer Plus Card loaded", VERSION);
  } catch (e) {
    /* non-fatal */
  }
})();
