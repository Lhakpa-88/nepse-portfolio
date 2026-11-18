"""NEPSE trading calendar helpers (Asia/Kathmandu, UTC+5:45)."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAL = json.loads((ROOT / "config" / "holidays.json").read_text(encoding="utf-8"))
NPT = timezone(timedelta(hours=5, minutes=45), "NPT")


def now_npt() -> datetime:
    return datetime.now(NPT)


def is_trading_day(d: date) -> bool:
    # Python weekday(): Mon=0 ... Fri=4, Sat=5. NEPSE is closed Friday & Saturday.
    return d.weekday() not in CAL["weekendDays"] and d.isoformat() not in CAL["holidays"]


def _hm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def session(now: datetime | None = None) -> str:
    """'pre' | 'open' | 'post' | 'closed' for the given Nepal time."""
    now = now or now_npt()
    if not is_trading_day(now.date()):
        return "closed"
    t = (now.hour, now.minute)
    if t < _hm(CAL["open"]):
        return "pre"
    return "open" if t < _hm(CAL["close"]) else "post"


def last_expected_trading_date(now: datetime | None = None) -> date:
    """Most recent date for which a closing/intraday price should exist."""
    now = now or now_npt()
    d = now.date()
    if is_trading_day(d) and (now.hour, now.minute) >= _hm(CAL["open"]):
        return d
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def sessions_between(earlier: str | None, later: str | None) -> int | None:
    """Trading sessions after `earlier` up to and including `later` (0 when they are the same day)."""
    if not earlier or not later:
        return None
    a, b = date.fromisoformat(earlier[:10]), date.fromisoformat(later[:10])
    n = 0
    while b > a and n < 400:
        if is_trading_day(b):
            n += 1
        b -= timedelta(days=1)
    return n


def freshness(market_date: str | None, now: datetime | None = None) -> dict:
    """Classifies how current the market data is. Never silently trusts stale data."""
    now = now or now_npt()
    expected = last_expected_trading_date(now)
    if not market_date:
        return {"state": "unavailable", "expected": expected.isoformat(), "lagTradingDays": None,
                "message": "No market data available."}
    md = date.fromisoformat(market_date[:10])
    lag, d = 0, expected
    while d > md and lag < 30:
        if is_trading_day(d):
            lag += 1
        d -= timedelta(days=1)
    if lag == 0:
        state, msg = "fresh", f"Prices are for {md.isoformat()} (latest expected session)."
    elif lag == 1:
        state, msg = "delayed", (f"Prices are for {md.isoformat()}; the {expected.isoformat()} session is missing "
                                 "(possible market holiday or source delay).")
    else:
        state, msg = "stale", f"Prices are {lag} trading sessions old (last: {md.isoformat()}). Do not act on them."
    return {"state": state, "expected": expected.isoformat(), "lagTradingDays": lag, "message": msg}
