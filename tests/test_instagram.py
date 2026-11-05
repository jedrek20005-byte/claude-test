from __future__ import annotations

import io
import json

import pytest
from aiohttp import web
from PIL import Image as PILImage

from umabot import instagram
from umabot.instagram import InstagramError, build_caption, publish_image, to_instagram_jpeg

from .conftest import make_image


def png(width: int, height: int, mode: str = "RGB") -> bytes:
    out = io.BytesIO()
    PILImage.new(mode, (width, height), "red").save(out, "PNG")
    return out.getvalue()


@pytest.mark.parametrize(
    ("size", "expected_ratio"),
    [((1000, 1000), 1.0), ((500, 2000), 0.8), ((4000, 500), 1.91), ((3000, 2000), 1.5)],
)
def test_jpeg_fits_instagram_shape(size, expected_ratio):
    result = PILImage.open(io.BytesIO(to_instagram_jpeg(png(*size))))
    assert result.format == "JPEG"
    assert max(result.size) <= instagram.MAX_SIDE
    assert result.width / result.height == pytest.approx(expected_ratio, abs=0.02)


def test_transparent_png_gets_a_white_background():
    result = PILImage.open(io.BytesIO(to_instagram_jpeg(png(100, 100, "RGBA")))).convert("RGB")
    assert result.getpixel((0, 0))[0] > 200  # not black


def test_garbage_is_rejected():
    with pytest.raises(OSError):
        to_instagram_jpeg(b"not a picture")


def test_caption_credits_the_artist_and_adds_hashtags():
    image = make_image(
        characters=("special_week_(umamusume)",), artists=("some_artist",), source_url="https://pixiv.net/artworks/1"
    )
    caption = build_caption(image, ("umamusume", "#fanart"))
    assert "Special Week" in caption
    assert "Art by some artist" in caption
    assert "https://pixiv.net/artworks/1" in caption
    assert "#umamusume #fanart #SpecialWeek" in caption
    assert len(caption) <= instagram.MAX_CAPTION


async def test_publish_creates_waits_and_publishes(fake_api, monkeypatch):
    calls = []

    async def create(request):
        calls.append(("create", dict(await request.post())))
        return web.json_response({"id": "container1"})

    async def status(request):
        calls.append(("status", request.match_info["id"]))
        return web.json_response({"status_code": "FINISHED" if len(calls) > 2 else "IN_PROGRESS"})

    async def publish(request):
        calls.append(("publish", dict(await request.post())))
        return web.json_response({"id": "media1"})

    api = await fake_api({
        "POST /v21.0/user1/media": create,
        "GET /v21.0/{id}": status,
        "POST /v21.0/user1/media_publish": publish,
    })
    monkeypatch.setattr(instagram, "API", f"{api.base_url}/v21.0")
    media_id = await publish_image(api.session, "user1", "tok", "https://x/y.jpg", "hi", poll_seconds=0)
    assert media_id == "media1"
    assert calls[0][1] == {"image_url": "https://x/y.jpg", "caption": "hi", "access_token": "tok"}
    assert calls[-1][1]["creation_id"] == "container1"


async def test_publish_reports_api_errors(fake_api, monkeypatch):
    async def create(request):
        return web.json_response({"error": {"message": "Invalid token", "code": 190}}, status=400)

    api = await fake_api({"POST /v21.0/user1/media": create})
    monkeypatch.setattr(instagram, "API", f"{api.base_url}/v21.0")
    with pytest.raises(InstagramError, match="Invalid token"):
        await publish_image(api.session, "user1", "bad", "https://x/y.jpg", "hi", poll_seconds=0)
