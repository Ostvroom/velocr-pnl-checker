// LOOTERS · The Ghost — autoplayer.
//
// Strategy (maximize $LOOT / leaderboard position):
//   1. Sync state (me).
//   2. If jailed, bail (when affordable).
//   3. Claim all free rewards (streak, contracts, machine quests + spin, boss).
//   4. Heist repeatedly while energy > 0 AND heat < HEAT_CAP (server jails > 60).
//   5. Reinvest surplus $LOOT: upgrades (throughput first) + factories (passive).
//   6. Sleep a randomized interval so heat cools and energy regenerates.
//
// Field names below were reverse-engineered from the client bundle. The bot is
// written defensively: it reads whatever `me` actually returns and falls back
// to sensible defaults, and logs anything it doesn't recognize. Run
// `npm run probe` once and share probe-dump.json to lock the fields exactly.

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api, reloadCookie, cookiePresent } from "./api.mjs";
import { bestUpgrade } from "./upgrades.mjs";

// Resolve state files next to this script (not process.cwd()) so the bot is
// self-contained when run as a subfolder inside another project/repo.
const HEAT_STATE = fileURLToPath(new URL("../heat.state", import.meta.url));
const STATUS_FILE = fileURLToPath(new URL("../status.txt", import.meta.url));

const DRY = process.argv.includes("--dry");
const JAIL_AT = 60; // server busts risk jail above this heat
const CFG = {
  lootReserve: num(process.env.LOOT_RESERVE, 250),
  minChance: num(process.env.MIN_CHANCE, 0), // optional success-% floor (0 = off; let $/hr math decide)
  heatBuffer: num(process.env.HEAT_BUFFER, 4), // extra safety below the predicted jail line
  regenSec: num(process.env.REGEN_SEC, 130), // seconds per +1 energy (used for $/hr math)
  // How good an affordable target must be (vs the best overall) to fire instead
  // of saving energy for the top target. 0.4 => skip anything worth <40% of the
  // best. Lower = steadier small income; higher = hoard energy for big vaults.
  patience: num(process.env.TARGET_PATIENCE, 0.4),
  risk: process.env.RISK === "1", // ignore the chance floor entirely
  tickMin: num(process.env.TICK_MS_MIN, 20000),
  tickMax: num(process.env.TICK_MS_MAX, 40000),
};

let ticks = 0;
// Observed heat added per heist; refined at runtime and persisted so a restart
// doesn't re-learn from scratch (which used to cost a jail on the first big hit).
let obsHeatPerHeist = loadHeat();
function loadHeat() {
  try {
    const v = parseFloat(readFileSync(HEAT_STATE, "utf8"));
    if (Number.isFinite(v) && v >= 7) return v;
  } catch {
    /* first run */
  }
  return 7;
}
const cooldowns = {}; // action -> epoch ms it's next allowed
const stats = {
  startedAt: Date.now(),
  startEarned: null, // set on first sync
  earned: 0, // lifetime "earned" (from server)
  loot: 0,
  heists: 0,
  hits: 0,
  jails: 0,
  bails: 0,
  invested: 0,
  lastError: "",
  lastTick: null,
};
let authFails = 0;
main();

async function main() {
  banner();
  // Wait (don't crash) until we have a valid session, so under pm2 the process
  // stays alive through cookie expiry and self-heals when .env is updated.
  await waitForAuth();
  log("Authenticated. Starting loop.", DRY ? "(DRY RUN — no mutations)" : "");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (e) {
      stats.lastError = e.message;
      log("tick error:", e.message);
    }
    writeStatus();
    // Cookie expired mid-run: re-read .env (the user may have pasted a fresh
    // one) and wait it out instead of dying.
    if (authFails >= 2) {
      const changed = reloadCookie();
      log(
        changed
          ? "🔄 New cookie detected in .env — retrying."
          : "!! COOKIE EXPIRED — paste a fresh LOOTER_COOKIE into .env (no restart needed). Waiting 3 min."
      );
      if (!changed) {
        await sleep(3 * 60e3);
        continue;
      }
      authFails = 0;
    }
    const wait = rand(CFG.tickMin, CFG.tickMax);
    log(`— sleeping ${Math.round(wait / 1000)}s —`);
    await sleep(wait);
  }
}

