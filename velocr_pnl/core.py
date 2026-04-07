"""
Velcor PNL — Alchemy-powered Indexed backend.

Uses:
- indexer.py to sync wallet history from Alchemy to SQLite
- database.py to query stored trades and calculate PnL
"""
import asyncio
import aiohttp
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from velocr_pnl import indexer, database

# ─── Chain metadata ──────────────────────────────────────────────────────────
PNL_CHAIN_META: Dict[str, Tuple[str, str]] = indexer.PNL_CHAIN_META

# Alchemy subdomain per chain
ALCHEMY_CHAIN: Dict[str, str] = indexer.ALCHEMY_CHAIN

SIMPLEHASH_CHAIN = ALCHEMY_CHAIN   # legacy alias used by __init__.py

ZERO_ADDR = "0x0000000000000000000000000000000000000000"
PNL_VALID_CHAINS = frozenset(PNL_CHAIN_META.keys())

# ─── Helpers ─────────────────────────────────────────────────────────────────

def _api_key() -> str:
    return (
        (os.getenv("ALCHEMY_API_KEY") or "").strip()
        or (os.getenv("SIMPLEHASH_API_KEY") or "").strip()
        or (os.getenv("MORALIS_API_KEY") or "").strip()
    )

def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "on")

def _env_int(name: str, default: int, vmin: int, vmax: int) -> int:
    try:
        return max(vmin, min(vmax, int((os.getenv(name) or str(default)).strip())))
    except ValueError:
        return default

def _nft_base(chain_key: str, key: str) -> str:
    return indexer._nft_base(chain_key, key)

def _rpc_url(chain_key: str, key: str) -> str:
    return indexer._rpc_url(chain_key, key)

def _resolve_ipfs_url(url: str) -> str:
    u = (url or "").strip()
    if u.lower().startswith("ipfs://"):
        return "https://ipfs.io/ipfs/" + u[7:]
    return u

# ─── Floor Price Cache (Delegated to indexer/database eventually) ───────────
_floor_cache: Dict[Tuple[str, str], Tuple[float, float]] = {}
_floor_lock = asyncio.Lock()

async def _fetch_floor(session: aiohttp.ClientSession, base: str, contract: str, chain_key: str) -> float:
    # Check DB first for recently updated floor
    conn = database.get_db_connection()
    try:
        row = conn.execute(
            "SELECT floor_price_native, floor_updated_at FROM collections WHERE chain = ? AND contract_address = ? LIMIT 1",
            (chain_key, contract.lower())
        ).fetchone()
        if row and row['floor_updated_at'] > (time.time() - 3600):
            return row['floor_price_native'] or 0.0
    finally:
        conn.close()

    # Fallback to Alchemy API (and cache in memory for now)
    url = f"{base}/getFloorPrice"
    try:
        async with session.get(url, params={"contractAddress": contract}, timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status >= 400: return 0.0
            data = await r.json()
    except Exception: return 0.0

    best = 0.0
    for mkt_data in data.values():
        if isinstance(mkt_data, dict):
            try:
                v = float(mkt_data.get("floorPrice") or 0)
                if v > best: best = v
            except: pass

    # Update DB with new floor
    conn = database.get_db_connection()
    try:
        conn.execute("""
            INSERT INTO collections (chain, contract_address, floor_price_native, floor_updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chain, contract_address) DO UPDATE SET
                floor_price_native = excluded.floor_price_native,
                floor_updated_at = excluded.floor_updated_at
        """, (chain_key, contract.lower(), best, int(time.time())))
        conn.commit()
    finally:
        conn.close()
    return best

# ─── Fetching Holdings (Still live, but indexed later) ──────────────────────

async def _fetch_holdings(session: aiohttp.ClientSession, base: str, wallet: str, max_pages: int) -> Tuple[List[dict], Optional[str]]:
    nfts: List[dict] = []
    page_key: Optional[str] = None
    url = f"{base}/getNFTs"
    for _ in range(max_pages):
        params = {"owner": wallet, "withMetadata": "true", "pageSize": "100"}
        if page_key: params["pageKey"] = page_key
        try:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=45)) as r:
                if r.status >= 400: break
                data = await r.json()
        except Exception: break
        nfts.extend(data.get("ownedNfts") or [])
        page_key = data.get("pageKey")
        if not page_key: break
        await asyncio.sleep(0.1)
    return nfts, None

