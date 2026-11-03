import pytest

from tools.build_card_data import parse_bonus_table, parse_cell, parse_support_link

# Trimmed from the wiki's real {{#invoke:Game/Supports|bonusTable|30001}} output.
BONUS_TABLE = (
    '<table class="wikitable uma-theme"><caption>Bonuses</caption><tr><th>Effect</th><th>Lv30</th><th>Lv35</th>'
    "<th>Lv40</th><th>Lv45</th><th>Lv50</th></tr>"
    '<tr><th><span class="tooltip">Friendship Bonus<span class="text">Increases the effectiveness of Friendship '
    "Training</span></span></th><td>15</td><td>16</td><td>18</td><td>20</td><td>20</td></tr>"
    '<tr><th><span class="tooltip">Guts Bonus<span class="text">Increases Guts gain</span></span></th>'
    "<td>(+1)</td><td>(+1)</td><td>(+1)</td><td>(+1)</td><td>(+1)</td></tr>"
    '<tr><th><span class="tooltip">Fan Bonus<span class="text">Increases fans gained</span></span></th>'
    "<td>-</td><td>-</td><td>-</td><td>10</td><td>15 (+5)</td></tr>"
    '<tr><th><span class="tooltip">Hint Levels<span class="text">x</span></span></th>'
    "<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>"
    "</table>"
)

SUPPORT_LINK = (
    "<span>[[File:Support Card 30001 Icon.png|24px]] [[File:Support Type Guts.png|24px]] "
    "[[Game:SSR Special Week (The Brightest Star in Japan!)|SSR [The Brightest Star in Japan!] Special Week]]</span>"
)


@pytest.mark.parametrize(
    "cell, value",
    [("-", 0), ("15", 15), ("(+5)", 5), ("10 (+5)", 15), ("80 (+20)", 100), ("2.5", 2.5), (" 7 ", 7)],
)
def test_parse_cell(cell, value):
    assert parse_cell(cell) == value


def test_parse_cell_rejects_surprises():
    with pytest.raises(ValueError):
        parse_cell("about 5")


def test_parse_bonus_table():
    levels, effects = parse_bonus_table(BONUS_TABLE)
    assert levels == [30, 35, 40, 45, 50]
    assert effects == {
        "Friendship Bonus": [15, 16, 18, 20, 20],
        "Guts Bonus": [1, 1, 1, 1, 1],
        "Fan Bonus": [0, 0, 0, 10, 20],
    }  # "Hint Levels" is all zero, so it's left out


def test_parse_bonus_table_rejects_ragged_rows():
    broken = BONUS_TABLE.replace("<td>16</td>", "")
    with pytest.raises(ValueError):
        parse_bonus_table(broken)


def test_parse_support_link():
    assert parse_support_link(SUPPORT_LINK) == {
        "rarity": "SSR",
        "type": "Guts",
        "title": "The Brightest Star in Japan!",
        "character": "Special Week",
    }
    tricky = SUPPORT_LINK.replace("The Brightest Star in Japan!", "Run(my)way").replace("Special Week", "Gold City")
    assert parse_support_link(tricky)["title"] == "Run(my)way"
    assert parse_support_link("<strong class=\"error\">Lua error</strong>") is None


def test_to_json_is_valid_and_line_per_card():
    import json

    from tools.build_card_data import to_json

    data = {"generated": "2026-11-04T00:00:00+00:00", "source": "wiki", "cards": [{"id": 1}, {"id": 2}]}
    text = to_json(data)
    assert json.loads(text) == data
    lines = text.splitlines()
    assert any(line.strip().startswith('"generated"') for line in lines)
    assert sum('"id"' in line for line in lines) == 2
