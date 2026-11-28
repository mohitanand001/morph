// A stand-in app for the Mac lab: one window with a title and a text area, under any bundle id (Slack, a password
// manager, a browser tab named "… - Jira"). The lab tells it what to copy, and asks what was pasted into it, through
// distributed notifications (dev.morph.lab.cmd / dev.morph.lab.reply, the object is the app's lab key).
// Built by mac/lab/build-fakes.sh; Info.plist keys MorphLabKey, MorphLabTitle, MorphLabPlain.
import AppKit

final class Fake: NSObject, NSApplicationDelegate {
    let key = Bundle.main.object(forInfoDictionaryKey: "MorphLabKey") as? String ?? "app"
    let title = Bundle.main.object(forInfoDictionaryKey: "MorphLabTitle") as? String ?? "App"
    let plain = (Bundle.main.object(forInfoDictionaryKey: "MorphLabPlain") as? String) == "1"
    var window: NSWindow!
    var text: NSTextView!
    var copies = 0

    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 520, height: 320), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = title
        let scroll = NSTextView.scrollableTextView()
        text = scroll.documentView as? NSTextView
        text.isRichText = !plain
        text.importsGraphics = false
        text.allowsUndo = true
        window.contentView = scroll
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(text)
        NSApp.activate(ignoringOtherApps: true)
        let c = DistributedNotificationCenter.default()
        c.addObserver(self, selector: #selector(cmd(_:)), name: NSNotification.Name("dev.morph.lab.cmd"), object: key, suspensionBehavior: .deliverImmediately)
        reply(["event": "ready"])
    }
    func applicationDidBecomeActive(_ n: Notification) { window.makeKeyAndOrderFront(nil); window.makeFirstResponder(text) }

    @objc func cmd(_ n: Notification) {
        let u = n.userInfo ?? [:]
        let id = u["id"] as? String ?? ""
        switch u["cmd"] as? String ?? "" {
        case "copy":
            // As if you selected something and pressed ⌘C in this app.
            let pb = NSPasteboard.general
            pb.clearContents()
            if let h = u["html"] as? String, !h.isEmpty { pb.setString(h, forType: .html) }
            if let r = u["rtf"] as? String, !r.isEmpty, let a = try? NSAttributedString(data: Data(r.utf8), options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil),
               let d = try? a.data(from: NSRange(location: 0, length: a.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) { pb.setData(d, forType: .rtf) }
            if let t = u["text"] as? String, !t.isEmpty { pb.setString(t, forType: .string) }
            if (u["concealed"] as? String) == "1" { pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) }
            if let rows = u["image"] as? String, let png = Fake.tablePNG(rows) { pb.setData(png, forType: .png) }
            copies += 1
            reply(["id": id, "copies": String(copies)])
        case "clear":
            text.string = ""
            reply(["id": id])
        case "report":
            let s = text.attributedString()
            var bold = false
            s.enumerateAttribute(.font, in: NSRange(location: 0, length: s.length)) { v, _, _ in
                if let f = v as? NSFont, f.fontDescriptor.symbolicTraits.contains(.bold) { bold = true }
            }
            reply(["id": id, "text": text.string, "bold": bold ? "1" : "0", "key": NSApp.isActive ? "active" : "inactive"])
        default: break
        }
    }

    func reply(_ info: [String: String]) {
        DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("dev.morph.lab.reply"), object: key, userInfo: info, deliverImmediately: true)
    }

    /// A picture of a table ("a|b;c|d" rows), as a screenshot would be.
    static func tablePNG(_ spec: String) -> Data? {
        let rows = spec.split(separator: ";").map { $0.split(separator: "|").map(String.init) }
        let W = 900, H = 60 + rows.count * 55
        let img = NSImage(size: NSSize(width: W, height: H))
        img.lockFocus()
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
        for (i, row) in rows.enumerated() {
            for (j, cell) in row.enumerated() {
                (cell as NSString).draw(at: NSPoint(x: 30 + j * 220, y: H - 50 - i * 55), withAttributes: [.font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black])
            }
        }
        img.unlockFocus()
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fake = Fake()
app.delegate = fake
app.run()
