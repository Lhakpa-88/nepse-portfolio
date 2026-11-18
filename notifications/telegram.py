"""Notification channels: Telegram Bot and email (SMTP).

Credentials come ONLY from environment variables (GitHub Actions secrets):
  Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  Email:    SMTP_USER, SMTP_PASSWORD   (+ SMTP_HOST, SMTP_PORT, EMAIL_TO when not using Gmail defaults)

Routing (see notify): Telegram receives everything when it is set up, and email then receives only the urgent
items. When Telegram is NOT set up, email is the main channel and receives everything. With no channel
configured the message is printed instead, so the pipeline stays testable.

Nothing in this module ever logs a token, password, address, chat id or a request URL (it contains the token):
the CI log of a public repository can be read by anyone.
"""
from __future__ import annotations

import json
import os
import re
import smtplib
import ssl
import time
import urllib.error
import urllib.request
from email.message import EmailMessage

from backend.secure_store import logs_are_public

MAX_LEN = 3900  # Telegram hard limit is 4096 characters
TOKEN_SHAPE = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")
CHAT_SHAPE = re.compile(r"^(-?\d{3,}|@[A-Za-z0-9_]{4,})$")
HINTS = {
    400: "check TELEGRAM_CHAT_ID, and that you pressed Start in the bot chat",
    401: "the bot token was rejected - copy it again from @BotFather",
    403: "the bot is not allowed to message you yet - open it in Telegram and press Start",
    409: "another program is already reading this bot's messages",
}
SETUP_TEXT = """NEPSE Portfolio Intelligence - setup

Your Telegram chat ID is:
{cid}

Add it to your GitHub repository as a secret:
  Name:   TELEGRAM_CHAT_ID
  Secret: {cid}

Then run the workflow again with the command test-telegram."""
GMAIL_DOMAINS = ("gmail.com", "googlemail.com")


# --------------------------------------------------------------------------- Telegram
def credentials() -> tuple[str, str]:
    """(bot token, chat id) with surrounding whitespace removed.

    A value pasted into GitHub Secrets often carries a stray space or line break, which would otherwise make
    every request fail with an error that says nothing useful.
    """
    return os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()


def problem_with(token: str, chat: str | None = None) -> str | None:
    """Explains an obviously malformed value before any network call. Never echoes the value itself."""
    if not TOKEN_SHAPE.match(token):
        return ("TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then about 35 letters, "
                "digits, '-' or '_') - copy it again from @BotFather")
    if chat is not None and not CHAT_SHAPE.match(chat):
        return "TELEGRAM_CHAT_ID should be a number such as 123456789 (a group id starts with a minus sign)"
    return None


def _explain(code: int, description: str) -> str:
    description = re.sub(r"\d{5,}", "[number]", description or "")[:120]      # belt and braces: no ids in logs
    text = f"Telegram API returned HTTP {code}"
    if description:
        text += f" ({description})"
    if code in HINTS:
        text += f": {HINTS[code]}"
    return text


