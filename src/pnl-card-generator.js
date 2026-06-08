require('./fonts'); // registers fonts before any canvas is created
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const config = require('./config');

class PnlCardGenerator {
  constructor() {
    this.outputPath = config.image.outputPath;
    this.initializeOutputDirectory();
  }

  async initializeOutputDirectory() {
    try {
      await fs.mkdir(this.outputPath, { recursive: true });
    } catch (error) {
      console.error('Error creating output directory:', error);
    }
  }

  async downloadImage(url) {
    if (!url) return null;
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
      return Buffer.from(response.data, 'binary');
    } catch (error) {
      console.error('Error downloading image:', error.message);
      return null;
    }
  }

  async generatePnlCard(data) {
    const {
      name,
      buyPrice,
      sellPrice,
      currency = 'ETH',
      wallet = null,
      imageUrl = null,
      collectionImageUrl = null,
      mode = 'manual', // 'manual', 'unrealized', 'realized'
      entryLabel = 'BUY PRICE'
    } = data;

    const profit = (sellPrice || 0) - buyPrice;
    const profitPercent = buyPrice > 0 ? ((profit / buyPrice) * 100) : 0;
    const isProfit = profit >= 0;

    const width = 1200;
    const height = 675;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Light cream background
    this.drawBackground(ctx, width, height, isProfit, mode);

    // 2. Decorative shapes
    this.drawDecorations(ctx, width, height, isProfit, mode);

    // 3. Token / Collection image circle
    const imageToUse = imageUrl || collectionImageUrl;
    const imageBuffer = imageToUse ? await this.downloadImage(imageToUse) : null;
    await this.drawTokenImage(ctx, imageBuffer, width, height, isProfit);

    // 4. Header area
    this.drawHeader(ctx, name, mode, width, height);

    // 5. Metrics panel
    this.drawMetrics(ctx, buyPrice, sellPrice, profit, profitPercent, currency, isProfit, mode, entryLabel, width, height);

    // 6. Wallet
    if (wallet) {
      this.drawWallet(ctx, wallet, width, height);
    }

    // 7. Bottom branding
    this.drawBranding(ctx, width, height, mode);

    const buffer = canvas.toBuffer('image/png');

    const safeName = String(name).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `pnl_card_${safeName}_${Date.now()}.png`;
    const filePath = path.join(this.outputPath, filename);
    await fs.writeFile(filePath, buffer);
    console.log(`PnL card saved to: ${filePath}`);

    return buffer;
  }

  drawBackground(ctx, width, height, isProfit, mode) {
    ctx.fillStyle = '#FAF8F5';
    ctx.fillRect(0, 0, width, height);

    // Mode-based accent color
    const accentBase = mode === 'unrealized'
      ? 'rgba(0, 150, 255,'
      : mode === 'realized'
        ? (isProfit ? 'rgba(46, 160, 67,' : 'rgba(207, 34, 46,')
        : (isProfit ? 'rgba(0, 200, 100,' : 'rgba(255, 80, 80,');

    // Soft top-left blob
    const grad1 = ctx.createRadialGradient(0, 0, 10, 200, 150, 400);
    grad1.addColorStop(0, `${accentBase} 0.10)`);
    grad1.addColorStop(1, 'rgba(198, 156, 108, 0)');
    ctx.fillStyle = grad1;
    ctx.fillRect(0, 0, 600, 400);

    // Soft bottom-right blob
    const grad2 = ctx.createRadialGradient(width, height, 10, width - 200, height - 150, 400);
    grad2.addColorStop(0, `${accentBase} 0.06)`);
    grad2.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad2;
    ctx.fillRect(width - 600, height - 400, 600, 400);
  }

  drawDecorations(ctx, width, height, isProfit, mode) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const spacing = 30;
    for (let x = 0; x < width; x += spacing) {
      for (let y = 0; y < height; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 60);
    ctx.lineTo(width, height - 60);
    ctx.stroke();

    // Mode indicator circles
    const accentColor = mode === 'unrealized'
      ? 'rgba(0, 150, 255, 0.12)'
      : mode === 'realized'
        ? (isProfit ? 'rgba(46, 160, 67, 0.12)' : 'rgba(207, 34, 46, 0.12)')
        : 'rgba(198, 156, 108, 0.12)';

    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(width - 120, 100, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(width - 180, 160, 30, 0, Math.PI * 2);
    ctx.fill();
  }

  async drawTokenImage(ctx, imageBuffer, width, height, isProfit) {
    const centerX = 260;
    const centerY = height / 2 + 10;
    const radius = 150;

    // Glow behind circle
    ctx.save();
    ctx.shadowColor = isProfit ? 'rgba(46, 160, 67, 0.25)' : 'rgba(207, 34, 46, 0.25)';
    ctx.shadowBlur = 60;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fill();
    ctx.restore();

    // White border ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.restore();

    // Gold accent ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#c69c6c';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Image clipped to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (imageBuffer) {
      try {
        const img = await loadImage(imageBuffer);
        const size = radius * 2;
        ctx.drawImage(img, centerX - radius, centerY - radius, size, size);
      } catch (e) {
        this.drawPlaceholderImage(ctx, centerX, centerY, radius);
      }
    } else {
      this.drawPlaceholderImage(ctx, centerX, centerY, radius);
    }
    ctx.restore();
  }

  drawPlaceholderImage(ctx, centerX, centerY, radius) {
    const grad = ctx.createLinearGradient(centerX - radius, centerY - radius, centerX + radius, centerY + radius);
    grad.addColorStop(0, '#f0e6d8');
    grad.addColorStop(1, '#e8dcc8');
    ctx.fillStyle = grad;
    ctx.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.fillStyle = 'rgba(198, 156, 108, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, -35);
    ctx.lineTo(30, 0);
    ctx.lineTo(0, 35);
    ctx.lineTo(-30, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawHeader(ctx, name, mode, width, height) {
    const startX = 500;
    const startY = 100;

    // "PnL CARD" label
    ctx.font = '22px "Chakra Petch SemiBold", sans-serif';
    ctx.fillStyle = '#8b7355';
    ctx.textAlign = 'left';
    ctx.fillText('PnL CARD', startX, startY);

    // Mode badge
    const modeText = mode === 'unrealized' ? 'UNREALIZED' : mode === 'realized' ? 'REALIZED' : 'MANUAL';
    ctx.font = '11px "Rajdhani SemiBold", sans-serif';
    const badgeW = ctx.measureText(modeText).width + 24;
    const badgeX = startX + ctx.measureText('PnL CARD').width + 20;
    const badgeY = startY - 18;

    const badgeColor = mode === 'unrealized'
      ? { bg: 'rgba(0, 150, 255, 0.12)', stroke: 'rgba(0, 150, 255, 0.4)', text: '#0096ff' }
      : mode === 'realized'
        ? { bg: 'rgba(46, 160, 67, 0.12)', stroke: 'rgba(46, 160, 67, 0.4)', text: '#2ea043' }
        : { bg: 'rgba(198, 156, 108, 0.12)', stroke: 'rgba(198, 156, 108, 0.4)', text: '#a08060' };

    ctx.save();
    ctx.fillStyle = badgeColor.bg;
    ctx.strokeStyle = badgeColor.stroke;
    ctx.lineWidth = 1;
    this.roundRect(ctx, badgeX, badgeY, badgeW, 20, 10);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = badgeColor.text;
    ctx.textAlign = 'left';
    ctx.fillText(modeText, badgeX + 12, badgeY + 14);

    // Token name
    ctx.font = '46px "Chakra Petch SemiBold", sans-serif';
    ctx.fillStyle = '#5a3e2b';
    ctx.textAlign = 'left';
    ctx.fillText(name, startX, startY + 65);

    // Subtle underline
    ctx.strokeStyle = 'rgba(198, 156, 108, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX, startY + 85);
    ctx.lineTo(startX + 350, startY + 85);
    ctx.stroke();
  }

  drawMetrics(ctx, buyPrice, sellPrice, profit, profitPercent, currency, isProfit, mode, entryLabel, width, height) {
    const panelX = 500;
    const panelY = 240;
    const colWidth = 240;
    const lineHeight = 110;

    const accentColor = isProfit ? '#2ea043' : '#cf222e';

    const drawMetricBox = (label, value, x, y, isHighlight = false, customColor = null) => {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      this.roundRect(ctx, x, y, colWidth, 90, 16);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = isHighlight ? (customColor || accentColor) : 'rgba(198, 156, 108, 0.25)';
      ctx.lineWidth = isHighlight ? 2 : 1;
      this.roundRect(ctx, x, y, colWidth, 90, 16);
      ctx.stroke();
      ctx.restore();

      ctx.font = '13px "Rajdhani SemiBold", sans-serif';
      ctx.fillStyle = '#a08060';
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 18, y + 28);

      if (isHighlight) {
        ctx.save();
        ctx.shadowColor = customColor || accentColor;
        ctx.shadowBlur = 20;
        ctx.font = '28px "Rajdhani SemiBold", sans-serif';
        ctx.fillStyle = customColor || accentColor;
        ctx.textAlign = 'left';
        ctx.fillText(value, x + 18, y + 65);
        ctx.restore();
      } else {
        ctx.font = '22px "Rajdhani SemiBold", sans-serif';
        ctx.fillStyle = '#5a3e2b';
        ctx.textAlign = 'left';
        ctx.fillText(value, x + 18, y + 62);
      }
    };

    // Row 1: Buy Price | Sell Price / Current Floor
    const sellLabel = mode === 'unrealized' ? 'CURRENT FLOOR' : 'SELL PRICE';
    const sellValue = mode === 'unrealized' && (!sellPrice || sellPrice === 0)
      ? '—'
      : `${sellPrice || 0} ${currency}`;

    drawMetricBox(entryLabel, `${buyPrice || 0} ${currency}`, panelX, panelY);
    drawMetricBox(sellLabel, sellValue, panelX + colWidth + 20, panelY);

    // Row 2: Profit % (highlighted) | Net Profit
    const sign = profit >= 0 ? '+' : '';
    const profitStr = `${sign}${profitPercent.toFixed(2)}%`;
    drawMetricBox('PROFIT / LOSS', profitStr, panelX, panelY + lineHeight, true);

    const netProfitStr = `${sign}${profit.toFixed(4)} ${currency}`;
    drawMetricBox('NET PROFIT', netProfitStr, panelX + colWidth + 20, panelY + lineHeight);
  }

  drawWallet(ctx, wallet, width, height) {
    ctx.font = '14px "Rajdhani SemiBold", sans-serif';
    ctx.fillStyle = '#a08060';
    ctx.textAlign = 'left';
    ctx.fillText(`Wallet: ${wallet}`, 500, height - 70);
  }

  drawBranding(ctx, width, height, mode) {
    ctx.font = '16px "Chakra Petch SemiBold", sans-serif';
    ctx.fillStyle = 'rgba(90, 62, 43, 0.15)';
    ctx.textAlign = 'left';
    ctx.fillText('VELIST', 50, height - 35);

    ctx.strokeStyle = 'rgba(198, 156, 108, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(50, height - 55);
    ctx.lineTo(width - 50, height - 55);
    ctx.stroke();

    // Auto badge if not manual
    if (mode !== 'manual') {
      ctx.font = '11px "Rajdhani SemiBold", sans-serif';
      ctx.fillStyle = 'rgba(90, 62, 43, 0.25)';
      ctx.textAlign = 'right';
      ctx.fillText('AUTO • VIA ALCHEMY', width - 50, height - 35);
    }
  }

  roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

module.exports = PnlCardGenerator;
