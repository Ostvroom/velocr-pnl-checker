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
    # Check DB first for recently updated floor (1 hour TTL)
    conn = database.get_db_connection()
    try:
        row = conn.execute(
            "SELECT floor_price_native, floor_updated_at FROM collections WHERE chain = ? AND contract_address = ? LIMIT 1",
            (chain_key, contract.lower())
        ).fetchone()
        if row and row['floor_updated_at'] and row['floor_updated_at'] > (time.time() - 3600):
            return float(row['floor_price_native'] or 0.0)
    finally:
        conn.close()

    # Alchemy NFT API v3 — getFloorPrice was deprecated; use getContractMetadata
    # openSeaMetadata.floorPrice gives the current floor in ETH
    url = f"{base}/getContractMetadata"
    best = 0.0
    try:
        async with session.get(
            url,
            params={"contractAddress": contract},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as r:
            if r.status < 400:
                data = await r.json()
                os_meta = data.get("openSeaMetadata") or {}
                fp = os_meta.get("floorPrice")
                if fp is not None:
                    try:
                        best = float(fp)
                    except (TypeError, ValueError):
                        best = 0.0
    except Exception:
        best = 0.0

    # Cache in DB
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

    # Time cutoff for period filtering — but do NOT filter rows yet.
    # We must process ALL rows for buy/sell matching first, then apply
    # the time window for stats/display.
    cutoff = 0
    if moralis_days is not None and moralis_days > 0:
        cutoff = int(time.time()) - moralis_days * 86400

    def _in_period(ts: int) -> bool:
        """True if this row falls within the selected time window."""
        if cutoff == 0:
            return True  # "All time"
        if ts == 0:
            return True  # unknown timestamp — include by default
        return ts >= cutoff

    # 4. Resolve prices for every row & do buy/sell matching on the FULL history.
    #    Rows are ordered newest→oldest, so a SELL appears before the matching BUY.

    def sanitize_name(n):
        if not n: return ""
        if n.count('?') > 3 or '??' in n: return ""
        if len(n) > 30 and all(c in '0123456789abcdefABCDEF?' for c in n): return ""
        return n.strip()

    # Pre-compute price & side for every row (full history)
    enriched: List[Dict[str, Any]] = []
    for r in rows:
        r["collection_name"] = sanitize_name(r.get("collection_name"))
        side = "buy" if r["to_address"].lower() == wl else "sell"
        legacy = float(r["price_native"] or 0.0)
        sale_buyer = (r["sale_buyer"] or "").lower() if r["sale_buyer"] else ""
        sale_seller = (r["sale_seller"] or "").lower() if r["sale_seller"] else ""
        bt = r["buyer_total_native"]
        sr = r["seller_receipt_native"]
        inferred = r["inferred_price_native"]

        if sale_buyer or sale_seller:
            if wl == sale_buyer:
                price = float(bt) if bt is not None else (float(inferred) if inferred else legacy)
            elif wl == sale_seller:
                price = float(sr) if sr is not None else (float(inferred) if inferred else legacy)
            else:
                price = float(inferred) if inferred else legacy
        else:
            price = float(inferred) if inferred else legacy

        contract_addr = r["contract_address"].lower()
        token_id = str(r["token_id"]).strip()
        if token_id.startswith("0x"):
            try:
                token_id = str(int(token_id, 16))
            except ValueError:
                pass

        enriched.append({
            "row": r,
            "side": side,
            "price": price,
            "contract_addr": contract_addr,
            "token_id": token_id,
            "ts": r["timestamp_unix"] or 0,
        })

    # Pass 1: Match buys ↔ sells across the ENTIRE history (newest→oldest).
    # Track which buys are "matched" (= realized) vs "unmatched" (= still held).
    pending_sells: Dict[Tuple[str, str], List[Tuple[float, int]]] = {}  # key → [(sell_price, sell_ts), ...]
    matched_buy_indices: set = set()     # indices of buys that matched a sell
    matched_sell_indices: set = set()    # for reference

    for idx, e in enumerate(enriched):
        nft_key = (e["contract_addr"], e["token_id"])
        if e["side"] == "sell":
            if nft_key not in pending_sells:
                pending_sells[nft_key] = []
            pending_sells[nft_key].append((e["price"], idx))
        elif e["side"] == "buy":
            if nft_key in pending_sells and pending_sells[nft_key]:
                sell_price, sell_idx = pending_sells[nft_key].pop(0)
                matched_buy_indices.add(idx)
                matched_sell_indices.add(sell_idx)
                # Store the PnL on the enriched entry for later
                e["_pnl_event"] = sell_price - e["price"]
                e["_matched_sell_price"] = sell_price

    # Pass 2: Compute period-filtered stats (only rows within the time window).
    normalized: List[Dict[str, Any]] = []
    buy_vol = 0.0
    sell_vol = 0.0
    mint_spend = 0.0
    mint_count = 0
    buy_count = 0
    sell_count = 0
    realized_pnl_native = 0.0
    best_trade: Optional[float] = None
    worst_trade: Optional[float] = None
    period_unrealized_cost = 0.0
    period_unrealized_contracts: Dict[str, int] = {}
    buckets: Dict[str, Dict[str, Any]] = {}

    for idx, e in enumerate(enriched):
        r = e["row"]
        side = e["side"]
        price = e["price"]
        contract_addr = e["contract_addr"]
        token_id = e["token_id"]
        ts = e["ts"]

        if not _in_period(ts):
            continue  # skip rows outside the selected time window for display

        # Realized PnL: only for matched buys within the period
        if side == "buy" and idx in matched_buy_indices:
            pnl_event = e.get("_pnl_event", 0.0)
            realized_pnl_native += pnl_event
            if best_trade is None or pnl_event > best_trade:
                best_trade = pnl_event
            if worst_trade is None or pnl_event < worst_trade:
                worst_trade = pnl_event

        # Unrealized: buys in-period that were NOT matched to any sell (anywhere in history)
        if side == "buy" and idx not in matched_buy_indices:
            period_unrealized_cost += price
            period_unrealized_contracts[contract_addr] = period_unrealized_contracts.get(contract_addr, 0) + 1

        # Volume / count stats
        if side == "buy":
            if r["event_type"] == "mint":
                mint_count += 1
                mint_spend += price
            else:
                buy_count += 1
                buy_vol += price
        else:
            sell_count += 1
            sell_vol += price

        # Bucket aggregation (per-collection)
        if contract_addr not in buckets:
            buckets[contract_addr] = {
                "token_address": contract_addr,
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
        b = buckets[contract_addr]
        if side == "buy":
            b["buy_volume"] += price
            b["buy_count"] += 1
        else:
            b["sell_volume"] += price
            b["sell_count"] += 1
        if side == "buy" and idx in matched_buy_indices:
            b["realized_pnl"] = b.get("realized_pnl", 0.0) + e.get("_pnl_event", 0.0)

        normalized.append({
            "side": side,
            "price_eth": price,
            "price_wei": int(price * 1e18),
            "buyer_address": r['to_address'],
            "seller_address": r['from_address'],
            "token_address": r['contract_address'],
            "token_id": token_id,
            "transaction_hash": r['tx_hash'],
            "block_number": r['block_number'],
            "timestamp_unix": ts,
            "marketplace": r['marketplace'] or "",
            "chain_symbol": symbol,
            "payment_symbol": r['payment_token'] or symbol,
            "token_name": r.get("collection_name") or "",
            "image_url": r.get("collection_image") or "",
        })

    # 5. Live Unrealized — fetch floor for top 30 contracts by holdings count
    period_floor = 0.0
    u_err = None
    holds_n = sum(period_unrealized_contracts.values())
    top_contracts = sorted(period_unrealized_contracts.items(), key=lambda x: x[1], reverse=True)[:30]
    if not skip_unrealized and top_contracts:
        sem = asyncio.Semaphore(5)
        async with aiohttp.ClientSession() as fp_session:
            async def _get_fp(c, q):
                nonlocal period_floor
                async with sem:
                    fp = await _fetch_floor(fp_session, base, c, chain_key)
                period_floor += fp * q
            try:
                await asyncio.wait_for(
                    asyncio.gather(*[_get_fp(c, q) for c, q in top_contracts], return_exceptions=True),
                    timeout=20.0,
                )
            except asyncio.TimeoutError:
                pass  # use partial results

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
    scope = f"**{len(normalized)}** indexed events · {period_note}"

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
        "unrealized_pnl_native": period_floor - period_unrealized_cost if not u_err else None,
        "holdings_floor_native": period_floor if not u_err else None,
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
