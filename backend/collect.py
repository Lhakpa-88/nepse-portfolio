"""Collects market data into the data directory served to the dashboard.

Outputs (all JSON, public market data only - never portfolio data):
  prices.json        latest price per symbol + market date
  market.json        indices, sector indices, market summary, breadth
  history/SYM.json   daily OHLCV per symbol (and NEPSE index)
  fundamentals.json  latest reported fundamentals + dividend history
  companies.json     symbol -> name/sector cache
  status.json        source health, freshness, cross-check result
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import market_calendar as cal
from .sources import CONFIG, PROVIDERS, Registry, SourceError


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def safe(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", symbol)


def collect_prices(out: Path, reg: Registry) -> dict | None:
    companies = read_json(out / "companies.json", {})
    try:
        rows, src = reg.call("prices")
    except SourceError:
        return None
    # Enrich names/sectors and cross-check closing prices against a second provider.
    cross = {"against": None, "compared": 0, "mismatches": 0, "examples": []}
    for other in CONFIG["capabilities"]["prices"]:
        if other == src:
            continue
        try:
            alt = {r["symbol"]: r for r in PROVIDERS[other].prices()}
        except Exception:  # noqa: BLE001
            continue
        first = cross["against"] is None   # cross-check prices against the first reachable alternative only
        cross["against"] = cross["against"] or other
        for r in rows:
            a = alt.get(r["symbol"])
            if not a:
                continue
            c = companies.setdefault(r["symbol"], {})
            if a.get("name") and not c.get("name"):
                c["name"] = a["name"]
            if a.get("sector") and not c.get("sector"):
                c["sector"] = a["sector"]
            if first and a["ltp"] and r["ltp"]:
                cross["compared"] += 1
                if abs(a["ltp"] - r["ltp"]) / r["ltp"] > 0.01:
                    cross["mismatches"] += 1
                    if len(cross["examples"]) < 5:
                        cross["examples"].append({"symbol": r["symbol"], src: r["ltp"], other: a["ltp"]})
        if all(companies.get(r["symbol"], {}).get("name") and companies.get(r["symbol"], {}).get("sector") for r in rows):
            break
    for r in rows:
        c = companies.setdefault(r["symbol"], {})
        for k in ("name", "sector"):
            if r.get(k):
                c[k] = r[k]
            r[k] = c.get(k)
        if r.get("prevClose") and r.get("ltp") and r.get("pctChange") is None:
            r["pctChange"] = round((r["ltp"] - r["prevClose"]) / r["prevClose"] * 100, 2)
    dates = Counter((r.get("asOf") or "")[:10] for r in rows if r.get("asOf"))
    market_date = max(dates) if dates else None
    as_of = max((r["asOf"] for r in rows if r.get("asOf")), default=None)
    traded = len(rows)
    carried = carry_forward(out, rows, companies, market_date)
    write_json(out / "companies.json", companies)
    payload = {"marketDate": market_date, "asOf": as_of, "source": src, "fetchedAt": utcnow(),
               "traded": traded, "carried": carried, "rows": rows}
    write_json(out / "prices.json", payload)
    reg.log["prices"]["crossCheck"] = cross
    reg.log["prices"]["rows"] = traded
    reg.log["prices"]["carried"] = carried
    return payload


def carry_forward(out: Path, rows: list[dict], companies: dict, market_date: str | None) -> int:
    """Adds a row for every known symbol that has no trade yet in the current session, using its last real close.

    Live feeds list only what has traded so far today. Without this, a holding would have no price until its
    first trade of the day - or all day for a thinly traded stock. A carried row is a real past closing price,
    marked `carried` with the date it is from; it is never an estimate, and it adds no bar to the price history.
    Symbols idle for longer than `carryForwardDays` are left out rather than shown at a very old price.
    """
    if not market_date:
        return 0
    present = {r["symbol"] for r in rows}
    oldest = (datetime.fromisoformat(market_date) - timedelta(days=CONFIG.get("carryForwardDays", 45))).date().isoformat()
    added = 0
    for sym, meta in sorted(companies.items()):
        if sym in present:
            continue
        hist = read_json(out / "history" / f"{safe(sym)}.json") or {}
        last = next((r for r in reversed(hist.get("rows", [])) if r[4] and str(r[0])[:10] < market_date), None)
        if not last or str(last[0])[:10] < oldest:
            continue
        rows.append({"symbol": sym, "name": meta.get("name"), "sector": meta.get("sector"),
                     "open": None, "high": None, "low": None, "ltp": last[4], "prevClose": last[4], "pctChange": None,
                     "volume": 0, "turnover": 0, "transactions": 0, "asOf": str(last[0])[:10], "carried": True})
        added += 1
    return added


def collect_indices(out: Path, reg: Registry, prices: dict | None) -> dict | None:
    try:
        data, src = reg.call("indices")
    except SourceError:
        return None
    # fill gaps (e.g. sector sub-indices) from the other provider where possible
    for other in CONFIG["capabilities"]["indices"]:
        if other != src and (not data.get("sectors") or data["summary"].get("gainers") is None):
            try:
                alt = PROVIDERS[other].indices()
                data["sectors"] = data.get("sectors") or alt.get("sectors", [])
                for k, v in alt["summary"].items():
                    if data["summary"].get(k) is None:
                        data["summary"][k] = v
            except Exception:  # noqa: BLE001
                pass
    if prices:
        ch = [r["pctChange"] for r in prices["rows"] if r.get("pctChange") is not None]
        data["breadth"] = {"advancers": sum(1 for c in ch if c > 0), "decliners": sum(1 for c in ch if c < 0),
                           "unchanged": sum(1 for c in ch if c == 0)}
    data.update({"source": src, "fetchedAt": utcnow(), "marketDate": prices and prices["marketDate"]})
    write_json(out / "market.json", data)
    return data


def update_history(out: Path, reg: Registry, prices: dict | None, market: dict | None) -> dict:
    hist_dir = out / "history"
    stats = {"appended": 0, "bootstrapped": 0, "failed": 0, "pending": 0}
    if not prices or not prices.get("marketDate"):
        return stats
    md, keep = prices["marketDate"], CONFIG.get("historyKeepDays", 520)
    budget = CONFIG.get("maxHistoryBootstrapsPerRun", 400)
    items = [(r["symbol"], [md, r.get("open"), r.get("high"), r.get("low"), r["ltp"], r.get("volume")])
             for r in prices["rows"] if not r.get("carried")]        # no trade today -> no bar for today
    nepse = next((i for i in (market or {}).get("main", []) if i["name"] == "NEPSE Index"), None)
    if nepse and nepse.get("value"):
        items.append(("NEPSE", [md, None, nepse.get("high"), nepse.get("low"), nepse["value"],
                               (market or {}).get("summary", {}).get("volume")]))
    for sym, today_row in items:
        path = hist_dir / f"{safe(sym)}.json"
        h = read_json(path)
        if not h or not h.get("rows"):
            if budget <= 0:
                stats["pending"] += 1
                continue
            budget -= 1
            try:
                rows, src = reg.call("history", sym, quiet=True)
                h = {"symbol": sym, "source": src, "rows": rows}
                stats["bootstrapped"] += 1
            except SourceError:
                h = {"symbol": sym, "source": "daily-append", "rows": []}
                stats["failed"] += 1
        # one bar per calendar day, keyed by a plain date (a feed may stamp today's bar with a time of day)
        by_day = {str(r[0])[:10]: [str(r[0])[:10], *r[1:]] for r in h["rows"] if r and r[0]}
        rows = [by_day[d] for d in sorted(by_day)]
        if rows and rows[-1][0] == md:
            rows[-1] = today_row if sym != "NEPSE" or today_row[4] else rows[-1]
        elif not rows or rows[-1][0] < md:
            rows.append(today_row)
            stats["appended"] += 1
        h["rows"] = rows[-keep:]
        h["updatedAt"] = utcnow()
        write_json(path, h)
    reg.log["history"] = {"ok": stats["failed"] == 0, **stats, "at": utcnow(),
                          "source": "/".join(CONFIG["capabilities"]["history"])}
    return stats


def _period_key(p: dict) -> tuple[int, int]:
    fy = re.findall(r"\d+", p.get("fiscalYear") or "0")
    q = re.findall(r"\d", p.get("quarter") or "0")
    return (int(fy[0]) % 100 if fy else 0, int(q[0]) if q else 0)


def summarise_fundamentals(symbol: str, periods: list[dict], dividends: list[dict]) -> dict | None:
    periods = sorted([p for p in periods if p["values"]], key=_period_key, reverse=True)
    if not periods:
        return None
    latest = periods[0]
    v = latest["values"]
    ky = _period_key(latest)
    prev = next((p for p in periods if _period_key(p) == (ky[0] - 1, ky[1])), None)

    def growth(key):
        a, b = v.get(key), prev and prev["values"].get(key)
        return round((a - b) / abs(b) * 100, 2) if a is not None and b not in (None, 0) else None

    eps = v.get("eps_a", v.get("eps"))
    return {
        "symbol": symbol, "fetchedAt": utcnow(),
        "period": {"fiscalYear": latest["fiscalYear"], "quarter": latest["quarter"]},
        "eps": eps, "epsReported": v.get("eps"), "bookValue": v.get("net_worth"),
        "roe": v.get("roe"), "roa": v.get("roa"), "npl": v.get("npl"), "car": v.get("capital_fund_to_rwa"),
        "cdRatio": v.get("cd_ratio"), "netProfit": v.get("net_profit"), "paidUpCapital": v.get("paidup_capital"),
        "reserves": v.get("reserve_surplus", v.get("reserve")), "totalAssets": v.get("total_assets"),
        "revenue": v.get("net_interest_income", v.get("revenue", v.get("total_revenue"))),
        "epsGrowthYoY": growth("eps_a") if "eps_a" in v else growth("eps"),
        "profitGrowthYoY": growth("net_profit"),
        "trend": [{"fy": p["fiscalYear"], "q": p["quarter"], "eps": p["values"].get("eps_a", p["values"].get("eps")),
                   "netProfit": p["values"].get("net_profit")} for p in periods[:8]],
        "dividends": dividends[:6],
    }


def collect_fundamentals(out: Path, reg: Registry, prices: dict | None, limit: int | None = None) -> dict:
    """Refreshes the oldest fundamentals first, within a per-run request budget."""
    store = read_json(out / "fundamentals.json", {"symbols": {}})
    excluded = {"Mutual Fund", "Non-Convertible Debenture"}
    symbols = [r["symbol"] for r in (prices or {}).get("rows", []) if r.get("sector") not in excluded]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CONFIG.get("fundamentalsRefreshDays", 7))).isoformat()
    due = sorted((s for s in symbols if store["symbols"].get(s, {}).get("fetchedAt", "") < cutoff),
                 key=lambda s: store["symbols"].get(s, {}).get("fetchedAt", ""))
    budget = limit if limit is not None else CONFIG.get("maxFundamentalFetchesPerRun", 150)
    ok = failed = 0
    for sym in due[:budget]:
        try:
            periods, _ = reg.call("fundamentals", sym, quiet=True)
            try:
                divs, _ = reg.call("dividends", sym, quiet=True)
            except SourceError:
                divs = store["symbols"].get(sym, {}).get("dividends", [])
            rec = summarise_fundamentals(sym, periods, divs)
            if rec:
                store["symbols"][sym] = rec
                ok += 1
            else:
                store["symbols"].setdefault(sym, {"symbol": sym})["fetchedAt"] = utcnow()
        except SourceError:
            failed += 1
            # remember the attempt so one broken symbol does not block the queue
            store["symbols"].setdefault(sym, {"symbol": sym, "missing": True})["fetchedAt"] = utcnow()
    store["updatedAt"] = utcnow()
    store["source"] = "/".join(CONFIG["capabilities"]["fundamentals"])
    write_json(out / "fundamentals.json", store)
    covered = sum(1 for s in symbols if store["symbols"].get(s, {}).get("eps") is not None)
    reg.log["fundamentals"] = {"ok": failed == 0 or ok > 0, "refreshed": ok, "failed": failed,
                               "pending": max(0, len(due) - budget), "covered": covered, "universe": len(symbols),
                               "source": store["source"], "at": utcnow()}
    return store


def write_status(out: Path, reg: Registry, prices: dict | None) -> dict:
    prev = read_json(out / "status.json", {})
    last_ok = prev.get("lastSuccess", {})
    for cap, entry in reg.log.items():
        if entry.get("ok"):
            last_ok[cap] = entry["at"]
    md = (prices or read_json(out / "prices.json", {}) or {}).get("marketDate")
    fresh = cal.freshness(md)
    cross = reg.log.get("prices", {}).get("crossCheck", {})
    if not reg.log.get("prices", {}).get("ok", False):
        reliability = "down"
    elif cross.get("compared", 0) == 0:
        reliability = "unverified"
    elif cross["mismatches"] / cross["compared"] > 0.05:
        reliability = "disputed"
    else:
        reliability = "cross-verified"
    status = {
        "generatedAt": utcnow(), "nepalTime": cal.now_npt().isoformat(timespec="minutes"),
        "session": cal.session(), "marketDate": md, "freshness": fresh, "reliability": reliability,
        "capabilities": reg.log, "lastSuccess": last_ok,
        "chain": CONFIG["capabilities"],
        "disclaimer": "All providers are unofficial public endpoints, not an official NEPSE API. "
                      "Prices may be delayed or wrong; confirm with your broker/TMS before trading.",
    }
    write_json(out / "status.json", status)
    return status


def run(out: Path, with_fundamentals: bool = True, fundamentals_limit: int | None = None) -> dict:
    reg = Registry()
    prices = collect_prices(out, reg)
    market = collect_indices(out, reg, prices)
    update_history(out, reg, prices, market)
    if with_fundamentals:
        collect_fundamentals(out, reg, prices or read_json(out / "prices.json"), fundamentals_limit)
    return write_status(out, reg, prices)