def _call(token: str, method: str, payload: dict, attempts: int = 3) -> tuple[bool, object]:
    """POSTs to the Bot API. Returns (True, result) or (False, reason); the reason never contains a secret."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    body = json.dumps(payload).encode("utf-8")
    reason = "network error"
    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
            if data.get("ok"):
                return True, data.get("result")
            reason = "Telegram API reported a failure"
        except urllib.error.HTTPError as e:
            try:
                info = json.loads(e.read())
            except Exception:  # noqa: BLE001 - an error body that is not JSON
                info = {}
            reason = _explain(e.code, info.get("description", ""))
            if e.code == 429 and not last:              # rate limited: honour retry_after
                time.sleep(min(int(info.get("parameters", {}).get("retry_after", 3)) + 1, 30))
                continue
            if e.code < 500:
                return False, reason                     # a client error will not improve by retrying
        except Exception as e:  # noqa: BLE001 - never str(e): it can contain the URL and therefore the token
            reason = f"could not reach Telegram ({type(e).__name__})"
        if not last:
            time.sleep(2 ** attempt)
    return False, reason


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


def send_telegram(text: str) -> dict:
    token, chat = credentials()
    if not token or not chat:
        return {"sent": False, "reason": "Telegram not configured"}
    bad = problem_with(token, chat)
    if bad:
        return {"sent": False, "reason": bad}
    for part in _chunks(text):
        ok, res = _call(token, "sendMessage", {"chat_id": chat, "text": part, "disable_web_page_preview": True})
        if not ok:
            return {"sent": False, "reason": str(res)}
        time.sleep(0.4)
    return {"sent": True}


def send_chat_ids(limit: int = 3) -> dict:
    """Setup helper for when only the bot token is configured.

    The bot tells each person who messaged it in the last 24 hours their own chat id, privately, inside
    Telegram. That avoids pasting the token into a browser address to look the id up. It does not connect
    anyone to anything: alerts only ever go to the chat id stored in TELEGRAM_CHAT_ID. Only a count is
    returned for logging.
    """
    token, _ = credentials()
    bad = problem_with(token)
    if bad:
        return {"replied": 0, "reason": bad}
    ok, res = _call(token, "getUpdates", {"timeout": 0})
    if not ok:
        return {"replied": 0, "reason": str(res)}
    chats: list[int] = []
    for update in reversed(res if isinstance(res, list) else []):          # newest first
        chat = (update.get("message") or update.get("my_chat_member") or {}).get("chat") or {}
        if chat.get("type") == "private" and chat.get("id") is not None and chat["id"] not in chats:
            chats.append(chat["id"])
    replied = 0
    reason = "the bot has not received any message in the last 24 hours - open it in Telegram and press Start"
    for cid in chats[:limit]:
        ok, res = _call(token, "sendMessage", {"chat_id": cid, "text": SETUP_TEXT.format(cid=cid)})
        if ok:
            replied += 1
        else:
            reason = str(res)
    return {"replied": replied, "reason": None if replied else reason}


# --------------------------------------------------------------------------- email
def email_settings() -> dict | None:
    """SMTP settings from the environment, or None when email is not set up.

    For Gmail only SMTP_USER (the address) and SMTP_PASSWORD (a 16-character app password) are needed:
    the server, port and recipient are filled in. Other providers also need SMTP_HOST.
    """
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    host = os.environ.get("SMTP_HOST", "").strip()
    to = os.environ.get("EMAIL_TO", "").strip() or user
    if not host and user.lower().rpartition("@")[2] in GMAIL_DOMAINS:
        host = "smtp.gmail.com"
    if not (host and user and password and to):
        return None
    if host == "smtp.gmail.com":
        password = password.replace(" ", "")          # Google displays app passwords in four spaced groups
    try:
        port = int(os.environ.get("SMTP_PORT", "").strip() or 465)
    except ValueError:
        port = 465
    return {"host": host, "port": port, "user": user, "password": password, "to": to}


def send_email(subject: str, text: str) -> dict:
    cfg = email_settings()
    if cfg is None:
        return {"sent": False, "reason": "email not configured"}
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, cfg["user"], cfg["to"]
    msg.set_content(text)
    try:
        tls = ssl.create_default_context()
        if cfg["port"] == 587:                           # STARTTLS providers
            with smtplib.SMTP(cfg["host"], 587, timeout=30) as s:
                s.starttls(context=tls)
                s.login(cfg["user"], cfg["password"])
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=30, context=tls) as s:
                s.login(cfg["user"], cfg["password"])
                s.send_message(msg)
        return {"sent": True}
    except smtplib.SMTPAuthenticationError:
        return {"sent": False, "reason": "the email login was rejected - for Gmail use a 16-character app password "
                                         "(not your normal password) and check SMTP_USER is the full address"}
    except Exception as e:  # noqa: BLE001 - class name only: the message can contain the address
        return {"sent": False, "reason": f"email could not be sent ({type(e).__name__})"}


# --------------------------------------------------------------------------- routing
def notify(text: str, subject: str = "NEPSE portfolio alert", email: bool = False, private: bool = False) -> dict:
    """Delivers `text` and reports what happened.

    `email`   - also email this item when Telegram is the main channel (used for the urgent ones).
    `private` - the text is built from the portfolio: it is never echoed into a public CI log.
    Returns {"telegram": {...}, "email": {...}?, "delivered": bool, "reason": str | None}.
    """
    token, chat = credentials()
    telegram_ready = bool(token and chat)
    res: dict = {"telegram": send_telegram(text)}
    if email or not telegram_ready:                      # without Telegram, email carries everything
        res["email"] = send_email(subject, text)
    delivered = any(r.get("sent") for r in res.values())
    reasons = [r["reason"] for r in res.values() if r.get("reason")]
    real = [r for r in reasons if "not configured" not in r]     # a configured channel that failed matters most
    if not delivered and not real and not (private and logs_are_public()):
        print("---- [not sent: no notification channel is configured] ----")
        print(text)
    res["delivered"] = delivered
    res["reason"] = None if delivered else ("; ".join(real) if real else "notifications not configured")
    return res
