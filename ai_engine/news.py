"""News & announcement monitor.

Collects headlines from sources that expose a machine-readable feed, removes
duplicates, links them to companies/sectors and triages them with transparent
keyword rules (no LLM, so nothing can be hallucinated). Every item keeps its
original link. Social media is deliberately not a source.
"""
from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from backend.collect import read_json, utcnow, write_json
from backend.sources import PROVIDERS, http_get

KEEP_DAYS = 21
MAX_ITEMS = 200

# (category, regex, impact, base sentiment, why, suggested action)
RULES = [
    ("Monetary policy", r"monetary policy|मौद्रिक नीति", "Critical", "Neutral",
     "Monetary policy sets liquidity, interest rates and margin-lending limits for the whole market.",
     "Read the policy highlights; review bank, finance and highly leveraged holdings."),
    ("Fiscal policy & tax", r"budget (speech|announce|unveil|present)|capital gains? tax|\bcgt\b|finance (bill|act)|"
                            r"tax (rate|on (dividend|share|capital))|बजेट (भाषण|वक्तव्य)", "Critical", "Neutral",
     "Budget and tax changes alter after-tax returns and sector incentives.",
     "Check whether CGT or dividend-tax rates changed and update the fee schedule in Settings."),
    ("Merger & acquisition", r"merger|acquisition|\bmerge[sd]?\b|swap ratio|joint operation", "High", "Neutral",
     "Mergers change share count through the swap ratio and can suspend trading.",
     "Check the swap ratio and any trading suspension dates."),
    ("Right share", r"right shares?|rights? (issue|offering)|हकप्रद", "High", "Neutral",
     "Right issues dilute non-participating holders and adjust the market price.",
     "Decide whether to subscribe and keep funds ready before the deadline."),
    ("Dividend", r"dividend (declar|propos|announc|approv|distribut)|(declar|propos|announc)\w* (of |a |the |its |\d+\S* )*"
                 r"(cash |stock )?dividend|cash dividend|bonus shares?|लाभांश|बोनस", "High", "Positive",
     "Dividends add to return; the share price adjusts after book closure.",
     "Note the book-closure date; shares must be held before it to qualify."),
    ("Regulation", r"\bsebon\b|securities board|directive|circular|regulation|margin (lending|loan)|circuit breaker|"
                   r"suspen|halt|penalt|fine[sd]?\b|action against|investigat|insider", "High", "Neutral",
     "Regulatory action can change trading rules or directly restrict a company.",
     "Read the notice; if it names a company you hold, reassess the governance risk."),
    ("Monetary policy", r"nepal rastra|\bnrb\b|policy rate|bank rate|\bcrr\b|\bslr\b|interest rate corridor", "High", "Neutral",
     "Central-bank decisions move bank earnings and overall market liquidity.",
     "No immediate action; note the direction of interest rates and liquidity."),
    ("Macro & liquidity", r"interest rates?|liquidity|inflation|remittance|forex reserve|balance of payment|\bgdp\b", "Moderate", "Neutral",
     "Macro conditions shape market liquidity and sentiment over months, not days.", None),
    ("AGM & book closure", r"book clos|\bagm\b|annual general|sgm|special general", "Moderate", "Neutral",
     "AGMs approve dividends and capital plans; book closure fixes entitlement.",
     "Note the date if you hold the stock."),
    ("Quarterly results", r"quarter|\bq[1-4]\b|net profit|earning|\beps\b|financial (report|result|statement)|"
                          r"profit (rise|fall|grow|declin|surge|drop|jump|plunge|increase|decrease)", "Moderate", "Neutral",
     "Earnings drive the fundamental score and valuation.",
     "Compare with last year's same quarter on the stock's analysis page."),
    ("Fiscal policy & tax", r"\bbudget\b|fiscal|government (spend|revenue|expenditure)|revenue (collection|generation)|\btax\b|बजेट",
     "Moderate", "Neutral", "Government spending and revenue trends affect liquidity and sentiment.", None),
    ("IPO, FPO & listing", r"\bipo\b|\bfpo\b|initial public|allot|issue (open|clos)|listing|listed|auction|debenture|mutual fund",
     "General", "Neutral", "New issues and listings are informational unless you applied.", None),
    ("Market wrap", r"nepse (index|gain|los|clos|drop|fall|ris|surge|plung|end)|turnover|points", "General", "Neutral",
     "Daily market summary.", None),
    ("Banking sector", r"\bbank\b|banks|bfi|microfinance|laghubitta|deposit|loan", "General", "Neutral",
     "Sector news relevant to bank and finance holdings.", None),
]
POS = r"rise|rises|rose|surge|jump|grow|growth|increase|gain|record high|upgrade|approve|profit up|higher|improve|strong"
NEG = r"fall|falls|fell|drop|declin|plunge|loss|decrease|downgrade|default|penalt|fine|suspen|halt|lower|weak|slump|crash|fraud"
SPECULATIVE = r"\bmay\b|\bmight\b|likely|expected to|rumou?r|speculat|sources? say|reportedly|could"
SECTOR_WORDS = {
    "Commercial Banks": r"commercial bank|\bbank\b|banks", "Development Banks": r"development bank|bikas bank",
    "Finance": r"finance compan", "Microfinance": r"microfinance|laghubitta", "Hydro Power": r"hydro|power|jalvidhyut",
    "Life Insurance": r"life insurance", "Non Life Insurance": r"non-?life|general insurance",
    "Hotels And Tourism": r"hotel|tourism", "Manufacturing And Processing": r"cement|manufactur|distiller",
}


