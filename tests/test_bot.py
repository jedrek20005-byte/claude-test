from __future__ import annotations

import discord
import pytest

from umabot.bot import DAILY_TITLE, UmaBot
from umabot.config import Config

from .conftest import make_image


class FakeChannel(discord.abc.Messageable):
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def _get_channel(self):
        return self

    async def send(self, **kwargs):
        if self.fail:
            raise discord.Forbidden(type("R", (), {"status": 403, "reason": "Forbidden"})(), "Missing Access")
        self.sent.append(kwargs)


class FakePicker:
    def __init__(self, image):
        self.image = image

    async def pick(self):
        return self.image


@pytest.fixture
def bot(tmp_path):
    def make(channels, image, **env):
        config = Config.from_env(
            {
                "DISCORD_TOKEN": "t",
                "CHANNEL_IDS": ",".join(str(c) for c in channels),
                "STATE_FILE": str(tmp_path / "state.json"),
                "UPLOAD_IMAGES": "false",
                **env,
            }
        )
        client = UmaBot(config)
        client.picker = FakePicker(image)
        client.session = object()  # not used when uploads are off
        client.get_channel = channels.get
        return client

    return make


def test_slash_commands_registered(bot):
    client = bot({1: FakeChannel()}, None)
    assert {c.name for c in client.tree.get_commands()} == {"uma", "uma_status"}
    uma = client.tree.get_command("uma")
    assert uma.checks  # cooldown is attached
    status = client.tree.get_command("uma_status")
    assert status.default_permissions.manage_guild


async def test_post_daily_sends_to_every_channel_and_remembers(bot, tmp_path):
    channels = {1: FakeChannel(), 2: FakeChannel(fail=True), 3: FakeChannel()}
    image = make_image("42", md5="m42")
    client = bot(channels, image, DAILY_MESSAGE="Good morning!")

    assert await client.post_daily("2026-10-26")
    for channel_id in (1, 3):
        [message] = channels[channel_id].sent
        assert message["content"] == "Good morning!"
        assert message["embed"].title == DAILY_TITLE
        assert message["embed"].image.url == image.image_url
    assert client.history.last_daily == "2026-10-26"
    assert client.history.has_posted(image)
    assert (tmp_path / "state.json").exists()


async def test_post_daily_fails_when_no_channel_works(bot):
    client = bot({1: FakeChannel(fail=True)}, make_image("1"))
    assert not await client.post_daily("2026-10-26")
    assert client.history.last_daily is None and len(client.history) == 0


async def test_post_daily_fails_when_no_picture(bot):
    client = bot({1: FakeChannel()}, None)
    assert not await client.post_daily("2026-10-26")


async def test_run_daily_if_due_posts_once_per_day(bot):
    channel = FakeChannel()
    client = bot({1: channel}, make_image("1"), POST_TIME="00:00")
    await client.run_daily_if_due()
    await client.run_daily_if_due()  # same day: nothing more
    assert len(channel.sent) == 1


async def test_run_daily_if_due_retries(bot, monkeypatch):
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr("umabot.bot.asyncio.sleep", fake_sleep)
    client = bot({1: FakeChannel()}, None, POST_TIME="00:00", RETRY_COUNT="2", RETRY_DELAY_MINUTES="1")
    await client.run_daily_if_due()
    assert sleeps == [60, 60]
    assert client.history.last_daily is None


class FakeResponse:
    def __init__(self):
        self.deferred = False
        self.messages = []

    async def defer(self, thinking=False):
        self.deferred = True

    async def send_message(self, content=None, **kwargs):
        self.messages.append((content, kwargs))

    def is_done(self):
        return self.deferred or bool(self.messages)


class FakeFollowup:
    def __init__(self):
        self.messages = []

    async def send(self, content=None, **kwargs):
        self.messages.append((content, kwargs))


class FakeInteraction:
    def __init__(self):
        self.user = type("User", (), {"id": 1})()
        self.response = FakeResponse()
        self.followup = FakeFollowup()


async def test_uma_command_posts_and_remembers(bot):
    image = make_image("9")
    client = bot({1: FakeChannel()}, image)
    interaction = FakeInteraction()
    await client.tree.get_command("uma").callback(interaction)
    assert interaction.response.deferred
    [(content, kwargs)] = interaction.followup.messages
    assert kwargs["embed"].image.url == image.image_url
    assert client.history.has_posted(image)
    assert client.history.last_daily is None  # doesn't count as the daily post


async def test_uma_command_when_nothing_found(bot):
    client = bot({1: FakeChannel()}, None)
    interaction = FakeInteraction()
    await client.tree.get_command("uma").callback(interaction)
    [(content, _)] = interaction.followup.messages
    assert "Couldn't find" in content


async def test_uma_status_command(bot):
    client = bot({1: FakeChannel(), 2: FakeChannel()}, None, POST_TIME="09:30", TIMEZONE="Europe/Warsaw")
    interaction = FakeInteraction()
    await client.tree.get_command("uma_status").callback(interaction)
    [(content, kwargs)] = interaction.response.messages
    assert kwargs["ephemeral"]
    assert "<#1>, <#2>" in content and "Danbooru, Safebooru, Konachan" in content
    assert "never" in content


async def test_setup_hook_builds_sources_and_starts_loop(tmp_path, monkeypatch):
    config = Config.from_env({"DISCORD_TOKEN": "t", "CHANNEL_IDS": "1", "STATE_FILE": str(tmp_path / "s.json")})
    client = UmaBot(config)
    synced = []

    async def fake_sync(guild=None):
        synced.append(guild)
        return []

    monkeypatch.setattr(client.tree, "sync", fake_sync)
    await client.setup_hook()
    try:
        assert [s.name for s in client.picker.sources] == ["danbooru", "safebooru", "konachan"]
        assert synced == [None]
        assert not client._daily_task.done()  # waiting for the gateway to be ready
    finally:
        await client.close()
    assert client.session.closed
