// The JavaScript side of Morph (Resources/morph.js: the converter, core.js and mac/host.js) runs here, in
// JavaScriptCore. This file gives it `native`: the clipboard, the app in front, timers, files, the panel, and so on.
// Everything is called on the main thread.
import AppKit
import JavaScriptCore

final class Bridge {
    let ctx: JSContext
    let paths: Paths
    var panel: Panel?
    private var timers: [Int: Timer] = [:]
    private var native: JSValue!

    init(paths: Paths) {
        self.paths = paths
        ctx = JSContext()!
        ctx.name = "Morph"
        ctx.exceptionHandler = { _, e in
            Log.write("[morph] script error: \(e?.toString() ?? "?") \(e?.objectForKeyedSubscript("stack")?.toString() ?? "")")
        }
    }

    /// Loads morph.js. false when it is missing or broken.
    @discardableResult
    func load() -> Bool {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("morph.js"),
              let src = try? String(contentsOf: url, encoding: .utf8) else { Log.write("[morph] morph.js is missing"); return false }
        installNative()
        ctx.evaluateScript(src, withSourceURL: url)
        return ctx.objectForKeyedSubscript("startMorphMac")?.isObject ?? false
    }

    private func set(_ name: String, _ value: Any) { native.setObject(value, forKeyedSubscript: name as NSString) }

    private func installNative() {
        native = JSValue(newObjectIn: ctx)
        let info = Bundle.main.infoDictionary ?? [:]
        set("version", info["CFBundleShortVersionString"] as? String ?? "0.0.0")
        set("home", NSHomeDirectory())
        set("supportDir", paths.support.path)
        set("downloadsDir", paths.downloads.path)
        set("debug", ProcessInfo.processInfo.environment["MORPH_DEBUG"] != nil)
        set("canOcr", true)
        if let u = ProcessInfo.processInfo.environment["MORPH_UPDATE_URL"] { set("updateUrl", u) }

        let log: @convention(block) (String) -> Void = { Log.write($0) }
        set("log", log)

        let setTimer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in
            guard let self = self else { return }
            self.timers[id]?.invalidate()
            self.timers[id] = Timer.scheduledTimer(withTimeInterval: max(0.001, ms / 1000), repeats: false) { [weak self] _ in
                guard let self = self else { return }
                self.timers[id] = nil
                self.ctx.objectForKeyedSubscript("__morphTimer")?.call(withArguments: [id])
            }
        }
        set("setTimer", setTimer)
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.timers[id]?.invalidate(); self?.timers[id] = nil }
        set("clearTimer", clearTimer)

        // Files: only Morph's own settings file is read or written.
        let readFile: @convention(block) (String) -> String? = { [weak self] p in
            guard let self = self, p == self.paths.settings.path else { return nil }
            return try? String(contentsOfFile: p, encoding: .utf8)
        }
        set("readFile", readFile)
        let writeFile: @convention(block) (String, String) -> Bool = { [weak self] p, s in
            guard let self = self, p == self.paths.settings.path else { return false }
            return Files.writePrivate(s, to: self.paths.settings)
        }
        set("writeFile", writeFile)
        let exists: @convention(block) (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
        set("exists", exists)

        // The clipboard.
        let changeCount: @convention(block) () -> Int = { Clip.changeCount() }
        set("changeCount", changeCount)
        let clipTypes: @convention(block) () -> String = { Json.string(Clip.types()) }
        set("clipTypes", clipTypes)
        let readClip: @convention(block) () -> String = { Json.string(Clip.read()) }
        set("readClip", readClip)
        let writeClip: @convention(block) (String, String) -> Bool = { Clip.write(html: $0, text: $1) }
        set("writeClip", writeClip)
        let paste: @convention(block) () -> Bool = { Keys.pasteCommandV() }
        set("paste", paste)
        let frontApp: @convention(block) () -> String = { Json.string(Front.now()) }
        set("frontApp", frontApp)
        let setHotkeys: @convention(block) (String) -> String = { j in
            let list = (try? JSONSerialization.jsonObject(with: Data(j.utf8))) as? [[String: Any]] ?? []
            return Json.string(Hotkeys.shared.set(list.compactMap { k in
                guard let id = k["id"] as? String, let accel = k["accel"] as? String else { return nil }
                return (id, accel)
            }))
        }
        set("setHotkeys", setHotkeys)

        // The panel.
        let setPanel: @convention(block) (String) -> Void = { [weak self] j in self?.panel?.render(j) }
        set("setPanel", setPanel)

        // Opening things. Only web and mail links, and files Morph itself saved (PDFs in Downloads).
        let openUrl: @convention(block) (String) -> Void = { s in
            guard let u = URL(string: s), ["https", "http", "mailto"].contains(u.scheme?.lowercased() ?? "") else { return }
            NSWorkspace.shared.open(u)
        }
        set("openUrl", openUrl)
        let openPath: @convention(block) (String) -> Void = { [weak self] p in
            guard let self = self, Files.isMorphPdf(p, in: self.paths.downloads) else { return }
            NSWorkspace.shared.open(URL(fileURLWithPath: p))
        }
        set("openPath", openPath)
        let reveal: @convention(block) (String) -> Void = { [weak self] p in
            guard let self = self, Files.isMorphPdf(p, in: self.paths.downloads) else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
        }
        set("reveal", reveal)

        let savePdf: @convention(block) (String, String, JSValue) -> Void = { [weak self] html, p, cb in
            guard let self = self, Files.isMorphPdf(p, in: self.paths.downloads) else { cb.call(withArguments: [false]); return }
            Pdf.save(html: html, to: URL(fileURLWithPath: p)) { ok in cb.call(withArguments: [ok]) }
        }
        set("savePdf", savePdf)

        let httpGet: @convention(block) (String, JSValue) -> Void = { s, cb in
            Net.get(s, max: 64 * 1024) { status, body in cb.call(withArguments: [status, body]) }
        }
        set("httpGet", httpGet)
        let update: @convention(block) (String, JSValue) -> Void = { v, cb in
            Updater.install(version: v) { ok in cb.call(withArguments: [ok]) }
        }
        set("update", update)
        let uninstall: @convention(block) () -> Bool = { [weak self] in
            guard let self = self else { return false }
            return Uninstaller.run(paths: self.paths)
        }
        set("uninstall", uninstall)
        let ocr: @convention(block) (JSValue) -> Void = { cb in Ocr.readClipboard { json in cb.call(withArguments: [json]) } }
        set("ocr", ocr)

        ctx.setObject(native, forKeyedSubscript: "native" as NSString)
    }

    func start() {
        ctx.evaluateScript("startMorphMac(native)")
        Hotkeys.shared.onPress = { [weak self] id in self?.ctx.objectForKeyedSubscript("__morphHotkey")?.call(withArguments: [id]) }
    }

    func action(_ a: String) {
        ctx.objectForKeyedSubscript("__morphAction")?.call(withArguments: [a])
    }
}

