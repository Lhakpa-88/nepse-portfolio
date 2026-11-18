"""Builds analysis.json: technicals, scores, stance, screens and rankings for every stock."""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from backend.collect import read_json, safe, write_json
from . import scoring as sc
from . import technicals as ta

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "scoring.json").read_text(encoding="utf-8"))

CATEGORIES = {
    "strong": "Fundamentally Strong Companies",
    "undervalued": "Undervalued Stocks",
    "dividend": "Dividend-Paying Stocks",
    "growth": "Growth Potential Stocks",
    "breakout": "Technical Breakout Opportunities",
    "trading": "Short-Term Trading Opportunities",
    "volume": "Stocks Showing Unusual Volume",
    "entry": "Stocks Approaching Attractive Entry Prices",
    "avoid": "High-Risk Stocks to Avoid",
}


def rnd(x, n=2):
    return None if x is None else round(x, n)


def round_deep(o, n=2):
    if isinstance(o, float):
        return round(o, n)
    if isinstance(o, dict):
        return {k: round_deep(v, n) for k, v in o.items()}
    if isinstance(o, list):
        return [round_deep(v, n) for v in o]
    return o


def price_levels(price: float, t: dict) -> dict:
    """Entry zone, upside and downside reference levels derived from actual price structure."""
    sup = t.get("support60") or t.get("support20")
    res = t.get("resistance60") or t.get("resistance20")
    hi = min(price, t["sma20"]) if t.get("sma20") else price
    lo = max(sup, hi * 0.95) if sup and sup < hi else hi * 0.95
    upside = res if res and res > price * 1.03 else (t.get("high52") if t.get("high52") and t["high52"] > price * 1.03 else None)
    downside = sup if sup and sup < price else price * 0.92
    return {"entryLow": lo, "entryHigh": hi, "upsideTarget": upside,
            "upsidePct": (upside / price - 1) * 100 if upside else None,
            "downsideLevel": downside, "downsidePct": (downside / price - 1) * 100,
            "stopLoss": downside * 0.98,
            "basis": "Entry zone: 20-day average down to 60-day support. Upside: nearest resistance / 52-week high. "
                     "Downside: 60-day support. These are reference levels from past prices, not forecasts."}


def categorise(e: dict) -> list[str]:
    cats = []
    f, v, t, r = e["fundamental"], e["valuation"], e["tech"], e["risk"]
    fs, vs, q = f["score"], v["score"], e["quality"]
    fd = e.get("fundamentals") or {}
    eps = fd.get("eps")
    high_risk = r["level"] == "High"
    if fs is not None and fs >= 68 and f["coverage"] >= 0.6 and not high_risk:
        cats.append("strong")
    # "Undervalued" requires earnings and acceptable fundamentals - never just a fallen price.
    if vs is not None and vs >= 65 and eps and eps > 0 and fs is not None and fs >= 50:
        cats.append("undervalued")
    divs = fd.get("dividends") or []
    if v.get("divYield") and v["divYield"] >= 3 and sum(1 for d in divs[:3] if d["cash"] > 0) >= 2:
        cats.append("dividend")
    if (fd.get("epsGrowthYoY") or 0) >= 15 and (fd.get("roe") or 0) >= 10 and eps and eps > 0:
        cats.append("growth")
    liquid = (r["components"].get("liquidity") if r["components"].get("liquidity") is not None else 100) < 60
    if t.get("breakout") and liquid:
        cats.append("breakout")
    if e["trading"] is not None and e["trading"] >= 68 and liquid:
        cats.append("trading")
    if (t.get("volRatio") or 0) >= 2.5:
        cats.append("volume")
    lv = e.get("levels")
    if lv and q is not None and q >= 58 and fs is not None and fs >= 55 and e["technical"]["outlook"] != "Bearish" \
            and lv["entryLow"] <= e["price"] <= lv["entryHigh"] * 1.01:
        cats.append("entry")
    if high_risk or (eps is not None and eps <= 0) or (q is not None and q < CFG["thresholds"]["reduce"]):
        cats.append("avoid")
    return cats


