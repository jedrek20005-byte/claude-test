from __future__ import annotations

from dataclasses import replace
from typing import Any
from urllib.parse import quote_plus

from yarl import URL

from ..formatting import normalize_source_url
from ..models import Image, Rating, normalize_tag
from .base import Source, SourceError, absolute_url


class ZerochanSource(Source):
    name = "zerochan"
    display_name = "Zerochan"
    default_base_url = "https://www.zerochan.net"

    def __init__(self, *args: Any, username: str, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # Zerochan asks API clients to identify themselves with their Zerochan username.
        self._headers = {"User-Agent": f"UmamusumeDailyBot - {username}"}

    def _url(self, path_and_query: str) -> URL:
        # Zerochan wants a bare "?json" flag, so build the URL by hand and keep it as-is.
        return URL(f"{self.base_url}/{path_and_query}", encoded=True)

    async def fetch_page(self, page: int) -> list[Image]:
        url = self._url(f"{quote_plus(self.tags)}?json&l={self.page_size}&p={page + 1}&s=id")
        return self.parse_listing(await self._get_json(url, headers=self._headers, missing_ok=True))

    def parse_listing(self, data: Any) -> list[Image]:
        items = (data.get("items") or []) if isinstance(data, dict) else []
        franchise = normalize_tag(self.tags)
        images = []
        for item in items:
            post_id, thumbnail = item.get("id"), absolute_url(item.get("thumbnail"))
            if post_id is None or not thumbnail:
                continue
            primary = item.get("tag")
            images.append(
                Image(
                    source=self.name,
                    post_id=str(post_id),
                    image_url=thumbnail,  # placeholder until resolve() finds the full-size file
                    page_url=f"{self.base_url}/{post_id}",
                    # Zerochan doesn't allow explicit uploads; the tag blacklist still applies.
                    rating=Rating.GENERAL,
                    tags=frozenset(normalize_tag(t) for t in (item.get("tags") or []) if isinstance(t, str)),
                    characters=(primary,) if primary and normalize_tag(primary) != franchise else (),
                    source_url=normalize_source_url(item.get("source")),
                )
            )
        return images

    async def resolve(self, image: Image) -> Image:
        data = await self._get_json(self._url(f"{image.post_id}?json"), headers=self._headers)
        if not isinstance(data, dict) or not data.get("full"):
            raise SourceError(f"Zerochan post {image.post_id} has no full-size image")
        tags = image.tags | {normalize_tag(t) for t in (data.get("tags") or []) if isinstance(t, str)}
        return replace(
            image,
            image_url=absolute_url(data["full"]),
            sample_url=absolute_url(data.get("large") or data.get("medium")),
            tags=frozenset(tags),
            source_url=normalize_source_url(data.get("source")) or image.source_url,
            md5=data.get("hash"),
        )
