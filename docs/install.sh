#!/usr/bin/env bash
# Morph installer. Read it before you run it: it only downloads one zip, checks its fingerprint
# against the website's version.json, unpacks it into ~/.local/share/morph and runs `morph --install`.
# It does not use sudo and touches nothing outside your home folder.
set -eu
BASE="${MORPH_BASE_URL:-https://mohitanand001.github.io/morph}"
DEST="${MORPH_DIR:-$HOME/.local/share/morph}"
say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { say "Needs '$1'. On Ubuntu:  sudo apt install $2"; exit 1; }; }
need curl curl; need unzip unzip; need sha256sum coreutils
command -v gjs >/dev/null 2>&1 || { say "GNOME's script runner (gjs) is missing. On Ubuntu:  sudo apt install gjs"; exit 1; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

say "Downloading Morph from $BASE"
meta="$(curl -fsSL --max-time 20 "$BASE/version.json")" || { say "Could not reach $BASE"; exit 1; }
zip="$(field "$meta" zip)"; sha="$(field "$meta" sha256)"; ver="$(field "$meta" version)"
[ -n "$zip" ] && [ -n "$sha" ] || { say "The version file did not look right."; exit 1; }
# Only a Morph zip from this same website, with a real fingerprint.
printf '%s' "$zip" | grep -Eq '^morph-[0-9A-Za-z.+-]+-linux\.zip$' || { say "The version file pointed somewhere unexpected, so nothing was installed."; exit 1; }
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || { say "The version file did not look right."; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 120 -o "$tmp/m.zip" "$BASE/$zip" || { say "Download failed."; exit 1; }
echo "$sha  $tmp/m.zip" | sha256sum -c --quiet - || { say "The download did not match its fingerprint, so nothing was installed."; exit 1; }
unzip -q "$tmp/m.zip" -d "$tmp/x"
[ -f "$tmp/x/morph/daemon/gjs-main.js" ] || { say "The download did not contain Morph."; exit 1; }
# Never unpack over a folder another program uses.
if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && [ ! -f "$DEST/daemon/gjs-main.js" ]; then
  say "$DEST already holds files that are not Morph's, so nothing was installed. Choose another folder:  MORPH_DIR=~/morph bash install.sh"
  exit 1
fi
mkdir -p "$DEST"
cp -r "$tmp/x/morph/." "$DEST/"
chmod +x "$DEST/bin/morph"
say "Morph $ver unpacked into $DEST"
"$DEST/bin/morph" --install
say ""
say "Done. Morph shows a short welcome now. If you do not see it, run:  morph --status"
