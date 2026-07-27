// Thin client for the LOOTERS game API.
// The whole game is a single endpoint: /api/game.php?action=<name>
// GET when there is no body, POST (JSON) when there is one — this mirrors the
// client's own helper: async function Y(action, body?).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.LOOTER_BASE || "https://lootersnft.xyz";
const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

// Read the cookie fresh from .env so the user can paste a new one and have the
// running bot pick it up WITHOUT a restart. Falls back to the env var.
function loadCookie() {
  try {
    const txt = readFileSync(ENV_PATH, "utf8");
    const m = txt.match(/^\s*LOOTER_COOKIE\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  } catch {
    /* fall through to env var */
  }
  return process.env.LOOTER_COOKIE || "";
}

let COOKIE = loadCookie();

// Re-read the cookie from .env; call this after an auth failure. Returns true if
// the cookie value changed (i.e. the user pasted a new one).
export function reloadCookie() {
  const next = loadCookie();
  const changed = next !== COOKIE;
  COOKIE = next;
  return changed;
}

export function cookiePresent() {
  return COOKIE && !COOKIE.includes("paste_your_full_cookie");
}

let lastCall = 0;
// Be polite: never fire two requests closer than this many ms apart.
const MIN_GAP_MS = 400;

async function gap() {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * Call a game action.
 * @param {string} action  e.g. "me", "heist", "upgrade"
 * @param {object|undefined} body  present => POST with JSON body; absent => GET
 * @returns {Promise<any>} parsed JSON response
 */
export async function call(action, body) {
  await gap();
  const headers = {
    "X-Requested-With": "fetch",
    Cookie: COOKIE,
    Accept: "application/json",
  };
  const init = { headers, method: body !== undefined ? "POST" : "GET" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const url = `${BASE}/api/game.php?action=${encodeURIComponent(action)}`;
  let res;
  try {
    // A stalled connection (dead socket, Cloudflare hiccup) can hang fetch()
    // forever since Node sets no default timeout — that once froze the whole
    // bot silently for an hour with no crash for pm2 to restart. Force a cap.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, error: `network: ${e.name === "TimeoutError" ? "timed out" : e.message}`, action };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON usually means we were bounced to an HTML login page.
    return {
      ok: false,
      error: `non-json (status ${res.status}) — session cookie may be expired`,
      action,
      status: res.status,
    };
  }
  if (!res.ok) data.httpStatus = res.status;
  return data;
}

// Convenience wrappers for the actions the bot uses most.
export const api = {
  me: () => call("me"),
  feed: () => call("feed"),
  top: () => call("top"),
  factories: () => call("factories"),
  contracts: () => call("contracts"),
  crewJobs: () => call("crew_jobs"),
  machineQuests: () => call("machine_quests"),
  boss: () => call("boss"),
  jailhouse: () => call("jailhouse"),

  heist: (target) => call("heist", { target }), // target = key string, e.g. "store"
  bail: (playerId) => call("bail", playerId ? { player_id: playerId } : {}),
  upgrade: (track, node) => call("upgrade", { track, node }),
  streakClaim: () => call("streak_claim"),
  contractClaim: (id) => call("contract_claim", { id }),
  machineQuestDone: (id, proof = "") => call("machine_quest_done", { id, proof }),
  machineSpin: () => call("machine_spin", {}),
  bossHit: () => call("boss_hit", {}),
  bossWeapon: (type) => call("boss_weapon", { type }),
  factoryBuy: () => call("factory_buy", {}),
  factoryHire: () => call("factory_hire", {}),
  factoryUpgrade: () => call("factory_upgrade", {}),
};

export { BASE };
