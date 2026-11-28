#!/usr/bin/env bash
# Builds Morph.app and Morph-mac.zip on a Mac (Xcode command line tools and Node needed).
#   bash mac/build.sh            -> mac/build/Morph.app, mac/build/Morph-mac.zip (+ .sha256)
# The app is signed "ad hoc" (no Apple developer certificate). Installed with the install script (curl), macOS
# does not quarantine it, so it opens without the "unidentified developer" warning.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=$ROOT/mac/build
APP=$OUT/Morph.app
VERSION=$(node -p "require('./package.json').version")

# Only Morph's own build output is cleared, by name (never a whole folder by wildcard).
if [ -d "$APP" ]; then
  # An app bundle is a folder: it is moved aside into a new temporary folder, never deleted whole.
  mv "$APP" "$(mktemp -d)/old-Morph.app"
fi
rm -f -- "$OUT/Morph-mac.zip" "$OUT/Morph-mac.zip.sha256"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The JavaScript: converter + logic + Mac host, and the panel page.
node tools/build-mac.js "$APP/Contents/Resources" >/dev/null

# The Swift app, for Apple silicon and Intel.
ARCHS=${ARCHS:-"arm64 x86_64"}
BINS=()
for a in $ARCHS; do
  swiftc -O -swift-version 5 -target "$a-apple-macos13.0" \
    -framework AppKit -framework WebKit -framework JavaScriptCore -framework Vision -framework Carbon \
    -framework ServiceManagement -framework PDFKit -framework CryptoKit \
    mac/Sources/*.swift -o "$OUT/Morph-$a"
  BINS+=("$OUT/Morph-$a")
done
lipo -create "${BINS[@]}" -output "$APP/Contents/MacOS/Morph"
for b in "${BINS[@]}"; do rm -f "$b"; done

sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# The icon, from build/icon.png.
ICONSET=$(mktemp -d)/Morph.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Morph.icns"

codesign --force --sign - --timestamp=none "$APP"
codesign --verify "$APP"

(cd "$OUT" && ditto -c -k --keepParent Morph.app Morph-mac.zip && shasum -a 256 Morph-mac.zip > Morph-mac.zip.sha256)
echo "built $APP ($VERSION)"
cat "$OUT/Morph-mac.zip.sha256"
