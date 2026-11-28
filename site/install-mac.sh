#!/usr/bin/env bash
# Morph installer for Mac (preview). Read it before you run it: it downloads the Mac app for the version the
# website names, checks its fingerprint, puts Morph.app in Applications and opens it. No sudo; nothing is deleted
# (an older Morph.app goes to the Bin).
set -eu
BASE="${MORPH_BASE_URL:-https://mohitanand001.github.io/morph}"
REL="${MORPH_RELEASES_URL:-https://github.com/mohitanand001/morph/releases/download}"
say() { printf '%s\n' "$*"; }
[ "$(uname -s)" = Darwin ] || { say "This installer is for macOS. On Linux:  curl -fsSL $BASE/install.sh | bash"; exit 1; }
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 13 ] 2>/dev/null || { say "Morph needs macOS 13 (Ventura) or newer."; exit 1; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

meta="$(curl -fsSL --max-time 20 "$BASE/version.json")" || { say "Could not reach $BASE"; exit 1; }
ver="$(field "$meta" version)"
printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$' || { say "The version file did not look right."; exit 1; }
say "Downloading Morph $ver for Mac"
tmp="$(mktemp -d)"
clean_tmp() { rm -f -- "$tmp/Morph-mac.zip" "$tmp/Morph-mac.zip.sha256"; rmdir -- "$tmp/x" "$tmp" 2>/dev/null || true; }
trap clean_tmp EXIT
curl -fsSL --max-time 30 -o "$tmp/Morph-mac.zip.sha256" "$REL/v$ver/Morph-mac.zip.sha256" || { say "The Mac download for $ver is not published yet. Try again later."; exit 1; }
curl -fsSL --max-time 300 -o "$tmp/Morph-mac.zip" "$REL/v$ver/Morph-mac.zip" || { say "Download failed."; exit 1; }
want="$(cut -d' ' -f1 < "$tmp/Morph-mac.zip.sha256")"
got="$(shasum -a 256 "$tmp/Morph-mac.zip" | cut -d' ' -f1)"
printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' && [ "$want" = "$got" ] || { say "The download did not match its fingerprint, so nothing was installed."; exit 1; }
mkdir -p "$tmp/x"
ditto -x -k "$tmp/Morph-mac.zip" "$tmp/x"
[ "$(defaults read "$tmp/x/Morph.app/Contents/Info" CFBundleIdentifier 2>/dev/null)" = dev.morph.app ] || { say "The download did not contain Morph."; exit 1; }

# /Applications when you can write there, else Applications in your home folder.
if [ -n "${MORPH_APPS:-}" ]; then APPS="$MORPH_APPS"; elif [ -w /Applications ]; then APPS=/Applications; else APPS="$HOME/Applications"; fi
mkdir -p "$APPS"
# A running Morph is stopped first (only Morph.app's own program, found by its path).
for pid in $(pgrep -f '/Morph\.app/Contents/MacOS/Morph$' || true); do kill "$pid" 2>/dev/null || true; done
sleep 1
if [ -e "$APPS/Morph.app" ]; then
  mkdir -p "$HOME/.Trash"
  mv "$APPS/Morph.app" "$HOME/.Trash/Morph-$(date +%Y%m%d-%H%M%S).app"
  say "The older Morph.app is in the Bin."
fi
mv "$tmp/x/Morph.app" "$APPS/Morph.app"
open "$APPS/Morph.app"
say ""
say "Morph $ver is installed in $APPS and running: look for the tab at the right edge of your screen."
say "The Mac asks once to let Morph use Accessibility (to see which window is in front and press ⌘V for you):"
say "System Settings → Privacy & Security → Accessibility → turn on Morph."
say "To remove it: Morph → Settings → Uninstall."