def _clean(s: str) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s.replace("�", "'")).strip()


def _id(url: str, title: str) -> str:
    return hashlib.sha1((url or title).encode("utf-8")).hexdigest()[:12]


def from_sharesansar() -> list[dict]:
    page = http_get("https://www.sharesansar.com/category/latest", as_json=False)
    out = []
    for m in re.finditer(r'<a href="(https://www\.sharesansar\.com/newsdetail/[^"]+)"\s+title="([^"]+)".*?text-org">([^<]+)<',
                         page, re.S):
        url, title, when = m.group(1), _clean(m.group(2)), _clean(m.group(3))
        try:
            dt = datetime.strptime(when, "%A, %B %d, %Y").replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
        except ValueError:
            dt = None
        out.append({"title": title, "url": url, "source": "ShareSansar", "publishedAt": dt, "official": False, "symbols": []})
    return out


def from_announcements() -> list[dict]:
    out = []
    for a in PROVIDERS["sharehub"].announcements(60):
        url = a.get("newsUrl") or a.get("attachmentUrl") or "https://sharehubnepal.com/announcements"
        src = a.get("source") or "Company"
        out.append({"title": _clean(a.get("title") or a.get("subTitle") or ""), "url": url,
                    "source": f"{'NEPSE' if src.lower() == 'nepse' else src} announcement (via ShareHub)",
                    "publishedAt": (a.get("announcementDate") or "")[:19] + "+05:45" if a.get("announcementDate") else None,
                    "official": True, "symbols": [a["symbol"]] if a.get("symbol") else []})
    return out


def from_nrb() -> list[dict]:
    feed = http_get("https://www.nrb.org.np/feed/", as_json=False)
    out = []
    for item in re.findall(r"<item>(.*?)</item>", feed, re.S):
        f = dict(re.findall(r"<(title|link|pubDate)>(.*?)</\1>", item, re.S))
        try:
            dt = parsedate_to_datetime(f.get("pubDate", "")).isoformat(timespec="seconds")
        except (TypeError, ValueError):
            dt = None
        title = _clean(re.sub(r"<!\[CDATA\[|\]\]>", "", f.get("title", "")))
        if title:
            out.append({"title": title, "url": _clean(f.get("link", "")), "source": "Nepal Rastra Bank", "publishedAt": dt,
                        "official": True, "symbols": [], "forceCategory": "Monetary policy"})
    return out


SOURCES = {
    "sharesansar": ("ShareSansar latest news", from_sharesansar),
    "announcements": ("NEPSE & company announcements (via ShareHub)", from_announcements),
    "nrb": ("Nepal Rastra Bank notices (RSS)", from_nrb),
}


