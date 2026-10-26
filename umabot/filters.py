"""Decides whether a picture is safe enough to post."""

from __future__ import annotations

from collections.abc import Iterable
from fnmatch import fnmatchcase

from .models import Image, Rating, normalize_tag

ALLOWED_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp"})


class ContentFilter:
    def __init__(
        self,
        max_rating: Rating = Rating.GENERAL,
        blacklist: Iterable[str] = (),
        min_score: int | None = None,
    ) -> None:
        self.max_rating = max_rating
        self.min_score = min_score
        tags = {normalize_tag(tag) for tag in blacklist if tag.strip()}
        self._exact = frozenset(tag for tag in tags if "*" not in tag)
        self._patterns = tuple(tag for tag in tags if "*" in tag)

    def rejection_reason(self, image: Image) -> str | None:
        if image.rating > self.max_rating:
            return f"rating {image.rating.name.lower()}"
        if image.extension not in ALLOWED_EXTENSIONS:
            return f"file type {image.extension or 'unknown'}"
        if self.min_score is not None and image.score is not None and image.score < self.min_score:
            return f"score {image.score}"
        hit = self._blacklisted_tag(image.tags)
        if hit:
            return f"blacklisted tag {hit}"
        return None

    def allows(self, image: Image) -> bool:
        return self.rejection_reason(image) is None

    def _blacklisted_tag(self, tags: Iterable[str]) -> str | None:
        for tag in tags:
            tag = normalize_tag(tag)
            if tag in self._exact or any(fnmatchcase(tag, pattern) for pattern in self._patterns):
                return tag
        return None
