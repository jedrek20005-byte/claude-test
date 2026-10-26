"""Picks one fresh, safe picture, falling back from source to source."""

from __future__ import annotations

import logging
import random
from collections.abc import Sequence
from typing import Protocol

from .filters import ContentFilter
from .models import Image
from .sources import Source, SourceError

log = logging.getLogger(__name__)


class History(Protocol):
    def has_posted(self, image: Image) -> bool: ...


class Picker:
    def __init__(
        self,
        sources: Sequence[Source],
        content_filter: ContentFilter,
        history: History,
        *,
        rng: random.Random | None = None,
        pages_per_source: int = 2,
        candidates_per_page: int = 3,
    ) -> None:
        self.sources = list(sources)
        self.filter = content_filter
        self.history = history
        self.rng = rng or random.Random()
        self.pages_per_source = pages_per_source
        self.candidates_per_page = candidates_per_page

    async def pick(self) -> Image | None:
        order = list(self.sources)
        self.rng.shuffle(order)
        for source in order:
            image = await self._pick_from(source)
            if image is not None:
                log.info("Picked %s from %s", image.page_url, source.display_name)
                return image
        log.warning("None of the sources returned a usable picture")
        return None

    def _usable(self, image: Image) -> bool:
        return self.filter.allows(image) and not self.history.has_posted(image)

    async def _pick_from(self, source: Source) -> Image | None:
        try:
            for _ in range(self.pages_per_source):
                candidates = [image for image in await source.random_batch(self.rng) if self._usable(image)]
                self.rng.shuffle(candidates)
                for candidate in candidates[: self.candidates_per_page]:
                    try:
                        image = await source.resolve(candidate)
                    except SourceError as exc:
                        log.info("Skipping %s: %s", candidate.page_url, exc)
                        continue
                    # Resolving can reveal more tags, so check again.
                    if self._usable(image):
                        return image
        except SourceError as exc:
            log.warning("%s is unavailable: %s", source.display_name, exc)
        except Exception:
            log.exception("Unexpected error while querying %s", source.display_name)
        return None
