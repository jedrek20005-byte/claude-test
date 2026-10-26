from __future__ import annotations

import random

import pytest
from aiohttp import web

from umabot.models import Rating
from umabot.sources import SourceError
from umabot.sources.base import Source
from umabot.sources.danbooru import DanbooruSource
from umabot.sources.gelbooru import GelbooruSource, SafebooruSource
from umabot.sources.konachan import KonachanSource
from umabot.sources.zerochan import ZerochanSource

DANBOORU_POSTS = [
    {
        "id": 7000001,
        "rating": "g",
        "score": 42,
        "md5": "aaa111",
        "file_url": "https://cdn.donmai.us/original/aa/a1/aaa111.png",
        "large_file_url": "https://cdn.donmai.us/sample/aa/a1/sample-aaa111.jpg",
        "tag_string": "1girl special_week_(umamusume) umamusume horse_ears smile",
        "tag_string_artist": "some_artist",
        "tag_string_character": "special_week_(umamusume)",
        "source": "https://i.pximg.net/img-original/img/2024/01/01/00/00/00/111222333_p0.png",
        "pixiv_id": 111222333,
        "is_deleted": False,
        "is_banned": False,
    },
    {
        "id": 7000002,
        "rating": "s",
        "score": 3,
        "md5": "bbb222",
        "file_url": "https://cdn.donmai.us/original/bb/b2/bbb222.jpg",
        "tag_string": "umamusume swimsuit",
        "tag_string_artist": "",
        "tag_string_character": "",
        "source": "",
        "pixiv_id": None,
    },
    # Hidden from anonymous users: no file_url.
    {"id": 7000003, "rating": "g", "tag_string": "umamusume"},
    {"id": 7000004, "rating": "g", "file_url": "https://cdn.donmai.us/x.jpg", "is_deleted": True},
]


def test_danbooru_parse():
    images = DanbooruSource(None, "umamusume").parse(DANBOORU_POSTS)
    assert [i.post_id for i in images] == ["7000001", "7000002"]
    first, second = images
    assert first.rating is Rating.GENERAL and second.rating is Rating.SENSITIVE
    assert first.page_url == "https://danbooru.donmai.us/posts/7000001"
    assert first.sample_url.endswith("sample-aaa111.jpg")
    assert first.characters == ("special_week_(umamusume)",)
    assert first.artists == ("some_artist",)
    assert first.source_url == "https://www.pixiv.net/artworks/111222333"
    assert first.score == 42 and first.md5 == "aaa111"
    assert "smile" in first.tags
    assert second.source_url is None


def test_danbooru_parse_ignores_error_payload():
    assert DanbooruSource(None, "umamusume").parse({"success": False, "message": "nope"}) == []


async def test_danbooru_fetch_sends_rating_and_page(fake_api):
    async def posts(request):
        return web.json_response(DANBOORU_POSTS[:1])

    api = await fake_api({"/posts.json": posts})
    source = DanbooruSource(api.session, "umamusume", base_url=api.base_url, login="me", api_key="k")
    images = await source.fetch_page(2)
    assert len(images) == 1
    query = api.requests[0].query
    assert query["tags"] == "umamusume rating:g"
    assert query["page"] == "3"
    assert query["limit"] == "100"
    assert query["login"] == "me" and query["api_key"] == "k"


async def test_danbooru_allow_sensitive_widens_rating(fake_api):
    api = await fake_api({"/posts.json": lambda r: web.json_response([])})
    source = DanbooruSource(api.session, "umamusume", base_url=api.base_url, allow_sensitive=True)
    await source.fetch_page(0)
    assert api.requests[0].query["tags"] == "umamusume rating:g,s"
    assert "login" not in api.requests[0].query


async def test_http_errors_raise_source_error(fake_api):
    api = await fake_api({"/posts.json": lambda r: web.json_response({"message": "rate limited"}, status=429)})
    source = DanbooruSource(api.session, "umamusume", base_url=api.base_url)
    with pytest.raises(SourceError, match="429"):
        await source.fetch_page(0)


async def test_invalid_json_raises_source_error(fake_api):
    api = await fake_api({"/posts.json": lambda r: web.Response(text="<html>Just a moment...</html>")})
    source = DanbooruSource(api.session, "umamusume", base_url=api.base_url)
    with pytest.raises(SourceError, match="invalid JSON"):
        await source.fetch_page(0)


