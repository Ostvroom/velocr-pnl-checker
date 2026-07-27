# LOOTERS autoplayer (piggybacking on this worker)

Headless autoplayer for the LOOTERS · The Ghost NFT game (lootersnft.xyz). Runs
as a second background process inside this same Render worker, launched by
`start.sh`. Zero shared dependencies with the PnL bot — pure Node built-ins
only (`fetch`, `fs`, `url`), nothing added to `package.json`.

## Required Render env var

- `LOOTER_COOKIE` — the game session cookie (`PHPSESSID=...`). Get it from
  DevTools → Network → any `game.php?action=me` request → Headers → Cookie.
  It expires roughly daily; when the bot logs `COOKIE EXPIRED`, update this
  env var in the Render dashboard and redeploy (or just Manual Restart) — no
  code change needed.

## Optional env vars (sane defaults if omitted)

| Var | Default | Meaning |
|---|---|---|
| `LOOTER_BASE` | `https://lootersnft.xyz` | API base URL |
| `LOOT_RESERVE` | `250` | Never spend below this much $LOOT |
| `MIN_CHANCE` | `0` | Optional success-% floor (0 = let $/hr math decide) |
| `TARGET_PATIENCE` | `0.4` | Save energy for a target worth less than this fraction of the best available |
| `RISK` | `0` | `1` = ignore the chance floor entirely |
| `REGEN_SEC` | `130` | Seconds per +1 energy (used for $/hr math) |
| `HEAT_BUFFER` | `4` | Extra safety margin below the predicted jail line |
| `NO_UPGRADE` | `0` | `1` = stop auto-spending $LOOT on gear |
| `HIT_BOSS` | `0` | `1` = also hit the gang boss (costs energy) |
| `TICK_MS_MIN` / `TICK_MS_MAX` | `30000` / `60000` | Randomized wait between cycles |

## Files this process writes (ephemeral, local to the container)

- `looters/status.txt` — human-readable snapshot, updated every tick
- `looters/heat.state` — learned heat-per-heist, survives restarts within the
  same deploy; resets on a fresh deploy (harmless, re-learns in a few heists)

Check status via Render's Shell tab: `cat looters/status.txt`.

## Isolation from the PnL bot

- No new npm dependencies — nothing to `npm install`.
- `src/bot.js` (the Discord bot) is untouched.
- If this bot crashes, `start.sh` respawns just this process; it does not
  restart the Discord bot.
- If the Discord bot crashes, Render restarts the whole container (both
  processes) — same as before this was added.
