"""Pipeline entry point (run from the repository root).

  python -m scripts.run_pipeline auto            # picks the right job for the current Nepal time (used by GitHub Actions)
  python -m scripts.run_pipeline collect         # prices, indices, history, fundamentals
  python -m scripts.run_pipeline analyze         # technicals, scores, screens
  python -m scripts.run_pipeline news            # news & announcements
  python -m scripts.run_pipeline alerts          # evaluate and send alerts
  python -m scripts.run_pipeline report daily    # premarket | daily | weekly | monthly
  python -m scripts.run_pipeline all             # collect + analyze + news + alerts (no report)
  python -m scripts.run_pipeline test-telegram   # guided Telegram check (tells you your chat id, then sends a test)
  python -m scripts.run_pipeline test-email      # send a test email

Options: --out DIR (default frontend/public/data)  --dry-run (print instead of sending)  --no-fundamentals
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ai_engine import news as news_mod  # noqa: E402
from ai_engine import report as report_mod  # noqa: E402
from analytics import build as analysis  # noqa: E402
from backend import collect, secure_store  # noqa: E402
from backend import market_calendar as cal  # noqa: E402
from notifications import alerts as alert_mod  # noqa: E402
from notifications import telegram  # noqa: E402


def step(name, fn, private: bool = False):
    """Runs one stage; a failure is logged and reported but does not stop later stages.

    `private` marks stages that handle the portfolio. In a public CI log their errors are reduced to the
    location and the error type, because an exception message can contain holdings or prices.
    """
    try:
        print(f"[{name}] start")
        res = fn()
        print(f"[{name}] ok")
        return res
    except SystemExit as e:
        print(f"[{name}] skipped: {e}")
    except Exception as e:  # noqa: BLE001
        print(f"[{name}] FAILED")
        if private and secure_store.logs_are_public():
            for f in traceback.extract_tb(e.__traceback__):
                print(f'  File "{Path(f.filename).name}", line {f.lineno}, in {f.name}')
            print(f"  {type(e).__name__} (message hidden: it may contain portfolio data and this log is public)")
        else:
            traceback.print_exc()
        ERRORS.append(name)
    return None


ERRORS: list[str] = []


def subject_of(text: str) -> str:
    """Email subject for an alert: its heading, plus the stock and signal when it has them."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    parts = [lines[0] if lines else "NEPSE alert"]
    for prefix in ("Stock:", "Signal:"):
        value = next((ln[len(prefix):].strip() for ln in lines if ln.startswith(prefix)), "")
        if value:
            parts.append(value.split(" (")[0].split(" | ")[0])
    return " - ".join(parts)[:120]


NOTED: set[str] = set()


def note_portfolio(portfolio, how: str) -> None:
    """Says once, on the run page, whether the private portfolio could be used - never anything about its content."""
    if "portfolio" in NOTED or not secure_store.logs_are_public():
        return
    NOTED.add("portfolio")
    if portfolio is not None:
        annotate("notice", "Your portfolio was loaded",
                 f"This run used your holdings (source - {how}), so its alerts and reports are position-aware.")
    elif "no portfolio configured" not in how:
        annotate("warning", "Your portfolio was NOT loaded", f"{how}. This run used market data only.")


def do_alerts(out: Path, dry: bool):
    portfolio, how = secure_store.load_portfolio()
    private = portfolio is not None
    print(f"[alerts] portfolio source: {how}")
    note_portfolio(portfolio, how)
    ctx = alert_mod.build_context(portfolio, out)
    found = alert_mod.generate(ctx)
    if dry:
        print(f"[alerts] {len(found)} candidate alert(s) (dry run: nothing sent, state not updated)")
        if private and secure_store.logs_are_public():
            print("[alerts] " + secure_store.loggable("", private))
        else:
            for a in found[: alert_mod.CFG["maxAlertsPerRun"]]:
                print("\n" + a["text"])
        return ctx, found
    reasons: set[str] = set()

    def deliver(a: dict) -> bool:
        res = telegram.notify(a["text"], subject=subject_of(a["text"]), email=a["kind"] in ("stop", "critical_news"),
                              private=private)
        if not res["delivered"]:
            reasons.add(res["reason"] or "unknown")
        return res["delivered"]

    sent, failed = alert_mod.filter_new(found, out, private, deliver)
    print(f"[alerts] {len(found)} candidate(s), {len(sent)} delivered"
          + (f", {len(failed)} NOT delivered ({'; '.join(sorted(reasons))}) - they will be retried" if failed else ""))
    if any("not configured" not in r for r in reasons):
        ERRORS.append("alert delivery")       # a configured channel is failing: make the run visibly fail
    if (sent or failed) and secure_store.logs_are_public():
        repeats = len(found) - len(sent) - len(failed)
        annotate("notice", "Alerts", f"{len(sent)} delivered"
                 + (f" and {len(failed)} could not be delivered ({'; '.join(sorted(reasons))})" if failed else "")
                 + (f". {repeats} more were sent recently and are not repeated yet" if repeats > 0 else "") + ".")
    return ctx, sent


