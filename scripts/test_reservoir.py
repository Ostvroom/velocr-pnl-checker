"""Test Reservoir API for recent sales."""
import asyncio, aiohttp, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

async def main(wallet):
    url = "https://api.reservoir.tools/sales/v6"
    params = {"maker": wallet, "limit": "10", "sortBy": "time", "sortDirection": "desc"}
    headers = {"accept": "application/json", "x-api-key": "demo-api-key"}

    async with aiohttp.ClientSession() as s:
        async with s.get(url, params=params, headers=headers) as r:
            body = await r.text()
            print(f"status={r.status}")
            d = json.loads(body)
            sales = d.get("sales", [])
            print(f"sales returned: {len(sales)}")
            for sale in sales[:5]:
                price = sale.get("price") or {}
                amt = (price.get("amount") or {}).get("decimal")
                sym = (price.get("currency") or {}).get("symbol")
                ts = sale.get("timestamp")
                tx = sale.get("txHash", "")[:14]
                print(f"  ts={ts}  tx={tx}...  price={amt} {sym}")

        # Also check taker (buyer) role
        params2 = {"taker": wallet, "limit": "10", "sortBy": "time", "sortDirection": "desc"}
        async with s.get(url, params=params2, headers=headers) as r:
            body = await r.text()
            d = json.loads(body)
            sales2 = d.get("sales", [])
            print(f"\nAs buyer (taker) sales returned: {len(sales2)}")
            for sale in sales2[:5]:
                price = sale.get("price") or {}
                amt = (price.get("amount") or {}).get("decimal")
                sym = (price.get("currency") or {}).get("symbol")
                ts = sale.get("timestamp")
                tx = sale.get("txHash", "")[:14]
                print(f"  ts={ts}  tx={tx}...  price={amt} {sym}")

if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "0xb0cf6360b50c48280e2c18fe9d96bc7d6f5ed697"
    asyncio.run(main(w))
