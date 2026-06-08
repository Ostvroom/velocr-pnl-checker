const path = require('path');
const dotenv = require('dotenv');
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath, override: true });

module.exports = {
  // Discord Configuration
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    channelId: process.env.DISCORD_CHANNEL_ID,
    pnlChannelId: process.env.DISCORD_PNL_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID
  },

  // X (Twitter) Configuration
  x: {
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET,
    bearerToken: process.env.X_BEARER_TOKEN,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
    botUsername: process.env.X_BOT_USERNAME || null,
    botPassword: process.env.X_BOT_PASSWORD || null
  },

  // Gemini API Configuration
  gemini: {
    apiKey: process.env.GEMINI_API_KEY
  },

  // Image Generation Configuration
  image: {
    templatePath: process.env.TEMPLATE_PATH || './templates/banner-template.png',
    outputPath: process.env.OUTPUT_PATH || './output/'
  },

  // Bot Settings
  bot: {
    prefix: process.env.BOT_PREFIX || '!',
    name: process.env.BOT_NAME || 'X Banner Generator'
  },

  // PnL Card Defaults
  pnl: {
    defaultCurrency: process.env.PNL_DEFAULT_CURRENCY || 'ETH',
    defaultType: process.env.PNL_DEFAULT_TYPE || 'nft'
  },

  // Alchemy API (for NFT data)
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || null
  }
};