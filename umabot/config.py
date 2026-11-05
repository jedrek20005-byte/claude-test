"""Configuration read from environment variables (or a .env file)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import Rating

ALL_SOURCES = ("danbooru", "safebooru", "gelbooru", "konachan", "zerochan")

DEFAULT_TAGS = {
    "danbooru": "umamusume",
    "safebooru": "umamusume",
    "gelbooru": "umamusume",
    "konachan": "uma_musume_pretty_derby",
    "zerochan": "Uma Musume: Pretty Derby",
}

# Extra safety net on top of the rating filter, so borderline "fanservice" posts
# never reach the channel. Entries may use * wildcards.
DEFAULT_BLACKLIST = (
    "nude", "completely_nude", "topless", "bottomless", "nipples", "areolae",
    "sex", "cum", "penis", "pussy", "after_sex", "implied_sex", "nsfw", "ecchi",
    "fanservice", "sexually_suggestive", "lewd", "loli", "shota", "pregnant",
    "underwear", "underwear_only", "panties", "bra", "lingerie", "pantyshot",
    "upskirt", "cameltoe", "swimsuit", "*_swimsuit", "bikini", "*_bikini",
    "cleavage", "sideboob", "underboob", "breast_grab", "groping", "ass",
    "ass_focus", "crotch", "groin", "spread_legs", "see-through", "naked_towel",
    "bath", "bathing", "onsen", "wet_clothes", "undressing", "bdsm", "bondage",
    "shibari", "gore", "guro", "blood", "vore", "foot_focus",
)

DEFAULT_USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)"

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class ConfigError(ValueError):
    pass


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _parse_bool(key: str, value: str, default: bool) -> bool:
    if not value:
        return default
    if value.lower() in _TRUE:
        return True
    if value.lower() in _FALSE:
        return False
    raise ConfigError(f"{key} must be true or false, got {value!r}")


def _parse_number(key: str, value: str, default: float, kind: type = float) -> float:
    if not value:
        return default
    try:
        return kind(value)
    except ValueError:
        raise ConfigError(f"{key} must be a number, got {value!r}") from None


def _parse_time(value: str) -> time:
    try:
        hour, minute = (int(part) for part in value.split(":"))
        return time(hour, minute)
    except ValueError:
        raise ConfigError(f"POST_TIME must look like HH:MM (24-hour clock), got {value!r}") from None


def _parse_timezone(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        raise ConfigError(
            f"Unknown TIMEZONE {value!r}; use a name like Europe/Warsaw or America/New_York"
        ) from None


def _missing_credentials(source: str, env: Mapping[str, str]) -> str | None:
    if source == "gelbooru" and not (env.get("GELBOORU_USER_ID") and env.get("GELBOORU_API_KEY")):
        return "GELBOORU_USER_ID and GELBOORU_API_KEY"
    if source == "zerochan" and not env.get("ZEROCHAN_USERNAME"):
        return "ZEROCHAN_USERNAME"
    return None


@dataclass(frozen=True)
class Config:
    discord_token: str
    channel_ids: tuple[int, ...]
    webhook_urls: tuple[str, ...]
    guild_id: int | None
    post_time: time
    timezone: ZoneInfo
    catch_up: bool
    daily_message: str
    sources: tuple[str, ...]
    tags: Mapping[str, str]
    allow_sensitive: bool
    blacklist: frozenset[str]
    min_score: int | None
    upload_images: bool
    max_upload_bytes: int
    retry_count: int
    retry_delay_minutes: float
    command_cooldown: float
    state_file: str
    user_agent: str
    danbooru_login: str | None
    danbooru_api_key: str | None
    gelbooru_user_id: str | None
    gelbooru_api_key: str | None
    zerochan_username: str | None
    instagram_user_id: str | None = None
    instagram_access_token: str | None = None
    instagram_hashtags: tuple[str, ...] = ("umamusume", "umamusumeprettyderby", "ウマ娘", "fanart")
    instagram_media_url: str | None = None
    instagram_media_dir: str = "instagram-media"
    instagram_posts_per_day: int = 2
    instagram_candidates: int = 6
    instagram_learning_file: str = "state/instagram-learning.json"

    @property
    def max_rating(self) -> Rating:
        return Rating.SENSITIVE if self.allow_sensitive else Rating.GENERAL

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, *, require_discord: bool = True) -> Config:
        env = {key: value.strip() for key, value in (os.environ if env is None else env).items()}
        get = env.get

        token = get("DISCORD_TOKEN", "")
        try:
            channel_ids = tuple(int(c) for c in _split(get("CHANNEL_IDS") or get("CHANNEL_ID", "")))
            guild_id = int(get("GUILD_ID")) if get("GUILD_ID") else None
        except ValueError:
            raise ConfigError("CHANNEL_IDS and GUILD_ID must be numeric Discord IDs") from None
        if require_discord and not token:
            raise ConfigError("DISCORD_TOKEN is not set")
        if require_discord and not channel_ids:
            raise ConfigError("CHANNEL_IDS is not set (the channel(s) the daily picture goes to)")

        requested = _split(get("SOURCES", "auto").lower())
        if requested in ([], ["auto"]):
            sources = tuple(s for s in ALL_SOURCES if not _missing_credentials(s, env))
        else:
            unknown = [s for s in requested if s not in ALL_SOURCES]
            if unknown:
                raise ConfigError(f"Unknown source(s) {unknown}; pick from {', '.join(ALL_SOURCES)}")
            for source in requested:
                missing = _missing_credentials(source, env)
                if missing:
                    raise ConfigError(f"The {source} source needs {missing} to be set")
            sources = tuple(dict.fromkeys(requested))

        blacklist = DEFAULT_BLACKLIST if get("BLACKLIST_TAGS") is None else _split(get("BLACKLIST_TAGS"))
        blacklist = frozenset([*blacklist, *_split(get("EXTRA_BLACKLIST_TAGS", ""))])

        min_score = get("MIN_SCORE", "0")
        return cls(
            discord_token=token,
            channel_ids=channel_ids,
            webhook_urls=tuple(_split(f"{get('DISCORD_WEBHOOK_URL', '')},{get('DISCORD_WEBHOOK_URLS', '')}")),
            guild_id=guild_id,
            post_time=_parse_time(get("POST_TIME") or "12:00"),
            timezone=_parse_timezone(get("TIMEZONE") or "UTC"),
            catch_up=_parse_bool("CATCH_UP", get("CATCH_UP", ""), True),
            daily_message=get("DAILY_MESSAGE", ""),
            sources=sources,
            tags={s: get(f"{s.upper()}_TAGS") or DEFAULT_TAGS[s] for s in ALL_SOURCES},
            allow_sensitive=_parse_bool("ALLOW_SENSITIVE", get("ALLOW_SENSITIVE", ""), False),
            blacklist=blacklist,
            min_score=None if min_score.lower() in ("", "none") else int(_parse_number("MIN_SCORE", min_score, 0, int)),
            upload_images=_parse_bool("UPLOAD_IMAGES", get("UPLOAD_IMAGES", ""), True),
            max_upload_bytes=int(_parse_number("MAX_UPLOAD_MB", get("MAX_UPLOAD_MB", ""), 9) * 1024 * 1024),
            retry_count=int(_parse_number("RETRY_COUNT", get("RETRY_COUNT", ""), 3, int)),
            retry_delay_minutes=_parse_number("RETRY_DELAY_MINUTES", get("RETRY_DELAY_MINUTES", ""), 15),
            command_cooldown=_parse_number("COMMAND_COOLDOWN", get("COMMAND_COOLDOWN", ""), 30),
            state_file=get("STATE_FILE") or "data/state.json",
            user_agent=get("USER_AGENT") or DEFAULT_USER_AGENT,
            danbooru_login=get("DANBOORU_LOGIN") or None,
            danbooru_api_key=get("DANBOORU_API_KEY") or None,
            gelbooru_user_id=get("GELBOORU_USER_ID") or None,
            gelbooru_api_key=get("GELBOORU_API_KEY") or None,
            zerochan_username=get("ZEROCHAN_USERNAME") or None,
            instagram_user_id=get("INSTAGRAM_USER_ID") or None,
            instagram_access_token=get("INSTAGRAM_ACCESS_TOKEN") or None,
            instagram_hashtags=tuple(
                tag.lstrip("#") for tag in _split(get("INSTAGRAM_HASHTAGS", "umamusume,umamusumeprettyderby,ウマ娘,fanart"))
            ),
            instagram_media_url=get("INSTAGRAM_MEDIA_URL") or None,
            instagram_media_dir=get("INSTAGRAM_MEDIA_DIR") or "instagram-media",
            instagram_posts_per_day=int(_parse_number("INSTAGRAM_POSTS_PER_DAY", get("INSTAGRAM_POSTS_PER_DAY", ""), 2, int)),
            instagram_candidates=int(_parse_number("INSTAGRAM_CANDIDATES", get("INSTAGRAM_CANDIDATES", ""), 6, int)),
            instagram_learning_file=get("INSTAGRAM_LEARNING_FILE") or "state/instagram-learning.json",
        )
