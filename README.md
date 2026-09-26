# Thermometer Plus Card

A Home Assistant Lovelace card that draws a thermometer for a temperature
sensor, with three things the card it was forked from could not do:

1. **Temperature *and* humidity** on one card — current value plus min/max.
2. **Rolling time windows** (`6h` / `12h` / `24h`, or anything you like)
   instead of fixed daily / monthly / yearly buckets.
3. **A secondary unit readout** — e.g. °C rendered in a smaller font
   underneath the °F value.

It also colours the thermometer — column *and* bulb — by comfort band rather
than a single gradient: snow white below freezing, blue when cold, green in
the ideal range, red when hot. See [Colours](#colours).

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

### Option A — HACS (recommended)

This card is not in the default HACS store, so add it as a custom repository:

1. In Home Assistant go to **HACS**.
2. Open the **⋮** menu (top right) → **Custom repositories**.
3. Paste the repository URL and pick the type:

   | Field | Value |
   |-------|-------|
   | Repository | `https://github.com/dougkl/thermometer-plus-card` |
   | Type | **Dashboard** (called *Lovelace* on older HACS versions) |

4. Click **Add**, then close the dialog.
5. Search HACS for **Thermometer Plus Card**, open it and click **Download**.
6. **Reload the browser bypassing the cache** (`Ctrl`+`F5`, or
   `Cmd`+`Shift`+`R` on macOS). HACS registers the dashboard resource for you,
   but the browser will happily keep serving the previously cached module.
7. Add it to a dashboard: **Edit dashboard → + Add card**, search for
   **Thermometer Plus**, and pick your temperature sensor. The visual editor
   exposes every option listed below.

To update later, HACS offers the new release and handles the resource version
for you — just bypass the cache again afterwards.

> HACS installs to `config/www/community/thermometer-plus-card/`. If you had
> previously installed manually into `config/www/`, delete that old file and
> its resource entry, otherwise two copies fight over the same `custom:` card
> name.

### Option B — manual

1. Copy `thermometer-plus-card.js` into your Home Assistant `config/www/`
   directory:

   ```bash
   cp thermometer-plus-card.js /config/www/
   ```

2. Register it as a Lovelace resource — **Settings → Dashboards → ⋮ →
   Resources → Add resource**:

   - URL: `/local/thermometer-plus-card.js?v=1.1.0`
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
   edit on its next save. Upgrading a card that already uses this type keeps
   whatever you changed in the dashboard UI and only forces the keys that are
   new in that version.

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
color_mode: bands
comfort_min: 65
comfort_max: 76
freeze_below: 35
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
| `optimum` | number | unit-aware | Where the colour spectrum turns from cool to warm. Only used by `color_mode: spectrum`. |
| `color_mode` | string | `bands` | `bands`, `spectrum`, or `static` (uses `theme_colors.fill`). |
| `comfort_min` / `comfort_max` | number | unit-aware | The green "ideal" band. `bands` mode only. |
| `freeze_below` | number | unit-aware | Below this the thermometer turns snow white. `bands` mode only. |
| `precision` | number | `1` | Decimals for temperature. |
| `humidity_precision` | number | `0` | Decimals for humidity. |
| `font_sizes` | object | see above | Per-element font sizes in `rem`. |
| `theme_colors` | object | `{}` | `{ tube, fill }` colour overrides. |
| `debug_banner` | bool | `false` | Show version/entity in the corner. |

### Colours

With the default `color_mode: bands`, the liquid column **and the bulb** are
coloured by how the temperature compares to your comfort band, so a glance at
the card tells you hot / ideal / cold / freezing:

| Range (°F defaults) | Colour |
|---------------------|--------|
| above `comfort_max` (76) | green → lime → gold → orange → **red**, hotter is redder |
| `comfort_min` … `comfort_max` (65–76) | flat **green** — ideal |
| `freeze_below` … `comfort_min` (35–65) | green → teal → **blue**, colder is bluer |
| below `freeze_below` (35) | pale ice → **snow white**, colder is whiter |

The ramps meet exactly at each threshold, so there is no visible jump as the
temperature crosses one. The bulb always matches the column — upstream painted
it red permanently, which read as "hot" even at freezing.

`comfort_min`, `comfort_max` and `freeze_below` are in the card's display
`unit`, and default per unit:

| Unit | `comfort_min` | `comfort_max` | `freeze_below` |
|------|---------------|---------------|----------------|
| °F | 65 | 76 | 35 |
| °C | 18.3 | 24.4 | 1.7 |
| K | 291.5 | 297.6 | 274.8 |

An unavailable or unknown temperature is drawn grey rather than in a band
colour, so a stale sensor is never mistaken for a real reading.

The other two modes are still available: `spectrum` is the original continuous
gradient pivoting around `optimum`, and `static` paints everything
`theme_colors.fill`.

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

58 assertions cover the readouts and secondary-unit conversion, window
filtering and labels, the scale fix, the colour bands (flat green across the
comfort band, monotonically redder above it, blue then snow-white below it,
ramps meeting at the thresholds, configurable limits, and grey when
unavailable), graceful degradation (missing humidity entity, `unavailable`
states, empty history), legacy config compatibility, and that two instances on
one dashboard do not collide in the SVG id namespace.

## License

[MIT](LICENSE)
