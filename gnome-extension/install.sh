#!/bin/sh
# Installs the Morph focus helper for GNOME Shell (Wayland).
# It lets the pill know which app is in front; see README.md.
set -e
UUID="morph-focus@morph.dev"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "GNOME Shell: $(gnome-shell --version 2>/dev/null || echo 'not found')"
mkdir -p "$DEST"
cp "$SRC/metadata.json" "$SRC/extension.js" "$SRC/stylesheet.css" "$DEST/"
echo "Copied the helper to $DEST"
gnome-extensions enable "$UUID" 2>/dev/null || true
echo
echo "Check that it is on with:"
echo "  gnome-extensions info $UUID     (State: ACTIVE)"
echo "If it isn't active, run:  gnome-extensions enable $UUID"
