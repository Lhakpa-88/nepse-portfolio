"""Technical indicators computed from daily history rows [date, o, h, l, c, v].

Pure functions, standard definitions (Wilder RSI, 12/26/9 MACD, 20/2 Bollinger).
Every indicator returns None when there is not enough history - callers must
treat None as "unknown", never as zero.
"""
from __future__ import annotations

import math


def sma(xs: list[float], n: int):
    return sum(xs[-n:]) / n if len(xs) >= n else None


def ema_series(xs: list[float], n: int) -> list[float]:
    if len(xs) < n:
        return []
    k = 2 / (n + 1)
    out = [sum(xs[:n]) / n]
    for x in xs[n:]:
        out.append(x * k + out[-1] * (1 - k))
    return out


def rsi(closes: list[float], n: int = 14):
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    if al == 0:
        return 100.0 if ag > 0 else 50.0
    return 100 - 100 / (1 + ag / al)


def macd(closes: list[float]):
    if len(closes) < 35:
        return None
    e12, e26 = ema_series(closes, 12), ema_series(closes, 26)
    line = [a - b for a, b in zip(e12[-len(e26):], e26)]
    sig = ema_series(line, 9)
    if len(sig) < 2:
        return None
    return {"macd": line[-1], "signal": sig[-1], "hist": line[-1] - sig[-1],
            "prevHist": line[-2] - sig[-2]}


def bollinger(closes: list[float], n: int = 20, k: float = 2.0):
    if len(closes) < n:
        return None
    w = closes[-n:]
    m = sum(w) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in w) / n)
    return {"mid": m, "upper": m + k * sd, "lower": m - k * sd,
            "pctB": (closes[-1] - (m - k * sd)) / (2 * k * sd) if sd else 0.5,
            "width": 2 * k * sd / m if m else None}


def pct_return(closes: list[float], n: int):
    return (closes[-1] / closes[-1 - n] - 1) * 100 if len(closes) > n and closes[-1 - n] else None


def daily_returns(closes: list[float]) -> list[float]:
    return [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1]]


def volatility(closes: list[float], days_per_year: int = 230, window: int = 120):
    r = daily_returns(closes[-(window + 1):])
    if len(r) < 20:
        return None
    m = sum(r) / len(r)
    return math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) * math.sqrt(days_per_year) * 100


def max_drawdown(values: list[float]):
    peak, mdd = -math.inf, 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            mdd = min(mdd, v / peak - 1)
    return mdd * 100 if values else None


def analyse(rows: list[list], days_per_year: int = 230) -> dict:
    """Full technical snapshot for one symbol."""
    rows = [r for r in rows if r[4]]
    closes = [r[4] for r in rows]
    highs = [r[2] or r[4] for r in rows]
    lows = [r[3] or r[4] for r in rows]
    vols = [r[5] or 0 for r in rows]
    n = len(closes)
    out: dict = {"bars": n, "lastDate": rows[-1][0] if rows else None}
    if n < 2:
        return out
    c = closes[-1]
    out.update({
        "close": c, "sma20": sma(closes, 20), "sma50": sma(closes, 50), "sma200": sma(closes, 200),
        "rsi14": rsi(closes), "macd": macd(closes), "bollinger": bollinger(closes),
        "ret1w": pct_return(closes, 5), "ret1m": pct_return(closes, 21), "ret3m": pct_return(closes, 63),
        "ret1y": pct_return(closes, min(n - 1, days_per_year)) if n > 200 else None,
        "volatility": volatility(closes, days_per_year),
        "high52": max(highs[-days_per_year:]), "low52": min(lows[-days_per_year:]),
        "window52Days": min(n, days_per_year),
    })
    out["fromHigh52"] = (c / out["high52"] - 1) * 100 if out["high52"] else None
    out["rangePos52"] = ((c - out["low52"]) / (out["high52"] - out["low52"]) * 100
                         if out["high52"] > out["low52"] else None)
    # Support / resistance from recent swing extremes (excluding today so breakouts are detectable)
    if n >= 21:
        out["support20"], out["resistance20"] = min(lows[-21:-1]), max(highs[-21:-1])
    if n >= 61:
        out["support60"], out["resistance60"] = min(lows[-61:-1]), max(highs[-61:-1])
    avg_vol = sum(vols[-21:-1]) / 20 if n >= 21 else None
    out["avgVol20"] = avg_vol
    out["volRatio"] = vols[-1] / avg_vol if avg_vol else None
    out["avgTurnover20"] = (sum(v * p for v, p in zip(vols[-20:], closes[-20:])) / 20) if n >= 20 else None
    r20 = out.get("resistance20")
    s20 = out.get("support20")
    vr = out["volRatio"] or 0
    out["breakout"] = bool(r20 and c > r20 and vr >= 1.5)
    out["breakdown"] = bool(s20 and c < s20)
    if n >= 20:
        out["tradingRange"] = {"low": min(lows[-20:]), "high": max(highs[-20:])}
    dc = (c / closes[-2] - 1) * 100 if closes[-2] else 0
    out["dayChange"] = dc
    signals = []
    s50, s200 = out["sma50"], out["sma200"]
    if out["breakout"]:
        signals.append("Breakout above 20-day high on strong volume")
    if out["breakdown"]:
        signals.append("Breakdown below 20-day low")
    if s50 and s200:
        signals.append("50-day MA above 200-day MA (uptrend)" if s50 > s200 else "50-day MA below 200-day MA (downtrend)")
    if out["rsi14"] is not None:
        if out["rsi14"] >= 70:
            signals.append(f"RSI {out['rsi14']:.0f}: overbought")
        elif out["rsi14"] <= 30:
            signals.append(f"RSI {out['rsi14']:.0f}: oversold")
    m = out["macd"]
    if m:
        if m["hist"] > 0 >= m["prevHist"]:
            signals.append("MACD bullish crossover")
        elif m["hist"] < 0 <= m["prevHist"]:
            signals.append("MACD bearish crossover")
    if vr >= 2.5:
        signals.append(f"Unusual volume: {vr:.1f}x 20-day average")
    out["signals"] = signals
    return out
