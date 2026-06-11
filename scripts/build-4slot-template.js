// One-time builder: derive 4-slot PnL templates (MINTED · BOUGHT · SOLD · HOLDING)
// from the existing 3-slot templates by repainting the metric band.
// Re-run after replacing the source templates. Output overwrites the *-4slot.png files.
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const TPL = path.join(__dirname, '..', 'templates');

// Band geometry (full-res 1684×934). The strip holding the metric chips sits
// left of the NFT artwork, so we only repaint x:30..1130.
const BAND = { x: 30, y: 408, w: 1120, h: 200 };

// Four evenly spaced slots. `chipX` = left of the icon chip; `labelX`/value share the
// generator's coordinates (see pnl-panel-generator.js metricX4).
const SLOTS = [
  { key: 'minted',  label: 'MINTED' },
  { key: 'bought',  label: 'BOUGHT' },
  { key: 'sold',    label: 'SOLD' },
  { key: 'holding', label: 'HOLDING' }
];

const CHIP = 64;            // chip box size
const SLOT_W = 270;         // horizontal stride between slots
const FIRST_CHIP_X = 48;    // left edge of first chip
const CHIP_Y = 432;         // top edge of chip row
const LABEL_DY = 32;        // label baseline offset within chip height

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Minimal line glyphs, drawn centered in a CHIP×CHIP box at (cx,cy) top-left.
function drawGlyph(ctx, key, cx, cy) {
  ctx.save();
  ctx.strokeStyle = '#e7e7ea';
  ctx.fillStyle = '#e7e7ea';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const x = cx + CHIP / 2;
  const y = cy + CHIP / 2;
  if (key === 'minted') {
    // four-point spark
    ctx.beginPath();
    ctx.moveTo(x, y - 16); ctx.lineTo(x + 5, y - 5); ctx.lineTo(x + 16, y);
    ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y + 16); ctx.lineTo(x - 5, y + 5);
    ctx.lineTo(x - 16, y); ctx.lineTo(x - 5, y - 5); ctx.closePath();
    ctx.fill();
  } else if (key === 'bought') {
    // shopping cart
    ctx.beginPath();
    ctx.moveTo(x - 16, y - 12); ctx.lineTo(x - 10, y - 12);
    ctx.lineTo(x - 6, y + 6); ctx.lineTo(x + 12, y + 6); ctx.lineTo(x + 16, y - 6);
    ctx.lineTo(x - 8, y - 6); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 4, y + 13, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 9, y + 13, 2.5, 0, Math.PI * 2); ctx.fill();
  } else if (key === 'sold') {
    // price tag
    ctx.beginPath();
    ctx.moveTo(x - 14, y - 4); ctx.lineTo(x + 2, y - 14); ctx.lineTo(x + 15, y - 2);
    ctx.lineTo(x + 2, y + 14); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 4, y - 4, 3, 0, Math.PI * 2); ctx.fill();
  } else if (key === 'holding') {
    // diamond
    ctx.beginPath();
    ctx.moveTo(x, y - 15); ctx.lineTo(x + 15, y); ctx.lineTo(x, y + 15);
    ctx.lineTo(x - 15, y); ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

async function build(srcName, outName, bandFill) {
  const img = await loadImage(path.join(TPL, srcName));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 1. Repaint the old 3-slot band with the sampled near-black band color.
  ctx.fillStyle = bandFill;
  ctx.fillRect(BAND.x, BAND.y, BAND.w, BAND.h);

  // 2. Draw four chips + labels.
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SLOTS.length; i++) {
    const slot = SLOTS[i];
    const chipX = FIRST_CHIP_X + i * SLOT_W;
    roundRect(ctx, chipX, CHIP_Y, CHIP, CHIP, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.stroke();
    drawGlyph(ctx, slot.key, chipX, CHIP_Y);

    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'left';
    ctx.fillText(slot.label, chipX + CHIP + 14, CHIP_Y + LABEL_DY);
  }

  const out = path.join(TPL, outName);
  fs.writeFileSync(out, c.toBuffer('image/png'));
  console.log('Wrote', out);
}

(async () => {
  await build('pnl-win-template.png', 'pnl-win-template-4slot.png', '#0a0b0d');
  await build('pnl-loss-template.png', 'pnl-loss-template-4slot.png', '#0b0c0e');
})();
