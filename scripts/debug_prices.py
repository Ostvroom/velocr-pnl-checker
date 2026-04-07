
import asyncio
from velocr_pnl.core import _pipeline

async def debug():
    wallet = "0xb4d64772218d36f97974e8bb6ef0d01b026c9a14"
    pnl, trades = await _pipeline(wallet, "eth", max_sale_pages=1, moralis_days=30)
    
    t_list = trades.get("normalized_trades", [])
    print(f"Total trades: {len(t_list)}")
    for i, t in enumerate(t_list[:10]):
        print(f"[{i}] {t['token_name']} ({t['side']}): {t['price_eth']} ETH (hash={t['transaction_hash'][:10]}...)")

if __name__ == "__main__":
    asyncio.run(debug())
