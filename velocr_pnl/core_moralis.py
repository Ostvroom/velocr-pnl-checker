import asyncio
import aiohttp
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Moralis base URL
MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2"

def _api_key() -> str:
    return (os.getenv("MORALIS_API_KEY") or "").strip()

async def fetch_moralis_trades(
    session: aiohttp.ClientSession,
    wallet: str,
    chain: str = "eth",
    max_pages: int = 10,
) -> List[dict]:
    """Fetch NFT transfers from Moralis and normalize to trades."""
    trades = []
    cursor = None
    url = f"{MORALIS_BASE}/{wallet}/nft/transfers"
    
    for _ in range(max_pages):
        params = {"chain": chain, "format": "decimal", "limit": "100"}
        if cursor:
            params["cursor"] = cursor
            
        headers = {"X-API-Key": _api_key()}
        async with session.get(url, params=params, headers=headers) as r:
            if r.status != 200:
                break
            data = await r.json()
            
        result = data.get("result") or []
        for row in result:
            # Moralis doesn't explicitly label 'buy' vs 'sell' in transfers
            # We determine based on wallet address
            buyer = (row.get("to_address") or "").lower()
            seller = (row.get("from_address") or "").lower()
            wallet_lower = wallet.lower()
            
            side = None
            if buyer == wallet_lower:
                side = "buy"
            elif seller == wallet_lower:
                side = "sell"
                
            if not side:
                continue
                
            price = float(row.get("value") or 0) / 1e18 # Rough ETH estimate if not token transfer
            
            trades.append({
                "side": side,
                "price_eth": price,
                "contract_address": row.get("token_address"),
                "token_id": row.get("token_id"),
                "transaction_hash": row.get("transaction_hash"),
                "block_number": row.get("block_number"),
                "timestamp": row.get("block_timestamp"),
            })
            
        cursor = data.get("cursor")
        if not cursor or not result:
            break
            
    return trades

async def get_moralis_pnl(wallet: str, chain: str = "eth") -> Dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        trades = await fetch_moralis_trades(session, wallet, chain)
        
    buy_vol = sum(t["price_eth"] for t in trades if t["side"] == "buy")
    sell_vol = sum(t["price_eth"] for t in trades if t["side"] == "sell")
    
    return {
        "provider": "moralis",
        "wallet": wallet,
        "chain": chain,
        "buy_volume": buy_vol,
        "sell_volume": sell_vol,
        "trade_count": len(trades),
        "net_pnl": sell_vol - buy_vol,
    }
