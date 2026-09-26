# Thermometer Plus Card

A Home Assistant Lovelace card that draws a thermometer for a temperature
sensor, with three things the card it was forked from could not do:

1. **Temperature *and* humidity** on one card — current value plus min/max.
2. **Rolling time windows** (`6h` / `12h` / `24h`, or anything you like)
   instead of fixed daily / monthly / yearly buckets.
3. **A secondary unit readout** — e.g. °C rendered in a smaller font
   underneath the °F value.

It is a standalone fork of `temperature-thermometer-card` v2.2.0 and
deliberately installs to `www/` rather than `www/community/`, so a HACS update
of the original cannot overwrite it.

```
┌──────────────────────────────┐
│ Outdoor                      │
│                              │
│    ▓         Temp    Humidity│
│    ▓        Max  Min  Max Min│
│    ▓   6 h  74.0 70.0  57  40│
│    ▓  12 h  80.0 62.0  70  30│
│    █  24 h  80.0 55.0  90  20│
│   ███                        │
│  73.9 °F                     │
│  23.3 °C   ← smaller font    │
│  💧 42 %                     │
└──────────────────────────────┘
```

## Install

1. Copy `thermometer-plus-card.js` into your Home Assistant `config/www/`
   directory:

   ```bash
   cp thermometer-plus-card.js /config/www/
   ```

2. Register it as a Lovelace resource — **Settings → Dashboards → ⋮ →
   Resources → Add resource**:

   - URL: `/local/thermometer-plus-card.js?v=1.0.0`
   - Type: **JavaScript module**

   Or let the bundled script do both steps and rewrite the card in your
   dashboard:

   ```bash
   export HA_URL="http://homeassistant.local:8123"
   export HA_TOKEN="<long-lived access token>"

   python3 deploy_thermometer_card.py            # dry run
   python3 deploy_thermometer_card.py --apply
   ```

   Edit the `TEMP_ENTITY` / `HUM_ENTITY` constants at the top of that script
   before running it. It backs up `.storage` first, and edits the dashboard
   through the websocket API rather than writing `.storage` directly — Home
   Assistant keeps the dashboard in memory and would overwrite a direct file
   edit on its next save.

   `deploy_thermometer_card.py` imports `ha_ws.py`, a stdlib-only websocket
   client included here — keep the two files side by side. Neither needs pip,
   so they run as-is on Home Assistant OS.

3. Bump the `?v=` query string whenever you update the file, otherwise the
   browser will keep serving the cached copy.

> No secrets live in this repo. `deploy_thermometer_card.py` reads `HA_URL` and
> `HA_TOKEN` from the environment. Create a long-lived access token from
> **Profile → Security → Long-lived access tokens**.

## Configuration

```yaml
type: custom:thermometer-plus-card
entity: sensor.patio_temperature
humidity_entity: sensor.patio_humidity
title: Outdoor
unit: F
secondary_unit: C
windows: [6, 12, 24]
show_table: true
stats_interval: 60
value_position: below
color_mode: spectrum
scale_min: 0
scale_max: 110
optimum: 72
precision: 1
humidity_precision: 0
font_sizes:
  value_rem: 1.6
  secondary_rem: 0.95
  humidity_rem: 1.05
  table_rem: 0.8
grid_options:
  columns: 9
  rows: auto
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `entity` | string | **required** | Temperature sensor. |
| `humidity_entity` | string | — | Humidity sensor. Omit to hide humidity entirely (the table drops to 3 columns). |
| `title` | string | `Temperature` | Card header. |
| `unit` | string | sensor's unit | Display unit for the main readout. |
| `secondary_unit` | string | — | Second unit shown underneath in a smaller font. Hidden when it matches `unit`. Supports `C`, `F`, `K`. |
| `windows` | list | `[6, 12, 24]` | Rolling windows for the min/max table. Accepts `6`, `"6h"`, `"30m"`, `"2d"`. |
| `show_table` | bool | `true` | Show the min/max table. |
| `stats_interval` | number | `300` | Seconds between history refreshes. |
| `value_position` | string | `below` | `below` or `left` of the thermometer. |
| `scale_min` / `scale_max` | number | unit-aware | Thermometer range. |
| `optimum` | number | unit-aware | Where the colour spectrum turns from cool to warm. |
| `color_mode` | string | `spectrum` | `spectrum` or `static` (uses `theme_colors.fill`). |
| `precision` | number | `1` | Decimals for temperature. |
| `humidity_precision` | number | `0` | Decimals for humidity. |
| `font_sizes` | object | see above | Per-element font sizes in `rem`. |
| `theme_colors` | object | `{}` | `{ tube, fill }` colour overrides. |
| `debug_banner` | bool | `false` | Show version/entity in the corner. |

### Unit-aware scale defaults

The upstream card always defaulted to `-20 … 40`, which pegs the bar at full
scale for any °F sensor. Defaults here follow the unit:

| Unit | `scale_min` | `scale_max` | `optimum` |
|------|-------------|-------------|-----------|
| °C | −20 | 40 | 20 |
| °F | 0 | 110 | 72 |
| K | 253 | 313 | 293 |

## How min/max is calculated

The card issues **one** request covering the largest configured window and
derives the shorter windows by filtering that series client-side.

- **Primary source:** `recorder/statistics_during_period` with
  `period: 5minute`, which returns per-bucket `min`/`max`. The recorder derives
  those from every state in the bucket, so they are exactly as accurate as
  scanning raw history — but far cheaper, and they survive the state purge.
- **Fallback:** the `history/period` REST endpoint, used per entity whenever
  statistics come back empty (for example a sensor added minutes ago that has
  not been rolled up yet).

## Tests

The card is exercised headlessly in a real DOM via jsdom:

```bash
cd test
npm install
npm test
```

37 assertions cover the readouts and secondary-unit conversion, window
filtering and labels, the scale fix, graceful degradation (missing humidity
entity, `unavailable` states, empty history), legacy config compatibility, and
that two instances on one dashboard do not collide in the SVG id namespace.

## License

[MIT](LICENSE)
