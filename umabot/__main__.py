from __future__ import annotations

import argparse
import asyncio
import logging
import sys

import discord
from dotenv import load_dotenv

from .config import Config, ConfigError

log = logging.getLogger("umabot")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m umabot", description="Daily SFW Umamusume pictures for Discord.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("run", "check"),
        default="run",
        help="'run' starts the bot (default); 'check' tests the image sources without Discord",
    )
    parser.add_argument("--env-file", default=".env", help="file to load settings from (default: .env)")
    args = parser.parse_args(argv)

    load_dotenv(args.env_file)
    discord.utils.setup_logging(level=logging.INFO, root=True)
    try:
        config = Config.from_env(require_discord=args.command == "run")
    except ConfigError as exc:
        log.error("Configuration error: %s", exc)
        return 2

    if args.command == "check":
        from .check import run_check

        return asyncio.run(run_check(config))

    from .bot import UmaBot

    UmaBot(config).run(config.discord_token, log_handler=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