// Block until authenticated, reloading the cookie from .env each try. Keeps the
// process healthy under pm2 while the user refreshes an expired cookie.
async function waitForAuth() {
  let announced = false;
  for (;;) {
    if (cookiePresent()) {
      const me = await api.me();
      if (me && me.ok !== false && me.auth !== false) return;
    }
    if (!announced) {
      log("!! Not authenticated — paste a fresh LOOTER_COOKIE into .env (no restart needed). Waiting…");
      announced = true;
    }
    stats.lastError = "cookie expired — awaiting refresh in .env";
    writeStatus();
    await sleep(30e3);
    reloadCookie();
  }
}

async function tick() {
  ticks++;
  const me = await api.me();
  if (me.auth === false || me.ok === false) {
    authFails++;
    log("session lost:", JSON.stringify(me).slice(0, 160));
    return;
  }
  authFails = 0;
  if (stats.lastError === "cookie expired — awaiting refresh in .env") stats.lastError = "";
  const s = readState(me);
  if (stats.startEarned === null) stats.startEarned = s.earned;
  stats.earned = s.earned;
  stats.loot = s.loot;
  stats.lastTick = Date.now();
  const pick = bestTarget(s);
  stats.event = s.event || "";
  log(
    `#${ticks} loot=${s.loot} earned=${s.earned} (session +${s.earned - stats.startEarned}) ` +
      `energy=${s.energy}/${s.energyMax} heat=${s.heat} ${s.jailed ? `JAILED(bail ${s.bailCost})` : ""} ` +
      `${s.event ? `🌆 ${s.event.toUpperCase()} ` : ""}` +
      `→ ${pick ? `${pick.key}(${pick.chance}%, ~${pick.perHr.toFixed(0)}/hr)` : "wait for energy"}`
  );

  // Jail handling: bail only if it's cheap relative to our loot (don't drain the
  // bank on bail; a short wait is fine when we're broke).
  if (s.jailed) {
    if (s.loot >= s.bailCost + CFG.lootReserve) {
      const r = await act(`bail (-${s.bailCost})`, () => api.bail());
      if (r && r.ok !== false) stats.bails++;
    } else {
      log(`   jailed (${s.jailLeft}s) — waiting it out (bail ${s.bailCost} too pricey now)`);
    }
  }

  await claimFreebies();
  await heistLoop(s);
  await reinvest(me, s);
}

// Throughput-aware target scoring. The two hard limits are energy (regens
// ~1 / REGEN_SEC) and heat (cools 1/min, ~60/hr, ~obsHeatPerHeist per heist).
// A target's real earning rate = EV per heist * heists/hour, where heists/hour
// is whichever limit binds first. This automatically favors small targets when
// energy-limited and big targets (Reserve) when heat-limited with spare energy.
function scoreTargets(s) {
  const energyPerHr = 3600 / CFG.regenSec;
  const heatPerHr = 60; // heat cools ~1/min
  const heatHeists = heatPerHr / Math.max(1, obsHeatPerHeist);
  return (s.targets || [])
    .map((t) => {
      const avg = (num(t.min) + num(t.max)) / 2;
      const chance = num(t.chance);
      const energy = Math.max(1, num(t.energy, 1));
      const ev = (avg * chance) / 100;
      const energyHeists = energyPerHr / energy;
      const heistsPerHr = Math.min(energyHeists, heatHeists);
      return {
        key: t.key,
        name: t.name,
        chance,
        energy,
        avg,
        ev,
        evPerEnergy: ev / energy,
        perHr: ev * heistsPerHr,
      };
    })
    .sort((a, b) => b.perHr - a.perHr);
}

// Pick the target to hit now. Ranks by $/hour, but — crucially — when heat is
// the binding constraint, each heat-limited heist should be spent on the
// highest-value target, not the first one we can afford. So if the top target
// is only an energy-refill away, we WAIT (return null) rather than burn heat on
// a cheap target worth < patience × the best. Optional MIN_CHANCE floor and RISK
// flag still honored.
function bestTarget(s) {
  let scored = scoreTargets(s);
  if (!CFG.risk && CFG.minChance > 0) {
    const floored = scored.filter((t) => t.chance >= CFG.minChance);
    if (floored.length) scored = floored;
  }
  const globalBest = scored[0];
  const affordable = scored.filter((t) => t.energy <= s.energy);
  const pick = affordable[0];
  if (!pick) return null;
  // Save energy for a much better target that's just a refill away.
  if (globalBest && globalBest.energy > s.energy && pick.perHr < CFG.patience * globalBest.perHr) {
    return null; // wait to afford the top target instead of wasting a heat-heist
  }
  return pick;
}

