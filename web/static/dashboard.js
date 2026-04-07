const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const STORAGE_KEY = "velocr_search_activity";
/** Same breakpoint as `styles.css` .dash-row-2 two-column layout */
const DASH_TWO_COL_MIN_PX = 900;

let statsResizeObs = null;

function setLoading(on) {
  const el = $("#dash-loading");
  if (!el) return;
  el.classList.toggle("is-hidden", !on);
  el.setAttribute("aria-busy", on ? "true" : "false");
}

function shortAddr(a) {
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatEth(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  if (Math.abs(x) < 0.0001) return x.toExponential(2);
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function relTime(ts) {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function imgProxySrc(url) {
  if (!url || typeof url !== "string") return "";
  const t = url.trim().replace(/"/g, "").replace(/</g, "");
  if (!t) return "";
  if (t.startsWith("/api/")) return t;
  if (!/^https:\/\//i.test(t)) return t;
  return `/api/img-proxy?url=${encodeURIComponent(t)}`;
}

function imgAvatar(url) {
  if (!url || typeof url !== "string")
    return '<div class="nft-avatar nft-avatar--ph" aria-hidden="true">◆</div>';
  const src = imgProxySrc(url);
  if (!src)
    return '<div class="nft-avatar nft-avatar--ph" aria-hidden="true">◆</div>';
  return `<img class="nft-avatar" src="${src}" alt="" loading="lazy" decoding="async" crossorigin="anonymous" />`;
}

function kindLabel(k) {
  if (k === "mint") return "Mint";
  if (k === "in") return "In";
  if (k === "out") return "Out";
  return k || "—";
}

function safeText(s) {
  return String(s || "").replace(/</g, "").replace(/"/g, "");
}

function isPaymentTokenLabel(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim().toLowerCase();
  const bad = new Set([
    "ether",
    "ethereum",
    "eth",
    "wrapped ether",
    "wrapped eth",
    "weth",
    "matic",
    "wmatic",
    "pol",
    "bnb",
    "avax",
  ]);
  return bad.has(t) || (t.startsWith("wrapped ") && t.length < 40);
}

function tradeRowTitle(t) {
  const coll = t.collection_name?.trim();
  if (coll && t.token_id) return `${coll} · #${t.token_id}`;
  if (coll) return coll;
  const n = t.token_name?.trim();
  if (n && !isPaymentTokenLabel(n)) return n;
  return t.token_id ? `#${t.token_id}` : shortAddr(t.token_address);
}

function tokenKey(addr) {
  return String(addr || "").toLowerCase();
}

function groupActivitiesByToken(activities) {
  const map = new Map();
  for (const a of activities || []) {
    const k = tokenKey(a.token_address);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((x, y) => (y.timestamp_unix || 0) - (x.timestamp_unix || 0));
    map.set(k, arr);
  }
  return map;
}

function etherscanTx(hash, chain) {
  const hosts = {
    eth: "etherscan.io",
    base: "basescan.org",
    polygon: "polygonscan.com",
    arbitrum: "arbiscan.io",
    optimism: "optimistic.etherscan.io",
  };
  const h = hosts[chain] || hosts.eth;
  return `https://${h}/tx/${hash}`;
}

function getParams() {
  const q = new URLSearchParams(window.location.search);
  const wallet = (q.get("wallet") || "").trim();
  const chain = (q.get("chain") || "eth").toLowerCase();
  let days = q.get("days");
  if (days === null || days === "") days = "90";
  const d = parseInt(days, 10);
  const daysNorm = Number.isFinite(d) && d >= 0 ? d : 90;
  return { wallet, chain, days: daysNorm };
}

function saveSearchActivity(entry) {
  const MAX_ITEMS = 25;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const arr = Array.isArray(list) ? list : [];
    const next = arr.filter(
      (x) =>
        !(
          x.wallet?.toLowerCase() === entry.wallet?.toLowerCase() &&
          x.chain === entry.chain &&
          Number(x.days) === Number(entry.days)
        ),
    );
    next.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, MAX_ITEMS)));
  } catch {
    /* ignore quota / private mode */
  }
}

function daysQuery(d) {
  if (d === 0) return "days=0";
  return `days=${encodeURIComponent(d)}`;
}

async function fetchJson(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.detail || data.message || r.statusText || "Request failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function setError(msg) {
  const el = $("#dash-error");
  if (!msg) {
    if (el) el.hidden = true;
    if (el) el.textContent = "";
    return;
  }
  if (el) {
    el.hidden = false;
    el.textContent = msg;
  }
}


function renderTradeBox(boxPrefix, trade, symbol, chain) {
  const box = $(`#box-${boxPrefix}`);
  if (!trade) {
    box.classList.add("is-empty");
    return;
  }
  box.classList.remove("is-empty");

  const isPos = trade.profit >= 0;
  $(`#val-${boxPrefix}-roi`).textContent = `${isPos ? "+" : ""}${trade.roi.toFixed(1)}%`;
  $(`#val-${boxPrefix}-roi`).className = `trade-box-roi ${isPos ? "pos" : "neg"}`;
  
  $(`#img-${boxPrefix}`).innerHTML = imgAvatar(trade.image_url);
  
  $(`#val-${boxPrefix}-profit`).textContent = `${isPos ? "+" : ""}${formatEth(trade.profit)} ${symbol}`;
  $(`#val-${boxPrefix}-profit`).className = `trade-profit ${isPos ? "pos" : "neg"}`;
  
  const name = trade.collection_name || trade.contract_addr;
  $(`#val-${boxPrefix}-name`).textContent = `${name} #${trade.token_id}`;
  
  $(`#val-${boxPrefix}-buy`).textContent = `${formatEth(trade.buy_price)} ${symbol}`;
  $(`#val-${boxPrefix}-sell`).textContent = `${formatEth(trade.sell_price)} ${symbol}`;
  
  $(`#ts-${boxPrefix}-buy`).innerHTML = `<a href="${etherscanTx(trade.buy_tx, chain)}" target="_blank">${relTime(trade.buy_ts)}</a>`;
  $(`#ts-${boxPrefix}-sell`).innerHTML = `<a href="${etherscanTx(trade.sell_tx, chain)}" target="_blank">${relTime(trade.sell_ts)}</a>`;
}

async function loadAll() {
  const { wallet, chain, days } = getParams();
  setError("");
  setLoading(true);

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    setError("Invalid or missing wallet. Go home and enter a 0x address.");
    setLoading(false);
    return;
  }

  $("#dash-wallet").textContent = shortAddr(wallet);
  const wn = $("#dash-wallet-name");
  wn.textContent = "—";
  $("#dash-chain-pill").textContent = chain.toUpperCase();

  try {
    const qc = `chain=${encodeURIComponent(chain)}&${daysQuery(days)}`;
    const dash = await fetchJson(
      `/api/dashboard/${encodeURIComponent(wallet)}?${qc}&metadata=false&enrich_images=true`,
    );
    const pnl = dash.pnl;
    
    if (wn) {
      const name = pnl?.wallet_name;
      if (typeof name === "string" && name.trim()) {
        wn.textContent = name.trim();
        $("#dash-avatar-wrapper").innerHTML = imgAvatar(pnl.wallet_avatar);
      } else {
        wn.textContent = "Anonymous Tracker";
      }
    }

    $("#val-total-trades").textContent = String(pnl.total_completed_trades || 0);

    renderTradeBox("best", pnl.best_trade, pnl.symbol || "ETH", chain);
    renderTradeBox("worst", pnl.worst_trade, pnl.symbol || "ETH", chain);

    const sym = pnl.symbol || "ETH";
    saveSearchActivity({
      wallet,
      chain,
      days,
      symbol: sym,
      trades_rows: pnl.total_completed_trades ?? 0,
      best_trade_profit: pnl.best_trade?.profit,
      worst_trade_profit: pnl.worst_trade?.profit,
    });

    setLoading(false);
  } catch (e) {
    setError(e.message || String(e));
    setLoading(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAll();
});
