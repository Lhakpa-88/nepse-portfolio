"""Loads the private portfolio for the automated pipeline WITHOUT ever storing it in plaintext in the repo.

Order of precedence:
  1. data/private/portfolio.enc.json decrypted with env PORTFOLIO_PASSPHRASE
     (file produced by the dashboard: Settings -> Encrypt & push / Download encrypted file)
  2. env PORTFOLIO_JSON (a plain backup pasted into a GitHub Actions secret) - simple alternative
Returns None when neither is configured: alerts are then market-only.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENC_PATH = ROOT / "data" / "private" / "portfolio.enc.json"


def logs_are_public() -> bool:
    """True when stdout is a GitHub Actions log.

    On a public repository anyone can read those logs, so nothing derived from the private portfolio
    (holdings, costs, P&L, targets, watchlist) may ever be printed there - not even in a dry run.
    """
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"


def loggable(text: str, private: bool) -> str:
    """What may be written to stdout for `text`: the text itself, or a placeholder when it is private and logs are public."""
    if private and logs_are_public():
        return ("[content hidden: it is built from your private portfolio and this log can be read by anyone. "
                "Run the same command on your own computer to read it.]")
    return text


def decrypt_blob(blob: dict, passphrase: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(blob["salt"]),
                     iterations=int(blob["iter"]))
    key = kdf.derive(passphrase.encode("utf-8"))
    plain = AESGCM(key).decrypt(base64.b64decode(blob["iv"]), base64.b64decode(blob["ct"]), None)
    return json.loads(plain.decode("utf-8"))


def encrypt_blob(obj: dict, passphrase: str, iterations: int = 600000) -> dict:
    """Same format as frontend/src/lib/crypto.ts (used by tests and scripts)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(passphrase.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(obj).encode("utf-8"), None)
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": iterations, "cipher": "AES-256-GCM",
            "salt": base64.b64encode(salt).decode(), "iv": base64.b64encode(iv).decode(),
            "ct": base64.b64encode(ct).decode()}


def load_portfolio() -> tuple[dict | None, str]:
    """Returns (portfolio, how) where how explains the source or why it is unavailable."""
    passphrase = os.environ.get("PORTFOLIO_PASSPHRASE", "")
    if ENC_PATH.exists() and passphrase:
        try:
            return decrypt_blob(json.loads(ENC_PATH.read_text(encoding="utf-8")), passphrase), "encrypted file"
        except ImportError:
            return None, "the 'cryptography' package is not installed (pip install cryptography)"
        except Exception:  # noqa: BLE001 - wrong passphrase / corrupt file; never print secrets
            return None, "encrypted portfolio could not be decrypted (wrong PORTFOLIO_PASSPHRASE?)"
    raw = os.environ.get("PORTFOLIO_JSON", "")
    if raw:
        try:
            return json.loads(raw), "PORTFOLIO_JSON secret"
        except ValueError:
            return None, "PORTFOLIO_JSON secret is not valid JSON"
    if ENC_PATH.exists():
        return None, "encrypted portfolio present but PORTFOLIO_PASSPHRASE secret is not set"
    return None, "no portfolio configured (market-only mode)"
