// Centralized font registration — required ONCE before any canvas is created.
// Uses SINGLE-WORD family names (no spaces, no weight descriptors) because canvas/Pango
// font matching on Linux is unreliable with multi-word names or weight selectors and
// silently falls back to a system font. Single-word names match deterministically.
const { registerFont } = require('canvas');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'fonts');

const FONTS = [
  { file: 'ChakraPetch-SemiBold.ttf', family: 'ChakraPetchSB' },
  { file: 'Rajdhani-SemiBold.ttf',    family: 'RajdhaniSB' },
  { file: 'Rajdhani-Bold.ttf',        family: 'RajdhaniBold' },
];

let registered = false;
function registerFonts() {
  if (registered) return;
  for (const f of FONTS) {
    try {
      registerFont(path.join(FONT_DIR, f.file), { family: f.family });
      console.log(`✓ Font registered: "${f.family}" (${f.file})`);
    } catch (e) {
      console.warn(`✗ Font failed: ${f.file}:`, e.message);
    }
  }
  registered = true;
}

registerFonts();

module.exports = {
  registerFonts,
  CHAKRA: 'ChakraPetchSB',
  RAJDHANI_SB: 'RajdhaniSB',
  RAJDHANI_BOLD: 'RajdhaniBold',
};
