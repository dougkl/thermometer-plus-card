# Home Assistant IoT

Custom Lovelace cards and automation tooling for my Home Assistant setup.

Everything here is deployed with plain Python over the Home Assistant REST and
WebSocket APIs — no YAML hand-editing, no add-ons required. Each deploy script
is **dry-run by default** and idempotent, so re-running it is safe.

## Contents

| Path | What it is |
|------|------------|
| [`cards/thermometer-plus-card`](cards/thermometer-plus-card) | A thermometer card showing temperature **and** humidity, rolling min/max windows (6h / 12h / 24h) and a secondary unit readout (°C under °F). |
| [`automations/`](automations) | Profile-driven deploy + test scripts for Zigbee 4-button-switch dimming automations. |

## Conventions

Every tool in this repo follows the same three rules:

1. **Dry run first.** Scripts print exactly what they would change and exit.
   Pass `--apply` to actually write.
2. **Back up before writing.** Anything that mutates `.storage` or
   `automations.yaml` snapshots the file first.
3. **Verify afterwards.** Each component ships a test that runs against real
   data (or a real DOM) rather than asserting on mocks alone.

## Credentials

No secrets are stored in this repo. The deploy scripts read:

```bash
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="<long-lived access token>"
```

Create a long-lived access token from your Home Assistant profile page
(**Profile → Security → Long-lived access tokens**).

## License

[MIT](LICENSE)
