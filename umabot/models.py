"""Core data types shared by the sources, the filter and the bot."""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from posixpath import splitext
from urllib.parse import urlsplit


class Rating(IntEnum):
    """Content rating normalised across sites (lower is safer)."""

    GENERAL = 0
    SENSITIVE = 1
    QUESTIONABLE = 2
    EXPLICIT = 3
    UNKNOWN = 9  # never allowed through the filter


def normalize_tag(tag: str) -> str:
    """'Special Week' -> 'special_week', so tags from every site compare equal."""
    return "_".join(tag.lower().split())


def url_extension(url: str) -> str:
    return splitext(urlsplit(url).path)[1].lower()


@dataclass(frozen=True)
class Image:
    source: str
    post_id: str
    image_url: str
    page_url: str
    rating: Rating
    tags: frozenset[str] = frozenset()
    sample_url: str | None = None
    artists: tuple[str, ...] = ()
    characters: tuple[str, ...] = ()
    source_url: str | None = None
    score: int | None = None
    md5: str | None = None

    @property
    def key(self) -> str:
        return f"{self.source}:{self.post_id}"

    @property
    def extension(self) -> str:
        return url_extension(self.image_url)
