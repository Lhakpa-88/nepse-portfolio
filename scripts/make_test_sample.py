"""Builds a small, real sample of the published data files for the dashboard's render tests.

Run from the repository root:  python -m scripts.make_test_sample   (during a trading session)
Reads frontend/public/data (the local pipeline output) and writes tests/fixtures/site_data.
Files are overwritten in place (the folder is not deleted first: OneDrive can hold a lock on it).
"""
import json
import os
import re

SRC, DST = "frontend/public/data", "tests/fixtures/site_data"
written: set[str] = set()


def rd(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return json.load(f)


def wr(name, obj):
    path = os.path.normpath(os.path.join(DST, name))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    written.add(path)


prices, analysis, market, status, news = rd("prices.json"), rd("analysis.json"), rd("market.json"), rd("status.json"), rd("news.json")
stocks = analysis["stocks"]
want = ["NABIL", "NTC", "SHPC", "NLIC", "UPPER", "CBBL", "HRL", "SANIMA", "BNT"] + [t["symbol"] for t in analysis["top10"]]
no_fund = next(s for s, e in sorted(stocks.items()) if e["fundamentals"] is None)
high_risk = next(s for s, e in sorted(stocks.items()) if e["risk"]["level"] == "High" and e["fundamentals"])
carried = [s for s, e in sorted(stocks.items()) if e.get("carried")]
fund = sorted(r["symbol"] for r in prices["rows"] if r.get("sector") == "Mutual Fund")[0]
want = list(dict.fromkeys(want + [no_fund, high_risk, fund] + carried[:1]))
if not any(s in carried for s in want):
    raise SystemExit("the sample needs at least one stock with no trade yet today: run this during the session")

prices["rows"] = [r for r in prices["rows"] if r["symbol"] in want]
analysis["stocks"] = {s: stocks[s] for s in want if s in stocks}
analysis["top10"] = [t for t in analysis["top10"] if t["symbol"] in analysis["stocks"]]
news["items"], news["newIds"] = news["items"][:10], []
for name, obj in (("prices.json", prices), ("analysis.json", analysis), ("market.json", market), ("status.json", status), ("news.json", news)):
    wr(name, obj)
for s in want + ["NEPSE"]:
    name = "history/" + re.sub(r"[^A-Za-z0-9_-]", "_", s) + ".json"
    h = rd(name)
    h["rows"] = h["rows"][-130:]
    wr(name, h)
in_sample = [s for s in want if s in carried]
wr("README.json", {
    "_note": "Real sample of the published data files (public market data collected during a session), trimmed to a few "
             "symbols. Used only by the dashboard render tests in frontend/src/App.test.tsx.",
    "symbols": want, "noFundamentals": no_fund, "highRisk": high_risk, "mutualFund": fund, "carried": in_sample})

stale = [os.path.join(dp, f) for dp, _, fs in os.walk(DST) for f in fs if os.path.normpath(os.path.join(dp, f)) not in written]
for path in stale:
    try:
        os.remove(path)
    except OSError:
        print("could not remove stale file:", path)
size = sum(os.path.getsize(p) for p in written)
print("symbols:", want)
print("no fundamentals:", no_fund, "| high risk:", high_risk, "| mutual fund:", fund, "| no trade yet today:", in_sample)
print(f"sample: {size // 1024} KB in {len(written)} files; removed {len(stale)} stale file(s)")
