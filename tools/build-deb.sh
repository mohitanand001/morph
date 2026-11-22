#!/usr/bin/env bash
# Builds morph_<version>_all.deb: program in /usr/lib/morph, command in /usr/bin, a launcher in the app menu and a
# login autostart. Per-user setup (the GNOME helper) happens by itself at first login or from the app menu.
# Usage: tools/build-deb.sh [absolute outdir]
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/dist}"
VER="$(node -p "require('$SRC/package.json').version")"
DEBVER="$(printf '%s' "$VER" | sed 's/-/~/')"   # 0.15.0-rc.1 -> 0.15.0~rc.1 (sorts before 0.15.0)
STAGE="$(mktemp -d)"; ZTMP="$(mktemp -d)"
bash "$SRC/tools/build-linux-zip.sh" "$ZTMP" >/dev/null
P="$STAGE/pkg"
mkdir -p "$P/usr/lib" "$P/usr/bin" "$P/usr/share/applications" "$P/etc/xdg/autostart" "$P/DEBIAN" "$OUT"
unzip -q "$ZTMP/morph-$VER-linux.zip" -d "$P/usr/lib"
rm -f "$P/usr/lib/morph/README.txt"
mkdir -p "$P/usr/share/doc/morph" && cp "$SRC/LICENSE" "$P/usr/share/doc/morph/copyright"
ln -s ../lib/morph/bin/morph "$P/usr/bin/morph"
cat > "$P/usr/share/applications/morph.desktop" <<'D'
[Desktop Entry]
Type=Application
Name=Morph
Comment=Paste formatted content correctly anywhere
Exec=morph --session
Icon=edit-paste
Terminal=false
Categories=Utility;
D
cat > "$P/etc/xdg/autostart/morph.desktop" <<'D'
[Desktop Entry]
Type=Application
Name=Morph
Comment=Paste formatted content correctly anywhere
Exec=morph --session
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=4
OnlyShowIn=GNOME;
Terminal=false
D
cat > "$P/DEBIAN/control" <<C
Package: morph
Version: $DEBVER
Section: utils
Priority: optional
Architecture: all
Depends: gjs, gnome-shell, bash, coreutils
Recommends: python3-venv
Maintainer: Morph <noreply@example.invalid>
Description: Paste formatted content correctly anywhere (GNOME)
 Morph re-shapes what you copy for the app you paste into. Your clipboard
 stays on your device; nothing you copy is uploaded or stored.
 .
 Installing starts Morph at your next login, or open "Morph" from the app menu
 to start it now. Optional table OCR: morph --enable-ocr
C
cat > "$P/DEBIAN/prerm" <<'S'
#!/bin/sh
set -e
pkill -f 'gjs.*/usr/lib/morph/daemon/gjs-main.js' 2>/dev/null || true
exit 0
S
chmod 755 "$P/DEBIAN/prerm"
find "$P/usr" "$P/etc" -type d -exec chmod 755 {} +
find "$P/usr" "$P/etc" -type f -exec chmod 644 {} +
chmod 755 "$P/usr/lib/morph/bin/morph"
(cd "$P" && find usr etc -type f -exec md5sum {} + > DEBIAN/md5sums)
rm -f "$OUT/morph_${DEBVER}_all.deb"
dpkg-deb --root-owner-group --build "$P" "$OUT/morph_${DEBVER}_all.deb" >/dev/null
rm -rf "$STAGE" "$ZTMP"
echo "$OUT/morph_${DEBVER}_all.deb"
