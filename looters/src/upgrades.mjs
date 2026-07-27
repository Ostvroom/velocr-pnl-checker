// Gear upgrade optimizer — full 6-tree catalog, decoded from the game client.
//
// upgrade action: Y("upgrade", { track, node })
//   track: "drill" | "hack" | "wheels" | "inside" | "mask" | "bags"
//   node : 1..12 in that track's skill tree
//
// Each node has an effect + value. Buying raises its RANK; total effect =
// value * rank. Next-rank cost = round(BASE[node] * 1.3^rank). A node unlocks
// only when every prerequisite (PREREQ) is at rank >= 1. Same cost table and
// prereq tree apply to all six gear lines.
//
// Effects:
//   suc   = success power  -> higher heist WIN rate  (drill/hack/wheels/inside)
//   pay   = +% payout      -> bigger $ per win        (mask/bags)
//   crit  = +crit chance   -> chance to DOUBLE a win  (mask/bags)
//   regen = -sec regen     -> energy refills faster   (wheels/bags)  [throughput]
//   heat  = -heat per job  -> more heists before jail (drill/hack/mask)
//   jail  = -% jail time,  bail = -% bail cost         (inside)
//
// Instead of a fixed priority we value every candidate in ESTIMATED $ using the
// player's live payout and win rate, then buy the best $-per-$LOOT node.

export const BASE = { 1: 100, 2: 150, 3: 150, 4: 250, 5: 250, 6: 250, 7: 400, 8: 400, 9: 400, 10: 650, 11: 650, 12: 1200 };
export const PREREQ = { 1: [], 2: [1], 3: [1], 4: [2], 5: [1], 6: [3], 7: [4], 8: [5], 9: [6], 10: [7], 11: [9], 12: [10, 11] };
export const MAX_RANK = 10;

// node -> [effect, value] for each gear track.
export const TREES = {
  drill: { 1: ["suc", 1], 2: ["suc", 1], 3: ["suc", 1], 4: ["suc", 2], 5: ["suc", 2], 6: ["heat", 0.2], 7: ["suc", 2], 8: ["suc", 2], 9: ["heat", 0.3], 10: ["suc", 3], 11: ["suc", 3], 12: ["suc", 4] },
  hack: { 1: ["suc", 1], 2: ["suc", 1], 3: ["suc", 1], 4: ["heat", 0.2], 5: ["suc", 2], 6: ["suc", 2], 7: ["heat", 0.3], 8: ["suc", 2], 9: ["suc", 2], 10: ["suc", 3], 11: ["suc", 3], 12: ["suc", 4] },
  wheels: { 1: ["suc", 1], 2: ["suc", 1], 3: ["suc", 1], 4: ["suc", 2], 5: ["regen", 2], 6: ["suc", 2], 7: ["suc", 2], 8: ["regen", 3], 9: ["suc", 2], 10: ["suc", 3], 11: ["suc", 3], 12: ["suc", 4] },
  inside: { 1: ["suc", 1], 2: ["suc", 1], 3: ["suc", 1], 4: ["suc", 2], 5: ["suc", 2], 6: ["suc", 2], 7: ["jail", 1], 8: ["jail", 2], 9: ["suc", 2], 10: ["suc", 3], 11: ["bail", 2], 12: ["suc", 4] },
  mask: { 1: ["pay", 0.3], 2: ["pay", 0.3], 3: ["heat", 0.2], 4: ["pay", 0.4], 5: ["pay", 0.4], 6: ["heat", 0.3], 7: ["pay", 0.5], 8: ["crit", 0.2], 9: ["pay", 0.5], 10: ["crit", 0.3], 11: ["pay", 0.6], 12: ["pay", 0.8] },
  bags: { 1: ["pay", 0.3], 2: ["pay", 0.3], 3: ["pay", 0.4], 4: ["pay", 0.4], 5: ["regen", 2], 6: ["pay", 0.4], 7: ["pay", 0.5], 8: ["pay", 0.5], 9: ["crit", 0.2], 10: ["pay", 0.6], 11: ["pay", 0.6], 12: ["pay", 0.8] },
};

export const cost = (node, rank) => Math.round(BASE[node] * Math.pow(1.3, rank));

// How much one point of "success power" moves the win rate. Small; tuned low so
// payout/crit (which have large, directly-observable $ impact) win early, and
// suc only gets bought when it's cheap. Adjust as we learn the real curve.
const WIN_PER_SUC = 0.004; // +0.4% win per success point

const rankOf = (perksTrack, node) => Number(perksTrack?.[node] || 0);
const unlocked = (perksTrack, node) => PREREQ[node].every((p) => rankOf(perksTrack, p) >= 1);

// Estimated marginal $-value of one purchase of [effect,value], given the
// player's current win rate w (0..1), average payout P, and energy regen
// interval T (seconds). Returns a $/heist-equivalent number.
function utility(effect, value, { w, P, T }) {
  switch (effect) {
    case "pay":
      return w * P * value; // +value fraction of payout on every win
    case "crit":
      return w * P * value; // crit doubles a win -> +P per crit, scaled by chance
    case "suc":
      return WIN_PER_SUC * value * P; // more wins
    case "regen":
      return (value / T) * (w * P); // faster energy -> more heists over time
    case "heat":
      return value * 12; // fewer busts/jails; flat proxy
    case "jail":
      return value * 4;
    case "bail":
      return value * 4;
    default:
      return 0;
  }
}

/**
 * Pick the best single upgrade across all trees.
 * @param {object} perks  the player's perks object (per-track rank maps)
 * @param {number} budget spendable $LOOT (loot minus reserve)
 * @param {{w:number,P:number,T:number}} ctx live win rate, avg payout, regen interval
 * @returns {{track:string,node:number,cost:number,util:number,effect:string,value:number,score:number}|null}
 */
export function bestUpgrade(perks, budget, ctx) {
  const c = { w: ctx.w ?? 0.3, P: ctx.P ?? 150, T: ctx.T ?? 130 };
  let best = null;
  for (const track of Object.keys(TREES)) {
    const tree = TREES[track];
    const pt = perks?.[track] || {};
    for (const node of Object.keys(tree).map(Number)) {
      const [effect, value] = tree[node];
      const rank = rankOf(pt, node);
      if (rank >= MAX_RANK) continue;
      if (!unlocked(pt, node)) continue;
      const cst = cost(node, rank);
      if (cst > budget) continue;
      const util = utility(effect, value, c);
      const score = util / cst;
      if (!best || score > best.score) {
        best = { track, node, cost: cst, util, effect, value, score };
      }
    }
  }
  return best;
}
