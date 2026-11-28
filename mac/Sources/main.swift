// Morph for Mac. A background app (no Dock icon, no menu bar): the tab at the screen edge is all you see.
//   Morph.app/Contents/MacOS/Morph               runs Morph
//   Morph.app/Contents/MacOS/Morph --selftest F  checks the parts that need a real Mac and writes the results to F
import AppKit
import ApplicationServices

final class AppDelegate: NSObject, NSApplicationDelegate {
    var bridge: Bridge!
    var panel: Panel!
    let paths = Paths.standard()

    func applicationDidFinishLaunching(_ note: Notification) {
        Log.url = paths.log
        startWhenAlone(tries: 0)
    }

    /// One Morph at a time. Right after an update the old one is still quitting: wait a few seconds for it.
    private func startWhenAlone(tries: Int) {
        let me = NSRunningApplication.current
        let others = Bundle.main.bundleIdentifier.map { id in NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { $0 != me } } ?? []
        if !others.isEmpty {
            if tries < 30 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.startWhenAlone(tries: tries + 1) }; return }
            Log.write("[morph] already running")
            NSApp.terminate(nil)
            return
        }
        start()
    }

    private func start() {
        try? FileManager.default.createDirectory(at: paths.support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        bridge = Bridge(paths: paths)
        panel = Panel()
        bridge.panel = panel
        panel.onAction = { [weak self] a in self?.bridge.action(a) }
        guard bridge.load() else { Log.write("[morph] could not load its logic"); NSApp.terminate(nil); return }
        LoginItem.addOnce(paths: paths)
        askForAccessibilityOnce()
        bridge.start()
        Log.write("[morph] started, version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")")
    }

    /// Opening Morph again while it runs brings the tab back (after "Hide Morph").
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        bridge?.action("key:pill")
        return false
    }

    /// Morph needs Accessibility to see which window is in front (Jira or Docs in a browser) and to press ⌘V for you.
    /// The Mac asks once; after that it is in System Settings → Privacy & Security → Accessibility.
    private func askForAccessibilityOnce() {
        let marker = paths.support.appendingPathComponent("asked-accessibility")
        guard !AXIsProcessTrusted(), !FileManager.default.fileExists(atPath: marker.path) else { return }
        _ = Files.writePrivate("1", to: marker)
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
}

/// --lab-update <version> and --lab-uninstall: run the real update or uninstall on this copy of the app, for the lab
/// (CI only: they refuse to run without MORPH_HOME, so they can never touch a person's own Morph settings).
final class LabTask: NSObject, NSApplicationDelegate {
    let what: String, arg: String
    init(_ what: String, _ arg: String) { self.what = what; self.arg = arg }
    func applicationDidFinishLaunching(_ n: Notification) {
        guard ProcessInfo.processInfo.environment["MORPH_HOME"] != nil else { print("Needs MORPH_HOME."); exit(2) }
        let paths = Paths.standard()
        Log.url = paths.log
        if what == "--lab-update" {
            Updater.install(version: arg) { ok in print(ok ? "updated" : "update failed"); if !ok { exit(1) } }
        } else {
            print(Uninstaller.run(paths: paths) ? "uninstalled" : "uninstall failed")
        }
    }
}

let args = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let appDelegate: NSApplicationDelegate
if args.count >= 2 && (args[1] == "--lab-update" || args[1] == "--lab-uninstall") {
    appDelegate = LabTask(args[1], args.count >= 3 ? args[2] : "")
} else if args.count >= 2 && args[1] == "--lab" {
    appDelegate = Lab(out: args.count >= 3 ? args[2] : "/dev/stdout")
} else if args.count >= 2 && args[1] == "--selftest" {
    appDelegate = SelfTest(out: args.count >= 3 ? args[2] : "/dev/stdout")
} else {
    appDelegate = AppDelegate()
}
app.delegate = appDelegate
withExtendedLifetime(appDelegate) { app.run() }