async def _calc_unrealized(session: aiohttp.ClientSession, base: str, wallet: str, chain_key: str, max_hold_pages: int) -> Tuple[float, float, int, Optional[str]]:
    nfts, err = await _fetch_holdings(session, base, wallet, max_hold_pages)
    if err: return 0.0, 0.0, 0, err
    contracts: Dict[str, int] = {}
    for nft in nfts:
        c = (nft.get("contract", {}).get("address") or "").lower()
        if c: contracts[c] = contracts.get(c, 0) + 1
    total_floor = 0.0
    sem = asyncio.Semaphore(6)
    async def _one(addr: str, qty: int):
        nonlocal total_floor
        async with sem:
            fp = await _fetch_floor(session, base, addr, chain_key)
        total_floor += fp * qty
    await asyncio.gather(*[_one(a, q) for a, q in contracts.items()], return_exceptions=True)
    return total_floor, total_floor, len(nfts), None


async def _fetch_missing_metadata(contracts: set[str], base: str, chain_key: str) -> dict[str, dict]:
    """Bulk fetch collection metadata via getContractMetadataBatch"""
    if not contracts:
        return {}
    out = {}
    contracts_list = list(contracts)
    url = f"{base}/getContractMetadataBatch"
    
    async with aiohttp.ClientSession() as session:
        for i in range(0, len(contracts_list), 50):
            batch = contracts_list[i:i+50]
            payload = {"contractAddresses": batch}
            try:
                async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status >= 400: continue
                    data = await r.json()
            except Exception: continue
                
            cs = data.get("contracts") or []
            for c in cs:
                addr = (c.get("address") or "").lower()
                name = c.get("name") or c.get("openSeaMetadata", {}).get("collectionName") or ""
                img = c.get("openSeaMetadata", {}).get("imageUrl") or c.get("image") or ""
                if addr:
                    out[addr] = {"name": name, "image_url": img}
    return out

# ─── Core pipeline ───────────────────────────────────────────────────────────

