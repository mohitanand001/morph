// The Mac pieces Morph uses: the clipboard, the app in front, pressing ⌘V, and global shortcuts.
import AppKit
import ApplicationServices
import Carbon

enum Clip {
    static let own = NSPasteboard.PasteboardType("dev.morph.own")
    static var pb: NSPasteboard { NSPasteboard.general }

    /// Goes up by one with every copy, in any app. Looking at it reads nothing.
    static func changeCount() -> Int { pb.changeCount }
    /// The formats on the clipboard (names only, no content).
    static func types() -> [String] { (pb.types ?? []).map { $0.rawValue } }

    /// What was copied, as HTML and text. Apps that only offer RTF (Notes, TextEdit, Pages) are read as HTML too.
    static func read() -> [String: Any] {
        let t = types()
        var html = pb.string(forType: .html) ?? ""
        if html.isEmpty, let rtf = pb.data(forType: .rtf) ?? pb.data(forType: .rtfd), rtf.count < 5_000_000,
           let a = NSAttributedString(rtf: rtf, documentAttributes: nil) ?? NSAttributedString(rtfd: rtf, documentAttributes: nil),
           let d = try? a.data(from: NSRange(location: 0, length: a.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.html]) {
            html = String(decoding: d, as: UTF8.self)
        }
        let text = pb.string(forType: .string) ?? ""
        return ["types": t, "text": String(text.prefix(2_000_000)), "html": String(html.prefix(5_000_000))]
    }

    /// Puts both versions on the clipboard: HTML (and RTF made from it, for Mac apps that prefer RTF) and plain text,
    /// marked as Morph's own so it is never taken for a new copy.
    static func write(html: String, text: String) -> Bool {
        var rtf: Data?
        if !html.isEmpty, html.utf8.count < 2_000_000,
           let a = try? NSAttributedString(data: Data(html.utf8), options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil) {
            rtf = try? a.data(from: NSRange(location: 0, length: a.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        }
        pb.clearContents()
        var ok = true
        if !html.isEmpty { ok = pb.setString(html, forType: .html) && ok }
        if let rtf = rtf { _ = pb.setData(rtf, forType: .rtf) }
        if !text.isEmpty { ok = pb.setString(text, forType: .string) && ok }
        _ = pb.setData(Data(), forType: own)
        _ = pb.setString(Bundle.main.bundleIdentifier ?? "dev.morph.app", forType: NSPasteboard.PasteboardType("org.nspasteboard.source"))
        return ok && (!html.isEmpty || !text.isEmpty)
    }
}

enum Front {
    /// The app in front: its bundle id, its name, and the title of its front window (the title needs Accessibility;
    /// without it, the title is empty and Morph goes by the app alone).
    static func now() -> [String: String] {
        guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
        var title = ""
        if AXIsProcessTrusted() {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 0.25)
            var win: CFTypeRef?
            if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &win) == .success, let w = win, CFGetTypeID(w) == AXUIElementGetTypeID() {
                var t: CFTypeRef?
                if AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &t) == .success, let s = t as? String { title = String(s.prefix(300)) }
            }
        }
        return ["app": app.bundleIdentifier ?? app.localizedName ?? "", "name": app.localizedName ?? "", "title": title]
    }
}

enum Keys {
    /// Presses ⌘V in the app in front. Needs Accessibility; false without it.
    static func pasteCommandV() -> Bool {
        guard AXIsProcessTrusted() else { return false }
        let src = CGEventSource(stateID: .combinedSessionState)
        let v = CGKeyCode(kVK_ANSI_V)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: false) else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        return true
    }
}

/// Global shortcuts (Carbon hot keys: they need no permission).
final class Hotkeys {
    static let shared = Hotkeys()
    var onPress: ((String) -> Void)?
    private var refs: [EventHotKeyRef] = []
    private var ids: [UInt32: String] = [:]
    private var installed = false

    private func install() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            let st = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            if st == noErr, let id = Hotkeys.shared.ids[hk.id] { DispatchQueue.main.async { Hotkeys.shared.onPress?(id) } }
            return noErr
        }, 1, &spec, nil, nil)
    }

    /// Registers these shortcuts instead of the current ones. Returns the ids another app already holds.
    func set(_ list: [(String, String)]) -> [String] {
        install()
        refs.forEach { UnregisterEventHotKey($0) }
        refs = []
        ids = [:]
        var failed: [String] = []
        for (n, (id, accel)) in list.prefix(10).enumerated() {
            guard let (code, mods) = Hotkeys.parse(accel) else { failed.append(id); continue }
            var ref: EventHotKeyRef?
            let hid = EventHotKeyID(signature: OSType(0x4D52_5048), id: UInt32(n + 1)) // "MRPH"
            let st = RegisterEventHotKey(code, mods, hid, GetApplicationEventTarget(), 0, &ref)
            if st == noErr, let r = ref { refs.append(r); ids[UInt32(n + 1)] = id } else { failed.append(id) }
        }
        return failed
    }

    /// "<Control><Alt>v" → key code and Carbon modifiers.
    static func parse(_ accel: String) -> (UInt32, UInt32)? {
        var mods: UInt32 = 0
        var rest = accel
        let names: [(String, Int)] = [("<Control>", controlKey), ("<Alt>", optionKey), ("<Shift>", shiftKey), ("<Super>", cmdKey)]
        var changed = true
        while changed {
            changed = false
            for (n, m) in names where rest.hasPrefix(n) { mods |= UInt32(m); rest.removeFirst(n.count); changed = true }
        }
        guard mods != 0, let code = keyCodes[rest.lowercased()] else { return nil }
        return (UInt32(code), mods)
    }
    static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
        "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
        "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
        "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
        "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
        "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
    ]
}
