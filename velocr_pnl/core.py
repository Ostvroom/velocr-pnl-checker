"""
Velcor PNL — Moralis-only (`MORALIS_API_KEY`).

- `GET …/wallets/{address}/nfts/trades` — marketplace buys/sells
- `GET …/{address}/nft/transfers` — NFT transfers; **mints** = from `0x0` → wallet
"""
import asyncio
import aiohttp
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

PNL_CHAIN_META: Dict[str, Tuple[str, str]] = {
    "eth": ("Ethereum", "ETH"),
    "polygon": ("Polygon", "MATIC"),
    "base": ("Base", "ETH"),
    "arbitrum": ("Arbitrum", "ETH"),
    "optimism": ("Optimism", "ETH"),
}

MORALIS_CHAIN: Dict[str, str] = {
    "eth": "eth",
    "polygon": "polygon",
    "base": "base",
    "arbitrum": "arbitrum",
    "optimism": "optimism",
}

MORALIS_TRADES_URL = "https://deep-index.moralis.io/api/v2.2/wallets/{address}/nfts/trades"
MORALIS_NFT_TRANSFERS_URL = "https://deep-index.moralis.io/api/v2.2/{address}/nft/transfers"
MORALIS_NFT_CONTRACT_METADATA_URL = "https://deep-index.moralis.io/api/v2.2/nft/{address}/metadata"
MORALIS_NFT_TOKEN_URL = "https://deep-index.moralis.io/api/v2.2/nft/{address}/{token_id}"
MORALIS_WALLET_NFTS_URL = "https://deep-index.moralis.io/api/v2.2/{address}/nft"
MORALIS_RESOLVE_REVERSE_URL = "https://deep-index.moralis.io/api/v2.2/resolve/{address}/reverse"

OPENSEA_ACCOUNT_URL = "https://api.opensea.io/api/v2/accounts/{address_or_username}"

ZERO_ADDR = "0x0000000000000000000000000000000000000000"

PNL_VALID_CHAINS = frozenset(PNL_CHAIN_META.keys())

_PAYMENT_TOKEN_SYMBOL_BY_CHAIN: Dict[str, Dict[str, str]] = {
    # ETH mainnet
    "eth": {
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
    },
    # Base / Arbitrum / Optimism canonical WETH
    "base": {
        "0x4200000000000000000000000000000000000006": "WETH",
    },
    "arbitrum": {
        "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "WETH",
    },
    "optimism": {
        "0x4200000000000000000000000000000000000006": "WETH",
    },
    # Polygon
    "polygon": {
        "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "WMATIC",
    },
}

_COLLECTION_META_TTL_S = float(os.getenv("VELOCR_COLLECTION_META_TTL_S", "600") or 600)  # seconds
_collection_meta_cache: Dict[Tuple[str, str], Tuple[float, Dict[str, str]]] = {}
_collection_meta_lock = asyncio.Lock()

# Short TTL full-dashboard cache (one Moralis trade fetch vs two). `VELOCR_API_CACHE_TTL_S=0` disables.
_dashboard_bundle_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_dashboard_bundle_lock = asyncio.Lock()


def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "on")


def _opensea_key() -> Optional[str]:
    k = (os.getenv("OPENSEA_API_KEY") or "").strip()
    return k or None


