#!/usr/bin/env python3
"""
Functional test for the 4-button-switch dimming automations.

Resolves automation entities by their numeric automation id (exposed as the
`id` state attribute) rather than guessing slugs, drives the real light group
through every boundary case, then restores the group's original state.

Usage:
    python3 test_dimmer.py living_room
    python3 test_dimmer.py bedroom
"""
import json
import os
import sys
import time
import urllib.request

HA_URL = os.environ["HA_URL"].rstrip("/")
HA_TOKEN = os.environ["HA_TOKEN"]

PROFILES = {
    "bedroom": {
        "target": "light.bedroom_lights",
        "b2_short": "1790279000001",
        "b2_double": "1790279000002",
        "b3_short": "1790279000003",
        "b3_double": "1787103476395",
    },
    "living_room": {
        "target": "light.living_room_lights",
        "b2_short": "1790365000001",
        "b2_double": "1790365000002",
        "b3_short": "1790365000003",
        "b3_double": "1790365000004",
    },
}

SETTLE = 5.0


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        HA_URL + path, data=data, method=method,
        headers={"Authorization": "Bearer " + HA_TOKEN,
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else None


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in PROFILES:
        sys.exit(f"usage: test_dimmer.py [{'|'.join(PROFILES)}]")
    prof = PROFILES[sys.argv[1]]
    target = prof["target"]

    states = api("GET", "/api/states")
    by_auto_id = {
        s["attributes"].get("id"): s["entity_id"]
        for s in states if s["entity_id"].startswith("automation.")
    }

    ents = {}
    print("=== automation entities ===")
    for key in ("b2_short", "b2_double", "b3_short", "b3_double"):
        eid = by_auto_id.get(prof[key])
        if not eid:
            sys.exit(f"automation id {prof[key]} ({key}) not found")
        ents[key] = eid
        st = api("GET", f"/api/states/{eid}")
        print(f"  {key:10s} {eid}  -> {st['state']}"
              f"  ({st['attributes'].get('friendly_name')})")

    def state(e):
        return api("GET", f"/api/states/{e}")

    def pct():
        s = state(target)
        if s["state"] != "on":
            return None
        b = s["attributes"].get("brightness")
        return None if b is None else round(b / 2.55)

    def set_pct(p):
        api("POST", "/api/services/light/turn_on",
            {"entity_id": target, "brightness_pct": p})
        time.sleep(SETTLE)

    def fire(key):
        api("POST", "/api/services/automation/trigger",
            {"entity_id": ents[key], "skip_condition": False})
        time.sleep(SETTLE)

    results = []

    def check(label, got, want, tol=3):
        if want is None:
            ok = got is None
        elif got is None:
            ok = False
        else:
            ok = abs(got - want) <= tol
        results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {label}: got={got} want={want}")

    print("\n=== group members ===")
    grp = state(target)
    for m in grp["attributes"].get("entity_id", []):
        ms = state(m)
        print(f"  {m:35s} {ms['state']:15s} "
              f"{ms['attributes'].get('friendly_name')}")

    orig_on = grp["state"] == "on"
    orig_b = grp["attributes"].get("brightness")
    print(f"\nOriginal group state: {grp['state']} brightness={orig_b}")

    try:
        print("\n=== test 1: dim 50% -> 40% ===")
        set_pct(50)
        fire("b2_short")
        check("button 2 single from 50", pct(), 40)

        print("\n=== test 2: brighten 50% -> 60% ===")
        set_pct(50)
        fire("b3_short")
        check("button 3 single from 50", pct(), 60)

        print("\n=== test 3: dim floor 8% -> 5%, stays on ===")
        set_pct(8)
        fire("b2_short")
        check("button 2 single from 8 (floor 5)", pct(), 5)
        check("light still on at floor", state(target)["state"] == "on",
              True, tol=0)

        print("\n=== test 4: floor is sticky 5% -> 5% ===")
        fire("b2_short")
        check("button 2 single from 5 (stays 5)", pct(), 5)

        print("\n=== test 5: brighten cap 95% -> 100% ===")
        set_pct(95)
        fire("b3_short")
        check("button 3 single from 95 (cap 100)", pct(), 100)

        print("\n=== test 6: cap is sticky 100% -> 100% ===")
        fire("b3_short")
        check("button 3 single from 100 (stays 100)", pct(), 100)

        print("\n=== test 7: button 2 double -> 10% ===")
        set_pct(80)
        fire("b2_double")
        check("button 2 double", pct(), 10)

        print("\n=== test 8: button 3 double -> 100% ===")
        fire("b3_double")
        check("button 3 double", pct(), 100)

        print("\n=== test 9: button 2 single is a no-op while off ===")
        api("POST", "/api/services/light/turn_off", {"entity_id": target})
        time.sleep(SETTLE)
        fire("b2_short")
        check("group stays off", state(target)["state"] == "off", True, tol=0)

        print("\n=== test 10: button 3 single from off -> 10% ===")
        fire("b3_short")
        check("button 3 single from off", pct(), 10)

    finally:
        print("\n=== restoring original state ===")
        if orig_on and orig_b:
            api("POST", "/api/services/light/turn_on",
                {"entity_id": target, "brightness": orig_b})
        else:
            api("POST", "/api/services/light/turn_off", {"entity_id": target})
        time.sleep(SETTLE)
        s = state(target)
        print("restored ->", s["state"], s["attributes"].get("brightness"))

    print(f"\n==== {sum(results)}/{len(results)} checks passed ====")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
