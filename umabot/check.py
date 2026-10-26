"""`python -m umabot check`: query every enabled source once, without Discord."""

from __future__ import annotations

from .config import Config
from .filters import ContentFilter
from .posting import make_session
from .sources import SourceError, build_sources


async def run_check(config: Config) -> int:
    content_filter = ContentFilter(config.max_rating, config.blacklist, config.min_score)
    working = 0
    async with make_session(config.user_agent) as session:
        for source in build_sources(config, session):
            try:
                posts = await source.fetch_page(0)
                usable = [post for post in posts if content_filter.allows(post)]
                example = None
                for candidate in usable[:3]:
                    # Resolving can reveal more tags, so filter again like the picker does.
                    resolved = await source.resolve(candidate)
                    if content_filter.allows(resolved):
                        example = resolved
                        break
            except SourceError as exc:
                print(f"[FAIL]  {source.display_name}: {exc}")
                continue
            status = "OK" if example else "EMPTY"
            print(
                f"[{status}]{' ' * (6 - len(status))}{source.display_name}: {len(posts)} posts on the first page "
                f"for {source.tags!r}, {len(usable)} pass the SFW filter"
            )
            if example:
                working += 1
                print(f"        e.g. {example.page_url}\n             {example.image_url}")
    print(f"\n{working}/{len(config.sources)} source(s) working.")
    return 0 if working else 1