async def _fetch_moralis_wallet_name(
    session: aiohttp.ClientSession,
    wallet_address: str,
    api_key: str,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Use Moralis Resolve API to reverse-resolve a wallet to a human name.
    Today this is primarily ENS (on Ethereum) and may be empty for most wallets.
    """
    url = MORALIS_RESOLVE_REVERSE_URL.format(address=quote(wallet_address))
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as r:
            text = await r.text()
            if r.status == 401:
                return None, _moralis_error_message(401, text)
            if r.status == 429:
                return None, _moralis_error_message(429, text)
            if r.status >= 400:
                return None, _moralis_error_message(r.status, text)
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                return None, "Moralis returned non-JSON."
    except Exception:
        return None, "Moralis resolve request failed."

    if not isinstance(data, dict):
        return None, None
    nm = data.get("name") or data.get("domain") or data.get("ens") or ""
    name = nm.strip() if isinstance(nm, str) else ""
    return (name if name else None), None


async def _fetch_opensea_wallet_name(
    session: aiohttp.ClientSession,
    wallet_address: str,
    api_key: str,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Fetch OpenSea account profile (v2) to get `username` for an address.
    Requires OPENSEA_API_KEY; failures are non-fatal.
    """
    url = OPENSEA_ACCOUNT_URL.format(address_or_username=quote(wallet_address))
    headers = {
        "X-API-KEY": api_key,
        "Accept": "application/json",
        "User-Agent": "VelcorDashboard/1.0 (opensea-account)",
    }
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as r:
            text = await r.text()
            if r.status == 401 or r.status == 403:
                return None, "OpenSea unauthorized (check OPENSEA_API_KEY)."
            if r.status == 429:
                return None, "OpenSea rate limited."
            if r.status >= 400:
                return None, f"OpenSea error {r.status}."
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                return None, "OpenSea returned non-JSON."
    except Exception:
        return None, "OpenSea request failed."

    if not isinstance(data, dict):
        return None, None
    # Docs: AccountResponse contains `username`; be defensive to schema drift.
    u = data.get("username")
    if not u and isinstance(data.get("account"), dict):
        u = data["account"].get("username")
    if not u and isinstance(data.get("data"), dict):
        u = data["data"].get("username")
    name = str(u).strip() if isinstance(u, (str, int, float)) else ""
    return (name if name else None), None


def _env_int(name: str, default: int, vmin: int, vmax: int) -> int:
    try:
        x = int((os.getenv(name) or "").strip() or default)
    except ValueError:
        x = default
    return max(vmin, min(vmax, x))


_PAYMENT_TOKEN_NAMES = frozenset(
    {
        "ether",
        "ethereum",
        "eth",
        "wrapped ether",
        "wrapped eth",
        "weth",
        "matic",
        "wmatic",
        "polygon matic",
        "pol",
        "bnb",
        "wrapped bnb",
        "avax",
        "avax.e",
    }
)


def _looks_like_payment_token_name(s: str) -> bool:
    """Moralis marketplace rows often put payment currency in `name` / `token_name` — not the collection."""
    t = (s or "").strip().lower()
    if not t:
        return False
    if t in _PAYMENT_TOKEN_NAMES:
        return True
    if t.startswith("wrapped ") and len(t) < 40:
        return True
    return False


def _is_generic_chain_icon_url(url: str) -> bool:
    """Moralis sometimes returns chain/token icons instead of NFT art."""
    u = (url or "").lower()
    return "cdn.moralis.io/eth/0x" in u or "/eth/0x.png" in u or "/native/eth" in u


def _resolve_ipfs_url(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""
    low = u.lower()
    if low.startswith("ipfs://ipfs/"):
        return "https://ipfs.io/ipfs/" + u[12:]
    if low.startswith("ipfs://"):
        return "https://ipfs.io/ipfs/" + u[7:]
    return u


def _image_from_metadata_dict(meta: Any) -> str:
    if not isinstance(meta, dict):
        return ""
    for key in ("image", "image_url", "animation_url", "external_image_url"):
        val = meta.get(key)
        if isinstance(val, str) and val.strip():
            return _resolve_ipfs_url(val)
    return ""


def _str_is_http_or_ipfs(s: str) -> bool:
    low = s.lower()
    return low.startswith("http://") or low.startswith("https://") or low.startswith("ipfs://")


def _media_preview_first_url(media: Any) -> str:
    """Moralis `media` / media_items — first usable preview URL."""
    if isinstance(media, dict):
        mc = media.get("media_collection")
        if isinstance(mc, dict):
            for tier in ("high", "medium", "low"):
                m = mc.get(tier)
                if isinstance(m, dict):
                    u = m.get("url")
                    if isinstance(u, str) and u.strip() and _str_is_http_or_ipfs(u):
                        return u.strip()
        for k in ("original_media_url", "media_url", "url", "preview"):
            u = media.get(k)
            if isinstance(u, str) and u.strip() and _str_is_http_or_ipfs(u):
                return u.strip()
    if isinstance(media, list):
        for item in media:
            if isinstance(item, dict):
                u = item.get("url") or item.get("original_media_url")
                if isinstance(u, str) and u.strip() and _str_is_http_or_ipfs(u):
                    return u.strip()
    return ""


def _parse_loose_native_amount(val: Any) -> float:
    """Moralis mixes wei strings, human decimals, and occasionally USD strings; best-effort native amount."""
    if val is None:
        return 0.0
    s = str(val).strip()
    if not s:
        return 0.0
    try:
        x = float(s)
    except (TypeError, ValueError):
        return 0.0
    if abs(x) >= 1e12:
        return x / 1e18
    return x


def _nft_row_image(row: dict) -> str:
    """Image URL from Moralis trade / NFT / metadata rows (incl. media previews)."""
    for key in ("token_logo", "collection_logo", "logo", "image"):
        v = row.get(key)
        if isinstance(v, str) and v.strip():
            s = v.strip()
            if _str_is_http_or_ipfs(s):
                return _resolve_ipfs_url(s)
    md_raw = row.get("metadata")
    if isinstance(md_raw, str) and "{" in md_raw:
        try:
            j = json.loads(md_raw)
            u = _image_from_metadata_dict(j)
            if u:
                return u
        except json.JSONDecodeError:
            pass
    u = _image_from_metadata_dict(row.get("normalized_metadata"))
    if u:
        return u
    u = _image_from_metadata_dict(row.get("nft_metadata"))
    if u:
        return u
    nested = row.get("nft")
    if isinstance(nested, dict):
        u = _image_from_metadata_dict(nested.get("metadata") if isinstance(nested.get("metadata"), dict) else nested)
        if u:
            return u
    mu = _media_preview_first_url(row.get("media"))
    if mu:
        return _resolve_ipfs_url(mu)
    return ""


def _first_token_id_from_row(row: dict) -> str:
    tid = row.get("token_id")
    if tid is not None and str(tid).strip():
        return str(tid)
    tids = row.get("token_ids")
    if isinstance(tids, list) and tids:
        return str(tids[0])
    return ""


def _nft_row_name(row: dict, token_id: str) -> str:
    """
    Best-effort NFT name for a trade row.
    Moralis wallet-trades don't include collection names; when `nft_metadata=true` they may include
    `normalized_metadata.name` or `nft_metadata.name`.
    """
    nm = row.get("normalized_metadata")
    if isinstance(nm, dict):
        n = nm.get("name")
        if isinstance(n, str) and n.strip() and not _looks_like_payment_token_name(n):
            return n.strip()
    md = row.get("nft_metadata")
    if isinstance(md, dict):
        n = md.get("name")
        if isinstance(n, str) and n.strip() and not _looks_like_payment_token_name(n):
            return n.strip()
    n2 = row.get("name")
    if isinstance(n2, str) and n2.strip() and not _looks_like_payment_token_name(n2):
        return n2.strip()
    tn = row.get("token_name")
    if isinstance(tn, str) and tn.strip() and not _looks_like_payment_token_name(tn):
        return tn.strip()
    return f"#{token_id}" if token_id else ""


def _safe_trade_row_image(row: dict) -> str:
    u = _nft_row_image(row)
    if u and _is_generic_chain_icon_url(u):
        return ""
    return u


def _moralis_period_params(moralis_days_override: Optional[int] = None) -> Tuple[Dict[str, str], str]:
    """
    Build Moralis trade query params to limit time range (fewer rows → less CU).

    Priority:
    1. moralis_days_override: >0 = last N days UTC; 0 = no filter (all time).
    2. Env PNL_MORALIS_FROM_BLOCK / TO_BLOCK
    3. Env PNL_MORALIS_FROM_DATE / TO_DATE
    4. Env PNL_MORALIS_DAYS = rolling window from now.
    5. No filter (all time).
    """
    p: Dict[str, str] = {}

    if moralis_days_override is not None:
        if moralis_days_override > 0:
            days = max(1, min(3650, int(moralis_days_override)))
            now = datetime.now(timezone.utc)
            from_dt = now - timedelta(days=days)
            # Moralis accepts seconds or moment-style strings; unix bounds are most reliable.
            p["from_date"] = str(int(from_dt.timestamp()))
            p["to_date"] = str(int(now.timestamp()))
            return (
                p,
                f"last **{days}** day(s) `{from_dt.date().isoformat()}` → `{now.date().isoformat()}` UTC (per-request)",
            )
        return {}, "all time — no date filter (**higher CU** / pagination)"

    fb = (os.getenv("PNL_MORALIS_FROM_BLOCK") or "").strip()
    tb = (os.getenv("PNL_MORALIS_TO_BLOCK") or "").strip()
    if fb or tb:
        if fb:
            p["from_block"] = fb
        if tb:
            p["to_block"] = tb
        return p, f"blocks **{fb or '…'}** → **{tb or '…'}**"

    fd = (os.getenv("PNL_MORALIS_FROM_DATE") or "").strip()
    td = (os.getenv("PNL_MORALIS_TO_DATE") or "").strip()
    if fd or td:
        if fd:
            p["from_date"] = fd
        if td:
            p["to_date"] = td
        return p, f"dates **{fd or '…'}** → **{td or '…'}**"

    days_s = (os.getenv("PNL_MORALIS_DAYS") or "").strip()
    if days_s:
        try:
            days = max(1, min(3650, int(days_s)))
        except ValueError:
            days = 0
        if days:
            now = datetime.now(timezone.utc)
            from_dt = now - timedelta(days=days)
            p["from_date"] = str(int(from_dt.timestamp()))
            p["to_date"] = str(int(now.timestamp()))
            return p, f"last **{days}** day(s) `{from_dt.date().isoformat()}` → `{now.date().isoformat()}` UTC (`PNL_MORALIS_DAYS`)"

    return {}, "all time — no filter (set **`PNL_MORALIS_DAYS`** or pass `moralis_days` to save CU)"


def _moralis_key() -> str:
    """
    Reads `MORALIS_API_KEY` or `MORALIS_WEB3_API_KEY`; strips whitespace and optional
    wrapping quotes (common when pasting into `.env`).
    """
    raw = (os.getenv("MORALIS_API_KEY") or os.getenv("MORALIS_WEB3_API_KEY") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1].strip()
    return raw


def _moralis_error_message(status: int, body: str) -> str:
    """Human-readable Moralis failure; includes API JSON `message` when present."""
    if status == 401:
        base = (
            "Moralis **401** — this key is invalid, expired, or not a **Web3 Data API** key. "
            "In Moralis Admin (https://admin.moralis.io/) open your **project** → **Web3 API** / API Keys → "
            "copy the key used for Web3 Data API (not Streams-only credentials)."
        )
    elif status == 429:
        return "Moralis **rate limit** — try again shortly."
    else:
        base = f"Moralis HTTP **{status}**."

    try:
        data = json.loads(body)
        msg = data.get("message") or data.get("error") or data.get("msg")
        if isinstance(msg, str) and msg.strip():
            return f"{base} Details: {msg.strip()}"
    except json.JSONDecodeError:
        pass
    snippet = body.strip().replace("\n", " ")
    if snippet and status != 401:
        return f"{base} `{snippet[:200]}`"
    if snippet and status == 401 and len(snippet) < 300:
        return f"{base} Raw: `{snippet}`"
    return base


async def _moralis_paginated_result(
    session: aiohttp.ClientSession,
    url: str,
    moralis_chain: str,
    api_key: str,
    page_limit: int,
    max_pages: int,
    period_params: Optional[Dict[str, str]],
    extra_params: Optional[Dict[str, str]] = None,
) -> Tuple[List[dict], bool, Optional[str]]:
    """Generic Moralis paginated `result` list. Returns (rows, hit_cap, error_message)."""
    all_rows: List[dict] = []
    hit_cap = False
    cursor: Optional[str] = None
    period_params = period_params or {}
    extra = extra_params or {}

    for page_idx in range(max_pages):
        params: Dict[str, str] = {
            "chain": moralis_chain,
            "limit": str(page_limit),
            **extra,
            **period_params,
        }
        if cursor:
            params["cursor"] = cursor
        headers = {
            "X-API-Key": api_key,
            "Accept": "application/json",
        }
        try:
            async with session.get(
                url,
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=45),
            ) as r:
                text = await r.text()
                if r.status == 401:
                    return [], False, _moralis_error_message(401, text)
                if r.status == 429:
                    return [], False, _moralis_error_message(429, text)
                if r.status >= 400:
                    return [], False, _moralis_error_message(r.status, text)
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    return [], False, "Moralis returned non-JSON."
        except Exception as e:
            return [], False, f"Moralis request error: {e}"

        if not isinstance(data, dict):
            return [], False, "Unexpected Moralis response."

        rows = data.get("result")
        if not isinstance(rows, list):
            rows = []
        all_rows.extend([x for x in rows if isinstance(x, dict)])

        next_cursor = data.get("cursor")
        if not next_cursor or not rows:
            break
        if page_idx == max_pages - 1:
            hit_cap = True
            break
        cursor = str(next_cursor)
        await asyncio.sleep(0.12)

    return all_rows, hit_cap, None


async def _fetch_moralis_nft_token(
    session: aiohttp.ClientSession,
    token_address: str,
    token_id: str,
    moralis_chain: str,
    api_key: str,
) -> Tuple[Optional[dict], Optional[str]]:
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    base_params = {
        "chain": moralis_chain,
        "normalizeMetadata": "true",
        "media_items": "true",
        "include_prices": "false",
    }
    attempts: List[Tuple[str, str]] = [
        ("decimal", quote(str(token_id).strip(), safe="")),
    ]
    ts = str(token_id).strip()
    if ts.isdigit():
        try:
            attempts.append(("hex", quote(hex(int(ts))[2:], safe="")))
        except ValueError:
            pass

    last_err = "No token id"
    for fmt, tid_q in attempts:
        params = {**base_params, "format": fmt}
        url = MORALIS_NFT_TOKEN_URL.format(address=token_address, token_id=tid_q)
        try:
            async with session.get(
                url,
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=25),
            ) as r:
                text = await r.text()
                if r.status == 404 and fmt == "decimal" and len(attempts) > 1:
                    last_err = _moralis_error_message(r.status, text)
                    continue
                if r.status >= 400:
                    return None, _moralis_error_message(r.status, text)
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    return None, "Moralis returned non-JSON."
                return data if isinstance(data, dict) else None, None
        except Exception as e:
            return None, f"Moralis request error: {e}"
    return None, last_err if last_err else "NFT not found."


