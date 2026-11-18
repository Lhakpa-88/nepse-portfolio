"""Portfolio accounting engine (Python mirror of frontend/src/lib/engine.ts).

Both implementations are verified against the same hand-computed fixture
(tests/fixtures/portfolio_cases.json), so the dashboard and the automated
alerts always agree.

Conventions
-----------
* Cost basis method: WACC (default, matches MeroShare/broker practice) or FIFO.
* Buy charges (commission, SEBON fee, DP charge) are capitalised into cost.
* Sell: realized = gross - commission - SEBON - DP - other - CGT - cost removed.
* CGT base = gross - commission - SEBON - tax cost (DP charge is not deductible).
  Rate depends on holding period of the FIFO lots consumed (short/long term).
* Bonus shares: economic cost = options.bonusCostBasis (default 0) and tax cost
  = options.bonusTaxBasis (default 100, the par value used for CGT in Nepal).
* Cash dividends never touch cost basis; they are tracked separately (net of TDS).
* Voided transactions are ignored (kept only for the audit trail).
"""
from __future__ import annotations

from datetime import date
from typing import Any

ACQUIRE = {"BUY", "IPO", "RIGHT", "BONUS", "ADJUST"}
DEFAULT_OPTIONS = {"method": "WACC", "bonusCostBasis": 0.0, "bonusTaxBasis": 100.0}


def r2(x: float) -> float:
    return round(x + 1e-9, 2)


def schedule_for(fees: dict, d: str) -> dict:
    best = None
    for s in sorted(fees["schedules"], key=lambda s: s["effectiveFrom"]):
        if s["effectiveFrom"] <= d:
            best = s
    return best or sorted(fees["schedules"], key=lambda s: s["effectiveFrom"])[0]


def commission(sched: dict, amount: float) -> float:
    if amount <= 0:
        return 0.0
    for slab in sched["commissionSlabs"]:
        if slab["upTo"] is None or amount <= slab["upTo"]:
            return r2(max(sched.get("minCommission", 0), amount * slab["rate"]))
    return 0.0


def trade_charges(sched: dict, amount: float) -> dict:
    """Charges common to a secondary-market buy or sell of `amount` NPR."""
    return {
        "commission": commission(sched, amount),
        "sebon": r2(amount * sched["sebonRate"]),
        "dp": float(sched["dpCharge"]) if amount > 0 else 0.0,
    }


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _num(t: dict, k: str):
    v = t.get(k)
    return None if v in (None, "") else float(v)


def new_position(symbol: str) -> dict:
    return {
        "symbol": symbol, "qty": 0.0, "cost": 0.0, "taxCost": 0.0, "lots": [],
        "realized": 0.0, "dividendGross": 0.0, "dividendTax": 0.0, "dividendNet": 0.0,
        "bonusQty": 0.0, "rightQty": 0.0, "totalBought": 0.0, "firstDate": None,
        "fees": {"commission": 0.0, "sebon": 0.0, "dp": 0.0, "cgt": 0.0, "other": 0.0},
    }


def estimate_sale(pos: dict, qty: float, price: float, on: str, fees: dict, method: str = "WACC",
                  consume: bool = False) -> dict:
    """Charges, CGT and net result of selling `qty` at `price` on date `on`."""
    sched = schedule_for(fees, on)
    gross = qty * price
    ch = trade_charges(sched, gross)
    avg_cost = pos["cost"] / pos["qty"] if pos["qty"] else 0.0
    avg_tax = pos["taxCost"] / pos["qty"] if pos["qty"] else 0.0
    net_per_share = (gross - ch["commission"] - ch["sebon"]) / qty if qty else 0.0
    remaining, cost_removed, tax_removed, cgt, long_qty = qty, 0.0, 0.0, 0.0, 0.0
    lots = pos["lots"] if consume else [dict(l) for l in pos["lots"]]
    cg = sched["cgt"]
    for lot in lots:
        if remaining <= 1e-9:
            break
        q = min(lot["qty"], remaining)
        if q <= 0:
            continue
        unit_cost = lot["unitCost"] if method == "FIFO" else avg_cost
        unit_tax = lot["unitTax"] if method == "FIFO" else avg_tax
        is_long = _days(lot["date"], on) > cg["longTermDays"]
        rate = cg["longTermRate"] if is_long else cg["shortTermRate"]
        cgt += (q * net_per_share - q * unit_tax) * rate
        cost_removed += q * unit_cost
        tax_removed += q * unit_tax
        long_qty += q if is_long else 0.0
        lot["qty"] -= q
        remaining -= q
    if consume:
        pos["lots"] = [l for l in pos["lots"] if l["qty"] > 1e-9]
    cgt = r2(max(0.0, cgt))
    taxable_gain = gross - ch["commission"] - ch["sebon"] - tax_removed
    net_proceeds = gross - ch["commission"] - ch["sebon"] - ch["dp"] - cgt
    return {
        "gross": gross, **ch, "cgt": cgt, "costRemoved": cost_removed, "taxCostRemoved": tax_removed,
        "taxableGain": taxable_gain, "netProceeds": net_proceeds, "profit": net_proceeds - cost_removed,
        "longTermQty": long_qty, "shortTermQty": qty - long_qty,
    }


