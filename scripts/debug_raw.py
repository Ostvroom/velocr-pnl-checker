"""
Raw Alchemy API probe — prints actual HTTP status + first 2000 chars of body.
Run: python scripts/debug_raw.py <wallet>
"""
import asyncio, os, sys, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env", encoding="utf-8-sig")

import aiohttp
from velocr_pnl.indexer import _api_key, _nft_base, _rpc_url, ALCHEMY_CHAIN

async def main(wallet: str, chain: str = "eth"):
    key = _api_key()
    if not key:
        print("ERROR: ALCHEMY_API_KEY not set"); return

    wallet = wallet.lower()
    nft_base = _nft_base(chain, key)
    rpc = _rpc_url(chain, key)

    async with aiohttp.ClientSession() as sess:
        # ── 1. eth_blockNumber ────────────────────────────────────────────────
        async with sess.post(rpc, json={"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}) as r:
            body = await r.text()
            print(f"\n[eth_blockNumber] status={r.status}")
            print(body[:500])

        # ── 2. getNFTSales (no fromBlock filter, buyer role) ─────────────────
        url = f"{nft_base}/getNFTSales"
        params = {"buyerAddress": wallet, "limit": "10"}
        async with sess.get(url, params=params) as r:
            body = await r.text()
            print(f"\n[getNFTSales buyer, no filter] status={r.status}")
            print(body[:2000])

        # ── 3. getNFTSales seller role ────────────────────────────────────────
        params2 = {"sellerAddress": wallet, "limit": "10"}
        async with sess.get(url, params=params2) as r:
            body = await r.text()
            print(f"\n[getNFTSales seller, no filter] status={r.status}")
            print(body[:2000])

        # ── 4. alchemy_getAssetTransfers (no fromBlock, toAddress) ───────────
        payload = {
            "jsonrpc": "2.0", "id": 1,
            "method": "alchemy_getAssetTransfers",
            "params": [{
                "toAddress": wallet,
                "category": ["erc721", "erc1155"],
                "withMetadata": True,
                "excludeZeroValue": False,
                "maxCount": "0xa",
            }]
        }
        async with sess.post(rpc, json=payload) as r:
            body = await r.text()
            print(f"\n[getAssetTransfers toAddress, no filter] status={r.status}")
            print(body[:2000])

        # ── 5. alchemy_getAssetTransfers fromAddress ──────────────────────────
        payload2 = {
            "jsonrpc": "2.0", "id": 1,
            "method": "alchemy_getAssetTransfers",
            "params": [{
                "fromAddress": wallet,
                "category": ["erc721", "erc1155"],
                "withMetadata": True,
                "excludeZeroValue": False,
                "maxCount": "0xa",
            }]
        }
        async with sess.post(rpc, json=payload2) as r:
            body = await r.text()
            print(f"\n[getAssetTransfers fromAddress, no filter] status={r.status}")
            print(body[:2000])

if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "0xdBd47F66aA2F00B3dB03397F260ce9728298c495"
    c = sys.argv[2] if len(sys.argv) > 2 else "eth"
    asyncio.run(main(w, c))
