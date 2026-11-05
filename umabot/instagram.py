"""`python -m umabot instagram-prepare` / `instagram-publish`: post a picture to Instagram.

Uses Instagram's official API (a Business or Creator account is required). The API
only accepts a public JPEG link, so posting takes two steps:

1. ``prepare`` picks a fresh SFW picture, converts it to an Instagram-friendly JPEG
   and writes it, with its caption, to the media folder.
2. The workflow commits that folder so the JPEG has a public link, then
   ``publish`` hands the link to Instagram and remembers the picture.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import random
import re
from datetime import datetime
from pathlib import Path

import aiohttp
from PIL import Image as PILImage
from PIL import ImageOps

from .config import Config
from .filters import ContentFilter
from .formatting import pretty_artist, pretty_character
from .history import PostHistory
from .learning import Learning, features_for
from .models import Image
from .picker import Picker
from .posting import download_image, make_session
from .schedule import utcnow
from .sources import build_sources, display_name

log = logging.getLogger(__name__)

API = "https://graph.instagram.com/v21.0"
MAX_CAPTION = 2200
MAX_HASHTAGS = 30
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_JPEG_BYTES = 7 * 1024 * 1024  # Instagram's limit is 8 MB
MAX_SIDE = 1440
# Instagram rejects feed pictures outside 4:5 (portrait) .. 1.91:1 (landscape).
MIN_RATIO, MAX_RATIO = 0.8, 1.91
IMAGE_NAME, PENDING_NAME = "current.jpg", "pending.json"


class InstagramError(RuntimeError):
    pass


def to_instagram_jpeg(data: bytes) -> bytes:
    """Convert any picture to an RGB JPEG that fits Instagram's size and shape rules.

    Pictures with a shape Instagram refuses get plain white bars instead of being cropped,
    so the artwork is never cut off."""
    with PILImage.open(io.BytesIO(data)) as opened:
        picture = ImageOps.exif_transpose(opened)
        if picture.mode in ("RGBA", "LA", "P"):
            rgba = picture.convert("RGBA")
            picture = PILImage.new("RGB", rgba.size, "white")
            picture.paste(rgba, mask=rgba.getchannel("A"))
        else:
            picture = picture.convert("RGB")

    width, height = picture.size
    ratio = width / height
    if ratio < MIN_RATIO:
        canvas_size = (round(height * MIN_RATIO), height)
    elif ratio > MAX_RATIO:
        canvas_size = (width, round(width / MAX_RATIO))
    else:
        canvas_size = (width, height)
    if canvas_size != picture.size:
        canvas = PILImage.new("RGB", canvas_size, "white")
        canvas.paste(picture, ((canvas_size[0] - width) // 2, (canvas_size[1] - height) // 2))
        picture = canvas
    picture.thumbnail((MAX_SIDE, MAX_SIDE), PILImage.Resampling.LANCZOS)

    for quality in (92, 85, 75, 65):
        out = io.BytesIO()
        picture.save(out, "JPEG", quality=quality, optimize=True)
        if out.tell() <= MAX_JPEG_BYTES:
            break
    return out.getvalue()


def _hashtag(text: str) -> str:
    return "#" + re.sub(r"[^\w]", "", text, flags=re.UNICODE)


def build_caption(image: Image, hashtags: tuple[str, ...]) -> str:
    lines = []
    if image.characters:
        lines.append("🐴 " + ", ".join(dict.fromkeys(pretty_character(c) for c in image.characters[:4])))
    if image.artists:
        lines.append("🎨 Art by " + ", ".join(pretty_artist(a) for a in image.artists[:3]))
    if image.source_url:
        lines.append(f"🔗 Original: {image.source_url}")
    lines.append(f"({display_name(image.source)} post #{image.post_id}; all rights belong to the artist. "
                 f"DM for credit fixes or removal.)")
    tags = [_hashtag(t) for t in hashtags] + [_hashtag(pretty_character(c)) for c in image.characters[:4]]
    tags = [t for t in dict.fromkeys(tags) if len(t) > 1][:MAX_HASHTAGS]
    caption = "\n".join(lines) + "\n\n" + " ".join(tags)
    return caption[:MAX_CAPTION]


async def _collect_candidates(picker: Picker, wanted: int) -> list[Image]:
    found: dict[str, Image] = {}
    for _ in range(wanted * 3):  # the picker may return the same picture again
        if len(found) >= wanted:
            break
        image = await picker.pick()
        if image is not None:
            found.setdefault(image.key, image)
    return list(found.values())


async def run_prepare(config: Config, *, now: bool = False, clock: datetime | None = None) -> int:
    """Pick a picture and write the JPEG + caption, unless it isn't a good time to post.

    Out of several fresh candidates, the learning algorithm picks the one it expects
    to get the most views. Nothing is written when it's not time to post."""
    current = clock or utcnow()
    learning = Learning.load(config.instagram_learning_file)
    if not now and not learning.should_post(current, config.instagram_posts_per_day):
        log.info("Not a posting hour (%d/day; today's chosen hours are %s UTC)", config.instagram_posts_per_day,
                 sorted(learning.best_hours(current.date().isoformat(), config.instagram_posts_per_day)))
        return 0

    history = PostHistory.load(config.state_file)
    folder = Path(config.instagram_media_dir)
    rng = random.Random()
    async with make_session(config.user_agent) as session:
        content_filter = ContentFilter(config.max_rating, config.blacklist, config.min_score)
        picker = Picker(build_sources(config, session), content_filter, history)
        candidates = await _collect_candidates(picker, config.instagram_candidates)
        while candidates:
            image = learning.choose(candidates, rng)
            candidates.remove(image)
            data = None
            for url in dict.fromkeys(u for u in (image.image_url, image.sample_url) if u):
                data = await download_image(session, url, max_bytes=MAX_SOURCE_BYTES, referer=image.page_url)
                if data:
                    break
            try:
                if not data:
                    raise ValueError("download failed")
                jpeg = to_instagram_jpeg(data)
            except (ValueError, OSError) as exc:
                log.info("Skipping %s: %s", image.page_url, exc)
                history.record(image)  # don't pick the same unusable picture again
                history.save()
                continue
            folder.mkdir(parents=True, exist_ok=True)
            (folder / IMAGE_NAME).write_bytes(jpeg)
            grouped = features_for(image)
            pending = {
                "source": image.source,
                "post_id": image.post_id,
                "md5": image.md5,
                "page_url": image.page_url,
                "caption": build_caption(image, config.instagram_hashtags),
                "features": [f for group in grouped.values() for f in group],
            }
            (folder / PENDING_NAME).write_text(json.dumps(pending, ensure_ascii=False, indent=1), encoding="utf-8")
            log.info("Prepared %s (%d KB)", image.page_url, len(jpeg) // 1024)
            return 0
    log.error("Couldn't find a usable picture; the next run will try again")
    return 1


async def _api(session: aiohttp.ClientSession, method: str, path: str, **params: str) -> dict:
    async with session.request(method, f"{API}/{path}", data=params if method == "POST" else None,
                               params=params if method == "GET" else None) as resp:
        body = await resp.json(content_type=None)
        if resp.status != 200 or "error" in body:
            error = body.get("error", {}) if isinstance(body, dict) else {}
            raise InstagramError(f"{error.get('message', body)} (HTTP {resp.status}, code {error.get('code')})")
        return body


async def publish_image(
    session: aiohttp.ClientSession, user_id: str, token: str, image_url: str, caption: str,
    *, poll_seconds: float = 3, attempts: int = 20,
) -> str:
    """Create the media container, wait until Instagram has fetched it, then publish."""
    container = (await _api(session, "POST", f"{user_id}/media",
                            image_url=image_url, caption=caption, access_token=token))["id"]
    for _ in range(attempts):
        status = (await _api(session, "GET", container, fields="status_code", access_token=token)).get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise InstagramError(f"Instagram couldn't process the picture (status {status})")
        await asyncio.sleep(poll_seconds)
    else:
        raise InstagramError("Instagram took too long to process the picture")
    return (await _api(session, "POST", f"{user_id}/media_publish", creation_id=container, access_token=token))["id"]


async def run_publish(config: Config) -> int:
    if not (config.instagram_user_id and config.instagram_access_token):
        log.error("INSTAGRAM_USER_ID and INSTAGRAM_ACCESS_TOKEN must be set")
        return 2
    folder = Path(config.instagram_media_dir)
    try:
        pending = json.loads((folder / PENDING_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.error("Nothing prepared in %s; run instagram-prepare first", folder)
        return 1
    if not config.instagram_media_url:
        log.error("INSTAGRAM_MEDIA_URL (the public link to %s) is not set", IMAGE_NAME)
        return 2

    async with make_session(config.user_agent) as session:
        try:
            media_id = await publish_image(
                session, config.instagram_user_id, config.instagram_access_token,
                config.instagram_media_url, pending["caption"],
            )
        except InstagramError as exc:
            log.error("Instagram refused the post: %s", exc)
            return 1
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.error("Couldn't reach Instagram: %r", exc)
            return 1

    history = PostHistory.load(config.state_file)
    history.record(Image(source=pending["source"], post_id=pending["post_id"], image_url="",
                         page_url=pending["page_url"], rating=config.max_rating, md5=pending.get("md5")))
    history.save()
    learning = Learning.load(config.instagram_learning_file)
    learning.record_post(media_id, pending.get("features", []), utcnow())
    learning.save()
    log.info("Posted to Instagram (media %s): %s", media_id, pending["page_url"])
    return 0


async def fetch_views(session: aiohttp.ClientSession, media_id: str, token: str) -> float | None:
    """How many times a post was seen (falls back to reach, the people who saw it)."""
    for metric in ("views", "reach"):
        try:
            body = await _api(session, "GET", f"{media_id}/insights", metric=metric, access_token=token)
            return float(body["data"][0]["values"][0]["value"])
        except InstagramError as exc:
            log.info("Insight %r unavailable for %s: %s", metric, media_id, exc)
        except (KeyError, IndexError, TypeError, ValueError):
            log.info("Unexpected insights reply for %s", media_id)
    return None


async def run_learn(config: Config, *, clock: datetime | None = None) -> int:
    """Read back the views of old enough posts and learn from them."""
    if not config.instagram_access_token:
        log.error("INSTAGRAM_ACCESS_TOKEN must be set")
        return 2
    current = clock or utcnow()
    learning = Learning.load(config.instagram_learning_file)
    due = learning.due_for_measuring(current)
    if due:
        async with make_session(config.user_agent) as session:
            for post in due:
                try:
                    views = await fetch_views(session, post["media_id"], config.instagram_access_token)
                except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                    log.warning("Couldn't reach Instagram: %r", exc)
                    break
                learning.record_result(post, views, current)
        learning.save()
    log.info("Learning status:\n%s", learning.summary())
    return 0


async def run_refresh(config: Config) -> int:
    """Print a fresh 60-day token (run locally; the old one is replaced by it)."""
    if not config.instagram_access_token:
        log.error("INSTAGRAM_ACCESS_TOKEN is not set")
        return 2
    async with make_session(config.user_agent) as session:
        try:
            body = await _api(session, "GET", "refresh_access_token",
                              grant_type="ig_refresh_token", access_token=config.instagram_access_token)
        except InstagramError as exc:
            log.error("Couldn't refresh the token: %s", exc)
            return 1
    days = int(body.get("expires_in", 0)) // 86400
    print(f"New token (valid {days} days). Put it in the INSTAGRAM_ACCESS_TOKEN secret:\n{body['access_token']}")
    return 0
