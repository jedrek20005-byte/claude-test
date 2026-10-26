"""Gelbooru and Safebooru, which run the same software and share an API."""

from __future__ import annotations

from typing import Any

from ..formatting import normalize_source_url
from ..models import Image, Rating
from .base import Source, absolute_url, guess_characters, to_int


class _GelbooruLikeSource(Source):
    _RATINGS = {
        "general": Rating.GENERAL,
        "safe": Rating.GENERAL,  # pre-2022 three-tier rating scheme
        "sensitive": Rating.SENSITIVE,
        "questionable": Rating.QUESTIONABLE,
        "explicit": Rating.EXPLICIT,
    }

    def _search_tags(self) -> str:
        return self.tags

    def _auth_params(self) -> dict[str, str]:
        return {}

    async def fetch_page(self, page: int) -> list[Image]:
        params = {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": 1,
            "tags": self._search_tags(),
            "limit": self.page_size,
            "pid": page,
            **self._auth_params(),
        }
        return self.parse(await self._get_json(f"{self.base_url}/index.php", params))

    def parse(self, data: Any) -> list[Image]:
        # Gelbooru wraps posts in {"post": [...]}, Safebooru returns a bare list.
        if isinstance(data, dict):
            posts = data.get("post") or []
        else:
            posts = data if isinstance(data, list) else []
        images = []
        for post in posts:
            post_id = post.get("id")
            file_url = absolute_url(post.get("file_url")) or self._file_url(post)
            if post_id is None or not file_url or post.get("status") == "deleted":
                continue
            tags = frozenset(str(post.get("tags", "")).split())
            images.append(
                Image(
                    source=self.name,
                    post_id=str(post_id),
                    image_url=file_url,
                    sample_url=absolute_url(post.get("sample_url")) or self._sample_url(post),
                    page_url=f"{self.base_url}/index.php?page=post&s=view&id={post_id}",
                    rating=self._RATINGS.get(str(post.get("rating", "")).lower(), Rating.UNKNOWN),
                    tags=tags,
                    characters=guess_characters(tags),
                    source_url=normalize_source_url(post.get("source")),
                    score=to_int(post.get("score")),
                    md5=post.get("md5") or post.get("hash"),
                )
            )
        return images

    def _file_url(self, post: dict[str, Any]) -> str | None:
        if post.get("directory") and post.get("image"):
            return f"{self.base_url}/images/{post['directory']}/{post['image']}"
        return None

    def _sample_url(self, post: dict[str, Any]) -> str | None:
        if post.get("sample") and post.get("directory") and post.get("image"):
            stem = str(post["image"]).rsplit(".", 1)[0]
            return f"{self.base_url}/samples/{post['directory']}/sample_{stem}.jpg"
        return None


class SafebooruSource(_GelbooruLikeSource):
    """safebooru.org only hosts SFW art; the client-side filter still checks each post."""

    name = "safebooru"
    display_name = "Safebooru"
    default_base_url = "https://safebooru.org"


class GelbooruSource(_GelbooruLikeSource):
    name = "gelbooru"
    display_name = "Gelbooru"
    default_base_url = "https://gelbooru.com"

    def __init__(self, *args: Any, user_id: str, api_key: str, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._user_id = user_id
        self._api_key = api_key

    def _search_tags(self) -> str:
        # Gelbooru hosts everything, so filter by rating on the server too.
        if self.allow_sensitive:
            return f"{self.tags} -rating:questionable -rating:explicit"
        return f"{self.tags} rating:general"

    def _auth_params(self) -> dict[str, str]:
        return {"user_id": self._user_id, "api_key": self._api_key}
