// Morph.app/Contents/MacOS/Morph --selftest results.json
// Checks, on a real Mac, the parts the Linux tests can't: the logic loads in JavaScriptCore and converts, the
// clipboard holds both formats, RTF-only copies are read, macOS's text recognition finds a table in a picture,
// the panel page loads and draws, a PDF is written in pages, shortcuts register. Run with MORPH_HOME set to an
// empty folder, so nothing of the person's own Morph is touched.
import AppKit
import PDFKit

final class SelfTest: NSObject, NSApplicationDelegate {
    let out: String
    var results: [[String: Any]] = []
    var bridge: Bridge!
    var panel: Panel!

    init(out: String) { self.out = out }

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        results.append(["name": name, "ok": ok, "detail": String(detail.prefix(500))])
        print((ok ? "ok    " : "FAIL  ") + name + (ok || detail.isEmpty ? "" : "  (" + String(detail.prefix(300)) + ")"))
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        guard ProcessInfo.processInfo.environment["MORPH_HOME"] != nil else {
            print("Set MORPH_HOME to an empty folder first: the self-test must not touch your own Morph.")
            exit(2)
        }
        let paths = Paths.standard()
        try? FileManager.default.createDirectory(at: paths.downloads, withIntermediateDirectories: true)
        Log.url = paths.log

        // 1. The logic, in JavaScriptCore.
        bridge = Bridge(paths: paths)
        let loaded = bridge.load()
        check("morph.js loads in JavaScriptCore", loaded)
        let conv = bridge.ctx.evaluateScript("""
            (function () { var r = FB.engine.run({ html: '', text: '## Plan\\n\\n- **ship** it\\n- test' }, 'slack');
              return JSON.stringify(r.out); })()
            """)?.toString() ?? ""
        check("it converts Markdown for Slack", conv.contains("*ship*"), conv)

