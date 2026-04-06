import sqlite3
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "indexer.db"

def get_db_connection():
    """Get a connection to the SQLite database with WAL enabled."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db():
    """Initialize the indexer database schema."""
    conn = get_db_connection()
    try:
        # 1. Collections: Metadata and cached floors
        conn.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                chain TEXT NOT NULL,
                contract_address TEXT NOT NULL,
                name TEXT,
                symbol TEXT,
                image_url TEXT,
                floor_price_native REAL,
                floor_updated_at INTEGER,
                PRIMARY KEY (chain, contract_address)
            )
        """)

        # 2. Transfers: Record of all NFT moves (mints, buys, sells, transfers)
        # We index by wallet_address to quickly find a user's history
        conn.execute("""
            CREATE TABLE IF NOT EXISTS transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chain TEXT NOT NULL,
                wallet_address TEXT NOT NULL,
                contract_address TEXT NOT NULL,
                token_id TEXT NOT NULL,
                from_address TEXT NOT NULL,
                to_address TEXT NOT NULL,
                amount INTEGER NOT NULL DEFAULT 1,
                block_number INTEGER NOT NULL,
                tx_hash TEXT NOT NULL,
                log_index INTEGER NOT NULL,
                timestamp_unix INTEGER,
                event_type TEXT, -- 'mint', 'transfer', 'sale'
                UNIQUE(chain, tx_hash, log_index, wallet_address, from_address, to_address, token_id)
            )
        """)

        # 3. Sales: Sub-records for transfers that included a price
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sales (
                chain TEXT NOT NULL,
                tx_hash TEXT NOT NULL,
                log_index INTEGER NOT NULL, -- matches the transfer record
                price_native REAL NOT NULL,
                payment_token TEXT, -- 'ETH', 'WETH', etc.
                marketplace TEXT,
                buyer TEXT,
                seller TEXT,
                PRIMARY KEY (chain, tx_hash, log_index)
            )
        """)

        # 4. Sync State: Tracking when we last indexed a wallet/chain
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_state (
                chain TEXT NOT NULL,
                wallet_address TEXT NOT NULL,
                last_block INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER NOT NULL,
                PRIMARY KEY (chain, wallet_address)
            )
        """)

        # Useful indexes for PnL calculation
        conn.execute("CREATE INDEX IF NOT EXISTS idx_transfers_wallet ON transfers(wallet_address, chain);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_transfers_contract ON transfers(contract_address, chain);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sales_hash ON sales(tx_hash, chain);")

        _migrate_sales_columns(conn)
        _migrate_transfers_columns(conn)

        conn.commit()
    finally:
        conn.close()


def _migrate_sales_columns(conn: sqlite3.Connection) -> None:
    """Add buyer/seller split columns for correct PnL (Alchemy fee model)."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sales)").fetchall()}
    if "buyer_total_native" not in cols:
        conn.execute("ALTER TABLE sales ADD COLUMN buyer_total_native REAL")
    if "seller_receipt_native" not in cols:
        conn.execute("ALTER TABLE sales ADD COLUMN seller_receipt_native REAL")


def _migrate_transfers_columns(conn: sqlite3.Connection) -> None:
    """Add inferred_price_native for ETH/WETH payment data when getNFTSales has no record."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(transfers)").fetchall()}
    if "inferred_price_native" not in cols:
        conn.execute("ALTER TABLE transfers ADD COLUMN inferred_price_native REAL")

if __name__ == "__main__":
    print(f"Initializing indexer database at {DB_PATH}...")
    init_db()
    print("Done.")