async def test_connection_errors_raise_source_error(fake_api):
    api = await fake_api({})
    source = DanbooruSource(api.session, "umamusume", base_url="http://127.0.0.1:9")
    with pytest.raises(SourceError, match="request failed"):
        await source.fetch_page(0)


SAFEBOORU_POSTS = [
    {
        "id": 5000001,
        "directory": "4321",
        "image": "abcdef.png",
        "hash": "ccc333",
        "rating": "general",
        "sample": True,
        "score": None,
        "tags": "1girl gold_ship_(umamusume) silence_suzuka_(umamusume) umamusume",
        "source": "https://twitter.com/someone/status/1",
    },
    {
        "id": 5000002,
        "directory": "4321",
        "image": "zzz.jpg",
        "file_url": "https://safebooru.org/images/4321/zzz.jpg",
        "rating": "questionable",
        "tags": "umamusume",
    },
]


def test_safebooru_parse_builds_urls_from_directory():
    images = SafebooruSource(None, "umamusume").parse(SAFEBOORU_POSTS)
    first, second = images
    assert first.image_url == "https://safebooru.org/images/4321/abcdef.png"
    assert first.sample_url == "https://safebooru.org/samples/4321/sample_abcdef.jpg"
    assert first.page_url == "https://safebooru.org/index.php?page=post&s=view&id=5000001"
    assert first.characters == ("gold_ship_(umamusume)", "silence_suzuka_(umamusume)")
    assert first.md5 == "ccc333" and first.score is None
    assert first.rating is Rating.GENERAL
    assert second.image_url == "https://safebooru.org/images/4321/zzz.jpg"
    assert second.rating is Rating.QUESTIONABLE


async def test_safebooru_fetch_handles_empty_body(fake_api):
    api = await fake_api({"/index.php": lambda r: web.Response(text="")})
    source = SafebooruSource(api.session, "umamusume", base_url=api.base_url)
    assert await source.fetch_page(4) == []
    query = api.requests[0].query
    assert query["page"] == "dapi" and query["s"] == "post" and query["q"] == "index"
    assert query["json"] == "1" and query["pid"] == "4" and query["tags"] == "umamusume"


GELBOORU_RESPONSE = {
    "@attributes": {"limit": 100, "offset": 0, "count": 1},
    "post": [
        {
            "id": 9000001,
            "md5": "ddd444",
            "rating": "general",
            "score": 12,
            "file_url": "https://img3.gelbooru.com/images/dd/d4/ddd444.jpg",
            "sample_url": "",
            "sample": 0,
            "tags": "umamusume tokai_teio_(umamusume)",
            "source": "",
        }
    ],
}


async def test_gelbooru_fetch_sends_credentials_and_rating(fake_api):
    api = await fake_api({"/index.php": lambda r: web.json_response(GELBOORU_RESPONSE)})
    source = GelbooruSource(api.session, "umamusume", base_url=api.base_url, user_id="42", api_key="secret")
    [image] = await source.fetch_page(0)
    query = api.requests[0].query
    assert query["tags"] == "umamusume rating:general"
    assert query["user_id"] == "42" and query["api_key"] == "secret"
    assert image.image_url == "https://img3.gelbooru.com/images/dd/d4/ddd444.jpg"
    assert image.sample_url is None
    assert image.characters == ("tokai_teio_(umamusume)",)
    assert image.score == 12


def test_gelbooru_parse_without_posts():
    assert GelbooruSource(None, "x", user_id="1", api_key="k").parse({"@attributes": {"count": 0}}) == []


KONACHAN_POSTS = [
    {
        "id": 360001,
        "tags": "animal_ears uma_musume_pretty_derby special_week_(umamusume)",
        "rating": "s",
        "score": 25,
        "md5": "eee555",
        "file_url": "//konachan.net/image/eee555/Konachan.net%20-%20360001.png",
        "sample_url": "https://konachan.net/sample/eee555/sample.jpg",
        "source": "",
        "status": "active",
    },
    {"id": 360002, "tags": "x", "rating": "s", "file_url": "https://k/x.png", "status": "deleted"},
]


async def test_konachan_fetch_and_parse(fake_api):
    api = await fake_api({"/post.json": lambda r: web.json_response(KONACHAN_POSTS)})
    source = KonachanSource(api.session, "uma_musume_pretty_derby", base_url=api.base_url)
    [image] = await source.fetch_page(0)
    assert api.requests[0].query["page"] == "1"
    assert api.requests[0].query["tags"] == "uma_musume_pretty_derby"
    assert image.image_url.startswith("https://konachan.net/image/")
    assert image.page_url == f"{api.base_url}/post/show/360001"
    assert image.rating is Rating.GENERAL
    assert image.characters == ("special_week_(umamusume)",)


