"""Builds card-data/support-cards.json: every support card with its effects per limit break.

The numbers come from the Umamusume Wiki (umamusu.wiki), whose Lua modules
read the game's own master data. For each card, the wiki's
`{{#invoke:Game/Supports|bonusTable|ID}}` renders an effect table with one
column per limit break (the card's max level at LB0..LB4), and `supportLink`
gives its rarity, type and English name. umapyoi.net lists the card IDs.

Run by .github/workflows/update-card-data.yml; uses only the standard library.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WIKI_API = "https://umamusu.wiki/w/api.php"
CARGO_EXPORT = "https://umamusu.wiki/w/index.php"
UMAPYOI_SUPPORTS = "https://umapyoi.net/api/v1/support"
USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)"
BATCH_SIZE = 10
PAUSE_SECONDS = 1.0  # between wiki requests, to go easy on it

_ROW = re.compile(r"<tr><th>(.*?)</th>(.*?)</tr>", re.S)
_CELL = re.compile(r"<td>(.*?)</td>", re.S)
_TOOLTIP_TEXT = re.compile(r'<span class="text">.*?</span>', re.S)
_TAG = re.compile(r"<[^>]+>")
_LEVEL_HEADER = re.compile(r"<th>Lv(\d+)</th>")
_CELL_VALUE = re.compile(r"^(-|[\d.]+)?\s*(?:\(\+([\d.]+)\))?$")
_LINK = re.compile(r"Support Type ([^|\]]+?)\.png.*\[\[[^|\]]+\|((SSR|SR|R) (.+?))\]\]", re.S)
_DISPLAY = re.compile(r"^\[(.+)\]\s+(.+)$")


def _number(text: str) -> int | float:
    value = float(text)
    return int(value) if value.is_integer() else value


def parse_cell(text: str) -> int | float:
    """'-' -> 0, '15' -> 15, '(+5)' -> 5 and '10 (+5)' -> 15 (base plus unique effect)."""
    text = html.unescape(_TAG.sub("", text)).strip()
    match = _CELL_VALUE.match(text)
    if not match:
        raise ValueError(f"unexpected effect cell {text!r}")
    base, unique = match.groups()
    total = (0 if base in (None, "-") else _number(base)) + (_number(unique) if unique else 0)
    return _number(str(total))


def parse_bonus_table(markup: str) -> tuple[list[int], dict[str, list[int | float]]]:
    """Returns the column levels and {effect name: value per column} from a bonusTable."""
    levels = [int(level) for level in _LEVEL_HEADER.findall(markup)]
    effects = {}
    for header, cells in _ROW.findall(markup):
        if "<td>" not in cells:
            continue  # the header row
        name = html.unescape(_TAG.sub("", _TOOLTIP_TEXT.sub("", header))).strip()
        values = [parse_cell(cell) for cell in _CELL.findall(cells)]
        if len(values) != len(levels):
            raise ValueError(f"{name}: {len(values)} values for {len(levels)} levels")
        if any(values):
            effects[name] = values
    return levels, effects


def parse_support_link(markup: str) -> dict[str, str] | None:
    """'[[File:Support Type Guts.png]] [[Game:...|SSR [Title] Name]]' -> rarity, type, title, character."""
    match = _LINK.search(markup)
    if not match:
        return None
    card_type, _, rarity, rest = match.groups()
    display = _DISPLAY.match(rest.strip())
    title, character = display.groups() if display else ("", rest.strip())
    return {
        "rarity": rarity,
        "type": card_type.strip(),
        "title": html.unescape(title).strip(),
        "character": html.unescape(character).strip(),
    }


def _get(url: str, params: dict[str, str] | None = None, *, attempts: int = 4) -> bytes:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception as exc:  # network hiccups: back off and retry
            if attempt == attempts:
                raise
            print(f"  retrying after {exc!r}", file=sys.stderr)
            time.sleep(5 * attempt)
    raise AssertionError("unreachable")


def card_ids() -> list[int]:
    ids = {int(card["id"]) for card in json.loads(_get(UMAPYOI_SUPPORTS))}
    cargo = json.loads(_get(CARGO_EXPORT, {
        "title": "Special:CargoExport", "tables": "Game_Supports", "fields": "support_id",
        "format": "json", "limit": "5000",
    }))
    ids |= {int(row["support id"]) for row in cargo if row.get("support id")}
    return sorted(ids)


def fetch_batch(ids: list[int]) -> dict[int, dict]:
    text = "".join(
        f"@@{i}@@{{{{#invoke:Game/Supports|bonusTable|{i}}}}}{{{{#invoke:Game/Supports|supportLink|{i}}}}}"
        for i in ids
    )
    body = json.loads(_get(WIKI_API, {
        "format": "json", "action": "expandtemplates", "prop": "wikitext", "text": text,
    }))
    output = body["expandtemplates"]["wikitext"]
    parts = re.split(r"@@(\d+)@@", output)[1:]
    cards = {}
    for card_id, markup in zip(parts[::2], parts[1::2]):
        info = parse_support_link(markup)
        if info is None or "<table" not in markup:
            print(f"  skipping {card_id}: no wiki data", file=sys.stderr)
            continue
        levels, effects = parse_bonus_table(markup)
        cards[int(card_id)] = {"id": int(card_id), **info, "levels": levels, "effects": effects}
    return cards


def build() -> dict:
    ids = card_ids()
    print(f"{len(ids)} support card IDs")
    cards = {}
    for start in range(0, len(ids), BATCH_SIZE):
        batch = ids[start:start + BATCH_SIZE]
        cards.update(fetch_batch(batch))
        print(f"  {min(start + BATCH_SIZE, len(ids))}/{len(ids)}")
        time.sleep(PAUSE_SECONDS)
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "https://umamusu.wiki (game master data)",
        "limit_breaks": "values[i] is the effect at the card's max level for limit break i (0-4)",
        "cards": [cards[i] for i in sorted(cards)],
    }


def to_json(data: dict) -> str:
    """One card per line, so diffs stay readable and the timestamp sits on its own line."""
    head = [f'  "{key}": {json.dumps(value, ensure_ascii=False)},' for key, value in data.items() if key != "cards"]
    cards = [json.dumps(card, ensure_ascii=False, separators=(",", ":")) for card in data["cards"]]
    return "{\n" + "\n".join(head) + '\n  "cards": [\n    ' + ",\n    ".join(cards) + "\n  ]\n}\n"


def check(data: dict) -> None:
    cards = data["cards"]
    with_fans = [c for c in cards if c["effects"].get("Fan Bonus")]
    print(f"{len(cards)} cards, {len(with_fans)} with Fan Bonus")
    if len(cards) < 300 or len(with_fans) < 20:
        raise SystemExit("Too few cards parsed; not writing the file (the wiki's format may have changed).")
    for card in cards:
        if len(card["levels"]) != 5:
            raise SystemExit(f"Card {card['id']} has {len(card['levels'])} levels instead of 5.")
    best = sorted(with_fans, key=lambda c: c["effects"]["Fan Bonus"][4], reverse=True)[:10]
    for card in best:
        print(f"  {card['rarity']} [{card['title']}] {card['character']}: Fan Bonus {card['effects']['Fan Bonus']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="card-data/support-cards.json")
    args = parser.parse_args(argv)
    data = build()
    check(data)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(to_json(data), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