def classify(item: dict, companies: dict) -> dict:
    title = item["title"]
    low = title.lower()
    symbols = set(item.get("symbols") or [])
    symbols.update(s for s in re.findall(r"\(([A-Z]{2,10})\)", title) if s in companies)
    for sym, c in companies.items():
        name = re.sub(r"\b(limited|ltd\.?|company|co\.)\b", "", (c.get("name") or "").lower()).strip()
        if len(name) >= 8 and name in low:
            symbols.add(sym)
        elif len(sym) >= 4 and re.search(rf"\b{re.escape(sym)}\b", title):
            symbols.add(sym)
    rule = next((r for r in RULES if re.search(r[1], low)), None)
    if item.get("forceCategory") and (not rule or rule[2] not in ("Critical",)):
        base = next(r for r in RULES if r[0] == item["forceCategory"])
        rule = (base[0], base[1], "High" if rule and rule[0] == "Monetary policy" else "Moderate", base[3], base[4], base[5])
    cat, _, impact, sentiment, why, action = rule or ("General", "", "General", "Neutral", "General market information.", None)
    pos, neg = bool(re.search(POS, low)), bool(re.search(NEG, low))
    if pos != neg:
        sentiment = "Positive" if pos else "Negative"
    elif pos and neg:
        sentiment = "Neutral"
    speculative = bool(re.search(SPECULATIVE, low))
    # company-specific items matter less market-wide: keep "High" only for the listed categories
    if symbols and impact == "Critical" and cat not in ("Monetary policy", "Fiscal policy & tax"):
        impact = "High"
    if re.search(r"suspen|halt|default|fraud", low):
        impact, sentiment = ("Critical" if not symbols else "High"), "Negative"
    sectors = sorted({c["sector"] for s in symbols if (c := companies.get(s)) and c.get("sector")} |
                     {sec for sec, rx in SECTOR_WORDS.items() if not symbols and re.search(rx, low)})
    return {
        "id": _id(item["url"], title), "title": title, "url": item["url"], "source": item["source"],
        "publishedAt": item.get("publishedAt"), "symbols": sorted(symbols)[:8], "sectors": sectors[:4],
        "category": cat, "impact": impact, "sentiment": sentiment,
        "confirmed": bool(item.get("official")) and not speculative,
        "why": why + (" Wording suggests this is not yet confirmed." if speculative else ""),
        "action": action,
    }


def _norm(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9ऀ-ॿ]+", title.lower()) if len(w) > 2}


def dedupe(items: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen_ids, token_sets = set(), []
    for it in items:   # official sources are listed first so they win ties
        if it["id"] in seen_ids:
            continue
        toks = _norm(it["title"])
        if toks and any(len(toks & t) / len(toks | t) >= 0.75 for t in token_sets):
            continue
        seen_ids.add(it["id"])
        token_sets.append(toks)
        out.append(it)
    return out


def run(out: Path) -> dict:
    companies = read_json(out / "companies.json", {})
    prev = read_json(out / "news.json", {"items": []})
    status, raw = {}, []
    for key, (label, fn) in SOURCES.items():
        try:
            got = fn()
            raw.extend(got)
            status[key] = {"label": label, "ok": True, "count": len(got)}
        except Exception as e:  # noqa: BLE001 - one failing source must not stop the others
            status[key] = {"label": label, "ok": False, "count": 0, "error": str(e)[:160]}
    fresh = [classify(i, companies) for i in raw if i.get("title")]
    first_run = not prev.get("items")          # do not flood alerts with the whole backlog on the first run
    known = {i["id"] for i in prev.get("items", [])}
    for i in fresh:
        i["firstSeen"] = utcnow()
    merged = fresh + [i for i in prev.get("items", []) if i["id"] not in {f["id"] for f in fresh}]
    for i in merged:
        old = next((p for p in prev.get("items", []) if p["id"] == i["id"]), None)
        if old:
            i["firstSeen"] = old.get("firstSeen", i.get("firstSeen"))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    merged = [i for i in merged if (i.get("publishedAt") or i.get("firstSeen") or "9") >= cutoff[:10]]
    merged.sort(key=lambda i: (not i["confirmed"],))                       # official first for tie-breaking
    items = dedupe(merged)
    items.sort(key=lambda i: (i.get("publishedAt") or i.get("firstSeen") or "")[:19], reverse=True)
    result = {"generatedAt": utcnow(), "items": items[:MAX_ITEMS], "sources": status,
              "newIds": [] if first_run else [i["id"] for i in items if i["id"] not in known]}
    write_json(out / "news.json", result)
    return result