ZEROCHAN_LISTING = {
    "items": [
        {
            "id": 4100001,
            "width": 1200,
            "height": 1600,
            "thumbnail": "https://s1.zerochan.net/Special.Week.600.4100001.jpg",
            "source": "",
            "tag": "Special Week",
            "tags": ["Special Week", "Uma Musume: Pretty Derby", "Horse Girl"],
        },
        {
            "id": 4100002,
            "thumbnail": "https://s1.zerochan.net/x.600.4100002.jpg",
            "tag": "Uma Musume: Pretty Derby",
            "tags": ["Uma Musume: Pretty Derby"],
        },
    ]
}

ZEROCHAN_POST = {
    "id": 4100001,
    "large": "https://s1.zerochan.net/Special.Week.600.4100001.jpg",
    "full": "https://static.zerochan.net/Special.Week.full.4100001.png",
    "hash": "fff666",
    "source": "https://www.pixiv.net/artworks/555",
    "tags": ["Special Week", "Uma Musume: Pretty Derby", "Swimsuit"],
}


async def test_zerochan_listing_and_resolve(fake_api):
    seen_urls = []

    async def handler(request):
        seen_urls.append(request.raw_path)
        return web.json_response(ZEROCHAN_POST if request.match_info["name"].isdigit() else ZEROCHAN_LISTING)

    api = await fake_api({"/{name}": handler})
    source = ZerochanSource(api.session, "Uma Musume: Pretty Derby", base_url=api.base_url, username="trainer")

    first, second = await source.fetch_page(1)
    assert seen_urls[0] == "/Uma+Musume%3A+Pretty+Derby?json&l=100&p=2&s=id"
    assert api.requests[0].headers["User-Agent"] == "UmamusumeDailyBot - trainer"
    assert first.characters == ("Special Week",)
    assert second.characters == ()  # primary tag is the franchise itself
    assert "horse_girl" in first.tags

    resolved = await source.resolve(first)
    assert seen_urls[1] == "/4100001?json"
    assert resolved.image_url == "https://static.zerochan.net/Special.Week.full.4100001.png"
    assert resolved.md5 == "fff666"
    assert resolved.source_url == "https://www.pixiv.net/artworks/555"
    assert "swimsuit" in resolved.tags  # tags from the full post are merged in


async def test_zerochan_missing_tag_is_empty(fake_api):
    api = await fake_api({})
    source = ZerochanSource(api.session, "Nope", base_url=api.base_url, username="trainer")
    assert await source.fetch_page(0) == []


async def test_zerochan_resolve_without_full_image_fails(fake_api):
    api = await fake_api({"/1": lambda r: web.json_response({"id": 1})})
    source = ZerochanSource(api.session, "x", base_url=api.base_url, username="trainer")
    [image] = source.parse_listing({"items": [{"id": 1, "thumbnail": "https://s/x.jpg"}]})
    with pytest.raises(SourceError):
        await source.resolve(image)


class PagedSource(Source):
    name = "paged"
    display_name = "Paged"
    default_base_url = "https://paged.test"

    def __init__(self, pages_with_posts: int):
        super().__init__(None, "x", max_pages=30)
        self.pages_with_posts = pages_with_posts
        self.requested: list[int] = []

    async def fetch_page(self, page):
        self.requested.append(page)
        return [page] if page < self.pages_with_posts else []


async def test_random_batch_learns_page_count():
    source = PagedSource(pages_with_posts=3)
    rng = random.Random(1)
    for _ in range(200):
        assert await source.random_batch(rng)  # never comes back empty while page 0 has posts
        assert source._page_limit >= 3  # never forgets real pages
    assert source._page_limit == 3
    # Once the limit is learned, no more empty pages are requested.
    source.requested.clear()
    for _ in range(20):
        await source.random_batch(rng)
    assert all(page < 3 for page in source.requested)


async def test_random_batch_with_no_results_at_all():
    source = PagedSource(pages_with_posts=0)
    assert await source.random_batch(random.Random(2)) == []
    assert source.requested[-1] == 0  # walked all the way down before giving up
    assert source._page_limit < 30
