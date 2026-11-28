#!/usr/bin/env bash
# The Mac lab, on a CI Mac (GitHub Actions macos runner): run after mac/build.sh.
#   1. Morph with stand-in apps, real keys, mouse and clipboard (Morph --lab)
#   2. the installer (site/install-mac.sh) from a local copy of the website and releases, twice
#   3. an update to a newer version, from that local copy (the real updater)
#   4. uninstall (the real uninstaller)
# Results: $OUT/*.json, one annotation per failure and a summary per part. Never run it on your own Mac: it
# installs, updates and uninstalls Morph.app in a temporary folder and stops Morph processes it started.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
T=${RUNNER_TEMP:?run this in CI}/maclab
OUT=${1:-$T/out}
mkdir -p "$T" "$OUT"
APP="$ROOT/mac/build/Morph.app"
V=$(node -p "require('./package.json').version")
alarm() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }
note() { printf '::notice title=%s::%s\n' "$1" "$(printf '%s' "$2" | tr '\n%' '  ' | cut -c1-3000)"; }
fail=0
checks=()
check() { # name ok detail
  if [ "$2" = 1 ]; then checks+=("ok $1"); else checks+=("FAIL $1"); fail=1; printf '::error title=FAIL::%s | %s\n' "$1" "$(printf '%s' "$3" | tr '\n%' '  ' | cut -c1-300)"; fi
}
report_json() { # file part
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const part = process.argv[2];
    const clean = (t) => String(t).replace(/[\r\n%]/g, " ");
    for (const x of r.results.filter((x) => !x.ok)) console.log("::error title=FAIL " + part + "::" + clean(x.name + " | " + x.detail).slice(0, 400));
    console.log("::notice title=" + part + "::" + r.passed + " passed, " + r.failed + " failed :: " + clean(r.results.map((x) => (x.ok ? "ok " : "FAIL ") + x.name).join(" ; ")));
    process.exit(r.failed ? 1 : 0);' "$1" "$2"
}
morph_pids() { pgrep -f "$1/Morph.app/Contents/MacOS/Morph" || true; }
stop_morph() { for p in $(morph_pids "$1"); do kill "$p" 2>/dev/null || true; done; sleep 1; }
plist_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null; }

# ---------------------------------------------------------------- 1. the lab
bash mac/lab/build-fakes.sh "$T/apps" >/dev/null || { echo "::error title=FAIL::could not build the stand-in apps"; exit 1; }
mkdir -p "$T/home-lab"
MORPH_HOME="$T/home-lab" MORPH_LAB_APPS="$T/apps" alarm 400 "$APP/Contents/MacOS/Morph" --lab "$OUT/lab.json"
if [ -f "$OUT/lab.json" ]; then report_json "$OUT/lab.json" lab || fail=1; else echo "::error title=FAIL lab::the lab wrote no results"; fail=1; fi
tail -n 40 "$T/home-lab/Logs/Morph.log" 2>/dev/null
for k in slack jira chat keepass editor; do for p in $(pgrep -f "$T/apps/$k.app/" || true); do kill "$p" 2>/dev/null || true; done; done

