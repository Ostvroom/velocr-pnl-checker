"""
Velcor web dashboard: NFT trades on EVM (Ethereum-first), Moralis-backed.
Run: `uvicorn velocr_pnl.web_app:app --reload --host 127.0.0.1 --port 8080`
"""
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

import aiohttp
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
# Always load project-root `.env` (not only cwd — uvicorn may start elsewhere).
# utf-8-sig strips a UTF-8 BOM so `MORALIS_API_KEY` is not read as `\ufeffMORALIS_…`.
load_dotenv(ROOT / ".env", encoding="utf-8-sig")
load_dotenv(encoding="utf-8-sig")

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from velocr_pnl.core import (
    get_wallet_dashboard_bundle,
    get_wallet_nft_activity,
    get_wallet_pnl,
    get_wallet_recent_trades,
    get_watchlist_nft_feed,
)
WEB_ROOT = ROOT / "web"
STATIC = WEB_ROOT / "static"
# Avoid stale branding/HTML when `web/index.html` changes (browser disk cache).
_HTML_NO_CACHE = {"Cache-Control": "no-store, max-age=0, must-revalidate"}

app = FastAPI(title="Velcor NFT Monitor", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/favicon.ico")
async def favicon() -> Response:
    # Avoid 404 spam in logs; optionally add a real icon later.
    return Response(status_code=204)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "service": "velcor-nft"}


_IMG_PROXY_MAX_BYTES = 2_500_000


def _allowed_image_proxy_url(url: str) -> bool:
    """HTTPS allowlist — avoids SSRF while fetching NFT/CDN art for `<img>`."""
    try:
        p = urlparse(url.strip())
    except (ValueError, TypeError):
        return False
    if p.scheme != "https":
        return False
    host = (p.hostname or "").lower()
    if not host:
        return False
    if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
        return False
    if host.endswith(".moralis.io"):
        return True
    if host == "ipfs.io" or host.endswith(".ipfs.io"):
        return True
    suffixes = (
        ".dweb.link",
        ".ipfs.dweb.link",
        ".nftstorage.link",
        ".pinata.cloud",
    )
    if any(host.endswith(s) for s in suffixes):
        return True
    if host in (
        "cloudflare-ipfs.com",
        "gateway.pinata.cloud",
        "w3s.link",
        "nftstorage.link",
        "i.seadn.io",
        "openseauserdata.com",
    ):
        return True
    # OpenSea image CDN (e.g. i.seadn.io, i2c.seadn.io — collection + NFT renders)
    if host.endswith(".seadn.io"):
        return True
    if host.endswith(".lh3.googleusercontent.com"):
        return True
    if host.endswith(".arweave.net"):
        return True
    return False


@app.get("/api/img-proxy")
async def img_proxy(url: str = Query(..., min_length=12, max_length=4096)) -> Response:
    raw = unquote(url).strip()
    if not _allowed_image_proxy_url(raw):
        raise HTTPException(status_code=400, detail="Image URL not allowed.")
    headers = {
        "User-Agent": "VelcorDashboard/1.0 (image-proxy)",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
    }
    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(raw, headers=headers, allow_redirects=True, ssl=True) as r:
                if r.status != 200:
                    raise HTTPException(status_code=502, detail="Image upstream error.")
                body = await r.read()
                ct = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Image fetch failed.") from None
    if len(body) > _IMG_PROXY_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large.")
    if ct not in {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}:
        if "svg" in raw.lower() or body[:5] == b"<?xml" or body[:4] == b"<svg":
            ct = "image/svg+xml"
        elif body[:8] == b"\x89PNG\r\n\x1a\n":
            ct = "image/png"
        elif body[:3] == b"\xff\xd8\xff":
            ct = "image/jpeg"
        elif body[:4] == b"RIFF" and body[8:12] == b"WEBP":
            ct = "image/webp"
        elif body[:6] in (b"GIF87a", b"GIF89a"):
            ct = "image/gif"
        else:
            ct = "image/jpeg"
    return Response(content=body, media_type=ct)


