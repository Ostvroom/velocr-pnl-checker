import asyncio
import aiohttp
import os
import time
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from velocr_pnl.database import get_db_connection, init_db

# Reuse the same chain metadata as core.py
PNL_CHAIN_META = {
    "eth":       ("Ethereum", "ETH"),
    "polygon":   ("Polygon",  "MATIC"),
    "base":      ("Base",     "ETH"),
    "arbitrum":  ("Arbitrum", "ETH"),
    "optimism":  ("Optimism", "ETH"),
}

ALCHEMY_CHAIN = {
    "eth":       "eth-mainnet",
    "polygon":   "polygon-mainnet",
    "base":      "base-mainnet",
    "arbitrum":  "arb-mainnet",
    "optimism":  "opt-mainnet",
}

# Wrapped-native token contracts (for WETH, WMATIC, etc.)
WRAPPED_NATIVE = {
    "eth":       "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",  # WETH
    "polygon":   "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",  # WETH on Polygon
    "base":      "0x4200000000000000000000000000000000000006",  # WETH on Base
    "arbitrum":  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",  # WETH on Arbitrum
    "optimism":  "0x4200000000000000000000000000000000000006",  # WETH on Optimism
}

def _api_key() -> str:
    """Same resolution as `core._api_key` — Alchemy NFT/RPC URLs need an Alchemy dashboard key."""
    return (
        (os.getenv("ALCHEMY_API_KEY") or "").strip()
        or (os.getenv("SIMPLEHASH_API_KEY") or "").strip()
    )

def _nft_base(chain_key: str, key: str, version: str = "v3") -> str:
    return f"https://{ALCHEMY_CHAIN[chain_key]}.g.alchemy.com/nft/{version}/{key}"

def _rpc_url(chain_key: str, key: str) -> str:
    return f"https://{ALCHEMY_CHAIN[chain_key]}.g.alchemy.com/v2/{key}"


def _fee_to_native(fee: Any) -> tuple[float, str]:
    """Alchemy NftSaleFeeData: amount is integer string, decimals for token."""
    if not isinstance(fee, dict):
        return 0.0, "ETH"
    sym = str(fee.get("symbol") or "ETH").strip() or "ETH"
    try:
        dec = int(fee["decimals"]) if fee.get("decimals") is not None else 18
    except (TypeError, ValueError):
        dec = 18
    raw = fee.get("amount")
    if raw is None or raw == "":
        return 0.0, sym
    try:
        amt_int = int(str(raw).split(".", 1)[0])
    except (TypeError, ValueError):
        return 0.0, sym
    return amt_int / (10**dec), sym


def _sale_amounts(s: dict) -> tuple[float, float, str]:
    """
    Alchemy docs: sellerFee = buyer→seller; protocolFee = marketplace; royaltyFee = royalties.
    Buyer all-in cost ≈ sum of components (same tx, same payment token usually).
    Seller net revenue ≈ sellerFee (what the seller receives for the NFT).
    """
    sf, sym = _fee_to_native(s.get("sellerFee"))
    pf, _ = _fee_to_native(s.get("protocolFee"))
    rf, _ = _fee_to_native(s.get("royaltyFee"))
    buyer_total = sf + pf + rf
    return buyer_total, sf, sym


def _dedupe_sales(sales: List[dict]) -> List[dict]:
    seen: set[tuple[str, int]] = set()
    out: List[dict] = []
    for s in sales:
        tx = (s.get("transactionHash") or "").lower()
        try:
            li = int(s.get("logIndex", 0))
        except (TypeError, ValueError):
            li = 0
        k = (tx, li)
        if not tx or k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def _transfer_ts_unix(t: dict) -> int:
    """Block time from alchemy_getAssetTransfers when withMetadata=true."""
    md = t.get("metadata")
    if isinstance(md, dict):
        ts = md.get("blockTimestamp")
        if isinstance(ts, str):
            try:
                s = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
                dt = datetime.fromisoformat(s)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return int(dt.timestamp())
            except ValueError:
                pass
    return 0


def _transfer_log_index(t: dict) -> int:
    """Real ERC-721 log index (joins to getNFTSales); do not use enumerate()."""
    u = t.get("uniqueId")
    if isinstance(u, str) and ":" in u:
        tail = u.rsplit(":", 1)[-1].strip()
        try:
            return int(tail, 16) if tail.startswith("0x") else int(tail)
        except ValueError:
            pass
    li = t.get("logIndex")
    if li is not None:
        if isinstance(li, str):
            try:
                return int(li, 16) if li.startswith("0x") else int(li)
            except ValueError:
                pass
        try:
            return int(li)
        except (TypeError, ValueError):
            pass
    return 0


