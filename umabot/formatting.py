"""Helpers that turn booru tags and links into something nice to show in Discord."""

from __future__ import annotations

import re
from collections.abc import Iterable

# Danbooru-style character tags look like "special_week_(umamusume)".
UMA_QUALIFIER = re.compile(r"_\((?:umamusume|uma_musume(?:_pretty_derby)?)\)$")
_PIXIV_IMAGE = re.compile(r"pximg\.net/.*?/(\d+)_(?:p\d+|ugoira)")
_INITIALISM = re.compile(r"(?:[a-z]\.)+")


def is_uma_character_tag(tag: str) -> bool:
    return bool(UMA_QUALIFIER.search(tag))


def _capitalize(word: str) -> str:
    if _INITIALISM.fullmatch(word):
        return word.upper()  # "t.m." -> "T.M."
    start = 1 if word.startswith("(") else 0
    return word[:start] + word[start : start + 1].upper() + word[start + 1 :]


def pretty_character(tag: str) -> str:
    """'special_week_(umamusume)' -> 'Special Week'; already pretty names are kept."""
    return " ".join(_capitalize(word) for word in UMA_QUALIFIER.sub("", tag).replace("_", " ").split())


def pretty_artist(tag: str) -> str:
    return tag.replace("_", " ")


def normalize_source_url(url: str | None, pixiv_id: int | str | None = None) -> str | None:
    """Return a link to the original artwork, turning raw pixiv image URLs into artwork pages."""
    if pixiv_id:
        return f"https://www.pixiv.net/artworks/{pixiv_id}"
    if not url or not url.startswith(("http://", "https://")):
        return None
    match = _PIXIV_IMAGE.search(url)
    if match:
        return f"https://www.pixiv.net/artworks/{match.group(1)}"
    return url


def join_limited(items: Iterable[str], limit: int = 4) -> str:
    items = list(items)
    if len(items) <= limit:
        return ", ".join(items)
    return f"{', '.join(items[:limit])} +{len(items) - limit} more"
