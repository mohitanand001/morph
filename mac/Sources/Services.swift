// Saving a PDF, reading a table from a copied picture, updating and uninstalling.
import AppKit
import CryptoKit
import ServiceManagement
import Vision
import WebKit

// ---------------------------------------------------------------- PDF
/// Lays the page out in an invisible web view and prints it to a PDF file, in pages (A4 or Letter, as the Mac is set).
final class Pdf: NSObject, WKNavigationDelegate {
    private static var jobs: [Pdf] = []
    private let web: WKWebView
    private let window: NSWindow
    private let url: URL
    private let done: (Bool) -> Void

    static func save(html: String, to url: URL, done: @escaping (Bool) -> Void) {
        let job = Pdf(url: url, done: done)
        jobs.append(job)
        job.web.loadHTMLString(html, baseURL: nil)
    }
    private init(url: URL, done: @escaping (Bool) -> Void) {
        self.url = url
        self.done = done
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 595, height: 842), configuration: cfg)
        window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 595, height: 842), styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.contentView = web
        web.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only the page itself: a link or an image from the web is never fetched.
        let s = action.request.url?.scheme ?? ""
        decisionHandler(s == "about" || s == "" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
        info.topMargin = 42; info.bottomMargin = 42; info.leftMargin = 42; info.rightMargin = 42
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isVerticallyCentered = false
        let op = web.printOperation(with: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        op.view?.frame = web.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printed(_:success:context:)), contextInfo: nil)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }
    @objc private func printed(_ op: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int ?? 0
        if success && size > 500 { finish(true); return }
        // Printing did not give a file: one long page instead, still a real PDF.
        Log.write("[morph] PDF: printing gave no file, saving one long page instead")
        web.createPDF(configuration: WKPDFConfiguration()) { [weak self] r in
            guard let self = self else { return }
            if case .success(let data) = r, (try? data.write(to: self.url, options: .withoutOverwriting)) != nil { self.finish(true) } else { self.finish(false) }
        }
    }
    private func finish(_ ok: Bool) {
        done(ok)
        Pdf.jobs.removeAll { $0 === self }
    }
}

