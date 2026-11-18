"""Transparent, rule-based scoring model (no black box, no LLM).

Three SEPARATE scores are produced and never blended into one number:
  * quality  - investment quality (weights from config/scoring.json)
  * trading  - short-term trading opportunity (technical/volume driven)
  * risk     - risk exposure (higher = riskier)
plus a confidence figure that falls when data is missing or stale.

Every component is a 0-100 sub-score with the raw evidence kept next to it,
so each recommendation can be audited line by line in the dashboard.
"""
from __future__ import annotations

import math
from statistics import median

BFI_SECTORS = {"Commercial Banks", "Development Banks", "Finance", "Microfinance"}


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


def scale(x, lo, hi):
    """Linear map lo->0, hi->100 (inverted automatically when lo > hi)."""
    if x is None:
        return None
    return clamp((x - lo) / (hi - lo) * 100)


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def pct_rank(value, population):
    pop = [p for p in population if p is not None]
    if value is None or len(pop) < 5:
        return None
    return sum(1 for p in pop if p <= value) / len(pop) * 100


def sector_stats(universe: dict) -> dict:
    """Peer medians per sector. `universe` = symbol -> {sector, pe, pb, roe, ret1m}."""
    by: dict[str, dict[str, list]] = {}
    for u in universe.values():
        s = by.setdefault(u.get("sector") or "Unknown", {"pe": [], "pb": [], "roe": [], "ret1m": [], "eps": []})
        if u.get("pe") and 0 < u["pe"] < 200:
            s["pe"].append(u["pe"])
        if u.get("pb") and 0 < u["pb"] < 50:
            s["pb"].append(u["pb"])
        for k in ("roe", "ret1m", "eps"):
            if u.get(k) is not None:
                s[k].append(u[k])
    return {sec: {"n": max(len(v["pe"]), len(v["roe"]), len(v["ret1m"])),
                  "medianPE": median(v["pe"]) if len(v["pe"]) >= 3 else None,
                  "medianPB": median(v["pb"]) if len(v["pb"]) >= 3 else None,
                  "medianROE": median(v["roe"]) if len(v["roe"]) >= 3 else None,
                  "avgRet1m": mean(v["ret1m"]), "_roe": v["roe"], "_eps": v["eps"]}
            for sec, v in by.items()}


def fundamental_score(f: dict | None, sector: str, sstats: dict) -> dict:
    if not f or f.get("eps") is None:
        return {"score": None, "coverage": 0.0, "components": {}, "outlook": "Unknown",
                "notes": ["No reported fundamentals available from the data source."]}
    comp, notes = {}, []
    eps, roe = f.get("eps"), f.get("roe")
    comp["earnings"] = 0.0 if eps <= 0 else scale(eps, 0, 40)
    comp["roe"] = scale(roe, 0, 20)
    comp["epsGrowth"] = scale(f.get("epsGrowthYoY"), -30, 30)
    comp["peerRoe"] = pct_rank(roe, sstats.get("_roe", []))
    comp["bookValue"] = scale(f.get("bookValue"), 80, 250)
    divs = f.get("dividends") or []
    comp["dividend"] = scale(divs[0]["cash"] + divs[0]["bonus"], 0, 20) if divs else None
    applicable = 6
    if sector in BFI_SECTORS:
        applicable = 8
        comp["assetQuality"] = scale(f.get("npl"), 6, 1)
        comp["capitalAdequacy"] = scale(f.get("car"), 10, 15)
        if f.get("npl") is not None and f["npl"] > 5:
            notes.append(f"High non-performing loans: {f['npl']:.2f}%")
        if f.get("car") is not None and f["car"] < 11:
            notes.append(f"Capital adequacy {f['car']:.2f}% is near/below the regulatory minimum")
    if eps <= 0:
        notes.append("Company is loss-making (negative EPS)")
    g = f.get("epsGrowthYoY")
    if g is not None:
        notes.append(f"EPS {'up' if g >= 0 else 'down'} {abs(g):.0f}% vs same quarter last year")
    if comp.get("peerRoe") is not None:
        notes.append(f"ROE {roe:.1f}% ranks at the {comp['peerRoe']:.0f}th percentile of its sector")
    avail = {k: v for k, v in comp.items() if v is not None}
    score = mean(avail.values())
    return {"score": score, "coverage": len(avail) / applicable, "components": comp, "notes": notes,
            "outlook": "Positive" if score >= 60 else "Negative" if score < 40 else "Neutral"}


