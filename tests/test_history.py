import json

from umabot.history import PostHistory

from .conftest import make_image


def test_round_trip(tmp_path):
    path = tmp_path / "nested" / "state.json"
    history = PostHistory.load(path)
    assert len(history) == 0 and history.last_daily is None

    history.record(make_image("1", md5="abc"))
    history.last_daily = "2026-10-26"
    history.save()

    reloaded = PostHistory.load(path)
    assert reloaded.last_daily == "2026-10-26"
    assert reloaded.has_posted(make_image("1"))
    assert not reloaded.has_posted(make_image("2"))
    assert not path.with_name("state.json.tmp").exists()


def test_same_file_on_another_site_counts_as_posted(tmp_path):
    history = PostHistory(tmp_path / "s.json")
    history.record(make_image("1", source="danbooru", md5="abc"))
    assert history.has_posted(make_image("999", source="safebooru", md5="abc"))
    assert not history.has_posted(make_image("999", source="safebooru", md5=None))


def test_history_is_trimmed(tmp_path):
    history = PostHistory(tmp_path / "s.json", max_entries=3)
    for i in range(5):
        history.record(make_image(str(i), md5=f"m{i}"))
    assert len(history) == 3
    assert not history.has_posted(make_image("0", md5="m0"))
    assert history.has_posted(make_image("4"))


def test_corrupt_file_starts_fresh(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    assert len(PostHistory.load(path)) == 0

    path.write_text(json.dumps({"posted": ["junk", {"key": "danbooru:1"}, {"md5": "no-key"}]}))
    history = PostHistory.load(path)
    assert len(history) == 1 and history.has_posted(make_image("1"))
