from __future__ import annotations

from typing import Any

from ..formatting import normalize_source_url
from ..models import Image, Rating
from .base import Source, absolute_url, guess_characters, to_int


class KonachanSource(Source):
    """konachan.net, the SFW-only mirror of Konachan (Moebooru API)."""

    name = "konachan"
    display_name = "Konachan"
    default_base_url = "https://konachan.net"

    # Moebooru has only three ratings; its "safe" is the lowest, so treat it as
    # general and let the tag blacklist catch borderline posts.
    _RATINGS = {"s": Rating.GENERAL, "q": Rating.QUESTIONABLE, "e": Rating.EXPLICIT}

    async def fetch_page(self, page: int) -> list[Image]:
        params = {"tags": self.tags, "limit": self.page_size, "page": page + 1}
        return self.parse(await self._get_json(f"{self.base_url}/post.json", params))

    def parse(self, data: Any) -> list[Image]:
        images = []
        for post in data if isinstance(data, list) else []:
            post_id, file_url = post.get("id"), absolute_url(post.get("file_url"))
            if post_id is None or not file_url or post.get("status") == "deleted":
                continue
            tags = frozenset(str(post.get("tags", "")).split())
            images.append(
                Image(
                    source=self.name,
                    post_id=str(post_id),
                    image_url=file_url,
                    sample_url=absolute_url(post.get("sample_url")),
                    page_url=f"{self.base_url}/post/show/{post_id}",
                    rating=self._RATINGS.get(post.get("rating"), Rating.UNKNOWN),
                    tags=tags,
                    characters=guess_characters(tags),
                    source_url=normalize_source_url(post.get("source")),
                    score=to_int(post.get("score")),
                    md5=post.get("md5"),
                )
            )
        return images
