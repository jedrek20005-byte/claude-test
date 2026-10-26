from __future__ import annotations

import random

from umabot.filters import ContentFilter
from umabot.models import Rating
from umabot.picker import Picker
from umabot.sources import SourceError
from umabot.sources.base import Source

from .conftest import make_image


class FakeSource(Source):
    default_base_url = "https://fake.test"

    def __init__(self, name, batches=None, error=None, resolve_error_ids=()):
        super().__init__(None, "x")
        self.name = self.display_name = name
        self.batches = batches or []
        self.error = error
        self.resolve_error_ids = set(resolve_error_ids)
        self.calls = 0

    async def fetch_page(self, page):
        self.calls += 1
        if self.error:
            raise self.error
        return self.batches.pop(0) if self.batches else []

    async def resolve(self, image):
        if image.post_id in self.resolve_error_ids:
            raise SourceError("gone")
        return image


class SetHistory:
    def __init__(self, keys=()):
        self.keys = set(keys)

    def has_posted(self, image):
        return image.key in self.keys


def picker(*sources, history=None, seed=0):
    return Picker(list(sources), ContentFilter(Rating.GENERAL), history or SetHistory(), rng=random.Random(seed))


async def test_falls_back_when_a_source_is_down():
    broken = FakeSource("broken", error=SourceError("HTTP 503"))
    crashing = FakeSource("crashing", error=KeyError("id"))
    working = FakeSource("working", batches=[[make_image("7", source="working")]])
    for seed in range(5):  # whatever order the sources are shuffled into
        working.batches = [[make_image("7", source="working")]]
        image = await picker(broken, crashing, working, seed=seed).pick()
        assert image is not None and image.key == "working:7"


async def test_skips_unsafe_and_already_posted():
    batch = [
        make_image("1", rating=Rating.EXPLICIT),
        make_image("2", tags=frozenset()),  # already posted
        make_image("3"),
    ]
    source = FakeSource("danbooru", batches=[batch])
    image = await picker(source, history=SetHistory({"danbooru:2"})).pick()
    assert image.post_id == "3"


async def test_tries_another_page_when_first_has_nothing_usable():
    source = FakeSource("danbooru", batches=[[make_image("1", rating=Rating.EXPLICIT)], [make_image("2")]])
    image = await picker(source).pick()
    assert image.post_id == "2"
    assert source.calls == 2


async def test_resolve_failures_try_next_candidate():
    source = FakeSource("danbooru", batches=[[make_image("1"), make_image("2")]], resolve_error_ids={"1"})
    for seed in range(5):
        source.batches = [[make_image("1"), make_image("2")]]
        assert (await picker(source, seed=seed).pick()).post_id == "2"


async def test_returns_none_when_nothing_found():
    assert await picker(FakeSource("empty"), FakeSource("down", error=SourceError("x"))).pick() is None
