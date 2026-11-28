#!/usr/bin/env bash
# Builds the Mac lab's stand-in apps into a folder: bash mac/lab/build-fakes.sh <out>
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?out folder}
mkdir -p "$OUT"
swiftc -O -swift-version 5 -framework AppKit mac/lab/FakeApp.swift -o "$OUT/fake-bin"
# key | bundle id | window title | plain text only
while IFS='|' read -r key id title plain; do
  [ -n "$key" ] || continue
  A="$OUT/$key.app"
  mkdir -p "$A/Contents/MacOS"
  cp "$OUT/fake-bin" "$A/Contents/MacOS/$key"
  cat > "$A/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$id</string>
<key>CFBundleName</key><string>$key</string>
<key>CFBundleExecutable</key><string>$key</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>MorphLabKey</key><string>$key</string>
<key>MorphLabTitle</key><string>$title</string>
<key>MorphLabPlain</key><string>$plain</string>
</dict></plist>
PL
  codesign --force --sign - "$A" >/dev/null 2>&1
done <<'APPS'
slack|com.tinyspeck.slackmacgap|general - Acme - Slack|0
jira|dev.morph.lab.browser.jira|[ABC-12] Login fails - Jira|0
chat|dev.morph.lab.browser.chat|ChatGPT|0
keepass|org.keepassxc.keepassxc|Passwords.kdbx - KeePassXC|1
editor|dev.morph.lab.editor|notes.txt|1
APPS
rm -f "$OUT/fake-bin"
echo "built the lab apps in $OUT"
