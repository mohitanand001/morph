#!/usr/bin/env bash
# Builds the website and downloads into docs/, which GitHub Pages serves at https://mohitanand001.github.io/morph/
# Usage: tools/build-site.sh
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$SRC/package.json').version")"
DEBVER="$(printf '%s' "$VER" | sed 's/-/~/')"
DOCS="$SRC/docs"
TMP="$(mktemp -d)"
bash "$SRC/tools/build-linux-zip.sh" "$TMP" >/dev/null
bash "$SRC/tools/build-deb.sh" "$TMP" >/dev/null
node "$SRC/tools/build-demo.js" "$TMP/try.html" >/dev/null
rm -rf "$DOCS"; mkdir -p "$DOCS"
cp "$TMP/morph-$VER-linux.zip" "$TMP/version.json" "$TMP/try.html" "$DOCS/"
# The .deb is published under a plain name (no ~), which every browser and server handles.
cp "$TMP/morph_${DEBVER}_all.deb" "$DOCS/morph_${VER}_all.deb"
cp "$SRC/site/install.sh" "$DOCS/install.sh"
sed -e "s/VERSION/$VER/g" -e "s/DEBFILE/morph_${VER}_all.deb/g" "$SRC/site/index.html" > "$DOCS/index.html"
touch "$DOCS/.nojekyll"
rm -rf "$TMP"
echo "docs/ ready: version $VER"