async function heistLoop(initial) {
  let s = initial;
  let did = 0;
  let guard = 0;
  let earnedThisRun = 0;
  const evFactor = eventHeatFactor(s.event);
  const heatPerHeist = obsHeatPerHeist * evFactor; // event-adjusted
  while (guard++ < 30) {
    if (s.jailed) break;
    // Predictive heat control: a heist ADDS heat, and a bust above ~60 jails us.
    // Stop before the heist would push us into the danger zone. During LOCKDOWN
    // heat runs hot (×1.5); during BLACKOUT it's halved so we can chain more.
    const stopHeat = JAIL_AT - heatPerHeist - CFG.heatBuffer;
    if (s.heat > stopHeat) {
      const tag = evFactor !== 1 ? ` ${s.event}×${evFactor}` : "";
      log(`   heat ${s.heat} > safe ${stopHeat.toFixed(0)} (jail@${JAIL_AT}, +${heatPerHeist.toFixed(0)}/heist${tag}) — cooling`);
      break;
    }
    const t = bestTarget(s);
    if (!t) {
      const top = scoreTargets(s)[0];
      log(
        top && top.energy > s.energy
          ? `   saving energy for ${top.key} (need ${top.energy}, have ${s.energy})`
          : "   out of energy for any target"
      );
      break;
    }
    const heatBefore = s.heat;
    const r = await act(`heist ${t.key} (${t.chance}%)`, () => api.heist(t.key));
    if (!r || r.ok === false) {
      if (r && r.error) log("   heist stopped:", r.error);
      break;
    }
    did++;
    stats.heists++;
    if (r.dry) {
      s = { ...s, energy: s.energy - t.energy, heat: s.heat + heatPerHeist };
      continue;
    }
    // Heist result is nested: { ok, result: { key, success, payout, crit, jailed } }
    const res = r.result || {};
    if (res.success) {
      earnedThisRun += num(res.payout);
      stats.hits++;
      log(`   ✓ hit ${t.key} +${res.payout}${res.crit ? " CRIT" : ""}`);
    } else {
      log(`   ✗ missed ${t.key}${res.jailed ? " → JAILED" : ""}`);
    }
    // The heist response doesn't echo full player state, so re-sync from me.
    s = readState(await api.me());
    // Learn the real BASE heat-per-heist from the observed jump (ignore jail
    // resets and event windows, since events scale heat and would corrupt it).
    if (!res.jailed && !s.event && s.heat > heatBefore) {
      const prev = obsHeatPerHeist;
      obsHeatPerHeist = Math.max(obsHeatPerHeist, s.heat - heatBefore);
      if (obsHeatPerHeist > prev) {
        try {
          writeFileSync(HEAT_STATE, String(obsHeatPerHeist));
        } catch {
          /* ignore */
        }
      }
    }
    if (res.jailed || s.jailed) {
      stats.jails++;
      log(`   jailed after ${did} heist(s)`);
      break;
    }
  }
  if (did) log(`   ran ${did} heist(s), +${earnedThisRun} $LOOT → loot=${s.loot} heat=${s.heat} energy=${s.energy}`);
}

async function claimFreebies() {
  // Daily streak.
  if (ready("streak")) {
    const r = await act("streak_claim", () => api.streakClaim());
    schedule("streak", 6 * 3600e3, r); // re-check in 6h regardless
  }

  // Contracts: claim any that are done but not yet claimed (free $LOOT).
  if (ready("contracts")) {
    const c = await api.contracts();
    for (const item of pickList(c)) {
      if (item && item.done && !item.claimed && item.id != null) {
        await act(`contract_claim ${item.label} (+${item.reward})`, () =>
          api.contractClaim(item.id)
        );
      }
    }
    schedule("contracts", 10 * 60e3);
  }

  // Machine: pure free loot. Rules: "1 job = 1 point · 3 points = 1 extra pull.
  // The free pull recharges on its own." Heisting earns points as a byproduct,
  // so we take the timed free pull AND cash in every 3 accumulated points.
  if (ready("machine")) {
    const q = await api.machineQuests();
    let pts = num(q && q.points, 0);
    if (q && num(q.freeIn, 1) <= 0) {
      const r = await act("machine_spin (free)", () => api.machineSpin());
      if (r && r.prize != null) log(`   🎰 prize +${r.prize}`);
    }
    let guard = 0;
    while (pts >= 3 && guard++ < 10) {
      const r = await act(`machine_spin (${pts}pts)`, () => api.machineSpin());
      if (!r || r.ok === false) break;
      if (r.prize != null) log(`   🎰 prize +${r.prize}`);
      pts -= 3;
    }
    schedule("machine", 5 * 60e3);
  }

  // Boss: only hit while the boss is alive (down:false, hpLeft>0). Note this may
  // cost energy — controlled by HIT_BOSS so it doesn't steal heist energy.
  if (process.env.HIT_BOSS === "1" && ready("boss")) {
    const b = await api.boss();
    if (b && b.live && b.boss && b.boss.down === false && num(b.boss.hpLeft) > 0) {
      await act("boss_hit", () => api.bossHit());
    }
    schedule("boss", 3 * 60e3);
  }
}