async def _fetch_moralis_nft_contract_metadata(
    session: aiohttp.ClientSession,
    token_address: str,
    moralis_chain: str,
    api_key: str,
) -> Tuple[Optional[dict], Optional[str]]:
    url = MORALIS_NFT_CONTRACT_METADATA_URL.format(address=token_address)
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    try:
        async with session.get(
            url,
            params={"chain": moralis_chain, "include_prices": "false"},
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as r:
            text = await r.text()
            if r.status >= 400:
                return None, _moralis_error_message(r.status, text)
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                return None, "Moralis returned non-JSON."
            return data if isinstance(data, dict) else None, None
    except Exception as e:
        return None, f"Moralis request error: {e}"


def _collection_cache_get(chain_key: str, token_address: str) -> Optional[Dict[str, str]]:
    k = (chain_key, token_address.lower())
    now = time.monotonic()
    v = _collection_meta_cache.get(k)
    if not v:
        return None
    exp, data = v
    if now >= exp:
        _collection_meta_cache.pop(k, None)
        return None
    return data


def _collection_cache_set(chain_key: str, token_address: str, data: Dict[str, str]) -> None:
    k = (chain_key, token_address.lower())
    _collection_meta_cache[k] = (time.monotonic() + _COLLECTION_META_TTL_S, data)


async def _enrich_tokens_with_collection_metadata(
    session: aiohttp.ClientSession,
    tokens: List[Dict[str, Any]],
    moralis_chain: str,
    api_key: str,
    chain_key: str,
    concurrency: int = 6,
) -> None:
    sem = asyncio.Semaphore(max(1, min(12, int(concurrency))))

    async def one(t: Dict[str, Any]) -> None:
        addr = (t.get("token_address") or "").strip()
        if not addr or not isinstance(addr, str) or not addr.lower().startswith("0x"):
            return
        async with _collection_meta_lock:
            cached = _collection_cache_get(chain_key, addr)
        if cached:
            nm = cached.get("collection_name") or ""
            lg = cached.get("collection_image") or ""
            if nm and not (t.get("collection_name") or "").strip():
                t["collection_name"] = nm
            if lg and not (t.get("collection_image") or "").strip():
                t["collection_image"] = lg
            if lg and not (t.get("image_url") or "").strip():
                t["image_url"] = lg
            return
        async with sem:
            data, err = await _fetch_moralis_nft_contract_metadata(session, addr, moralis_chain, api_key)
        if err or not data:
            return
        name = data.get("name")
        logo = data.get("collection_logo") or data.get("collection_banner_image") or ""
        out: Dict[str, str] = {}
        if isinstance(name, str) and name.strip():
            out["collection_name"] = name.strip()
            t["collection_name"] = out["collection_name"]
        if isinstance(logo, str) and logo.strip():
            out["collection_image"] = _resolve_ipfs_url(logo.strip())
            t["collection_image"] = out["collection_image"]
            if not (t.get("image_url") or "").strip():
                t["image_url"] = out["collection_image"]
        if out:
            async with _collection_meta_lock:
                _collection_cache_set(chain_key, addr, out)

    await asyncio.gather(*[one(t) for t in tokens], return_exceptions=True)


async def _enrich_trade_rows_token_images(
    session: aiohttp.ClientSession,
    rows: List[dict],
    moralis_chain: str,
    api_key: str,
    chain_key: str,
    fetch_per_token: bool = True,
) -> None:
    """
    Wallet NFT trade rows often omit art even with `nft_metadata=true`.
    Fill `image_url` via `GET /nft/{contract}/{token_id}` (deduped) when `fetch_per_token`.
    Always applies collection-logo fallback for rows still missing art (lower CU).
    """
    try:
        lim = max(4, min(200, int(os.getenv("VELOCR_TRADE_IMAGE_ENRICH_MAX", "24"))))
    except ValueError:
        lim = 24

    if fetch_per_token and not _truthy_env("VELOCR_SKIP_TRADE_NFT_ENRICH"):
        key_to_indices: Dict[Tuple[str, str], List[int]] = {}
        for i, r in enumerate(rows):
            if (r.get("image_url") or "").strip():
                continue
            tok = (r.get("token_address") or "").strip()
            tid = (r.get("token_id") or "").strip()
            if not tok.startswith("0x") or not tid:
                continue
            k = (tok.lower(), tid)
            key_to_indices.setdefault(k, []).append(i)

        keys = list(key_to_indices.keys())[:lim]

        if keys:
            sem = asyncio.Semaphore(max(2, min(8, _env_int("VELOCR_MORALIS_ENRICH_CONCURRENCY", 6, 1, 12))))

            async def fetch_one(contract_tid: Tuple[str, str]) -> None:
                contract, tid = contract_tid
                async with sem:
                    data, err = await _fetch_moralis_nft_token(session, contract, tid, moralis_chain, api_key)
                if err or not data:
                    async with sem:
                        meta, _ = await _fetch_moralis_nft_contract_metadata(session, contract, moralis_chain, api_key)
                    logo = ""
                    if isinstance(meta, dict):
                        raw = meta.get("collection_logo") or meta.get("collection_banner_image") or ""
                        if isinstance(raw, str) and raw.strip():
                            logo = _resolve_ipfs_url(raw.strip())
                    for idx in key_to_indices[contract_tid]:
                        if logo and not (rows[idx].get("image_url") or "").strip():
                            rows[idx]["image_url"] = logo
                    return
                img = _nft_row_image(data)
                tname = _nft_row_name(data, tid)
                for idx in key_to_indices[contract_tid]:
                    if img:
                        rows[idx]["image_url"] = img
                    if tname and not (rows[idx].get("token_name") or "").strip():
                        rows[idx]["token_name"] = tname

            await asyncio.gather(*[fetch_one(k) for k in keys], return_exceptions=True)

    missing_addrs = sorted(
        {
            (r.get("token_address") or "").strip()
            for r in rows
            if not (r.get("image_url") or "").strip() and (r.get("token_address") or "").strip().lower().startswith("0x")
        }
    )
    try:
        cap = max(4, min(80, int(os.getenv("VELOCR_TRADE_COLLECTION_LOGO_MAX", "28"))))
    except ValueError:
        cap = 28
    stubs: List[Dict[str, Any]] = [
        {"token_address": a, "collection_name": "", "collection_image": "", "image_url": ""} for a in missing_addrs[:cap]
    ]
    if stubs:
        await _enrich_tokens_with_collection_metadata(
            session, stubs, moralis_chain, api_key, chain_key=chain_key, concurrency=6
        )
        logo_by = {
            (s.get("token_address") or "").lower(): (s.get("collection_image") or s.get("image_url") or "").strip()
            for s in stubs
        }
        for r in rows:
            lg = logo_by.get((r.get("token_address") or "").lower())
            if not lg:
                continue
            cur = (r.get("image_url") or "").strip()
            if not cur or _is_generic_chain_icon_url(cur):
                r["image_url"] = lg


async def _enrich_trade_rows_collection_fields(
    session: aiohttp.ClientSession,
    rows: List[dict],
    moralis_chain: str,
    api_key: str,
    chain_key: str,
) -> None:
    """Set `collection_name` + fill/repair `image_url` from `GET /nft/{contract}/metadata` (cached)."""
    addrs = sorted(
        {
            (r.get("token_address") or "").strip()
            for r in rows
            if (r.get("token_address") or "").strip().lower().startswith("0x")
        }
    )
    try:
        cap = max(8, min(120, int(os.getenv("VELOCR_TRADE_COLLECTION_FIELDS_MAX", "80"))))
    except ValueError:
        cap = 80
    stubs: List[Dict[str, Any]] = [
        {"token_address": a, "collection_name": "", "collection_image": "", "image_url": ""} for a in addrs[:cap]
    ]
    if not stubs:
        return
    conc = max(2, min(8, _env_int("VELOCR_MORALIS_ENRICH_CONCURRENCY", 6, 1, 12)))
    await _enrich_tokens_with_collection_metadata(
        session, stubs, moralis_chain, api_key, chain_key=chain_key, concurrency=conc
    )
    by_l = {(s.get("token_address") or "").lower(): s for s in stubs}
    for r in rows:
        stub = by_l.get((r.get("token_address") or "").lower())
        if not isinstance(stub, dict):
            continue
        cn = (stub.get("collection_name") or "").strip()
        if cn:
            r["collection_name"] = cn
        lg = (stub.get("collection_image") or stub.get("image_url") or "").strip()
        if lg:
            cur = (r.get("image_url") or "").strip()
            if not cur or _is_generic_chain_icon_url(cur):
                r["image_url"] = _resolve_ipfs_url(lg)


def _last_sale_cost_native(last_sale: Any, wallet_lower: str) -> float:
    if not isinstance(last_sale, dict):
        return 0.0
    buyer = (last_sale.get("buyer_address") or "").lower()
    if buyer != wallet_lower:
        return 0.0
    pf = last_sale.get("price_formatted")
    if isinstance(pf, str) and pf.strip():
        try:
            return float(pf)
        except ValueError:
            pass
    try:
        return int(last_sale.get("price") or 0) / 1e18
    except (TypeError, ValueError):
        return 0.0


async def _fetch_wallet_nfts_unrealized(
    session: aiohttp.ClientSession,
    wallet_address: str,
    moralis_chain: str,
    api_key: str,
    page_limit: int,
    max_pages: int,
) -> Tuple[float, float, int, Optional[str]]:
    """
    Est. unrealized on **current** holdings: sum(floor) − sum(cost) where cost comes from
    Moralis `last_sale` when this wallet was the buyer (mints / missing history → cost 0).
    """
    wl = wallet_address.lower()
    url = MORALIS_WALLET_NFTS_URL.format(address=wallet_address)
    headers = {"X-API-Key": api_key, "Accept": "application/json"}
    total_floor = 0.0
    total_unrealized = 0.0
    n_items = 0
    cursor: Optional[str] = None

    for page_idx in range(max_pages):
        params: Dict[str, str] = {
            "chain": moralis_chain,
            "limit": str(page_limit),
            "format": "decimal",
            "normalizeMetadata": "false",
            "include_prices": "true",
            "exclude_spam": "false",
            "media_items": "false",
        }
        if cursor:
            params["cursor"] = cursor
        try:
            async with session.get(
                url,
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=45),
            ) as r:
                text = await r.text()
                if r.status == 401:
                    return 0.0, 0.0, 0, _moralis_error_message(401, text)
                if r.status == 429:
                    return 0.0, 0.0, 0, _moralis_error_message(429, text)
                if r.status >= 400:
                    return 0.0, 0.0, 0, _moralis_error_message(r.status, text)
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    return 0.0, 0.0, 0, "Moralis returned non-JSON."
        except Exception as e:
            return 0.0, 0.0, 0, f"Moralis request error: {e}"

        rows = data.get("result") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return total_unrealized, total_floor, n_items, None

        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                qty = max(1, int(float(row.get("amount") or 1)))
            except (TypeError, ValueError):
                qty = 1
            floor_n = _parse_loose_native_amount(row.get("floor_price")) * qty
            cost_n = _last_sale_cost_native(row.get("last_sale"), wl) * qty
            total_floor += floor_n
            total_unrealized += floor_n - cost_n
            n_items += qty

        next_cursor = data.get("cursor") if isinstance(data, dict) else None
        if not next_cursor or not rows:
            break
        if page_idx == max_pages - 1:
            break
        cursor = str(next_cursor)
        await asyncio.sleep(0.12)

    return total_unrealized, total_floor, n_items, None


