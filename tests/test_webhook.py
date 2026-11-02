from __future__ import annotations

import json
from datetime import datetime, timezone

import discord
import pytest
from aiohttp import web

from umabot.config import Config
from umabot.history import PostHistory
from umabot.posting import DAILY_TITLE
from umabot.sources.danbooru import DanbooruSource
from umabot.webhook import run_post

from .test_sources import DANBOORU_POSTS

WEBHOOK_ID, WEBHOOK_TOKEN = "123456789012345678", "T0ken-" * 12
WEBHOOK = f"https://discord.com/api/webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
BEFORE_NOON = datetime(2026, 11, 2, 11, 0, tzinfo=timezone.utc)
AFTER_NOON = datetime(2026, 11, 2, 12, 30, tzinfo=timezone.utc)


def make_config(tmp_path, **env):
    return Config.from_env(
        {
            "DISCORD_WEBHOOK_URL": WEBHOOK,
            "SOURCES": "danbooru",
            "POST_TIME": "12:00",
            "DAILY_MESSAGE": "Good morning!",
            "STATE_FILE": str(tmp_path / "history.json"),
            **env,
        },
        require_discord=False,
    )


@pytest.fixture
async def fake_discord(fake_api, monkeypatch):
    """Danbooru and Discord's webhook endpoint on one local server."""
    state = {"posts": None, "webhook_status": 204, "received": []}

    async def posts(request):
        default = [dict(DANBOORU_POSTS[0], file_url=f"{api.base_url}/img/a.png")]
        return web.json_response(default if state["posts"] is None else state["posts"])

    async def image(request):
        return web.Response(body=PNG, content_type="image/png")

    async def execute_webhook(request):
        if request.content_type == "application/json":
            payload, files = await request.json(), {}
        else:
            form = await request.post()
            payload = json.loads(form["payload_json"])
            files = {f.filename: f.file.read() for key, f in form.items() if key.startswith("files[")}
        state["received"].append({"ids": dict(request.match_info), "payload": payload, "files": files})
        if state["webhook_status"] == 404:
            return web.json_response({"message": "Unknown Webhook", "code": 10015}, status=404)
        return web.Response(status=204)

    api = await fake_api(
        {
            "/posts.json": posts,
            "/img/a.png": image,
            "POST /api/v10/webhooks/{id}/{token}": execute_webhook,
        }
    )
    monkeypatch.setattr(DanbooruSource, "default_base_url", api.base_url)
    monkeypatch.setattr(discord.http.Route, "BASE", f"{api.base_url}/api/v10")
    return state


async def test_waits_until_post_time(tmp_path, fake_discord):
    assert await run_post(make_config(tmp_path), clock=BEFORE_NOON) == 0
    assert fake_discord["received"] == []
    assert not (tmp_path / "history.json").exists()


async def test_posts_once_per_day(tmp_path, fake_discord):
    config = make_config(tmp_path)
    assert await run_post(config, clock=AFTER_NOON) == 0

    [request] = fake_discord["received"]
    assert request["ids"] == {"id": WEBHOOK_ID, "token": WEBHOOK_TOKEN}
    assert request["payload"]["content"] == "Good morning!"
    [embed] = request["payload"]["embeds"]
    assert embed["title"] == DAILY_TITLE
    assert embed["image"]["url"] == "attachment://umamusume_danbooru_7000001.png"
    assert request["files"] == {"umamusume_danbooru_7000001.png": PNG}

    history = PostHistory.load(config.state_file)
    assert history.last_daily == "2026-11-02"
    assert len(history) == 1

    # The hourly schedule runs again later that day: nothing more is posted.
    assert await run_post(config, clock=AFTER_NOON.replace(hour=20)) == 0
    assert len(fake_discord["received"]) == 1


async def test_post_now_ignores_the_schedule(tmp_path, fake_discord):
    config = make_config(tmp_path)
    assert await run_post(config, now=True, clock=BEFORE_NOON) == 0
    assert len(fake_discord["received"]) == 1
    # It counts as today's picture, so the scheduled run doesn't post a second one.
    assert await run_post(config, clock=AFTER_NOON) == 0
    assert len(fake_discord["received"]) == 1


async def test_deleted_webhook_fails_without_saving(tmp_path, fake_discord):
    fake_discord["webhook_status"] = 404
    assert await run_post(make_config(tmp_path), clock=AFTER_NOON) == 1
    assert not (tmp_path / "history.json").exists()


async def test_no_picture_found_fails(tmp_path, fake_discord):
    fake_discord["posts"] = []
    assert await run_post(make_config(tmp_path), clock=AFTER_NOON) == 1
    assert fake_discord["received"] == []


async def test_bad_or_missing_webhook_url(tmp_path, fake_discord):
    assert await run_post(make_config(tmp_path, DISCORD_WEBHOOK_URL="https://example.com/x"), clock=AFTER_NOON) == 1
    assert await run_post(make_config(tmp_path, DISCORD_WEBHOOK_URL=""), clock=AFTER_NOON) == 2


def test_webhook_urls_config():
    config = Config.from_env(
        {"DISCORD_WEBHOOK_URL": " https://a ", "DISCORD_WEBHOOK_URLS": "https://b, https://c"}, require_discord=False
    )
    assert config.webhook_urls == ("https://a", "https://b", "https://c")
    assert Config.from_env({}, require_discord=False).webhook_urls == ()
