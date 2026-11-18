"""Tests for indicators, scoring with incomplete data, calendar, failover, encryption, alert noise control
and the rule that nothing built from the private portfolio reaches a public CI log."""
import contextlib
import io
import json
import os
import tempfile
import unittest
import urllib.error
from datetime import datetime
from pathlib import Path
from unittest import mock

from ai_engine import news, report
from analytics import build
from analytics import scoring as sc
from analytics import technicals as ta
from backend import collect, market_calendar as cal, secure_store, sources
from notifications import alerts, telegram
from scripts import run_pipeline

ROOT = Path(__file__).resolve().parents[1]


class TechnicalsTest(unittest.TestCase):
    def test_sma_and_insufficient_history(self):
        self.assertEqual(ta.sma([1, 2, 3, 4], 2), 3.5)
        self.assertIsNone(ta.sma([1, 2], 5))
        self.assertIsNone(ta.rsi([1, 2, 3]))
        self.assertIsNone(ta.macd(list(range(20))))

    def test_rsi_extremes(self):
        self.assertEqual(ta.rsi([float(i) for i in range(1, 40)]), 100.0)          # only gains
        self.assertAlmostEqual(ta.rsi([float(40 - i) for i in range(1, 40)]), 0.0)  # only losses

    def test_rsi_known_value(self):
        # Wilder's textbook series -> RSI(14) of the 15th close is 70.46
        closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
        self.assertAlmostEqual(ta.rsi(closes), 70.46, delta=0.1)

    def test_bollinger_and_drawdown(self):
        b = ta.bollinger([10.0] * 20)
        self.assertEqual((b["upper"], b["lower"], b["mid"]), (10.0, 10.0, 10.0))
        self.assertAlmostEqual(ta.max_drawdown([100, 120, 90, 110]), -25.0)

    def test_breakout_detection(self):
        rows = [[f"2025-01-{i:02d}", 100, 101, 99, 100, 1000] for i in range(1, 29)]
        rows.append(["2025-01-29", 100, 110, 100, 109, 5000])   # closes above the 20-day high on 5x volume
        t = ta.analyse(rows)
        self.assertTrue(t["breakout"])
        self.assertFalse(t["breakdown"])
        self.assertAlmostEqual(t["volRatio"], 5.0)


class ScoringIncompleteDataTest(unittest.TestCase):
    def test_no_fundamentals_never_yields_buy(self):
        # accelerating uptrend with a small pullback every 5th session (a straight line would give a flat MACD)
        px = [100 * 1.004 ** i * (0.99 if i % 5 == 0 else 1.0) for i in range(260)]
        rows = [[f"d{i}", None, p * 1.005, p * 0.995, p, 10000] for i, p in enumerate(px)]
        t = ta.analyse(rows)
        parts = {"fundamental": sc.fundamental_score(None, "Hydro Power", {}), "technical": sc.technical_score(t),
                 "valuation": sc.valuation_score(360, None, {})}
        parts["market"] = sc.market_score({"score": 80}, {}, None)
        parts["risk"] = sc.risk_score(t, None, parts["valuation"], "Hydro Power", {"low": 35, "medium": 60})
        q, coverage = sc.combine(parts, {"fundamental": 35, "technical": 25, "valuation": 15, "market": 15, "risk": 10})
        stance, reasons = sc.stance(q, parts, {"buy": 70, "accumulate": 60, "hold": 45, "reduce": 35})
        self.assertEqual(parts["technical"]["outlook"], "Bullish")
        self.assertEqual(stance, "WATCH")                      # bullish chart alone is not a recommendation
        self.assertIn("Incomplete", reasons[0])
        self.assertLess(coverage, 0.6)                          # confidence input drops with missing areas

    def test_loss_making_company_scores_zero_on_earnings(self):
        f = {"eps": -5, "roe": -3, "bookValue": 90, "dividends": []}
        self.assertEqual(sc.fundamental_score(f, "Hydro Power", {})["components"]["earnings"], 0.0)
        self.assertEqual(sc.valuation_score(200, f, {})["components"]["pe"], 0.0)

    def test_short_history_reports_gap(self):
        t = ta.analyse([[f"d{i}", None, 10, 9, 10, 100] for i in range(10)])
        self.assertIsNone(sc.technical_score(t)["score"])


class CalendarTest(unittest.TestCase):
    def at(self, s):
        return datetime.fromisoformat(s).replace(tzinfo=cal.NPT)

    def test_sessions(self):
        self.assertEqual(cal.session(self.at("2026-11-17T12:00")), "open")      # Tuesday
        self.assertEqual(cal.session(self.at("2026-11-17T10:00")), "pre")
        self.assertEqual(cal.session(self.at("2026-11-17T15:30")), "post")
        self.assertEqual(cal.session(self.at("2026-11-20T12:00")), "closed")    # Friday
        self.assertEqual(cal.session(self.at("2026-11-21T12:00")), "closed")    # Saturday
        self.assertEqual(cal.session(self.at("2026-11-22T12:00")), "open")      # Sunday trades

    def test_freshness_never_hides_stale_prices(self):
        now = self.at("2026-11-17T16:00")
        self.assertEqual(cal.freshness("2026-11-17", now)["state"], "fresh")
        self.assertEqual(cal.freshness("2026-11-16", now)["state"], "delayed")
        self.assertEqual(cal.freshness("2026-11-12", now)["state"], "stale")
        self.assertEqual(cal.freshness(None, now)["state"], "unavailable")
        # Saturday: Thursday's close is still the latest expected session
        self.assertEqual(cal.freshness("2026-11-19", self.at("2026-11-21T12:00"))["state"], "fresh")


