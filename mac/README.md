# Morph for Mac (preview)

The same Morph as on Linux: the same converter, the same logic (`daemon/core.js`), the same panel and settings. Only
the parts that touch the computer are the Mac's own.

## Install

```
curl -fsSL https://mohitanand001.github.io/morph/install-mac.sh | bash
```

Needs macOS 13 (Ventura) or newer, Apple silicon or Intel. The script ([read it](../site/install-mac.sh)) downloads
the app for the current version from the project's GitHub releases, checks it against its fingerprint, puts
`Morph.app` in Applications and opens it. Installed this way the Mac does not quarantine it, so there is no
"unidentified developer" warning (the app is not signed with an Apple developer certificate yet).

On the first start the Mac asks once to let Morph use **Accessibility**: System Settings → Privacy & Security →
Accessibility → Morph. Morph needs it to see which window is in front (Jira or Google Docs in a browser) and to
press ⌘V for you. Without it Morph still converts, but goes by the app alone and you press ⌘V yourself.

On macOS 15.4 and newer, the Mac may also ask whether Morph may read what other apps copied ("Paste from Other
Apps"). Choose Allow, or set it in System Settings → Privacy & Security → Paste from Other Apps.

Morph opens at login (System Settings → General → Login Items to change that). Remove it from Morph's own
Settings → Uninstall: it removes its login item and its own files by name, and moves Morph.app to the Bin.

## How it is built

| | |
|---|---|
| `mac/host.js` | Connects `daemon/core.js` to the Mac: the clipboard's change counter, the app in front, timers, PDF, updates, image tables. Runs in JavaScriptCore. |
| `mac/ui/` | The tab and panel: an HTML page that draws the same spec the GNOME helper draws. |
| `mac/Sources/` | The Swift app: the borderless panel window (WebKit), the clipboard, Accessibility (window titles, ⌘V), global shortcuts (Carbon hot keys), text recognition (Vision), PDF (WebKit printing), updates, uninstall, login item. |
| `tools/build-mac.js` | Bundles the converter, core.js and host.js into `morph.js`, and the panel's files. |
| `mac/build.sh` | On a Mac: builds `mac/build/Morph.app` (arm64 + x86_64), signs it ad hoc, zips it. |

What differs from Linux:

- **The clipboard keeps both formats.** A converted copy carries HTML, RTF and plain text, so a terminal or a plain
  field gets text and Notes gets formatting. (GNOME's helper can only offer one.)
- **Privacy is decided before reading**, as on Linux: every 300 ms Morph looks only at the clipboard's change
  counter. A new copy is read only if the app it was copied in may be read: never a password manager, never a copy
  the app marked as concealed (`org.nspasteboard.ConcealedType`), and with your own list of apps, only those.
  What was on the clipboard before Morph started is never read. Morph marks its own writes, so they are never taken
  for a new copy.
- **Image tables are built in**: macOS's own text recognition, on this computer. Nothing to download.
- **Updates** download that version's `Morph-mac.zip` from the GitHub release, check its `.sha256`, check that it
  is Morph at that version, move the running copy to the Bin and start the new one.

## Testing

- `node test/mac-host.test.js`: the whole bundle in a bare JavaScript context with a pretend Mac (copying,
  converting, privacy, shortcuts, PDF, image tables, updates, the panel's words).
- `node test/mac-panel.test.js`: the panel page in Chromium with specs from the real logic: every view fits,
  clicks send the right actions, nothing moves when you press a button, dragging moves the window. Screenshots in
  `test-results/mac-panel/`.
- `.github/workflows/mac.yml`: builds the app on a real Mac and runs `Morph --selftest` (JavaScriptCore,
  clipboard formats, RTF copies, shortcuts, text recognition on a drawn table, the panel page in WebKit, PDF in
  pages). Results are annotations on the run, and the zip, results and a screenshot of the panel are its artifact.
  A `v<version>` tag publishes the zip as a release.

Not checked by machine: Accessibility (window titles, ⌘V) and the pasteboard privacy prompt need a person to allow
them, so they are tested by hand.