enum Json {
    static func string(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v) else { return "null" }
        return String(data: d, encoding: .utf8) ?? "null"
    }
}

/// Where Morph keeps things.
struct Paths {
    let support: URL
    let settings: URL
    let downloads: URL
    let log: URL

    static func standard() -> Paths {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let home = env["MORPH_HOME"].map { URL(fileURLWithPath: $0) }
        let support = home?.appendingPathComponent("Support") ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Morph")
        let downloads = home?.appendingPathComponent("Downloads") ?? fm.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let logs = home?.appendingPathComponent("Logs") ?? fm.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs")
        return Paths(support: support, settings: support.appendingPathComponent("settings.json"), downloads: downloads, log: logs.appendingPathComponent("Morph.log"))
    }
}

enum Files {
    /// Writes a file only this user can read, all at once.
    static func writePrivate(_ s: String, to url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data(s.utf8).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return true
        } catch { Log.write("[morph] could not write \(url.lastPathComponent): \(error.localizedDescription)"); return false }
    }
    /// A PDF Morph saves: Downloads/Morph_<date>_<time>[_n].pdf, nothing else.
    static func isMorphPdf(_ p: String, in downloads: URL) -> Bool {
        let u = URL(fileURLWithPath: p).standardizedFileURL
        guard u.deletingLastPathComponent().path == downloads.standardizedFileURL.path else { return false }
        return u.lastPathComponent.range(of: #"^Morph_\d{4}-\d\d-\d\d_\d\d\.\d\d\.\d\d(_\d{1,2})?\.pdf$"#, options: .regularExpression) != nil
    }
}

enum Log {
    static var url: URL?
    static let echo = ProcessInfo.processInfo.environment["MORPH_DEBUG"] != nil
    static func write(_ s: String) {
        if echo { FileHandle.standardError.write(Data((s + "\n").utf8)) }
        guard let url = url else { return }
        let line = Data((ISO8601DateFormatter().string(from: Date()) + " " + s + "\n").utf8)
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        // Kept short: a log that grows past 1 MB starts again.
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 1_000_000 { try? Data().write(to: url) }
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line); try? h.close() }
    }
}

enum Net {
    /// A plain GET (the update check). Calls back on the main thread with the status and at most `max` bytes.
    static func get(_ s: String, max: Int, done: @escaping (Int, String) -> Void) {
        guard let u = URL(string: s), u.scheme == "https" || ProcessInfo.processInfo.environment["MORPH_UPDATE_URL"] != nil else { done(0, ""); return }
        var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.httpShouldHandleCookies = false
        URLSession(configuration: .ephemeral).dataTask(with: req) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.map { String(decoding: $0.prefix(max), as: UTF8.self) } ?? ""
            DispatchQueue.main.async { done(status, body) }
        }.resume()
    }
}
