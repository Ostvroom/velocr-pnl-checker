"""Check log_index mismatch between transfers and sales tables."""
import sqlite3

DB = "data/indexer.db"
WALLET = "0xb4d64772218d36f97974e8bb6ef0d01b026c9a14"

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Check how sales join by tx_hash ONLY (ignoring log_index)
rows = conn.execute("""
    SELECT 
        t.tx_hash, t.log_index as t_log, t.event_type,
        s.log_index as s_log, s.price_native, s.buyer_total_native
    FROM transfers t
    LEFT JOIN sales s ON t.chain=s.chain AND t.tx_hash=s.tx_hash
    WHERE t.wallet_address=? AND s.price_native IS NOT NULL
    LIMIT 10
""", (WALLET,)).fetchall()

print("Joins by tx_hash only (ignoring log_index):")
for r in rows:
    d = dict(r)
    print(f"  t.log={d['t_log']}  s.log={d['s_log']}  "
          f"price={d['price_native']}  buyer_total={d['buyer_total_native']}")

# Original join with log_index
rows2 = conn.execute("""
    SELECT 
        t.tx_hash, t.log_index as t_log, t.event_type,
        s.log_index as s_log, s.price_native
    FROM transfers t
    LEFT JOIN sales s ON t.chain=s.chain AND t.tx_hash=s.tx_hash AND t.log_index=s.log_index
    WHERE t.wallet_address=? AND s.price_native IS NOT NULL
    LIMIT 10
""", (WALLET,)).fetchall()

print(f"\nJoins with log_index (matches found): {len(rows2)}")

conn.close()
