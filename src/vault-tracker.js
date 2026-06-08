/**
 * VAULT TRACKER — Automated Alpha Signal Bot
 * Monitors the Virtuals Protocol trading vault 0x7e74c740...
 * and alerts your Discord channel on every new buy detected.
 *
 * HOW IT WORKS:
 *  1. Every 3 seconds it checks for new blocks on Base
 *  2. Scans those blocks for any ERC-20 token flowing INTO the vault (= a buy)
 *  3. Also watches for token approvals from the vault (= new position incoming)
 *  4. Sends a formatted Discord embed with token info + copy-trade suggestion
 *  5. Tracks burst-buy clusters (3+ buys same token in <1 hour = STRONG signal)
 */

const https = require('https');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const VAULT_ADDRESS       = '0x7e74c740a0b05cc8ba8c85bef8f6d5f084022c90';
const BASE_RPC            = 'https://mainnet.base.org';
const BACKUP_RPC          = 'https://base.llamarpc.com';
const POLL_INTERVAL_MS    = 3000;   // check every 3 seconds
const BURST_WINDOW_MS     = 60 * 60 * 1000; // 1 hour window for burst detection
const BURST_THRESHOLD     = 3;      // 3+ buys same token in 1h = STRONG signal
const KNOWN_IGNORE_TOKENS = new Set([
  '0x4200000000000000000000000000000000000006', // WETH (not a buy signal)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
]);

// ERC-20 event topics
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

// Vault address padded to 32 bytes for topic matching
const VAULT_TOPIC = '0x000000000000000000000000' + VAULT_ADDRESS.slice(2).toLowerCase();

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastCheckedBlock = null;
let currentRPC       = BASE_RPC;
let isRunning        = false;

// token address -> { symbol, name, decimals }
const tokenCache = new Map();

// token address -> array of { timestamp, amount, txHash }  (for burst detection)
const buyHistory = new Map();

// token address -> timestamp of last approval alert (avoid spam)
const approvalAlerts = new Map();

// ─── RPC HELPER ───────────────────────────────────────────────────────────────
function rpcCall(method, params, retries = 3) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url  = new URL(currentRPC);

    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  8000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else resolve(json.result);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', async (err) => {
      if (retries > 0) {
        // switch RPC on network error
        currentRPC = currentRPC === BASE_RPC ? BACKUP_RPC : BASE_RPC;
        try { resolve(await rpcCall(method, params, retries - 1)); }
        catch (e) { reject(e); }
      } else { reject(err); }
    });

    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  });
}

// ─── TOKEN INFO ───────────────────────────────────────────────────────────────
async function getTokenInfo(address) {
  const key = address.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);

  try {
    const [symbolHex, nameHex, decimalsHex] = await Promise.all([
      rpcCall('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
      rpcCall('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
      rpcCall('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
    ]);

    const decodeStr = hex => {
      if (!hex || hex === '0x') return '???';
      try {
        const data = hex.slice(2);
        // ABI-encoded string: offset(32) + length(32) + data
        if (data.length > 128) {
          const len = parseInt(data.slice(64, 128), 16);
          return Buffer.from(data.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '').trim();
        }
        return Buffer.from(data.replace(/^0+/, '') || '00', 'hex').toString('utf8').replace(/\0/g, '').trim() || '???';
      } catch { return '???'; }
    };

    const info = {
      symbol:   decodeStr(symbolHex),
      name:     decodeStr(nameHex),
      decimals: decimalsHex && decimalsHex !== '0x' ? parseInt(decimalsHex, 16) : 18,
      address,
    };

    tokenCache.set(key, info);
    return info;
  } catch {
    const fallback = { symbol: '???', name: 'Unknown Token', decimals: 18, address };
    tokenCache.set(key, fallback);
    return fallback;
  }
}

// ─── AMOUNT FORMATTER ─────────────────────────────────────────────────────────
function formatAmount(hexAmount, decimals) {
  try {
    const raw = BigInt(hexAmount);
    const divisor = BigInt(10 ** Math.min(decimals, 18));
    const whole = raw / divisor;
    const frac  = raw % divisor;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2);
    return formatNumber(Number(whole.toString() + '.' + fracStr));
  } catch { return '?'; }
}

function formatNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(2);
}

