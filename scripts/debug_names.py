"""Debug: inspect what token_name values the API is actually returning."""
import urllib.request
import json
import sys

wallet = sys.argv[1] if len(sys.argv) > 1 else "0xb4d64772218d36f97974e8bb6ef0d01b026c9a14"
url = f"http://127.0.0.1:8080/api/dashboard/{wallet}?chain=eth&days=30"

data = json.loads(urllib.request.urlopen(url).read().decode("utf-8"))
trades = data.get("trades", {}).get("trades", [])

print(f"Total trades: {len(trades)}")
print("=" * 80)

for i, t in enumerate(trades[:10]):
    name = t.get("token_name", "")
    tid = t.get("token_id", "")
    img = t.get("image_url", "")
    side = t.get("side", "")
    price = t.get("price_eth", 0)

    # Show raw repr to spot encoding issues
    print(f"[{i}] side={side}  price={price}")
    print(f"    token_name repr : {repr(name)}")
    print(f"    token_id repr   : {repr(tid)}")
    print(f"    image_url       : {img[:80] if img else '(empty)'}")
    print()
