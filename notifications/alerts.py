"""Alert engine: turns portfolio + market analysis + news into a SMALL number of actionable alerts.

Noise control: thresholds in config/alerts.json, a per-alert cooldown and a
per-run cap. The de-duplication state is stored as keyed digests so the public
data branch never reveals which stocks are held (see _digester).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend import market_calendar as cal
from backend import portfolio as pf
from backend.collect import read_json, write_json

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "alerts.json").read_text(encoding="utf-8"))
FEES = json.loads((ROOT / "config" / "fees.json").read_text(encoding="utf-8"))
ORDER = ["SELL", "REDUCE", "HOLD", "ACCUMULATE", "BUY"]
PRIORITY = {"stop": 0, "critical_news": 1, "target": 2, "support": 3, "signal": 4, "loss": 5, "move": 6,
            "portfolio": 6, "concentration": 7, "holding_news": 7, "watch": 8, "volume": 9, "opportunity": 10}


def n(x, d=0):
    return "n/a" if x is None else f"{x:,.{d}f}"


def cap(action: str, limit: str) -> str:
    return action if action == "WATCH" else ORDER[min(ORDER.index(action), ORDER.index(limit))]


def position_signal(h: dict, a: dict | None, plan: dict, weight: float | None, limit: float) -> tuple[str, list[str]]:
    """Position-aware signal (compact mirror of frontend/src/lib/recommend.ts)."""
    if not a or not h.get("ltp"):
        return "WATCH", ["No current market analysis for this symbol - recommendation incomplete"]
    action, reasons, ltp, t = a["stance"], [], h["ltp"], a["tech"]
    if plan.get("stop") and ltp <= plan["stop"]:
        action = "SELL"
        reasons.append(f"Stop-loss {n(plan['stop'], 1)} breached")
    if plan.get("target") and ltp >= plan["target"]:
        action = cap("REDUCE" if action == "WATCH" else action, "REDUCE")
        reasons.append(f"Target {n(plan['target'], 1)} reached")
    sup = t.get("support60") or t.get("support20")
    if sup and ltp < sup:
        action = cap(action, "HOLD") if action in ("BUY", "ACCUMULATE") else action
        reasons.append(f"Below support {n(sup, 1)}")
    if weight is not None and weight > limit:
        action = cap(action, "HOLD")
        reasons.append(f"{weight:.0f}% of portfolio (limit {limit:.0f}%)")
    return action, reasons


def build_context(portfolio: dict | None, out: Path) -> dict:
    prices = read_json(out / "prices.json", {"rows": []})
    analysis = read_json(out / "analysis.json", {"stocks": {}, "top10": []})
    rows = {r["symbol"]: r for r in prices.get("rows", [])}
    ctx = {"prices": prices, "rows": rows, "analysis": analysis, "status": read_json(out / "status.json", {}),
           "news": read_json(out / "news.json", {"items": [], "newIds": []}), "portfolio": None}
    if portfolio:
        settings = portfolio.get("settings", {})
        res = pf.compute(portfolio.get("transactions", []), settings.get("fees") or FEES,
                         {s: r["ltp"] for s, r in rows.items()}, settings.get("engine"), cal.now_npt().date().isoformat())
        held = [h for h in res["holdings"] if h["qty"] > 0]
        total = res["totals"]["value"]
        for h in held:
            h["weight"] = h["value"] / total * 100 if h.get("value") and total else None
            r = rows.get(h["symbol"])
            h["dayPct"] = r.get("pctChange") if r else None
            h["dayAmt"] = (r["ltp"] - r["prevClose"]) * h["qty"] if r and r.get("prevClose") else 0.0
            h["lastTraded"] = r["asOf"][:10] if r and r.get("carried") else None     # no trade yet this session
        ctx["portfolio"] = {"result": res, "held": held, "plans": portfolio.get("plans", {}),
                            "watchlist": portfolio.get("watchlist", []),
                            "limit": settings.get("concentrationPct", CFG["concentrationPct"]),
                            "dayAmt": sum(h["dayAmt"] for h in held),
                            "dayPct": (sum(h["dayAmt"] for h in held) / (total - sum(h["dayAmt"] for h in held)) * 100)
                            if total - sum(h["dayAmt"] for h in held) > 0 else None}
    return ctx


def position_message(h: dict, a: dict | None, signal: str, headline: str, reasons: list[str], ctx: dict) -> str:
    risk = (a or {}).get("risk", {}).get("level", "Unknown")
    lv = (a or {}).get("levels")
    sn = h.get("sellNow")
    if signal == "SELL":
        action = "Consider exiting. " + (f"Selling all nets about Rs {n(sn['netProceeds'])} after charges and Rs {n(sn['cgt'])} CGT "
                                         f"({'profit' if sn['profit'] >= 0 else 'loss'} Rs {n(abs(sn['profit']))})." if sn else "")
    elif signal == "REDUCE":
        action = "Consider booking partial profits / trimming" + (f"; keep a stop near Rs {n(lv['stopLoss'])}." if lv else ".")
    elif signal in ("BUY", "ACCUMULATE"):
        action = "Hold; adding is reasonable" + (f" in the Rs {n(lv['entryLow'])}-{n(lv['entryHigh'])} zone." if lv else ".")
    elif signal == "HOLD":
        action = "Hold; do not add." + (f" Stop-loss reference Rs {n(lv['stopLoss'])}." if lv else "")
    else:
        action = "Data incomplete - verify the price with your broker before acting."
    return "\n".join([
        "NEPSE PORTFOLIO ALERT", "",
        f"Stock: {h['symbol']}", "",
        f"Current Price: NPR {n(h.get('ltp'), 1)}" + (f" (last traded {h['lastTraded']})" if h.get("lastTraded") else ""),
        f"Your Average Cost: NPR {n(h['avgCost'], 2)}",
        f"Unrealized Return: {h['unrealizedPct']:+.1f}%" if h.get("unrealizedPct") is not None else "Unrealized Return: n/a", "",
        f"Signal: {signal}", "",
        "Reason:", headline + ("" if not reasons else " " + "; ".join(reasons) + "."), "",
        "Suggested Action:", action, "",
        f"Risk: {risk}", "",
        "Review: Next trading session", "",
        f"Data updated: {ctx['prices'].get('asOf', 'n/a')} NPT ({ctx['status'].get('freshness', {}).get('state', 'unknown')})",
    ])


def generate(ctx: dict) -> list[dict]:
    """Returns alerts: {key, kind, text}. Keys identify the condition for cooldown."""
    alerts: list[dict] = []
    stocks = ctx["analysis"].get("stocks", {})
    fresh = ctx["status"].get("freshness", {}).get("state")
    if fresh in ("stale", "unavailable"):
        # Never alert on stale prices; tell the user once instead.
        return [{"key": "stale-data", "kind": "portfolio",
                 "text": "NEPSE DATA WARNING\n\n" + ctx["status"].get("freshness", {}).get("message", "Market data unavailable.")
                         + "\n\nPrice-based alerts are paused until fresh data arrives."}]
    p = ctx["portfolio"]
    held_syms = set()
    if p:
        for h in p["held"]:
            sym = h["symbol"]
            held_syms.add(sym)
            a, plan = stocks.get(sym), p["plans"].get(sym, {})
            signal, reasons = position_signal(h, a, plan, h.get("weight"), p["limit"])
            ltp = h.get("ltp")
            if not ltp:
                continue

            def add(kind, key, headline):
                alerts.append({"key": f"{kind}:{sym}:{key}", "kind": kind,
                               "text": position_message(h, a, signal, headline, reasons, ctx)})
            if plan.get("stop") and ltp <= plan["stop"]:
                add("stop", plan["stop"], "STOP-LOSS TRIGGERED.")
            elif plan.get("target") and ltp >= plan["target"]:
                add("target", plan["target"], "TARGET PRICE ACHIEVED.")
            elif a and (a["tech"].get("support60") or 0) and ltp < a["tech"]["support60"] * (1 - CFG["supportBreachBufferPct"] / 100):
                add("support", round(a["tech"]["support60"]), f"Price closed below 60-day support ({n(a['tech']['support60'], 1)}).")
            elif signal in ("SELL", "REDUCE") and a:
                f = a.get("fundamental", {})
                add("signal", signal, f"Model signal is {signal}: fundamental outlook {f.get('outlook', 'Unknown')}, "
                                      f"technical outlook {a['technical'].get('outlook', 'Unknown')}.")
            elif h.get("unrealizedPct") is not None and h["unrealizedPct"] <= -CFG["positionLossPct"]:
                add("loss", int(h["unrealizedPct"] // 5), f"Position is down {abs(h['unrealizedPct']):.1f}% from your cost. Re-check your thesis.")
            elif h.get("dayPct") is not None and abs(h["dayPct"]) >= CFG["dayMovePct"]:
                add("move", ctx["prices"].get("marketDate"), f"Significant price move today: {h['dayPct']:+.2f}%.")
            if h.get("weight") and h["weight"] > p["limit"]:
                alerts.append({"key": f"concentration:{sym}", "kind": "concentration",
                               "text": f"NEPSE PORTFOLIO ALERT\n\nConcentration: {sym} is {h['weight']:.0f}% of your portfolio "
                                       f"(limit {p['limit']:.0f}%).\n\nSuggested Action:\nDirect new money elsewhere or trim on strength.\n\n"
                                       f"Data updated: {ctx['prices'].get('asOf', 'n/a')} NPT"})
        if p["dayPct"] is not None and p["dayPct"] <= -CFG["portfolioDayLossPct"]:
            worst = sorted(p["held"], key=lambda h: h["dayAmt"])[:3]
            alerts.append({"key": f"portfolio:{ctx['prices'].get('marketDate')}", "kind": "portfolio",
                           "text": f"NEPSE PORTFOLIO ALERT\n\nPortfolio fell {p['dayPct']:.2f}% today (Rs {n(p['dayAmt'])}).\n"
                                   f"Largest declines: " + ", ".join(f"{h['symbol']} {h['dayPct']:+.1f}%" for h in worst if h.get('dayPct') is not None)
                                   + f"\n\nSuggested Action:\nNo action needed on a single day's move alone; check the stop levels of the names above.\n\n"
                                     f"Data updated: {ctx['prices'].get('asOf', 'n/a')} NPT"})
        for w in p["watchlist"]:
            if w.get("list") == "avoid":
                continue
            r, a = ctx["rows"].get(w["symbol"]), stocks.get(w["symbol"])
            if r and w.get("buyHigh") and r["ltp"] <= w["buyHigh"] and (not w.get("buyLow") or r["ltp"] >= w["buyLow"] * 0.97):
                alerts.append({"key": f"watch:{w['symbol']}:{w['buyHigh']}", "kind": "watch",
                               "text": f"NEPSE WATCHLIST ALERT\n\nStock: {w['symbol']}\n\nCurrent Price: NPR {n(r['ltp'], 1)}\n"
                                       f"Your Buy Range: NPR {n(w.get('buyLow'))} - {n(w['buyHigh'])}\n\nSignal: {a['stance'] if a else 'WATCH'}"
                                       f"{' (data incomplete)' if a and a.get('incomplete') else ''}\n\nReason:\nPrice has entered your predefined buying range."
                                       f"{' Model quality score ' + format(a['quality'], '.0f') + '/100, risk ' + a['risk']['level'] + '.' if a and a.get('quality') is not None else ''}\n\n"
                                       f"Suggested Action:\n{'Consider a first tranche; confirm with the latest quarterly report.' if a and a['stance'] in ('BUY', 'ACCUMULATE') else 'In range, but the model does not support buying now - review before acting.'}\n\n"
                                       f"Data updated: {ctx['prices'].get('asOf', 'n/a')} NPT"})
    # News: critical market-wide, or High+ touching a holding
    new_ids = set(ctx["news"].get("newIds", []))
    for item in ctx["news"].get("items", []):
        if item["id"] not in new_ids:
            continue
        mine = [s for s in item.get("symbols", []) if s in held_syms]
        if item["impact"] == "Critical" or (mine and item["impact"] in ("High", "Critical")):
            alerts.append({"key": f"news:{item['id']}", "kind": "critical_news" if item["impact"] == "Critical" else "holding_news",
                           "text": f"NEPSE {'CRITICAL' if item['impact'] == 'Critical' else 'HOLDING'} NEWS\n\n{item['title']}\n\n"
                                   f"Source: {item['source']} ({'confirmed announcement' if item['confirmed'] else 'news report'})\n"
                                   + (f"Your holdings: {', '.join(mine)}\n" if mine else "")
                                   + f"Impact: {item['impact']} | {item['sentiment']}\nWhy it matters: {item['why']}\n"
                                   + (f"\nSuggested Action:\n{item['action']}\n" if item.get("action") else "")
                                   + f"\n{item['url']}"})
    if CFG.get("notifyOpportunities"):
        for t in ctx["analysis"].get("top10", [])[:3]:
            a = stocks.get(t["symbol"])
            if a and t["symbol"] not in held_syms and (a.get("quality") or 0) >= CFG["minOpportunityScore"] and "entry" in a.get("categories", []):
                lv = a.get("levels") or {}
                alerts.append({"key": f"opportunity:{t['symbol']}", "kind": "opportunity",
                               "text": f"NEPSE BUY OPPORTUNITY\n\nStock: {a['symbol']} ({a.get('sector')})\n\nCurrent Price: NPR {n(a['price'], 1)}\n"
                                       f"Signal: {a['stance']} | quality {a['quality']:.0f}/100 | risk {a['risk']['level']} | confidence {a['confidence']:.0f}/100\n\n"
                                       f"Reason:\nRanked in the top 3 of the screener and trading inside its entry zone "
                                       f"(Rs {n(lv.get('entryLow'))}-{n(lv.get('entryHigh'))}). {' '.join(a['fundamental'].get('notes', [])[:2])}\n\n"
                                       f"Suggested Action:\nReview the analysis page and latest quarterly report before buying. Not an instruction to trade.\n\n"
                                       f"Data updated: {ctx['prices'].get('asOf', 'n/a')} NPT"})
    alerts.sort(key=lambda x: PRIORITY.get(x["kind"], 99))
    return alerts


KDF_ROUNDS = 300_000


def _digester(state: dict, private: bool):
    """Returns key -> digest for the sent-state, or None when private keys cannot be recorded safely.

    The state file sits on the PUBLIC data branch, and alert keys contain symbols and price levels. Digests are
    therefore keyed with a secret that is stretched with PBKDF2 and a random per-repository salt first: a plain,
    fast HMAC over a human-chosen passphrase would hand an attacker a far cheaper way to test passphrase guesses
    than the encrypted portfolio file does. A machine-generated secret (the bot token) is preferred.
    """
    material = next((os.environ[k].strip() for k in ("TELEGRAM_BOT_TOKEN", "SMTP_PASSWORD", "PORTFOLIO_PASSPHRASE")
                     if os.environ.get(k, "").strip()), None)
    if material is None:
        if private:
            return None
        return lambda key: hashlib.sha256(key.encode()).hexdigest()[:24]     # market-only keys are public anyway
    salt = state.setdefault("salt", os.urandom(16).hex())
    derived = hashlib.pbkdf2_hmac("sha256", material.encode(), bytes.fromhex(salt), KDF_ROUNDS)
    return lambda key: hmac.new(derived, key.encode(), hashlib.sha256).hexdigest()[:24]


def filter_new(alerts: list[dict], out: Path, private: bool = True, deliver=None) -> tuple[list[dict], list[dict]]:
    """Applies cooldown and the per-run cap, delivers, and records ONLY what was actually delivered.

    `private`  - the alerts were built from a portfolio (controls how the sent-state may be stored).
    `deliver`  - callable(alert) -> True when it reached the user. When omitted every selected alert counts as
                 delivered. An alert that fails to send is not recorded, so it is retried on the next run instead
                 of being silently lost.
    Returns (delivered, undelivered).
    """
    path = out / "state" / "alerts.json"
    state = read_json(path, {"sent": {}})
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=CFG["cooldownDays"])).isoformat()
    state["sent"] = {k: v for k, v in state.get("sent", {}).items() if v >= (now - timedelta(days=45)).isoformat()}
    digest = _digester(state, private)
    delivered, undelivered = [], []
    for a in alerts:
        d = digest(a["key"]) if digest else None
        news = a["kind"] in ("critical_news", "holding_news")
        if d and d in state["sent"] and (news or state["sent"][d] >= cutoff):
            continue
        if len(delivered) + len(undelivered) >= CFG["maxAlertsPerRun"]:
            break       # the rest are reconsidered on the next run
        if deliver is None or deliver(a):
            delivered.append(a)
            if d:
                state["sent"][d] = now.isoformat(timespec="seconds")
        else:
            undelivered.append(a)
    if digest:
        write_json(path, state)
    return delivered, undelivered