def valuation_score(price: float, f: dict | None, sstats: dict) -> dict:
    if not f or f.get("eps") is None:
        return {"score": None, "coverage": 0.0, "components": {}, "notes": [], "pe": None, "pb": None, "divYield": None}
    comp, notes = {}, []
    eps, bv = f.get("eps"), f.get("bookValue")
    pe = price / eps if eps and eps > 0 else None
    pb = price / bv if bv and bv > 0 else None
    mpe, mpb = sstats.get("medianPE"), sstats.get("medianPB")
    if eps is not None and eps <= 0:
        comp["pe"] = 0.0
        notes.append("Negative earnings: P/E not meaningful")
    elif pe is not None:
        rel = scale(pe / mpe, 1.6, 0.5) if mpe else None
        absolute = scale(pe, 45, 8)
        comp["pe"] = mean([rel, absolute])
        notes.append(f"P/E {pe:.1f}" + (f" vs sector median {mpe:.1f}" if mpe else ""))
    if pb is not None:
        rel = scale(pb / mpb, 1.6, 0.5) if mpb else None
        comp["pb"] = mean([rel, scale(pb, 5, 1)])
        notes.append(f"P/B {pb:.2f}" + (f" vs sector median {mpb:.2f}" if mpb else ""))
    divs = f.get("dividends") or []
    dy = divs[0]["cash"] / price * 100 if divs and price else None   # cash % of Rs 100 par = Rs per share
    if dy is not None:
        comp["dividendYield"] = scale(dy, 0, 6)
        if dy > 0:
            notes.append(f"Cash dividend yield {dy:.1f}% (FY {divs[0]['fiscalYear']})")
    avail = [v for v in comp.values() if v is not None]
    return {"score": mean(avail), "coverage": len(avail) / 3, "components": comp, "notes": notes,
            "pe": pe, "pb": pb, "divYield": dy}


def technical_score(t: dict) -> dict:
    if t.get("bars", 0) < 30:
        return {"score": None, "coverage": 0.0, "components": {}, "outlook": "Unknown",
                "notes": [f"Only {t.get('bars', 0)} days of price history - technicals unavailable"]}
    c, comp = t["close"], {}
    trend = [100.0 if c > t[k] else 0.0 for k in ("sma20", "sma50", "sma200") if t.get(k)]
    if t.get("sma50") and t.get("sma200"):
        trend.append(100.0 if t["sma50"] > t["sma200"] else 0.0)
    comp["trend"] = mean(trend)
    r = t.get("rsi14")
    if r is not None:
        comp["rsi"] = 35.0 if r >= 75 else 55.0 if r >= 70 else 80.0 if r >= 50 else 45.0 if r >= 30 else 40.0
    m = t.get("macd")
    if m:
        comp["macd"] = (75.0 if m["hist"] > 0 else 25.0) + (15.0 if m["hist"] > m["prevHist"] else -15.0)
    comp["momentum"] = scale(t.get("ret1m"), -12, 12)
    vr, dc = t.get("volRatio"), t.get("dayChange", 0)
    if vr is not None:
        comp["volume"] = 80.0 if vr >= 1.5 and dc > 0 else 20.0 if vr >= 1.5 and dc < 0 else 50.0
    if t.get("breakout"):
        comp["breakout"] = 100.0
    elif t.get("breakdown"):
        comp["breakout"] = 0.0
    weights = {"trend": 3, "rsi": 1.5, "macd": 2, "momentum": 2, "volume": 1, "breakout": 1.5}
    avail = {k: v for k, v in comp.items() if v is not None}
    score = sum(v * weights[k] for k, v in avail.items()) / sum(weights[k] for k in avail) if avail else None
    cov = min(1.0, t["bars"] / 200) * (len([k for k in ("trend", "rsi", "macd", "momentum") if k in avail]) / 4)
    notes = list(t.get("signals", []))
    if t["bars"] < 200:
        notes.append(f"{t['bars']} days of history: 200-day average not available")
    return {"score": score, "coverage": cov, "components": comp, "notes": notes,
            "outlook": "Unknown" if score is None else "Bullish" if score >= 62 else "Bearish" if score <= 40 else "Neutral"}


def market_regime(nepse_t: dict, breadth: dict | None) -> dict:
    """Overall market trend indicator from the NEPSE index itself."""
    comp = {}
    if nepse_t.get("close"):
        c = nepse_t["close"]
        for k in ("sma20", "sma50", "sma200"):
            if nepse_t.get(k):
                comp[k] = 100.0 if c > nepse_t[k] else 0.0
        comp["momentum"] = scale(nepse_t.get("ret1m"), -8, 8)
    if breadth and (breadth.get("advancers", 0) + breadth.get("decliners", 0)) > 0:
        comp["breadth"] = breadth["advancers"] / (breadth["advancers"] + breadth["decliners"]) * 100
    score = mean(comp.values())
    label = "Unknown" if score is None else "Bullish" if score >= 62 else "Bearish" if score <= 40 else "Sideways"
    return {"score": score, "label": label, "components": comp}


