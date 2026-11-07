import json

import pytest

from tools.build_race_data import check, distance_type, first_place_fans, parse_races, parse_umas, to_json

FAN_TABLES = [
    {"id": 5, "fans": [{"fans": 640, "order": 2}, {"fans": 1600, "order": 1}]},
    {"id": 36, "fans": [{"fans": 30000, "order": 1}]},
    {"id": 2, "fans": [{"fans": 600, "order": 1}]},
]


def instance(name, grade, terrain, distance, year, month, half, fans_gain, needed=0, **details):
    return {
        "details": {"name_en": name, "grade": grade, "terrain": terrain, "distance": distance, **details},
        "fans_gain": fans_gain, "fans_needed": needed, "half": half, "id": name, "instance": 100 + month,
        "month": month, "year": year,
    }


def test_distance_types_follow_the_game():
    assert [distance_type(m) for m in (1000, 1400, 1600, 1800, 2000, 2400, 2500, 3200)] == [
        "short", "short", "mile", "mile", "medium", "medium", "long", "long",
    ]


def test_first_place_fans():
    assert first_place_fans(FAN_TABLES) == {5: 1600, 36: 30000, 2: 600}


def test_parse_races_keeps_career_races_sorted_by_turn():
    instances = [
        instance("Japan Cup", 100, 1, 2400, 2, 11, 2, 36, needed=25000),
        {"id": "debut", "special_race": True, "fans_gain": 2, "details": {}},
        {"id": "final", "special_race": True, "details": {}},
        instance("Cosmos Sho", 400, 1, 1800, 1, 8, 1, 5, needed=350),
        instance("Odd", 999, 1, 1800, 1, 8, 1, 5),
        instance("Dirt race", 300, 2, 1200, 1, 8, 1, 5, unreleased_servers=["en"]),
    ]
    races, debut = parse_races(instances, first_place_fans(FAN_TABLES))
    assert debut == 600
    assert [r["name"] for r in races] == ["Cosmos Sho", "Dirt race", "Japan Cup"]
    assert races[2] == {
        "id": 111, "name": "Japan Cup", "grade": "G1", "surface": "turf", "distance": 2400, "type": "medium",
        "year": 2, "month": 11, "half": 2, "fans": 30000, "needed": 25000,
    }
    assert races[1]["surface"] == "dirt" and races[1]["jp_only"] is True
    assert "jp_only" not in races[0]


def test_parse_umas():
    cards = [
        {"card_id": 100101, "name_en": "Special Week", "title_en_gl": "[Special Dreamer]",
         "aptitude": ["A", "G", "F", "C", "A", "A", "G", "A", "A", "C"], "release_en": "2025-06-26"},
        {"card_id": 109901, "name_en": "New Girl", "title": "Fresh", "aptitude": ["B", "A", "A", "B", "C", "G", "A", "A", "B", "C"]},
        {"card_id": 1, "name_en": "Broken", "aptitude": []},
    ]
    umas = parse_umas(cards)
    assert umas[1] == {
        "id": 100101, "name": "Special Week", "title": "Special Dreamer",
        "aptitude": {"turf": "A", "dirt": "G", "short": "F", "mile": "C", "medium": "A", "long": "A"},
    }
    assert umas[0]["name"] == "New Girl" and umas[0]["jp_only"] is True and umas[0]["title"] == "Fresh"


def test_check_rejects_a_broken_download():
    with pytest.raises(SystemExit):
        check({"races": [], "umas": []})


def test_to_json_puts_the_timestamp_and_each_entry_on_its_own_line():
    data = {"generated": "now", "source": "x", "debut_fans": 600, "races": [{"id": 1}, {"id": 2}], "umas": [{"id": 3}]}
    text = to_json(data)
    assert json.loads(text) == data
    assert '"generated":"now",' in text.splitlines()
    assert '{"id":1},' in text.splitlines()