def do_report(kind: str, out: Path, dry: bool, sent=None):
    portfolio, how = secure_store.load_portfolio()
    private = portfolio is not None
    note_portfolio(portfolio, how)
    ctx = alert_mod.build_context(portfolio, out)
    text = report_mod.build(kind, ctx, out, sent)
    summary = report_mod.narrative(text)
    if summary:
        text += "\n\nAI summary (from the figures above): " + summary
    if dry:
        print(secure_store.loggable(text, private))
        return False
    res = telegram.notify(text, subject=f"NEPSE {kind} report", email=kind in ("weekly", "monthly"), private=private)
    print(f"[{kind} report] " + ("delivered" if res["delivered"] else f"NOT delivered ({res['reason']})"))
    if not res["delivered"] and "not configured" not in (res["reason"] or ""):
        ERRORS.append(f"{kind} report delivery")
    if res["delivered"] and secure_store.logs_are_public():
        annotate("notice", f"The {kind} report was delivered",
                 "It includes your holdings." if private else "It is a market-only report because no portfolio was loaded.")
    return res["delivered"]


def scheduled_report(kind: str, out: Path, dry: bool, day: str, sent=None) -> None:
    """Sends a report at most once per `day`, on whichever run gets there first (state/reports.json remembers)."""
    path = out / "state" / "reports.json"
    state = collect.read_json(path, {})
    if state.get(kind) == day:
        print(f"[{kind} report] already sent for {day} - not repeated")
        return
    delivered = step(f"{kind} report", lambda: do_report(kind, out, dry, sent), private=True)
    if delivered and not dry:
        state[kind] = day
        collect.write_json(path, state)


def annotate(level: str, title: str, message: str) -> None:
    """A notice or error shown at the top of the GitHub run page, so the reason is visible without opening the log.

    That page is public: never pass a token, a chat id or anything from the portfolio. `title` must not contain
    ':' or ',' (GitHub's annotation syntax).
    """
    if secure_store.logs_are_public():
        print(f"::{level} title={title}::{message}")
    else:
        print(f"[{level}] {title}. {message}")


def test_telegram() -> int:
    """Guided check of the Telegram setup. With only the token set, the bot first tells you your chat id."""
    token, chat = telegram.credentials()
    if not token:
        annotate("error", "TELEGRAM_BOT_TOKEN is not set",
                 "Create a bot with @BotFather in Telegram, then add its token under Settings > Secrets and variables > "
                 "Actions as TELEGRAM_BOT_TOKEN and run test-telegram again.")
        return 1
    if not chat:
        res = telegram.send_chat_ids()
        if res["replied"]:
            annotate("notice", "Check Telegram - your bot has sent you your chat ID",
                     "Add that number under Settings > Secrets and variables > Actions as TELEGRAM_CHAT_ID, "
                     "then run test-telegram again to receive the test message.")
            return 0
        annotate("error", "The bot could not reach you yet", f"{res['reason']}. Then run test-telegram again.")
        return 1
    res = telegram.notify("NEPSE Portfolio Intelligence: test message. Your Telegram notifications are working.")
    if res["delivered"]:
        annotate("notice", "Telegram is working", "The test message was delivered. Alerts and reports will arrive in that chat.")
        return 0
    annotate("error", "The test message was not delivered", f"{res['reason']}.")
    return 1