class SourceFailoverTest(unittest.TestCase):
    def test_falls_back_and_records_health(self):
        good = [{"symbol": "X", "ltp": 10.0, "asOf": "2026-11-17T15:00:00"}]
        with mock.patch.object(sources.PROVIDERS["sharehub"], "prices", side_effect=sources.SourceError("boom")), \
                mock.patch.object(sources.PROVIDERS["nepalipaisa"], "prices", return_value=good):
            reg = sources.Registry()
            data, used = reg.call("prices")
        self.assertEqual(used, "nepalipaisa")
        self.assertEqual(reg.log["prices"]["role"], "secondary")
        self.assertIn("sharehub", reg.log["prices"]["errors"][0])

    def test_total_failure_raises_and_writes_no_prices(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.multiple(sources.PROVIDERS["sharehub"], prices=mock.Mock(side_effect=sources.SourceError("x"))), \
                mock.patch.object(sources.PROVIDERS["nepalipaisa"], "prices", side_effect=sources.SourceError("x")), \
                mock.patch.object(sources.PROVIDERS["chukul"], "prices", side_effect=sources.SourceError("x")):
            reg = sources.Registry()
            self.assertIsNone(collect.collect_prices(Path(d), reg))
            self.assertFalse((Path(d) / "prices.json").exists())      # nothing fabricated
            self.assertFalse(reg.log["prices"]["ok"])
            status = collect.write_status(Path(d), reg, None)
            self.assertEqual(status["freshness"]["state"], "unavailable")
            self.assertEqual(status["reliability"], "down")


class EncryptionTest(unittest.TestCase):
    def test_roundtrip_and_wrong_passphrase(self):
        try:
            import cryptography  # noqa: F401
        except ImportError:
            self.skipTest("cryptography not installed")
        blob = secure_store.encrypt_blob({"transactions": [{"symbol": "DEMO"}]}, "correct horse battery", iterations=1000)
        self.assertNotIn("DEMO", json.dumps(blob))
        self.assertEqual(secure_store.decrypt_blob(blob, "correct horse battery")["transactions"][0]["symbol"], "DEMO")
        with self.assertRaises(Exception):
            secure_store.decrypt_blob(blob, "wrong passphrase")

    def test_file_encrypted_by_the_dashboard_decrypts_in_the_pipeline(self):
        """The cross-language contract: the same DEMO fixture is decrypted by frontend/src/lib/crypto.test.ts."""
        try:
            import cryptography  # noqa: F401
        except ImportError:
            self.skipTest("cryptography not installed")
        fx = json.loads((ROOT / "tests" / "fixtures" / "encrypted_demo.json").read_text(encoding="utf-8"))
        self.assertEqual(fx["fromBrowser"]["iter"], 600000)
        for side in ("fromBrowser", "fromPipeline"):
            with self.subTest(encrypted_by=side):
                self.assertEqual(secure_store.decrypt_blob(fx[side], fx["passphrase"]), fx["plain"])
                with self.assertRaises(Exception):
                    secure_store.decrypt_blob(fx[side], fx["passphrase"] + " ")


class NewsTest(unittest.TestCase):
    COMPANIES = {"NABIL": {"name": "Nabil Bank Limited", "sector": "Commercial Banks"}}

    def test_classification(self):
        c = news.classify({"title": "Nabil Bank Limited proposes 10% cash dividend", "url": "u1", "source": "s", "official": True}, self.COMPANIES)
        self.assertEqual((c["category"], c["impact"], c["sentiment"], c["symbols"]), ("Dividend", "High", "Positive", ["NABIL"]))
        c = news.classify({"title": "NRB unveils monetary policy for the fiscal year", "url": "u2", "source": "s", "official": True}, self.COMPANIES)
        self.assertEqual(c["impact"], "Critical")
        c = news.classify({"title": "Government spends 23% of annual budget in four months", "url": "u3", "source": "s"}, self.COMPANIES)
        self.assertNotEqual(c["impact"], "Critical")
        c = news.classify({"title": "Company may announce bonus shares, sources say", "url": "u4", "source": "s", "official": True}, self.COMPANIES)
        self.assertFalse(c["confirmed"])                         # speculation is never marked confirmed

    def test_dedupe(self):
        a = news.classify({"title": "Nabil Bank proposes 10% cash dividend for FY 2082/83", "url": "a", "source": "x"}, self.COMPANIES)
        b = news.classify({"title": "Nabil Bank proposes 10% cash dividend for FY 2082/83 ", "url": "b", "source": "y"}, self.COMPANIES)
        self.assertEqual(len(news.dedupe([a, b, dict(a)])), 1)


DEMO_TEXT = (ROOT / "data" / "templates" / "demo_portfolio.json").read_text(encoding="utf-8")
PIPELINE_ENV = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_TO",
                "PORTFOLIO_PASSPHRASE", "PORTFOLIO_JSON", "ANTHROPIC_API_KEY", "GITHUB_ACTIONS", "DRY_RUN")
FAKE_TOKEN = "1234567890:TEST-ONLY-not-a-real-bot-token-000000"
# strings that exist only in portfolio-derived output: holdings, cost basis, P&L wording
PRIVATE_MARKERS = ("NABIL", "UPPER", "484.68", "Average Cost", "Unrealized", "Stop-loss")


def clean_env(**overrides):
    """os.environ with every pipeline secret/flag removed, then `overrides` applied (restored afterwards)."""
    env = {k: v for k, v in os.environ.items() if k not in PIPELINE_ENV}
    env.update(overrides)
    return mock.patch.dict(os.environ, env, clear=True)


