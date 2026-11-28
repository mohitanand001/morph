#!/usr/bin/env bash
# Temporary: what the CI Mac allows (SIP, TCC, pasteboard privacy). Prints annotations.
n() { printf '::notice title=%s::%s\n' "$1" "$(printf '%s' "$2" | tr '\n%' '  ' | cut -c1-900)"; }
n sip "$(csrutil status 2>&1)"
n os "$(sw_vers 2>&1)"
n tcc-sys-access "$(sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "select service,client,client_type,auth_value from access where service like '%Accessib%' or service like '%PostEvent%' or service like '%Paste%' limit 20" 2>&1)"
n tcc-user-access "$(sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "select service,client,client_type,auth_value from access limit 30" 2>&1)"
n tcc-schema "$(sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' '.schema access' 2>&1)"
cat > /tmp/pb.swift <<'S'
import AppKit
import ApplicationServices
let pb = NSPasteboard.general
#if compiler(>=6.1)
if #available(macOS 15.4, *) { print("accessBehavior=\(pb.accessBehavior.rawValue)") }
#endif
print("types=\(pb.types?.map{$0.rawValue} ?? [])")
let t0 = Date()
print("trusted=\(AXIsProcessTrusted())")
print("string=\(pb.string(forType: .string) ?? "nil") in \(Date().timeIntervalSince(t0))s")
S
swiftc -O /tmp/pb.swift -o /tmp/pb 2>&1 | tail -3
printf 'copied by pbcopy %s' "$(date)" | pbcopy
n pasteboard-other-app "$(perl -e "alarm 20; exec @ARGV" /tmp/pb 2>&1; echo exit=$?)"
n whoami "$(id; echo; ls -la /Library/Application\ Support/com.apple.TCC/ 2>&1)"
n services-sys "$(sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' 'select distinct service from access' 2>&1)"
n services-user "$(sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" 'select distinct service from access' 2>&1)"
sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "insert or replace into access (service,client,client_type,auth_value,auth_reason,auth_version,csreq,flags) values ('kTCCServiceAccessibility','/tmp/pb',1,2,4,1,NULL,0)"
printf 'second copy %s' "$(date)" | pbcopy
n after-grant "$(perl -e "alarm 20; exec @ARGV" /tmp/pb 2>&1; echo exit=$?)"
n pb-log "$(log show --last 2m --predicate 'process == "tccd" OR subsystem == "com.apple.pasteboard"' --style compact 2>/dev/null | grep -i "pb\|paste" | tail -8)"
