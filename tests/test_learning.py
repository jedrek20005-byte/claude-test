from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from umabot.learning import Learning, features_for, reward

from .conftest import make_image

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def learned(tmp_path, results):
    """A Learning with posts of (features, views) already measured."""
    learning = Learning(tmp_path / "l.json")
    for number, (features, views) in enumerate(results):
        learning.record_post(str(number), features, T0)
        learning.record_result(learning.posts[-1], views, T0 + timedelta(days=3))
    return learning


def test_features_group_characters_artist_and_source():
    image = make_image(characters=("special_week_(umamusume)",), artists=("bob",))
    assert features_for(image) == {
        "char": ["char:special week"], "artist": ["artist:bob"], "source": ["source:danbooru"],
    }


def test_prefers_what_got_more_views(tmp_path):
    good, bad = make_image("1", characters=("tokai_teio_(umamusume)",)), make_image("2", characters=("oguri_cap_(umamusume)",))
    learning = learned(tmp_path, [(["char:tokai teio"], 5000)] * 8 + [(["char:oguri cap"], 50)] * 8)
    rng = random.Random(1)
    wins = sum(learning.choose([good, bad], rng) is good for _ in range(200))
    assert wins > 180


def test_still_explores_unknown_features(tmp_path):
    known, unknown = make_image("1", characters=("tokai_teio_(umamusume)",)), make_image("2", characters=("mejiro_mcqueen_(umamusume)",))
    learning = learned(tmp_path, [(["char:tokai teio"], 1000)] * 3 + [(["char:other"], 100)] * 3)
    picks = {learning.choose([known, unknown], random.Random(i)).post_id for i in range(100)}
    assert picks == {"1", "2"}


def test_posts_in_the_hours_that_did_best(tmp_path):
    results = [([f"hour:{h}"], 3000 if h in (18, 19) else 100) for h in range(24) for _ in range(6)]
    learning = learned(tmp_path, results)
    chosen = [learning.best_hours(f"2026-12-{day:02d}", 2) for day in range(1, 11)]
    assert sum(h == {18, 19} for h in chosen) >= 8


def test_hours_are_stable_within_a_day_and_capped(tmp_path):
    learning = Learning(tmp_path / "l.json")
    assert learning.best_hours("2026-12-01", 3) == learning.best_hours("2026-12-01", 3)
    hour = next(iter(learning.best_hours("2026-12-01", 2)))
    at = datetime(2026, 12, 1, hour, 30, tzinfo=timezone.utc)
    assert learning.should_post(at, 2)
    learning.record_post("a", [], at)
    learning.record_post("b", [], at)
    assert not learning.should_post(at, 2)


def test_measuring_waits_two_days_and_unmeasurable_posts_are_dropped_eventually(tmp_path):
    learning = Learning(tmp_path / "l.json")
    learning.record_post("a", ["source:danbooru"], T0)
    assert learning.due_for_measuring(T0 + timedelta(hours=47)) == []
    post = learning.due_for_measuring(T0 + timedelta(hours=49))[0]
    learning.record_result(post, None, T0 + timedelta(hours=49))
    assert learning.due_for_measuring(T0 + timedelta(days=3)) == [post]  # retried
    learning.record_result(post, None, T0 + timedelta(days=15))
    assert learning.due_for_measuring(T0 + timedelta(days=16)) == []
    assert learning.measured_posts == 0


def test_save_and_load_roundtrip(tmp_path):
    learning = learned(tmp_path, [(["char:x"], 100), (["char:x"], 300)])
    learning.save()
    again = Learning.load(tmp_path / "l.json")
    assert again.measured_posts == 2
    assert again.arms["char:x"].mean == learning.arms["char:x"].mean
    assert reward(100) > reward(10)
