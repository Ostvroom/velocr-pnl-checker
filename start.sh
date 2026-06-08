#!/bin/bash
# Install custom fonts into the system font directory so Pango/fontconfig picks them up
FONT_DIR="$HOME/.local/share/fonts"
mkdir -p "$FONT_DIR"
cp /opt/render/project/src/fonts/*.ttf "$FONT_DIR/" 2>/dev/null || true
cp /opt/render/project/src/fonts/*.otf "$FONT_DIR/" 2>/dev/null || true
fc-cache -f -v 2>/dev/null || true
echo "Fonts installed. Starting bot..."
node src/bot.js
