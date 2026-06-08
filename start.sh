#!/bin/bash
# Custom fonts are loaded directly via canvas registerFont() — no system install needed.
# Each font is registered under a unique family name (ChakraPetchSB, RajdhaniBold, etc.)
# to bypass Linux Pango's flaky weight-based font matching.
node src/bot.js
