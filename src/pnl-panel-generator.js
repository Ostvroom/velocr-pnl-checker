require('./fonts'); // registers fonts before any canvas is created
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

class PnlPanelGenerator {
  constructor() {
    this.templateDir = path.join(__dirname, '..', 'templates');
    this.outputDir = path.join(__dirname, '..', 'output');
    this.ethPriceUsd = 3000; // fallback
    this.lastPriceFetch = 0;
  }

  async getEthPrice() {
    // Cache for 5 minutes
    if (Date.now() - this.lastPriceFetch < 300000 && this.ethPriceUsd > 0) {
      return this.ethPriceUsd;
    }
    // Try CoinGecko first, then Binance as backup
    try {
      const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { timeout: 5000 });
      this.ethPriceUsd = res.data?.ethereum?.usd || 0;
    } catch (e) {}

    if (!this.ethPriceUsd) {
      try {
        const res = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { timeout: 5000 });
        this.ethPriceUsd = parseFloat(res.data?.price) || 0;
      } catch (e) {}
    }

    if (!this.ethPriceUsd) {
      console.warn('ETH price fetch failed from all sources, using fallback');
      this.ethPriceUsd = 3000;
    }

    this.lastPriceFetch = Date.now();
    return this.ethPriceUsd;
  }

  formatUsd(ethAmount, ethPrice) {
    const usd = ethAmount * ethPrice;
    if (usd >= 1000000) return `$${(usd / 1000000).toFixed(2)}M`;
    if (usd >= 1000) return `$${(usd / 1000).toFixed(3)}K`;
    return `$${usd.toFixed(2)}`;
  }

  formatK(num) {
    if (num >= 1000000) return `${(num / 1000000).toFixed(3)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(3)}K`;
    return num.toFixed(3);
  }

  async generatePanel(data, mode = 'win') {
    const templateFile = mode === 'win'
      ? path.join(this.templateDir, 'pnl-win-template.png')
      : path.join(this.templateDir, 'pnl-loss-template.png');

    const canvas = createCanvas(1920, 1080);
    const ctx = canvas.getContext('2d');

    let template;
    try {
      template = await loadImage(templateFile);
      canvas.width = template.width;
      canvas.height = template.height;
    } catch (e) {
      // Fallback: draw dark background if template missing
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      throw new Error(`Template not found: ${templateFile}. Please add the template image.`);
    }

    ctx.drawImage(template, 0, 0);

    const ethPrice = await this.getEthPrice();

    // ─── Text styling helpers ───
    const drawText = (text, x, y, options = {}) => {
      const {
        font = '32px "Rajdhani SemiBold"',
        color = '#FFFFFF',
        align = 'left',
        shadow = false
      } = options;
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      if (shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
      ctx.fillText(text, x, y);
      ctx.shadowColor = 'transparent';
    };

    // ─── Coordinates (calibrated for typical 1920×1080 template) ───
    // Adjust these if text doesn't align perfectly with your template
    const COLORS = {
      white: '#FFFFFF',
      gray: '#9ca3af',
      green: '#22c55e',
      red: '#ef4444',
      gold: '#c69c6c'
    };

    // 1. Collection name — auto-scale down to stay left of the NFT image (~x=750)
    let collectionFontSize = 64;
    const maxCollectionWidth = 560; // keeps text clear of the circular image on the right
    const collectionText = data.collection.toUpperCase();
    ctx.font = `${collectionFontSize}px "Chakra Petch SemiBold"`;
    while (ctx.measureText(collectionText).width > maxCollectionWidth && collectionFontSize > 24) {
      collectionFontSize -= 4;
      ctx.font = `${collectionFontSize}px "Chakra Petch SemiBold"`;
    }
    // If still too wide at min size, truncate with ellipsis
    let displayCollectionText = collectionText;
    if (ctx.measureText(displayCollectionText).width > maxCollectionWidth) {
      while (ctx.measureText(displayCollectionText + '…').width > maxCollectionWidth && displayCollectionText.length > 1) {
        displayCollectionText = displayCollectionText.slice(0, -1);
      }
      displayCollectionText += '…';
    }
    // x=67: pixel-scanned left edge of "COLLECTION" label in template — name aligns under it
    drawText(displayCollectionText, 67, 270, {
      font: `${collectionFontSize}px "Chakra Petch SemiBold"`,
      color: COLORS.white
    });

    // Helper: draw metric at fixed x (aligned with the label text in the template)
    const drawMetric = (value, x, yNum, yUsd) => {
      const numText = this.formatK(value);
      const usdText = `≈ ${this.formatUsd(value, ethPrice)}`;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Bold number
      ctx.font = 'bold 38px "Rajdhani"';
      ctx.fillStyle = COLORS.white;
      ctx.fillText(numText, x, yNum);
      const numW = ctx.measureText(numText).width;

      // Suffix: regular weight, same y — real font registered so metrics are consistent
      ctx.font = '24px "Rajdhani SemiBold"';
      ctx.fillStyle = COLORS.gray;
      ctx.fillText(' ETH', x + numW, yNum);

      // USD sub-label
      ctx.font = '18px "Rajdhani SemiBold"';
      ctx.fillStyle = COLORS.gray;
      ctx.fillText(usdText, x, yUsd);
    };

    // ── Calibrated x positions (pixel-scanned from template — label text start x) ──
    // BOUGHT label starts at x=184, SOLD at x=500, HOLDING at x=840
    const X_BOUGHT = 184;
    const X_SOLD   = 520;
    const HOLD_X   = 860;

    // Per-section y values — icons in the template are at slightly different heights,
    // so each section's number line is calibrated to sit BESIDE its icon, not above it.
    const Y_BOUGHT = 500;
    const Y_SOLD   = 500;
    const Y_HOLD   = 500;

    // 3. BOUGHT value — aligned with cart icon
    const allTransferred = (data.transferredCount || 0) > 0 && (data.totalBoughtEth || 0) === 0;
    if (allTransferred) {
      ctx.font = 'bold 26px "Rajdhani"';
      ctx.fillStyle = COLORS.gray;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('TRANSFERRED', X_BOUGHT, Y_BOUGHT);
      ctx.font = '16px "Rajdhani SemiBold"';
      ctx.fillText('no payment on-chain', X_BOUGHT, Y_BOUGHT + 45);
    } else {
      drawMetric(data.totalBoughtEth || 0, X_BOUGHT, Y_BOUGHT, Y_BOUGHT + 45);
    }

    // 4. SOLD value — aligned with hexagon icon
    drawMetric(data.totalSoldEth || 0, X_SOLD, Y_SOLD, Y_SOLD + 45);
    const holdingCount = data.holdingCount || 0;
    const holdingEth = data.totalHoldingEth || 0;
    const holdingY = Y_HOLD;

    const countStr = String(holdingCount);
    const countFont = countStr.length === 1 ? 40 : countStr.length === 2 ? 30 : 22;
    const nftFont = Math.round(countFont * 0.65); // ~65% of count size

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${countFont}px "Rajdhani"`;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(countStr, HOLD_X, holdingY);
    const countW = ctx.measureText(countStr).width;
    ctx.font = `${nftFont}px "Rajdhani SemiBold"`;
    ctx.fillStyle = COLORS.gray;
    ctx.fillText(' NFTs', HOLD_X + countW, holdingY);

    // Current floor value (if any held) — stacked below the count
    if (holdingCount > 0) {
      if (holdingEth > 0) {
        const hEthText = this.formatK(holdingEth);
        ctx.font = 'bold 20px "Rajdhani"';
        ctx.fillStyle = COLORS.white;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(hEthText, HOLD_X, holdingY + 37);
        const hEthW = ctx.measureText(hEthText).width;
        ctx.font = '20px "Rajdhani SemiBold"';
        ctx.fillStyle = COLORS.gray;
        ctx.fillText(' ETH', HOLD_X + hEthW, holdingY + 37);

        ctx.font = '14px "Rajdhani SemiBold"';
        ctx.fillStyle = COLORS.gray;
        ctx.fillText(`≈ ${this.formatUsd(holdingEth, ethPrice)}`, HOLD_X, holdingY + 62);
      } else {
        ctx.font = 'bold 16px "Rajdhani"';
        ctx.fillStyle = COLORS.gray;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('N/A', HOLD_X, holdingY + 37);
        ctx.font = '12px "Rajdhani SemiBold"';
        ctx.fillText('No floor data', HOLD_X, holdingY + 60);
      }
    }


    // 6. Total P&L (bottom left, large)
    // NOTE: the template already has a "USD" badge baked in — do NOT draw it again.
    const profitColor = data.totalProfit >= 0 ? COLORS.green : COLORS.red;
    const profitSign = data.totalProfit >= 0 ? '+' : '-';
    const profitText = `${profitSign}${this.formatUsd(Math.abs(data.totalProfit), ethPrice)}`;
    drawText(profitText, 225, 780, {
      font: 'bold 58px "Rajdhani"',
      color: profitColor
    });

    // 7. ROI — auto-scale font down for large percentages
    // For transferred/gifted NFTs (no cost), show N/A instead of +∞%
    const isTransferred = (data.transferredCount || 0) > 0 && (data.totalBoughtEth || 0) === 0;
    const roiText = isTransferred
      ? 'N/A'
      : !isFinite(data.totalRoi)
        ? (data.totalRoi > 0 ? '+∞%' : '-∞%')
        : `${data.totalRoi >= 0 ? '+' : ''}${Math.round(data.totalRoi)}%`;
    const roiColor = isTransferred ? COLORS.gray : profitColor;
    const maxRoiWidth = 220;
    let roiFontSize = 58; // match TOTAL PROFIT/LOSS size
    ctx.font = `bold ${roiFontSize}px "Rajdhani"`;
    while (ctx.measureText(roiText).width > maxRoiWidth && roiFontSize > 28) {
      roiFontSize -= 4;
      ctx.font = `bold ${roiFontSize}px "Rajdhani"`;
    }
    drawText(roiText, 950, 780, {
      font: `bold ${roiFontSize}px "Rajdhani"`,
      color: roiColor
    });

    // 8-10. Date / Time / Trader (right column).
    // Icons sit at x≈1372; VALUE text must start at x=1450 to clear the icon
    // and sit in the open text area to the right of the icon.
    const rightColX = 1430; // moved 20px left
    const dateY   = 700;    // up 5px total
    const timeY   = 775;
    const traderY = 859.5;  // up 5.5px total
    const rightColFont = '22px "Rajdhani SemiBold"'; // unified size + weight for all three rows

    drawText(data.date || new Date().toLocaleDateString('en-GB'), rightColX, dateY, {
      font: rightColFont,
      color: COLORS.white
    });
    drawText(data.time || new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' UTC', rightColX, timeY, {
      font: rightColFont,
      color: COLORS.white
    });
    drawText(data.trader || 'Unknown', rightColX, traderY, {
      font: rightColFont,
      color: COLORS.white
    });

    // Save and return
    const buffer = canvas.toBuffer('image/png');
    const filename = `pnl_panel_${data.collection.replace(/\s+/g, '_')}_${Date.now()}.png`;
    const filePath = path.join(this.outputDir, filename);
    await fs.writeFile(filePath, buffer);
    console.log(`PnL panel saved: ${filePath}`);
    return buffer;
  }
}

module.exports = PnlPanelGenerator;