async def _fetch_moralis_wallet_trades(
    session: aiohttp.ClientSession,
    wallet: str,
    moralis_chain: str,
    api_key: str,
    page_limit: int,
    max_pages: int,
    period_params: Optional[Dict[str, str]] = None,
    nft_metadata: bool = False,
) -> Tuple[List[dict], bool, Optional[str]]:
    url = MORALIS_TRADES_URL.format(address=wallet)
    return await _moralis_paginated_result(
        session,
        url,
        moralis_chain,
        api_key,
        page_limit,
        max_pages,
        period_params,
        {"nft_metadata": "true" if nft_metadata else "false"},
    )


async def _fetch_moralis_nft_transfers(
    session: aiohttp.ClientSession,
    wallet: str,
    moralis_chain: str,
    api_key: str,
    page_limit: int,
    max_pages: int,
    period_params: Optional[Dict[str, str]] = None,
    nft_metadata: bool = False,
) -> Tuple[List[dict], bool, Optional[str]]:
    url = MORALIS_NFT_TRANSFERS_URL.format(address=wallet)
    return await _moralis_paginated_result(
        session,
        url,
        moralis_chain,
        api_key,
        page_limit,
        max_pages,
        period_params,
        {
            "order": "DESC",
            "format": "decimal",
            "nft_metadata": "true" if nft_metadata else "false",
        },
    )


def _aggregate_moralis_trades(wallet_lower: str, trades: List[dict]) -> Tuple[int, int, int, int]:
    """Returns (buy_count, sell_count, buy_wei, sell_wei)."""
    buy_n = sell_n = 0
    buy_wei = sell_wei = 0
    for row in trades:
        buyer = (row.get("buyer_address") or "").lower()
        seller = (row.get("seller_address") or "").lower()
        try:
            price = int(row.get("price") or 0)
        except (TypeError, ValueError):
            price = 0
        if buyer == wallet_lower:
            buy_n += 1
            buy_wei += price
        if seller == wallet_lower:
            sell_n += 1
            sell_wei += price
    return buy_n, sell_n, buy_wei, sell_wei