def market_score(regime: dict, sstats: dict, sector_day_change) -> dict:
    comp = {"market": regime.get("score"),
            "sectorMomentum": scale(sstats.get("avgRet1m"), -8, 8),
            "sectorToday": scale(sector_day_change, -2, 2)}
    w = {"market": 0.5, "sectorMomentum": 0.35, "sectorToday": 0.15}
    avail = {k: v for k, v in comp.items() if v is not None}
    score = sum(v * w[k] for k, v in avail.items()) / sum(w[k] for k in avail) if avail else None
    notes = []
    if regime.get("label") not in (None, "Unknown"):
        notes.append(f"NEPSE trend: {regime['label']}")
    if sstats.get("avgRet1m") is not None:
        notes.append(f"Sector stocks moved {sstats['avgRet1m']:+.1f}% on average over the last month")
    if sector_day_change is not None:
        notes.append(f"Sector index {sector_day_change:+.2f}% today")
    # every score block has the same shape (score, coverage, components, notes): the dashboard relies on it
    return {"score": score, "coverage": len(avail) / 3, "components": comp, "notes": notes}


def risk_score(t: dict, f: dict | None, val: dict, sector: str, levels: dict) -> dict:
    comp, notes = {}, []
    comp["volatility"] = scale(t.get("volatility"), 20, 70)
    to = t.get("avgTurnover20")
    if to is not None:
        comp["liquidity"] = clamp(100 - (math.log10(max(to, 1)) - 5.5) / 1.5 * 100)   # ~3 lakh -> 100, ~1 crore -> 0
        if comp["liquidity"] >= 70:
            notes.append(f"Thin trading: average daily turnover about NPR {to:,.0f}")
    comp["drawdown"] = scale(-(t.get("fromHigh52") or 0), 0, 50) if t.get("fromHigh52") is not None else None
    if f and f.get("eps") is not None:
        fr = 100.0 if f["eps"] <= 0 else 70.0 if (val.get("pe") or 0) > 50 else 20.0
        if sector in BFI_SECTORS and f.get("npl") is not None and f["npl"] > 5:
            fr = max(fr, 75.0)
        comp["financial"] = fr
    else:
        comp["financial"] = 65.0
        notes.append("Financial risk cannot be assessed (no fundamentals) - treated as elevated")
    if t.get("volatility") is not None and t["volatility"] >= 50:
        notes.append(f"High price volatility ({t['volatility']:.0f}% annualised)")
    w = {"volatility": 0.3, "liquidity": 0.25, "drawdown": 0.15, "financial": 0.3}
    avail = {k: v for k, v in comp.items() if v is not None}
    score = sum(v * w[k] for k, v in avail.items()) / sum(w[k] for k in avail) if avail else None
    level = "Unknown" if score is None else "Low" if score < levels["low"] else "Medium" if score < levels["medium"] else "High"
    return {"score": score, "level": level, "components": comp, "notes": notes}


def combine(parts: dict, weights: dict) -> tuple[float | None, float]:
    """Weighted quality score over AVAILABLE areas; returns (score, weightCoverage 0-1)."""
    vals = {"fundamental": parts["fundamental"]["score"], "technical": parts["technical"]["score"],
            "valuation": parts["valuation"]["score"], "market": parts["market"]["score"],
            "risk": None if parts["risk"]["score"] is None else 100 - parts["risk"]["score"]}
    avail = {k: v for k, v in vals.items() if v is not None}
    wsum = sum(weights[k] for k in avail)
    if not avail or wsum == 0:
        return None, 0.0
    return sum(v * weights[k] for k, v in avail.items()) / wsum, wsum / sum(weights.values())


def trading_score(t: dict, tech: dict, risk: dict) -> float | None:
    if tech["score"] is None:
        return None
    liq = risk["components"].get("liquidity")
    parts = [(tech["score"], 0.45), (scale(t.get("ret1w"), -6, 6), 0.2),
             (scale(t.get("volRatio"), 0.5, 2.5), 0.2), (None if liq is None else 100 - liq, 0.15)]
    parts = [(v, w) for v, w in parts if v is not None]
    return sum(v * w for v, w in parts) / sum(w for _, w in parts)


def stance(quality, parts: dict, th: dict) -> tuple[str, list[str]]:
    """Market-level stance for a stock (before any personal position adjustments)."""
    reasons = []
    fund, tech, risk = parts["fundamental"], parts["technical"], parts["risk"]
    if fund["score"] is None:
        return "WATCH", ["Incomplete: no fundamental data - cannot form an investment view on price action alone"]
    if quality is None:
        return "WATCH", ["Incomplete data"]
    if quality >= th["buy"] and fund["score"] >= 60 and tech["outlook"] != "Bearish" and risk["level"] != "High":
        return "BUY", reasons
    if quality >= th["accumulate"] and fund["score"] >= 50 and risk["level"] != "High":
        if tech["outlook"] == "Bearish":
            return "WATCH", ["Fundamentally sound but the price trend is still bearish - wait for stabilisation"]
        return "ACCUMULATE", reasons
    if quality >= th["hold"]:
        return "HOLD", reasons
    if quality >= th["reduce"]:
        return "REDUCE", reasons
    return "SELL", reasons
