#!/usr/bin/env python3
"""
Deploy the Thermometer Plus card.

Steps (all idempotent):
  1. Back up .storage/lovelace.lovelace and .storage/lovelace_resources.
  2. Register (or cache-bust) the /local/thermometer-plus-card.js resource.
  3. Replace the existing `custom:temperature-thermometer-card` in the
     dashboard with the new `custom:thermometer-plus-card` config.

The dashboard is edited through the websocket API (lovelace/config +
lovelace/config/save) rather than by writing .storage directly, because HA
keeps the dashboard in memory and would otherwise overwrite the file.

Usage:
    python3 deploy_thermometer_card.py            # dry run
    python3 deploy_thermometer_card.py --apply
"""
import datetime
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ha_ws import HAClient  # noqa: E402

CARD_VERSION = "1.1.0"
RESOURCE_URL = "/local/thermometer-plus-card.js?v=" + CARD_VERSION
RESOURCE_STEM = "/local/thermometer-plus-card.js"

OLD_TYPE = "custom:temperature-thermometer-card"
NEW_TYPE = "custom:thermometer-plus-card"

TEMP_ENTITY = "sensor.thermostat_sensor_patio_temperature"
HUM_ENTITY = "sensor.thermostat_sensor_patio_humidity"

NEW_CARD = {
    "type": NEW_TYPE,
    "entity": TEMP_ENTITY,
    "humidity_entity": HUM_ENTITY,
    "title": "Outdoor",
    "unit": "F",
    "secondary_unit": "C",
    "windows": [6, 12, 24],
    "show_table": True,
    "stats_interval": 60,
    "value_position": "below",
    # Banded colouring: snow-white below freezing, blue while cold, flat green
    # through the comfort band, then gold/orange/red as it heats up.
    "color_mode": "bands",
    "comfort_min": 65,
    "comfort_max": 76,
    "freeze_below": 35,
    # Upstream defaulted to -20..40, which pegs a degF reading at full scale.
    "scale_min": 0,
    "scale_max": 110,
    "optimum": 72,
    "precision": 1,
    "humidity_precision": 0,
    "font_sizes": {
        "value_rem": 1.6,
        "secondary_rem": 0.95,
        "humidity_rem": 1.05,
        "table_rem": 0.8,
    },
    "grid_options": {"columns": 9, "rows": "auto"},
}

# Keys introduced by this version. When upgrading a card that is already ours
# these are overwritten; everything else the user set in the UI is kept.
FORCE_KEYS = ("type", "color_mode", "comfort_min", "comfort_max", "freeze_below")

STORAGE = "/config/.storage"
BACKUP_DIR = "/config/matter-keepalive/backups"


def backup():
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    made = []
    for name in ("lovelace.lovelace", "lovelace_resources"):
        src = os.path.join(STORAGE, name)
        if os.path.exists(src):
            dst = os.path.join(BACKUP_DIR, f"{name}.bak-{stamp}")
            shutil.copy2(src, dst)
            made.append(dst)
    return made


def walk_replace(node, hits):
    """Swap every old thermometer card for the new config, in place.

    Migrating from the upstream card starts from NEW_CARD and keeps only the
    layout. Upgrading a card that is already ours must NOT clobber settings
    tweaked in the dashboard UI, so the existing config wins and only the keys
    introduced by this version are forced.
    """
    if isinstance(node, dict):
        is_ours = node.get("type") == NEW_TYPE
        if node.get("type") == OLD_TYPE or is_ours:
            merged = dict(NEW_CARD)
            if is_ours:
                merged.update(node)
                for k in FORCE_KEYS:
                    merged[k] = NEW_CARD[k]
            else:
                # Preserve layout the user may have tweaked.
                if "grid_options" in node:
                    merged["grid_options"] = node["grid_options"]
                if "title" in node and node["title"]:
                    merged["title"] = node["title"]
            hits.append((dict(node), merged))
            node.clear()
            node.update(merged)
            return
        for v in node.values():
            walk_replace(v, hits)
    elif isinstance(node, list):
        for v in node:
            walk_replace(v, hits)


def main():
    apply = "--apply" in sys.argv
    client = HAClient(os.environ["HA_URL"], os.environ["HA_TOKEN"])

    try:
        # ---------------- resources ----------------
        res = client.cmd(type="lovelace/resources")
        resources = res.get("result") or []
        existing = [r for r in resources
                    if str(r.get("url", "")).startswith(RESOURCE_STEM)]
        print("=== lovelace resource ===")
        if existing:
            cur = existing[0]
            if cur.get("url") == RESOURCE_URL:
                print(f"  already registered: {cur['url']}")
                res_action = None
            else:
                print(f"  update {cur['url']} -> {RESOURCE_URL}")
                res_action = ("update", cur["id"])
        else:
            print(f"  create {RESOURCE_URL}")
            res_action = ("create", None)

        # ---------------- dashboard ----------------
        cfg_res = client.cmd(type="lovelace/config", url_path=None)
        if not cfg_res.get("success"):
            sys.exit(f"could not read dashboard: {cfg_res}")
        config = cfg_res["result"]

        hits = []
        walk_replace(config, hits)

        print("\n=== dashboard cards ===")
        if not hits:
            print("  no thermometer card found - nothing to replace")
        for before, after in hits:
            print("  BEFORE:", json.dumps(before))
            print("  AFTER :", json.dumps(after))

        if not apply:
            print("\nDRY RUN - pass --apply to write.")
            return

        made = backup()
        print("\n=== backups ===")
        for m in made:
            print("  ", m)

        if res_action:
            kind, rid = res_action
            if kind == "create":
                r = client.cmd(type="lovelace/resources/create",
                               res_type="module", url=RESOURCE_URL)
            else:
                r = client.cmd(type="lovelace/resources/update",
                               resource_id=rid, res_type="module",
                               url=RESOURCE_URL)
            print(f"\nresource {kind}: success={r.get('success')} "
                  f"{r.get('error', '')}")

        if hits:
            s = client.cmd(type="lovelace/config/save", url_path=None,
                           config=config)
            print(f"dashboard save: success={s.get('success')} "
                  f"{s.get('error', '')}")
            if not s.get("success"):
                sys.exit("dashboard save FAILED")

        print("\nDone.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
