from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from umabot.schedule import is_due, local_day, next_run_after, seconds_until, sleep_until

WARSAW = ZoneInfo("Europe/Warsaw")


def test_next_run_later_today():
    now = datetime(2026, 6, 1, 7, 0, tzinfo=timezone.utc)  # 09:00 in Warsaw (CEST)
    target = next_run_after(now, time(12, 0), WARSAW)
    assert target == datetime(2026, 6, 1, 12, 0, tzinfo=WARSAW)
    assert seconds_until(target, now) == 3 * 3600


def test_next_run_tomorrow_once_passed():
    now = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)  # 12:00 Warsaw exactly
    assert next_run_after(now, time(12, 0), WARSAW) == datetime(2026, 6, 2, 12, 0, tzinfo=WARSAW)


def test_dst_change_is_respected():
    # Clocks go back on 2026-10-25 in Europe, so that day is 25 hours long.
    now = datetime(2026, 10, 24, 10, 30, tzinfo=timezone.utc)  # 12:30 CEST
    target = next_run_after(now, time(12, 0), WARSAW)
    assert target.date().isoformat() == "2026-10-25"
    assert target.astimezone(timezone.utc).hour == 11  # 12:00 CET
    assert seconds_until(target, now) == 24.5 * 3600


def test_is_due_and_local_day():
    late_evening_utc = datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)  # already Jan 2 in Warsaw
    assert local_day(late_evening_utc, WARSAW) == "2026-01-02"
    assert not is_due(late_evening_utc, time(9, 0), WARSAW)
    assert is_due(late_evening_utc, time(0, 15), WARSAW)


async def test_sleep_until_returns_once_target_passed():
    target = datetime(2026, 1, 1, tzinfo=timezone.utc)
    await sleep_until(target, clock=lambda: datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc))