def write_market(d: Path, state: str = "fresh") -> None:
    """Minimal DEMO data directory: NABIL has fallen through the DEMO stop-loss of 480."""
    collect.write_json(d / "prices.json", {"marketDate": "2026-11-17", "asOf": "2026-11-17T15:00:00", "rows": [
        {"symbol": "NABIL", "ltp": 470.0, "prevClose": 500.0, "pctChange": -6.0},
        {"symbol": "UPPER", "ltp": 210.0, "prevClose": 209.0, "pctChange": 0.5}]})
    collect.write_json(d / "analysis.json", {"stocks": {}, "top10": []})
    collect.write_json(d / "status.json", {"freshness": {"state": state, "message": "Prices are 3 trading sessions old."}})
    collect.write_json(d / "news.json", {"items": [], "newIds": []})


class AlertTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def found(self, state="fresh"):
        write_market(self.d, state)
        return alerts.generate(alerts.build_context(json.loads(DEMO_TEXT), self.d))

    def state(self):
        return collect.read_json(self.d / "state" / "alerts.json", None)

    def test_stop_loss_alert_and_cooldown(self):
        found = self.found()
        stop = [a for a in found if a["kind"] == "stop"]
        self.assertEqual(len(stop), 1)                            # NABIL 470 <= stop 480
        self.assertIn("Stock: NABIL", stop[0]["text"])
        self.assertIn("Your Average Cost", stop[0]["text"])
        self.assertEqual(found[0]["kind"], "stop")                # most urgent first
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN):
            sent, failed = alerts.filter_new(found, self.d, private=True)
            self.assertGreaterEqual(len(sent), 1)
            self.assertEqual(failed, [])
            self.assertEqual(alerts.filter_new(found, self.d, private=True), ([], []))   # cooldown suppresses repeats
        raw = (self.d / "state" / "alerts.json").read_text()
        for marker in ("NABIL", "UPPER", "stop", "480"):
            self.assertNotIn(marker, raw)                         # the public sent-state does not leak holdings

    def test_failed_delivery_is_retried_not_lost(self):
        found = self.found()
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN):
            sent, failed = alerts.filter_new(found, self.d, private=True, deliver=lambda a: False)
            self.assertEqual(sent, [])
            self.assertGreaterEqual(len(failed), 1)
            self.assertEqual(self.state()["sent"], {})            # nothing recorded as sent
            sent, failed = alerts.filter_new(found, self.d, private=True, deliver=lambda a: True)
            self.assertGreaterEqual(len(sent), 1)                 # so the next run sends it

    def test_per_run_cap_counts_attempts(self):
        found = self.found() * 10
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN):
            sent, failed = alerts.filter_new(found, self.d, private=True, deliver=lambda a: False)
        self.assertEqual(len(sent) + len(failed), alerts.CFG["maxAlertsPerRun"])

    def test_private_state_is_not_written_without_a_secret(self):
        found = self.found()
        with clean_env():
            sent, _ = alerts.filter_new(found, self.d, private=True)
        self.assertGreaterEqual(len(sent), 1)
        self.assertIsNone(self.state())                           # nothing safe to key the digests with

    def test_passphrase_is_stretched_before_keying_public_digests(self):
        import hashlib
        import hmac
        found = self.found()
        with clean_env(PORTFOLIO_PASSPHRASE="correct horse battery staple"):
            alerts.filter_new(found, self.d, private=True)
        state = self.state()
        self.assertGreaterEqual(alerts.KDF_ROUNDS, 100_000)
        self.assertEqual(len(bytes.fromhex(state["salt"])), 16)   # random per-repository salt
        fast = hmac.new(b"correct horse battery staple", found[0]["key"].encode(), hashlib.sha256).hexdigest()[:24]
        self.assertNotIn(fast, state["sent"])                     # a plain HMAC would be a cheap guessing oracle

    def test_stale_data_pauses_price_alerts(self):
        found = self.found("stale")
        self.assertEqual(len(found), 1)
        self.assertIn("DATA WARNING", found[0]["text"])

    def test_market_only_mode_without_portfolio(self):
        write_market(self.d)
        ctx = alerts.build_context(None, self.d)
        self.assertEqual([a for a in alerts.generate(ctx) if a["kind"] == "stop"], [])


