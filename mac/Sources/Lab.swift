// Morph.app/Contents/MacOS/Morph --lab <results.json>   (CI only: needs MORPH_HOME and MORPH_LAB_APPS)
// The Mac lab: the real Morph (logic, panel, shortcuts, clipboard) with stand-in apps (mac/lab/FakeApp.swift) that
// copy and paste through the real clipboard, real key presses and real mouse clicks. Like Morph Lab on Linux.
import AppKit
import Carbon

@MainActor
final class Lab: NSObject, NSApplicationDelegate {
    let out: String
    var results: [[String: Any]] = []
    var bridge: Bridge!
    var panel: Panel!
    var paths: Paths!
    var appsDir = ""
    var replies: [String: [String: String]] = [:]
    var ready: Set<String> = []
    var seq = 0
    let ids = ["slack": "com.tinyspeck.slackmacgap", "jira": "dev.morph.lab.browser.jira", "chat": "dev.morph.lab.browser.chat", "keepass": "org.keepassxc.keepassxc", "editor": "dev.morph.lab.editor"]

    nonisolated init(out: String) { self.out = out; super.init() }

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        results.append(["name": name, "ok": ok, "detail": String(detail.prefix(500))])
        print((ok ? "ok    " : "FAIL  ") + name + (ok || detail.isEmpty ? "" : "  (" + String(detail.prefix(300)) + ")"))
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        let env = ProcessInfo.processInfo.environment
        guard env["MORPH_HOME"] != nil, let apps = env["MORPH_LAB_APPS"] else { print("Needs MORPH_HOME and MORPH_LAB_APPS."); exit(2) }
        appsDir = apps
        paths = Paths.standard()
        Log.url = paths.log
        try? FileManager.default.createDirectory(at: paths.downloads, withIntermediateDirectories: true)
        _ = Files.writePrivate(#"{"setupDone":true}"#, to: paths.settings)
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("dev.morph.lab.reply"), object: nil, queue: .main) { [weak self] n in
            let u = (n.userInfo as? [String: String]) ?? [:]
            let k = n.object as? String
            Task { @MainActor in
                if u["event"] == "ready", let k = k { self?.ready.insert(k) }
                if let id = u["id"], !id.isEmpty { self?.replies[id] = u }
            }
        }
        bridge = Bridge(paths: paths)
        panel = Panel()
        bridge.panel = panel
        panel.onAction = { [weak self] a in self?.bridge.action(a) }
        guard bridge.load() else { check("morph.js loads", false); finish(); return }
        bridge.start()
        Task { @MainActor in await self.run(); self.finish() }
    }

    // ---------------------------------------------------------------- helpers
    func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
    func waitFor(_ timeout: Double, _ cond: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if await cond() { return true }; await sleep(0.1) }
        return await cond()
    }
    /// Opens a stand-in app (or brings it to the front) and waits until the Mac says it is in front.
    @discardableResult
    func open(_ key: String) async -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", appsDir + "/" + key + ".app"]
        try? p.run()
        let id = ids[key] ?? ""
        let front = await waitFor(10) { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id && self.ready.contains(key) }
        await sleep(0.9) // Morph looks at the app in front every 0.7 s
        return front
    }
    func cmd(_ key: String, _ info: [String: String]) async -> [String: String]? {
        seq += 1
        let id = "\(seq)"
        var u = info; u["id"] = id
        DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("dev.morph.lab.cmd"), object: key, userInfo: u, deliverImmediately: true)
        _ = await waitFor(5) { self.replies[id] != nil }
        return replies[id]
    }
    var lastCopy: [String: String] = [:]
    func copy(_ key: String, _ info: [String: String]) async {
        let before = Clip.changeCount()
        lastCopy = await cmd(key, ["cmd": "copy"].merging(info) { $1 }) ?? [:]
        _ = await waitFor(3) { Clip.changeCount() != before }
        await sleep(0.6) // Morph looks for new copies every 0.3 s
    }
    /// A real key press, as from the keyboard: the modifier keys go down first, then the key, then all come up.
    func press(_ code: Int, _ flags: CGEventFlags) {
        let src = CGEventSource(stateID: .hidSystemState)
        let mods: [(CGEventFlags, Int)] = [(.maskControl, kVK_Control), (.maskAlternate, kVK_Option), (.maskShift, kVK_Shift), (.maskCommand, kVK_Command)]
        var held: CGEventFlags = []
        let post = { (k: Int, down: Bool, f: CGEventFlags) in
            let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(k), keyDown: down)
            e?.flags = f
            e?.post(tap: .cghidEventTap)
            usleep(8000)
        }
        for (f, k) in mods where flags.contains(f) { held.insert(f); post(k, true, held) }
        post(code, true, held)
        post(code, false, held)
        for (f, k) in mods.reversed() where flags.contains(f) { held.remove(f); post(k, false, held) }
    }
    /// Screen point (Cocoa, from the bottom) to event point (from the top).
    func cg(_ p: NSPoint) -> CGPoint { CGPoint(x: p.x, y: NSScreen.screens[0].frame.height - p.y) }
    func mouse(_ type: CGEventType, _ p: NSPoint) {
        CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: cg(p), mouseButton: .left)?.post(tap: .cghidEventTap)
    }
    func click(_ p: NSPoint) async { mouse(.mouseMoved, p); await sleep(0.05); mouse(.leftMouseDown, p); await sleep(0.05); mouse(.leftMouseUp, p); await sleep(0.3) }
    func state() async -> [String: Any] {
        guard let s = try? await panel.web.evaluateJavaScript("JSON.stringify(window.morphState())") as? String,
              let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { return [:] }
        return j
    }
    /// Clicks, with the real mouse, the first element of the panel matching a CSS selector (and holding some text).
    func clickText(_ sel: String, containing: String = "") async -> Bool {
        let js = "(function(){var e=[...document.querySelectorAll(\(Json.string([sel]).dropFirst().dropLast()))].find(function(x){return x.innerText.indexOf(\(Json.string([containing]).dropFirst().dropLast()))>=0}); if(!e) return ''; var r=e.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]);})()"
        guard let s = try? await panel.web.evaluateJavaScript(js) as? String, let xy = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [Double], xy.count == 2 else { return false }
        let w = panel.window.frame
        await click(NSPoint(x: w.minX + xy[0], y: w.maxY - xy[1]))
        return true
    }
    func str(_ d: [String: Any], _ k: String) -> String { d[k] as? String ?? "" }
    func settings() -> [String: Any] {
        guard let d = try? Data(contentsOf: paths.settings), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return j
    }
    func ownOnClipboard() -> Bool { Clip.types().contains("dev.morph.own") }
    func clipText() -> String { NSPasteboard.general.string(forType: .string) ?? "" }
    func clipHtml() -> String { NSPasteboard.general.string(forType: .html) ?? "" }
    func snapshot(_ name: String) async {
        guard let img = try? await panel.web.takeSnapshot(configuration: nil), let tiff = img.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: (out as NSString).deletingLastPathComponent).appendingPathComponent("lab-" + name + ".png"))
    }

    let MD = "## Plan\n\n- **ship** it\n- test the `build`\n\n| Name | Score |\n|---|---|\n| Ana | 9 |"

    // ---------------------------------------------------------------- scenarios
    func run() async {
        check("Accessibility is allowed here (the lab needs it)", AXIsProcessTrusted())
        for k in ["chat", "editor", "keepass", "jira", "slack"] { await open(k) }
        check("the stand-in apps start", ready.count == 5, ready.sorted().joined(separator: ","))

        // Can this process press keys and move the mouse here? (Everything below that uses them depends on it.)
        let target = NSPoint(x: 123, y: 321)
        mouse(.mouseMoved, target)
        await sleep(0.3)
        let at = NSEvent.mouseLocation
        check("posting events is allowed (CGPreflightPostEventAccess)", CGPreflightPostEventAccess(), "listen: \(CGPreflightListenEventAccess())")
        check("a posted mouse move moves the pointer", abs(at.x - target.x) < 2 && abs(at.y - target.y) < 2, "\(at)")
        await open("editor")
        _ = await cmd("editor", ["cmd": "clear"])
        press(kVK_ANSI_A, [])
        press(kVK_ANSI_B, [])
        await sleep(0.5)
        let typed = (await cmd("editor", ["cmd": "report"]) ?? [:])["text"] ?? ""
        let src2 = CGEventSource(stateID: .combinedSessionState)
        let d2 = CGEvent(keyboardEventSource: src2, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: true), u2 = CGEvent(keyboardEventSource: src2, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: false)
        d2?.post(tap: .cgSessionEventTap); u2?.post(tap: .cgSessionEventTap)
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            let d3 = CGEvent(keyboardEventSource: src2, virtualKey: CGKeyCode(kVK_ANSI_D), keyDown: true), u3 = CGEvent(keyboardEventSource: src2, virtualKey: CGKeyCode(kVK_ANSI_D), keyDown: false)
            d3?.postToPid(pid); u3?.postToPid(pid)
        }
        await sleep(0.5)
        let typed2 = (await cmd("editor", ["cmd": "report"]) ?? [:])["text"] ?? ""
        check("posted key presses reach the app in front", typed == "ab", "hid: '\(typed)', then session + pid: '\(typed2)'")

        // The window in front, by its title (needs Accessibility): a Jira tab in a "browser".
        await open("jira")
        let f = Front.now()
        check("Morph sees the window title of the app in front", (f["title"] ?? "").contains("Jira") && f["app"] == ids["jira"], Json.string(f))

        // Copy Markdown in a chat app, switch to Slack: converted on the switch (Convert automatically is on).
        await open("chat")
        await copy("chat", ["text": MD])
        var st = await state()
        check("a copy in another app is read: the card names it", str(st, "source").contains("ChatGPT"), str(st, "source"))
        await open("slack")
        let converted = await waitFor(4) { self.ownOnClipboard() }
        check("switching to Slack converts it", converted && clipText().contains("*ship*"), clipText())
        check("…and the clipboard holds HTML, RTF and text", Clip.types().contains("public.html") && Clip.types().contains("public.rtf") && Clip.types().contains("public.utf8-plain-text"), Clip.types().joined(separator: ","))
        await sleep(1)
        st = await state()
        check("Morph's own write is not taken for a new copy", str(st, "source").contains("ChatGPT") && str(st, "source").contains("⌘V"), str(st, "source"))

        // ⌘V by hand into Slack: the converted version arrives.
        _ = await cmd("slack", ["cmd": "clear"])
        press(kVK_ANSI_V, .maskCommand)
        await sleep(0.8)
        var r = await cmd("slack", ["cmd": "report"]) ?? [:]
        check("pressing ⌘V in Slack pastes the converted text", (r["text"] ?? "").contains("ship") && !(r["text"] ?? "").contains("**"), Json.string(r))

        // The paste shortcut (⌃⌥V, a real key press): converts for the app in front and presses ⌘V.
        await open("chat")
        await copy("chat", ["text": "Release notes:\n\n1. **fast** start\n2. fewer clicks"])
        await open("jira")
        _ = await cmd("jira", ["cmd": "clear"])
        press(kVK_ANSI_V, [.maskControl, .maskAlternate])
        let pasted = await waitFor(4) { ((await self.cmd("jira", ["cmd": "report"]) ?? [:])["text"] ?? "").contains("fast") }
        r = await cmd("jira", ["cmd": "report"]) ?? [:]
        check("⌃⌥V in Jira converts and pastes, formatted", pasted && r["bold"] == "1" && !(r["text"] ?? "").contains("**"), Json.string(r))

        // Paste as plain text (⌃⌥⇧V) into a plain editor.
        await open("editor")
        _ = await cmd("editor", ["cmd": "clear"])
        press(kVK_ANSI_V, [.maskControl, .maskAlternate, .maskShift])
        _ = await waitFor(4) { ((await self.cmd("editor", ["cmd": "report"]) ?? [:])["text"] ?? "").contains("fast") }
        r = await cmd("editor", ["cmd": "report"]) ?? [:]
        check("⌃⌥⇧V pastes plain text", (r["text"] ?? "").contains("fast start") && !(r["text"] ?? "").contains("**"), Json.string(r))

        // A password manager's copy: never read, never changed.
        await open("keepass")
        await copy("keepass", ["text": "correct horse battery staple"])
        await open("slack")
        await sleep(2)
        st = await state()
        check("a copy in a password manager is not converted", clipText() == "correct horse battery staple" && !ownOnClipboard(), clipText())
        check("…and the card says it was never read", str(st, "source").contains("password manager"), str(st, "source"))

        // A copy the app marks as concealed (as 1Password and browsers do for passwords).
        await open("chat")
        await copy("chat", ["text": "s3cret token value here", "concealed": "1"])
        await open("slack")
        await sleep(2)
        st = await state()
        check("a concealed copy is not read or converted", clipText() == "s3cret token value here" && !ownOnClipboard() && str(st, "source").contains("Never read"), str(st, "source"))

        // Notes and TextEdit copy RTF only: read as HTML.
        await open("chat")
        await copy("chat", ["rtf": "<p><b>Bold</b> words and <i>more</i> words in a note</p>"])
        await open("slack")
        let rtf = await waitFor(4) { self.ownOnClipboard() }
        check("an RTF-only copy (Notes, TextEdit) is converted for Slack", rtf && clipText().contains("*Bold*"), clipText())

        // A screenshot of a table: picking Slack reads it with the Mac's text recognition.
        await open("chat")
        await copy("chat", ["image": "Employee|Basic|Allowance|Net Pay;James Miller|4200|300|4500;Ana Lopez|3900|250|4150;Bo Chen|5100|400|5500"])
        await open("slack")
        st = await state()
        check("a copied picture: the card offers to read its table", str(st, "source").contains("Image copied"), str(st, "source") + " | copied: " + Json.string(lastCopy) + " | now: " + Clip.types().joined(separator: ","))
        bridge.action("fix:slack")
        let table = await waitFor(8) { self.ownOnClipboard() && self.clipText().contains("James Miller") }
        check("picking Slack reads the table from the picture", table, clipText())

        // The tab and the panel with the real mouse.
        await open("chat")
        await copy("chat", ["text": MD])
        await open("slack")
        _ = await waitFor(4) { self.ownOnClipboard() }
        let tab = panel.window.frame
        check("the tab is at the right edge of the screen", panel.window.isVisible && abs(tab.maxX - (NSScreen.screens[0].visibleFrame.maxX)) < 2 && tab.width < 40, "\(tab)")
        await click(NSPoint(x: tab.midX, y: tab.maxY - 20))
        let opened = await waitFor(3) { (await self.state())["open"] as? Bool == true && self.panel.window.frame.width > 250 }
        let evs = (try? await panel.web.evaluateJavaScript("JSON.stringify(window.__ev || [])") as? String) ?? ""
        check("a click on the tab opens the panel", opened, "\(panel.window.frame) key=\(panel.window.isKeyWindow) events: \(evs)")
        await snapshot("panel-open")
        st = await state()
        check("the panel shows the copy, Slack as This app, and the other apps", str(st, "text").contains("This app") && str(st, "text").contains("Jira") && str(st, "text").contains("Save as PDF"), String(str(st, "text").prefix(300)))
        // Pressing Jira in the panel, with the real mouse.
        let jiraRow = try? await panel.web.evaluateJavaScript("(function(){var b=[...document.querySelectorAll('.row')].find(function(x){return /Jira/.test(x.innerText)}); if(!b) return ''; var r=b.getBoundingClientRect(); return JSON.stringify([r.left+r.width/2, r.top+r.height/2]);})()") as? String
        if let s = jiraRow, let xy = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [Double], xy.count == 2 {
            let w = panel.window.frame
            await click(NSPoint(x: w.minX + xy[0], y: w.maxY - xy[1]))
            let jiraDone = await waitFor(3) { self.ownOnClipboard() && (self.clipHtml().lowercased().contains("<strong>") || self.clipHtml().lowercased().contains("<b>")) }
            check("clicking Jira in the panel converts for Jira", jiraDone && clipHtml().contains("<table"), String(clipHtml().prefix(200)))
            check("…and the panel stays open, where it was", panel.window.frame.width == w.width && abs(panel.window.frame.maxY - w.maxY) < 1, "\(w) → \(panel.window.frame)")
        } else { check("the Jira row can be found", false, jiraRow ?? "") }
        // Clicking Morph never takes the keyboard or the front from your app.
        check("after clicks on the panel, Slack is still the app in front", NSWorkspace.shared.frontmostApplication?.bundleIdentifier == ids["slack"], NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
        _ = await cmd("slack", ["cmd": "clear"])
        press(kVK_ANSI_H, []); press(kVK_ANSI_I, [])
        await sleep(0.5)
        let typedHi = (await cmd("slack", ["cmd": "report"]) ?? [:])["text"] ?? ""
        check("…and typing still goes to Slack with Morph open", typedHi == "hi", "'\(typedHi)'")
        // Settings with the mouse: the gear, then a switch.
        let auto0 = settings()["autoFormat"] as? Bool ?? true
        var gear = false, inSettings = false
        for _ in 0..<3 where !inSettings {
            gear = await clickText(".ib.gear") || gear
            inSettings = await waitFor(1.5) { self.str(await self.state(), "text").contains("Convert automatically") }
        }
        if gear {
            check("the gear opens Settings", inSettings, String(str(await state(), "text").prefix(200)))
            if await clickText(".opt", containing: "Convert automatically") {
                await sleep(0.5)
                check("clicking Convert automatically turns it off, and it is saved", (settings()["autoFormat"] as? Bool) == !auto0, Json.string(settings()))
                _ = await clickText(".opt", containing: "Convert automatically")
                await sleep(0.4)
            } else { check("the Convert automatically switch can be found", false) }
            await snapshot("settings")
            _ = await clickText(".ib.back")
        } else { check("the gear can be found", false) }
        // A click elsewhere folds it into the tab (and still reaches that app).
        let slackWin = NSRect(x: 260, y: 260, width: 400, height: 200)
        await click(NSPoint(x: slackWin.midX, y: slackWin.midY))
        let closed = await waitFor(3) { (await self.state())["open"] as? Bool == false && self.panel.window.frame.width < 40 }
        check("a click in another app folds the panel into its tab", closed, "\(panel.window.frame)")

        // Dragging the tab up moves it and Morph remembers where.
        let y0 = settings()["pillYFrac"] as? Double ?? 0.42
        let t0 = panel.window.frame
        let start = NSPoint(x: t0.midX, y: t0.maxY - 20)
        mouse(.mouseMoved, start); await sleep(0.05)
        mouse(.leftMouseDown, start)
        for i in 1...12 { mouse(.leftMouseDragged, NSPoint(x: start.x, y: start.y + CGFloat(i * 15))); await sleep(0.03) }
        mouse(.leftMouseUp, NSPoint(x: start.x, y: start.y + 180))
        await sleep(0.8)
        let y1 = settings()["pillYFrac"] as? Double ?? y0
        let stillClosed = (await state())["open"] as? Bool == false
        check("dragging the tab up moves it, and the place is remembered", panel.window.frame.minY > t0.minY + 100 && y1 < y0 - 0.05 && stillClosed, "y \(y0) → \(y1), \(t0) → \(panel.window.frame)")

        // Hide Morph, then ⌃⌥F brings it back.
        bridge.action("hide:")
        let hidden = await waitFor(4) { !self.panel.window.isVisible }
        check("Hide Morph hides the tab", hidden)
        press(kVK_ANSI_F, [.maskControl, .maskAlternate])
        let back = await waitFor(3) { self.panel.window.isVisible }
        check("⌃⌥F brings it back", back)

        // Settings → Privacy shows the Mac's permissions.
        _ = try? await panel.web.evaluateJavaScript("(function(){var t=document.querySelector('.tab'); if(!t) return; var r=t.getBoundingClientRect(); var o={bubbles:true,button:0,screenX:5,screenY:5,clientX:r.left+5,clientY:r.top+20}; t.dispatchEvent(new MouseEvent('mousedown',o)); window.dispatchEvent(new MouseEvent('mouseup',o));})()")
        bridge.action("view:privacy")
        await sleep(0.5)
        st = await state()
        check("Settings → Privacy shows Accessibility on", str(st, "text").contains("Accessibility: on"), String(str(st, "text").prefix(600)))
        await snapshot("privacy")
        bridge.action("view:main")

        // Save as PDF from the panel.
        await open("chat")
        await copy("chat", ["text": MD])
        bridge.action("pdf:")
        let pdf = await waitFor(8) { ((try? FileManager.default.contentsOfDirectory(atPath: self.paths.downloads.path)) ?? []).contains { $0.hasPrefix("Morph_") && $0.hasSuffix(".pdf") } }
        check("Save as PDF writes Morph_<date>_<time>.pdf to Downloads", pdf, ((try? FileManager.default.contentsOfDirectory(atPath: paths.downloads.path)) ?? []).joined(separator: ","))

        // Nothing copied was written to any file Morph keeps.
        let kept = [paths.settings, paths.log].compactMap { try? String(contentsOf: $0, encoding: .utf8) }.joined()
        check("nothing copied is in Morph's files (settings, log)", !kept.contains("ship") && !kept.contains("correct horse") && !kept.contains("James Miller") && !kept.contains("s3cret"))
    }

    func finish() {
        let failed = results.filter { !($0["ok"] as? Bool ?? false) }.count
        let json = Json.string(["passed": results.count - failed, "failed": failed, "results": results, "macOS": ProcessInfo.processInfo.operatingSystemVersionString])
        try? json.write(toFile: out, atomically: true, encoding: .utf8)
        print(failed == 0 ? "All \(results.count) lab checks passed" : "\(failed) of \(results.count) lab checks FAILED")
        exit(failed == 0 ? 0 : 1)
    }
}
