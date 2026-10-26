"""Image sources the bot can pull pictures from."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .base import Source, SourceError
from .danbooru import DanbooruSource
from .gelbooru import GelbooruSource, SafebooruSource
from .konachan import KonachanSource
from .zerochan import ZerochanSource

if TYPE_CHECKING:
    import aiohttp

    from ..config import Config

SOURCE_CLASSES: dict[str, type[Source]] = {
    cls.name: cls
    for cls in (DanbooruSource, SafebooruSource, GelbooruSource, KonachanSource, ZerochanSource)
}

__all__ = ["SOURCE_CLASSES", "Source", "SourceError", "build_sources", "display_name"]


def display_name(source: str) -> str:
    cls = SOURCE_CLASSES.get(source)
    return cls.display_name if cls else source.title()


def build_sources(config: Config, session: aiohttp.ClientSession) -> list[Source]:
    sources = []
    for name in config.sources:
        kwargs: dict[str, Any] = {"allow_sensitive": config.allow_sensitive}
        if name == "danbooru":
            kwargs.update(login=config.danbooru_login, api_key=config.danbooru_api_key)
        elif name == "gelbooru":
            kwargs.update(user_id=config.gelbooru_user_id, api_key=config.gelbooru_api_key)
        elif name == "zerochan":
            kwargs.update(username=config.zerochan_username)
        sources.append(SOURCE_CLASSES[name](session, config.tags[name], **kwargs))
    return sources
