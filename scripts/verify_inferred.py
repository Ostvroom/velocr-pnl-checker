"""Verify inferred prices are populated and estimate PnL."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env", encoding="utf-8-sig")
from velocr_pnl.database import get_db_connection

wallet = sys.argv[1] if len(sys.argv) > 1 else "0xb0cf6360b50c48280e2c18fe9d96bc7d6f5ed697"
conn = get_db_connection()

r = conn.execute(
    "SELECT COUNT(*) n FROM transfers WHERE wallet_address=? AND inferred_price_native IS NOT NULL",
    (wallet,)
).fetchone()
print(f"Transfers with inferred price: {r['n']}")

rows = conn.execute(
    """SELECT tx_hash, event_type, from_address, to_address, inferred_price_native
       FROM transfers WHERE wallet_address=? AND inferred_price_native IS NOT NULL
       ORDER BY block_number DESC LIMIT 10""",
    (wallet,)
).fetchall()
print("Sample (newest 10):")
for row in rows:
    side = "SELL" if row["from_address"].lower() == wallet.lower() else "BUY"
    print(f"  [{side}] {row['tx_hash'][:14]}... event={row['event_type']}  inferred={row['inferred_price_native']:.5f} ETH")

stats = conn.execute(
    """SELECT
        SUM(CASE WHEN to_address=? AND event_type!='mint' THEN inferred_price_native ELSE 0 END) buy_vol,
        SUM(CASE WHEN from_address=? THEN inferred_price_native ELSE 0 END) sell_vol,
        SUM(CASE WHEN event_type='mint' THEN inferred_price_native ELSE 0 END) mint_vol
       FROM transfers WHERE wallet_address=? AND inferred_price_native IS NOT NULL""",
    (wallet, wallet, wallet)
).fetchone()
print(f"\nEstimated totals:")
print(f"  Buy vol:  {stats['buy_vol'] or 0:.4f} ETH")
print(f"  Sell vol: {stats['sell_vol'] or 0:.4f} ETH")
print(f"  Mint vol: {stats['mint_vol'] or 0:.4f} ETH")
conn.close()
