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
      !(x.wallet?.toLowerCase() === entry.wallet?.toLowerCase() && x.chain === entry.chain && x.days === entry.days),
  );
  list.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
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
      '<li class="kol-activity-empty">No searches yet. Enter a wallet above to open the dashboard.</li>';
    return;
  }
  ul.innerHTML = items
    .map((x) => {
      const net = Number(x.net_trades);
      const netStr = Number.isFinite(net)
        ? `${net >= 0 ? "+" : ""}${net.toFixed(4)} ${x.symbol || "ETH"}`
        : "—";
      const rows = x.trades_rows != null ? `${x.trades_rows} mkt rows` : "";
      const q = new URLSearchParams({
        wallet: x.wallet,
        chain: x.chain || "eth",
        days: String(x.days ?? 90),
      });
      return `<li class="kol-activity-item">
        <a class="kol-activity-link" href="/dashboard?${q.toString()}">
          <span class="kol-act-wallet">${shortAddr(x.wallet)}</span>
          <span class="kol-act-chain">${(x.chain || "eth").toUpperCase()}</span>
          <span class="kol-act-range">${daysLabel(x.days)}</span>
          <span class="kol-act-net ${net >= 0 ? "pos" : "neg"}">${netStr} net</span>
          <span class="kol-act-meta">${rows}</span>
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
