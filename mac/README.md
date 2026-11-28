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

On macOS 15.4 and newer, the Mac may also ask before Morph reads what another app copied ("Paste from Other
Apps"). While it would ask, Morph reads nothing in the background (that would mean an alert for every copy): the
card says "Not read yet: the Mac asks first", and picking an app reads and converts it. To have Morph convert by
itself again, set System Settings → Privacy & Security → Paste from Other Apps → Morph → Always Allow.

Morph → Settings → Privacy shows both permissions, and each row opens its page in System Settings. With
Accessibility off, the card says so, and the paste shortcut converts and asks you to press ⌘V.

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
- **The Mac lab** (`mac/lab/run.sh`, the `lab` job in `.github/workflows/mac.yml`): the real Morph on a CI Mac with
  stand-in apps (`mac/lab/FakeApp.swift`: "Slack", a "Jira" browser tab, a chat app, KeePassXC, a plain editor)
  that copy and paste through the real clipboard, with real key presses and mouse clicks (35 checks): window
  titles, Convert automatically on switching apps, ⌘V, ⌃⌥V and ⌃⌥⇧V into the apps, password-manager and
  concealed copies never read, RTF copies, a table read from a picture, opening the panel with the mouse,
  clicking an app in it, typing still going to your app, Settings, a click elsewhere closing it, dragging the
  tab, Hide Morph and ⌃⌥F, Save as PDF, and nothing copied in Morph's files. Then, for real, in temporary
  folders: the installer (twice, and refusing a bad fingerprint), an update to a newer version (and refusing a bad
  checksum), and uninstall (keeping a file that is not Morph's).
- `.github/workflows/mac.yml`: builds the app on a real Mac and runs `Morph --selftest` (JavaScriptCore,
  clipboard formats, RTF copies, shortcuts, text recognition on a drawn table, the panel page in WebKit, PDF in
  pages). Results are annotations on the run, and the zip, results and a screenshot of the panel are its artifact.
  A `v<version>` tag, or "Run workflow" on the Actions page from main, publishes the zip as the release
  `v<version>`, which the installer and in-app updates download.

Not checked by machine: the moment a person allows Accessibility, and the "Paste from Other Apps" alert (the CI Mac
allows both from the start), real Slack/Jira/Outlook, several screens, and Intel Macs (CI is Apple silicon).