function hexToEth(hex) {
  if (!hex || hex === '0x0' || hex === '0x') return 0;
  return Number(BigInt(hex)) / 1e18;
}

// ─── BURST SIGNAL CALCULATOR ──────────────────────────────────────────────────
function updateBurstHistory(tokenAddress, amount, txHash) {
  const key = tokenAddress.toLowerCase();
  const now = Date.now();

  if (!buyHistory.has(key)) buyHistory.set(key, []);
  const history = buyHistory.get(key);

  // add new buy
  history.push({ timestamp: now, amount, txHash });

  // remove entries older than burst window
  const cutoff = now - BURST_WINDOW_MS;
  const recent = history.filter(h => h.timestamp >= cutoff);
  buyHistory.set(key, recent);

  return recent.length; // total buys in window
}

function getSignalStrength(buyCount) {
  if (buyCount >= 6)  return { emoji: '🔥🔥🔥', label: 'EXTREME SIGNAL',  color: 0xFF0000 };
  if (buyCount >= 4)  return { emoji: '🔥🔥',   label: 'STRONG SIGNAL',   color: 0xFF6600 };
  if (buyCount >= 3)  return { emoji: '🔥',     label: 'GOOD SIGNAL',     color: 0xFFAA00 };
  if (buyCount === 2) return { emoji: '👀',     label: 'WATCHING',        color: 0xFFFF00 };
  return               { emoji: '📡',            label: 'FIRST BUY',       color: 0x00AAFF };
}

// ─── DISCORD EMBED BUILDER ────────────────────────────────────────────────────
function buildBuyEmbed(tokenInfo, amountFormatted, buysInWindow, txHash, blockNum, ethValue) {
  const signal  = getSignalStrength(buysInWindow);
  const shortTx = txHash.slice(0, 10) + '...' + txHash.slice(-6);
  const shortAddr = tokenInfo.address.slice(0, 8) + '...' + tokenInfo.address.slice(-6);
  const basescanToken = `https://basescan.org/token/${tokenInfo.address}`;
  const basescanTx    = `https://basescan.org/tx/${txHash}`;
  const dexscreener   = `https://dexscreener.com/base/${tokenInfo.address}`;
  const virtuals      = `https://app.virtuals.io/virtuals`;

  return {
    embeds: [{
      title: `${signal.emoji} ${signal.label} — Vault Buying ${tokenInfo.symbol}`,
      description:
        `The alpha vault just bought **${amountFormatted} ${tokenInfo.symbol}**\n` +
        `This is buy **#${buysInWindow}** in the last hour${buysInWindow >= BURST_THRESHOLD ? ' — **BURST CLUSTER DETECTED**' : ''}\n\n` +
        (buysInWindow >= BURST_THRESHOLD
          ? `⚡ **COPY TRADE OPPORTUNITY** — vault is accumulating hard\n\n`
          : '') +
        `> *"When this vault buys 3+ times in 1 hour, it has consistently pumped"*`,
      color: signal.color,
      fields: [
        {
          name: '🪙 Token',
          value: `**${tokenInfo.name}** (${tokenInfo.symbol})\n\`${tokenInfo.address}\``,
          inline: false,
        },
        {
          name: '💰 Amount Bought',
          value: `**${amountFormatted} ${tokenInfo.symbol}**`,
          inline: true,
        },
        {
          name: '⛽ ETH Spent',
          value: ethValue > 0 ? `**${ethValue.toFixed(4)} ETH**` : 'See tx',
          inline: true,
        },
        {
          name: '📊 Buys This Hour',
          value: `**${buysInWindow}** / threshold: ${BURST_THRESHOLD}`,
          inline: true,
        },
        {
          name: '🔗 Links',
          value:
            `[Basescan Token](${basescanToken}) • [Transaction](${basescanTx})\n` +
            `[DexScreener](${dexscreener}) • [Virtuals](${virtuals})`,
          inline: false,
        },
        {
          name: '📋 Transaction',
          value: `Block: **${parseInt(blockNum, 16).toLocaleString()}**\nTx: \`${shortTx}\``,
          inline: false,
        },
        {
          name: '⚠️ Copy Trade Guide',
          value:
            `1. Go to [DexScreener](${dexscreener}) and check liquidity\n` +
            `2. Only buy if liquidity > $50K\n` +
            `3. Use 0.1–0.3 ETH max (same scale as vault)\n` +
            `4. Set 2–3x take profit target\n` +
            `5. DYOR — past signals ≠ guaranteed future gains`,
          inline: false,
        },
      ],
      footer: { text: `Vault Tracker • 0x7e74c740...22C90 • Block ${parseInt(blockNum, 16).toLocaleString()}` },
      timestamp: new Date().toISOString(),
    }]
  };
}

