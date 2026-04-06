"""Check recent transfers and sales for a wallet."""
import asyncio, aiohttp, os, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env", encoding="utf-8-sig")
from velocr_pnl.indexer import _api_key, _rpc_url, _nft_base, _resolve_from_block_decimal, ALCHEMY_CHAIN

async def main(wallet, chain="eth", days=90):
    key = _api_key()
    rpc = _rpc_url(chain, key)
    nft_base = _nft_base(chain, key)
    chain_id = ALCHEMY_CHAIN[chain]

    async with aiohttp.ClientSession() as s:
        fb = await _resolve_from_block_decimal(s, chain, key, days)
        fb_hex = hex(int(fb))
        print(f"fromBlock hex: {fb_hex} (last {days} days)\n")

        # --- outgoing transfers (sells) ---
        payload = {"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
            "fromAddress": wallet,
            "category": ["erc721","erc1155"],
            "withMetadata": True,
            "excludeZeroValue": False,
            "maxCount": "0x14",
            "fromBlock": fb_hex
        }]}
        async with s.post(rpc, json=payload) as r:
            data = await r.json()
        transfers = (data.get("result") or {}).get("transfers", [])
        print(f"Outgoing transfers in last {days}d: {len(transfers)}")
        for t in transfers[:8]:
            ts = (t.get("metadata") or {}).get("blockTimestamp", "?")
            print(f"  {ts[:10]}  tx={t.get('hash','')[:14]}...  contract={t.get('rawContract',{}).get('address','?')[:14]}...")

        # --- incoming transfers (buys) ---
        payload2 = {"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
            "toAddress": wallet,
            "category": ["erc721","erc1155"],
            "withMetadata": True,
            "excludeZeroValue": False,
            "maxCount": "0x14",
            "fromBlock": fb_hex
        }]}
        async with s.post(rpc, json=payload2) as r:
            data2 = await r.json()
        transfers2 = (data2.get("result") or {}).get("transfers", [])
        print(f"\nIncoming transfers in last {days}d: {len(transfers2)}")
        for t in transfers2[:8]:
            ts = (t.get("metadata") or {}).get("blockTimestamp", "?")
            print(f"  {ts[:10]}  tx={t.get('hash','')[:14]}...  from={t.get('from','?')[:14]}...")

        # --- getNFTSales order=desc (newest first) ---
        url_v3 = f"https://{chain_id}.g.alchemy.com/nft/v3/{key}/getNFTSales"
        params = {"sellerAddress": wallet, "limit": "10", "order": "desc"}
        async with s.get(url_v3, params=params) as r:
            data3 = await r.json()
        sales = data3.get("nftSales", [])
        print(f"\nMost recent sales (Alchemy getNFTSales v3 seller, desc):")
        for sale in sales[:5]:
            print(f"  block={sale.get('blockNumber')}  marketplace={sale.get('marketplace')}  "
                  f"tx={sale.get('transactionHash','')[:14]}...")

if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "0xdbd47f66aa2f00b3db03397f260ce9728298c495"
    asyncio.run(main(w))