async function reinvest(me, s) {
  const budget = s.loot - CFG.lootReserve;
  if (budget <= 0) return;

  // Gear upgrades — the compounding lever, spread across all six trees. Each
  // candidate is valued in estimated $ from the live payout & win rate, so the
  // bot buys whatever returns the most per $LOOT: usually payout/crit early,
  // then regen (throughput) and success power. Deep-clone perks so we can model
  // successive buys within one tick.
  if (process.env.NO_UPGRADE !== "1") {
    const perks = structuredClone((me.player && me.player.perks) || {});
    const t = bestTarget(s) || scoreTargets(s)[0] || { avg: 150, chance: 30 };
    const ctx = {
      w: (t.chance || 30) / 100,
      P: t.avg || 150,
      T: Math.max(30, s.nextEnergyIn || 130),
    };
    let loot = s.loot;
    let bought = 0;
    const byEffect = {};
    while (bought < 10) {
      const b = bestUpgrade(perks, loot - CFG.lootReserve, ctx);
      if (!b) break;
      const r = await act(
        `upgrade ${b.track}#${b.node} [${b.effect}+${b.value}] (-${b.cost})`,
        () => api.upgrade(b.track, b.node)
      );
      if (!r || r.ok === false) {
        if (r && r.error) log("   upgrade stopped:", r.error);
        break;
      }
      perks[b.track] = perks[b.track] || {};
      perks[b.track][b.node] = (Number(perks[b.track][b.node]) || 0) + 1;
      loot -= b.cost;
      stats.invested += b.cost;
      byEffect[b.effect] = (byEffect[b.effect] || 0) + 1;
      bought++;
    }
    if (bought) {
      const mix = Object.entries(byEffect).map(([k, v]) => `${k}×${v}`).join(" ");
      log(`   bought ${bought} upgrade(s) [${mix}], ${s.loot - loot} $LOOT invested`);
    }
  }

  // Factories: only a gang's OWNED factories can be upgraded, and buying one
  // costs 80k–190k — late-game only. Act only when clearly affordable.
  if (ready("factories")) {
    const f = await api.factories();
    const myGangId = (me.player && me.player.gang && me.player.gang.id) || null;
    const mine = pickList(f).filter((x) => x && x.ownerGangId === myGangId);
    const upg = mine
      .filter((x) => x.level < (x.maxLevel ?? Infinity) && num(x.upgradeCost) <= s.loot - CFG.lootReserve)
      .sort((a, b) => a.upgradeCost - b.upgradeCost)[0];
    if (upg) await act(`factory_upgrade ${upg.name} (-${upg.upgradeCost})`, () => api.factoryUpgrade());
    schedule("factories", 10 * 60e3);
  }
}

// ---- helpers ---------------------------------------------------------------

// Map a raw `me` (or heist) payload to a normalized state object.
// Real shape: { ok, auth, player: { loot, energy, energyMax, nextEnergyIn,
// heat, jailLeft, bailCost, streak, earned, targets:[...] } }
function readState(resp) {
  const g = resp.player || resp.game || resp.state || resp;
  return {
    loot: num(g.loot ?? g.balance, 0),
    earned: num(g.earned, 0),
    energy: num(g.energy, 0),
    energyMax: num(g.energyMax, 0),
    nextEnergyIn: num(g.nextEnergyIn, 0),
    heat: num(g.heat, 0),
    jailed: num(g.jailLeft, 0) > 0,
    jailLeft: num(g.jailLeft, 0),
    bailCost: num(g.bailCost ?? g.bail, 100),
    streak: num(g.streak, 0),
    targets: Array.isArray(g.targets) ? g.targets : [],
    // Active city event (temporary city-wide modifier), or null.
    event: g.cityEvent ? String(g.cityEvent.key || g.cityEvent.name || "").toLowerCase() : "",
  };
}