def test_email() -> int:
    """Guided check of the email setup."""
    if telegram.email_settings() is None:
        annotate("error", "Email is not set up",
                 "Add two secrets under Settings > Secrets and variables > Actions - SMTP_USER (your full email address) "
                 "and SMTP_PASSWORD (for Gmail this is a 16-character app password and not your normal password). "
                 "Providers other than Gmail also need SMTP_HOST. Then run test-email again.")
        return 1
    res = telegram.send_email("NEPSE Portfolio Intelligence - test", "Test message. Your email notifications are working.")
    if res["sent"]:
        annotate("notice", "Email is working", "The test email was sent. Check your inbox and the spam folder the first time.")
        return 0
    annotate("error", "The test email was not sent", f"{res['reason']}.")
    return 1


def auto(out: Path, dry: bool):
    """Chooses work from the Nepal clock, so late or skipped cron triggers still do the right thing."""
    now = cal.now_npt()
    sess = cal.session(now)
    hm = now.hour * 60 + now.minute
    print(f"[auto] Nepal time {now:%Y-%m-%d %H:%M} | session {sess}")
    today = now.date().isoformat()
    morning, evening = hm < 13 * 60, hm >= 17 * 60
    res = None
    if sess == "pre":
        step("news", lambda: news_mod.run(out))
        step("collect", lambda: collect.run(out, with_fundamentals=False))
    elif sess == "open":
        step("collect", lambda: collect.run(out, with_fundamentals=False))
        step("analyze", lambda: analysis.build(out))
        step("news", lambda: news_mod.run(out))
        res = step("alerts", lambda: do_alerts(out, dry), private=True)
    elif sess == "post":
        step("collect", lambda: collect.run(out, with_fundamentals=True))
        step("analyze", lambda: analysis.build(out))
        step("news", lambda: news_mod.run(out))
        res = step("alerts", lambda: do_alerts(out, dry), private=True)
    else:   # market closed (Friday / Saturday / holiday)
        step("news", lambda: news_mod.run(out))
        step("collect", lambda: collect.run(out, with_fundamentals=True))
        step("analyze", lambda: analysis.build(out))
    # Reports are tied to the day, not to one trigger: GitHub starts scheduled runs late and sometimes skips a slot,
    # so each report goes out on the first suitable run and is then not repeated.
    if sess in ("pre", "open") and morning:
        scheduled_report("premarket", out, dry, today)
    if sess == "post" and evening:
        scheduled_report("daily", out, dry, today, res[1] if res else None)
    if evening and now.weekday() == 4:                 # Friday evening
        scheduled_report("weekly", out, dry, today)
    if evening and now.day == 1:
        scheduled_report("monthly", out, dry, today)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["auto", "collect", "analyze", "news", "alerts", "report", "all", "test-telegram",
                                        "test-email"])
    ap.add_argument("kind", nargs="?", default="daily", choices=["premarket", "daily", "weekly", "monthly"])
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "data"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-fundamentals", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    dry = a.dry_run or os.environ.get("DRY_RUN") == "1"

    if a.command == "auto":
        auto(out, dry)
    elif a.command == "collect":
        st = step("collect", lambda: collect.run(out, with_fundamentals=not a.no_fundamentals))
        if st:
            print(f"market date {st['marketDate']} | {st['freshness']['state']} | reliability {st['reliability']}")
    elif a.command == "analyze":
        step("analyze", lambda: analysis.build(out))
    elif a.command == "news":
        res = step("news", lambda: news_mod.run(out))
        if res:
            print(f"{len(res['items'])} items, {len(res['newIds'])} new; sources: "
                  + ", ".join(f"{k}={'ok' if v['ok'] else 'FAILED'}" for k, v in res["sources"].items()))
    elif a.command == "alerts":
        step("alerts", lambda: do_alerts(out, dry), private=True)
    elif a.command == "report":
        step("report", lambda: do_report(a.kind, out, dry), private=True)
    elif a.command == "all":
        step("collect", lambda: collect.run(out, with_fundamentals=not a.no_fundamentals))
        step("analyze", lambda: analysis.build(out))
        step("news", lambda: news_mod.run(out))
        step("alerts", lambda: do_alerts(out, dry), private=True)
    elif a.command == "test-telegram":
        return test_telegram()
    elif a.command == "test-email":
        return test_email()
    if ERRORS:
        print(f"Completed with failures in: {', '.join(ERRORS)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