        // 2. The clipboard: both formats, Morph's own mark, and RTF-only copies.
        let before = Clip.changeCount()
        let wrote = Clip.write(html: "<p><b>Morph</b> test</p>", text: "Morph test")
        let r = Clip.read()
        let types = Clip.types()
        check("the clipboard takes HTML and plain text together", wrote && (r["text"] as? String) == "Morph test" && ((r["html"] as? String) ?? "").contains("<b>Morph</b>"), Json.string(r))
        check("…with RTF for Mac apps and Morph's own mark", types.contains("public.rtf") && types.contains("dev.morph.own"), types.joined(separator: ","))
        check("the change counter moves on a write", Clip.changeCount() > before)
        let rtfText = NSAttributedString(string: "Bold words", attributes: [.font: NSFont.boldSystemFont(ofSize: 12)])
        let rtf = try? rtfText.data(from: NSRange(location: 0, length: rtfText.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setData(rtf, forType: .rtf)
        let rr = Clip.read()
        check("a copy that is only RTF (Notes, TextEdit) is read as HTML", ((rr["html"] as? String) ?? "").contains("Bold words"), ((rr["html"] as? String) ?? "").prefix(300).description)

        // 3. Shortcuts and the app in front.
        let failed = Hotkeys.shared.set([("pill", "<Control><Alt>f"), ("plain", "<Shift><Control><Alt>v")])
        check("global shortcuts register", failed.isEmpty, failed.joined(separator: ","))
        check("shortcut names are understood", Hotkeys.parse("<Control><Alt>v") != nil && Hotkeys.parse("<Super>F5") != nil && Hotkeys.parse("v") == nil)
        let front = Front.now()
        check("the app in front can be asked", !(front["app"] ?? "").isEmpty || NSWorkspace.shared.frontmostApplication == nil, Json.string(front))

        // 4. Image tables: draw a table, read it back.
        recognizeTable { [weak self] in
            // 5. The panel page.
            self?.panelTest {
                // 6. A whole copy → convert, through the running app.
                self?.flowTest {
                    // 7. PDF.
                    self?.pdfTest(paths) { self?.finish() }
                }
            }
        }
    }

    private func recognizeTable(then next: @escaping () -> Void) {
        let rows = [["Employee", "Basic", "Allowance", "Net Pay"], ["James Miller", "4200", "300", "4500"], ["Ana Lopez", "3900", "250", "4150"], ["Bo Chen", "5100", "400", "5500"]]
        let W = 900, H = 260
        let img = NSImage(size: NSSize(width: W, height: H))
        img.lockFocus()
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
        let font = NSFont.systemFont(ofSize: 24)
        for (i, row) in rows.enumerated() {
            for (j, cell) in row.enumerated() {
                (cell as NSString).draw(at: NSPoint(x: 30 + j * 220, y: H - 50 - i * 55), withAttributes: [.font: font, .foregroundColor: NSColor.black])
            }
        }
        img.unlockFocus()
        guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { check("a picture can be made", false); next(); return }
        let started = Date()
        Ocr.recognize(cg) { [weak self] json in
            guard let self = self else { return }
            let grid = self.bridge.ctx.evaluateScript("(function (j) { var r = JSON.parse(j); var g = FB.ocrGrid(r.texts, r.boxes); return JSON.stringify({ words: r.texts, grid: g }); })(\(Json.string([json]).dropFirst().dropLast()))")?.toString() ?? ""
            let ok = grid.contains("James Miller") && grid.contains("\"grid\":[[") && grid.contains("5500")
            self.check("macOS text recognition reads a table from a picture (\(Int(Date().timeIntervalSince(started) * 1000)) ms)", ok, grid)
            next()
        }
    }

    private func panelTest(then next: @escaping () -> Void) {
        panel = Panel()
        var sizes: [[String: Any]] = []
        var ready = false
        panel.onMessage = { m in
            if m["type"] as? String == "ready" { ready = true }
            if m["type"] as? String == "size" { sizes.append(m) }
        }
        bridge.panel = panel
        bridge.start() // the real logic, on this Mac, drawing into the real panel
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self else { return }
            self.check("the panel page loads (morph://ui/panel.html)", ready)
            let last = sizes.last ?? [:]
            let w = (last["w"] as? NSNumber)?.intValue ?? 0
            self.check("the panel draws and reports its size", w > 20 && ["welcome", "tab"].contains(last["mode"] as? String ?? ""), Json.string(last))
            self.check("the window shows at that size", self.panel.window.isVisible && Int(self.panel.window.frame.width) == w, "\(self.panel.window.frame)")
            self.panel.web.takeSnapshot(with: nil) { image, _ in
                var painted = 0.0
                if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                    if let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: (self.out as NSString).deletingLastPathComponent).appendingPathComponent("panel.png"))
                    }
                    // How much of it is Morph's cream: the page really painted, in its own colours.
                    var cream = 0, all = 0
                    for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
                            all += 1
                            if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), c.alphaComponent > 0.9, c.redComponent > 0.9, c.greenComponent > 0.88, c.blueComponent > 0.78, c.blueComponent < 0.93 { cream += 1 }
                        }
                    }
                    painted = all > 0 ? Double(cream) / Double(all) : 0
                }
                self.check("the panel is painted in Morph's colours (\(Int(painted * 100))% cream)", painted > 0.3)
                next()
            }
        }
    }

    private func flowTest(then next: @escaping () -> Void) {
        var sizes: [[String: Any]] = []
        panel.onMessage = { m in if m["type"] as? String == "size" { sizes.append(m) } }
        // As if another app copied Markdown.
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString("## Plan\n\n- **ship** it\n- test", forType: .string)
        // The welcome card first (a new install): "Got it", as a person would.
        bridge.action("setup:ok")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self = self else { return }
            self.bridge.action("fix:slack")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                let r = Clip.read()
                let t = Clip.types()
                let text = r["text"] as? String ?? "", html = r["html"] as? String ?? ""
                self.check("a copy from another app is read and converted for Slack", text.contains("*ship*") && (html.lowercased().contains("<b>ship</b>") || html.lowercased().contains("<strong>ship</strong>")), text + " | " + String(html.prefix(200)))
                self.check("…with HTML, RTF and text, marked as Morph's", t.contains("public.html") && t.contains("public.rtf") && t.contains("public.utf8-plain-text") && t.contains("dev.morph.own"), t.joined(separator: ","))
                // Open the panel: click the tab.
                self.panel.web.evaluateJavaScript("(function(){var t=document.querySelector('.tab'); if(!t) return 'no tab'; var r=t.getBoundingClientRect(); var o={bubbles:true,button:0,screenX:5,screenY:5,clientX:r.left+5,clientY:r.top+20}; t.dispatchEvent(new MouseEvent('mousedown',o)); window.dispatchEvent(new MouseEvent('mouseup',o)); return 'ok';})()") { res, _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        let last = sizes.last ?? [:]
                        self.check("a click on the tab opens the panel at its width", (last["mode"] as? String) == "panel" && (last["w"] as? NSNumber)?.intValue == 296 && Int(self.panel.window.frame.width) == 296, "\(res ?? "") \(Json.string(last)) \(self.panel.window.frame)")
                        self.panel.web.evaluateJavaScript("document.querySelector('.panel') ? document.querySelector('.panel').innerText : ''") { txt, _ in
                            let s = txt as? String ?? ""
                            self.check("the panel shows the copy and the apps", s.contains("Slack") && s.contains("Jira") && s.contains("Save as PDF"), String(s.prefix(300)))
                            next()
                        }
                    }
                }
            }
        }
    }

    private func pdfTest(_ paths: Paths, then next: @escaping () -> Void) {
        let body = (1...120).map { "<p>Line \($0) of a long copied page, to check that the PDF has more than one page.</p>" }.joined()
        let url = paths.downloads.appendingPathComponent("Morph_2026-01-01_10.00.00.pdf")
        let started = Date()
        Pdf.save(html: "<!doctype html><html><body><h1>Morph</h1>\(body)</body></html>", to: url) { [weak self] ok in
            guard let self = self else { return }
            let doc = PDFDocument(url: url)
            let pages = doc?.pageCount ?? 0
            self.check("Save as PDF writes a PDF (\(Int(Date().timeIntervalSince(started) * 1000)) ms)", ok && doc != nil, url.path)
            self.check("…in pages", pages >= 2, "\(pages) pages")
            self.check("…with the text in it", (doc?.string ?? "").contains("Line 120"))
            next()
        }
    }

    private func finish() {
        let failed = results.filter { !($0["ok"] as? Bool ?? false) }.count
        let json = Json.string(["passed": results.count - failed, "failed": failed, "results": results, "macOS": ProcessInfo.processInfo.operatingSystemVersionString])
        if out == "/dev/stdout" { print(json) } else { try? json.write(toFile: out, atomically: true, encoding: .utf8) }
        print(failed == 0 ? "All \(results.count) checks passed" : "\(failed) of \(results.count) checks FAILED")
        exit(failed == 0 ? 0 : 1)
    }
}