@app.get("/api/dashboard/{address}")
async def api_dashboard(
    address: str,
    chain: str = Query("eth"),
    days: Optional[int] = Query(
        None,
        ge=0,
        le=3650,
        description="Rolling window days; 0 = all time (high CU).",
    ),
    trade_pages: Optional[int] = Query(
        None,
        ge=1,
        le=50,
        description="NFT marketplace trade pages for list (merged with PnL trade fetch).",
    ),
    activity_pages: Optional[int] = Query(
        None,
        ge=0,
        le=8,
        description="NFT transfer pages for collection activity; 0 = skip (saves CU).",
    ),
    metadata: bool = Query(
        False,
        description="Rich metadata on trade rows from Moralis (higher CU).",
    ),
    enrich_images: bool = Query(
        True,
        description="Per-token + collection image enrichment (high CU; set false to only collection logos).",
    ),
    skip_activity: bool = Query(False, description="If true, do not fetch transfer feed."),
) -> dict:
    """
    **Lower CU than** calling `/api/pnl` + `/api/trades` separately: one shared NFT-trades pagination.
    """
    data = await get_wallet_dashboard_bundle(
        address,
        chain,
        moralis_days=days,
        dashboard_trade_pages=trade_pages,
        activity_max_pages=activity_pages,
        include_nft_metadata=metadata,
        enrich_trade_images=enrich_images,
        skip_activity=skip_activity,
    )
    if data.get("error"):
        raise HTTPException(status_code=400, detail=str(data["error"]))
    return data


@app.get("/api/pnl/{address}")
async def api_pnl(
    address: str,
    chain: str = Query("eth", description="eth | polygon | base | arbitrum | optimism"),
    days: Optional[int] = Query(
        None,
        ge=0,
        le=3650,
        description="Last N days; omit for .env PNL_MORALIS_DAYS",
    ),
    metadata: bool = Query(
        False,
        description="Request NFT metadata (images) in trade rows — higher Moralis CU.",
    ),
) -> dict:
    data = await get_wallet_pnl(
        address,
        chain,
        moralis_days=days,
        include_nft_metadata=metadata,
    )
    if data.get("error"):
        raise HTTPException(status_code=400, detail=str(data["error"]))
    return data


@app.get("/api/trades/{address}")
async def api_trades(
    address: str,
    chain: str = Query("eth"),
    days: Optional[int] = Query(None, ge=0, le=3650),
    max_pages: Optional[int] = Query(None, ge=1, le=50),
    metadata: bool = Query(False, description="Include NFT images in results."),
) -> dict:
    data = await get_wallet_recent_trades(
        address,
        chain,
        moralis_days=days,
        max_pages=max_pages,
        include_nft_metadata=metadata,
    )
    if data.get("error"):
        raise HTTPException(status_code=400, detail=str(data["error"]))
    return data


@app.get("/api/activity/{address}")
async def api_activity(
    address: str,
    chain: str = Query("eth"),
    days: Optional[int] = Query(None, ge=0, le=3650),
    max_pages: Optional[int] = Query(3, ge=1, le=8),
) -> dict:
    data = await get_wallet_nft_activity(
        address,
        chain,
        moralis_days=days,
        max_pages=max_pages or 3,
    )
    if data.get("error"):
        raise HTTPException(status_code=400, detail=str(data["error"]))
    return data


@app.get("/api/feed")
async def api_feed(
    chain: str = Query("eth"),
    days: Optional[int] = Query(7, ge=0, le=3650),
) -> dict:
    return await get_watchlist_nft_feed(chain=chain, moralis_days=days)


if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/")
async def index() -> FileResponse:
    index_path = WEB_ROOT / "index.html"
    if not index_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Frontend missing: web/index.html",
        )
    return FileResponse(index_path, headers=dict(_HTML_NO_CACHE))


@app.get("/dashboard")
async def dashboard_page() -> FileResponse:
    path = WEB_ROOT / "dashboard.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Frontend missing: web/dashboard.html")
    return FileResponse(path, headers=dict(_HTML_NO_CACHE))
