#!/usr/bin/env bash
# Builds the website and downloads into docs/, which GitHub Pages serves at https://mohitanand001.github.io/morph/
# Usage: tools/build-site.sh
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$SRC/package.json').version")"
DEBVER="$(printf '%s' "$VER" | sed 's/-/~/')"
DOCS="$SRC/docs"
# A new build must carry a new version, or installed copies would not see it as an update.
if [ -f "$DOCS/version.json" ] && grep -q "\"version\": \"$VER\"" "$DOCS/version.json" && [ "${SAME_VERSION:-0}" != 1 ]; then
  echo "docs/ already has version $VER. Bump \"version\" in package.json (or set SAME_VERSION=1 for a site-only change)." >&2
  exit 1
fi
TMP="$(mktemp -d)"
bash "$SRC/tools/build-linux-zip.sh" "$TMP" >/dev/null
bash "$SRC/tools/build-deb.sh" "$TMP" >/dev/null
node "$SRC/tools/build-demo.js" "$TMP/try.html" >/dev/null
# The old site goes file by file, by name (never a whole folder at once).
if [ -d "$DOCS" ]; then
  for f in "$DOCS"/morph-*-linux.zip "$DOCS"/morph_*_all.deb "$DOCS/version.json" "$DOCS/try.html" "$DOCS/install.sh" "$DOCS/install-mac.sh" "$DOCS/index.html" "$DOCS/.nojekyll"; do
    if [ -f "$f" ]; then rm -f -- "$f"; fi
  done
  for f in "$SRC"/site/fonts/*; do rm -f -- "$DOCS/fonts/$(basename "$f")"; done
  rmdir -- "$DOCS/fonts" 2>/dev/null || true
fi
mkdir -p "$DOCS"
cp "$TMP/morph-$VER-linux.zip" "$TMP/version.json" "$TMP/try.html" "$DOCS/"
# The .deb is published under a plain name (no ~), which every browser and server handles.
cp "$TMP/morph_${DEBVER}_all.deb" "$DOCS/morph_${VER}_all.deb"
cp "$SRC/site/install.sh" "$DOCS/install.sh"
cp "$SRC/site/install-mac.sh" "$DOCS/install-mac.sh"
# Fonts are served from the site itself: a visit sends nothing to a font service.
mkdir -p "$DOCS/fonts"
cp "$SRC"/site/fonts/* "$DOCS/fonts/"
sed -e "s/VERSION/$VER/g" -e "s/DEBFILE/morph_${VER}_all.deb/g" "$SRC/site/index.html" > "$DOCS/index.html"
touch "$DOCS/.nojekyll"
rm -f -- "$TMP/morph-$VER-linux.zip" "$TMP/version.json" "$TMP/try.html" "$TMP/morph_${DEBVER}_all.deb"
rmdir -- "$TMP" 2>/dev/null || echo "note: $TMP kept (it holds files this script did not make)"
echo "docs/ ready: version $VER"
