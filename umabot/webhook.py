"""`python -m umabot post`: post the daily picture through a Discord webhook.

Meant to be started by a scheduler (such as the GitHub Actions workflow in
.github/workflows/daily-post.yml), so nothing has to stay online. It's safe to
run it often: it only posts once POST_TIME has passed, and once per day.
"""

from __future__ import annotations

import logging
from datetime import datetime

import discord

from .config import Config
from .filters import ContentFilter
from .history import PostHistory
from .picker import Picker
from .posting import DAILY_TITLE, make_session, prepare_post
from .schedule import is_due, local_day, utcnow
from .sources import build_sources

log = logging.getLogger(__name__)


async def run_post(config: Config, *, now: bool = False, clock: datetime | None = None) -> int:
    """Post today's picture if it's due (or right away with now=True). Returns an exit code."""
    if not config.webhook_urls:
        log.error("DISCORD_WEBHOOK_URL is not set")
        return 2
    current = clock or utcnow()
    today = local_day(current, config.timezone)
    history = PostHistory.load(config.state_file)
    if not now:
        if history.last_daily == today:
            log.info("Today's picture (%s) is already posted", today)
            return 0
        if not is_due(current, config.post_time, config.timezone):
            post_time = config.post_time.strftime("%H:%M")
            log.info("Not time yet: the daily picture goes out at %s (%s)", post_time, config.timezone)
            return 0

    async with make_session(config.user_agent) as session:
        content_filter = ContentFilter(config.max_rating, config.blacklist, config.min_score)
        image = await Picker(build_sources(config, session), content_filter, history).pick()
        if image is None:
            log.error("Couldn't find a picture; the next run will try again")
            return 1
        post = await prepare_post(
            session, image, DAILY_TITLE, upload=config.upload_images, max_bytes=config.max_upload_bytes
        )
        sent = 0
        for number, url in enumerate(config.webhook_urls, start=1):
            # Never log the URL itself: it works like a password.
            try:
                webhook = discord.Webhook.from_url(url, session=session)
                await webhook.send(**post.send_kwargs(config.daily_message or None))
                sent += 1
            except ValueError:
                log.error("Webhook URL #%d doesn't look like a Discord webhook URL", number)
            except discord.HTTPException as exc:
                log.error("Webhook #%d failed: %s (was the webhook deleted?)", number, exc)

    if not sent:
        return 1
    history.last_daily = today
    history.record(image)
    history.save()
    log.info("Posted %s", image.page_url)
    return 0