// ---------------------------------------------------------------- image tables
/// The copied picture's words and where they are, read by macOS's own text recognition on this computer.
/// Answers {"texts": [...], "boxes": [[x1, y1, x2, y2], ...]} (pixels, y downwards) or {"error": "..."}.
enum Ocr {
    static func readClipboard(done: @escaping (String) -> Void) {
        let pb = NSPasteboard.general
        if (pb.types ?? []).contains(where: { $0.rawValue.range(of: "concealed|transient", options: [.regularExpression, .caseInsensitive]) != nil }) { done(#"{"error":"secret"}"#); return }
        guard let img = NSImage(pasteboard: pb), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { done(#"{"error":"no_image"}"#); return }
        recognize(cg, done: done)
    }

    static func recognize(_ cg: CGImage, done: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .accurate
            req.usesLanguageCorrection = false
            var texts: [String] = [], boxes: [[Int]] = []
            do {
                try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
                let W = Double(cg.width), H = Double(cg.height)
                let px = { (r: CGRect) -> [Int] in [Int(r.minX * W), Int((1 - r.maxY) * H), Int(r.maxX * W), Int((1 - r.minY) * H)] }
                for obs in req.results ?? [] {
                    guard let cand = obs.topCandidates(1).first else { continue }
                    // A line can hold several cells ("Basic   Allowances"): split it where its words are far apart.
                    for (t, r) in phrases(cand) { texts.append(t); boxes.append(px(r)) }
                }
            } catch { DispatchQueue.main.async { done(#"{"error":"failed"}"#) }; return }
            let json = Json.string(["texts": texts, "boxes": boxes])
            DispatchQueue.main.async { done(json) }
        }
    }

    private static func phrases(_ cand: VNRecognizedText) -> [(String, CGRect)] {
        let s = cand.string
        var words: [(String, CGRect)] = []
        var at = s.startIndex
        while let r = s.range(of: #"\S+"#, options: .regularExpression, range: at..<s.endIndex) {
            if let b = try? cand.boundingBox(for: r)?.boundingBox { words.append((String(s[r]), b)) }
            at = r.upperBound
        }
        // When word boxes are not available, the whole line is one phrase.
        guard words.count > 1 else {
            if let b = try? cand.boundingBox(for: s.startIndex..<s.endIndex)?.boundingBox { return [(s, b)] }
            return []
        }
        let h = words.map { $0.1.height }.sorted()[words.count / 2]
        var out: [(String, CGRect)] = []
        var cur = words[0]
        for w in words.dropFirst() {
            if w.1.minX - cur.1.maxX > h * 1.2 { out.append(cur); cur = w } else { cur = (cur.0 + " " + w.0, cur.1.union(w.1)) }
        }
        out.append(cur)
        return out
    }
}

// ---------------------------------------------------------------- updates
/// Downloads the Mac app for that version from the project's releases, checks its checksum and what it is,
/// puts it in place of this copy (the old one goes to the Bin) and starts it.
enum Updater {
    // (MORPH_RELEASES_URL: the lab's local copy of the releases, for testing the update.)
    static let repo = ProcessInfo.processInfo.environment["MORPH_RELEASES_URL"] ?? "https://github.com/mohitanand001/morph/releases/download/"

    static func install(version v: String, done: @escaping (Bool) -> Void) {
        guard v.range(of: #"^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$"#, options: .regularExpression) != nil,
              let zipURL = URL(string: repo + "v\(v)/Morph-mac.zip"), let shaURL = URL(string: repo + "v\(v)/Morph-mac.zip.sha256") else { done(false); return }
        let fail = { (why: String) in Log.write("[morph] update failed: " + why); DispatchQueue.main.async { done(false) } }
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: shaURL) { shaData, r1, _ in
            guard (r1 as? HTTPURLResponse)?.statusCode == 200, let shaText = shaData.map({ String(decoding: $0, as: UTF8.self) }),
                  let want = shaText.split(separator: " ").first.map(String.init)?.lowercased(), want.count == 64 else { return fail("no checksum") }
            session.downloadTask(with: zipURL) { tmp, r2, _ in
                guard (r2 as? HTTPURLResponse)?.statusCode == 200, let tmp = tmp, let data = try? Data(contentsOf: tmp), data.count < 200_000_000 else { return fail("download") }
                let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard got == want else { return fail("checksum does not match") }
                DispatchQueue.main.async { swapIn(zip: data, version: v, done: done) }
            }.resume()
        }.resume()
    }

    private static func swapIn(zip: Data, version v: String, done: @escaping (Bool) -> Void) {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("morph-update-\(UUID().uuidString)")
        let zipFile = work.appendingPathComponent("Morph-mac.zip")
        let unpacked = work.appendingPathComponent("unpacked")
        let fail = { (why: String) in Log.write("[morph] update failed: " + why); done(false) }
        do {
            try fm.createDirectory(at: unpacked, withIntermediateDirectories: true)
            try zip.write(to: zipFile)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            p.arguments = ["-x", "-k", zipFile.path, unpacked.path]
            try p.run(); p.waitUntilExit()
            guard p.terminationStatus == 0 else { return fail("unzip") }
            let app = unpacked.appendingPathComponent("Morph.app")
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
            guard info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier, info?["CFBundleShortVersionString"] as? String == v else { return fail("not the expected app") }
            let here = Bundle.main.bundleURL
            guard here.pathExtension == "app" else { return fail("not running from an app") }
            // The running copy goes to the Bin (recoverable), the new one takes its place.
            var trashed: NSURL?
            try fm.trashItem(at: here, resultingItemURL: &trashed)
            do { try fm.moveItem(at: app, to: here) } catch {
                if let t = trashed as URL? { try? fm.moveItem(at: t, to: here) }
                return fail("could not put the new version in place")
            }
            Log.write("[morph] updated to \(v), restarting")
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["-n", here.path]
            try open.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            done(true)
        } catch { fail(error.localizedDescription) }
    }
}

// ---------------------------------------------------------------- uninstall
/// Removes Morph: its login item, its own files by name, and the app (to the Bin). Then quits.
enum Uninstaller {
    static func run(paths: Paths) -> Bool {
        let fm = FileManager.default
        try? SMAppService.mainApp.unregister()
        for f in [paths.settings, paths.support.appendingPathComponent("login-item-added"), paths.support.appendingPathComponent("asked-accessibility"), paths.log] where fm.fileExists(atPath: f.path) {
            try? fm.removeItem(at: f) // a single named file
        }
        // The folder goes only when it is empty (never a folder with anything in it).
        if (try? fm.contentsOfDirectory(atPath: paths.support.path))?.isEmpty == true { rmdir(paths.support.path) }
        let here = Bundle.main.bundleURL
        if here.pathExtension == "app" {
            do { try fm.trashItem(at: here, resultingItemURL: nil) } catch { Log.write("[morph] could not move Morph.app to the Bin"); return false }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
        return true
    }
}

// ---------------------------------------------------------------- open at login
enum LoginItem {
    /// Once, on the first start: Morph opens when you log in (you can turn it off in System Settings → General → Login Items).
    static func addOnce(paths: Paths) {
        let marker = paths.support.appendingPathComponent("login-item-added")
        guard Bundle.main.bundleURL.pathExtension == "app", !FileManager.default.fileExists(atPath: marker.path) else { return }
        do { try SMAppService.mainApp.register() } catch { Log.write("[morph] could not add the login item: \(error.localizedDescription)") }
        _ = Files.writePrivate("1", to: marker)
    }
}
