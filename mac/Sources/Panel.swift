// The tab and panel at the screen edge: a small borderless window that never takes focus from your app, showing
// Resources/ui/panel.html. The page draws Morph and says how big it is; this window takes that size, docks at the edge
// and height you dragged it to, and passes clicks back to the logic.
import AppKit
import WebKit

final class MorphWebView: WKWebView {
    // The first click on the panel acts at once (the window never becomes active, so every click is a "first" one).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class PanelWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Serves the panel's own files as morph://ui/<name>. Nothing else can be loaded.
final class UISchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let name = task.request.url?.lastPathComponent ?? ""
        guard name.range(of: #"^[a-z-]+\.(html|css|js)$"#, options: .regularExpression) != nil,
              let url = Bundle.main.resourceURL?.appendingPathComponent("ui").appendingPathComponent(name),
              let data = try? Data(contentsOf: url) else {
            task.didFailWithError(NSError(domain: "morph", code: 404))
            return
        }
        let type = name.hasSuffix(".css") ? "text/css" : name.hasSuffix(".js") ? "text/javascript" : "text/html"
        task.didReceive(URLResponse(url: task.request.url!, mimeType: type, expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Panel: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window: PanelWindow
    let web: MorphWebView
    var onAction: ((String) -> Void)?
    var onMessage: (([String: Any]) -> Void)? // (the self-test listens)
    private(set) var ready = false
    private var pending: String?
    private var mode = "hidden"
    private var size = NSSize(width: 1, height: 1)
    private var side = "r"
    private var yFrac: CGFloat = 0.42
    private var monitor = -1
    private var openTop: CGFloat?     // while open, the top edge stays put: the panel grows downwards
    private var dragStart: NSPoint?
    private var outside: Any?

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(UISchemeHandler(), forURLScheme: "morph")
        cfg.websiteDataStore = .nonPersistent()
        cfg.suppressesIncrementalRendering = true
        web = MorphWebView(frame: NSRect(x: 0, y: 0, width: 300, height: 400), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        window = PanelWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 400), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        cfg.userContentController.add(self, name: "morph")
        web.navigationDelegate = self
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .statusBar
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.contentView = web
        web.autoresizingMask = [.width, .height]
        web.load(URLRequest(url: URL(string: "morph://ui/panel.html")!))
        // A click anywhere else folds the panel into its tab (the click still reaches the app you clicked).
        outside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.web.evaluateJavaScript("window.morphClose && morphClose()", completionHandler: nil)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func render(_ json: String) {
        guard ready else { pending = json; return }
        call("morphRender", json)
    }
    private func call(_ fn: String, _ arg: String) {
        // The spec goes in as a JSON string literal: never as code.
        let lit = Json.string([arg]).dropFirst().dropLast()
        web.evaluateJavaScript("window.\(fn) && \(fn)(\(lit))", completionHandler: nil)
    }

    @objc private func screensChanged() {
        call("morphScreen", String(Int(screen().visibleFrame.height)))
        place()
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        onMessage?(m)
        switch type {
        case "ready":
            ready = true
            call("morphScreen", String(Int(screen().visibleFrame.height)))
            if let p = pending { pending = nil; call("morphRender", p) }
        case "action":
            if let a = m["action"] as? String, a.range(of: #"^[a-z]+:[a-z0-9]*$"#, options: .regularExpression) != nil { onAction?(a) }
        case "size":
            let newMode = m["mode"] as? String ?? "hidden"
            if newMode != "panel" || mode != "panel" { openTop = nil }
            mode = newMode
            size = NSSize(width: max(1, (m["w"] as? NSNumber)?.doubleValue ?? 1), height: max(1, (m["h"] as? NSNumber)?.doubleValue ?? 1))
            side = (m["side"] as? String) == "l" ? "l" : "r"
            yFrac = CGFloat(min(0.95, max(0.05, (m["yFrac"] as? NSNumber)?.doubleValue ?? 0.42)))
            monitor = (m["monitor"] as? NSNumber)?.intValue ?? -1
            place()
        case "drag":
            let phase = m["phase"] as? String ?? ""
            if phase == "start" { dragStart = window.frame.origin }
            if phase == "move", let s = dragStart {
                let dx = (m["dx"] as? NSNumber)?.doubleValue ?? 0, dy = (m["dy"] as? NSNumber)?.doubleValue ?? 0
                window.setFrameOrigin(NSPoint(x: s.x + dx, y: s.y - dy))
            }
            if phase == "end" { dragStart = nil; dropped() }
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The panel never navigates anywhere: links are opened by the logic, in your browser.
        decisionHandler(action.request.url?.scheme == "morph" ? .allow : .cancel)
    }

    /// The screen you dragged it to, or else the one with the mouse.
    private func screen() -> NSScreen {
        let all = NSScreen.screens
        if monitor >= 0 && monitor < all.count { return all[monitor] }
        let mouse = NSEvent.mouseLocation
        return all.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? all[0]
    }

    private func place() {
        if mode == "hidden" { window.orderOut(nil); return }
        if dragStart != nil { return }
        let vf = screen().visibleFrame
        let w = min(size.width, vf.width), h = min(size.height, vf.height - 16)
        var frame = NSRect(x: 0, y: 0, width: w, height: h)
        if mode == "welcome" {
            frame.origin = NSPoint(x: vf.midX - w / 2, y: vf.midY - h / 2)
        } else {
            var top = openTop ?? (vf.height * yFrac - h / 2)          // from the top of the screen
            top = max(8, min(top, vf.height - h - 8))
            if mode == "panel" && openTop == nil { openTop = top }
            frame.origin = NSPoint(x: side == "l" ? vf.minX : vf.maxX - w, y: vf.maxY - top - h)
        }
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
    }

    /// Let go after a drag: dock to the nearer edge, at that height, and remember it.
    private func dropped() {
        let f = window.frame
        let center = NSPoint(x: f.midX, y: f.midY)
        let all = NSScreen.screens
        let idx = all.firstIndex { NSMouseInRect(center, $0.frame, false) } ?? all.firstIndex { $0 == screen() } ?? 0
        let vf = all[idx].visibleFrame
        let newSide = center.x < vf.midX ? "l" : "r"
        let frac = min(0.95, max(0.05, (vf.maxY - center.y) / vf.height))
        side = newSide; yFrac = frac; monitor = idx; openTop = nil
        place()
        onAction?("moved:\(newSide)\(min(idx, 9))y\(Int((frac * 1000).rounded()))")
    }
}
