/**
 * STANDALONE VAULT TRACKER RUNNER
 * Run this separately from the main bot:
 *   node run-tracker.js
 *
 * Or add it to your process manager (PM2):
 *   pm2 start run-tracker.js --name vault-tracker
 */

require('dotenv').config();
const tracker = require('./src/vault-tracker');

// ── Validate required env vars ────────────────────────────────────────────────
if (!process.env.VAULT_WEBHOOK_URL) {
  console.error(
    '\n[ERROR] VAULT_WEBHOOK_URL is not set in .env\n' +
    'Create a Discord webhook in your alerts channel:\n' +
    '  Channel Settings → Integrations → Webhooks → New Webhook\n' +
    '  Copy URL and add to .env as VAULT_WEBHOOK_URL=https://discord.com/api/webhooks/...\n'
  );
  process.exit(1);
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  // Backfill last 1000 blocks on startup (catches any recent buys while offline)
  // Adjust number down if startup is slow
  const BACKFILL_BLOCKS = parseInt(process.env.BACKFILL_BLOCKS || '1000', 10);
  if (BACKFILL_BLOCKS > 0) {
    console.log(`[Tracker] Backfilling last ${BACKFILL_BLOCKS} blocks on startup...`);
    await tracker.backfillRecentBlocks(BACKFILL_BLOCKS);
  }

  tracker.startTracking();
})();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT',  () => { tracker.stopTracking(); process.exit(0); });
process.on('SIGTERM', () => { tracker.stopTracking(); process.exit(0); });
