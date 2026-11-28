#!/usr/bin/env bash
# Builds the small Linux download: the background program, the converter, the GNOME helper and the
# installer. No Node, no Electron. Usage: tools/build-linux-zip.sh [outdir]
set -eu
# A temporary build folder is emptied file by file, by name, then its empty folders (never a whole folder at once).
clear_by_name() { [ -d "$1" ] || return 0; find "$1" \( -type f -o -type l \) -exec rm -f -- {} +; find "$1" -depth -type d -empty -exec rmdir -- {} +; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/dist}"
VER="$(node -p "require('$SRC/package.json').version")"
STAGE="$(mktemp -d)"
DIR="$STAGE/morph"
mkdir -p "$DIR/ocr" "$DIR/bin" "$DIR/daemon" "$DIR/lib" "$DIR/src/core" "$DIR/gnome-extension" "$OUT"
cp "$SRC/bin/morph" "$DIR/bin/"
cp "$SRC/LICENSE" "$DIR/"
cp "$SRC/ocr/morph_ocr.py" "$DIR/ocr/"
cp "$SRC/daemon/core.js" "$SRC/daemon/gjs-main.js" "$SRC/daemon/pdf-doc.js" "$SRC/daemon/pdf.js" "$DIR/daemon/"
cp "$SRC/lib/rules.js" "$SRC/lib/source.js" "$SRC/lib/slack.js" "$SRC/lib/keys.js" "$SRC/lib/links.js" "$DIR/lib/"
cp "$SRC"/src/core/*.js "$DIR/src/core/"
cp -r "$SRC/gnome-extension/morph-focus@morph.dev" "$DIR/gnome-extension/"
printf '{\n  "name": "morph",\n  "version": "%s"\n}\n' "$VER" > "$DIR/package.json"
cat > "$DIR/README.txt" <<TXT
Morph $VER for Linux (GNOME)

1. Open a terminal in this folder and run:   bin/morph --install
2. Morph then starts by itself and opens a short setup page.

Other commands: --start  --stop  --restart  --status  --uninstall
Needs: GNOME (Ubuntu, Fedora Workstation...) with gjs, which is already part of GNOME.
Nothing you copy leaves your computer.
TXT
chmod +x "$DIR/bin/morph"
# Every file the download holds, so --uninstall and --update can delete Morph's files by name (never a whole folder).
(cd "$DIR" && { find . -type f ! -name MANIFEST | sed 's#^\./##' | LC_ALL=C sort; echo MANIFEST; }) > "$DIR/MANIFEST"
rm -f "$OUT/morph-$VER-linux.zip"
(cd "$STAGE" && zip -qr "$OUT/morph-$VER-linux.zip" morph)
clear_by_name "$STAGE"
# What the app and the installer ask the website for: newest version, file, fingerprint.
SHA="$(sha256sum "$OUT/morph-$VER-linux.zip" | cut -d' ' -f1)"
printf '{\n  "version": "%s",\n  "zip": "morph-%s-linux.zip",\n  "sha256": "%s"\n}\n' "$VER" "$VER" "$SHA" > "$OUT/version.json"
echo "$OUT/morph-$VER-linux.zip"
