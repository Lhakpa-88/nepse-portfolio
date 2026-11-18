"""Telegram Bot (primary) and optional SMTP email notification channels.

Credentials come ONLY from environment variables (GitHub Actions secrets):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  optional email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_TO
With no credentials the message is printed (dry run) so the pipeline is testable.
"""
from __future__ import annotations

import json
import os
import smtplib
import time
import urllib.error
import urllib.request
from email.message import EmailMessage

from backend.secure_store import logs_are_public

MAX_LEN = 3900  # Telegram hard limit is 4096 characters


def _chunks(text: str) -> list[str]:
    parts, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > MAX_LEN:
            parts.append(cur)
            cur = ""
        cur += line[:MAX_LEN] + "\n"
    if cur.strip():
        parts.append(cur)
    return parts


def send_telegram(text: str, private: bool = False) -> dict:
    """Sends `text`. `private` marks content built from the portfolio: it is never echoed into a public CI log."""
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", ""), os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        if not (private and logs_are_public()):      # the caller logs a one-line summary either way
            print("---- [not sent: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set] ----")
            print(text)
        return {"sent": False, "reason": "Telegram not configured"}
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for part in _chunks(text):
        body = json.dumps({"chat_id": chat, "text": part, "disable_web_page_preview": True}).encode("utf-8")
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:           # rate limited: honour retry_after
                    try:
                        wait = json.loads(e.read()).get("parameters", {}).get("retry_after", 3)
                    except ValueError:
                        wait = 3
                    time.sleep(min(int(wait) + 1, 30))
                    continue
                # never echo the URL: it contains the bot token
                return {"sent": False, "reason": f"Telegram API returned HTTP {e.code}"}
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    return {"sent": False, "reason": f"network error: {type(e).__name__}"}
                time.sleep(2 ** attempt)
        time.sleep(0.4)
    return {"sent": True}


def send_email(subject: str, text: str) -> dict:
    host, to = os.environ.get("SMTP_HOST", ""), os.environ.get("EMAIL_TO", "")
    if not host or not to:
        return {"sent": False, "reason": "not configured"}
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, os.environ.get("SMTP_USER", to), to
    msg.set_content(text)
    try:
        with smtplib.SMTP_SSL(host, int(os.environ.get("SMTP_PORT", "465")), timeout=30) as s:
            s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            s.send_message(msg)
        return {"sent": True}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "reason": type(e).__name__}


def notify(text: str, subject: str = "NEPSE portfolio alert", email: bool = False, private: bool = False) -> dict:
    res = {"telegram": send_telegram(text, private)}
    if email:
        res["email"] = send_email(subject, text)
    res["delivered"] = any(r.get("sent") for r in res.values())
    res["reason"] = None if res["delivered"] else res["telegram"].get("reason")
    return res