async def _pipeline(
    wallet_address: str,
    chain: str,
    max_sale_pages: int,
    skip_unrealized: bool = False,
    moralis_days: Optional[int] = None,
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    chain_key = chain.lower()
    if chain_key not in PNL_CHAIN_META:
        return {"error": f"Invalid chain '{chain}'"}, None

    database.init_db()

    key = _api_key()
    if not key:
        return {"error": "Set **ALCHEMY_API_KEY** in your `.env` file."}, None

    chain_name, symbol = PNL_CHAIN_META[chain_key]
    base = _nft_base(chain_key, key)
    wl = wallet_address.lower()

    # 1. Check Sync State
    conn = database.get_db_connection()
    try:
        row = conn.execute(
            "SELECT last_sync_at FROM sync_state WHERE chain = ? AND wallet_address = ? LIMIT 1",
            (chain_key, wl)
        ).fetchone()
        last_sync = row['last_sync_at'] if row else 0
    finally:
        conn.close()

    # 2. Trigger Sync if stale (30 mins)
    if time.time() - last_sync > 1800:
        await indexer.sync_wallet(
            wl,
            chain_key,
            max_pages=max_sale_pages,
            days_window=moralis_days,
        )

    # 3. Pull Data from Indexer
    conn = database.get_db_connection()
    try:
        # Fetch Sales joined with transfers.
        # NOTE: We join sales by tx_hash + contract_address + token_id (NOT log_index)
        # because alchemy_getAssetTransfers and getNFTSales use different log indexing schemes,
        # which causes log_index-based joins to silently fail and return NULL prices.
        rows = conn.execute(
            """
            SELECT t.*,
                   s.price_native,
                   s.buyer_total_native,
                   s.seller_receipt_native,
                   s.payment_token,
                   s.marketplace,
                   s.buyer AS sale_buyer,
                   s.seller AS sale_seller,
                   t.inferred_price_native,
                   c.name AS collection_name,
                   c.image_url AS collection_image
            FROM transfers t
            LEFT JOIN sales s
              ON t.chain = s.chain
             AND t.tx_hash = s.tx_hash
             AND LOWER(t.contract_address) = LOWER(s.contract_address)
             AND t.token_id = s.token_id
            LEFT JOIN collections c
              ON t.chain = c.chain AND LOWER(t.contract_address) = LOWER(c.contract_address)
            WHERE t.chain = ? AND t.wallet_address = ?
            ORDER BY t.block_number DESC
            """,
            (chain_key, wl),
        ).fetchall()
    finally:
        conn.close()

    rows = [dict(r) for r in rows]

    # Quick fetch for completely missing metadata
    missing_meta = {r["contract_address"].lower() for r in rows if r["contract_address"] and r["collection_name"] is None}
    if missing_meta:
        meta_dict = await _fetch_missing_metadata(missing_meta, base, chain_key)
        if meta_dict:
            conn = database.get_db_connection()
            try:
                for c_addr, md in meta_dict.items():
                    c_name, c_img = md["name"], md["image_url"]
                    conn.execute("""
                        INSERT INTO collections (chain, contract_address, name, image_url)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(chain, contract_address) DO UPDATE SET
                            name = excluded.name,
                            image_url = excluded.image_url
                    """, (chain_key, c_addr, c_name, c_img))
                conn.commit()
            finally:
                conn.close()
            # Patch memory rows
            for r in rows:
                c_addr = r["contract_address"].lower()
                if c_addr in meta_dict and r["collection_name"] is None:
                    r["collection_name"] = meta_dict[c_addr]["name"]
                    r["collection_image"] = meta_dict[c_addr]["image_url"]

    if moralis_days is not None and moralis_days > 0:
        cutoff = int(time.time()) - moralis_days * 86400
        rows = [
            r
            for r in rows
            if (r["timestamp_unix"] or 0) == 0
            or (r["timestamp_unix"] or 0) >= cutoff
        ]

    # 4. Calculate PnL from DB rows
    normalized: List[Dict[str, Any]] = []
    buy_vol = 0.0
    sell_vol = 0.0
    mint_spend = 0.0
    mint_count = 0
    buy_count = 0
    sell_count = 0

    buckets: Dict[str, Dict[str, Any]] = {}
    
    # Track cost basis matching (processing newest to oldest, so SELLs buffered until matching BUY is found)
    pending_sells: Dict[Tuple[str, str], List[float]] = {}
    realized_pnl_native = 0.0
    best_trade: Optional[float] = None
    worst_trade: Optional[float] = None

    def sanitize_name(n):
        if not n: return ""
        # If name is just ????? or contains too many ? relative to length, it's likely garbled
        if n.count('?') > 3 or '??' in n: return ""
        # If it looks like a raw long hex string (common in some garbled API responses)
        if len(n) > 30 and all(c in '0123456789abcdefABCDEF?' for c in n): return ""
        return n.strip()

    for r in rows:
        r["collection_name"] = sanitize_name(r.get("collection_name"))
        side = "buy" if r["to_address"].lower() == wl else "sell"
        legacy = float(r["price_native"] or 0.0)
        sale_buyer = (r["sale_buyer"] or "").lower() if r["sale_buyer"] else ""
        sale_seller = (r["sale_seller"] or "").lower() if r["sale_seller"] else ""
        bt = r["buyer_total_native"]
        sr = r["seller_receipt_native"]
        inferred = r["inferred_price_native"]

        # Priority: Alchemy getNFTSales exact fee data → inferred ETH/WETH payment → 0
        if sale_buyer or sale_seller:
            if wl == sale_buyer:
                price = float(bt) if bt is not None else (float(inferred) if inferred else legacy)
            elif wl == sale_seller:
                price = float(sr) if sr is not None else (float(inferred) if inferred else legacy)
            else:
                price = float(inferred) if inferred else legacy
        else:
            # No sale record at all — use inferred ETH/WETH payment if available
            price = float(inferred) if inferred else legacy

        contract_addr = r["contract_address"].lower()
        token_id = str(r["token_id"]).strip()
        if token_id.startswith("0x"):
            try:
                token_id = str(int(token_id, 16))
            except ValueError:
                pass

        if side == "buy":
            key = (contract_addr, token_id)
            if key in pending_sells and len(pending_sells[key]) > 0:
                matched_sell_price = pending_sells[key].pop(0)
                pnl_event = matched_sell_price - price
                realized_pnl_native += pnl_event
                
                if best_trade is None or pnl_event > best_trade:
                    best_trade = pnl_event
                if worst_trade is None or pnl_event < worst_trade:
                    worst_trade = pnl_event

                # Apply to bucket as well (must ensure bucket exists)
                if contract_addr not in buckets:
                    buckets[contract_addr] = {
                        "token_address": contract_addr, "symbol": symbol,
                        "buy_volume": 0.0, "sell_volume": 0.0, "buy_count": 0, "sell_count": 0,
                        "net_native": 0.0, "realized_pnl": 0.0,
                    }
                buckets[contract_addr]["realized_pnl"] += pnl_event

            if r["event_type"] == "mint":
                mint_count += 1
                mint_spend += price
            else:
                buy_count += 1
                buy_vol += price
        else:
            sell_count += 1
            sell_vol += price
            key = (contract_addr, token_id)
            if key not in pending_sells:
                pending_sells[key] = []
            pending_sells[key].append(price)

        # Bucket aggregation
        addr = r["contract_address"].lower()
        if addr not in buckets:
            buckets[addr] = {
                "token_address": addr,
                "collection_name": r.get("collection_name") or "",
                "collection_image": r.get("collection_image") or "",
                "symbol": symbol,
                "buy_volume": 0.0,
                "sell_volume": 0.0,
                "buy_count": 0,
                "sell_count": 0,
                "net_native": 0.0,
                "realized_pnl": 0.0,
            }
        b = buckets[addr]
        if "realized_pnl" not in b:
            b["realized_pnl"] = 0.0
            
        if side == "buy":
            b["buy_volume"] += price
            b["buy_count"] += 1
        else:
            b["sell_volume"] += price
            b["sell_count"] += 1

        normalized.append({
            "side": side,
            "price_eth": price,
            "price_wei": int(price * 1e18),
            "buyer_address": r['to_address'],
            "seller_address": r['from_address'],
            "token_address": r['contract_address'],
            "token_id": r['token_id'],
            "transaction_hash": r['tx_hash'],
            "block_number": r['block_number'],
            "timestamp_unix": r['timestamp_unix'] or 0,
            "marketplace": r['marketplace'] or "",
            "chain_symbol": symbol,
            "payment_symbol": r['payment_token'] or symbol,
            "token_name": r.get("collection_name") or "",
            "image_url": r.get("collection_image") or "",
            "token_id": token_id,
        })

    # 5. Live Unrealized (Still using API for current floor speed)
    unreal, floor, holds_n, u_err = 0.0, 0.0, 0, None
    if not skip_unrealized:
        async with aiohttp.ClientSession() as session:
            unreal, floor, holds_n, u_err = await _calc_unrealized(session, base, wallet_address, chain_key, max_hold_pages=3)

    total_cost = buy_vol + mint_spend
    net = sell_vol - total_cost
    pct = (net / total_cost * 100.0) if total_cost > 1e-12 else None
    
    tokens = list(buckets.values())
    for t in tokens: t["net_native"] = t["sell_volume"] - t["buy_volume"]
    tokens.sort(key=lambda x: abs(x["net_native"]), reverse=True)

    period_note = (
        f"Last {moralis_days} days · Alchemy"
        if moralis_days and moralis_days > 0
        else "All time · Alchemy"
    )
    scope = f"**{len(rows)}** indexed events · {period_note}"

    pnl: Dict[str, Any] = {
        "mode": "alchemy_indexed",
        "wallet": wallet_address,
        "chain": chain_name,
        "symbol": symbol,
        "moralis_period_note": period_note,
        "bought_trades": buy_count,
        "sold_trades": sell_count,
        "est_buy_volume": buy_vol,
        "est_sell_volume": sell_vol,
        "mint_count": mint_count,
        "mint_spend": mint_spend,
        "net_trades": net,
        "realized_pnl_native": realized_pnl_native,
        "best_trade": best_trade,
        "worst_trade": worst_trade,
        "unrealized_pnl_native": floor - total_cost if not u_err else None,
        "holdings_floor_native": floor if not u_err else None,
        "holdings_nft_count": holds_n if not u_err else None,
        "pnl_percent": pct,
        "trades_rows": len(normalized),
        "scope_note": scope,
        "tokens": tokens[:50],
    }

    return pnl, {"normalized_trades": normalized}


# ─── Public API ───

async def get_wallet_pnl(wallet_address: str, chain: str = "eth", **kwargs) -> Dict[str, Any]:
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address."}
    pnl, _ = await _pipeline(
        wallet_address,
        chain,
        max_sale_pages=15,
        moralis_days=kwargs.get("moralis_days"),
    )
    return pnl

async def get_wallet_dashboard_bundle(wallet_address: str, chain: str = "eth", **kwargs) -> Dict[str, Any]:
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address."}
    pnl, pdata = await _pipeline(
        wallet_address,
        chain,
        max_sale_pages=15,
        moralis_days=kwargs.get("moralis_days"),
    )
    if "error" in pnl or pdata is None: return pnl
    return {
        "pnl": pnl,
        "trades": {
            "wallet": wallet_address, "chain": pnl["chain"], "symbol": pnl["symbol"],
            "trades": pdata["normalized_trades"], "raw_count": len(pdata["normalized_trades"]),
        },
        "activity": {"activities": [], "raw_transfer_rows": 0},
    }

async def get_wallet_recent_trades(
    wallet_address: str,
    chain: str = "eth",
    max_pages: Optional[int] = None,
    **kwargs,
) -> Dict[str, Any]:
    mp = max(1, max_pages if max_pages is not None else 15)
    pnl, pdata = await _pipeline(
        wallet_address,
        chain,
        max_sale_pages=mp,
        skip_unrealized=True,
        moralis_days=kwargs.get("moralis_days"),
    )
    if "error" in pnl or pdata is None: return pnl
    return {
        "wallet": wallet_address, "chain": pnl["chain"], "symbol": pnl["symbol"],
        "trades": pdata["normalized_trades"], "raw_count": len(pdata["normalized_trades"]),
    }

async def get_wallet_nft_activity(wallet_address: str, chain: str = "eth", **kwargs) -> Dict[str, Any]:
    pnl, pdata = await _pipeline(
        wallet_address,
        chain,
        max_sale_pages=3,
        skip_unrealized=True,
        moralis_days=kwargs.get("moralis_days"),
    )
    if "error" in pnl or pdata is None: return pnl
    return {
        "wallet": wallet_address, "chain": pnl["chain"], "symbol": pnl["symbol"],
        "activities": [], "raw_transfer_rows": 0,
    }

async def get_watchlist_nft_feed(chain: str = "eth", per_wallet_max_pages: int = 2, **kwargs) -> Dict[str, Any]:
    raw = (os.getenv("VELOCR_FEED_WALLETS") or "").strip()
    chain_name = PNL_CHAIN_META.get(chain.lower(), ("Ethereum", "ETH"))[0]
    if not raw: return {"chain": chain_name, "trades": [], "wallets": []}
    addrs = [w.strip() for w in raw.split(",") if re.match(r"^0x[a-fA-F0-9]{40}$", w.strip())][:25]
    results = await asyncio.gather(*[get_wallet_recent_trades(a, chain, max_pages=per_wallet_max_pages) for a in addrs], return_exceptions=True)
    merged = []
    for addr, res in zip(addrs, results):
        if isinstance(res, dict) and not res.get("error"):
            for t in res.get("trades") or []:
                tw = dict(t); tw["watched_wallet"] = addr; merged.append(tw)
    merged.sort(key=lambda x: int(x.get("block_number") or 0), reverse=True)
    return {"chain": chain_name, "wallets": addrs, "trades": merged[:200]}
