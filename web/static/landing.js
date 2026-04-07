const STORAGE_KEY = "velocr_search_activity";
const MAX_ITEMS = 25;

function $(sel) {
  return document.querySelector(sel);
}

function shortAddr(a) {
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function loadActivity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveActivity(entry) {
  const list = loadActivity().filter(
    (x) =>
      !(
        x.wallet?.toLowerCase() === entry.wallet?.toLowerCase() &&
        x.chain === entry.chain &&
        Number(x.days) === Number(entry.days)
      ),
  );
  list.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
}

function formatTradeProfit(v, sym) {
  if (v === undefined || v === null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(4)} ${sym}`;
}

function daysLabel(d) {
  if (d === 0 || d === "0") return "all time";
  return `${d} days`;
}

function renderActivity() {
  const ul = $("#activity-list");
  const items = loadActivity();
  if (!items.length) {
    ul.innerHTML =
      '<li class="kol-activity-empty kol-activity-empty--full">No dossiers yet. Open the dashboard from a wallet search — top / worst trades and row counts are saved here for that window.</li>';
    return;
  }
  const shown = items.slice(0, 6);
  ul.innerHTML = shown
    .map((x) => {
      const sym = x.symbol || "ETH";
      const best = x.best_trade_profit;
      const worst = x.worst_trade_profit;
      const bestStr = formatTradeProfit(best, sym);
      const worstStr = formatTradeProfit(worst, sym);
      const bestCls =
        best === undefined || best === null || !Number.isFinite(Number(best))
          ? ""
          : Number(best) >= 0
            ? " pos"
            : " neg";
      const worstCls =
        worst === undefined || worst === null || !Number.isFinite(Number(worst))
          ? ""
          : Number(worst) >= 0
            ? " pos"
            : " neg";
      const rows = x.trades_rows != null ? `${x.trades_rows} mkt rows` : "";
      const q = new URLSearchParams({
        wallet: x.wallet,
        chain: x.chain || "eth",
        days: String(x.days ?? 90),
      });
      return `<li class="kol-activity-item">
        <a class="kol-activity-link" href="/dashboard?${q.toString()}">
          <span class="kol-act-cell kol-act-wallet" title="${x.wallet}">${shortAddr(x.wallet)}</span>
          <span class="kol-act-cell kol-act-chain">${(x.chain || "eth").toUpperCase()}</span>
          <span class="kol-act-cell kol-act-range">${daysLabel(x.days)}</span>
          <span class="kol-act-cell kol-act-top${bestCls}">${bestStr}</span>
          <span class="kol-act-cell kol-act-worst${worstCls}">${worstStr}</span>
          <span class="kol-act-cell kol-act-meta">${rows || "—"}</span>
        </a>
      </li>`;
    })
    .join("");
}

function initForm() {
  const form = $("#landing-form");
  const input = $("#landing-wallet");
  const chain = $("#landing-chain");
  const range = $("#landing-range");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const wallet = input.value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      alert("Enter a valid 0x wallet (42 characters).");
      return;
    }
    const q = new URLSearchParams({
      wallet,
      chain: chain.value,
      days: range.value,
    });
    window.location.href = `/dashboard?${q.toString()}`;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderActivity();
  initForm();
});
