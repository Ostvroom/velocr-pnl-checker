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

# Optional second bot (LOOTERS autoplayer) piggybacking on this worker — see
# looters/README.md. Only starts if LOOTER_COOKIE is set, so it's a no-op
# until that env var is added in Render. Runs in the background with its own
# auto-respawn loop; a crash here never affects the main Discord bot below.
if [ -n "$LOOTER_COOKIE" ]; then
  (
    while true; do
      node looters/src/bot.mjs
      echo "[looters] exited, restarting in 5s…" >&2
      sleep 5
    done
  ) &
  echo "── Started looters autoplayer (background) ──"
else
  echo "── LOOTER_COOKIE not set — skipping looters autoplayer ──"
fi

node src/bot.js
