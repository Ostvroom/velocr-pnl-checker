const { ETHNOCENTRIC } = require('./fonts'); // registers fonts before any canvas is created
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

class PnlPanelGenerator {
  constructor() {
    this.templateDir = path.join(__dirname, '..', 'templates');
    this.outputDir = path.join(__dirname, '..', 'output');
    this.ethPriceUsd = 0;
    this.ethPriceSource = null;
    this.lastPriceFetch = 0;
  }

  async getEthPrice() {
    // Cache for 5 minutes
    if (Date.now() - this.lastPriceFetch < 300000 && this.ethPriceUsd > 0) {
      console.log(`[PnL] ETH/USD price: $${this.ethPriceUsd.toFixed(2)} (${this.ethPriceSource || 'cache'}, cached)`);
      return this.ethPriceUsd;
    }
    if (Date.now() - this.lastPriceFetch < 300000 && this.ethPriceSource === 'unavailable') {
      console.warn('[PnL] ETH/USD price unavailable (cached); USD labels will show N/A');
      return 0;
    }

    const priceSources = [
      {
        name: 'CoinGecko',
        url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        parse: data => Number(data?.ethereum?.usd) || 0
      },
      {
        name: 'Coinbase',
        url: 'https://api.coinbase.com/v2/exchange-rates?currency=ETH',
        parse: data => Number(data?.data?.rates?.USD) || 0
      },
      {
        name: 'Kraken ETHUSD',
        url: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
        parse: data => {
          const ticker = data?.result ? Object.values(data.result)[0] : null;
          return Number(ticker?.c?.[0]) || 0;
        }
      },
      {
        name: 'Binance ETHUSDT',
        url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
        parse: data => Number(data?.price) || 0
      },
      {
        name: 'OKX ETH-USDT',
        url: 'https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT',
        parse: data => Number(data?.data?.[0]?.last) || 0
      }
    ];

    let fetchedPrice = 0;
    let fetchedSource = null;
    for (const source of priceSources) {
      try {
        const res = await axios.get(source.url, { timeout: 5000 });
        fetchedPrice = source.parse(res.data);
        if (fetchedPrice >= 100 && fetchedPrice <= 100000) {
          fetchedSource = source.name;
          break;
        }
        console.warn(`[PnL] ETH/USD ${source.name} returned no usable price: ${fetchedPrice || 'empty'}`);
      } catch (e) {
        console.warn(`[PnL] ETH/USD ${source.name} fetch failed: ${e.message}`);
      }
    }

    if (!fetchedPrice) {
      this.ethPriceUsd = 0;
      this.ethPriceSource = 'unavailable';
      this.lastPriceFetch = Date.now();
      console.warn('[PnL] ETH/USD price unavailable; USD labels will show N/A');
      return 0;
    }

    this.ethPriceUsd = fetchedPrice;
    this.ethPriceSource = fetchedSource;
    this.lastPriceFetch = Date.now();
    console.log(`[PnL] ETH/USD price: $${this.ethPriceUsd.toFixed(2)} (${this.ethPriceSource})`);
    return this.ethPriceUsd;
  }

