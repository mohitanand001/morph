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
let pb = NSPasteboard.general
#if compiler(>=6.1)
if #available(macOS 15.4, *) { print("accessBehavior=\(pb.accessBehavior.rawValue)") }
#endif
print("types=\(pb.types?.map{$0.rawValue} ?? [])")
let t0 = Date()
print("string=\(pb.string(forType: .string) ?? "nil") in \(Date().timeIntervalSince(t0))s")
S
swiftc -O /tmp/pb.swift -o /tmp/pb 2>&1 | tail -3
printf 'copied by pbcopy %s' "$(date)" | pbcopy
n pasteboard-other-app "$(timeout 20 /tmp/pb 2>&1; echo exit=$?)"
n whoami "$(id; echo; ls -la /Library/Application\ Support/com.apple.TCC/ 2>&1)"
