// Centralized font registration — required ONCE before any canvas is created.
// Use the family names embedded in the font files. On Linux/Pango, registerFont()
// can log success for an alias and still fall back at draw time if the alias does
// not match the font metadata.
const { registerFont } = require('canvas');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'fonts');

const FONTS = [
  { file: 'ChakraPetch-SemiBold.ttf', family: 'Chakra Petch', weight: '600' },
  { file: 'Rajdhani-SemiBold.ttf',    family: 'Rajdhani', weight: '600' },
  { file: 'Rajdhani-Bold.ttf',        family: 'Rajdhani', weight: 'bold' },
  { file: 'Ethnocentric.ttf',         family: 'Ethnocentric' },
  { file: 'TheLastShuriken.ttf',      family: 'TheLastShuriken' },
  { file: 'SpaceGrotesk.ttf',         family: 'Space Grotesk' },
];

let registered = false;
function registerFonts() {
  if (registered) return;
  for (const f of FONTS) {
    try {
      registerFont(path.join(FONT_DIR, f.file), {
        family: f.family,
        weight: f.weight || 'normal',
      });
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
  CHAKRA: 'Chakra Petch',
  RAJDHANI_SB: 'Rajdhani',
  RAJDHANI_BOLD: 'Rajdhani',
  ETHNOCENTRIC: 'Ethnocentric',
  SHURIKEN: 'TheLastShuriken',
  SPACE_GROTESK: 'Space Grotesk',
};
