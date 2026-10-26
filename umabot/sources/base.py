"""Shared plumbing for the image sources."""

from __future__ import annotations

import asyncio
import json
import random
from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
from typing import Any, ClassVar

import aiohttp
from yarl import URL

from ..formatting import is_uma_character_tag
from ..models import Image


class SourceError(Exception):
    """A source could not be queried (network error, bad status, bad JSON...)."""


def absolute_url(url: str | None) -> str | None:
    if not url:
        return None
    return "https:" + url if url.startswith("//") else url


def to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def guess_characters(tags: Iterable[str]) -> tuple[str, ...]:
    """For sites without tag categories, which still use 'name_(umamusume)' character tags."""
    return tuple(sorted(tag for tag in tags if is_uma_character_tag(tag)))


class Source(ABC):
    name: ClassVar[str]
    display_name: ClassVar[str]
    default_base_url: ClassVar[str]

    def __init__(
        self,
        session: aiohttp.ClientSession,
        tags: str,
        *,
        base_url: str | None = None,
        page_size: int = 100,
        max_pages: int = 30,
        allow_sensitive: bool = False,
    ) -> None:
        self.session = session
        self.tags = tags
        self.base_url = (base_url or self.default_base_url).rstrip("/")
        self.page_size = page_size
        self.allow_sensitive = allow_sensitive
        self._page_limit = max(1, max_pages)

    @abstractmethod
    async def fetch_page(self, page: int) -> list[Image]:
        """Return the posts on a 0-based results page (empty past the last page)."""

    async def resolve(self, image: Image) -> Image:
        """Fill in details the listing endpoint leaves out (only Zerochan needs this)."""
        return image

    async def random_batch(self, rng: random.Random) -> list[Image]:
        """Fetch a random results page, learning how many pages actually exist."""
        page = rng.randrange(self._page_limit)
        posts = await self.fetch_page(page)
        while not posts and page > 0:
            # Every later page is empty too, so stop drawing from them.
            self._page_limit = page
            page = rng.randrange(page)
            posts = await self.fetch_page(page)
        return posts

    async def _get_json(
        self,
        url: str | URL,
        params: Mapping[str, str | int] | None = None,
        *,
        headers: Mapping[str, str] | None = None,
        missing_ok: bool = False,
    ) -> Any:
        try:
            async with self.session.get(url, params=params, headers=headers) as resp:
                if missing_ok and resp.status == 404:
                    return None
                if resp.status != 200:
                    raise SourceError(f"{self.display_name} returned HTTP {resp.status}")
                body = await resp.read()
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            detail = getattr(exc, "message", None) or str(exc) or "timed out"
            raise SourceError(f"{self.display_name} request failed ({type(exc).__name__}: {detail})") from exc
        text = body.decode("utf-8", errors="replace").strip()
        if not text:
            return None
        try:
            # strict=False: some sites (Zerochan) emit raw control characters in strings.
            return json.loads(text, strict=False)
        except ValueError as exc:
            raise SourceError(f"{self.display_name} returned invalid JSON") from exc
