#!/bin/bash
# Copy fonts to ALL paths fontconfig actually scans on Render's Linux.
# Verified from fc-cache logs: /opt/render/.fonts is the path it looks for.
set -e

mkdir -p /opt/render/.fonts
cp -f fonts/*.ttf /opt/render/.fonts/ 2>/dev/null || true
cp -f fonts/*.otf /opt/render/.fonts/ 2>/dev/null || true

# Also copy into /usr/share/fonts/truetype as a backup (always scanned)
mkdir -p /usr/share/fonts/truetype/custom 2>/dev/null || true
cp -f fonts/*.ttf /usr/share/fonts/truetype/custom/ 2>/dev/null || true

# Rebuild the cache and verify our fonts are registered
fc-cache -f /opt/render/.fonts 2>/dev/null || true
fc-cache -f 2>/dev/null || true

echo "── Font check ──"
fc-list | grep -i "chakra\|rajdhani" || echo "WARN: fonts not detected by fontconfig"
echo "────────────────"

node src/bot.js
