"""Builds the Discord message (embed + optional uploaded file) for a picture."""

from __future__ import annotations

import asyncio
import io
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import aiohttp
import discord
from discord.utils import escape_markdown

from .filters import ALLOWED_EXTENSIONS
from .formatting import join_limited, pretty_artist, pretty_character
from .models import Image, url_extension
from .sources import display_name

log = logging.getLogger(__name__)

EMBED_COLOR = discord.Color(0x5FBF6E)
_DOWNLOAD_TIMEOUT = aiohttp.ClientTimeout(total=90)


def make_session(user_agent: str) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(
        headers={"User-Agent": user_agent},
        timeout=aiohttp.ClientTimeout(total=30),
        trust_env=True,
    )


async def download_image(
    session: aiohttp.ClientSession, url: str, *, max_bytes: int, referer: str | None = None
) -> bytes | None:
    """Download an image, or return None if it fails or is bigger than max_bytes."""
    try:
        async with session.get(url, headers={"Referer": referer} if referer else None, timeout=_DOWNLOAD_TIMEOUT) as resp:
            if resp.status != 200 or not resp.content_type.startswith("image/"):
                log.info("Can't download %s (HTTP %s, %s)", url, resp.status, resp.content_type)
                return None
            if resp.content_length and resp.content_length > max_bytes:
                return None
            data = bytearray()
            async for chunk in resp.content.iter_chunked(64 * 1024):
                data += chunk
                if len(data) > max_bytes:
                    return None
            return bytes(data)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        log.info("Can't download %s: %r", url, exc)
        return None


def _markdown_url(url: str) -> str:
    return url.replace("(", "%28").replace(")", "%29")


def build_embed(image: Image, title: str, *, image_url: str) -> discord.Embed:
    lines = []
    if image.characters:
        names = join_limited(escape_markdown(pretty_character(c)) for c in image.characters)
        lines.append(f"**Characters:** {names}")
    if image.artists:
        lines.append(f"**Artist:** {join_limited(escape_markdown(pretty_artist(a)) for a in image.artists)}")
    if image.source_url:
        lines.append(f"**Original:** [source]({_markdown_url(image.source_url)})")
    embed = discord.Embed(
        title=title,
        url=image.page_url,
        description="\n".join(lines) or None,
        color=EMBED_COLOR,
        timestamp=datetime.now(timezone.utc),
    )
    embed.set_image(url=image_url)
    embed.set_footer(text=f"{display_name(image.source)} · post #{image.post_id}")
    return embed


@dataclass
class PreparedPost:
    image: Image
    embed: discord.Embed
    data: bytes | None = None
    filename: str | None = None

    def send_kwargs(self, content: str | None = None) -> dict[str, Any]:
        # A discord.File can only be sent once, so build a fresh one per message.
        kwargs: dict[str, Any] = {"embed": self.embed}
        if self.data is not None and self.filename:
            kwargs["file"] = discord.File(io.BytesIO(self.data), filename=self.filename)
        if content:
            kwargs["content"] = content
        return kwargs


async def prepare_post(
    session: aiohttp.ClientSession, image: Image, title: str, *, upload: bool = True, max_bytes: int
) -> PreparedPost:
    """Upload the picture as an attachment when possible (some sites block hotlinking),
    trying the original first and the smaller sample second; otherwise link it."""
    if upload:
        for url in dict.fromkeys(u for u in (image.image_url, image.sample_url) if u):
            data = await download_image(session, url, max_bytes=max_bytes, referer=image.page_url)
            if data is not None:
                ext = url_extension(url)
                filename = f"umamusume_{image.source}_{image.post_id}{ext if ext in ALLOWED_EXTENSIONS else '.jpg'}"
                embed = build_embed(image, title, image_url=f"attachment://{filename}")
                return PreparedPost(image, embed, data, filename)
        log.info("Falling back to linking %s instead of uploading it", image.image_url)
    return PreparedPost(image, build_embed(image, title, image_url=image.image_url))
