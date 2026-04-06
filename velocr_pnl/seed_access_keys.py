"""
Generate N clearance keys and store hashes in SQLite (data/access.db).

Usage:
  python -m velocr_pnl.seed_access_keys
  python -m velocr_pnl.seed_access_keys --count 100 --append
  python -m velocr_pnl.seed_access_keys --out data/clearance_keys.txt
"""
from __future__ import annotations

import argparse
import secrets
import sys

from velocr_pnl.gate_auth import DB_PATH, init_db, insert_keys, key_count


def _make_key() -> str:
    # Human-ish blocks, high entropy (~192 bits in hex portion)
    a = secrets.token_hex(4).upper()
    b = secrets.token_hex(4).upper()
    c = secrets.token_hex(8).upper()
    return f"VLCR-{a}-{b}-{c}"


def main() -> int:
    p = argparse.ArgumentParser(description="Seed access gate keys into SQLite.")
    p.add_argument("--count", type=int, default=100, help="Number of keys to create.")
    p.add_argument(
        "--append",
        action="store_true",
        help="Add keys even if keys already exist (default: refuse if DB non-empty).",
    )
    p.add_argument(
        "--out",
        type=str,
        default="",
        help="Optional file path to write plaintext keys (keep secret; gitignored pattern recommended).",
    )
    args = p.parse_args()
    if args.count < 1 or args.count > 10_000:
        print("--count must be between 1 and 10000", file=sys.stderr)
        return 2

    init_db()
    existing = key_count()
    if existing > 0 and not args.append:
        print(
            f"Database already has {existing} key(s) at {DB_PATH}.\n"
            "Use --append to add more, or delete the DB file to start over.",
            file=sys.stderr,
        )
        return 1

    keys = [_make_key() for _ in range(args.count)]
    n = insert_keys(keys)
    print(f"Inserted {n} new key(s) into {DB_PATH} (requested {args.count}).")

    lines = "\n".join(keys) + "\n"
    if args.out:
        path = args.out
        with open(path, "w", encoding="utf-8") as f:
            f.write("# CLASSIFIED — distribute once; delete file after sharing.\n")
            f.write(lines)
        print(f"Plaintext keys written to {path} (protect this file).")
    else:
        print("\n--- PLAINTEXT KEYS (save securely; not stored in DB) ---\n")
        print(lines, end="")
        print("--- END KEYS ---")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
