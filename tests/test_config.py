from datetime import time

import pytest

from umabot.config import ALL_SOURCES, DEFAULT_BLACKLIST, Config, ConfigError
from umabot.models import Rating
from umabot.sources import SOURCE_CLASSES

BASE = {"DISCORD_TOKEN": "token", "CHANNEL_IDS": "111, 222"}


def test_defaults():
    cfg = Config.from_env(BASE)
    assert cfg.channel_ids == (111, 222)
    assert cfg.post_time == time(12, 0)
    assert str(cfg.timezone) == "UTC"
    assert cfg.sources == ("danbooru", "safebooru", "konachan")  # no credentials for the others
    assert cfg.max_rating is Rating.GENERAL
    assert cfg.blacklist == frozenset(DEFAULT_BLACKLIST)
    assert cfg.min_score == 0
    assert cfg.max_upload_bytes == 9 * 1024 * 1024
    assert cfg.tags["danbooru"] == "umamusume"
    assert cfg.catch_up and cfg.upload_images


def test_source_classes_match_config():
    assert set(SOURCE_CLASSES) == set(ALL_SOURCES)


def test_auto_sources_include_credentialed_ones():
    env = {**BASE, "GELBOORU_USER_ID": "1", "GELBOORU_API_KEY": "k", "ZEROCHAN_USERNAME": "me"}
    assert Config.from_env(env).sources == ALL_SOURCES


def test_explicit_sources():
    assert Config.from_env({**BASE, "SOURCES": "Safebooru, danbooru, safebooru"}).sources == ("safebooru", "danbooru")
    with pytest.raises(ConfigError, match="GELBOORU_USER_ID"):
        Config.from_env({**BASE, "SOURCES": "gelbooru"})
    with pytest.raises(ConfigError, match="Unknown source"):
        Config.from_env({**BASE, "SOURCES": "pixiv"})


def test_required_values():
    with pytest.raises(ConfigError, match="DISCORD_TOKEN"):
        Config.from_env({"CHANNEL_IDS": "1"})
    with pytest.raises(ConfigError, match="CHANNEL_IDS"):
        Config.from_env({"DISCORD_TOKEN": "t"})
    with pytest.raises(ConfigError, match="numeric"):
        Config.from_env({**BASE, "CHANNEL_IDS": "#general"})
    # `check` doesn't need Discord settings, and CHANNEL_ID works as an alias.
    assert Config.from_env({}, require_discord=False).channel_ids == ()
    assert Config.from_env({"DISCORD_TOKEN": "t", "CHANNEL_ID": "5"}).channel_ids == (5,)


@pytest.mark.parametrize("value", ["noon", "25:00", "12", "12:00:00"])
def test_bad_post_time(value):
    with pytest.raises(ConfigError, match="POST_TIME"):
        Config.from_env({**BASE, "POST_TIME": value})


def test_timezone_and_time():
    cfg = Config.from_env({**BASE, "POST_TIME": "8:05", "TIMEZONE": "Europe/Warsaw"})
    assert cfg.post_time == time(8, 5) and str(cfg.timezone) == "Europe/Warsaw"
    with pytest.raises(ConfigError, match="TIMEZONE"):
        Config.from_env({**BASE, "TIMEZONE": "Mars/Olympus"})


def test_filter_settings():
    cfg = Config.from_env({**BASE, "ALLOW_SENSITIVE": "yes", "EXTRA_BLACKLIST_TAGS": "comic, 4koma", "MIN_SCORE": ""})
    assert cfg.max_rating is Rating.SENSITIVE
    assert {"comic", "4koma", "bikini"} <= cfg.blacklist
    assert cfg.min_score is None
    assert Config.from_env({**BASE, "BLACKLIST_TAGS": ""}).blacklist == frozenset()
    with pytest.raises(ConfigError, match="ALLOW_SENSITIVE"):
        Config.from_env({**BASE, "ALLOW_SENSITIVE": "maybe"})
    with pytest.raises(ConfigError, match="MIN_SCORE"):
        Config.from_env({**BASE, "MIN_SCORE": "lots"})


def test_custom_tags():
    cfg = Config.from_env({**BASE, "KONACHAN_TAGS": "umamusume"})
    assert cfg.tags["konachan"] == "umamusume"