  formatUsd(ethAmount, ethPrice) {
    if (!Number.isFinite(ethPrice) || ethPrice <= 0) return 'N/A';
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

  /**
   * Paint the page background over unwanted baked template artwork:
   *  - the empty left arc of the mascot's circular ring (both win + loss), which
   *    otherwise reads as a hollow gap to the left of the character;
   *  - on the loss card, the full-body mascot's lower edge that drops onto the
   *    DATE ISSUED panel — faded out so the two don't collide.
   * Uses opaque→transparent gradients so the covered area blends seamlessly into
   * the near-black background instead of leaving a hard seam.
   */
  cleanupTemplateArt(ctx, mode) {
    const bg = mode === 'loss' ? '11,12,14' : '9,10,12';

    // 1. Empty left ring-arc. Opaque on the far left (covers the faint ring),
    //    fading to transparent before reaching the character on the right.
    const crescent = ctx.createLinearGradient(1040, 0, 1205, 0);
    crescent.addColorStop(0, `rgba(${bg},1)`);
    crescent.addColorStop(0.62, `rgba(${bg},1)`);
    crescent.addColorStop(1, `rgba(${bg},0)`);
    ctx.fillStyle = crescent;
    ctx.fillRect(1040, 95, 170, 500);

    // 2. Loss card only: fade the mascot's lower body into the background just
    //    above the date panel (vertical gradient, opaque at the bottom).
    if (mode === 'loss') {
      const skirt = ctx.createLinearGradient(0, 560, 0, 625);
      skirt.addColorStop(0, `rgba(${bg},0)`);
      skirt.addColorStop(1, `rgba(${bg},1)`);
      ctx.fillStyle = skirt;
      ctx.fillRect(1150, 560, 420, 65);
    }
  }

  async generatePanel(data, mode = 'win') {
    const templateFile = path.join(this.templateDir, 'PNL v3 .png');

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

    // PNL v3 already has clean mascot/ring artwork.

    const ethPrice = await this.getEthPrice();
    const hasEthPrice = Number.isFinite(ethPrice) && ethPrice > 0;
    const boughtEth = data.totalBoughtEth || 0;
    const soldEth = data.totalSoldEth || 0;
    const holdingEth = data.totalHoldingEth || 0;
    const profitEth = data.totalProfit || 0;
    console.log(
      `[PnL] USD conversions @ $${ethPrice.toFixed(2)}/ETH: ` +
      `BOUGHT ${boughtEth.toFixed(4)} ETH = ${this.formatUsd(boughtEth, ethPrice)} | ` +
      `SOLD ${soldEth.toFixed(4)} ETH = ${this.formatUsd(soldEth, ethPrice)} | ` +
      `HOLDING ${holdingEth.toFixed(4)} ETH = ${this.formatUsd(holdingEth, ethPrice)} | ` +
      `P&L ${profitEth.toFixed(4)} ETH = ${profitEth < 0 ? '-' : ''}${this.formatUsd(Math.abs(profitEth), ethPrice)}`
    );

    // ─── Text styling helpers ───
    const drawText = (text, x, y, options = {}) => {
      const {
        font = '32px "Space Grotesk"',
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

    const formatEth = (value, signed = false) => {
      const num = Number(value) || 0;
      const sign = signed && num > 0 ? '+' : '';
      return `${sign}${num.toFixed(Math.abs(num) >= 10 ? 2 : 3)} ETH`;
    };

    const drawEthUsd = (ethValue, x, y, options = {}) => {
      const {
        signed = false,
        color = COLORS.white,
        font = '30px "Space Grotesk"',
        subFont = '16px "Space Grotesk"',
        subOffset = 30
      } = options;
      drawText(formatEth(ethValue, signed), x, y, { font, color, shadow: true });
      if (hasEthPrice) {
        const prefix = signed && ethValue > 0 ? '+' : ethValue < 0 ? '-' : '';
        drawText(`${prefix}${this.formatUsd(Math.abs(ethValue), ethPrice)}`, x, y + subOffset, {
          font: subFont,
          color: COLORS.gray
        });
      }
    };

    const saleFeeRate = Number(data.saleFeeRate) || 0;
    if (saleFeeRate > 0) {
      const feeText = `NET FLOOR INCLUDES ${(saleFeeRate * 100).toFixed(2)}% FORCED FEES`;
      drawText(feeText, 390, 96, {
        font: '20px "Space Grotesk"',
        color: COLORS.gold,
        shadow: true
      });
      console.log(`[PnL] Panel fee note: ${feeText}`);
    }

    // 1. Collection name — auto-scale down to stay left of the NFT image (~x=750)
    let collectionFontSize = 64;
    const maxCollectionWidth = 560; // keeps text clear of the circular image on the right
    const collectionText = data.collection.toUpperCase();
    ctx.font = `${collectionFontSize}px "${ETHNOCENTRIC}"`;
    while (ctx.measureText(collectionText).width > maxCollectionWidth && collectionFontSize > 24) {
      collectionFontSize -= 4;
      ctx.font = `${collectionFontSize}px "${ETHNOCENTRIC}"`;
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
    drawText(displayCollectionText, 77, 247, {
      font: `${collectionFontSize}px "${ETHNOCENTRIC}"`,
      color: COLORS.white
    });

    // ── 4-slot metric band: MINTED · BOUGHT · SOLD · HOLDING ──
    // Each slot shows a big NFT COUNT plus a small sub-line:
    //   minted/bought → "avg <price> ETH"   sold → "avg <price> ETH"   holding → "floor <price> ETH"
    // X positions line up under the chips drawn in scripts/build-4slot-template.js
    // (FIRST_CHIP_X=48, SLOT_W=270). Value sits just inside each chip's left edge.
    const SLOT_X = { minted: 178, bought: 452, sold: 700, holding: 952 };
    const Y_COUNT = 452;
    const Y_SUB = 482;

    const drawSlot = (x, count, avgEth, kind) => {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Big NFT count
      const countStr = String(count || 0);
      ctx.font = '34px "Space Grotesk"';
      ctx.fillStyle = COLORS.white;
      ctx.fillText(countStr, x, Y_COUNT);
      const countW = ctx.measureText(countStr).width;
      ctx.font = '17px "Space Grotesk"';
      ctx.fillStyle = COLORS.gray;
      ctx.fillText(count === 1 ? ' NFT' : ' NFTs', x + countW, Y_COUNT);

      // Sub-line: avg price (minted/bought/sold) or floor (holding)
      const prefix = kind === 'holding' ? '' : 'avg ';
      let sub;
      if (!count) {
        sub = '—';
      } else if (avgEth > 0.00001) {
        sub = `${prefix}${avgEth.toFixed(3)} ETH`;
      } else if (kind === 'holding') {
        sub = 'no floor data';
      } else {
        sub = `${prefix}0.000 ETH`; // free mint / unpriced
      }
      ctx.font = '15px "Space Grotesk"';
      ctx.fillStyle = COLORS.gray;
      ctx.fillText(sub, kind === 'holding' ? x + 52 : x, Y_SUB);
    };

    drawSlot(SLOT_X.minted, data.mintedCount || 0, data.mintedAvgEth || 0, 'minted');
    drawSlot(SLOT_X.bought, data.boughtCount || 0, data.boughtAvgEth || 0, 'bought');
    drawSlot(SLOT_X.sold, data.soldCount || 0, data.soldAvgEth || 0, 'sold');
    drawSlot(SLOT_X.holding, data.holdingCount || 0, data.holdingFloorEth || 0, 'holding');

    const unrealizedProfit = Number(data.totalUnrealizedProfit) || 0;
    drawEthUsd(data.totalBoughtEth || 0, 183, 615, {
      color: COLORS.white,
      font: '30px "Space Grotesk"',
      subFont: '15px "Space Grotesk"'
    });
    drawEthUsd(data.totalSoldEth || 0, 536, 615, {
      color: COLORS.white,
      font: '30px "Space Grotesk"',
      subFont: '15px "Space Grotesk"'
    });
    drawEthUsd(unrealizedProfit, 888, 615, {
      signed: true,
      color: unrealizedProfit >= 0 ? COLORS.green : COLORS.red,
      font: '30px "Space Grotesk"',
      subFont: '15px "Space Grotesk"'
    });

    // 6. Total P&L (bottom left, large)
    // NOTE: the template already has a "USD" badge baked in — do NOT draw it again.
    const profitColor = data.totalProfit >= 0 ? COLORS.green : COLORS.red;
    drawEthUsd(data.totalProfit || 0, 265, 805, {
      signed: true,
      color: profitColor,
      font: '42px "Space Grotesk"',
      subFont: '18px "Space Grotesk"',
      subOffset: 36
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
    ctx.font = `${roiFontSize}px "Space Grotesk"`;
    while (ctx.measureText(roiText).width > maxRoiWidth && roiFontSize > 28) {
      roiFontSize -= 4;
      ctx.font = `${roiFontSize}px "Space Grotesk"`;
    }
    drawText(roiText, 932, 805, {
      font: `${roiFontSize}px "Space Grotesk"`,
      color: roiColor
    });

    // 8-10. Date / Time / Trader (right column).
    // Icons sit at x≈1372; VALUE text must start at x=1450 to clear the icon
    // and sit in the open text area to the right of the icon.
    // Labels (DATE/TIME/TRADED BY) sit at y≈665/745/825 (pixel-scanned, evenly 80px
    // apart) with thin dividers at y≈722/802. Place each value a uniform 28px below its
    // label so all three label/value pairs match and the value clears the divider below.
    const rightColX = 1430; // aligned with the label text left edge (x≈1432)
    const dateY   = 724;
    const timeY   = 794;
    const traderY = 864;
    const rightColFont = '22px "Space Grotesk"'; // unified size + weight for all three rows

    const generatedAt = new Date();
    const fallbackDate = generatedAt.toLocaleDateString('en-GB', { timeZone: 'UTC' });
    const fallbackTime = generatedAt.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }) + ' UTC';
    console.log(`[PnL] Panel timestamp: ${fallbackDate} ${fallbackTime}`);

    drawText(fallbackDate, rightColX, dateY, {
      font: rightColFont,
      color: COLORS.white
    });
    drawText(fallbackTime, rightColX, timeY, {
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
