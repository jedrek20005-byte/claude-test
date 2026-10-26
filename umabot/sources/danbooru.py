from __future__ import annotations

from typing import Any

from ..formatting import normalize_source_url
from ..models import Image, Rating
from .base import Source, to_int


class DanbooruSource(Source):
    name = "danbooru"
    display_name = "Danbooru"
    default_base_url = "https://danbooru.donmai.us"

    _RATINGS = {
        "g": Rating.GENERAL,
        "s": Rating.SENSITIVE,
        "q": Rating.QUESTIONABLE,
        "e": Rating.EXPLICIT,
    }

    def __init__(self, *args: Any, login: str | None = None, api_key: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._auth = {"login": login, "api_key": api_key} if login and api_key else {}

    async def fetch_page(self, page: int) -> list[Image]:
        # Anonymous searches are limited to two tags: the franchise tag plus the rating.
        rating = "rating:g,s" if self.allow_sensitive else "rating:g"
        params = {"tags": f"{self.tags} {rating}", "limit": self.page_size, "page": page + 1, **self._auth}
        return self.parse(await self._get_json(f"{self.base_url}/posts.json", params))

    def parse(self, data: Any) -> list[Image]:
        images = []
        for post in data if isinstance(data, list) else []:
            post_id, file_url = post.get("id"), post.get("file_url")
            # file_url is missing for posts anonymous users can't see.
            if post_id is None or not file_url or post.get("is_deleted") or post.get("is_banned"):
                continue
            images.append(
                Image(
                    source=self.name,
                    post_id=str(post_id),
                    image_url=file_url,
                    sample_url=post.get("large_file_url"),
                    page_url=f"{self.base_url}/posts/{post_id}",
                    rating=self._RATINGS.get(post.get("rating"), Rating.UNKNOWN),
                    tags=frozenset(post.get("tag_string", "").split()),
                    artists=tuple(post.get("tag_string_artist", "").split()),
                    characters=tuple(post.get("tag_string_character", "").split()),
                    source_url=normalize_source_url(post.get("source"), post.get("pixiv_id")),
                    score=to_int(post.get("score")),
                    md5=post.get("md5"),
                )
            )
        return images
