"""Data-source layer: HTTP client with rate limiting/retries + provider adapters.

IMPORTANT: every provider here is an UNOFFICIAL, undocumented public endpoint
(the JSON a site's own web page loads). None is an official NEPSE API. They
may change without notice, so every capability has an ordered fallback chain
(config/sources.json) and each call's outcome is recorded for status.json.
Nothing in this module ever invents a price: a failed fetch raises.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))

_last_call: dict[str, float] = {}


class SourceError(Exception):
    pass


def http_get(url: str, as_json: bool = True, timeout: float | None = None):
    """GET with per-host rate limit, retry and exponential backoff."""
    host = urllib.parse.urlparse(url).netloc
    retries = CONFIG.get("retries", 3)
    err: Exception | None = None
    for attempt in range(retries):
        wait = CONFIG.get("minIntervalSeconds", 0.3) - (time.time() - _last_call.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last_call[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": CONFIG["userAgent"], "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout or CONFIG.get("timeoutSeconds", 25)) as r:
                body = r.read().decode("utf-8", errors="replace")
            return json.loads(body) if as_json else body
        except urllib.error.HTTPError as e:
            err = e
            if e.code in (400, 401, 403, 404):       # not retryable
                break
            time.sleep(2 ** attempt * (3 if e.code == 429 else 1))
        except Exception as e:  # network errors, bad JSON
            err = e
            time.sleep(2 ** attempt)
    raise SourceError(f"{host}: {err}")


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


SECTOR_ALIASES = {
    "banking": "Commercial Banks", "commercial bank": "Commercial Banks", "commercial banks": "Commercial Banks",
    "development bank": "Development Banks", "development banks": "Development Banks",
    "hydropower": "Hydro Power", "hydro power": "Hydro Power",
    "manu.& pro.": "Manufacturing And Processing", "manufacturing and processing": "Manufacturing And Processing",
    "trading": "Tradings", "tradings": "Tradings", "hotels and tourism": "Hotels And Tourism",
    "non life insurance": "Non Life Insurance", "life insurance": "Life Insurance",
    "microfinance": "Microfinance", "finance": "Finance", "investment": "Investment",
    "mutual fund": "Mutual Fund", "others": "Others",
}


def norm_sector(name: str | None) -> str | None:
    if not name:
        return None
    return SECTOR_ALIASES.get(name.strip().lower(), name.strip())


# --------------------------------------------------------------------------- providers
class ShareHub:
    name = "sharehub"
    label = "ShareHub Nepal (sharehubnepal.com) - unofficial public endpoints"
    base = "https://sharehubnepal.com"

    def prices(self):
        d = http_get(f"{self.base}/live/api/v2/nepselive/live-nepse")["data"]
        rows = []
        for x in d:
            ltp = _f(x.get("lastTradedPrice"))
            if not x.get("symbol") or not ltp:
                continue
            rows.append({
                "symbol": x["symbol"], "name": x.get("securityName"), "sector": norm_sector(x.get("sector")),
                "open": _f(x.get("openPrice")), "high": _f(x.get("highPrice")), "low": _f(x.get("lowPrice")),
                "ltp": ltp, "prevClose": _f(x.get("previousClose")), "pctChange": _f(x.get("percentageChange")),
                "volume": _f(x.get("totalTradeQuantity")), "turnover": _f(x.get("totalTradeValue")),
                "transactions": _f(x.get("totalTransactions")), "asOf": (x.get("lastUpdatedDateTime") or "")[:19],
            })
        return rows

    def indices(self):
        d = http_get(f"{self.base}/live/api/v2/nepselive/index")
        out = [{"name": x["index"], "value": _f(x.get("currentValue")), "prev": _f(x.get("close")),
                "change": _f(x.get("change")), "pctChange": _f(x.get("perChange")),
                "high": _f(x.get("high")), "low": _f(x.get("low")),
                "high52": _f(x.get("fiftyTwoWeekHigh")), "low52": _f(x.get("fiftyTwoWeekLow")),
                "asOf": (x.get("generatedTime") or "")[:19]} for x in d]
        summary = {}
        try:
            for x in http_get(f"{self.base}/live/api/v2/nepselive/market-summary"):
                summary[x["detail"].strip(": ").replace(" Rs", "")] = _f(x["value"])
        except SourceError:
            pass
        return {"main": out, "sectors": [], "summary": {
            "turnover": summary.get("Total Turnover"), "volume": summary.get("Total Traded Shares"),
            "transactions": summary.get("Total Transactions"), "scripsTraded": summary.get("Total Scrips Traded"),
            "marketCap": summary.get("Total Market Capitalization"),
            "floatMarketCap": summary.get("Total Float Market Capitalization")}}

    def fundamentals(self, symbol: str):
        d = http_get(f"{self.base}/data/api/v1/fundamental/values/{urllib.parse.quote(symbol)}").get("data") or []
        periods = []
        for p in d:
            vals = {v["key"]: v.get("value") for v in p.get("values", []) if v.get("value") is not None}
            periods.append({"fiscalYear": p.get("fiscalYear"), "quarter": (p.get("quarter") or "").lower(), "values": vals})
        return periods

    def dividends(self, symbol: str):
        d = http_get(f"{self.base}/data/api/v1/dividend?symbol={urllib.parse.quote(symbol)}&limit=10")
        return [{"fiscalYear": x.get("fiscalYear"), "bonus": _f(x.get("bonus")) or 0.0, "cash": _f(x.get("cash")) or 0.0,
                 "announced": (x.get("announcementDate") or "")[:10], "bookClosure": (x.get("bookClosureDate") or "")[:10],
                 "status": x.get("status")} for x in (d.get("data") or {}).get("content", [])]

    def announcements(self, size: int = 40):
        d = http_get(f"{self.base}/data/api/v1/announcement?Size={size}&Page=1")
        return (d.get("data") or {}).get("content", [])


class NepaliPaisa:
    name = "nepalipaisa"
    label = "NepaliPaisa (nepalipaisa.com) - unofficial public endpoints"
    base = "https://nepalipaisa.com/api"

    def prices(self):
        d = http_get(f"{self.base}/GetStockLive")["result"]["stocks"]
        return [{
            "symbol": x["stockSymbol"], "name": x.get("companyName"), "sector": None,
            "open": _f(x.get("openingPrice")), "high": _f(x.get("maxPrice")), "low": _f(x.get("minPrice")),
            "ltp": _f(x.get("closingPrice")), "prevClose": _f(x.get("previousClosing")),
            "pctChange": _f(x.get("percentChange")), "volume": _f(x.get("volume")), "turnover": _f(x.get("amount")),
            "transactions": _f(x.get("noOfTransactions")), "asOf": (x.get("asOfDate") or "")[:19],
        } for x in d if x.get("stockSymbol") and _f(x.get("closingPrice"))]

    def indices(self):
        def conv(x, sector=False):
            return {"name": norm_sector(x["indexName"]) if sector else x["indexName"], "value": _f(x.get("indexValue")),
                    "prev": _f(x.get("previousValue")), "change": _f(x.get("difference")),
                    "pctChange": _f(x.get("percentChange")), "high": _f(x.get("dayHigh")), "low": _f(x.get("dayLow")),
                    "turnover": _f(x.get("turnover")), "asOf": (x.get("asOfDate") or "")[:19]}
        main = http_get(f"{self.base}/GetIndexLive")["result"]
        sub = http_get(f"{self.base}/GetSubIndexLive")["result"]
        n = next((x for x in main if x["indexName"].lower() == "nepse"), main[0])
        names = {"Nepse": "NEPSE Index", "Sensitive": "Sensitive Index", "Float": "Float Index",
                 "Sen. Float": "Sensitive Float Index"}
        mains = [conv(x) for x in main]
        for m in mains:
            m["name"] = names.get(m["name"], m["name"])
        return {"main": mains, "sectors": [conv(x, True) for x in sub], "summary": {
            "turnover": _f(n.get("turnover")), "volume": _f(n.get("volume")),
            "transactions": _f(n.get("noOfTransactions")), "scripsTraded": _f(n.get("noOfTradedCompanies")),
            "marketCap": _f(n.get("marketCap")), "gainers": _f(n.get("noOfGainers")),
            "losers": _f(n.get("noOfLosers")), "unchanged": _f(n.get("noOfUnchanged"))}}

    def history(self, symbol: str):
        to = datetime.now(timezone.utc).date().isoformat()
        url = (f"{self.base}/GetStockHistory?stockSymbol={urllib.parse.quote(symbol)}"
               f"&fromDate=2000-01-01&toDate={to}&pageNo=1&itemsPerPage=520")
        d = http_get(url)["result"]["data"]
        rows = [[x["tradeDateString"], None, _f(x.get("maxPrice")), _f(x.get("minPrice")), _f(x.get("closingPrice")),
                 _f(x.get("volume"))] for x in d if _f(x.get("closingPrice"))]
        return sorted(rows)


class Chukul:
    name = "chukul"
    label = "Chukul (chukul.com) - unofficial public endpoints"
    base = "https://chukul.com/api"

    def prices(self):
        d = http_get(f"{self.base}/data/v2/market-summary/")
        return [{
            "symbol": x["symbol"], "name": None, "sector": None, "open": _f(x.get("open")), "high": _f(x.get("high")),
            "low": _f(x.get("low")), "ltp": _f(x.get("close")), "prevClose": _f(x.get("prev_close")),
            "pctChange": _f(x.get("percentage_change")), "volume": _f(x.get("volume")), "turnover": _f(x.get("amount")),
            # during the session this feed reports "YYYY-MM-DD HH:MM:SS"; after the close just the date
            "transactions": None, "asOf": str(x.get("date") or "").replace(" ", "T")[:19],
        } for x in d if x.get("symbol") and _f(x.get("close"))]

    def history(self, symbol: str):
        d = http_get(f"{self.base}/data/historydata/?symbol={urllib.parse.quote(symbol)}")
        rows = [[str(x["date"])[:10], _f(x.get("open")), _f(x.get("high")), _f(x.get("low")), _f(x.get("close")),
                 _f(x.get("volume"))] for x in d if x.get("date") and _f(x.get("close"))]
        return sorted(rows)


PROVIDERS = {p.name: p for p in (ShareHub(), NepaliPaisa(), Chukul())}


class Registry:
    """Runs a capability through its fallback chain and records health."""

    def __init__(self):
        self.log: dict[str, dict] = {}

    def call(self, capability: str, *args, quiet: bool = False):
        chain = CONFIG["capabilities"].get(capability, [])
        errors = []
        for rank, name in enumerate(chain):
            fn = getattr(PROVIDERS[name], capability, None)
            if fn is None:
                continue
            try:
                data = fn(*args)
                if not data:
                    raise SourceError(f"{name}: empty response")
                if not quiet:
                    self.log[capability] = {
                        "ok": True, "source": name, "label": PROVIDERS[name].label,
                        "role": ["primary", "secondary", "fallback"][min(rank, 2)],
                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "errors": errors,
                    }
                return data, name
            except Exception as e:  # noqa: BLE001 - any provider failure triggers fallback
                errors.append(f"{name}: {e}")
        if not quiet:
            self.log[capability] = {"ok": False, "source": None, "errors": errors,
                                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        raise SourceError(f"All sources failed for {capability}: {errors}")