def _aggregate_mints_from_transfers(wallet_lower: str, transfers: List[dict]) -> Tuple[int, int]:
    """
    Count mints (from zero address → wallet) and sum native `value` on those logs (wei).
    Mint paid via router/WETH may show value 0 here.
    """
    z = ZERO_ADDR.lower()
    mint_n = 0
    mint_wei = 0
    # Moralis repeats the *transaction value* on each transfer log in a tx.
    # If you mint multiple NFTs in one tx, summing per-row massively overcounts.
    seen_value_txs: set[str] = set()
    for row in transfers:
        to_a = (row.get("to_address") or "").lower()
        from_a = (row.get("from_address") or "").lower()
        if to_a != wallet_lower or from_a != z:
            continue
        mint_n += 1
        try:
            txh = (row.get("transaction_hash") or row.get("transactionHash") or "").lower()
            if txh and txh in seen_value_txs:
                continue
            v = int(row.get("value") or 0)
            if txh:
                seen_value_txs.add(txh)
            mint_wei += v
        except (TypeError, ValueError):
            pass
    return mint_n, mint_wei


def _aggregate_trades_by_token(
    wallet_lower: str,
    trades: List[dict],
    symbol: str,
    limit: int = 36,
) -> List[Dict[str, Any]]:
    """Per-NFT-contract marketplace flow: sell_volume − buy_volume in native (estimated realized)."""
    buckets: Dict[str, Dict[str, Any]] = {}
    for row in trades:
        buyer = (row.get("buyer_address") or "").lower()
        seller = (row.get("seller_address") or "").lower()
        tok_raw = row.get("token_address") or ""
        tok = tok_raw.lower() if isinstance(tok_raw, str) else str(tok_raw).lower()
        if not tok:
            continue
        try:
            price = int(row.get("price") or 0)
        except (TypeError, ValueError):
            price = 0
        if tok not in buckets:
            raw_nm = row.get("token_name") or row.get("name") or ""
            nm = (
                raw_nm
                if isinstance(raw_nm, str) and raw_nm.strip() and not _looks_like_payment_token_name(raw_nm)
                else ""
            )
            buckets[tok] = {
                "token_address": tok_raw if isinstance(tok_raw, str) else str(tok_raw),
                "token_name": nm[:48] if nm else "",
                "buy_wei": 0,
                "sell_wei": 0,
                "buy_count": 0,
                "sell_count": 0,
                "image_url": "",
                "collection_name": "",
                "collection_image": "",
            }
        b = buckets[tok]
        img = _safe_trade_row_image(row)
        if img and not b["image_url"]:
            b["image_url"] = img
        nm = row.get("token_name") or row.get("name")
        if (
            nm
            and not b["token_name"]
            and isinstance(nm, str)
            and nm.strip()
            and not _looks_like_payment_token_name(nm)
        ):
            b["token_name"] = nm[:48]
        if buyer == wallet_lower:
            b["buy_wei"] += price
            b["buy_count"] += 1
        if seller == wallet_lower:
            b["sell_wei"] += price
            b["sell_count"] += 1

    out: List[Dict[str, Any]] = []
    for b in buckets.values():
        buy_w, sell_w = int(b["buy_wei"]), int(b["sell_wei"])
        net = (sell_w - buy_w) / 1e18
        out.append(
            {
                "token_address": b["token_address"],
                "token_name": b["token_name"] or "",
                "collection_name": b.get("collection_name") or "",
                "collection_image": b.get("collection_image") or "",
                "image_url": b.get("image_url") or "",
                "buy_volume": buy_w / 1e18,
                "sell_volume": sell_w / 1e18,
                "net_native": net,
                "buy_count": b["buy_count"],
                "sell_count": b["sell_count"],
                "symbol": symbol,
            }
        )
    out.sort(key=lambda x: abs(float(x.get("net_native") or 0)), reverse=True)
    return out[: max(1, min(200, limit))]


def _moralis_single_trade_extremes(wallet_lower: str, trades: List[dict]) -> Tuple[Optional[int], Optional[int]]:
    """Largest one-row price when wallet is seller (best sale) vs buyer (largest buy). Prices in wei."""
    max_sell: Optional[int] = None
    max_buy: Optional[int] = None
    for row in trades:
        buyer = (row.get("buyer_address") or "").lower()
        seller = (row.get("seller_address") or "").lower()
        try:
            price = int(row.get("price") or 0)
        except (TypeError, ValueError):
            price = 0
        if price <= 0:
            continue
        if seller == wallet_lower:
            max_sell = price if max_sell is None else max(max_sell, price)
        if buyer == wallet_lower:
            max_buy = price if max_buy is None else max(max_buy, price)
    return max_sell, max_buy


async def _finalize_pnl_payload(
    wallet_address: str,
    chain_key: str,
    chain_name: str,
    symbol: str,
    wl: str,
    wallet_name: Optional[str],
    trades: List[dict],
    xfers: List[dict],
    hit_trade_cap: bool,
    hit_xfer_cap: bool,
    xfer_err: Optional[str],
    moralis_period_note: str,
    unreal_tuple: Optional[Tuple[Any, ...]],
    include_nft_metadata: bool,
    moralis_limit: int,
    trade_pages: int,
    xfer_pages: int,
) -> Dict[str, Any]:
    if xfer_err:
        xfers = []

    unrealized_native: Optional[float] = None
    holdings_floor_native: Optional[float] = None
    holdings_nft_count: Optional[int] = None
    unrealized_err: Optional[str] = None
    if unreal_tuple is not None and isinstance(unreal_tuple, tuple) and len(unreal_tuple) == 4:
        u_pn, u_fl, u_n, u_er = unreal_tuple
        unrealized_err = u_er
        if not u_er:
            unrealized_native = float(u_pn)
            holdings_floor_native = float(u_fl)
            holdings_nft_count = int(u_n)

    buy_n, sell_n, buy_wei, sell_wei = _aggregate_moralis_trades(wl, trades)
    est_buy = buy_wei / 1e18
    est_sell = sell_wei / 1e18
    mint_n, mint_wei = _aggregate_mints_from_transfers(wl, xfers)
    mint_spend = mint_wei / 1e18

    total_cost = est_buy + mint_spend
    net_t = est_sell - total_cost
    max_sell_w, max_buy_w = _moralis_single_trade_extremes(wl, trades)
    best_trade = max_sell_w / 1e18 if max_sell_w else None
    worst_trade = max_buy_w / 1e18 if max_buy_w else None
    if total_cost > 1e-18:
        pnl_percent = (net_t / total_cost) * 100.0
    else:
        pnl_percent = None

    max_rows_tr = trade_pages * moralis_limit
    max_rows_xf = xfer_pages * moralis_limit
    scope_note = (
        f"**{len(trades):,}** marketplace · **{len(xfers):,}** transfer rows · _{moralis_period_note}_"
    )
    if xfer_err:
        scope_note += f" _(Mints: transfer API error — {xfer_err})_"
    if hit_trade_cap and len(trades) >= max_rows_tr:
        scope_note += f" · trades cap **{max_rows_tr:,}**"
    if hit_xfer_cap and len(xfers) >= max_rows_xf:
        scope_note += f" · transfers cap **{max_rows_xf:,}**"

    try:
        tok_limit = max(12, min(100, int(os.getenv("VELOCR_TOKEN_GRID_LIMIT", "36"))))
    except ValueError:
        tok_limit = 36
    tokens = _aggregate_trades_by_token(wl, trades, symbol, limit=tok_limit)
    if tokens:
        key = _moralis_key()
        async with aiohttp.ClientSession() as session:
            await _enrich_tokens_with_collection_metadata(
                session,
                tokens,
                MORALIS_CHAIN[chain_key],
                key,
                chain_key=chain_key,
                concurrency=max(2, min(8, _env_int("VELOCR_MORALIS_ENRICH_CONCURRENCY", 6, 1, 12))),
            )
        for t in tokens:
            ci = (t.get("collection_image") or "").strip()
            iu = (t.get("image_url") or "").strip()
            if _is_generic_chain_icon_url(iu):
                t["image_url"] = ci if ci else ""

    return {
        "mode": "moralis_trades",
        "wallet": wallet_address,
        "wallet_name": wallet_name,
        "chain": chain_name,
        "symbol": symbol,
        "moralis_period_note": moralis_period_note,
        "bought_trades": buy_n,
        "sold_trades": sell_n,
        "est_buy_volume": est_buy,
        "est_sell_volume": est_sell,
        "mint_count": mint_n,
        "mint_spend": mint_spend,
        "net_trades": net_t,
        "unrealized_pnl_native": unrealized_native,
        "holdings_floor_native": holdings_floor_native,
        "holdings_nft_count": holdings_nft_count,
        "unrealized_error": unrealized_err,
        "pnl_percent": pnl_percent,
        "best_trade": best_trade,
        "worst_trade": worst_trade,
        "trades_rows": len(trades),
        "transfer_rows": len(xfers),
        "hit_row_cap": hit_trade_cap,
        "hit_transfer_cap": hit_xfer_cap,
        "xfer_fetch_error": xfer_err,
        "scope_note": scope_note,
        "tokens": tokens,
    }


