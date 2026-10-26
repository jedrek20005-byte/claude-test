"""Time-of-day maths for the daily post (DST-safe)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, time, timedelta, timezone, tzinfo


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _post_time_on(day: datetime, post_time: time, tz: tzinfo) -> datetime:
    return datetime.combine(day.date(), post_time, tzinfo=tz)


def next_run_after(now: datetime, post_time: time, tz: tzinfo) -> datetime:
    local_now = now.astimezone(tz)
    target = _post_time_on(local_now, post_time, tz)
    if target <= local_now:
        target = _post_time_on(local_now + timedelta(days=1), post_time, tz)
    return target


def is_due(now: datetime, post_time: time, tz: tzinfo) -> bool:
    local_now = now.astimezone(tz)
    return local_now >= _post_time_on(local_now, post_time, tz)


def local_day(now: datetime, tz: tzinfo) -> str:
    return now.astimezone(tz).date().isoformat()


def seconds_until(target: datetime, now: datetime) -> float:
    # Subtracting two datetimes that share a zoneinfo ignores DST shifts, so go via UTC.
    return (target.astimezone(timezone.utc) - now.astimezone(timezone.utc)).total_seconds()


async def sleep_until(target: datetime, *, clock: Callable[[], datetime] = utcnow) -> None:
    # Sleep in chunks so a suspended machine or clock change can't make us oversleep by hours.
    while (remaining := seconds_until(target, clock())) > 0:
        await asyncio.sleep(min(remaining, 3600))
