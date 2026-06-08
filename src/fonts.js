// Centralized font registration — required ONCE before any canvas is created.
// Uses each font's REAL internal family name (read from the TTF name table) so that
// node-canvas/Cairo and the OS fontconfig agree on the lookup name. Registering in a
// single place avoids the conflicting multi-file registration that produced faint text.
const { registerFont } = require('canvas');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'fonts');

// family = the actual name stored inside the .ttf (verified via the name table)
const FONTS = [
  { file: 'ChakraPetch-SemiBold.ttf', family: 'Chakra Petch SemiBold' },
  { file: 'Rajdhani-SemiBold.ttf',    family: 'Rajdhani SemiBold' },
  { file: 'Rajdhani-Regular.ttf',     family: 'Rajdhani' },
  { file: 'Rajdhani-Bold.ttf',        family: 'Rajdhani', weight: 'bold' },
];

let registered = false;
function registerFonts() {
  if (registered) return;
  for (const f of FONTS) {
    try {
      const opts = { family: f.family };
      if (f.weight) opts.weight = f.weight;
      registerFont(path.join(FONT_DIR, f.file), opts);
      console.log(`✓ Font registered: "${f.family}"${f.weight ? ' ' + f.weight : ''} (${f.file})`);
    } catch (e) {
      console.warn(`✗ Font failed: ${f.file}:`, e.message);
    }
  }
  registered = true;
}

registerFonts();

// Export the canonical family names so generators reference them consistently.
module.exports = {
  registerFonts,
  CHAKRA: 'Chakra Petch SemiBold',
  RAJDHANI_SB: 'Rajdhani SemiBold',
  RAJDHANI: 'Rajdhani',
};