async def get_wallet_pnl(
    wallet_address: str,
    chain: str = "eth",
    moralis_days: Optional[int] = None,
    include_nft_metadata: bool = False,
) -> Dict[str, Any]:
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address. Use a 0x-prefixed 40-hex EVM address."}

    chain_key = (chain or "eth").lower()
    meta = PNL_CHAIN_META.get(chain_key)
    if not meta:
        return {"error": "Invalid chain."}

    chain_name, symbol = meta
    moralis_chain = MORALIS_CHAIN.get(chain_key)
    if not moralis_chain:
        return {"error": "Invalid chain."}

    if not _moralis_key():
        return {"error": "Set **MORALIS_API_KEY** (e.g. in `.env`)."}

    try:
        moralis_limit = max(10, min(100, int(os.getenv("PNL_MORALIS_PAGE_LIMIT", "100"))))
    except ValueError:
        moralis_limit = 100
    moralis_max_pages = _env_int("PNL_MORALIS_MAX_PAGES", 15, 1, 200)

    wl = wallet_address.lower()
    moralis_period_q, moralis_period_note = _moralis_period_params(moralis_days)
    key = _moralis_key()
    unreal_pages = _env_int("VELOCR_UNREALIZED_NFT_PAGES", 3, 1, 20)

    skip_u = _truthy_env("VELOCR_SKIP_UNREALIZED")
    skip_os = _truthy_env("VELOCR_SKIP_OPENSEA")
    os_key = _opensea_key()

    async with aiohttp.ClientSession() as session:
        trade_coro = _fetch_moralis_wallet_trades(
            session,
            wl,
            moralis_chain,
            key,
            moralis_limit,
            moralis_max_pages,
            moralis_period_q,
            nft_metadata=include_nft_metadata,
        )
        xfer_coro = _fetch_moralis_nft_transfers(
            session,
            wl,
            moralis_chain,
            key,
            moralis_limit,
            moralis_max_pages,
            moralis_period_q,
            nft_metadata=False,
        )
        if skip_u:

            async def _no_unreal() -> Tuple[float, float, int, Optional[str]]:
                await asyncio.sleep(0)
                return (0.0, 0.0, 0, "skipped")

            unreal_coro = _no_unreal()
        else:
            unreal_coro = _fetch_wallet_nfts_unrealized(
                session,
                wallet_address,
                moralis_chain,
                key,
                moralis_limit,
                unreal_pages,
            )

        # Prefer Moralis resolve (ENS) name first; optional OpenSea fallback if provided.
        name_coro = _fetch_moralis_wallet_name(session, wallet_address, key)
        if os_key and not skip_os:
            os_coro = _fetch_opensea_wallet_name(session, wallet_address, os_key)
        else:

            async def _no_os() -> Tuple[Optional[str], Optional[str]]:
                await asyncio.sleep(0)
                return None, "skipped"

            os_coro = _no_os()

        (trades, hit_cap, api_err), (xfers, hit_xfer_cap, xfer_err), unreal_tuple, (moralis_name, _m_name_err), (os_name, _os_err) = await asyncio.gather(
            trade_coro,
            xfer_coro,
            unreal_coro,
            name_coro,
            os_coro,
        )
        wallet_name = moralis_name or os_name
    if api_err:
        return {"error": api_err}

    if skip_u:
        unreal_tuple = None

    return await _finalize_pnl_payload(
        wallet_address=wallet_address,
        chain_key=chain_key,
        chain_name=chain_name,
        symbol=symbol,
        wl=wl,
        wallet_name=wallet_name,
        trades=trades,
        xfers=xfers,
        hit_trade_cap=hit_cap,
        hit_xfer_cap=hit_xfer_cap,
        xfer_err=xfer_err,
        moralis_period_note=moralis_period_note,
        unreal_tuple=unreal_tuple,
        include_nft_metadata=include_nft_metadata,
        moralis_limit=moralis_limit,
        trade_pages=moralis_max_pages,
        xfer_pages=moralis_max_pages,
    )


