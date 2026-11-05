"""Learns which pictures and posting hours get the most views (Thompson sampling).

Every post is described by a few features (its characters, artist, source and the
hour it went out). After Instagram reports how many people saw a post, its reward
``log(1 + views)`` is added to the statistics of each feature. To choose, every
feature gets a random draw from what we believe its average reward is: features with
good results usually draw high, and features we know little about draw widely, so the
bot keeps trying new things instead of repeating early luck.
"""

from __future__ import annotations

import json
import math
import os
import random
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .formatting import pretty_character
from .models import Image

PRIOR_STRENGTH = 2.0  # how many "pretend" posts at the global average each feature starts with
MIN_SPREAD = 0.5  # never be more sure than this about a feature (keeps exploring)
MEASURE_AFTER = timedelta(hours=48)  # views mostly settle by then
GIVE_UP_AFTER = timedelta(days=14)


def features_for(image: Image) -> dict[str, list[str]]:
    """The features of a picture, grouped by kind."""
    return {
        "char": [f"char:{pretty_character(c).lower()}" for c in image.characters[:4]],
        "artist": [f"artist:{a}" for a in image.artists[:2]],
        "source": [f"source:{image.source}"],
    }


def reward(views: float) -> float:
    return math.log1p(max(views, 0))


@dataclass
class Stat:
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0

    def add(self, value: float) -> None:  # Welford's running mean/variance
        self.n += 1
        delta = value - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (value - self.mean)

    @property
    def std(self) -> float:
        return math.sqrt(self.m2 / (self.n - 1)) if self.n > 1 else 0.0


class Learning:
    ALL = "__all__"

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.posts: list[dict] = []
        self.arms: dict[str, Stat] = {}

    @classmethod
    def load(cls, path: str | Path) -> Learning:
        learning = cls(path)
        if learning.path.exists():
            try:
                data = json.loads(learning.path.read_text(encoding="utf-8"))
                learning.posts = [p for p in data.get("posts", []) if isinstance(p, dict)]
                learning.arms = {k: Stat(**v) for k, v in data.get("arms", {}).items()}
            except (OSError, ValueError, TypeError):
                pass  # start fresh rather than crash the posting run
        return learning

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        payload = {
            "posts": self.posts[-500:],
            "arms": {k: vars(v) for k, v in self.arms.items()},
        }
        tmp.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    # --- recording -----------------------------------------------------------------

    def record_post(self, media_id: str, features: Sequence[str], posted_at: datetime) -> None:
        hour = f"hour:{posted_at.astimezone(timezone.utc).hour}"
        self.posts.append({
            "media_id": media_id,
            "features": [*features, hour],
            "posted_at": posted_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "views": None,
            "done": False,
        })

    def due_for_measuring(self, now: datetime) -> list[dict]:
        return [
            p for p in self.posts
            if not p["done"] and now - datetime.fromisoformat(p["posted_at"]) >= MEASURE_AFTER
        ]

    def record_result(self, post: dict, views: float | None, now: datetime) -> None:
        """Learn from a post's views. views=None means "couldn't be measured"; it's retried
        until the post is too old, then dropped without learning anything from it."""
        age = now - datetime.fromisoformat(post["posted_at"])
        if views is None:
            post["done"] = age >= GIVE_UP_AFTER
            return
        value = reward(views)
        post["views"], post["done"] = views, True
        for key in (self.ALL, *post["features"]):
            self.arms.setdefault(key, Stat()).add(value)

    # --- choosing ------------------------------------------------------------------

    @property
    def measured_posts(self) -> int:
        return self.arms.get(self.ALL, Stat()).n

    def draw(self, feature: str, rng: random.Random) -> float:
        """A random guess of how well this feature does: wide when we know little."""
        overall = self.arms.get(self.ALL, Stat())
        spread = max(overall.std, MIN_SPREAD)
        stat = self.arms.get(feature, Stat())
        mean = (stat.n * stat.mean + PRIOR_STRENGTH * overall.mean) / (stat.n + PRIOR_STRENGTH)
        return rng.gauss(mean, spread / math.sqrt(stat.n + PRIOR_STRENGTH))

    def score(self, grouped: dict[str, list[str]], rng: random.Random) -> float:
        """Average of one draw per kind of feature (characters averaged together)."""
        kinds = [sum(self.draw(f, rng) for f in group) / len(group) for group in grouped.values() if group]
        return sum(kinds) / len(kinds) if kinds else rng.gauss(0, 1)

    def choose(self, candidates: Sequence[Image], rng: random.Random) -> Image:
        return max(candidates, key=lambda image: self.score(features_for(image), rng))

    def posts_on(self, day: str) -> int:
        return sum(1 for p in self.posts if p["posted_at"].startswith(day))

    def best_hours(self, day: str, how_many: int) -> set[int]:
        """The hours (UTC) to post in today. Seeded by the date, so hourly runs agree."""
        rng = random.Random(f"hours-{day}")
        draws = {hour: self.draw(f"hour:{hour}", rng) for hour in range(24)}
        return set(sorted(draws, key=draws.__getitem__, reverse=True)[:how_many])

    def should_post(self, now: datetime, per_day: int) -> bool:
        now = now.astimezone(timezone.utc)
        day = now.date().isoformat()
        return self.posts_on(day) < per_day and now.hour in self.best_hours(day, per_day)

    def summary(self, top: int = 5) -> str:
        ranked = sorted(((k, s) for k, s in self.arms.items() if k != self.ALL and s.n >= 2), key=lambda kv: -kv[1].mean)
        lines = [f"{self.measured_posts} measured posts"]
        lines += [f"  {k}: avg views ~{math.expm1(s.mean):.0f} over {s.n} posts" for k, s in ranked[:top]]
        return "\n".join(lines)
