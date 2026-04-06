"""
Site access gate: SQLite-backed clearance keys + signed session cookie.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "access.db"

COOKIE_NAME = "pnl_site_gate_v1"
COOKIE_MAX_AGE_S = 30 * 24 * 3600  # 30 days


def _gate_secret() -> bytes:
    s = (os.environ.get("GATE_SECRET") or "").strip()
    if not s:
        raise RuntimeError(
            "GATE_SECRET is required when ACCESS_GATE_ENABLED=1. "
            "Set a long random string in .env (e.g. openssl rand -hex 32)."
        )
    return s.encode("utf-8")


def gate_enabled() -> bool:
    v = (os.environ.get("ACCESS_GATE_ENABLED") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def hash_key(plain: str) -> str:
    return hashlib.sha256(plain.strip().encode("utf-8")).hexdigest()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS access_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def key_count() -> int:
    if not DB_PATH.is_file():
        return 0
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute("SELECT COUNT(*) FROM access_keys").fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


def verify_key_plain(plain: str) -> int | None:
    """Return key row id if valid, else None."""
    h = hash_key(plain)
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT id FROM access_keys WHERE key_hash = ? LIMIT 1",
            (h,),
        ).fetchone()
        return int(row[0]) if row else None
    finally:
        conn.close()


def make_cookie_value(key_id: int) -> str:
    exp = int(time.time()) + COOKIE_MAX_AGE_S
    payload = {"kid": key_id, "exp": exp, "v": 1}
    body = (
        base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        .decode("ascii")
        .rstrip("=")
    )
    sig = hmac.new(_gate_secret(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_cookie_value(val: str | None) -> bool:
    if not val or "." not in val:
        return False
    try:
        body, sig = val.rsplit(".", 1)
        expected = hmac.new(
            _gate_secret(), body.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return False
        pad = "=" * (-len(body) % 4)
        data = json.loads(base64.urlsafe_b64decode(body + pad))
        if data.get("v") != 1:
            return False
        if int(data["exp"]) < time.time():
            return False
        return True
    except Exception:
        return False


def insert_keys(plaintext_keys: list[str]) -> int:
    """Insert new keys; skip duplicates. Returns number inserted."""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    inserted = 0
    try:
        for p in plaintext_keys:
            h = hash_key(p)
            try:
                conn.execute(
                    "INSERT INTO access_keys (key_hash, created_at) VALUES (?, ?)",
                    (h, now),
                )
                inserted += 1
            except sqlite3.IntegrityError:
                continue
        conn.commit()
    finally:
        conn.close()
    return inserted