def build(out: Path) -> dict:
    prices = read_json(out / "prices.json")
    if not prices:
        raise SystemExit("analysis: prices.json missing - run collection first")
    market = read_json(out / "market.json", {})
    fund_store = read_json(out / "fundamentals.json", {"symbols": {}})["symbols"]
    dpy = CFG["tradingDaysPerYear"]
    md = prices["marketDate"]

    techs, universe = {}, {}
    for r in prices["rows"]:
        if r.get("sector") in CFG["excludedSectors"]:
            continue
        h = read_json(out / "history" / f"{safe(r['symbol'])}.json", {"rows": []})
        t = ta.analyse(h["rows"], dpy)
        t["stale"] = t.get("lastDate") != md
        techs[r["symbol"]] = t
        f = fund_store.get(r["symbol"]) or {}
        eps, bv = f.get("eps"), f.get("bookValue")
        universe[r["symbol"]] = {"sector": r.get("sector"), "roe": f.get("roe"), "eps": eps, "ret1m": t.get("ret1m"),
                                 "pe": r["ltp"] / eps if eps and eps > 0 else None,
                                 "pb": r["ltp"] / bv if bv and bv > 0 else None}
    sstats = sc.sector_stats(universe)

    nepse_hist = read_json(out / "history" / "NEPSE.json", {"rows": []})
    nepse_t = ta.analyse(nepse_hist["rows"], dpy)
    regime = sc.market_regime(nepse_t, market.get("breadth"))
    sector_today = {s["name"]: s.get("pctChange") for s in market.get("sectors", [])}

    today = date.fromisoformat(md) if md else date.today()
    stocks = {}
    for r in prices["rows"]:
        sym, sector = r["symbol"], r.get("sector")
        if sym not in techs:
            continue
        t, f, ss = techs[sym], fund_store.get(sym), sstats.get(sector or "Unknown", {})
        if f and f.get("eps") is None:
            f = None
        parts = {
            "fundamental": sc.fundamental_score(f, sector, ss),
            "technical": sc.technical_score(t),
            "valuation": sc.valuation_score(r["ltp"], f, ss),
        }
        parts["market"] = sc.market_score(regime, ss, sector_today.get(sector))
        parts["risk"] = sc.risk_score(t, f, parts["valuation"], sector, CFG["riskLevels"])
        quality, wcov = sc.combine(parts, CFG["weights"])
        trading = sc.trading_score(t, parts["technical"], parts["risk"])
        st, st_reasons = sc.stance(quality, parts, CFG["thresholds"])

        # Confidence: how much of the model is backed by real, current data.
        gaps = list(st_reasons)
        conf = 100 * wcov * (0.5 + 0.5 * sc.mean([parts["fundamental"]["coverage"], parts["technical"]["coverage"],
                                                  parts["valuation"]["coverage"]]))
        if t.get("stale"):
            conf *= 0.7
            gaps.append(f"Price history ends {t.get('lastDate')} (not traded in the latest session)")
        if f is None:
            gaps.append("Fundamentals missing")
        elif f.get("fetchedAt"):
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(f["fetchedAt"])).days
            if age > 45:
                conf *= 0.85
                gaps.append(f"Fundamentals last refreshed {age} days ago")
        if t.get("bars", 0) < 200:
            gaps.append(f"Only {t.get('bars', 0)} trading days of history")

        e = {
            "symbol": sym, "name": r.get("name"), "sector": sector, "price": r["ltp"], "pctChange": r.get("pctChange"),
            "quality": quality, "trading": trading, "confidence": sc.clamp(conf), "stance": st,
            "incomplete": f is None or parts["technical"]["score"] is None,
            "dataGaps": gaps,
            "fundamental": parts["fundamental"], "technical": parts["technical"], "valuation": parts["valuation"],
            "market": parts["market"], "risk": parts["risk"],
            "tech": {k: t.get(k) for k in (
                "sma20", "sma50", "sma200", "rsi14", "macd", "bollinger", "ret1w", "ret1m", "ret3m", "ret1y",
                "volatility", "high52", "low52", "window52Days", "fromHigh52", "rangePos52", "support20",
                "resistance20", "support60", "resistance60", "avgVol20", "volRatio", "avgTurnover20", "breakout",
                "breakdown", "tradingRange", "bars", "lastDate")},
            "fundamentals": f and {k: f.get(k) for k in (
                "period", "eps", "bookValue", "roe", "roa", "npl", "car", "cdRatio", "netProfit", "paidUpCapital",
                "epsGrowthYoY", "profitGrowthYoY", "trend", "dividends", "fetchedAt")},
            "levels": price_levels(r["ltp"], t) if t.get("bars", 0) >= 21 else None,
            "horizon": {
                "long": st if st in ("BUY", "ACCUMULATE", "HOLD", "REDUCE", "SELL") else "No view (incomplete data)",
                "short": ("Unknown" if trading is None else "Bullish setup" if trading >= 68
                          else "Weak setup" if trading < 40 else "Neutral"),
            },
        }
        e["categories"] = categorise(e)
        stocks[sym] = e

    ranked = sorted((e for e in stocks.values()
                     if e["quality"] is not None and not e["incomplete"] and e["risk"]["level"] != "High"
                     and e["fundamental"]["score"] >= 55 and e["stance"] in ("BUY", "ACCUMULATE")),
                    key=lambda e: e["quality"] * e["confidence"] / 100, reverse=True)
    sector_perf = []
    for sec, ss in sorted(sstats.items()):
        members = [e for e in stocks.values() if (e["sector"] or "Unknown") == sec]
        ch = [e["pctChange"] for e in members if e["pctChange"] is not None]
        sector_perf.append({"sector": sec, "count": len(members), "avgDayChange": sc.mean(ch), "avgRet1m": ss["avgRet1m"],
                            "indexDayChange": sector_today.get(sec), "medianPE": ss["medianPE"],
                            "medianPB": ss["medianPB"], "medianROE": ss["medianROE"]})
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "marketDate": md,
        "weights": CFG["weights"], "thresholds": CFG["thresholds"], "riskLevels": CFG["riskLevels"],
        "regime": {**regime, "nepse": {k: nepse_t.get(k) for k in (
            "close", "sma20", "sma50", "sma200", "rsi14", "ret1w", "ret1m", "ret3m", "ret1y", "volatility",
            "high52", "low52", "fromHigh52")}},
        "sectorPerformance": sector_perf,
        "categories": CATEGORIES,
        "top10": [{"symbol": e["symbol"], "rankScore": e["quality"] * e["confidence"] / 100} for e in ranked[:10]],
        "methodology": "rankScore = investment-quality score x confidence. Eligible only if fundamentals are present, "
                       "fundamental score >= 55, risk level is not High and stance is BUY/ACCUMULATE. "
                       "A falling price alone never qualifies a stock.",
        "coverage": {"stocks": len(stocks), "withFundamentals": sum(1 for e in stocks.values() if e["fundamentals"]),
                     "with200d": sum(1 for e in stocks.values() if (e["tech"]["bars"] or 0) >= 200)},
        "stocks": stocks,
    }
    for ss in sstats.values():
        ss.pop("_roe", None)
        ss.pop("_eps", None)
    result = round_deep(result)
    write_json(out / "analysis.json", result)
    return result
