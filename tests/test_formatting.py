from umabot.formatting import join_limited, normalize_source_url, pretty_artist, pretty_character


def test_pretty_character():
    assert pretty_character("special_week_(umamusume)") == "Special Week"
    assert pretty_character("t.m._opera_o_(umamusume)") == "T.M. Opera O"
    assert pretty_character("rice_shower_(make_up_vampire!)_(umamusume)") == "Rice Shower (Make Up Vampire!)"
    assert pretty_character("mejiro_mcqueen_(umamusume)") == "Mejiro Mcqueen"
    assert pretty_character("gold_ship_(uma_musume)") == "Gold Ship"
    assert pretty_character("Special Week") == "Special Week"


def test_pretty_artist():
    assert pretty_artist("some_artist") == "some artist"


def test_normalize_source_url():
    assert normalize_source_url(None) is None
    assert normalize_source_url("file.png") is None
    assert normalize_source_url("", pixiv_id=123) == "https://www.pixiv.net/artworks/123"
    assert (
        normalize_source_url("https://i.pximg.net/img-original/img/2024/01/01/00/00/00/98765_p1.jpg")
        == "https://www.pixiv.net/artworks/98765"
    )
    assert normalize_source_url("https://x.com/a/status/1") == "https://x.com/a/status/1"


def test_join_limited():
    assert join_limited(["a", "b"]) == "a, b"
    assert join_limited(["a", "b", "c", "d", "e", "f"], limit=4) == "a, b, c, d +2 more"
