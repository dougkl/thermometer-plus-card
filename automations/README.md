# Zigbee 4-Button Switch Dimming Automations

Profile-driven deploy + test scripts for Tuya/Moes-style **TS0044** 4-button
Zigbee switches in Home Assistant (ZHA).

Each switch gets the same verified behaviour:

| Trigger | Action |
|---------|--------|
| Button 2, single press | Dim by 10 percentage points, floor **5 %** — never switches the light off. No-op while the lights are off. |
| Button 2, double press | Jump straight to **10 %**. |
| Button 3, single press | Brighten by 10 percentage points, capped at **100 %**. From off, turns on at 10 %. |
| Button 3, double press | Jump straight to **100 %**. |

Buttons 1 and 4 are left alone for on/off/scene use.

## Why `mode: queued`

With `mode: single`, a quick burst of presses is *dropped* while the first run
is still in flight, so holding-and-tapping feels unresponsive. `queued` with
`max: 10` steps once per press instead. Each automation also sets
`trace: stored_traces: 20` so recent presses stay inspectable under
**Settings → Automations → Traces**.

## Usage

```bash
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="<long-lived token>"

python3 deploy_dimmer.py                     # dry run, all profiles
python3 deploy_dimmer.py living_room         # dry run, one profile
python3 deploy_dimmer.py --apply living_room
python3 deploy_dimmer.py --apply all
```

Define your switches in the `PROFILES` dict at the top of `deploy_dimmer.py`:

```python
PROFILES = {
    "living_room": {
        "label": "Living room",
        "device_id": "<ZHA device id>",
        "target": "light.living_room_lights",
        "base_id": 1790365000001,
        "skip": set(),
    },
}
```

- `device_id` — the ZHA device id (Developer Tools → Devices, or read it out of
  an existing device trigger).
- `target` — usually a light **group** so one automation drives every bulb.
- `base_id` — the first of four consecutive automation ids. Re-running
  overwrites those same ids, which is what makes the script idempotent.
- `skip` — keys to leave alone (`b2_short`, `b2_double`, `b3_short`,
  `b3_double`) when an automation already exists and you want to keep it.

## Verifying button numbering

ZHA subtypes (`button_1` … `button_4`) do not always match the physical layout
printed on the switch. Before trusting the mapping, list what the device
actually exposes:

```bash
python3 - <<'EOF'
# device_automation/trigger/list over the HA websocket API
EOF
```

…then cross-check against automations you already know work. On my install all
TS0044 switches map 1:1 (physical button N == `button_N`), confirmed across
four switches.

## Tests

```bash
python3 test_dimmer.py living_room
```

Drives the **real** light group through every boundary case and restores its
original state afterwards:

```
50% --b2--> 40%        50% --b3--> 60%
 8% --b2-->  5%   (floor holds, light stays on)
 5% --b2-->  5%   (sticky floor)
95% --b3--> 100%  (cap)
100% --b3--> 100% (sticky cap)
80% --b2 dbl--> 10%
10% --b3 dbl--> 100%
off --b2--> off   (no-op)
off --b3--> 10%
```

The test resolves automation entities by their numeric automation `id`
attribute rather than guessing entity slugs — renaming an automation's alias
does **not** rewrite its `entity_id`, so slugs drift from aliases over time.

## License

[MIT](../LICENSE)
