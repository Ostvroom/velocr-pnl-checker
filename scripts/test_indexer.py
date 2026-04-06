import asyncio
import os
import sys
import json
from dotenv import load_dotenv

# Add parent dir to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from velocr_pnl.indexer import sync_wallet
from velocr_pnl.core import get_wallet_pnl
from velocr_pnl.database import get_db_connection

load_dotenv()

async def test_indexer(wallet: str, chain: str = "eth"):
    print(f"--- Testing Indexer for {wallet} on {chain} ---")
    
    # 1. Sync
    print("Step 1: Syncing wallet...")
    res = await sync_wallet(wallet, chain, max_pages=2)
    print(f"Sync result: {res}")
    
    # 2. Check DB
    print("\nStep 2: Checking database counts...")
    conn = get_db_connection()
    try:
        t_count = conn.execute("SELECT COUNT(*) FROM transfers WHERE wallet_address = ?", (wallet.lower(),)).fetchone()[0]
        s_count = conn.execute("SELECT COUNT(*) FROM sales WHERE buyer = ? OR seller = ?", (wallet.lower(), wallet.lower())).fetchone()[0]
        print(f"Transfers in DB: {t_count}")
        print(f"Sales in DB: {s_count}")
    finally:
        conn.close()
        
    # 3. Get PnL
    print("\nStep 3: Calculating PnL via indexed pipeline...")
    pnl = await get_wallet_pnl(wallet, chain)
    if "error" in pnl:
        print(f"PnL Error: {pnl['error']}")
    else:
        print(f"Wallet: {pnl['wallet']}")
        print(f"Buy Vol: {pnl['est_buy_volume']:.4f} {pnl['symbol']}")
        print(f"Sell Vol: {pnl['est_sell_volume']:.4f} {pnl['symbol']}")
        print(f"Net PnL (CashFlow): {pnl['net_trades']:.4f} {pnl['symbol']}")
        print(f"Realized PnL (Matched): {pnl.get('realized_pnl_native', 0):.4f} {pnl['symbol']}")
        print(f"Indexed Events: {pnl['trades_rows']}")
        print(f"Scope: {pnl['scope_note']}")

if __name__ == "__main__":
    test_wallet = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D" # BAYC deployer/whale
    if len(sys.argv) > 1:
        test_wallet = sys.argv[1]
    
    asyncio.run(test_indexer(test_wallet))
