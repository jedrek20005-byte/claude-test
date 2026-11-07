"""Builds race-data/races.json: every career race and every trainable Uma's aptitudes.

The data comes from GameTora (gametora.com), which reads the game's master
data: `race_instances` lists each race of a career with its year (1 Junior,
2 Classic, 3 Senior), month and half, the fans needed to enter, and the id of
its fan table in `race-fans` (fans per finishing place). `character-cards`
gives each Uma's aptitudes, in the order turf, dirt, short, mile, medium,
long, then the four running styles.

Used by the /uma_races command. Run by .github/workflows/update-card-data.yml;
uses only the standard library.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://gametora.com"
MANIFEST = f"{BASE}/data/manifests/umamusume.json"
USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)"

GRADES = {100: "G1", 200: "G2", 300: "G3", 400: "OP", 700: "Pre-OP"}
SURFACES = {1: "turf", 2: "dirt"}
APTITUDE_KEYS = ["turf", "dirt", "short", "mile", "medium", "long"]


def distance_type(meters: int) -> str:
    """The game's distance groups: Short up to 1400m, Mile to 1800m, Medium to 2400m, Long beyond."""
    if meters <= 1400:
        return "short"
    if meters <= 1800:
        return "mile"
    if meters <= 2400:
        return "medium"
    return "long"


def _not_on_global(details: dict) -> bool:
    servers = details.get("unreleased_servers") or []
    if isinstance(servers, dict):
        servers = [name for name, value in servers.items() if value]
    return any(str(server).lower() in ("en", "global") for server in servers)


def first_place_fans(fan_tables: list[dict]) -> dict[int, int]:
    """{fan table id: fans for 1st place}."""
    result = {}
    for table in fan_tables:
        first = next((row["fans"] for row in table.get("fans", []) if row.get("order") == 1), None)
        if first is not None:
            result[int(table["id"])] = int(first)
    return result


def parse_races(instances: list[dict], fans: dict[int, int]) -> tuple[list[dict], int]:
    """Career races sorted by turn, and the fans for winning the debut."""
    races, debut_fans = [], 0
    for instance in instances:
        if instance.get("id") == "debut":
            debut_fans = fans.get(int(instance.get("fans_gain") or 0), 0)
        if instance.get("special_race"):
            continue
        details = instance["details"]
        if details.get("grade") not in GRADES or details.get("terrain") not in SURFACES:
            continue
        race = {
            "id": int(instance["instance"]),
            "name": details["name_en"],
            "grade": GRADES[details["grade"]],
            "surface": SURFACES[details["terrain"]],
            "distance": int(details["distance"]),
            "type": distance_type(int(details["distance"])),
            "year": int(instance["year"]),
            "month": int(instance["month"]),
            "half": int(instance["half"]),
            "fans": fans.get(int(instance["fans_gain"]), 0),
            "needed": int(instance.get("fans_needed") or 0),
        }
        if _not_on_global(details):
            race["jp_only"] = True
        races.append(race)
    races.sort(key=lambda r: (r["year"], r["month"], r["half"], -r["fans"], r["name"]))
    return races, debut_fans


def parse_umas(cards: list[dict]) -> list[dict]:
    """Trainable Umas with their surface and distance aptitudes."""
    umas = []
    for card in cards:
        aptitude = card.get("aptitude") or []
        if len(aptitude) < len(APTITUDE_KEYS):
            continue
        title = (card.get("title_en_gl") or "").strip("[]") or card.get("title") or ""
        uma = {
            "id": int(card["card_id"]),
            "name": card["name_en"],
            "title": title,
            "aptitude": dict(zip(APTITUDE_KEYS, aptitude)),
        }
        if not card.get("release_en"):
            uma["jp_only"] = True
        umas.append(uma)
    umas.sort(key=lambda u: (u["name"], u["id"]))
    return umas


def _get(url: str, *, attempts: int = 4) -> bytes:
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def build() -> dict:
    manifest = json.loads(_get(MANIFEST))

    def load(key: str):
        return json.loads(_get(f"{BASE}/data/umamusume/{key}.{manifest[key]}.json"))

    races, debut_fans = parse_races(load("race_instances"), first_place_fans(load("race-fans")))
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "GameTora (gametora.com), from the game's master data",
        "debut_fans": debut_fans,
        "races": races,
        "umas": parse_umas(load("character-cards")),
    }


def to_json(data: dict) -> str:
    """One race or Uma per line, so diffs stay readable and the timestamp has its own line."""
    def dump(value) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    head = ",\n".join(f"{dump(key)}:{dump(data[key])}" for key in ("generated", "source", "debut_fans"))
    lists = ",\n".join(f"{dump(key)}:[\n" + ",\n".join(dump(item) for item in data[key]) + "\n]" for key in ("races", "umas"))
    return "{\n" + head + ",\n" + lists + "\n}\n"


def check(data: dict) -> None:
    """Stops a broken download from replacing good data."""
    races, umas = data["races"], data["umas"]
    if len(races) < 300 or len(umas) < 150:
        raise SystemExit(f"Only {len(races)} races and {len(umas)} Umas; GameTora's data may have changed.")
    japan_cup = [r for r in races if r["name"] == "Japan Cup"]
    if not japan_cup or japan_cup[0]["fans"] < 10000 or japan_cup[0]["grade"] != "G1":
        raise SystemExit(f"The Japan Cup looks wrong: {japan_cup[:1]}")
    if not all(set(u["aptitude"].values()) <= set("SABCDEFG") for u in umas):
        raise SystemExit("Unexpected aptitude letters.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="race-data/races.json")
    args = parser.parse_args(argv)
    data = build()
    check(data)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(to_json(data), encoding="utf-8")
    print(f"Saved {len(data['races'])} races and {len(data['umas'])} Umas to {out} (debut win: {data['debut_fans']} fans)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