def compute(transactions: list[dict], fees: dict, prices: dict[str, float] | None = None,
            options: dict | None = None, today: str | None = None) -> dict:
    opt = {**DEFAULT_OPTIONS, **(options or {})}
    prices = prices or {}
    today = today or date.today().isoformat()
    positions: dict[str, dict] = {}
    events: list[dict] = []   # realized P&L / dividend events (for monthly P&L)
    errors: list[dict] = []
    total_buy_cost = 0.0

    live = [t for t in transactions if not t.get("voided")]
    live = sorted(enumerate(live), key=lambda it: (it[1]["date"], it[0]))
    for _, t in live:
        sym, typ, d = t["symbol"].upper().strip(), t["type"].upper(), t["date"]
        qty, price = float(t.get("qty") or 0), float(t.get("price") or 0)
        pos = positions.setdefault(sym, new_position(sym))
        sched = schedule_for(fees, d)
        other = _num(t, "other") or 0.0

        if typ in ("BUY", "IPO", "RIGHT", "BONUS", "ADJUST"):
            amount = qty * price
            auto = trade_charges(sched, amount) if typ == "BUY" else {"commission": 0.0, "sebon": 0.0, "dp": 0.0}
            ch = {k: (_num(t, k) if _num(t, k) is not None else auto[k]) for k in auto}
            if typ == "BONUS":
                cost, tax_cost = qty * opt["bonusCostBasis"], qty * opt["bonusTaxBasis"]
                pos["bonusQty"] += qty
            else:
                cost = amount + ch["commission"] + ch["sebon"] + ch["dp"] + other
                tax_cost = cost
                if typ == "RIGHT":
                    pos["rightQty"] += qty
            if typ == "ADJUST" and qty < 0:
                if -qty > pos["qty"] + 1e-9:
                    errors.append({"id": t.get("id"), "symbol": sym, "date": d,
                                   "message": f"Adjustment removes {-qty:g} shares but only {pos['qty']:g} held"})
                    continue
                frac = -qty / pos["qty"]
                pos["cost"] -= pos["cost"] * frac
                pos["taxCost"] -= pos["taxCost"] * frac
                pos["qty"] += qty
                rem = -qty
                for lot in pos["lots"]:
                    q = min(lot["qty"], rem)
                    lot["qty"] -= q
                    rem -= q
                pos["lots"] = [l for l in pos["lots"] if l["qty"] > 1e-9]
                continue
            if qty <= 0:
                errors.append({"id": t.get("id"), "symbol": sym, "date": d, "message": "Quantity must be positive"})
                continue
            pos["qty"] += qty
            pos["cost"] += cost
            pos["taxCost"] += tax_cost
            pos["lots"].append({"date": d, "qty": qty, "unitCost": cost / qty, "unitTax": tax_cost / qty})
            pos["firstDate"] = pos["firstDate"] or d
            if typ != "BONUS":
                pos["totalBought"] += cost
                total_buy_cost += cost
            for k in ("commission", "sebon", "dp"):
                pos["fees"][k] += ch[k]
            pos["fees"]["other"] += other

        elif typ == "SELL":
            if qty <= 0 or qty > pos["qty"] + 1e-9:
                errors.append({"id": t.get("id"), "symbol": sym, "date": d,
                               "message": f"Cannot sell {qty:g} shares; only {pos['qty']:g} held on {d}"})
                continue
            est = estimate_sale(pos, qty, price, d, fees, opt["method"], consume=True)
            ch = {k: (_num(t, k) if _num(t, k) is not None else est[k]) for k in ("commission", "sebon", "dp", "cgt")}
            realized = est["gross"] - ch["commission"] - ch["sebon"] - ch["dp"] - ch["cgt"] - other - est["costRemoved"]
            pos["qty"] -= qty
            pos["cost"] -= est["costRemoved"]
            pos["taxCost"] -= est["taxCostRemoved"]
            if pos["qty"] < 1e-9:
                pos["qty"], pos["cost"], pos["taxCost"], pos["lots"] = 0.0, 0.0, 0.0, []
            pos["realized"] += realized
            for k in ("commission", "sebon", "dp", "cgt"):
                pos["fees"][k] += ch[k]
            pos["fees"]["other"] += other
            events.append({"date": d, "symbol": sym, "kind": "SELL", "amount": realized, "qty": qty,
                           "price": price, "costRemoved": est["costRemoved"], "cgt": ch["cgt"]})

        elif typ == "DIVIDEND":
            gross = qty * price
            tax = _num(t, "cgt")
            tax = r2(gross * sched["dividendTaxRate"]) if tax is None else tax
            pos["dividendGross"] += gross
            pos["dividendTax"] += tax
            pos["dividendNet"] += gross - tax
            events.append({"date": d, "symbol": sym, "kind": "DIVIDEND", "amount": gross - tax})
        else:
            errors.append({"id": t.get("id"), "symbol": sym, "date": d, "message": f"Unknown type {typ}"})

    holdings = []
    tot = {"cost": 0.0, "value": 0.0, "unrealized": 0.0, "realized": 0.0, "dividendNet": 0.0,
           "dividendGross": 0.0, "dividendTax": 0.0, "bonusQty": 0.0, "rightQty": 0.0,
           "commission": 0.0, "sebon": 0.0, "dp": 0.0, "cgt": 0.0, "other": 0.0,
           "unpricedCost": 0.0, "netIfSold": 0.0}
    for sym, p in sorted(positions.items()):
        h = {k: v for k, v in p.items()}
        h["avgCost"] = p["cost"] / p["qty"] if p["qty"] else 0.0
        ltp = prices.get(sym)
        h["ltp"] = ltp
        if p["qty"] > 0 and ltp:
            h["value"] = p["qty"] * ltp
            h["unrealized"] = h["value"] - p["cost"]
            h["unrealizedPct"] = h["unrealized"] / p["cost"] * 100 if p["cost"] else None
            h["sellNow"] = estimate_sale(p, p["qty"], ltp, today, fees, opt["method"])
            tot["value"] += h["value"]
            tot["unrealized"] += h["unrealized"]
            tot["netIfSold"] += h["sellNow"]["netProceeds"]
        else:
            h["value"] = h["unrealized"] = h["unrealizedPct"] = h["sellNow"] = None
            if p["qty"] > 0:
                tot["unpricedCost"] += p["cost"]
        tot["cost"] += p["cost"]
        for k in ("realized", "dividendNet", "dividendGross", "dividendTax", "bonusQty", "rightQty"):
            tot[k] += p[k]
        for k in ("commission", "sebon", "dp", "cgt", "other"):
            tot[k] += p["fees"][k]
        holdings.append(h)
    tot["fees"] = tot["commission"] + tot["sebon"] + tot["dp"] + tot["other"]
    tot["netReturn"] = tot["realized"] + tot["unrealized"] + tot["dividendNet"]
    tot["totalBuyCost"] = total_buy_cost
    tot["netReturnPct"] = tot["netReturn"] / total_buy_cost * 100 if total_buy_cost else None
    tot["unrealizedPct"] = tot["unrealized"] / (tot["cost"] - tot["unpricedCost"]) * 100 \
        if tot["cost"] - tot["unpricedCost"] > 0 else None
    tot["holdingCount"] = sum(1 for h in holdings if h["qty"] > 0)
    return {"holdings": holdings, "totals": tot, "events": events, "errors": errors, "options": opt}