async def get_wallet_dashboard_bundle(
    wallet_address: str,
    chain: str = "eth",
    moralis_days: Optional[int] = None,
    dashboard_trade_pages: Optional[int] = None,
    activity_max_pages: Optional[int] = None,
    include_nft_metadata: bool = False,
    enrich_trade_images: bool = True,
    skip_activity: bool = False,
) -> Dict[str, Any]:
    """
    Single dashboard load: **one** Moralis NFT-trades pagination (shared by PnL + trade list),
    plus transfers for mints, optional wallet-NFT unrealized, optional activity transfers.
    """
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address. Use a 0x-prefixed 40-hex EVM address."}

    chain_key = (chain or "eth").lower()
    meta = PNL_CHAIN_META.get(chain_key)
    if not meta:
        return {"error": "Invalid chain."}

    chain_name, symbol = meta
    moralis_chain = MORALIS_CHAIN.get(chain_key)
    if not moralis_chain:
        return {"error": "Invalid chain."}

    if not _moralis_key():
        return {"error": "Set **MORALIS_API_KEY** (e.g. in `.env`)."}

    moralis_limit = _env_int("PNL_MORALIS_PAGE_LIMIT", 100, 10, 100)
    pnl_xfer_pages = _env_int("PNL_MORALIS_MAX_PAGES", 15, 1, 200)
    list_pages_req = dashboard_trade_pages if dashboard_trade_pages is not None else _env_int("VELOCR_DASHBOARD_TRADE_PAGES", 4, 1, 50)
    effective_trade_pages = max(pnl_xfer_pages, list_pages_req)
    xfer_pages = _env_int("VELOCR_TRANSFER_MAX_PAGES", pnl_xfer_pages, 1, 200)
    act_pages = 0 if skip_activity else (activity_max_pages if activity_max_pages is not None else _env_int("VELOCR_DASHBOARD_ACTIVITY_PAGES", 2, 1, 8))

    cache_ttl = 0.0
    try:
        cache_ttl = float((os.getenv("VELOCR_API_CACHE_TTL_S", "45") or "0").strip() or 0)
    except ValueError:
        cache_ttl = 0.0
    cache_key = (
        f"{wallet_address.lower()}|{chain_key}|{moralis_days}|{effective_trade_pages}|{xfer_pages}|{act_pages}|"
        f"{int(include_nft_metadata)}|{int(enrich_trade_images)}|{int(skip_activity)}|"
        f"{int(_truthy_env('VELOCR_SKIP_UNREALIZED'))}|{int(_truthy_env('VELOCR_SKIP_TRADE_NFT_ENRICH'))}"
    )

    if cache_ttl > 0:
        async with _dashboard_bundle_lock:
            hit = _dashboard_bundle_cache.get(cache_key)
            if hit:
                exp, payload = hit
                if time.monotonic() < exp:
                    return dict(payload)
                _dashboard_bundle_cache.pop(cache_key, None)

    wl = wallet_address.lower()
    moralis_period_q, moralis_period_note = _moralis_period_params(moralis_days)
    key = _moralis_key()
    unreal_pages = _env_int("VELOCR_UNREALIZED_NFT_PAGES", 3, 1, 20)
    skip_u = _truthy_env("VELOCR_SKIP_UNREALIZED")
    skip_os = _truthy_env("VELOCR_SKIP_OPENSEA")
    os_key = _opensea_key()
    fetch_per_token = enrich_trade_images and not _truthy_env("VELOCR_SKIP_TRADE_NFT_ENRICH")

    async with aiohttp.ClientSession() as session:
        trade_coro = _fetch_moralis_wallet_trades(
            session,
            wl,
            moralis_chain,
            key,
            moralis_limit,
            effective_trade_pages,
            moralis_period_q,
            nft_metadata=include_nft_metadata,
        )
        xfer_coro = _fetch_moralis_nft_transfers(
            session,
            wl,
            moralis_chain,
            key,
            moralis_limit,
            xfer_pages,
            moralis_period_q,
            nft_metadata=False,
        )
        if skip_u:

            async def _no_unreal() -> Tuple[float, float, int, Optional[str]]:
                await asyncio.sleep(0)
                return (0.0, 0.0, 0, "skipped")

            unreal_coro = _no_unreal()
        else:
            unreal_coro = _fetch_wallet_nfts_unrealized(
                session,
                wallet_address,
                moralis_chain,
                key,
                moralis_limit,
                unreal_pages,
            )

        if act_pages <= 0:

            async def _no_act() -> Tuple[List[dict], bool, Optional[str]]:
                await asyncio.sleep(0)
                return [], False, None

            act_coro = _no_act()
        else:
            act_coro = _fetch_moralis_nft_transfers(
                session,
                wl,
                moralis_chain,
                key,
                moralis_limit,
                act_pages,
                moralis_period_q,
                nft_metadata=True,
            )

        name_coro = _fetch_moralis_wallet_name(session, wallet_address, key)
        if os_key and not skip_os:
            os_coro = _fetch_opensea_wallet_name(session, wallet_address, os_key)
        else:

            async def _no_os() -> Tuple[Optional[str], Optional[str]]:
                await asyncio.sleep(0)
                return None, "skipped"

            os_coro = _no_os()

        (trades, hit_cap, api_err), (xfers, hit_xfer_cap, xfer_err), unreal_tuple, (act_rows, act_hit, act_err), (moralis_name, _m_name_err), (os_name, _os_err) = await asyncio.gather(
            trade_coro,
            xfer_coro,
            unreal_coro,
            act_coro,
            name_coro,
            os_coro,
        )
        wallet_name = moralis_name or os_name

        if api_err:
            return {"error": api_err}

        if skip_u:
            unreal_tuple = None

        pnl = await _finalize_pnl_payload(
            wallet_address=wallet_address,
            chain_key=chain_key,
            chain_name=chain_name,
            symbol=symbol,
            wl=wl,
            wallet_name=wallet_name,
            trades=trades,
            xfers=xfers,
            hit_trade_cap=hit_cap,
            hit_xfer_cap=hit_xfer_cap,
            xfer_err=xfer_err,
            moralis_period_note=moralis_period_note,
            unreal_tuple=unreal_tuple,
            include_nft_metadata=include_nft_metadata,
            moralis_limit=moralis_limit,
            trade_pages=effective_trade_pages,
            xfer_pages=xfer_pages,
        )

        normalized = []
        for row in trades:
            if not isinstance(row, dict):
                continue
            n = _normalize_trade_row(row, wl, symbol)
            if n:
                pa = (n.get("price_token_address") or "").lower()
                pay_sym = None
                if pa:
                    pay_sym = _PAYMENT_TOKEN_SYMBOL_BY_CHAIN.get(chain_key, {}).get(pa)
                n["payment_symbol"] = pay_sym or symbol
                normalized.append(n)
        normalized.sort(key=lambda x: float(x.get("timestamp_unix") or 0), reverse=True)

        await _enrich_trade_rows_token_images(
            session,
            normalized,
            moralis_chain,
            key,
            chain_key,
            fetch_per_token=fetch_per_token,
        )
        await _enrich_trade_rows_collection_fields(
            session,
            normalized,
            moralis_chain,
            key,
            chain_key,
        )

    activities: List[Dict[str, Any]] = []
    if act_pages > 0 and not act_err:
        for row in act_rows:
            if not isinstance(row, dict):
                continue
            n = _normalize_transfer_activity(row, wl, symbol)
            if n:
                activities.append(n)
        activities.sort(key=lambda x: float(x.get("timestamp_unix") or 0), reverse=True)
        activities = activities[:100]

    out = {
        "pnl": pnl,
        "trades": {
            "wallet": wallet_address,
            "chain": chain_name,
            "symbol": symbol,
            "moralis_period_note": moralis_period_note,
            "trades": normalized,
            "raw_count": len(trades),
            "hit_row_cap": hit_cap,
        },
        "activity": {
            "wallet": wallet_address,
            "chain": chain_name,
            "symbol": symbol,
            "activities": activities,
            "raw_transfer_rows": len(act_rows) if act_pages > 0 else 0,
            "hit_row_cap": act_hit if act_pages > 0 else False,
            "fetch_error": act_err if act_pages > 0 else None,
        },
    }

    if cache_ttl > 0:
        async with _dashboard_bundle_lock:
            _dashboard_bundle_cache[cache_key] = (time.monotonic() + cache_ttl, dict(out))

    return out


def _row_timestamp_unix(row: dict) -> float:
    """Moralis may return ISO string, unix seconds, or millis."""
    v = row.get("block_timestamp")
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        x = float(v)
        return x / 1000.0 if x > 1e12 else x
    s = str(v).strip()
    if s.isdigit():
        x = int(s)
        return (x / 1000.0) if x > 1e12 else float(x)
    try:
        if s.endswith("Z"):
            s = s.replace("Z", "+00:00", 1)
        return datetime.fromisoformat(s).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _normalize_trade_row(row: dict, wallet_lower: str, chain_symbol: str) -> Optional[dict]:
    buyer = (row.get("buyer_address") or "").lower()
    seller = (row.get("seller_address") or "").lower()
    if wallet_lower not in (buyer, seller):
        return None
    try:
        price_wei = int(row.get("price") or 0)
    except (TypeError, ValueError):
        price_wei = 0
    side = "buy" if buyer == wallet_lower else "sell"
    tok_raw = row.get("token_address")
    tok = tok_raw if isinstance(tok_raw, str) else (str(tok_raw) if tok_raw else "")
    token_id = _first_token_id_from_row(row)
    tx = row.get("transaction_hash") or row.get("transactionHash") or row.get("hash") or ""
    mp = row.get("marketplace") or row.get("marketplace_address") or ""
    name = _nft_row_name(row, token_id)
    collection = row.get("token_address") or ""
    pay_addr = (row.get("price_token_address") or "").strip()
    pay_addr_l = pay_addr.lower() if isinstance(pay_addr, str) else ""

    return {
        "side": side,
        "price_eth": price_wei / 1e18,
        "price_wei": price_wei,
        "buyer_address": row.get("buyer_address") or "",
        "seller_address": row.get("seller_address") or "",
        "token_address": tok if isinstance(tok, str) else str(tok),
        "token_id": token_id,
        "token_name": name if isinstance(name, str) else "",
        "collection_name": "",
        "image_url": _safe_trade_row_image(row) or "",
        "transaction_hash": tx if isinstance(tx, str) else str(tx),
        "block_number": row.get("block_number"),
        "timestamp_unix": _row_timestamp_unix(row),
        "marketplace": mp if isinstance(mp, str) else str(mp),
        "chain_symbol": chain_symbol,
        "price_token_address": pay_addr,
        "payment_symbol": None,
        "collection": collection[:42] if collection else "",
    }


