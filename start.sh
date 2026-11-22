#!/bin/bash
# Morph — start script
cd "$(dirname "$0")"

# Install GNOME extension if not already installed
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/morph-focus@morph.dev"
if [ ! -d "$EXT_DIR" ] || [ "gnome-extension/morph-focus@morph.dev/extension.js" -nt "$EXT_DIR/extension.js" ]; then
  echo "Installing/updating GNOME extension..."
  bash gnome-extension/install.sh 2>/dev/null
fi

# Install node modules if missing
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --omit=dev 2>/dev/null
fi

# Kill any existing instance
pkill -f "electron.*morph" 2>/dev/null
sleep 0.3

echo "Starting Morph..."
npx electron . &
disown
echo "Morph is running in the tray."
