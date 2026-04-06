import asyncio
import os
import sys
import json
from dotenv import load_dotenv

# Add parent dir to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from velocr_pnl.core import get_wallet_pnl as get_alchemy_pnl
from velocr_pnl.core_moralis import get_moralis_pnl

load_dotenv()

async def compare_wallets(wallets: list, chain: str = "eth"):
    results = []
    print(f"{'Wallet':<42} {'Provider':<10} {'Buy Vol':<12} {'Sell Vol':<12} {'Trades':<8}")
    print("-" * 88)
    
    for wallet in wallets:
        # Alchemy
        try:
            alc = await get_alchemy_pnl(wallet, chain)
            alc_buy = alc.get("est_buy_volume", 0)
            alc_sell = alc.get("est_sell_volume", 0)
            alc_trades = alc.get("transfer_rows", 0)
            print(f"{wallet:<42} {'Alchemy':<10} {alc_buy:<12.4f} {alc_sell:<12.4f} {alc_trades:<8}")
        except Exception as e:
            print(f"{wallet:<42} {'Alchemy':<10} ERROR: {e}")
            
        # Moralis
        try:
            mor = await get_moralis_pnl(wallet, chain)
            mor_buy = mor.get("buy_volume", 0)
            mor_sell = mor.get("sell_volume", 0)
            mor_trades = mor.get("trade_count", 0)
            print(f"{wallet:<42} {'Moralis':<10} {mor_buy:<12.4f} {mor_sell:<12.4f} {mor_trades:<8}")
        except Exception as e:
            print(f"{wallet:<42} {'Moralis':<10} ERROR: {e}")
            
        print("-" * 88)

if __name__ == "__main__":
    test_wallets = [
        "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", # BAYC deployer or similar
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", # vitalik.eth
    ]
    
    # If wallet passed as arg
    if len(sys.argv) > 1:
        test_wallets = [sys.argv[1]]
        
    asyncio.run(compare_wallets(test_wallets))