# ---------------------------------------------------------------- 2. the installer
SRV="$T/srv"
mkdir -p "$SRV/rel/v$V"
cp mac/build/Morph-mac.zip "$SRV/rel/v$V/"
(cd "$SRV/rel/v$V" && shasum -a 256 Morph-mac.zip > Morph-mac.zip.sha256)
printf '{ "version": "%s" }\n' "$V" > "$SRV/version.json"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$SRV" >/dev/null 2>&1 &
SERVER=$!
sleep 1
APPS="$T/Applications"
inst() { MORPH_BASE_URL=http://127.0.0.1:8765 MORPH_RELEASES_URL=http://127.0.0.1:8765/rel MORPH_APPS="$APPS" alarm 120 bash site/install-mac.sh; }
out1=$(inst 2>&1); code1=$?
sleep 3
check "the installer puts Morph.app $V in Applications" "$([ $code1 = 0 ] && [ "$(plist_version "$APPS/Morph.app")" = "$V" ] && echo 1)" "$out1"
check "…and starts it" "$([ -n "$(morph_pids "$APPS")" ] && echo 1)" "$(ps ax | grep -i morph | head -5)"
check "…from a download it checked: codesign verifies the app" "$(codesign --verify "$APPS/Morph.app" 2>/dev/null && echo 1)" "$(codesign --verify "$APPS/Morph.app" 2>&1)"
check "…with no quarantine mark (no 'unidentified developer' warning)" "$([ -z "$(xattr -p com.apple.quarantine "$APPS/Morph.app" 2>/dev/null)" ] && echo 1)" "$(xattr -l "$APPS/Morph.app")"
before=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph-' || true)
out2=$(inst 2>&1); code2=$?
sleep 2
after=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph-' || true)
check "running it again replaces the app, the old one goes to the Bin" "$([ $code2 = 0 ] && [ "$after" -gt "$before" ] && [ "$(morph_pids "$APPS" | wc -l | tr -d ' ')" = 1 ] && echo 1)" "$out2 / bin $before→$after / pids $(morph_pids "$APPS" | tr '\n' ' ')"
cp "$SRV/rel/v$V/Morph-mac.zip.sha256" "$T/sha.keep"
printf '%064d  Morph-mac.zip\n' 0 > "$SRV/rel/v$V/Morph-mac.zip.sha256"
out3=$(inst 2>&1); code3=$?
cp "$T/sha.keep" "$SRV/rel/v$V/Morph-mac.zip.sha256"
check "a download that doesn't match its fingerprint is not installed" "$([ $code3 != 0 ] && echo "$out3" | grep -q fingerprint && [ "$(plist_version "$APPS/Morph.app")" = "$V" ] && echo 1)" "$out3"
stop_morph "$APPS"

# ---------------------------------------------------------------- 3. an update, with the real updater
NEW=9.9.9
mkdir -p "$T/new" "$SRV/rel/v$NEW"
ditto "$APP" "$T/new/Morph.app"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW" -c "Set :CFBundleVersion $NEW" "$T/new/Morph.app/Contents/Info.plist"
codesign --force --sign - "$T/new/Morph.app" >/dev/null 2>&1
(cd "$T/new" && ditto -c -k --keepParent Morph.app "$SRV/rel/v$NEW/Morph-mac.zip")
(cd "$SRV/rel/v$NEW" && shasum -a 256 Morph-mac.zip > Morph-mac.zip.sha256)
mkdir -p "$T/home-upd"
before=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph' || true)
uout=$(MORPH_HOME="$T/home-upd" MORPH_RELEASES_URL=http://127.0.0.1:8765/rel/ alarm 120 "$APPS/Morph.app/Contents/MacOS/Morph" --lab-update "$NEW" 2>&1); ucode=$?
sleep 3
after=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph' || true)
check "the updater downloads $NEW, checks it and puts it in place" "$([ $ucode = 0 ] && [ "$(plist_version "$APPS/Morph.app")" = "$NEW" ] && echo 1)" "$uout / $(tail -5 "$T/home-upd/Logs/Morph.log" 2>/dev/null)"
check "…the old version goes to the Bin" "$([ "$after" -gt "$before" ] && echo 1)" "bin $before→$after"
check "…and the new version is started" "$([ -n "$(morph_pids "$APPS")" ] && echo 1)" "$(ps ax | grep -i 'Morph.app' | head -5)"
stop_morph "$APPS"
printf '%064d  Morph-mac.zip\n' 0 > "$SRV/rel/v$NEW/Morph-mac.zip.sha256"
bout=$(MORPH_HOME="$T/home-upd" MORPH_RELEASES_URL=http://127.0.0.1:8765/rel/ alarm 120 "$APPS/Morph.app/Contents/MacOS/Morph" --lab-update "$NEW" 2>&1); bcode=$?
check "an update that doesn't match its checksum is refused, the app stays" "$([ $bcode != 0 ] && [ -d "$APPS/Morph.app" ] && echo 1)" "$bout"
kill "$SERVER" 2>/dev/null || true

# ---------------------------------------------------------------- 4. uninstall, with the real uninstaller
H="$T/home-un"
mkdir -p "$H/Support" "$H/Logs"
printf '{"setupDone":true}' > "$H/Support/settings.json"
printf '1' > "$H/Support/login-item-added"
printf '1' > "$H/Support/asked-accessibility"
printf 'not Morph' > "$H/Support/yours.txt"
printf 'log' > "$H/Logs/Morph.log"
before=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph' || true)
nout=$(MORPH_HOME="$H" alarm 60 "$APPS/Morph.app/Contents/MacOS/Morph" --lab-uninstall 2>&1)
sleep 1
after=$(ls "$HOME/.Trash" 2>/dev/null | grep -c '^Morph' || true)
check "uninstall removes Morph's settings and log, by name" "$([ ! -e "$H/Support/settings.json" ] && [ ! -e "$H/Support/login-item-added" ] && [ ! -e "$H/Logs/Morph.log" ] && echo 1)" "$nout / $(ls -la "$H/Support" "$H/Logs")"
check "…keeps a file that is not Morph's, and its folder" "$([ -f "$H/Support/yours.txt" ] && echo 1)" "$(ls -la "$H/Support")"
check "…and moves Morph.app to the Bin" "$([ ! -e "$APPS/Morph.app" ] && [ "$after" -gt "$before" ] && echo 1)" "$nout / bin $before→$after"

note "install-update-uninstall" "$(printf '%s ; ' "${checks[@]}")"
printf '%s\n' "${checks[@]}" > "$OUT/install-update-uninstall.txt"
exit $fail
