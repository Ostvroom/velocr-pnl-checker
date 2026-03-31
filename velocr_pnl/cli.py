import argparse
import asyncio
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from velocr_pnl.core import get_wallet_pnl

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    load_dotenv(_PROJECT_ROOT / ".env", encoding="utf-8-sig")
    load_dotenv(encoding="utf-8-sig")
    p = argparse.ArgumentParser(description="Velcor PNL (Moralis)")
    p.add_argument("wallet", help="0x… EVM address")
    p.add_argument("--chain", default="eth", help="eth | polygon | base | arbitrum | optimism")
    p.add_argument(
        "--days",
        type=int,
        default=None,
        help="Last N days only (0 = all time per Moralis params). Omit to use .env PNL_MORALIS_DAYS.",
    )
    args = p.parse_args()

    days = args.days
    if days is not None:
        days = max(0, min(3650, days))

    data = asyncio.run(get_wallet_pnl(args.wallet, args.chain, moralis_days=days))
    json.dump(data, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    if "error" in data:
        sys.exit(1)


if __name__ == "__main__":
    main()
