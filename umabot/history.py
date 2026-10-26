"""Remembers what was already posted so pictures don't repeat."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from .models import Image

log = logging.getLogger(__name__)


class PostHistory:
    def __init__(self, path: str | Path, *, max_entries: int = 5000) -> None:
        self.path = Path(path)
        self.max_entries = max_entries
        self.last_daily: str | None = None  # ISO date of the last daily post
        self._entries: list[dict[str, str | None]] = []
        self._keys: set[str] = set()
        self._md5s: set[str] = set()

    @classmethod
    def load(cls, path: str | Path, **kwargs: int) -> PostHistory:
        history = cls(path, **kwargs)
        if history.path.exists():
            try:
                data = json.loads(history.path.read_text(encoding="utf-8"))
                history.last_daily = data.get("last_daily")
                history._entries = [e for e in data.get("posted", []) if isinstance(e, dict) and e.get("key")]
                history._reindex()
            except (OSError, ValueError, AttributeError) as exc:
                log.warning("Could not read %s (%s); starting with an empty history", history.path, exc)
        return history

    def __len__(self) -> int:
        return len(self._entries)

    def has_posted(self, image: Image) -> bool:
        # The same file is often on several boorus, so compare hashes too.
        return image.key in self._keys or (image.md5 is not None and image.md5 in self._md5s)

    def record(self, image: Image) -> None:
        self._entries.append(
            {"key": image.key, "md5": image.md5, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        )
        self._entries = self._entries[-self.max_entries :]
        self._reindex()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({"last_daily": self.last_daily, "posted": self._entries}, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def _reindex(self) -> None:
        self._keys = {str(e["key"]) for e in self._entries}
        self._md5s = {str(e["md5"]) for e in self._entries if e.get("md5")}
