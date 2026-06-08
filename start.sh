#!/bin/bash
# Belt-and-suspenders font setup for Linux:
# 1. Install fonts into the fontconfig-scanned dir (/opt/render/.fonts) and rebuild cache,
#    so Pango/Cairo can find them by their real family name.
# 2. The code ALSO calls registerFont() via src/fonts.js as a second guarantee.
FONT_DIR="/opt/render/.fonts"
mkdir -p "$FONT_DIR"
cp -f fonts/*.ttf "$FONT_DIR/" 2>/dev/null || true
fc-cache -f "$FONT_DIR" 2>/dev/null || true

echo "── Installed custom fonts ──"
fc-list | grep -iE "chakra|rajdhani" || echo "(fontconfig did not list them — relying on registerFont)"
echo "────────────────────────────"

node src/bot.js