function buildApprovalEmbed(tokenInfo) {
  return {
    embeds: [{
      title: `👁️ NEW TOKEN APPROVED — ${tokenInfo.symbol} (Pre-Buy Alert)`,
      description:
        `The vault just **approved** a new token for trading.\n` +
        `**This almost always means a buy is incoming within minutes.**\n\n` +
        `Get ready — first buy alert will follow soon.`,
      color: 0x5865F2,
      fields: [
        {
          name: '🪙 Token',
          value: `**${tokenInfo.name}** (${tokenInfo.symbol})\n\`${tokenInfo.address}\``,
          inline: false,
        },
        {
          name: '🔗 Links',
          value:
            `[Basescan](https://basescan.org/token/${tokenInfo.address}) • ` +
            `[DexScreener](https://dexscreener.com/base/${tokenInfo.address}) • ` +
            `[Virtuals](https://app.virtuals.io/virtuals)`,
          inline: false,
        },
        {
          name: '💡 What to do',
          value: `Research this token NOW before the vault buys.\nIf it looks legit, be ready to buy when the first buy alert drops.`,
          inline: false,
        },
      ],
      footer: { text: 'Vault Tracker — Pre-Buy Signal' },
      timestamp: new Date().toISOString(),
    }]
  };
}

// ─── DISCORD SENDER ───────────────────────────────────────────────────────────
function sendDiscordMessage(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(webhookUrl);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = https.request(options, res => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Alternative: send via Discord bot channel (used when integrated into bot.js)
let discordChannelSender = null;
function setDiscordSender(fn) { discordChannelSender = fn; }

async function sendAlert(payload) {
  try {
    if (discordChannelSender) {
      await discordChannelSender(payload);
    } else if (process.env.VAULT_WEBHOOK_URL) {
      await sendDiscordMessage(process.env.VAULT_WEBHOOK_URL, payload);
    } else {
      console.log('[VaultTracker] Alert (no sender configured):', JSON.stringify(payload.embeds[0].title));
    }
  } catch (err) {
    console.error('[VaultTracker] Failed to send alert:', err.message);
  }
}

// ─── CORE: PROCESS A BLOCK RANGE ─────────────────────────────────────────────
async function processBlockRange(fromBlock, toBlock) {
  const fromHex = '0x' + fromBlock.toString(16);
  const toHex   = '0x' + toBlock.toString(16);

  // Fetch all ERC-20 Transfer events TO the vault in this range
  let buyLogs = [];
  try {
    buyLogs = await rpcCall('eth_getLogs', [{
      fromBlock: fromHex,
      toBlock:   toHex,
      topics:    [TRANSFER_TOPIC, null, VAULT_TOPIC],
    }]) || [];
  } catch (err) {
    console.warn('[VaultTracker] getLogs (buys) error:', err.message);
    return;
  }

  // Fetch Approval events FROM the vault in this range
  let approvalLogs = [];
  try {
    approvalLogs = await rpcCall('eth_getLogs', [{
      fromBlock: fromHex,
      toBlock:   toHex,
      topics:    [APPROVAL_TOPIC, VAULT_TOPIC],
    }]) || [];
  } catch (err) {
    console.warn('[VaultTracker] getLogs (approvals) error:', err.message);
  }

  // ── Handle approvals first (pre-buy alerts) ──────────────────────────────
  for (const log of approvalLogs) {
    const tokenAddr = log.address.toLowerCase();
    if (KNOWN_IGNORE_TOKENS.has(tokenAddr)) continue;

    const lastAlert = approvalAlerts.get(tokenAddr) || 0;
    if (Date.now() - lastAlert < 30 * 60 * 1000) continue; // suppress duplicates for 30 min
    approvalAlerts.set(tokenAddr, Date.now());

    const tokenInfo = await getTokenInfo(log.address);
    if (tokenInfo.symbol === '???') continue; // skip scam/broken tokens

    console.log(`[VaultTracker] APPROVAL detected: ${tokenInfo.symbol} (${log.address})`);
    await sendAlert(buildApprovalEmbed(tokenInfo));
  }

  // ── Handle buys ──────────────────────────────────────────────────────────
  // Group by tx hash to avoid double-counting within same tx
  const seenTxHashes = new Set();

  for (const log of buyLogs) {
    const tokenAddr = log.address.toLowerCase();
    if (KNOWN_IGNORE_TOKENS.has(tokenAddr)) continue;
    if (seenTxHashes.has(log.transactionHash + tokenAddr)) continue;
    seenTxHashes.add(log.transactionHash + tokenAddr);

    // Decode amount from log.data
    const amountHex = log.data;
    const tokenInfo = await getTokenInfo(log.address);

    if (tokenInfo.symbol === '???') continue; // skip scam tokens with no symbol

    const amountFormatted = formatAmount(amountHex, tokenInfo.decimals);
    const buysInWindow    = updateBurstHistory(tokenAddr, amountHex, log.transactionHash);

    // Get ETH value of the transaction
    let ethValue = 0;
    try {
      const tx = await rpcCall('eth_getTransaction', [log.transactionHash]);
      if (tx) ethValue = hexToEth(tx.value || '0x0');
    } catch { /* ignore */ }

    console.log(
      `[VaultTracker] BUY #${buysInWindow} — ${amountFormatted} ${tokenInfo.symbol}` +
      ` | tx: ${log.transactionHash.slice(0, 12)}...` +
      ` | block: ${parseInt(log.blockNumber, 16)}`
    );

    await sendAlert(buildBuyEmbed(
      tokenInfo,
      amountFormatted,
      buysInWindow,
      log.transactionHash,
      log.blockNumber,
      ethValue,
    ));
  }
}

// ─── MAIN POLLING LOOP ────────────────────────────────────────────────────────
async function startTracking() {
  if (isRunning) return;
  isRunning = true;

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        VAULT TRACKER — ALPHA SIGNAL BOT         ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Watching: ${VAULT_ADDRESS.slice(0, 12)}...${VAULT_ADDRESS.slice(-6)}  ║`);
  console.log(`║  Network:  Base Mainnet                          ║`);
  console.log(`║  Poll:     every ${(POLL_INTERVAL_MS/1000).toFixed(0)}s                               ║`);
  console.log(`║  Burst:    alert at ${BURST_THRESHOLD}+ buys / hour                  ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Get starting block
  try {
    const blockHex = await rpcCall('eth_blockNumber', []);
    lastCheckedBlock = parseInt(blockHex, 16);
    console.log(`[VaultTracker] Starting from block ${lastCheckedBlock.toLocaleString()}`);
  } catch (err) {
    console.error('[VaultTracker] Failed to get starting block:', err.message);
    isRunning = false;
    return;
  }

  const poll = async () => {
    if (!isRunning) return;

    try {
      const latestHex = await rpcCall('eth_blockNumber', []);
      const latestBlock = parseInt(latestHex, 16);

      if (latestBlock > lastCheckedBlock) {
        // Process in chunks of max 200 blocks to avoid RPC limits
        const MAX_CHUNK = 200;
        let from = lastCheckedBlock + 1;

        while (from <= latestBlock) {
          const to = Math.min(from + MAX_CHUNK - 1, latestBlock);
          await processBlockRange(from, to);
          from = to + 1;
        }

        lastCheckedBlock = latestBlock;
      }
    } catch (err) {
      console.warn('[VaultTracker] Poll error:', err.message);
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  setTimeout(poll, POLL_INTERVAL_MS);
}

function stopTracking() {
  isRunning = false;
  console.log('[VaultTracker] Stopped.');
}

// ─── MANUAL BACKFILL (check last N blocks on startup) ─────────────────────────
async function backfillRecentBlocks(numBlocks = 300) {
  try {
    const latestHex = await rpcCall('eth_blockNumber', []);
    const latest    = parseInt(latestHex, 16);
    const from      = latest - numBlocks;
    console.log(`[VaultTracker] Backfilling blocks ${from.toLocaleString()} → ${latest.toLocaleString()}...`);
    await processBlockRange(from, latest);
    console.log('[VaultTracker] Backfill complete.');
    lastCheckedBlock = latest;
  } catch (err) {
    console.error('[VaultTracker] Backfill error:', err.message);
  }
}

// ─── STATUS REPORT ────────────────────────────────────────────────────────────
async function getStatusReport() {
  try {
    const [blockHex, ethBalHex] = await Promise.all([
      rpcCall('eth_blockNumber', []),
      rpcCall('eth_getBalance', [VAULT_ADDRESS, 'latest']),
    ]);

    const block  = parseInt(blockHex, 16);
    const ethBal = hexToEth(ethBalHex);

    // Active burst tokens
    const now = Date.now();
    const bursts = [];
    for (const [token, history] of buyHistory.entries()) {
      const recent = history.filter(h => now - h.timestamp < BURST_WINDOW_MS);
      if (recent.length > 0) {
        const info = tokenCache.get(token);
        bursts.push({ token, count: recent.length, symbol: info?.symbol || '???' });
      }
    }
    bursts.sort((a, b) => b.count - a.count);

    return {
      embeds: [{
        title: '📊 Vault Tracker — Live Status',
        color: 0x00FF88,
        fields: [
          { name: '🔍 Tracking',    value: `\`${VAULT_ADDRESS}\``, inline: false },
          { name: '📦 Latest Block', value: block.toLocaleString(), inline: true },
          { name: '💎 Vault ETH',    value: `${ethBal.toFixed(4)} ETH`, inline: true },
          { name: '🏃 Running',      value: isRunning ? 'YES' : 'NO', inline: true },
          {
            name: '🔥 Active Bursts (last 1h)',
            value: bursts.length > 0
              ? bursts.map(b => `**${b.symbol}**: ${b.count} buys`).join('\n')
              : 'None detected',
            inline: false,
          },
        ],
        footer: { text: 'Vault Tracker' },
        timestamp: new Date().toISOString(),
      }],
    };
  } catch (err) {
    return { content: `Error fetching status: ${err.message}` };
  }
}

// ─── CURRENT HOLDINGS SNAPSHOT ───────────────────────────────────────────────
async function getHoldingsSnapshot() {
  // Check known active tokens from our investigation
  const knownTokens = [
    { address: '0xA9E23871156718C1D55e90dad1c4ea8a33480DFd', symbol: 'INSTACLAW' },
    { address: '0x797f214a2CD64a4963A91Fa21c8C55Ec3EBa4714', symbol: 'SIBYL' },
    { address: '0x5c72992b83E74c4D5200A8E8920fB946214a5A5D', symbol: 'BEAN' },
    { address: '0x51CE0f584C0Df8505FDdC385b3a46Ac002c2305f', symbol: 'KOI' },
    { address: '0xF4d97F2da56e8c3098f3a8D538DB630A2606a024', symbol: 'DIEM' },
  ];

  const results = [];
  for (const t of knownTokens) {
    try {
      const balHex = await rpcCall('eth_call', [{
        to:   t.address,
        data: '0x70a08231000000000000000000000000' + VAULT_ADDRESS.slice(2),
      }, 'latest']);

      const bal = BigInt(balHex || '0x0');
      if (bal > 0n) {
        const info = await getTokenInfo(t.address);
        results.push({
          symbol:   info.symbol,
          balance:  formatAmount(balHex, info.decimals),
          address:  t.address,
        });
      }
    } catch { /* skip */ }
  }

  const fieldValue = results.length > 0
    ? results.map(r =>
        `**${r.symbol}**: ${r.balance}\n` +
        `[DexScreener](https://dexscreener.com/base/${r.address})`
      ).join('\n\n')
    : 'All known positions appear empty (position may have been cycled)';

  return {
    embeds: [{
      title: '💼 Vault Current Known Holdings',
      description: 'Live balances for vault known active tokens:',
      color: 0x5865F2,
      fields: [{ name: 'Holdings', value: fieldValue, inline: false }],
      footer: { text: `Vault: ${VAULT_ADDRESS}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  startTracking,
  stopTracking,
  setDiscordSender,
  backfillRecentBlocks,
  getStatusReport,
  getHoldingsSnapshot,
  VAULT_ADDRESS,
};