class PublicLogTest(unittest.TestCase):
    """GitHub Actions logs of a public repository are world-readable: no portfolio content may reach them."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        write_market(self.d)
        run_pipeline.ERRORS.clear()
        run_pipeline.NOTED.clear()

    def tearDown(self):
        self.tmp.cleanup()
        run_pipeline.ERRORS.clear()
        run_pipeline.NOTED.clear()

    GMAIL = {"SMTP_USER": "someone@gmail.com", "SMTP_PASSWORD": "abcdefghijklmnop"}

    def test_run_page_says_whether_the_portfolio_was_loaded_and_what_was_delivered(self):
        with clean_env(GITHUB_ACTIONS="true", PORTFOLIO_JSON=DEMO_TEXT, **self.GMAIL), \
                mock.patch.object(telegram.smtplib, "SMTP_SSL") as smtp:
            out = self.captured(lambda: (run_pipeline.do_alerts(self.d, False), run_pipeline.do_report("daily", self.d, False)))
        self.assertEqual(out.count("::notice title=Your portfolio was loaded::"), 1)       # once per run, not per stage
        self.assertRegex(out, r"::notice title=Alerts::\d+ delivered")
        self.assertIn("::notice title=The daily report was delivered::It includes your holdings.", out)
        self.assertGreaterEqual(smtp.call_count, 2)                                         # alerts and the report were emailed
        for marker in PRIVATE_MARKERS + ("someone@gmail.com", "abcdefghijklmnop"):
            self.assertNotIn(marker, out)
        self.assertEqual(run_pipeline.ERRORS, [])

    def test_run_page_explains_a_portfolio_that_could_not_be_decrypted(self):
        try:
            import cryptography  # noqa: F401
        except ImportError:
            self.skipTest("cryptography not installed")
        path = self.d / "portfolio.enc.json"
        path.write_text(json.dumps(secure_store.encrypt_blob(json.loads(DEMO_TEXT), "the right passphrase", 1000)))
        with mock.patch.object(secure_store, "ENC_PATH", path), clean_env(GITHUB_ACTIONS="true", PORTFOLIO_PASSPHRASE="a wrong one"):
            out = self.captured(lambda: run_pipeline.do_alerts(self.d, False))
        self.assertIn("::warning title=Your portfolio was NOT loaded::", out)
        self.assertIn("could not be decrypted", out)
        for marker in PRIVATE_MARKERS + ("a wrong one", "the right passphrase"):
            self.assertNotIn(marker, out)

    def test_a_readable_file_where_the_encrypted_one_belongs_fails_the_run(self):
        """A plain backup uploaded by mistake is public. It must not pass as 'wrong passphrase' or go unnoticed."""
        path = self.d / "portfolio.enc.json"
        for content in (DEMO_TEXT, "symbol,qty,price\nNABIL,315,484.68\n", "{}"):
            with self.subTest(content=content[:14]):
                path.write_text(content, encoding="utf-8")
                for env in ({}, {"PORTFOLIO_PASSPHRASE": "five random words here"}, {"PORTFOLIO_JSON": DEMO_TEXT}):
                    with mock.patch.object(secure_store, "ENC_PATH", path), clean_env(**env):
                        self.assertEqual(secure_store.load_portfolio(), (None, secure_store.NOT_ENCRYPTED))
                run_pipeline.NOTED.clear()
                run_pipeline.ERRORS.clear()
                with mock.patch.object(secure_store, "ENC_PATH", path), clean_env(GITHUB_ACTIONS="true"):
                    out = self.captured(lambda: run_pipeline.do_alerts(self.d, False))
                self.assertIn("::error title=The file in data/private is not encrypted::", out)
                self.assertEqual(run_pipeline.ERRORS, ["portfolio file"])           # the run ends red
                for marker in PRIVATE_MARKERS:
                    self.assertNotIn(marker, out)                                    # ...without repeating what is in the file
        run_pipeline.NOTED.clear()
        run_pipeline.ERRORS.clear()

    def test_no_run_page_annotations_outside_ci_or_without_a_portfolio(self):
        with clean_env(PORTFOLIO_JSON=DEMO_TEXT):                       # local run
            out = self.captured(lambda: run_pipeline.do_alerts(self.d, True))
        self.assertNotIn("::notice", out)
        run_pipeline.NOTED.clear()
        with clean_env(GITHUB_ACTIONS="true"):                          # CI, market-only: nothing to say
            out = self.captured(lambda: run_pipeline.do_alerts(self.d, False))
        self.assertNotIn("portfolio was", out)

    def captured(self, fn) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            fn()
        return buf.getvalue()

    def everything(self, dry: bool):
        run_pipeline.do_alerts(self.d, dry)
        for kind in ("premarket", "daily", "weekly", "monthly"):
            run_pipeline.do_report(kind, self.d, dry)

    def test_ci_log_never_contains_portfolio_content(self):
        for dry in (True, False):
            with self.subTest(dry_run=dry), clean_env(GITHUB_ACTIONS="true", PORTFOLIO_JSON=DEMO_TEXT):
                out = self.captured(lambda: self.everything(dry))
                for marker in PRIVATE_MARKERS:
                    self.assertNotIn(marker, out)
                self.assertIn("content hidden" if dry else "NOT delivered (notifications not configured)", out)
                self.assertIn("candidate", out)                   # counts and status are still logged
        self.assertFalse((self.d / "state").exists())             # no secret configured -> no sent-state published

    def test_local_dry_run_still_shows_everything(self):
        with clean_env(PORTFOLIO_JSON=DEMO_TEXT):
            out = self.captured(lambda: self.everything(True))
        self.assertIn("Stock: NABIL", out)
        self.assertIn("Your Average Cost", out)

    def test_market_only_content_is_not_hidden_in_ci(self):
        with clean_env(GITHUB_ACTIONS="true"):                    # no portfolio: everything is public market data
            out = self.captured(lambda: run_pipeline.do_report("daily", self.d, True))
        self.assertIn("NEPSE DAILY PORTFOLIO REPORT", out)
        self.assertNotIn("hidden", out)

    def test_error_messages_are_reduced_in_ci_for_private_stages(self):
        def boom():
            raise ValueError("holding NABIL at cost 484.68")
        with clean_env(GITHUB_ACTIONS="true"):
            out = self.captured(lambda: run_pipeline.step("alerts", boom, private=True))
        self.assertIn("ValueError", out)
        self.assertIn("FAILED", out)
        for marker in ("NABIL", "484.68"):
            self.assertNotIn(marker, out)
        with clean_env(GITHUB_ACTIONS="true"):                    # public stages keep the full traceback
            out = self.captured(lambda: run_pipeline.step("collect", boom))
        self.assertIn("484.68", out)
        self.assertEqual(run_pipeline.ERRORS, ["alerts", "collect"])

    def test_failing_channel_fails_the_run_and_keeps_the_alert(self):
        bad = {"sent": False, "reason": "Telegram API returned HTTP 401"}
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN, TELEGRAM_CHAT_ID="1", PORTFOLIO_JSON=DEMO_TEXT), \
                mock.patch.object(telegram, "send_telegram", return_value=bad):
            out = self.captured(lambda: run_pipeline.do_alerts(self.d, False))
        self.assertIn("NOT delivered (Telegram API returned HTTP 401)", out)
        self.assertIn("alert delivery", run_pipeline.ERRORS)
        self.assertEqual(collect.read_json(self.d / "state" / "alerts.json")["sent"], {})

    def test_unconfigured_telegram_is_not_an_error(self):
        with clean_env():
            self.captured(lambda: run_pipeline.do_alerts(self.d, False))
        self.assertEqual(run_pipeline.ERRORS, [])


class TelegramSetupTest(unittest.TestCase):
    """Setup must survive sloppy pasting, explain failures, and never log a token or a chat id."""

    UPDATES = [
        {"update_id": 1, "message": {"chat": {"id": 111222333, "type": "private"}, "text": "/start"}},
        {"update_id": 2, "message": {"chat": {"id": -100555666, "type": "group"}, "text": "hi"}},
        {"update_id": 3, "message": {"chat": {"id": 111222333, "type": "private"}, "text": "hello"}},
        {"update_id": 4, "my_chat_member": {"chat": {"id": 444555666, "type": "private"}}},
    ]

    def fake_api(self, updates, send=(True, {})):
        calls = []

        def call(token, method, payload, attempts=3):
            calls.append((method, payload))
            return (True, updates) if method == "getUpdates" else send
        return calls, call

    def captured(self, fn):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            code = fn()
        return code, buf.getvalue()

    def test_pasted_values_are_stripped_and_checked(self):
        with clean_env(TELEGRAM_BOT_TOKEN=f"  {FAKE_TOKEN}\n", TELEGRAM_CHAT_ID=" 123456789\r\n"):
            self.assertEqual(telegram.credentials(), (FAKE_TOKEN, "123456789"))
        self.assertIsNone(telegram.problem_with(FAKE_TOKEN, "123456789"))
        self.assertIsNone(telegram.problem_with(FAKE_TOKEN, "-1001234567890"))          # group chat
        self.assertIn("does not look like a bot token", telegram.problem_with("bot" + FAKE_TOKEN))
        bad = telegram.problem_with(FAKE_TOKEN, "my chat")
        self.assertIn("should be a number", bad)
        self.assertNotIn("my chat", bad)                           # the explanation never repeats the value

    def test_malformed_token_is_reported_without_any_network_call(self):
        with clean_env(TELEGRAM_BOT_TOKEN="not a token", TELEGRAM_CHAT_ID="123456789"), \
                mock.patch.object(telegram, "_call", side_effect=AssertionError("no network call expected")):
            res = telegram.send_telegram("hello")
        self.assertFalse(res["sent"])
        self.assertIn("does not look like a bot token", res["reason"])

    def test_error_text_never_carries_ids(self):
        text = telegram._explain(400, "Bad Request: chat 123456789 not found")
        self.assertIn("[number]", text)
        self.assertNotIn("123456789", text)
        self.assertIn("pressed Start", text)

    def test_rate_limited_message_is_not_reported_as_sent(self):
        def limited(*_a, **_k):
            raise urllib.error.HTTPError("https://example.invalid", 429, "Too Many Requests", None, io.BytesIO(
                b'{"ok":false,"description":"Too Many Requests: retry after 1","parameters":{"retry_after":1}}'))
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN, TELEGRAM_CHAT_ID="123456789"), \
                mock.patch("urllib.request.urlopen", side_effect=limited), mock.patch.object(telegram.time, "sleep"):
            res = telegram.send_telegram("hello")
        self.assertFalse(res["sent"])
        self.assertIn("HTTP 429", res["reason"])
        self.assertNotIn(FAKE_TOKEN, res["reason"])

    def test_bot_tells_each_private_chat_its_own_id(self):
        calls, call = self.fake_api(self.UPDATES)
        with clean_env(TELEGRAM_BOT_TOKEN=FAKE_TOKEN), mock.patch.object(telegram, "_call", side_effect=call):
            res = telegram.send_chat_ids()
        sends = [p for m, p in calls if m == "sendMessage"]
        self.assertEqual(res, {"replied": 2, "reason": None})
        self.assertEqual([p["chat_id"] for p in sends], [444555666, 111222333])   # newest first, private only, once each
        for p in sends:
            self.assertIn(str(p["chat_id"]), p["text"])            # each chat is told its own id, nobody else's
            self.assertIn("TELEGRAM_CHAT_ID", p["text"])

    def test_guided_setup_command(self):
        ok_api = self.fake_api(self.UPDATES)[1]
        empty_api = self.fake_api([])[1]
        refused = self.fake_api([], send=(False, telegram._explain(400, "Bad Request: chat not found")))[1]
        cases = [   # (environment, fake API, expected exit code, text that must appear)
            ({}, ok_api, 1, "TELEGRAM_BOT_TOKEN is not set"),
            ({"TELEGRAM_BOT_TOKEN": FAKE_TOKEN}, ok_api, 0, "your bot has sent you your chat ID"),
            ({"TELEGRAM_BOT_TOKEN": FAKE_TOKEN}, empty_api, 1, "press Start"),
            ({"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TELEGRAM_CHAT_ID": "111222333\n"}, ok_api, 0, "Telegram is working"),
            ({"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TELEGRAM_CHAT_ID": "111222333"}, refused, 1, "chat not found"),
        ]
        for env, api, expected, text in cases:
            for ci in ("true", ""):
                with self.subTest(env=sorted(env), ci=ci, expect=text), clean_env(GITHUB_ACTIONS=ci, **env), \
                        mock.patch.object(telegram, "_call", side_effect=api), mock.patch.object(telegram.time, "sleep"):
                    code, out = self.captured(run_pipeline.test_telegram)
                self.assertEqual(code, expected)
                self.assertIn(text, out)
                if ci:
                    self.assertRegex(out, r"(?m)^::(notice|error) title=[^:,]+::")      # shown on the run page
                for secret in (FAKE_TOKEN, "111222333", "444555666"):
                    self.assertNotIn(secret, out)                  # the log is public

    # ------------------------------------------------------------------ email as the fallback channel
    GMAIL = {"SMTP_USER": " someone@gmail.com\n", "SMTP_PASSWORD": "abcd efgh ijkl mnop\n"}

    def test_gmail_needs_only_address_and_app_password(self):
        with clean_env(**self.GMAIL):
            self.assertEqual(telegram.email_settings(), {"host": "smtp.gmail.com", "port": 465, "user": "someone@gmail.com",
                                                         "password": "abcdefghijklmnop", "to": "someone@gmail.com"})
        with clean_env(SMTP_USER="someone@example.org", SMTP_PASSWORD="pw with spaces"):
            self.assertIsNone(telegram.email_settings())                        # other providers must name their server
        with clean_env(SMTP_USER="someone@example.org", SMTP_PASSWORD="pw with spaces", SMTP_HOST="mail.example.org",
                       SMTP_PORT="587", EMAIL_TO="me@example.net"):
            cfg = telegram.email_settings()
        self.assertEqual((cfg["host"], cfg["port"], cfg["to"], cfg["password"]),
                         ("mail.example.org", 587, "me@example.net", "pw with spaces"))
        with clean_env():
            self.assertIsNone(telegram.email_settings())

    def test_email_carries_everything_when_telegram_is_not_set_up(self):
        with clean_env(**self.GMAIL), mock.patch.object(telegram.smtplib, "SMTP_SSL") as smtp:
            res = telegram.notify("routine alert", subject="S", email=False, private=True)
        server = smtp.return_value.__enter__.return_value
        server.login.assert_called_once_with("someone@gmail.com", "abcdefghijklmnop")
        self.assertEqual(server.send_message.call_count, 1)
        self.assertTrue(res["delivered"])
        self.assertIsNone(res["reason"])

    def test_with_telegram_only_urgent_items_are_also_emailed(self):
        env = {"TELEGRAM_BOT_TOKEN": FAKE_TOKEN, "TELEGRAM_CHAT_ID": "123456789", **self.GMAIL}
        with clean_env(**env), mock.patch.object(telegram, "_call", return_value=(True, {})), \
                mock.patch.object(telegram.time, "sleep"), mock.patch.object(telegram.smtplib, "SMTP_SSL") as smtp:
            telegram.notify("routine", email=False)
            self.assertEqual(smtp.call_count, 0)
            telegram.notify("urgent", email=True)
            self.assertEqual(smtp.call_count, 1)

    def test_guided_email_check(self):
        with clean_env(GITHUB_ACTIONS="true"):
            code, out = self.captured(run_pipeline.test_email)
        self.assertEqual(code, 1)
        self.assertIn("::error title=Email is not set up::", out)
        with clean_env(GITHUB_ACTIONS="true", **self.GMAIL), mock.patch.object(telegram.smtplib, "SMTP_SSL"):
            code, out = self.captured(run_pipeline.test_email)
        self.assertEqual(code, 0)
        self.assertIn("::notice title=Email is working::", out)
        with clean_env(GITHUB_ACTIONS="true", **self.GMAIL), mock.patch.object(telegram.smtplib, "SMTP_SSL") as smtp:
            smtp.return_value.__enter__.return_value.login.side_effect = telegram.smtplib.SMTPAuthenticationError(535, b"no")
            code, out = self.captured(run_pipeline.test_email)
        self.assertEqual(code, 1)
        self.assertIn("app password", out)
        for secret in ("someone@gmail.com", "abcdefghijklmnop", "abcd efgh"):
            self.assertNotIn(secret, out)                              # the log is public

    def test_email_subject_names_the_stock_and_signal(self):
        text = "NEPSE PORTFOLIO ALERT\n\nStock: NABIL\n\nCurrent Price: NPR 549.0\n\nSignal: REDUCE\n\nReason:\nTarget reached."
        self.assertEqual(run_pipeline.subject_of(text), "NEPSE PORTFOLIO ALERT - NABIL - REDUCE")
        self.assertEqual(run_pipeline.subject_of("NEPSE CRITICAL NEWS\n\nSome headline"), "NEPSE CRITICAL NEWS")

    def test_passphrase_secret_with_a_stray_line_break_still_decrypts(self):
        try:
            import cryptography  # noqa: F401
        except ImportError:
            self.skipTest("cryptography not installed")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "portfolio.enc.json"
            path.write_text(json.dumps(secure_store.encrypt_blob({"transactions": []}, "five random words here", 1000)))
            with mock.patch.object(secure_store, "ENC_PATH", path):
                with clean_env(PORTFOLIO_PASSPHRASE="five random words here\n"):
                    self.assertEqual(secure_store.load_portfolio(), ({"transactions": []}, "encrypted file"))
                with clean_env(PORTFOLIO_PASSPHRASE="something else"):
                    portfolio, why = secure_store.load_portfolio()
                    self.assertIsNone(portfolio)
                    self.assertIn("could not be decrypted", why)


def bar(day, close, volume=1000.0):
    return [day, close, close * 1.01, close * 0.99, close, volume]


class IntradayDataTest(unittest.TestCase):
    """Live feeds list only what has traded so far today, and today's bar is incomplete until the close."""

    TODAY = "2026-11-18"          # a Wednesday

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.companies = {s: {"name": f"{s} Limited", "sector": "Hydro Power"} for s in ("IDLE", "LIVE", "NEW", "GONE")}
        collect.write_json(self.d / "history" / "IDLE.json", {"rows": [bar("2026-11-16", 98.0), bar("2026-11-17", 100.0)]})
        collect.write_json(self.d / "history" / "LIVE.json", {"rows": [bar("2026-11-17", 50.0), bar("2026-11-18 11:27:03", 51.0)]})
        collect.write_json(self.d / "history" / "GONE.json", {"rows": [bar("2026-08-01", 70.0)]})       # idle far too long
        self.rows = [{"symbol": "LIVE", "name": None, "sector": None, "open": 50.0, "high": 52.0, "low": 50.0, "ltp": 52.0,
                      "prevClose": 50.0, "pctChange": 4.0, "volume": 300.0, "turnover": 15600.0, "transactions": 9,
                      "asOf": "2026-11-18T11:30:00"}]

    def tearDown(self):
        self.tmp.cleanup()

    def test_stock_without_a_trade_today_keeps_its_last_real_close(self):
        added = collect.carry_forward(self.d, self.rows, self.companies, self.TODAY)
        by = {r["symbol"]: r for r in self.rows}
        self.assertEqual(added, 1)
        self.assertEqual(sorted(by), ["IDLE", "LIVE"])                 # NEW has no history, GONE is older than the limit
        idle = by["IDLE"]
        self.assertEqual((idle["ltp"], idle["prevClose"], idle["asOf"], idle["carried"]), (100.0, 100.0, "2026-11-17", True))
        self.assertIsNone(idle["pctChange"])                           # no change is claimed for a day without a trade
        self.assertEqual(idle["volume"], 0)
        self.assertNotIn("carried", by["LIVE"])
        self.assertEqual(collect.carry_forward(self.d, [], self.companies, None), 0)

    def test_no_bar_is_invented_and_bars_are_keyed_by_plain_dates(self):
        collect.carry_forward(self.d, self.rows, self.companies, self.TODAY)
        collect.update_history(self.d, sources.Registry(), {"marketDate": self.TODAY, "rows": self.rows}, None)
        idle = collect.read_json(self.d / "history" / "IDLE.json")["rows"]
        live = collect.read_json(self.d / "history" / "LIVE.json")["rows"]
        self.assertEqual([r[0] for r in idle], ["2026-11-16", "2026-11-17"])       # untouched: it did not trade today
        self.assertEqual([r[0] for r in live], ["2026-11-17", "2026-11-18"])       # one bar per day, time of day dropped
        self.assertEqual(live[-1][4], 52.0)                                         # today's bar follows the latest price

    def test_sessions_between(self):
        self.assertEqual(cal.sessions_between("2026-11-18", "2026-11-18"), 0)
        self.assertEqual(cal.sessions_between("2026-11-17", "2026-11-18"), 1)
        self.assertEqual(cal.sessions_between("2026-11-12", "2026-11-15"), 1)      # Thu -> Sun: Fri and Sat are closed
        self.assertEqual(cal.sessions_between("2026-11-10", "2026-11-18"), 6)
        self.assertIsNone(cal.sessions_between(None, "2026-11-18"))

    def test_indicators_ignore_the_unfinished_bar_while_the_session_is_open(self):
        rows = [bar("2026-11-17", 100.0), bar(self.TODAY, 103.0, 12.0)]
        self.assertEqual(build.completed_bars(rows, self.TODAY, True), rows[:1])
        self.assertEqual(build.completed_bars(rows, self.TODAY, False), rows)          # after the close it counts
        self.assertEqual(build.completed_bars(rows[:1], self.TODAY, True), rows[:1])   # nothing traded today: keep all

    def test_analysis_during_and_after_the_session(self):
        days = [f"2026-{m:02d}-{d:02d}" for m in (9, 10, 11) for d in range(1, 29)]
        days = [x for x in days if cal.is_trading_day(datetime.fromisoformat(x).date()) and x < self.TODAY][-45:]
        hist = [bar(x, 100.0 + i * 0.5, 1000.0) for i, x in enumerate(days)]
        last_close = hist[-1][4]
        collect.write_json(self.d / "history" / "LIVE.json", {"rows": hist + [bar(self.TODAY, last_close + 1, 40.0)]})   # 4% of a day
        collect.write_json(self.d / "history" / "IDLE.json", {"rows": hist})
        collect.write_json(self.d / "history" / "NEPSE.json", {"rows": hist + [bar(self.TODAY, last_close + 1)]})
        prices = {"marketDate": self.TODAY, "asOf": f"{self.TODAY}T11:30:00", "rows": [
            {"symbol": "LIVE", "name": "Live", "sector": "Hydro Power", "ltp": last_close + 1, "prevClose": last_close, "pctChange": 0.8},
            {"symbol": "IDLE", "name": "Idle", "sector": "Hydro Power", "ltp": last_close, "prevClose": last_close,
             "pctChange": None, "asOf": days[-1], "carried": True}]}
        collect.write_json(self.d / "prices.json", prices)
        collect.write_json(self.d / "market.json", {"sectors": [], "breadth": {"advancers": 1, "decliners": 0}})
        collect.write_json(self.d / "fundamentals.json", {"symbols": {}})

        during = build.build(self.d, now=datetime.fromisoformat(f"{self.TODAY}T12:00").replace(tzinfo=cal.NPT))
        # Data contract with the dashboard: every score block of every stock has the same shape. A block without
        # its `notes` list once crashed the stock detail view (frontend/src/App.test.tsx covers the other side).
        for symbol, stock in during["stocks"].items():
            for area in ("fundamental", "technical", "valuation", "market", "risk"):
                block = stock[area]
                self.assertIn("score", block, f"{symbol}.{area}")
                self.assertIsInstance(block.get("components"), dict, f"{symbol}.{area}.components")
                self.assertIsInstance(block.get("notes"), list, f"{symbol}.{area}.notes")
            self.assertIsInstance(stock["dataGaps"], list)
            self.assertIsInstance(stock["categories"], list)
        self.assertTrue(during["sessionInProgress"])
        self.assertEqual(during["indicatorsThrough"], days[-1])
        live, idle = during["stocks"]["LIVE"], during["stocks"]["IDLE"]
        self.assertEqual(live["tech"]["lastDate"], days[-1])            # indicators stop at the last completed session
        self.assertEqual(live["tech"]["volRatio"], 1.0)                 # not dragged down by 30 minutes of volume
        self.assertEqual(live["price"], last_close + 1)                 # ...while the price is today's
        self.assertEqual((live["carried"], live["lastTraded"]), (False, self.TODAY))
        self.assertEqual((idle["carried"], idle["lastTraded"]), (True, days[-1]))
        self.assertTrue(any("No trade yet in the latest session" in g for g in idle["dataGaps"]))
        self.assertFalse(any("No trade" in g for g in live["dataGaps"]))

        after = build.build(self.d, now=datetime.fromisoformat(f"{self.TODAY}T16:00").replace(tzinfo=cal.NPT))
        self.assertFalse(after["sessionInProgress"])
        self.assertEqual(after["stocks"]["LIVE"]["tech"]["lastDate"], self.TODAY)      # the finished bar now counts
        self.assertLess(after["stocks"]["LIVE"]["tech"]["volRatio"], 0.1)


