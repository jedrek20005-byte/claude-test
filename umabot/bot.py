"""The Discord client: daily scheduler plus slash commands."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp
import discord
from discord import app_commands
from discord.utils import format_dt

from .config import Config
from .filters import ContentFilter
from .history import PostHistory
from .models import Image
from .picker import Picker
from .posting import PreparedPost, make_session, prepare_post
from .schedule import is_due, local_day, next_run_after, sleep_until, utcnow
from .sources import build_sources, display_name

log = logging.getLogger(__name__)

DAILY_TITLE = "🐴 Umamusume of the Day"
RANDOM_TITLE = "🐴 Random Umamusume"


class UmaBot(discord.Client):
    def __init__(self, config: Config) -> None:
        # Slash commands don't need any privileged intents.
        super().__init__(intents=discord.Intents.default())
        self.config = config
        self.tree = app_commands.CommandTree(self)
        self.history = PostHistory.load(config.state_file)
        self.content_filter = ContentFilter(config.max_rating, config.blacklist, config.min_score)
        self.session: aiohttp.ClientSession | None = None
        self.picker: Picker | None = None
        self._daily_task: asyncio.Task[None] | None = None
        self._register_commands()

    async def setup_hook(self) -> None:
        self.session = make_session(self.config.user_agent)
        self.picker = Picker(build_sources(self.config, self.session), self.content_filter, self.history)
        await self._sync_commands()
        self._daily_task = asyncio.create_task(self._daily_loop(), name="umabot-daily")

    async def close(self) -> None:
        if self._daily_task:
            self._daily_task.cancel()
        if self.session:
            await self.session.close()
        await super().close()

    async def on_ready(self) -> None:
        log.info("Logged in as %s; sources: %s", self.user, ", ".join(self.config.sources))

    # ---- daily post -------------------------------------------------------

    async def _daily_loop(self) -> None:
        await self.wait_until_ready()
        cfg = self.config
        if cfg.catch_up:
            # Covers restarts after today's post time when nothing was posted yet.
            await self.run_daily_if_due()
        while not self.is_closed():
            try:
                target = next_run_after(utcnow(), cfg.post_time, cfg.timezone)
                log.info("Next daily post at %s", target.isoformat())
                await sleep_until(target)
                await self.run_daily_if_due()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Daily loop crashed; retrying in a minute")
                await asyncio.sleep(60)

    async def run_daily_if_due(self) -> None:
        cfg = self.config
        today = local_day(utcnow(), cfg.timezone)
        if self.history.last_daily == today or not is_due(utcnow(), cfg.post_time, cfg.timezone):
            return
        for attempt in range(cfg.retry_count + 1):
            try:
                if await self.post_daily(today):
                    return
            except Exception:
                log.exception("Daily post failed")
            if attempt < cfg.retry_count:
                log.info("Retrying the daily post in %s minutes", cfg.retry_delay_minutes)
                await asyncio.sleep(cfg.retry_delay_minutes * 60)
        log.error("Giving up on today's daily post after %d attempts", cfg.retry_count + 1)

    async def post_daily(self, day: str) -> bool:
        post = await self._find_post(DAILY_TITLE)
        if post is None:
            return False
        sent = 0
        for channel_id in self.config.channel_ids:
            channel = await self._get_messageable(channel_id)
            if channel is None:
                continue
            try:
                await channel.send(**post.send_kwargs(self.config.daily_message or None))
                sent += 1
            except discord.HTTPException as exc:
                log.error("Couldn't post in channel %s: %s", channel_id, exc)
        if not sent:
            return False
        self.history.last_daily = day
        self._remember(post.image)
        return True

    # ---- helpers ----------------------------------------------------------

    async def _find_post(self, title: str) -> PreparedPost | None:
        assert self.picker is not None and self.session is not None, "setup_hook has not run"
        image = await self.picker.pick()
        if image is None:
            return None
        return await prepare_post(
            self.session,
            image,
            title,
            upload=self.config.upload_images,
            max_bytes=self.config.max_upload_bytes,
        )

    def _remember(self, image: Image) -> None:
        self.history.record(image)
        try:
            self.history.save()
        except OSError:
            log.exception("Couldn't save the post history to %s", self.history.path)

    async def _get_messageable(self, channel_id: int) -> Any:
        channel = self.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.fetch_channel(channel_id)
            except discord.HTTPException as exc:
                log.error("Can't access channel %s: %s", channel_id, exc)
                return None
        if not isinstance(channel, discord.abc.Messageable):
            log.error("Channel %s is not a text channel", channel_id)
            return None
        return channel

    async def _sync_commands(self) -> None:
        try:
            if self.config.guild_id:
                # Guild commands show up instantly; global ones can take up to an hour.
                guild = discord.Object(id=self.config.guild_id)
                self.tree.copy_global_to(guild=guild)
                synced = await self.tree.sync(guild=guild)
            else:
                synced = await self.tree.sync()
            log.info("Synced %d slash command(s)", len(synced))
        except discord.HTTPException:
            log.exception("Couldn't sync slash commands")

    # ---- slash commands ---------------------------------------------------

    def _register_commands(self) -> None:
        cfg = self.config

        @self.tree.command(name="uma", description="Post a random SFW Umamusume picture")
        async def uma(interaction: discord.Interaction) -> None:
            await interaction.response.defer(thinking=True)
            post = await self._find_post(RANDOM_TITLE)
            if post is None:
                await interaction.followup.send("Couldn't find a picture right now, try again in a bit.")
                return
            await interaction.followup.send(**post.send_kwargs())
            self._remember(post.image)

        if cfg.command_cooldown > 0:
            app_commands.checks.cooldown(1, cfg.command_cooldown, key=lambda i: i.user.id)(uma)

        @self.tree.command(name="uma_status", description="Show the daily Umamusume schedule")
        @app_commands.default_permissions(manage_guild=True)
        async def uma_status(interaction: discord.Interaction) -> None:
            upcoming = next_run_after(utcnow(), cfg.post_time, cfg.timezone)
            lines = [
                f"**Next daily post:** {format_dt(upcoming, 'F')} ({format_dt(upcoming, 'R')})",
                f"**Channels:** {', '.join(f'<#{c}>' for c in cfg.channel_ids)}",
                f"**Sources:** {', '.join(display_name(s) for s in cfg.sources)}",
                f"**Last daily post:** {self.history.last_daily or 'never'}",
                f"**Pictures posted so far:** {len(self.history)}",
            ]
            await interaction.response.send_message("\n".join(lines), ephemeral=True)

        @self.tree.error
        async def on_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
            if isinstance(error, app_commands.CommandOnCooldown):
                message = f"Slow down, trainer! Try again in {error.retry_after:.0f}s."
            else:
                log.error("Command failed", exc_info=error)
                message = "Something went wrong, sorry."
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)
