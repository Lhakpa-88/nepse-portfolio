"""Daily / weekly / monthly reports. All numbers come from the engine and data files.

An optional short narrative is added by Claude when ANTHROPIC_API_KEY is set;
it receives only the already-computed report text and is told not to add facts.
Without a key the report is purely rule-based.
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from analytics import technicals as ta
from backend.collect import read_json, safe
from notifications.alerts import CFG, n, position_signal


def _market_block(ctx: dict, out: Path) -> list[str]:
    market = read_json(out / "market.json", {})
    idx = next((i for i in market.get("main", []) if i["name"] == "NEPSE Index"), None)
    s = market.get("summary", {})
    b = market.get("breadth") or {}
    regime = ctx["analysis"].get("regime", {})
    lines = []
    if idx and idx.get("value"):
        lines.append(f"NEPSE {idx['value']:,.2f} ({idx.get('pctChange') or 0:+.2f}%) | trend: {regime.get('label', 'Unknown')}")
    if s.get("turnover"):
        lines.append(f"Turnover Rs {s['turnover'] / 1e9:.2f} Arba | {b.get('advancers', '?')} up / {b.get('decliners', '?')} down")
    return lines


def _period_return(out: Path, symbol: str, sessions: int):
    rows = read_json(out / "history" / f"{safe(symbol)}.json", {"rows": []})["rows"]
    closes = [r[4] for r in rows if r[4]]
    return ta.pct_return(closes, sessions) if len(closes) > sessions else None


def build(kind: str, ctx: dict, out: Path, sent_alerts: list[dict] | None = None) -> str:
    """kind: 'premarket' | 'daily' | 'weekly' | 'monthly'"""
    # "premarket" is called the morning brief: when GitHub starts the first run late it goes out after the open
    title = {"premarket": "MORNING BRIEF", "daily": "DAILY PORTFOLIO REPORT", "weekly": "WEEKLY PERFORMANCE & RISK REVIEW",
             "monthly": "MONTHLY PORTFOLIO HEALTH REVIEW"}[kind]
    fresh = ctx["status"].get("freshness", {})
    L = [f"NEPSE {title}", f"Market date {ctx['prices'].get('marketDate', 'n/a')} | data {fresh.get('state', 'unknown')}", ""]
    if fresh.get("state") not in ("fresh", None):
        L += [f"WARNING: {fresh.get('message', '')}", ""]
    L += _market_block(ctx, out) + [""]
    p = ctx["portfolio"]
    stocks = ctx["analysis"].get("stocks", {})

    if kind == "premarket":
        new_ids = set(ctx["news"].get("newIds", []))
        held = {h["symbol"] for h in p["held"]} if p else set()
        items = [i for i in ctx["news"].get("items", [])[:60]
                 if i["impact"] in ("Critical", "High") or any(s in held for s in i.get("symbols", []))][:8]
        L.append("Overnight developments:" if items else "No critical or holding-specific announcements since the last session.")
        for i in items:
            tag = "NEW " if i["id"] in new_ids else ""
            mine = [s for s in i.get("symbols", []) if s in held]
            L.append(f"- {tag}[{i['impact']}] {i['title'][:110]}{' (yours: ' + ', '.join(mine) + ')' if mine else ''} - {i['source']}")
        if p:
            near = []
            for h in p["held"]:
                plan = p["plans"].get(h["symbol"], {})
                if h.get("ltp") and plan.get("stop") and h["ltp"] <= plan["stop"] * 1.03:
                    near.append(f"{h['symbol']} is within 3% of your stop {n(plan['stop'], 1)}")
                if h.get("ltp") and plan.get("target") and h["ltp"] >= plan["target"] * 0.97:
                    near.append(f"{h['symbol']} is within 3% of your target {n(plan['target'], 1)}")
            if near:
                L += ["", "Levels to watch today:"] + [f"- {x}" for x in near]
        return "\n".join(L)

    if not p:
        L.append("Portfolio not configured for the pipeline (market-only report). Sync your encrypted portfolio from the dashboard Settings page.")
    else:
        t = p["result"]["totals"]
        L += [f"Value Rs {n(t['value'])} | cost Rs {n(t['cost'])}",
              f"Today {p['dayAmt']:+,.0f} ({p['dayPct']:+.2f}%)" if p["dayPct"] is not None else "Today: n/a",
              f"Unrealized {t['unrealized']:+,.0f} ({t['unrealizedPct']:+.2f}%)" if t["unrealizedPct"] is not None else "Unrealized: n/a",
              f"Realized {t['realized']:+,.0f} | dividends {t['dividendNet']:,.0f} | net return {t['netReturn']:+,.0f}", ""]
        sessions = {"daily": 1, "weekly": 5, "monthly": 21}[kind]
        rows = []
        for h in sorted(p["held"], key=lambda h: -(h.get("value") or 0)):
            a = stocks.get(h["symbol"])
            sig, why = position_signal(h, a, p["plans"].get(h["symbol"], {}), h.get("weight"), p["limit"])
            chg = h.get("dayPct") if kind == "daily" else _period_return(out, h["symbol"], sessions)
            rows.append((h, a, sig, why, chg))
            L.append(f"{h['symbol']:<8} {n(h.get('ltp'), 1):>9} {'' if chg is None else format(chg, '+.1f') + '%':>7}  "
                     f"P/L {'' if h.get('unrealizedPct') is None else format(h['unrealizedPct'], '+.1f') + '%':>7}  {sig}")
        attention = [(h, sig, why) for h, a, sig, why, _ in rows if sig in ("SELL", "REDUCE") or why]
        L.append("")
        if attention:
            L.append("Needs attention:")
            L += [f"- {h['symbol']}: {sig}" + (f" ({'; '.join(why)})" if why else "") for h, sig, why in attention]
        else:
            L.append("No holding needs action today.")

        if kind in ("weekly", "monthly"):
            nepse = _period_return(out, "NEPSE", sessions)
            total = t["value"]
            port = sum((chg or 0) * (h.get("value") or 0) for h, _, _, _, chg in rows) / total if total else None
            L += ["", f"{'Week' if kind == 'weekly' else 'Month'}: current holdings {'' if port is None else format(port, '+.2f') + '%'} "
                      f"vs NEPSE {'' if nepse is None else format(nepse, '+.2f') + '%'}"]
            sectors: dict[str, float] = {}
            for h, a, *_ in rows:
                sec = (a or {}).get("sector") or "Unknown"
                sectors[sec] = sectors.get(sec, 0) + (h.get("weight") or 0)
            L.append("Sector exposure: " + ", ".join(f"{s} {w:.0f}%" for s, w in sorted(sectors.items(), key=lambda x: -x[1])))
            risks = [f"{h['symbol']} is {h['weight']:.0f}% of the portfolio" for h, *_ in rows if (h.get("weight") or 0) > p["limit"]]
            risks += [f"{s} is {w:.0f}% of the portfolio" for s, w in sectors.items() if w > CFG["sectorConcentrationPct"]]
            risks += [f"{h['symbol']} risk level High" for h, a, *_ in rows if a and a["risk"]["level"] == "High"]
            L.append("Risk flags: " + ("; ".join(risks) if risks else "none"))
        if kind == "monthly":
            weak = [h["symbol"] for h, a, sig, *_ in rows if a and (a.get("quality") or 100) < 45]
            L += ["", "Strategy review:",
                  f"- Holdings with a quality score below 45: {', '.join(weak) if weak else 'none'}",
                  f"- Diversification: {len(rows)} stocks across {len(sectors)} sectors",
                  "- Re-read your thesis for each holding against its latest quarterly report; update targets and stops in the dashboard."]

    top = [stocks[t["symbol"]] for t in ctx["analysis"].get("top10", [])[:5] if t["symbol"] in stocks]
    if top and kind != "premarket":
        L += ["", "Top-ranked opportunities (model):"]
        L += [f"- {a['symbol']} Rs {n(a['price'], 1)} | quality {a['quality']:.0f} | risk {a['risk']['level']}" for a in top]
    if sent_alerts:
        L += ["", f"{len(sent_alerts)} alert(s) were sent separately this run."]
    L += ["", "Decision support only - not investment advice. No orders are placed."]
    return "\n".join(L)


def narrative(report_text: str) -> str | None:
    """Optional 3-sentence summary from Claude. Returns None when no key is configured or on any error."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None
    body = json.dumps({
        "model": os.environ.get("CLAUDE_MODEL", "claude-haiku-5-5"), "max_tokens": 300,
        "system": "You summarise a NEPSE portfolio report for a busy investor in at most 3 plain sentences. Use ONLY facts and "
                  "numbers present in the report. Do not add prices, news, predictions or advice that are not in it.",
        "messages": [{"role": "user", "content": report_text}],
    }).encode("utf-8")
    try:
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
            "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.loads(r.read())
        text = " ".join(b["text"] for b in data.get("content", []) if b.get("type") == "text").strip()
        return text or None
    except Exception:  # noqa: BLE001 - the report must never fail because the summary did
        return None