class ScheduleRobustnessTest(unittest.TestCase):
    """GitHub starts scheduled runs late and sometimes skips a slot: reports must still go out once, and only once."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        run_pipeline.ERRORS.clear()

    def tearDown(self):
        self.tmp.cleanup()
        run_pipeline.ERRORS.clear()

    def reports_for(self, when: str, delivered=True, dry=False):
        """Runs `auto` at a given Nepal time with every stage stubbed out; returns the reports it tried to send."""
        tried = []

        def fake_report(kind, out, dry_, sent=None):
            tried.append(kind)
            return delivered and not dry_
        now = datetime.fromisoformat(when).replace(tzinfo=cal.NPT)
        with mock.patch.object(cal, "now_npt", return_value=now), mock.patch.object(collect, "run"), \
                mock.patch.object(build, "build"), mock.patch.object(news, "run"), \
                mock.patch.object(run_pipeline, "do_alerts", return_value=({}, [])), \
                mock.patch.object(run_pipeline, "do_report", side_effect=fake_report), \
                contextlib.redirect_stdout(io.StringIO()):
            run_pipeline.auto(self.d, dry)
        return tried

    def test_each_report_goes_out_on_the_first_suitable_run_and_is_not_repeated(self):
        self.assertEqual(self.reports_for("2026-11-18T09:58"), ["premarket"])      # early trigger, before the open
        self.assertEqual(self.reports_for("2026-11-18T10:40"), [])                 # spare trigger: already sent
        self.assertEqual(self.reports_for("2026-11-18T12:00"), [])
        self.assertEqual(self.reports_for("2026-11-18T15:25"), [])                 # after the close but not evening yet
        self.assertEqual(self.reports_for("2026-11-18T18:20"), ["daily"])
        self.assertEqual(self.reports_for("2026-11-18T19:40"), [])                 # spare evening trigger
        self.assertEqual(collect.read_json(self.d / "state" / "reports.json"), {"premarket": "2026-11-18", "daily": "2026-11-18"})

    def test_a_late_first_run_still_sends_the_morning_brief(self):
        self.assertEqual(self.reports_for("2026-11-18T11:26"), ["premarket"])      # what actually happened on day one
        self.assertEqual(self.reports_for("2026-11-18T11:56"), [])
        self.assertEqual(self.reports_for("2026-11-19T14:10"), [])                 # too late in the day to call it a morning brief

    def test_the_morning_brief_does_not_claim_to_be_pre_market(self):
        # on day one it arrived at 11:55, almost an hour after the open, headed "PRE-MARKET BRIEF"
        ctx = {"status": {}, "prices": {"marketDate": "2026-11-18"}, "analysis": {}, "portfolio": None, "news": {}}
        text = report.build("premarket", ctx, self.d)
        self.assertEqual(text.splitlines()[0], "NEPSE MORNING BRIEF")
        self.assertNotIn("PRE-MARKET", text.upper())
        self.assertEqual(run_pipeline.subject_of(text), "NEPSE MORNING BRIEF")     # the email subject follows the heading

    def test_an_undelivered_or_dry_run_report_is_tried_again(self):
        self.assertEqual(self.reports_for("2026-11-18T18:05", delivered=False), ["daily"])
        self.assertEqual(self.reports_for("2026-11-18T18:10", dry=True), ["daily"])
        self.assertEqual(self.reports_for("2026-11-18T19:40"), ["daily"])
        self.assertEqual(self.reports_for("2026-11-18T19:50"), [])

    def test_weekly_and_monthly_and_closed_days(self):
        self.assertEqual(self.reports_for("2026-11-20T18:20"), ["weekly"])         # Friday evening: no daily report
        self.assertEqual(self.reports_for("2026-11-20T19:40"), [])
        self.assertEqual(self.reports_for("2026-11-21T18:20"), [])                 # Saturday
        self.assertEqual(self.reports_for("2026-12-01T18:20"), ["daily", "monthly"])   # Tuesday the 1st
        self.assertEqual(self.reports_for("2026-11-22T11:10"), ["premarket"])      # Sunday is a trading day


if __name__ == "__main__":
    unittest.main()
