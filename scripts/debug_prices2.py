"""Check why trades show 0 ETH - inspect the DB price columns for a specific wallet."""
import sys
import sqlite3

DB = "data/indexer.db"
WALLET = "0xb4d64772218d36f97974e8bb6ef0d01b026c9a14"

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# 1. How many sales records exist for this wallet?
sales_count = conn.execute(
    "SELECT COUNT(*) FROM sales s "
    "JOIN transfers t ON s.chain=t.chain AND s.tx_hash=t.tx_hash AND s.log_index=t.log_index "
    "WHERE t.wallet_address=?", (WALLET,)
).fetchone()[0]
print(f"Sales with transfer match: {sales_count}")

# 2. Sample 5 transfers with their price columns
rows = conn.execute("""
    SELECT t.tx_hash, t.event_type, t.contract_address, t.token_id,
           s.price_native, s.buyer_total_native, s.seller_receipt_native,
           t.inferred_price_native
    FROM transfers t
    LEFT JOIN sales s ON t.chain=s.chain AND t.tx_hash=s.tx_hash AND t.log_index=s.log_index
    WHERE t.wallet_address=?
    LIMIT 10
""", (WALLET,)).fetchall()

print(f"\nSample rows (total={len(rows)}):")
for r in rows:
    d = dict(r)
    print(f"  tx={d['tx_hash'][:12]}  event={d['event_type']}  "
          f"price_native={d['price_native']}  buyer_total={d['buyer_total_native']}  "
          f"seller={d['seller_receipt_native']}  inferred={d['inferred_price_native']}")

# 3. How many non-zero prices?
non_zero = conn.execute(
    "SELECT COUNT(*) FROM transfers WHERE wallet_address=? AND inferred_price_native > 0",
    (WALLET,)
).fetchone()[0]
print(f"\nTransfers with non-zero inferred_price: {non_zero}")

conn.close()
