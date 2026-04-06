"""
Debug script: test Alchemy sync for a wallet and print what comes back.
Run: python scripts/debug_sync.py <wallet> [days]
"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env", encoding="utf-8-sig")
load_dotenv(encoding="utf-8-sig")

import aiohttp
from velocr_pnl.database import get_db_connection, init_db
from velocr_pnl import indexer


async def main(wallet: str, chain: str = "eth", days: int = 90) -> None:
    key = indexer._api_key()
    if not key:
        print("ERROR: ALCHEMY_API_KEY not set in .env")
        return

    print(f"\nWallet : {wallet}")
    print(f"Chain  : {chain}")
    print(f"Days   : {days}")
    print(f"API key: ...{key[-6:]}\n")

    init_db()

    # --- 1. fromBlock estimate ---
    async with aiohttp.ClientSession() as session:
        fb = await indexer._resolve_from_block_decimal(session, chain, key, days)
        print(f"fromBlock (approx for last {days}d): {fb}\n")

        # --- 2. Sales ---
        print("Fetching sales from Alchemy getNFTSales ...")
        sales_data, _ = await indexer._fetch_sales(session, chain, wallet.lower(), key, max_pages=4, from_block=fb)
        print(f"  Raw sales fetched (deduped): {len(sales_data)}")
        for s in sales_data[:5]:
            buyer_total, seller_receipt, sym = indexer._sale_amounts(s)
            role = "BUYER" if s.get("buyerAddress", "").lower() == wallet.lower() else "SELLER"
            print(f"  [{role}] tx={s.get('transactionHash','?')[:12]}... "
                  f"buyer_total={buyer_total:.4f} {sym}  seller_recv={seller_receipt:.4f} {sym}  "
                  f"marketplace={s.get('marketplace','?')}")

        # --- 3. Transfers ---
        print("\nFetching transfers from Alchemy alchemy_getAssetTransfers ...")
        transfers_data = await indexer._fetch_asset_transfers(session, chain, wallet.lower(), key, max_pages=4, from_block=fb)
        print(f"  Raw transfers fetched: {len(transfers_data)}")
        for t in transfers_data[:5]:
            direction = "IN " if (t.get("to") or "").lower() == wallet.lower() else "OUT"
            li = indexer._transfer_log_index(t)
            print(f"  [{direction}] tx={t.get('hash','?')[:12]}... logIdx={li}  "
                  f"from={t.get('from','?')[:10]}  to={t.get('to','?')[:10]}")

    # --- 4. DB state ---
    print("\nRunning full sync into DB ...")
    result = await indexer.sync_wallet(wallet.lower(), chain, max_pages=4, days_window=days)
    print(f"  Sync result: {result}")

    conn = get_db_connection()
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM transfers WHERE wallet_address=? AND chain=?",
        (wallet.lower(), chain)
    ).fetchone()
    print(f"  transfers rows in DB for this wallet: {row['n']}")
    row2 = conn.execute(
        "SELECT COUNT(*) AS n FROM sales WHERE chain=?", (chain,)
    ).fetchone()
    print(f"  sales rows in DB (all wallets, chain={chain}): {row2['n']}")

    # Show a few joined rows
    rows = conn.execute("""
        SELECT t.tx_hash, t.event_type, t.from_address, t.to_address,
               s.buyer_total_native, s.seller_receipt_native, s.payment_token, s.marketplace
        FROM transfers t
        LEFT JOIN sales s ON t.chain=s.chain AND t.tx_hash=s.tx_hash AND t.log_index=s.log_index
        WHERE t.wallet_address=? AND t.chain=?
        LIMIT 10
    """, (wallet.lower(), chain)).fetchall()
    print(f"\n  First {len(rows)} joined rows:")
    for r in rows:
        bt = r["buyer_total_native"]
        sr = r["seller_receipt_native"]
        print(f"    {r['tx_hash'][:14]}... event={r['event_type']}  "
              f"buyer_total={bt}  seller_recv={sr}  mkt={r['marketplace']}")
    conn.close()


if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "0xdBd47F66aA2F00B3dB03397F260ce9728298c495"
    c = sys.argv[2] if len(sys.argv) > 2 else "eth"
    d = int(sys.argv[3]) if len(sys.argv) > 3 else 90
    asyncio.run(main(w, c, d))