// City events change heat per heist. LOCKDOWN ×1.5 (cops everywhere), BLACKOUT
// ×0.5 (grid down). Returns the multiplier to apply to obsHeatPerHeist so the
// jail-avoidance math stays correct during events.
function eventHeatFactor(ev) {
  if (!ev) return 1;
  if (ev.includes("lockdown")) return 1.5;
  if (ev.includes("blackout")) return 0.5;
  return 1; // payday etc. don't change heat
}

async function act(label, fn) {
  if (DRY) {
    log("   [dry] would", label);
    return { ok: true, dry: true };
  }
  const r = await fn();
  const ok = r && r.ok !== false;
  log(`   ${ok ? "✓" : "✗"} ${label}`, ok ? shortOk(r) : (r && r.error) || "");
  return r;
}

function shortOk(r) {
  const bits = [];
  if (r.reward != null) bits.push(`+${r.reward}`);
  if (r.payout != null) bits.push(`+${r.payout}`);
  if (r.loot != null) bits.push(`loot=${r.loot}`);
  return bits.join(" ");
}

function pickList(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  for (const k of ["items", "list", "contracts", "quests", "factories", "data"]) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  return [];
}

// Human-readable snapshot written every tick to status.txt.
function writeStatus() {
  const upMin = (Date.now() - stats.startedAt) / 60000;
  const sessionEarned = stats.startEarned === null ? 0 : stats.earned - stats.startEarned;
  const perHr = upMin > 1 ? (sessionEarned / upMin) * 60 : 0;
  const hitRate = stats.heists ? ((stats.hits / stats.heists) * 100).toFixed(0) : "–";
  const lines = [
    `LOOTERS autoplayer — status`,
    `updated : ${new Date().toISOString()}`,
    `uptime  : ${upMin.toFixed(0)} min   (tick #${ticks})`,
    ``,
    `$LOOT balance    : ${stats.loot}`,
    `lifetime earned  : ${stats.earned}`,
    `earned this run  : +${sessionEarned}   (~${perHr.toFixed(0)}/hr)`,
    `$LOOT invested   : ${stats.invested} (into gear)`,
    ``,
    `heists           : ${stats.heists}  (hits ${stats.hits}, win ${hitRate}%)`,
    `jails / bails    : ${stats.jails} / ${stats.bails}`,
    `heat per heist   : ~${obsHeatPerHeist}`,
    stats.event ? `city event       : ${stats.event.toUpperCase()} active` : ``,
    stats.lastError ? `last error       : ${stats.lastError}` : ``,
    authFails >= 3 ? `!! COOKIE EXPIRED — refresh LOOTER_COOKIE in .env and restart` : ``,
  ].filter(Boolean);
  try {
    writeFileSync(STATUS_FILE, lines.join("\n") + "\n");
  } catch {
    /* ignore */
  }
}

function ready(key) {
  return (cooldowns[key] || 0) <= Date.now();
}
function schedule(key, ms) {
  cooldowns[key] = Date.now() + ms;
}

function num(v, d = 0) {
  return Number.isFinite(+v) ? +v : d;
}
// Function declarations (not const) — they're hoisted, so they're safely
// callable from main()/waitForAuth() which run synchronously before the
// module finishes evaluating its later const/arrow-function statements. A
// const here caused a ReferenceError (TDZ) the first time the bot booted
// without a cookie and hit this call before yielding on any prior await.
function rand(a, b) {
  return Math.floor(a + Math.random() * (b - a));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}
function banner() {
  console.log("┌─────────────────────────────────────────┐");
  console.log("│  LOOTERS · The Ghost — autoplayer         │");
  console.log(`│  reserve=${String(CFG.lootReserve).padEnd(5)} minChance=${String(CFG.minChance).padEnd(3)} jail@${JAIL_AT}${CFG.risk ? " RISK" : ""}       │`);
  console.log("└─────────────────────────────────────────┘");
}
