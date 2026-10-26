from umabot.config import DEFAULT_BLACKLIST
from umabot.filters import ContentFilter
from umabot.models import Rating

from .conftest import make_image


def test_rating_limit():
    strict = ContentFilter(Rating.GENERAL)
    relaxed = ContentFilter(Rating.SENSITIVE)
    assert strict.allows(make_image(rating=Rating.GENERAL))
    assert not strict.allows(make_image(rating=Rating.SENSITIVE))
    assert relaxed.allows(make_image(rating=Rating.SENSITIVE))
    for rating in (Rating.QUESTIONABLE, Rating.EXPLICIT, Rating.UNKNOWN):
        assert not relaxed.allows(make_image(rating=rating))


def test_blacklist_exact_and_wildcard():
    f = ContentFilter(blacklist=["Swimsuit", "*_bikini", " "])
    assert f.rejection_reason(make_image(tags=frozenset({"swimsuit"}))) == "blacklisted tag swimsuit"
    assert not f.allows(make_image(tags=frozenset({"striped_bikini"})))
    assert f.allows(make_image(tags=frozenset({"bikini_top_removed_from_list", "smile"})))
    # Zerochan-style tags are normalised before matching.
    assert not f.allows(make_image(tags=frozenset({"Swimsuit"})))


def test_default_blacklist_catches_common_tags():
    f = ContentFilter(blacklist=DEFAULT_BLACKLIST)
    for tag in ("cleavage", "school_swimsuit", "micro_bikini", "underwear", "loli"):
        assert not f.allows(make_image(tags=frozenset({"umamusume", tag}))), tag
    assert f.allows(make_image(tags=frozenset({"umamusume", "racing", "smile", "tracen_school_uniform"})))


def test_file_types():
    f = ContentFilter()
    assert f.allows(make_image(image_url="https://x.test/a.JPG"))
    assert f.allows(make_image(image_url="https://x.test/a.webp?download=1"))
    assert f.rejection_reason(make_image(image_url="https://x.test/a.mp4")) == "file type .mp4"
    assert not f.allows(make_image(image_url="https://x.test/ugoira.zip"))
    assert not f.allows(make_image(image_url="https://x.test/no-extension"))


def test_min_score():
    f = ContentFilter(min_score=5)
    assert not f.allows(make_image(score=4))
    assert f.allows(make_image(score=5))
    assert f.allows(make_image(score=None))  # sites without scores aren't penalised
