const { Client, GatewayIntentBits, Events, Collection, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');
const config = require('./config');
const XApiClient = require('./x-api');
const ImageGenerator = require('./image-generator');
const PnlCardGenerator = require('./pnl-card-generator');
const PnlPanelGenerator = require('./pnl-panel-generator');
const NftApiClient = require('./nft-api');
const vaultTracker = require('./vault-tracker');
const fs = require('fs');
const path = require('path');

class DiscordBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    this.xClient = new XApiClient();
    this.imageGenerator = new ImageGenerator();
    this.pnlCardGenerator = new PnlCardGenerator();
    this.pnlPanelGenerator = new PnlPanelGenerator();
    this.nftApi = new NftApiClient(config.alchemy?.apiKey);
    this.commands = new Collection();
    this.userWallets = new Map(); // userId -> wallet address
    this.walletsFile = path.join(__dirname, '..', 'data', 'user-wallets.json');
    this.pendingPnls = new Map(); // userId -> { buffer, filename, collection, wallet, results }
    this.loadWallets();

    this.initializeCommands();
    this.setupEventHandlers();
  }

  initializeCommands() {
    // Define slash commands
    this.commands.set('generate', {
      name: 'generate',
      description: 'Generate a banner with X profile data',
      options: [
        {
          name: 'username',
          type: 3, // STRING
          description: 'X username (without @)',
          required: true
        }
      ]
    });

    this.commands.set('pnl', {
      name: 'pnl',
      description: 'Generate PnL cards for your last 3 held and last 3 sold NFTs',
      options: [
        {
          name: 'wallet',
          type: 3, // STRING
          description: 'Ethereum wallet address (0x...)',
          required: true
        }
      ]
    });

    this.commands.set('pnl_panel', {
      name: 'pnl_panel',
      description: 'Post a persistent NFT profit tracker panel in this channel'
    });

    // ── Vault Tracker Commands ──────────────────────────────────────────────
    this.commands.set('vault_start', {
      name: 'vault_start',
      description: 'Start tracking the alpha vault for buy signals'
    });

    this.commands.set('vault_stop', {
      name: 'vault_stop',
      description: 'Stop the vault tracker'
    });

    this.commands.set('vault_status', {
      name: 'vault_status',
      description: 'Show current vault tracker status and active burst signals'
    });

    this.commands.set('vault_holdings', {
      name: 'vault_holdings',
      description: 'Show current live holdings of the alpha vault'
    });

    this.commands.set('pnl_manual', {
      name: 'pnl_manual',
      description: 'Manually generate a PnL card with your own prices',
      options: [
        {
          name: 'name',
          type: 3, // STRING
          description: 'Token or NFT name',
          required: true
        },
        {
          name: 'buy_price',
          type: 10, // NUMBER
          description: 'Entry / buy price',
          required: true
        },
        {
          name: 'sell_price',
          type: 10, // NUMBER
          description: 'Exit / sell price',
          required: true
        },
        {
          name: 'wallet',
          type: 3, // STRING
          description: 'Wallet name or ENS (optional)',
          required: false
        },
        {
          name: 'currency',
          type: 3, // STRING
          description: 'Currency: ETH, SOL, or USD (default: ETH)',
          required: false,
          choices: [
            { name: 'ETH', value: 'ETH' },
            { name: 'SOL', value: 'SOL' },
            { name: 'USD', value: 'USD' }
          ]
        },
        {
          name: 'image_url',
          type: 3, // STRING
          description: 'Token / NFT image URL (optional)',
          required: false
        }
      ]
    });
  }

  setupEventHandlers() {
    this.client.once(Events.ClientReady, () => {
      console.log(`Ready! Logged in as ${this.client.user.tag}`);
      this.registerCommands();
      this.logStartupEthPrice();

      // Keep-alive to prevent timeouts
      setInterval(() => {
        if (this.client.ws.connection?.readyState === 1) {
          console.log('Connection alive check');
        }
      }, 300000); // Every 5 minutes
    });

    this.client.on(Events.InteractionCreate, async interaction => {
      try {
        if (interaction.isChatInputCommand()) {
          const command = this.commands.get(interaction.commandName);
          if (!command) return;
          await this.executeCommand(interaction);
        } else if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        } else if (interaction.type === InteractionType.ModalSubmit) {
          await this.handleModalSubmit(interaction);
        }
      } catch (error) {
        console.error('Error handling interaction:', error);
        await this.safeInteractionErrorReply(interaction);
      }
    });

    // Handle Discord client errors
    this.client.on('error', error => {
      console.error('Discord client error:', error);
    });

    this.client.on('warn', warning => {
      console.warn('Discord client warning:', warning);
    });
  }

  async logStartupEthPrice() {
    try {
      const price = await this.pnlPanelGenerator.getEthPrice();
      if (price > 0) {
        console.log(`[Startup] ETH/USD price check OK: $${price.toFixed(2)}`);
      } else {
        console.warn('[Startup] ETH/USD price check unavailable; PnL panels will show USD as N/A');
      }
    } catch (error) {
      console.warn(`[Startup] ETH/USD price check failed: ${error.message}`);
    }
  }

  async safeInteractionErrorReply(interaction, content = 'There was an error while executing this command!') {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch (error) {
      // 10062: interaction expired/already consumed; 40060: already acknowledged.
      // These are expected when duplicate bot instances receive the same interaction.
      if (error?.code === 10062 || error?.code === 40060) {
        console.warn(`[Discord] Could not send error reply: ${error.message}`);
        return;
      }
      console.error('Failed to send interaction error reply:', error);
    }
  }

  async registerCommands() {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
      console.log('Started refreshing application (/) commands.');

      // Support multiple guild IDs (comma-separated)
      const guildIds = String(config.discord.guildId || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => /^\d+$/.test(id));

      if (guildIds.length === 0) {
        console.error('No valid DISCORD_GUILD_ID found in config.');
        return;
      }

      for (const guildId of guildIds) {
        try {
          await rest.put(
            Routes.applicationGuildCommands(config.discord.clientId, guildId),
            { body: Array.from(this.commands.values()) }
          );
          console.log(`✅ Commands registered for guild ${guildId}`);
        } catch (err) {
          console.error(`❌ Failed to register commands for guild ${guildId}:`, err.message);
        }
      }
    } catch (error) {
      console.error('Error registering commands:', error);
    }
  }

  async executeCommand(interaction) {
    const { commandName } = interaction;

    if (commandName === 'generate') {
      await this.handleGenerateCommand(interaction);
    } else if (commandName === 'pnl') {
      await this.handlePnlCommand(interaction);
    } else if (commandName === 'pnl_panel') {
      await this.handlePnlPanelCommand(interaction);
    } else if (commandName === 'pnl_manual') {
      await this.handlePnlManualCommand(interaction);
    } else if (commandName === 'vault_start') {
      await this.handleVaultStart(interaction);
    } else if (commandName === 'vault_stop') {
      await this.handleVaultStop(interaction);
    } else if (commandName === 'vault_status') {
      await this.handleVaultStatus(interaction);
    } else if (commandName === 'vault_holdings') {
      await this.handleVaultHoldings(interaction);
    }
  }

  // ── VAULT TRACKER HANDLERS ────────────────────────────────────────────────

  async handleVaultStart(interaction) {
    await interaction.deferReply();

    // Wire up the sender so tracker posts to THIS channel
    vaultTracker.setDiscordSender(async (payload) => {
      try {
        const channel = interaction.channel;
        await channel.send(payload);
      } catch (e) {
        console.error('[VaultTracker] channel send error:', e.message);
      }
    });

    // Backfill last 500 blocks so we catch any recent signals
    await vaultTracker.backfillRecentBlocks(500);
    vaultTracker.startTracking();

    await interaction.editReply({
      embeds: [{
        title: '✅ Vault Tracker Started',
        description:
          `Now monitoring **0x7e74c740...22C90** for buy signals.\n\n` +
          `**How it works:**\n` +
          `• Every new block on Base is scanned\n` +
          `• Any token flowing into the vault = BUY alert\n` +
          `• 3+ buys same token in 1 hour = 🔥 BURST signal\n` +
          `• New token approval = 👁️ pre-buy warning\n\n` +
          `Alerts will appear in this channel. Use \`/vault_status\` anytime.`,
        color: 0x00FF88,
        footer: { text: 'Vault Tracker • Alpha Signal Bot' },
        timestamp: new Date().toISOString(),
      }]
    });
  }

  async handleVaultStop(interaction) {
    vaultTracker.stopTracking();
    await interaction.reply({
      embeds: [{
        title: '🛑 Vault Tracker Stopped',
        description: 'No longer monitoring the vault. Use `/vault_start` to resume.',
        color: 0xFF4444,
        timestamp: new Date().toISOString(),
      }]
    });
  }

  async handleVaultStatus(interaction) {
    await interaction.deferReply();
    const payload = await vaultTracker.getStatusReport();
    await interaction.editReply(payload);
  }

  async handleVaultHoldings(interaction) {
    await interaction.deferReply();
    const payload = await vaultTracker.getHoldingsSnapshot();
    await interaction.editReply(payload);
  }

  async handleButtonInteraction(interaction) {
    const customId = interaction.customId;

    // Panel buttons
    if (customId === 'pnl_panel:connect') {
      return this.handlePanelConnect(interaction);
    }
    if (customId === 'pnl_panel:disconnect') {
      return this.handlePanelDisconnect(interaction);
    }
    if (customId === 'pnl_panel:pnl') {
      return this.handlePanelPnl(interaction);
    }
    if (customId === 'pnl_panel:confirm') {
      return this.handlePanelConfirm(interaction);
    }
    if (customId === 'pnl_panel:decline') {
      return this.handlePanelDecline(interaction);
    }

    if (customId.startsWith('pnl:')) {
      try {
        await interaction.deferUpdate();
      } catch (e) {
        console.error('Failed to defer button:', e.message);
        return;
      }

      // Parse contract, tokenId, mode from customId
      // Format: pnl:CONTRACT:TOKENID:MODE[:INDEX]
      const parts = customId.split(':');
      if (parts.length < 4) {
        await interaction.editReply({
          content: '❌ Invalid button data.',
          components: [],
          embeds: []
        }).catch(() => {});
        return;
      }

      const contract = parts[1];
      const tokenId = parts[2];
      const mode = parts[3];

      // Extract wallet from message footer
      const footerText = interaction.message?.embeds?.[0]?.footer?.text || '';
      const walletMatch = footerText.match(/Wallet: (0x[a-fA-F0-9]{40})/);
      const wallet = walletMatch ? walletMatch[1] : null;

      if (!wallet) {
        await interaction.editReply({
          content: '❌ Could not determine wallet. Please run `/pnl` again.',
          components: [],
          embeds: []
        }).catch(() => {});
        return;
      }

      try {
        await this.generatePnlFromButton(interaction, wallet, contract, tokenId, mode);
      } catch (error) {
        console.error('Error generating PnL from button:', error);
        await interaction.editReply({
          content: `❌ Error generating PnL card: ${error.message}\n\nTry \`/pnl_manual\` instead.`,
          components: [],
          embeds: []
        }).catch(() => {});
      }
    }
  }

  async handlePnlCommand(interaction) {
    const wallet = interaction.options.getString('wallet');

    // Basic ETH address validation
    if (!wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      return interaction.reply({ content: '❌ Invalid Ethereum wallet address. Must be 0x followed by 40 hex characters.', ephemeral: true });
    }

    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('Failed to defer:', e.message);
      return;
    }

    try {
      await interaction.editReply(`🔍 Fetching NFT activity for wallet \`${wallet}\`...`);

      // Fetch both held and sold NFTs in parallel
      const [ownedData, soldData] = await Promise.all([
        this.nftApi.getRecentOwnedNfts(wallet, 3),
        this.nftApi.getRecentSoldNfts(wallet, 3)
      ]);

      if (ownedData.error) {
        return interaction.editReply({ content: `❌ ${ownedData.error}` });
      }

      const heldNfts = ownedData.nfts || [];
      const soldNfts = soldData.nfts || [];

      if (heldNfts.length === 0 && soldNfts.length === 0) {
        return interaction.editReply({
          content: `❌ No NFT activity found for wallet \`${wallet}\`.\n\nThe wallet may be empty or the data isn't indexed yet. Try \`/pnl_manual\` for manual entry.`
        });
      }

      // Build embed description
      let description = '';

      if (heldNfts.length > 0) {
        description += '🖼️ **Recently Acquired (Still Holding)**\n';
        heldNfts.forEach((nft, i) => {
          const floorText = nft.floorPrice > 0.00001 ? ` • Floor: ${nft.floorPrice.toFixed(4)} ETH` : '';
          description += `${i + 1}. **${nft.name}**${floorText}\n`;
        });
        description += '\n';
      }

      if (soldNfts.length > 0) {
        description += '💰 **Recently Sold**\n';
        soldNfts.forEach((nft, i) => {
          const sellText = nft.sellPrice > 0.0001 ? ` • Sold: ${nft.sellPrice.toFixed(4)} ETH` : '';
          description += `${i + 1}. **${nft.name}**${sellText}\n`;
        });
      }

      const embed = {
        title: '📊 Your Recent NFT Activity',
        description: `${description}\nClick a button below to generate a PnL card:`,
        color: 0xc69c6c,
        footer: { text: `Wallet: ${wallet} • Powered by Alchemy` }
      };

      // Build buttons — customId format: pnl:CONTRACT:TOKENID:MODE[:INDEX]
      const rows = [];
      let currentRow = new ActionRowBuilder();
      const usedCustomIds = new Set();

      const createButton = (nft, mode, emoji, style) => {
        // Truncate tokenId if too long for customId (max 100)
        const safeTokenId = nft.tokenId.length > 20 ? nft.tokenId.substring(0, 20) : nft.tokenId;
        let customId = `pnl:${nft.contract}:${safeTokenId}:${mode}`;
        let dedupIndex = 0;
        while (usedCustomIds.has(customId)) {
          dedupIndex++;
          customId = `pnl:${nft.contract}:${safeTokenId}:${mode}:${dedupIndex}`;
        }
        usedCustomIds.add(customId);

        const button = new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(`${nft.name.substring(0, 20)}${nft.name.length > 20 ? '…' : ''}`)
          .setStyle(style)
          .setEmoji(emoji);

        currentRow.addComponents(button);
        if (currentRow.components.length === 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder();
        }
      };

      heldNfts.forEach(nft => createButton(nft, 'hold', '🖼️', ButtonStyle.Primary));
      soldNfts.forEach(nft => createButton(nft, 'sold', '💰', ButtonStyle.Danger));

      if (currentRow.components.length > 0) {
        rows.push(currentRow);
      }

      await interaction.editReply({
        content: `👇 **Pick an NFT to analyze:**`,
        embeds: [embed],
        components: rows
      });

    } catch (error) {
      console.error('Error in pnl command:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ **Error:** ${error.message}\n\nTry \`/pnl_manual\` instead.`);
      } else {
        await interaction.reply({ content: `❌ **Error:** ${error.message}`, ephemeral: true });
      }
    }
  }

  async generatePnlForCollection(interaction, wallet, collectionInput) {
    // This can be called from slash command (with collection) OR button click
    const isButton = interaction.isButton?.();

    if (!isButton) {
      await interaction.editReply(`🔍 Searching collection **${collectionInput}**...`);
    }

    const result = await this.nftApi.analyzeWalletCollection(wallet, collectionInput);

    if (result.error) {
      const suggestionText = result.suggestions?.length ? '\n\n**Did you mean:**\n' + result.suggestions.join('\n') : '';
      const content = `❌ ${result.error}${suggestionText}\n\nUse \`/pnl_manual\` to enter prices manually.`;

      if (isButton) {
        await interaction.editReply({ content, components: [], embeds: [] });
      } else {
        await interaction.editReply({ content });
      }
      return;
    }

    // Validate result data before generating card
    if (!result.collection || result.collection === 'null' || result.collection === 'undefined') {
      const content = `❌ Could not fetch valid collection data. The collection may not be indexed yet.\n\nTry \`/pnl_manual\` instead.`;
      if (isButton) {
        await interaction.editReply({ content, components: [], embeds: [] });
      } else {
        await interaction.editReply({ content });
      }
      return;
    }

    if (!isButton) {
      await interaction.editReply(`🎨 Fetching on-chain data for **${result.collection}**...`);
    }

    // Determine prices based on mode
    const buyPrice = Number(result.buyPrice) || 0;
    const sellPrice = Number(result.sellPrice || result.currentValue) || 0;
    const profit = sellPrice - buyPrice;
    const isProfit = profit >= 0;
    const sign = profit >= 0 ? '+' : '';
    const profitPercent = buyPrice > 0 ? ((profit / buyPrice) * 100) : 0;

    // Generate card
    const cardBuffer = await this.pnlCardGenerator.generatePnlCard({
      name: result.tokenName || result.collection,
      buyPrice,
      sellPrice,
      currency: result.currency || 'ETH',
      wallet: result.wallet,
      imageUrl: result.tokenImage,
      collectionImageUrl: result.collectionImage,
      mode: result.mode,
      entryLabel: result.entryLabel || 'BUY PRICE'
    });

    const embedColor = isProfit ? 0x2ea043 : 0xcf222e;
    const valueLabel = result.mode === 'unrealized'
      ? (Number(result.saleFeeRate) > 0 ? '**NET FLOOR:**' : '**CURRENT FLOOR:**')
      : '**SELL PRICE:**';
    const feeNote = result.mode === 'unrealized' && Number(result.saleFeeRate) > 0
      ? `\n**Sale Fees:** ${(Number(result.saleFeeRate) * 100).toFixed(2)}% estimated royalties/marketplace fees`
      : '';

    const statusText = result.mode === 'unrealized'
      ? (isProfit ? '🟢 **Holding — In Profit (Floor)**' : '🔴 **Holding — In Loss (Floor)**')
      : (isProfit ? '🟢 **Trade Closed — In Profit**' : '🔴 **Trade Closed — In Loss**');

    const embed = {
      title: `PnL Card — ${result.tokenName || result.collection}`,
      description:
        `**Collection:** ${result.collection}\n` +
        `**${result.entryLabel || 'BUY PRICE'}:** ${buyPrice} ETH\n` +
        `${valueLabel} ${sellPrice} ETH${feeNote}\n` +
        `**Result:** ${sign}${profit.toFixed(4)} ETH (${sign}${profitPercent.toFixed(2)}%)`,
      color: embedColor,
      image: { url: 'attachment://pnl_card.png' },
      footer: { text: `Wallet: ${result.wallet} • Via Alchemy` },
      timestamp: new Date().toISOString()
    };

    if (isButton) {
      await interaction.editReply({
        content: statusText,
        embeds: [embed],
        files: [{ attachment: cardBuffer, name: 'pnl_card.png' }],
        components: []
      });
    } else {
      await interaction.editReply({
        content: statusText,
        embeds: [embed],
        files: [{ attachment: cardBuffer, name: 'pnl_card.png' }]
      });
    }

    console.log(`Auto PnL card generated for ${result.collection}`);
  }

  async generatePnlForSoldCollection(interaction, wallet, contractInput) {
    const isButton = interaction.isButton?.();

    if (!isButton) {
      await interaction.editReply(`🔍 Analyzing sold NFTs for **${contractInput}**...`);
    }

    const result = await this.nftApi.analyzeSoldCollection(wallet, contractInput);

    if (result.error) {
      const content = `❌ ${result.error}\n\nUse \`/pnl_manual\` to enter prices manually.`;
      if (isButton) {
        await interaction.editReply({ content, components: [], embeds: [] });
      } else {
        await interaction.editReply({ content });
      }
      return;
    }

    if (!isButton) {
      await interaction.editReply(`🎨 Generating realized PnL card for **${result.collection}**...`);
    }

    const buyPrice = Number(result.buyPrice) || 0;
    const sellPrice = Number(result.sellPrice) || 0;
    const profit = sellPrice - buyPrice;
    const isProfit = profit >= 0;
    const sign = profit >= 0 ? '+' : '';
    const profitPercent = buyPrice > 0 ? ((profit / buyPrice) * 100) : 0;

    const cardBuffer = await this.pnlCardGenerator.generatePnlCard({
      name: result.tokenName || result.collection,
      buyPrice,
      sellPrice,
      currency: 'ETH',
      wallet: result.wallet,
      imageUrl: result.tokenImage,
      collectionImageUrl: result.collectionImage,
      mode: 'realized',
      entryLabel: result.entryLabel || 'BUY PRICE'
    });

    const embedColor = isProfit ? 0x2ea043 : 0xcf222e;

    const statusText = isProfit
      ? '🟢 **Trade Closed — In Profit**'
      : '🔴 **Trade Closed — In Loss**';

    const embed = {
      title: `PnL Card — ${result.tokenName || result.collection} (SOLD)`,
      description:
        `**Collection:** ${result.collection}\n` +
        `**${result.entryLabel || 'BUY PRICE'}:** ${buyPrice} ETH\n` +
        `**SELL PRICE:** ${sellPrice} ETH\n` +
        `**Result:** ${sign}${profit.toFixed(4)} ETH (${sign}${profitPercent.toFixed(2)}%)`,
      color: embedColor,
      image: { url: 'attachment://pnl_card.png' },
      footer: { text: `Wallet: ${result.wallet} • Via Alchemy` },
      timestamp: new Date().toISOString()
    };

    if (isButton) {
      await interaction.editReply({
        content: statusText,
        embeds: [embed],
        files: [{ attachment: cardBuffer, name: 'pnl_card.png' }],
        components: []
      });
    } else {
      await interaction.editReply({
        content: statusText,
        embeds: [embed],
        files: [{ attachment: cardBuffer, name: 'pnl_card.png' }]
      });
    }

    console.log(`Sold PnL card generated for ${result.collection}`);
  }

  async generatePnlFromButton(interaction, wallet, contract, tokenId, mode) {
    const result = await this.nftApi.analyzeNft(wallet, contract, tokenId, mode);

    if (result.error) {
      const content = `❌ ${result.error}\n\nUse \`/pnl_manual\` to enter prices manually.`;
      await interaction.editReply({ content, components: [], embeds: [] }).catch(() => {});
      return;
    }

    const buyDetected = result.buyDetected;
    const sellDetected = result.sellDetected;
    const floorDetected = result.floorDetected || false;
    const buyPrice = Number(result.buyPrice) || 0;
    const currentFloor = Number(result.currentValue) || 0;
    const sellPrice = mode === 'sold'
      ? Number(result.sellPrice) || 0
      : currentFloor;

    // Determine display values
    const buyDisplay = buyDetected && buyPrice > 0 ? `${buyPrice.toFixed(4)} ETH` : 'Unknown';
    const sellDisplay = mode === 'sold'
      ? (sellDetected && sellPrice > 0 ? `${sellPrice.toFixed(4)} ETH` : 'Unknown')
      : (floorDetected && currentFloor > 0.00001 ? `${currentFloor.toFixed(4)} ETH` : 'Not found');
    const valueLabel = mode === 'sold'
      ? '**SELL PRICE:**'
      : (Number(result.saleFeeRate) > 0 ? '**NET FLOOR:**' : '**CURRENT FLOOR:**');
    const feeNote = mode !== 'sold' && Number(result.saleFeeRate) > 0
      ? `**Sale Fees:** ${(Number(result.saleFeeRate) * 100).toFixed(2)}% estimated royalties/marketplace fees\n`
      : '';

    // Calculate profit only when both prices are known
    let profit = 0;
    let isProfit = true;
    let sign = '+';
    let profitPercent = 0;
    let percentText = 'N/A';
    let canCalculatePnl = false;

    if (mode === 'sold' && sellDetected && sellPrice > 0 && buyDetected && buyPrice > 0) {
      profit = sellPrice - buyPrice;
      isProfit = profit >= 0;
      sign = isProfit ? '+' : '';
      profitPercent = buyPrice > 0 ? (profit / buyPrice) * 100 : 0;
      percentText = `${sign}${profitPercent.toFixed(2)}%`;
      canCalculatePnl = true;
    } else if (mode !== 'sold' && floorDetected && currentFloor > 0.00001) {
      profit = currentFloor - buyPrice;
      isProfit = profit >= 0;
      sign = isProfit ? '+' : '';
      if (buyDetected && buyPrice > 0) {
        profitPercent = (profit / buyPrice) * 100;
        percentText = `${sign}${profitPercent.toFixed(2)}%`;
      } else if (profit > 0) {
        percentText = '+∞% (Free Mint / Airdrop)';
      }
      canCalculatePnl = true;
    }

    const cardBuffer = await this.pnlCardGenerator.generatePnlCard({
      name: result.tokenName || result.collection,
      buyPrice: buyDetected && buyPrice > 0 ? buyPrice : 0,
      sellPrice: mode === 'sold'
        ? (sellDetected && sellPrice > 0 ? sellPrice : 0)
        : (floorDetected && currentFloor > 0.00001 ? currentFloor : 0),
      currency: 'ETH',
      wallet: result.wallet,
      imageUrl: result.tokenImage,
      collectionImageUrl: result.collectionImage,
      mode: result.mode,
      entryLabel: result.entryLabel || 'BUY PRICE'
    });

    const embedColor = canCalculatePnl ? (isProfit ? 0x2ea043 : 0xcf222e) : 0xf0a500;

    const statusText = mode === 'sold'
      ? (canCalculatePnl ? (isProfit ? '🟢 **Trade Closed — In Profit**' : '🔴 **Trade Closed — In Loss**') : '⚠️ **Trade Closed — Prices Unknown**')
      : (canCalculatePnl ? (isProfit ? '🟢 **Holding — In Profit (Floor)**' : '🔴 **Holding — In Loss (Floor)**') : '⚠️ **Holding — Floor Price Unavailable**');

    let description = `**Collection:** ${result.collection}\n`;
    description += `**${result.entryLabel || 'BUY PRICE'}:** ${buyDisplay}\n`;
    description += `${valueLabel} ${sellDisplay}\n`;
    description += feeNote;

    if (canCalculatePnl) {
      description += `**Result:** ${sign}${profit.toFixed(4)} ETH (${percentText})`;
    } else {
      description += "**Result:** Cannot calculate — buy/sell prices not detected. This can happen with WETH sales, private sales, or older transactions. Try `/pnl_manual` to enter prices manually.";
    }

    const embed = {
      title: `PnL Card — ${result.tokenName || result.collection}`,
      description,
      color: embedColor,
      image: { url: 'attachment://pnl_card.png' },
      footer: { text: `Wallet: ${result.wallet} • Via Alchemy` },
      timestamp: new Date().toISOString()
    };

    await interaction.editReply({
      content: statusText,
      embeds: [embed],
      files: [{ attachment: cardBuffer, name: 'pnl_card.png' }],
      components: []
    });

    console.log(`PnL card generated for ${result.tokenName} (${mode})`);
  }

  async handlePnlManualCommand(interaction) {
    const name = interaction.options.getString('name');
    const buyPrice = interaction.options.getNumber('buy_price');
    const sellPrice = interaction.options.getNumber('sell_price');
    const wallet = interaction.options.getString('wallet');
    const currency = interaction.options.getString('currency') || 'ETH';
    const imageUrl = interaction.options.getString('image_url');

    if (buyPrice < 0 || sellPrice < 0) {
      return interaction.reply({ content: '❌ Prices cannot be negative.', ephemeral: true });
    }

    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('Failed to defer:', e.message);
      return;
    }

    try {
      await interaction.editReply(`🎨 Generating PnL card for **${name}**...`);

      const cardBuffer = await this.pnlCardGenerator.generatePnlCard({
        name,
        buyPrice,
        sellPrice,
        currency,
        wallet,
        imageUrl,
        mode: 'manual',
        entryLabel: 'BUY PRICE'
      });

      const profit = sellPrice - buyPrice;
      const isProfit = profit >= 0;
      const sign = profit >= 0 ? '+' : '';
      const profitPercent = buyPrice > 0 ? ((profit / buyPrice) * 100) : 0;

      const embedColor = isProfit ? 0x2ea043 : 0xcf222e;

      const embed = {
        title: `PnL Card — ${name} (MANUAL)`,
        description:
          `**Buy:** ${buyPrice} ${currency}\n` +
          `**Sell:** ${sellPrice} ${currency}\n` +
          `**Result:** ${sign}${profit.toFixed(4)} ${currency} (${sign}${profitPercent.toFixed(2)}%)`,
        color: embedColor,
        image: { url: 'attachment://pnl_card.png' },
        footer: { text: wallet ? `Wallet: ${wallet}` : 'VELIST PnL Generator' },
        timestamp: new Date().toISOString()
      };

      await interaction.editReply({
        content: isProfit ? '🟢 **Trade Closed — In Profit**' : '🔴 **Trade Closed — In Loss**',
        embeds: [embed],
        files: [{ attachment: cardBuffer, name: 'pnl_card.png' }]
      });

      console.log(`Manual PnL card generated for ${name}`);
    } catch (error) {
      console.error('Error in pnl_manual command:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ **Error:** ${error.message}`);
      } else {
        await interaction.reply({ content: `❌ **Error:** ${error.message}`, ephemeral: true });
      }
    }
  }

  async handleGenerateCommand(interaction) {
    const username = interaction.options.getString('username');

    // Acknowledge the interaction immediately to prevent timeout
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('Failed to defer:', e.message);
      return;
    }

    try {
      // Step 1: Fetch user profile from X
      await interaction.editReply(`🔍 Fetching X profile for **@${username}**...`);
      const userData = await this.xClient.getUserProfile(username);

      // Step 2: Download profile image
      await interaction.editReply(`📥 Downloading profile image for **${userData.name}** (@${userData.username})...`);
      const profileImageBuffer = await this.xClient.downloadImage(userData.profileImageUrl);

      // Step 3: Generate banner
      await interaction.editReply(`🎨 Generating custom VELTCOR3 banner...`);
      const bannerBuffer = await this.imageGenerator.generateBanner(userData, profileImageBuffer);

      // Step 4: Post to Discord channel (for logging/storage)
      await interaction.editReply(`📤 Posting to Discord and X...`);
      const channel = await this.client.channels.fetch(config.discord.channelId);

      const message = await channel.send({
        content: `Congrats ${userData.username}!\n\n${userData.username} has been approved for VELIST.`,
        files: [{ attachment: bannerBuffer, name: `veltcor3_banner_${username}.png` }]
      });

      // Step 5: Post to X
      const tweetText = `Congrats @${username}\n\nYou’ve been approved for VELIST.\n\nWelcome to VELCORIANS.`;
      const tweet = await this.xClient.postToX(bannerBuffer, tweetText);

      // Final confirmation
      const tweetUrl = tweet.data.id === 'scraper_post_success'
        ? `https://x.com/${process.env.X_BOT_USERNAME || 'yakup_karaca_'}`
        : `https://x.com/status/${tweet.data.id}`;

      await interaction.editReply({
        content: `✅ **Success!** Banner generated and posted.\n\n🔗 **View on X:** ${tweetUrl}\n📍 **Stored in:** ${message.url}`,
      });

      console.log(`Successfully completed banner generation for @${username}`);

    } catch (error) {
      console.error('Error in generate command:', error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ **Error:** ${error.message}`);
      } else {
        await interaction.reply({ content: `❌ **Error:** ${error.message}`, flags: [64] });
      }
    }
  }

  // ─── Panel System ───

  async handlePnlPanelCommand(interaction) {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      console.error('Failed to defer:', e.message);
      return;
    }

    try {
      const channel = interaction.channel;
      const message = await this.postPnlPanel(channel);
      await interaction.editReply(`✅ Profit tracker panel posted! ${message.url}`);
    } catch (error) {
      console.error('Error posting panel:', error);
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  }

  buildPanelEmbed(wallet) {
    const baseDescription = wallet
      ? `✅ **Wallet connected:** \`${wallet}\`\n\nClick **📊 My PnL** to analyze a collection.`
      : '**Track your NFT collection profits with on-chain data.**\n\n1. Click **🔗 Connect Wallet** to link your ETH address\n2. Click **📊 My PnL** and enter a collection contract or OpenSea link';

    return {
      title: '📊 V3 PNL — NFT Profit Tracker',
      description: `${baseDescription}\n\n**━━━━━━━━━━━━━━━━━━━━━━━**`,
      color: wallet ? 0x2ea043 : 0xc69c6c,
      image: { url: 'attachment://banner.jpg' },
      fields: [
        {
          name: '🖼️ PnL Panel',
          value:
            '• Connect your Ethereum wallet once\n' +
            '• Click **My PnL** and paste any collection contract\n' +
            '• Get a full breakdown: Bought, Sold, Holding, Profit, ROI\n' +
            '• Gas fees and hold time included automatically',
          inline: false
        },
        {
          name: '💡 Tips',
          value:
            '• Collection contract looks like `0x1234...abcd`\n' +
            '• You can also paste an OpenSea asset URL\n' +
            '• Wallet stays connected until you click **Disconnect**',
          inline: false
        }
      ],
      footer: { text: 'Created by Sultan' },
      timestamp: new Date().toISOString()
    };
  }

  buildPanelEmbed(wallet) {
    const baseDescription = wallet
      ? `✅ **Wallet connected:** \`${wallet}\`\n\nClick **📊 My PnL** to scan a collection.`
      : '**Track NFT collection profit/loss with on-chain data.**\n\n1. Click **🔗 Connect Wallet** to link your ETH wallet\n2. Click **📊 My PnL** and paste a collection contract or OpenSea link';

    return {
      title: '📊 V3 PNL — NFT Profit Tracker',
      description: `${baseDescription}\n\n**━━━━━━━━━━━━━━━━━━━━━━━**`,
      color: wallet ? 0x2ea043 : 0xc69c6c,
      image: { url: 'attachment://banner.jpg' },
      fields: [
        {
          name: '🖼️ What It Tracks',
          value:
            '• Minted, bought, sold, and currently held NFTs\n' +
            '• Spent, sales, unrealized profit, total PnL, and ROI\n' +
            '• Gas fees, batch buys/sells, and transferred-out NFTs\n' +
            '• Exact / estimated / unknown data confidence in preview',
          inline: false
        },
        {
          name: '🔗 Supported Inputs',
          value:
            '• Collection contract like `0x1234...abcd`\n' +
            '• OpenSea collection URL: `opensea.io/collection/...`\n' +
            '• OpenSea asset URL: `opensea.io/assets/ethereum/...`\n' +
            '• Ethereum mainnet collections only',
          inline: false
        },
        {
          name: '💡 If No Activity Shows',
          value:
            '• Confirm the connected wallet is the one that traded the NFTs\n' +
            '• Some OpenSea collections use multiple or wrapped contracts\n' +
            '• Send an asset link or transaction hash if a collection link looks wrong',
          inline: false
        }
      ],
      footer: { text: 'Created by Sultan' },
      timestamp: new Date().toISOString()
    };
  }

  buildPanelComponents() {
    // The panel is a single shared message used by everyone, so it always shows
    // the same two generic buttons. If a user already has a wallet connected,
    // clicking "Connect Wallet" shows them an ephemeral status with a Disconnect option.
    const row = new ActionRowBuilder();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('pnl_panel:connect')
        .setLabel('🔗 Connect Wallet')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('pnl_panel:pnl')
        .setLabel('📊 My PnL')
        .setStyle(ButtonStyle.Success)
    );
    return [row];
  }

  async postPnlPanel(channel) {
    const embed = this.buildPanelEmbed(null);
    const components = this.buildPanelComponents();
    const bannerPath = path.join(__dirname, '..', 'banner.jpg');
    const files = [];
    if (fs.existsSync(bannerPath)) {
      files.push({ attachment: bannerPath, name: 'banner.jpg' });
    }
    return channel.send({ embeds: [embed], components, files });
  }

  // Build a private (ephemeral) embed showing the user's own connected wallet
  buildWalletStatusEmbed(wallet) {
    return {
      title: '🔗 Wallet Connection',
      description: wallet
        ? `✅ **You are connected with:**\n\`${wallet}\`\n\nClick **📊 My PnL** on the panel to analyze a collection.`
        : '❌ **No wallet connected.**\n\nClick **🔗 Connect Wallet** on the panel to link your ETH address.',
      color: wallet ? 0x2ea043 : 0x9ca3af,
      footer: { text: 'Only you can see this • Your wallet is private' }
    };
  }

  async handlePanelConnect(interaction) {
    // If the user already has a wallet, show ephemeral status with a Disconnect button
    // instead of opening the connect modal. They must disconnect first to switch wallets.
    const existing = this.getWallet(interaction.user.id);
    if (existing) {
      const disconnectRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pnl_panel:disconnect')
          .setLabel('❌ Disconnect')
          .setStyle(ButtonStyle.Danger)
      );
      return interaction.reply({
        content: `✅ **Wallet already connected:** \`${existing}\`\n\nUse **📊 My PnL** to analyze a collection, or click **Disconnect** below to connect a different wallet.`,
        components: [disconnectRow],
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('pnl_panel:wallet_modal')
      .setTitle('Connect Ethereum Wallet');

    const walletInput = new TextInputBuilder()
      .setCustomId('wallet_input')
      .setLabel('Your Wallet Address')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0x...')
      .setRequired(true)
      .setMaxLength(42)
      .setMinLength(42);

    modal.addComponents(new ActionRowBuilder().addComponents(walletInput));
    await interaction.showModal(modal);
  }

  async handlePanelDisconnect(interaction) {
    this.reloadWallets();
    const had = this.userWallets.get(interaction.user.id);
    this.userWallets.delete(interaction.user.id);
    this.saveWallets();

    const content = had
      ? `✅ Disconnected wallet \`${had}\`. Click **🔗 Connect Wallet** on the panel to connect a new one.`
      : 'ℹ️ You had no wallet connected.';

    // If this button was clicked from inside the ephemeral status message, update it
    // in place so the Disconnect button disappears. Otherwise reply fresh ephemerally.
    if (interaction.message?.flags?.has?.(64) || interaction.message?.flags?.bitfield === 64) {
      await interaction.update({ content, components: [], embeds: [this.buildWalletStatusEmbed(null)] });
    } else {
      await interaction.reply({ content, embeds: [this.buildWalletStatusEmbed(null)], ephemeral: true });
    }
  }

  async handlePanelPnl(interaction) {
    const wallet = this.getWallet(interaction.user.id);
    if (!wallet) {
      return interaction.reply({
        content: '❌ Please connect your wallet first using the **🔗 Connect Wallet** button.',
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('pnl_panel:collection_modal')
      .setTitle('Enter Collection');

    const collectionInput = new TextInputBuilder()
      .setCustomId('collection_input')
      .setLabel('Contract Address or OpenSea Link')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0x... or https://opensea.io/assets/ethereum/0x.../123')
      .setRequired(true)
      .setMaxLength(120);

    modal.addComponents(new ActionRowBuilder().addComponents(collectionInput));
    await interaction.showModal(modal);
  }

  async handlePanelConfirm(interaction) {
    const pending = this.pendingPnls.get(interaction.user.id);
    if (!pending) {
      return interaction.reply({
        content: '❌ Preview expired. Please generate a new PnL panel.',
        ephemeral: true
      });
    }

    try {
      await interaction.deferUpdate();

      // Support comma-separated channel IDs — pick first valid one
      const channelIds = String(config.discord.pnlChannelId || config.discord.channelId || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => /^\d+$/.test(id));

      if (channelIds.length === 0) {
        await interaction.editReply({
          content: '❌ No valid PnL channel configured. Please check `DISCORD_PNL_CHANNEL_ID` in your `.env`.',
          components: [],
          files: [],
          embeds: []
        });
        return;
      }

      const channelId = channelIds[0];
      const channel = await this.client.channels.fetch(channelId);

      if (!channel) {
        await interaction.editReply({
          content: '❌ Could not find the PnL channel. Please check configuration.',
          components: [],
          files: [],
          embeds: []
        });
        return;
      }

      await channel.send({
        content: `${pending.isProfit ? '🟢' : '🔴'} **${pending.collection} — Collection PnL**\n<@${pending.userId}> | NFTs: ${pending.results.length} (${pending.holdingCount} holding, ${pending.soldCount} sold)`,
        files: [{ attachment: pending.buffer, name: pending.filename }]
      });

      this.pendingPnls.delete(interaction.user.id);

      await interaction.editReply({
        content: `✅ **Sent to <#${channelId}>!**\n\nYour ${pending.collection} PnL panel has been posted.`,
        components: [],
        files: [],
        embeds: []
      });
    } catch (error) {
      console.error('Error confirming PnL panel:', error);
      await interaction.editReply({
        content: `❌ Failed to send: ${error.message}`,
        components: [],
        files: [],
        embeds: []
      });
    }
  }

  async handlePanelDecline(interaction) {
    this.pendingPnls.delete(interaction.user.id);
    await interaction.update({
      content: '❌ PnL panel cancelled.',
      components: [],
      files: [],
      embeds: []
    });
  }

  async handleModalSubmit(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('pnl_panel:wallet_modal')) {
      await this.handleWalletModal(interaction);
    } else if (customId === 'pnl_panel:collection_modal') {
      await this.handleCollectionModal(interaction);
    }
  }

  async handleWalletModal(interaction) {
    const wallet = interaction.fields.getTextInputValue('wallet_input').trim();

    if (!wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      return interaction.reply({
        content: '❌ Invalid Ethereum wallet address. Must be 0x followed by 40 hex characters.',
        ephemeral: true
      });
    }

    this.reloadWallets();
    this.userWallets.set(interaction.user.id, wallet);
    this.saveWallets();

    // Show the connected wallet privately — only this user sees which wallet they linked.
    // The shared panel stays generic so other users' wallets never appear there.
    await interaction.reply({
      embeds: [this.buildWalletStatusEmbed(wallet)],
      ephemeral: true
    });
  }

  async handleCollectionModal(interaction) {
    const wallet = this.getWallet(interaction.user.id);
    if (!wallet) {
      return interaction.reply({
        content: '❌ Wallet disconnected. Please connect again.',
        ephemeral: true
      });
    }

    const input = interaction.fields.getTextInputValue('collection_input').trim();
    const parsed = this.nftApi.parseOpenSeaUrl(input);

    if (!parsed) {
      return interaction.reply({
        content: '❌ Invalid input. Please provide a contract address (0x...) or OpenSea URL.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    if (parsed.slug) {
      await interaction.editReply(`🔍 Resolving collection **"${parsed.slug}"** via OpenSea...`);
      const resolvedContract = await this.nftApi.resolveSlugToContract(parsed.slug);
      if (!resolvedContract) {
        return interaction.editReply(
          `❌ Could not resolve **"${parsed.slug}"** to an Ethereum contract. Please provide the contract address directly (\`0x...\`).`
        );
      }
      parsed.contract = resolvedContract;
    }

    const contract = parsed.contract;
    const collectionLabel = parsed.slug ? `${parsed.slug} (${contract})` : contract;
    await interaction.editReply(`🔍 Analyzing collection \`${collectionLabel}\` for wallet \`${wallet}\`... This may take a moment.`);

    try {
      const results = await this.nftApi.analyzeCollectionPnL(wallet, contract);

      // Validation / lookup errors come back as a single { error } row
      if (results[0]?.error) {
        return interaction.editReply(`❌ ${results[0].error}`);
      }

      if (!Array.isArray(results) || results.length === 0) {
        return interaction.editReply(
          `❌ **No activity found.**\nWallet \`${wallet}\` has never held or traded any NFTs from collection \`${contract}\` on Ethereum.\n\nMake sure you're using the right wallet and that the collection is on **Ethereum mainnet** (not Base/Polygon/etc).`
        );
      }

      await this.sendCollectionPnLEmbed(interaction, results);
    } catch (error) {
      console.error('[PnL] Error analyzing collection:', error);
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  }

  async sendCollectionPnLEmbed(interaction, results) {
    let totalProfit = 0;
    let totalGas = 0;
    let totalBought = 0;
    let totalBuyGas = 0;
    let totalSold = 0;
    let totalHolding = 0;
    let totalUnrealizedProfit = 0;
    let holdingCount = 0;
    let soldCount = 0;

    // Minted vs bought split (acquisition method, independent of later sale).
    // A free mint has buyLabel 'MINT PRICE'/'MINT FEE'; a secondary buy is 'BUY PRICE'.
    // Mint/buy counts span both held and sold NFTs (a sold NFT was still minted/bought),
    // so they intentionally overlap with soldCount — matching the reference card.
    let mintedCount = 0;
    let mintedPriceSum = 0;
    let boughtCount = 0;
    let boughtPriceSum = 0;
    let soldPriceSum = 0;
    let confidenceExact = 0;
    let confidenceEstimated = 0;
    let confidenceUnknown = 0;

    let transferredOutCount = 0;
    for (const r of results) {
      // NFTs transferred out with no proceeds (moved to own wallet/staking/gifted)
      // are excluded from all totals — we can't value them. Count for the note only.
      if (r.mode === 'transferred_out') {
        transferredOutCount++;
        continue;
      }
      totalGas += r.gasFees;
      totalBuyGas += r.buyExtraGas || 0;
      if (r.buyDetected && r.buyPrice > 0) {
        totalBought += r.buyPrice;
      }

      // Classify acquisition method for the MINTED / BOUGHT slots.
      const isMint = r.buyLabel === 'MINT PRICE' || r.buyLabel === 'MINT FEE';
      const isBuy = r.buyLabel === 'BUY PRICE';
      if (isMint) {
        mintedCount++;
        if (r.buyDetected && r.buyPrice > 0) mintedPriceSum += r.buyPrice;
      } else if (isBuy) {
        boughtCount++;
        if (r.buyDetected && r.buyPrice > 0) boughtPriceSum += r.buyPrice;
      }

      if (r.mode === 'sold') {
        soldCount++;
        if (r.sellDetected) {
          totalSold += r.sellPrice;
          soldPriceSum += r.sellPrice;
        }
      } else {
        holdingCount++;
        if (r.currentFloor > 0.00001) totalHolding += r.currentFloor;
        if (r.profit !== null) totalUnrealizedProfit += r.profit;
      }
      if (r.profit !== null) {
        totalProfit += r.profit;
      }

      const rowConfidence = [
        r.buyConfidence || (r.buyDetected ? 'exact' : 'unknown'),
        r.mode === 'sold'
          ? (r.sellConfidence || (r.sellDetected ? 'exact' : 'unknown'))
          : (r.floorConfidence || 'unknown')
      ];
      if (rowConfidence.includes('unknown')) {
        confidenceUnknown++;
      } else if (rowConfidence.includes('estimated')) {
        confidenceEstimated++;
      } else {
        confidenceExact++;
      }
    }

    // Averages for each slot (avg mint price, avg buy price, avg sale price, net floor/item).
    const mintedAvgEth = mintedCount > 0 ? mintedPriceSum / mintedCount : 0;
    const boughtAvgEth = boughtCount > 0 ? boughtPriceSum / boughtCount : 0;
    const soldAvgEth = soldCount > 0 ? soldPriceSum / soldCount : 0;
    const holdingFloorEth = holdingCount > 0 ? totalHolding / holdingCount : 0;

    const isProfit = totalProfit >= 0;
    const collection = results[0]?.collection || 'Unknown';
    const wallet = results[0]?.wallet || this.userWallets.get(interaction.user.id) || 'Unknown';

    // Count how many NFTs were transferred/gifted (no payment detected)
    const transferredCount = results.filter(r => r.buyLabel === 'TRANSFERRED').length;

    // If no spend is known, keep infinity/N/A behavior; otherwise ROI uses spend including buy gas.
    const totalSpent = totalBought + totalBuyGas;
    const totalRoi = totalSpent > 0
      ? (totalProfit / totalSpent * 100)
      : (totalProfit > 0 ? Infinity : 0);
    const saleFeeRate = Math.max(
      0,
      ...results
        .filter(r => r.mode === 'holding')
        .map(r => Number(r.saleFeeRate) || 0)
    );

    console.log(`[PnL] ${collection}: BOUGHT ${totalBought.toFixed(4)} + GAS ${totalBuyGas.toFixed(4)} = ${totalSpent.toFixed(4)} | SOLD ${totalSold.toFixed(4)} | HOLDING ${totalHolding.toFixed(4)} (${holdingCount}) | UNREALIZED ${totalUnrealizedProfit.toFixed(4)} ETH | P&L ${totalProfit.toFixed(4)} ETH | ROI ${isFinite(totalRoi) ? totalRoi.toFixed(1) + '%' : '∞'} | ${transferredOutCount} moved out`);

    const generatedAt = new Date();
    const generatedDate = generatedAt.toLocaleDateString('en-GB', { timeZone: 'UTC' });
    const generatedTime = generatedAt.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }) + ' UTC';

    // Prepare data for image generator
    const panelData = {
      collection: collection.substring(0, 18),
      totalBoughtEth: totalSpent, // price paid + buy gas
      totalSoldEth: totalSold,
      holdingCount: holdingCount,
      totalHoldingEth: totalHolding,
      totalUnrealizedProfit,
      // ── 4-slot breakdown (MINTED · BOUGHT · SOLD · HOLDING): count + avg price ──
      mintedCount,
      mintedAvgEth,
      boughtCount,
      boughtAvgEth,
      soldCount,
      soldAvgEth,
      holdingFloorEth,
      totalProfit: totalProfit,
      totalRoi: totalRoi,
      saleFeeRate,
      confidenceExact,
      confidenceEstimated,
      confidenceUnknown,
      transferredCount: transferredCount,  // NFTs received as gifts/transfers
      date: generatedDate,
      time: generatedTime,
      trader: interaction.user.username.substring(0, 15)
    };

    try {
      await interaction.editReply(`🎨 Generating ${isProfit ? 'WIN' : 'LOSS'} PnL panel...`);
      const imageBuffer = await this.pnlPanelGenerator.generatePanel(panelData, isProfit ? 'win' : 'loss');

      // Store for confirm/decline
      this.pendingPnls.set(interaction.user.id, {
        buffer: imageBuffer,
        filename: 'pnl_panel.png',
        collection,
        wallet,
        results,
        holdingCount,
        soldCount,
        isProfit,
        userId: interaction.user.id
      });

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pnl_panel:confirm')
          .setLabel('✅ Confirm & Send')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('pnl_panel:decline')
          .setLabel('❌ Decline')
          .setStyle(ButtonStyle.Danger)
      );

      const movedOutNote = transferredOutCount > 0
        ? `\n📦 ${transferredOutCount} NFT${transferredOutCount > 1 ? 's' : ''} moved out (no sale proceeds) — excluded from P&L`
        : '';
      const confidenceNote = `\nData confidence: ${confidenceExact} exact, ${confidenceEstimated} estimated, ${confidenceUnknown} unknown`;

      await interaction.editReply({
        content: `👁️ **Preview — ${collection} PnL**\n<@${interaction.user.id}> | NFTs: ${holdingCount + soldCount} (${holdingCount} holding, ${soldCount} sold)${movedOutNote}${confidenceNote}\n\nClick **Confirm** to post this to the PnL channel, or **Decline** to cancel.`,
        files: [{ attachment: imageBuffer, name: 'pnl_panel.png' }],
        embeds: [],
        components: [confirmRow]
      });
    } catch (error) {
      console.error('Error generating PnL panel image:', error);
      // Fallback to text embed
      await interaction.editReply({
        content: `❌ Failed to generate image: ${error.message}\n\nFalling back to text summary...`,
        embeds: [{
          title: `📊 ${collection} — Collection PnL`,
          description: `**Wallet:** \`${wallet}\`\n**NFTs:** ${results.length}\n**Total P&L:** ${totalProfit.toFixed(4)} ETH\n**Total Gas:** ${totalGas.toFixed(4)} ETH`,
          color: isProfit ? 0x2ea043 : 0xcf222e
        }]
      });
    }
  }

  loadWallets() {
    try {
      if (fs.existsSync(this.walletsFile)) {
        const data = JSON.parse(fs.readFileSync(this.walletsFile, 'utf8'));
        if (typeof data === 'object' && data !== null) {
          for (const [userId, wallet] of Object.entries(data)) {
            if (typeof wallet === 'string' && wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
              this.userWallets.set(userId, wallet);
            }
          }
          console.log(`Loaded ${this.userWallets.size} wallet(s) from disk.`);
        }
      }
    } catch (e) {
      console.warn('Failed to load wallets:', e.message);
    }
  }

  saveWallets() {
    try {
      const dir = path.dirname(this.walletsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this.userWallets);
      fs.writeFileSync(this.walletsFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('Failed to save wallets:', e.message);
    }
  }

  reloadWallets() {
    try {
      if (fs.existsSync(this.walletsFile)) {
        const data = JSON.parse(fs.readFileSync(this.walletsFile, 'utf8'));
        if (typeof data === 'object' && data !== null) {
          for (const [userId, wallet] of Object.entries(data)) {
            if (typeof wallet === 'string' && wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
              this.userWallets.set(userId, wallet);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to reload wallets:', e.message);
    }
  }

  getWallet(userId) {
    this.reloadWallets();
    return this.userWallets.get(userId) || null;
  }

  async start() {
    try {
      console.log('Starting Discord bot...');
      console.log('⚠️  IMPORTANT: Make sure no other bot instance is running (check PM2)!');
      await this.client.login(config.discord.token);
      console.log('Bot started successfully!');
    } catch (error) {
      console.error('Failed to start bot:', error);

      // Try to reconnect after delay
      console.log('Attempting to reconnect in 10 seconds...');
      setTimeout(() => {
        this.start().catch(err => {
          console.error('Reconnection failed:', err);
          process.exit(1);
        });
      }, 10000);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT signal...');
  // Don't exit immediately, let ongoing operations complete
  setTimeout(() => {
    console.log('Shutting down gracefully...');
    process.exit(0);
  }, 2000);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM signal...');
  setTimeout(() => {
    console.log('Shutting down gracefully...');
    process.exit(0);
  }, 2000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit, continue running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, continue running
});

module.exports = DiscordBot;

// Start the bot if this file is run directly
if (require.main === module) {
  const bot = new DiscordBot();
  bot.start();
}
