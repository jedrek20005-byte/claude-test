from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from umabot.models import Image, Rating


def make_image(post_id: str = "1", source: str = "danbooru", **overrides) -> Image:
    fields = dict(
        source=source,
        post_id=post_id,
        image_url=f"https://example.test/{source}/{post_id}.png",
        page_url=f"https://example.test/posts/{post_id}",
        rating=Rating.GENERAL,
        tags=frozenset({"umamusume", "1girl", "horse_girl"}),
    )
    fields.update(overrides)
    return Image(**fields)


def _as_async(handler):
    if inspect.iscoroutinefunction(handler):
        return handler

    async def wrapper(request):
        return handler(request)

    return wrapper


@dataclass
class FakeApi:
    """A local HTTP server that records requests and replies with canned handlers."""

    base_url: str
    session: aiohttp.ClientSession
    requests: list[web.Request] = field(default_factory=list)


@pytest.fixture
async def fake_api() -> AsyncIterator[Callable[..., FakeApi]]:
    servers: list[TestServer] = []
    sessions: list[aiohttp.ClientSession] = []

    async def start(routes: dict[str, Callable[[web.Request], web.StreamResponse]]) -> FakeApi:
        api: FakeApi

        @web.middleware
        async def record(request: web.Request, handler):
            api.requests.append(request)
            return await handler(request)

        app = web.Application(middlewares=[record])
        for path, handler in routes.items():
            app.router.add_get(path, _as_async(handler))
        server = TestServer(app)
        await server.start_server()
        servers.append(server)
        session = aiohttp.ClientSession()
        sessions.append(session)
        api = FakeApi(str(server.make_url("")).rstrip("/"), session)
        return api

    yield start
    for session in sessions:
        await session.close()
    for server in servers:
        await server.close()
