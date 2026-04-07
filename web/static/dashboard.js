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
  if (x === 0) return "—";
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
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function syncPillActive(days) {
  $$(".dash-pill").forEach((btn) => {
    const d = parseInt(btn.dataset.days, 10);
    btn.classList.toggle("is-active", d === days);
  });
}

function updateUrl(wallet, chain, days) {
  const q = new URLSearchParams({ wallet, chain, days: String(days) });
  window.history.replaceState({}, "", `/dashboard?${q.toString()}`);
}

function saveLocalActivity(pnl, chain, days) {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const arr = Array.isArray(list) ? list : [];
    const entry = {
      wallet: pnl.wallet,
      chain,
      days,
      net_trades: pnl.net_trades,
      symbol: pnl.symbol,
      trades_rows: pnl.trades_rows,
      at: Date.now(),
    };
    const next = arr.filter(
      (x) =>
        !(x.wallet?.toLowerCase() === entry.wallet?.toLowerCase() && x.chain === chain && x.days === days),
    );
    next.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, 25)));
  } catch (_) {}
}

function fmtStatEth(n, sym) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${formatEth(n)} ${sym}`;
}

function syncTradesPanelHeight() {
  const stats = $(".dash-card-stats");
  const trades = $(".dash-card-trades");
  if (!stats || !trades) return;
  if (window.innerWidth < DASH_TWO_COL_MIN_PX) {
    trades.style.maxHeight = "";
    return;
  }
  trades.style.maxHeight = `${stats.offsetHeight}px`;
}

function ensureStatsTradesHeightSync() {
  const stats = $(".dash-card-stats");
  if (!stats || statsResizeObs) return;
  statsResizeObs = new ResizeObserver(() => syncTradesPanelHeight());
  statsResizeObs.observe(stats);
  window.addEventListener("resize", syncTradesPanelHeight);
}

function scheduleTradesHeightSync() {
  requestAnimationFrame(() => {
    syncTradesPanelHeight();
    requestAnimationFrame(syncTradesPanelHeight);
  });
}

function renderStats(pnl) {
  const sym = pnl.symbol || "ETH";
  const pct =
    typeof pnl.pnl_percent === "number"
      ? `${pnl.pnl_percent.toFixed(1)}%`
      : "N/A";
  const unreal =
    typeof pnl.unrealized_pnl_native === "number" && !pnl.unrealized_error
      ? `${formatEth(pnl.unrealized_pnl_native)} ${sym}`
      : "—";
  const rows = [
    ["Net", `${formatEth(pnl.net_trades)} ${sym} (${pct})`],
    ["Unrealized PnL (est.)", unreal],
    ["Sell volume", `${formatEth(pnl.est_sell_volume)} ${sym}`],
    ["Buy volume", `${formatEth(pnl.est_buy_volume)} ${sym}`],
    ["Mint spend (est.)", `${formatEth(pnl.mint_spend)} ${sym}`],
    ["Buys", String(pnl.bought_trades ?? 0)],
    ["Sells", String(pnl.sold_trades ?? 0)],
    [
      "Total trades",
      String((pnl.bought_trades ?? 0) + (pnl.sold_trades ?? 0)),
    ],
    ["Best trade", fmtStatEth(pnl.best_trade, sym)],
    ["Worst trade", fmtStatEth(pnl.worst_trade, sym)],
  ];
  $("#dash-stats").innerHTML = rows
    .map(
      ([k, v]) => `<div class="dash-stat-row"><dt>${k}</dt><dd>${v}</dd></div>`,
    )
    .join("");
}

function renderTradeList(trades, listEl, chain, symbol) {
  if (!listEl) return;
  if (!trades?.length) {
    listEl.innerHTML =
      '<li class="trade-item placeholder">No trades in this window.</li>';
    return;
  }
  listEl.innerHTML = "";
  for (const t of trades) {
    const li = document.createElement("li");
    li.className = "trade-item trade-item--dash";
    const name = t.token_name?.trim()
      ? t.token_name
      : (t.token_id ? `#${t.token_id}` : shortAddr(t.token_address));
    const tx = t.transaction_hash
      ? `<a href="${etherscanTx(t.transaction_hash, chain)}" target="_blank" rel="noopener">tx</a>`
      : "—";
    const ts = t.timestamp_unix ? relTime(t.timestamp_unix) : "—";
    const paySym = t.payment_symbol || symbol || t.chain_symbol || "ETH";
    const sideLabel = String(t.side || "").toUpperCase();
    li.innerHTML = `
      ${imgAvatar(t.image_url)}
      <span class="side-badge ${t.side}">${sideLabel}</span>
      <div class="trade-body">
        <div class="title">${name}</div>
        <div class="meta">${shortAddr(t.token_address)} · ${tx}</div>
      </div>
      <div class="trade-price">
        <div class="eth">${formatEth(t.price_eth)} ${paySym}</div>
        <div class="when">${ts}</div>
      </div>`;
    listEl.appendChild(li);
  }
}

function renderTrades(trades, chain, symbol) {
  const merged = [...(trades || [])].sort(
    (a, b) => (b.timestamp_unix || 0) - (a.timestamp_unix || 0),
  );
  renderTradeList(merged, $("#dash-trade-list"), chain, symbol);
}