def _parse_token_id(t_id: Any) -> str:
    """Alchemy often returns Token IDs as giant hex strings. Convert them to decimal."""
    if t_id is None:
        return ""
    s = str(t_id).strip()
    if s.startswith("0x"):
        try:
            return str(int(s, 16))
        except ValueError:
            return s
    return s


async def _resolve_from_block_decimal(
    session: aiohttp.ClientSession, chain: str, key: str, days: int
) -> Optional[str]:
    """Approximate start block for last `days` (12s/block on Ethereum L1)."""
    if days <= 0:
        return None
    rpc = _rpc_url(chain, key)
    async with session.post(
        rpc,
        json={"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []},
        timeout=aiohttp.ClientTimeout(total=20),
    ) as r:
        if r.status != 200:
            return None
        data = await r.json()
    res = data.get("result")
    if not res:
        return None
    latest = int(res, 16) if isinstance(res, str) and res.startswith("0x") else int(res)
    span = int((days * 86400) / 12)
    fb = max(0, latest - span)
    return str(fb)


async def _fetch_payment_transfers(
    session: aiohttp.ClientSession,
    chain: str,
    wallet: str,
    key: str,
    max_pages: int,
    from_block: Optional[str] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Fetch ETH (internal) and WETH (erc20) value flows for the wallet to infer
    sale prices when Alchemy getNFTSales has no record (Seaport v1.5+ gap).

    Returns {tx_hash_lower: {"amount": float, "token": "ETH"|"WETH", "direction": "in"|"out"}}
    For a given tx_hash, INCOMING amount = seller received; OUTGOING = buyer paid.
    If multiple transfers in same tx, we sum them (royalties go to multiple addresses).
    """
    rpc = _rpc_url(chain, key)
    weth = WRAPPED_NATIVE.get(chain, "")
    result: Dict[str, Dict[str, Any]] = {}

    for direction_key, addr_param in [("in", "toAddress"), ("out", "fromAddress")]:
        for category, label in [(["internal"], "ETH"), (["erc20"], "WETH")]:
            page_key = None
            for _ in range(max(1, max_pages // 4)):
                block_params: Dict[str, Any] = {
                    addr_param: wallet,
                    "category": category,
                    "withMetadata": False,
                    "excludeZeroValue": True,
                    "maxCount": "0x3e8",
                }
                if from_block:
                    block_params["fromBlock"] = from_block
                if page_key:
                    block_params["pageKey"] = page_key

                payload = {
                    "jsonrpc": "2.0", "id": 1,
                    "method": "alchemy_getAssetTransfers",
                    "params": [block_params],
                }
                async with session.post(rpc, json=payload) as r:
                    if r.status != 200:
                        break
                    data = await r.json()

                if data.get("error"):
                    break

                transfers = (data.get("result") or {}).get("transfers") or []
                for t in transfers:
                    # For ERC-20, only accept the wrapped-native (WETH/WMATIC) contract
                    if label == "WETH":
                        contract = ((t.get("rawContract") or {}).get("address") or "").lower()
                        if contract != weth:
                            continue

                    tx = (t.get("hash") or "").lower()
                    if not tx:
                        continue

                    raw_val = (t.get("rawContract") or {}).get("value")
                    val_float = 0.0
                    if raw_val:
                        try:
                            val_float = int(raw_val, 16) / 1e18
                        except (ValueError, TypeError):
                            pass
                    if val_float <= 0:
                        direct_val = t.get("value")
                        if direct_val is not None:
                            try:
                                val_float = float(direct_val)
                            except (TypeError, ValueError):
                                pass

                    if val_float <= 0:
                        continue

                    key_str = f"{tx}:{direction_key}"
                    if key_str in result:
                        result[key_str]["amount"] += val_float
                    else:
                        result[key_str] = {
                            "tx_hash": tx,
                            "amount": val_float,
                            "token": label,
                            "direction": direction_key,
                        }

                page_key = (data.get("result") or {}).get("pageKey")
                if not page_key or not transfers:
                    break
                await asyncio.sleep(0.05)

    return result


def _apply_inferred_prices(chain: str, wallet: str, payments: Dict[str, Dict[str, Any]]) -> None:
    """
    For each transfer row with no matching sale price, write the inferred ETH/WETH
    payment amount to transfers.inferred_price_native.
    Incoming payment (direction=in) → used for sell-side; outgoing → buy-side.
    """
    if not payments:
        return

    conn = get_db_connection()
    try:
        # Group payments by tx_hash and direction
        by_tx: Dict[str, Dict[str, float]] = {}
        for entry in payments.values():
            tx = entry["tx_hash"]
            d = entry["direction"]
            if tx not in by_tx:
                by_tx[tx] = {}
            by_tx[tx][d] = by_tx[tx].get(d, 0.0) + entry["amount"]

        for tx_hash, dirs in by_tx.items():
            # For outgoing NFT (sell): seller received payment (direction=in)
            # For incoming NFT (buy): buyer paid (direction=out)
            inferred = dirs.get("in", 0.0) or dirs.get("out", 0.0)
            if inferred <= 0:
                continue

            # Check how many NFTs were transferred for this wallet in this tx
            row = conn.execute(
                """
                SELECT COUNT(*) as count 
                FROM transfers 
                WHERE chain = ? AND tx_hash = ? AND wallet_address = ?
                """,
                (chain, tx_hash, wallet)
            ).fetchone()
            
            count = row['count'] if row and row['count'] > 0 else 1
            true_price = inferred / count

            conn.execute(
                """
                UPDATE transfers
                SET inferred_price_native = ?
                WHERE chain = ? AND tx_hash = ? AND wallet_address = ?
                  AND inferred_price_native IS NULL
                """,
                (true_price, chain, tx_hash, wallet),
            )
        conn.commit()
    finally:
        conn.close()


async def sync_wallet(
    wallet: str,
    chain: str = "eth",
    max_pages: int = 20,
    days_window: Optional[int] = None,
):
    """
    Synchronize a wallet's NFT history from Alchemy into the local SQLite database.
    If ``days_window`` is provided, fetches only from an approximate fromBlock for that window.
    Time-window display filtering is also applied in core._pipeline via timestamp_unix.
    """
    init_db()
    key = _api_key()
    if not key:
        return {"error": "Missing ALCHEMY_API_KEY"}

    wallet = wallet.lower()
    chain = chain.lower()
    if chain not in ALCHEMY_CHAIN:
        return {"error": f"Unsupported chain: {chain}"}

    async with aiohttp.ClientSession() as session:
        from_block_dec: Optional[int] = None
        if days_window is not None and days_window > 0:
            fb_str = await _resolve_from_block_decimal(session, chain, key, days_window)
            if fb_str is not None:
                try:
                    from_block_dec = int(fb_str)
                except (TypeError, ValueError):
                    from_block_dec = None

        # getNFTSales: fromBlock not used (not supported by v3 endpoint)
        # alchemy_getAssetTransfers: requires hex block number
        from_block_hex = hex(from_block_dec) if from_block_dec is not None else None

        sales_data, hit_cap = await _fetch_sales(
            session, chain, wallet, key, max_pages
        )
        _save_sales(chain, wallet, sales_data)

        transfers_data = await _fetch_asset_transfers(
            session, chain, wallet, key, max_pages, from_block=from_block_hex
        )
        _save_transfers(chain, wallet, transfers_data)

        # Fetch ETH/WETH payment flows to infer prices for trades Alchemy getNFTSales misses
        payments = await _fetch_payment_transfers(
            session, chain, wallet, key, max_pages, from_block=from_block_hex
        )
        _apply_inferred_prices(chain, wallet, payments)

        _update_sync_state(chain, wallet)

    return {
        "status": "success",
        "sales_indexed": len(sales_data),
        "transfers_indexed": len(transfers_data),
        "payments_inferred": len(payments),
    }

async def _fetch_sales(
    session: aiohttp.ClientSession,
    chain: str,
    wallet: str,
    key: str,
    max_pages: int,
    from_block: Optional[str] = None,  # kept for signature compat, not used
):
    """
    Fetch NFT marketplace sales via Alchemy NFT API v3 getNFTSales.
    Uses order=desc so the most recent sales come first within each page batch.
    fromBlock is NOT passed — the v2/v3 endpoint does not reliably accept it.
    Time-window filtering is handled downstream by core._pipeline via timestamp_unix.
    """
    base = _nft_base(chain, key, version="v3")
    url = f"{base}/getNFTSales"
    all_sales = []
    page_key = None

    for role in ["buyerAddress", "sellerAddress"]:
        for _ in range(max_pages // 2):
            params: dict = {role: wallet, "limit": "100", "order": "desc"}
            if page_key:
                params["pageKey"] = page_key

            async with session.get(url, params=params) as r:
                if r.status != 200:
                    body = await r.text()
                    print(f"[getNFTSales] HTTP {r.status}: {body[:200]}")
                    break
                data = await r.json()

            sales = data.get("nftSales") or []
            all_sales.extend(sales)
            page_key = data.get("pageKey")
            if not page_key or not sales:
                break
            await asyncio.sleep(0.1)
        page_key = None  # reset for next role

    return _dedupe_sales(all_sales), False

async def _fetch_asset_transfers(
    session: aiohttp.ClientSession,
    chain: str,
    wallet: str,
    key: str,
    max_pages: int,
    from_block: Optional[str] = None,
):
    rpc = _rpc_url(chain, key)
    all_transfers = []
    page_key = None
    
    # SimpleHash-like behavior: fetch all NFT transfers to/from this wallet
    for direction in ["toAddress", "fromAddress"]:
        for _ in range(max_pages // 2):
            block_params: Dict[str, Any] = {
                direction: wallet,
                "category": ["erc721", "erc1155"],
                "withMetadata": True,
                "excludeZeroValue": False,
                "maxCount": "0x3e8",
            }
            if from_block is not None:
                block_params["fromBlock"] = from_block
            payload = {
                "jsonrpc": "2.0", "id": 1,
                "method": "alchemy_getAssetTransfers",
                "params": [block_params],
            }
            if page_key:
                payload["params"][0]["pageKey"] = page_key
                
            async with session.post(rpc, json=payload) as r:
                if r.status != 200:
                    body = await r.text()
                    print(f"[getAssetTransfers] HTTP {r.status}: {body[:200]}")
                    break
                data = await r.json()

            if data.get("error"):
                print(f"[getAssetTransfers] RPC error: {data['error']}")
                break
            result = data.get("result") or {}
            transfers = result.get("transfers") or []
            all_transfers.extend(transfers)
            page_key = result.get("pageKey")
            if not page_key or not transfers:
                break
            await asyncio.sleep(0.1)
        page_key = None

    return all_transfers

def _save_sales(chain: str, wallet: str, sales: List[dict]):
    conn = get_db_connection()
    try:
        for s in sales:
            tx_hash = (s.get("transactionHash") or "").lower()
            try:
                log_idx = int(s.get("logIndex", 0))
            except (TypeError, ValueError):
                log_idx = 0
            if not tx_hash:
                continue

            buyer_total, seller_receipt, payment_token = _sale_amounts(s)
            # price_native kept as buyer-side all-in for legacy readers
            price_native = buyer_total

            conn.execute(
                """
                INSERT OR REPLACE INTO sales (
                    chain, tx_hash, log_index, price_native, buyer_total_native, seller_receipt_native,
                    payment_token, marketplace, buyer, seller
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chain,
                    tx_hash,
                    log_idx,
                    price_native,
                    buyer_total,
                    seller_receipt,
                    payment_token,
                    s.get("marketplace"),
                    (s.get("buyerAddress") or "").lower(),
                    (s.get("sellerAddress") or "").lower(),
                ),
            )

            conn.execute(
                """
                INSERT OR IGNORE INTO transfers (
                    chain, wallet_address, contract_address, token_id, from_address, to_address,
                    block_number, tx_hash, log_index, timestamp_unix, event_type
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chain,
                    wallet,
                    (s.get("contractAddress") or "").lower(),
                    _parse_token_id(s.get("tokenId")),
                    (s.get("sellerAddress") or "").lower(),
                    (s.get("buyerAddress") or "").lower(),
                    int(s.get("blockNumber") or 0),
                    tx_hash,
                    log_idx,
                    None,
                    "sale",
                ),
            )

        conn.commit()
    finally:
        conn.close()

def _save_transfers(chain: str, wallet: str, transfers: List[dict]):
    conn = get_db_connection()
    try:
        for t in transfers:
            tx_hash = (t.get("hash") or "").lower()
            if not tx_hash: continue

            # Identify if it's a mint
            from_addr = (t.get("from") or "").lower()
            is_mint = from_addr == "0x0000000000000000000000000000000000000000"
            event_type = 'mint' if is_mint else 'transfer'

            log_idx = _transfer_log_index(t)
            bn = t.get("blockNum")
            if isinstance(bn, str) and bn.startswith("0x"):
                block_number = int(bn, 16)
            else:
                block_number = int(bn or 0)

            ts_u = _transfer_ts_unix(t)
            conn.execute("""
                INSERT OR IGNORE INTO transfers (chain, wallet_address, contract_address, token_id, from_address, to_address, block_number, tx_hash, log_index, timestamp_unix, event_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                chain,
                wallet,
                (t.get("rawContract") or {}).get("address") or "",
                _parse_token_id(t.get("tokenId")),
                (t.get("from") or "").lower(),
                (t.get("to") or "").lower(),
                block_number,
                tx_hash,
                log_idx,
                ts_u or None,
                event_type,
            ))
            
        conn.commit()
    finally:
        conn.close()

def _update_sync_state(chain: str, wallet: str):
    conn = get_db_connection()
    try:
        now = int(time.time())
        conn.execute("""
            INSERT OR REPLACE INTO sync_state (chain, wallet_address, last_sync_at)
            VALUES (?, ?, ?)
        """, (chain, wallet, now))
        conn.commit()
    finally:
        conn.close()
