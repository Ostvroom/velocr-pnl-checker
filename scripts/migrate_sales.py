"""
Migrate the sales table: add contract_address + token_id columns,
then backfill them from the existing transfers table by matching tx_hash + log_index.
"""
import sqlite3

DB = "data/indexer.db"
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Step 1: Add the new columns if they don't exist
cols = {r[1] for r in conn.execute("PRAGMA table_info(sales)").fetchall()}
if "contract_address" not in cols:
    conn.execute("ALTER TABLE sales ADD COLUMN contract_address TEXT")
    print("Added contract_address column")
if "token_id" not in cols:
    conn.execute("ALTER TABLE sales ADD COLUMN token_id TEXT")
    print("Added token_id column")

# Step 2: Add the index
conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_sales_contract_token "
    "ON sales(chain, tx_hash, contract_address, token_id);"
)

# Step 3: Backfill from transfers table by tx_hash + log_index
result = conn.execute("""
    UPDATE sales
    SET
        contract_address = (
            SELECT LOWER(t.contract_address) FROM transfers t
            WHERE t.chain = sales.chain AND t.tx_hash = sales.tx_hash AND t.log_index = sales.log_index
            LIMIT 1
        ),
        token_id = (
            SELECT t.token_id FROM transfers t
            WHERE t.chain = sales.chain AND t.tx_hash = sales.tx_hash AND t.log_index = sales.log_index
            LIMIT 1
        )
    WHERE contract_address IS NULL
""")
print(f"Backfilled {result.rowcount} sales rows with contract/token data")

# Step 4: Check how many are still NULL
null_count = conn.execute("SELECT COUNT(*) FROM sales WHERE contract_address IS NULL").fetchone()[0]
print(f"Sales with NULL contract_address remaining: {null_count}")

conn.commit()
conn.close()
print("Done!")