async def get_wallet_recent_trades(
    wallet_address: str,
    chain: str = "eth",
    moralis_days: Optional[int] = None,
    max_pages: Optional[int] = None,
    page_limit: Optional[int] = None,
    include_nft_metadata: bool = False,
) -> Dict[str, Any]:
    """
    Recent NFT marketplace trades for a wallet (newest first), for dashboards / live feeds.
    """
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address. Use a 0x-prefixed 40-hex EVM address."}

    chain_key = (chain or "eth").lower()
    meta = PNL_CHAIN_META.get(chain_key)
    if not meta:
        return {"error": "Invalid chain."}

    chain_name, symbol = meta
    moralis_chain = MORALIS_CHAIN.get(chain_key)
    if not moralis_chain:
        return {"error": "Invalid chain."}

    if not _moralis_key():
        return {"error": "Set **MORALIS_API_KEY** (e.g. in `.env`)."}

    try:
        lim = max(10, min(100, int(page_limit or os.getenv("PNL_MORALIS_PAGE_LIMIT", "100"))))
    except ValueError:
        lim = 100
    fp = max_pages if max_pages is not None else _env_int("VELOCR_FEED_MAX_PAGES", 2, 1, 50)
    pages = max(1, min(50, int(fp)))

    wl = wallet_address.lower()
    moralis_period_q, moralis_period_note = _moralis_period_params(moralis_days)
    key = _moralis_key()

    async with aiohttp.ClientSession() as session:
        trades, hit_cap, api_err = await _fetch_moralis_wallet_trades(
            session,
            wl,
            moralis_chain,
            key,
            lim,
            pages,
            moralis_period_q,
            nft_metadata=include_nft_metadata,
        )
        if api_err:
            return {"error": api_err}

        normalized = []
        for row in trades:
            if not isinstance(row, dict):
                continue
            n = _normalize_trade_row(row, wl, symbol)
            if n:
                pa = (n.get("price_token_address") or "").lower()
                pay_sym = None
                if pa:
                    pay_sym = _PAYMENT_TOKEN_SYMBOL_BY_CHAIN.get(chain_key, {}).get(pa)
                n["payment_symbol"] = pay_sym or symbol
                normalized.append(n)
        normalized.sort(key=lambda x: float(x.get("timestamp_unix") or 0), reverse=True)
        fetch_pt = not _truthy_env("VELOCR_SKIP_TRADE_NFT_ENRICH")
        await _enrich_trade_rows_token_images(
            session, normalized, moralis_chain, key, chain_key, fetch_per_token=fetch_pt
        )
        await _enrich_trade_rows_collection_fields(session, normalized, moralis_chain, key, chain_key)

    return {
        "wallet": wallet_address,
        "chain": chain_name,
        "symbol": symbol,
        "moralis_period_note": moralis_period_note,
        "trades": normalized,
        "raw_count": len(trades),
        "hit_row_cap": hit_cap,
    }


def _normalize_transfer_activity(
    row: dict,
    wallet_lower: str,
    chain_symbol: str,
) -> Optional[Dict[str, Any]]:
    """NFT transfer row when `nft_metadata=true` — mint / in / out relative to wallet."""
    from_a = (row.get("from_address") or "").lower()
    to_a = (row.get("to_address") or "").lower()
    z = ZERO_ADDR.lower()
    if to_a == wallet_lower and from_a == z:
        kind = "mint"
    elif to_a == wallet_lower:
        kind = "in"
    elif from_a == wallet_lower:
        kind = "out"
    else:
        return None

    tok_raw = row.get("token_address") or ""
    token_address = tok_raw if isinstance(tok_raw, str) else str(tok_raw)
    token_id = str(row.get("token_id") or "")
    name = row.get("name") or row.get("token_name") or ""
    nm = row.get("normalized_metadata")
    if isinstance(nm, dict):
        n2 = nm.get("name")
        if isinstance(n2, str) and n2.strip() and not (isinstance(name, str) and name.strip()):
            name = n2
    tx = row.get("transaction_hash") or row.get("transactionHash") or ""
    return {
        "kind": kind,
        "token_address": token_address,
        "token_id": token_id,
        "name": ((name if isinstance(name, str) else str(name)) or "")[:80],
        "image_url": _safe_trade_row_image(row) or "",
        "transaction_hash": tx if isinstance(tx, str) else str(tx),
        "timestamp_unix": _row_timestamp_unix(row),
        "chain_symbol": chain_symbol,
        "from_address": row.get("from_address") or "",
        "to_address": row.get("to_address") or "",
    }


async def get_wallet_nft_activity(
    wallet_address: str,
    chain: str = "eth",
    moralis_days: Optional[int] = None,
    max_pages: int = 3,
) -> Dict[str, Any]:
    """Recent NFT transfers (with images): mints, sends, receives — for activity feeds."""
    wallet_address = (wallet_address or "").strip()
    if not re.match(r"^0x[a-fA-F0-9]{40}$", wallet_address):
        return {"error": "Invalid wallet address. Use a 0x-prefixed 40-hex EVM address."}

    chain_key = (chain or "eth").lower()
    meta = PNL_CHAIN_META.get(chain_key)
    if not meta:
        return {"error": "Invalid chain."}

    chain_name, symbol = meta
    moralis_chain = MORALIS_CHAIN.get(chain_key)
    if not moralis_chain:
        return {"error": "Invalid chain."}

    if not _moralis_key():
        return {"error": "Set **MORALIS_API_KEY** (e.g. in `.env`)."}

    try:
        lim = max(10, min(100, int(os.getenv("PNL_MORALIS_PAGE_LIMIT", "100"))))
    except ValueError:
        lim = 100
    try:
        pages = max(1, min(8, int(max_pages)))
    except (TypeError, ValueError):
        pages = 3

    wl = wallet_address.lower()
    moralis_period_q, moralis_period_note = _moralis_period_params(moralis_days)
    key = _moralis_key()

    async with aiohttp.ClientSession() as session:
        rows, hit_cap, err = await _fetch_moralis_nft_transfers(
            session,
            wl,
            moralis_chain,
            key,
            lim,
            pages,
            moralis_period_q,
            nft_metadata=True,
        )
    if err:
        return {"error": err}

    activities: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        n = _normalize_transfer_activity(row, wl, symbol)
        if n:
            activities.append(n)

    activities.sort(key=lambda x: float(x.get("timestamp_unix") or 0), reverse=True)

    return {
        "wallet": wallet_address,
        "chain": chain_name,
        "symbol": symbol,
        "moralis_period_note": moralis_period_note,
        "activities": activities[:100],
        "raw_transfer_rows": len(rows),
        "hit_row_cap": hit_cap,
    }


def _parse_watch_wallets_env() -> List[str]:
    raw = (os.getenv("VELOCR_FEED_WALLETS") or "").strip()
    if not raw:
        return []
    out: List[str] = []
    for part in raw.split(","):
        w = part.strip()
        if re.match(r"^0x[a-fA-F0-9]{40}$", w):
            out.append(w)
    return out[:25]


async def get_watchlist_nft_feed(
    chain: str = "eth",
    moralis_days: Optional[int] = None,
    per_wallet_max_pages: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Merge recent trades from `VELOCR_FEED_WALLETS` (comma-separated 0x addresses).
    """
    addrs = _parse_watch_wallets_env()
    if not addrs:
        return {
            "chain": PNL_CHAIN_META.get((chain or "eth").lower(), ("Ethereum", "ETH"))[0],
            "trades": [],
            "wallets": [],
            "note": "Set **VELOCR_FEED_WALLETS** in the environment for a global feed.",
        }

    try:
        pw = max(1, min(10, int(per_wallet_max_pages or os.getenv("VELOCR_FEED_PER_WALLET_PAGES", "2"))))
    except ValueError:
        pw = 2

    results = await asyncio.gather(
        *[get_wallet_recent_trades(a, chain, moralis_days=moralis_days, max_pages=pw) for a in addrs],
        return_exceptions=True,
    )

    merged: List[dict] = []
    errors: List[str] = []
    for addr, res in zip(addrs, results):
        if isinstance(res, Exception):
            errors.append(f"{addr[:10]}…: {res}")
            continue
        if isinstance(res, dict) and res.get("error"):
            errors.append(f"{addr[:10]}…: {res['error']}")
            continue
        if not isinstance(res, dict):
            continue
        for t in res.get("trades") or []:
            if isinstance(t, dict):
                tw = dict(t)
                tw["watched_wallet"] = addr
                merged.append(tw)

    merged.sort(key=lambda x: float(x.get("timestamp_unix") or 0), reverse=True)

    ck = (chain or "eth").lower()
    chain_name = PNL_CHAIN_META.get(ck, ("Ethereum", "ETH"))[0]

    return {
        "chain": chain_name,
        "wallets": addrs,
        "trades": merged[:200],
        "errors": errors or None,
    }