function renderTokens(tokens, symbol, activityByToken, chain) {
  const grid = $("#dash-token-grid");
  if (!tokens?.length) {
    grid.innerHTML =
      '<p class="muted token-empty">No per-collection data — marketplace rows may be empty for this range.</p>';
    $("#dash-token-summary").textContent = "";
    return;
  }
  const positive = tokens.filter((t) => (t.net_native || 0) > 0).length;
  $("#dash-token-summary").textContent = `${tokens.length} collections · ${symbol}`;
  grid.innerHTML = tokens
    .map((t) => {
      const net = Number(t.net_native);
      const cls = net >= 0 ? "pos" : "neg";
      let displayName =
        t.collection_name?.trim() ||
        t.token_name?.trim() ||
        shortAddr(t.token_address);
      if (isPaymentTokenLabel(displayName)) {
        displayName = shortAddr(t.token_address);
      }
      const img =
        t.collection_image ||
        t.image_url;
      const buyCount = Number(t.buy_count || 0);
      const sellCount = Number(t.sell_count || 0);
      const buyAvg = buyCount > 0 ? Number(t.buy_volume || 0) / buyCount : 0;
      const sellAvg = sellCount > 0 ? Number(t.sell_volume || 0) / sellCount : 0;
      const roi =
        Number(t.buy_volume || 0) > 0
          ? (net / Number(t.buy_volume || 0)) * 100
          : null;

      const acts = activityByToken?.get(tokenKey(t.token_address)) || [];
      const actHtml = acts.slice(0, 3).map((a) => {
        const title = a.name?.trim() || (a.token_id ? `#${a.token_id}` : shortAddr(a.token_address));
        const when = a.timestamp_unix ? relTime(a.timestamp_unix) : "—";
        const tx = a.transaction_hash
          ? `<a href="${etherscanTx(a.transaction_hash, chain)}" target="_blank" rel="noopener">tx</a>`
          : "—";
        return `<div class="tok-act-row">
          <span class="tok-act-kind ${safeText(a.kind)}">${kindLabel(a.kind)}</span>
          <span class="tok-act-title">${safeText(title)}</span>
          <span class="tok-act-when">${safeText(when)}</span>
          <span class="tok-act-tx mono">${tx}</span>
        </div>`;
      }).join("");

      return `<article class="dash-token-card">
        <div class="dash-tok-row1">
          ${imgAvatar(img)}
          <div class="dash-tok-head">
            <span class="dash-tok-name">${displayName}</span>
            <span class="dash-tok-net ${cls}">${net >= 0 ? "+" : ""}${formatEth(net)} ${symbol}</span>
          </div>
        </div>
        <div class="dash-tok-sub mono">${shortAddr(t.token_address)}</div>
        <div class="dash-tok-rows">
          <span class="tok-buy">Avg buy ${formatEth(buyAvg)} (${buyCount}) · Total ${formatEth(t.buy_volume)}</span>
          <span class="tok-sell">Avg sell ${formatEth(sellAvg)} (${sellCount}) · Total ${formatEth(t.sell_volume)}</span>
          <span class="tok-roi mono">${roi == null ? "ROI —" : `ROI ${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`}</span>
        </div>
        <div class="tok-activity">
          ${actHtml || '<div class="tok-act-empty muted">No recent transfers for this collection in this window.</div>'}
        </div>
      </article>`;
    })
    .join("");
}

function renderNftActivity(activities, chain) {
  const grid = $("#dash-activity-grid");
  const meta = $("#dash-activity-meta");
  if (!activities?.length) {
    grid.innerHTML =
      '<p class="muted token-empty">No NFT transfers in this window.</p>';
    meta.textContent = "";
    return;
  }
  meta.textContent = `${activities.length} events`;
  grid.innerHTML = activities
    .map((a) => {
      const title =
        a.name?.trim() ||
        (a.token_id ? `#${a.token_id}` : shortAddr(a.token_address));
      const tx = a.transaction_hash
        ? `<a href="${etherscanTx(a.transaction_hash, chain)}" target="_blank" rel="noopener">tx</a>`
        : "—";
      const when = a.timestamp_unix ? relTime(a.timestamp_unix) : "—";
      return `<article class="dash-activity-card">
        ${imgAvatar(a.image_url)}
        <div class="dash-act-main">
          <div class="dash-act-top">
            <span class="dash-act-kind ${a.kind}">${kindLabel(a.kind)}</span>
            <span class="dash-act-name">${title}</span>
            <span class="dash-act-when">${when}</span>
          </div>
          <div class="dash-act-meta mono">${shortAddr(a.token_address)} · ${tx}</div>
        </div>
      </article>`;
    })
    .join("");
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

  $("#dash-wallet").textContent = wallet;
  const wn = $("#dash-wallet-name");
  if (wn) {
    wn.hidden = true;
    wn.textContent = "";
  }
  $("#dash-chain-pill").textContent = chain.toUpperCase();
  syncPillActive(days);

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
        wn.hidden = false;
      } else {
        wn.hidden = true;
        wn.textContent = "";
      }
    }
    const tradesData = dash.trades;
    const activityData = dash.activity;

    renderStats(pnl);
    renderTrades(tradesData.trades, chain, pnl.symbol);
    const activityByToken = groupActivitiesByToken(activityData.activities);
    renderTokens(pnl.tokens, pnl.symbol, activityByToken, chain);
    saveLocalActivity(pnl, chain, days);
    setLoading(false);
    scheduleTradesHeightSync();
  } catch (e) {
    setError(e.message || String(e));
    $("#dash-stats").innerHTML = "";
    const tl = $("#dash-trade-list");
    if (tl) tl.innerHTML = "";
    const tradesCard = $(".dash-card-trades");
    if (tradesCard) tradesCard.style.maxHeight = "";
    $("#dash-token-grid").innerHTML = "";
    $("#dash-token-summary").textContent = "";
    setLoading(false);
  }
}

function initPills() {
  $$(".dash-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = parseInt(btn.dataset.days, 10);
      const { wallet, chain } = getParams();
      if (!wallet) return;
      updateUrl(wallet, chain, d);
      loadAll();
    });

  });
}

document.addEventListener("DOMContentLoaded", () => {
  ensureStatsTradesHeightSync();
  initPills();
  loadAll();
});
