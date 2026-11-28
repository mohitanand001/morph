# Morph

Copy from Slack, Jira, Confluence, Outlook, Google Docs, a spreadsheet, an AI chat or a terminal, and paste it correctly anywhere: Slack, Jira, Confluence, email, Google Docs, Markdown or plain text.

Morph is a small background program for the GNOME desktop on Linux. It re-shapes what you copy for the app you paste into, so tables stay tables, lists stay lists and code keeps its indentation.

> **Status: release candidate.** It is being tested. Expect rough edges and please report them.

## Install

Open a terminal and run:

```
curl -fsSL https://mohitanand001.github.io/morph/install.sh | bash
```

The installer checks the download against a fingerprint before it installs anything. A short welcome opens by itself; there is nothing to set up. No log out is needed.

Needs GNOME (tested on Ubuntu with Wayland) and `gjs`, which GNOME already includes. Other commands: `morph --status`, `--restart`, `--setup` (show the welcome again), `--update`, `--enable-ocr` (turn on image tables), `--uninstall`.

You can read the installer first: [`site/install.sh`](site/install.sh).

**On a Mac (preview):** `curl -fsSL https://mohitanand001.github.io/morph/install-mac.sh | bash` (macOS 13 or newer). See [mac/README.md](mac/README.md).

## What it does

- **Tables**: Slack text tables, spreadsheet ranges, psql/mysql output and HTML tables become real tables in Jira, Confluence, Slack, Outlook and Google Docs.
- **Destination-aware copy**: each destination gets the format it understands. Pairs that already paste fine (Slack to Slack, Jira to Confluence) get your copy back untouched.
- **Lists and indentation**: odd bullets, `a) b)` numbering, mixed tabs and spaces and Outlook's fake lists become real nested lists.
- **Terminal output** and **PDF text** are cleaned up too.
- **Converts as you arrive**: switch to one of Morph's apps and your copy is already converted, so plain Ctrl+V pastes it right. On by default; turn it off in Settings → General.
- **A slim tab** on the screen edge opens Morph, which shows what you copied and offers the apps to convert it for. The app you're in is at the top; click an app, then paste with Ctrl+V. The ✕ closes it back into the tab.
- **Image tables (optional)**: reads a table from a copied screenshot, on your computer, only when you click. Turn it on in Settings → Image tables (about 400 MB, one time: RapidOCR from PyPI and its models from ModelScope, the RapidOCR project's model host; after that it works offline).

## Privacy

- Morph never stores what you copy and never sends it anywhere. Conversion happens on your computer.
- Morph works in all apps by default, except password managers. In Settings → Apps you can limit it to only the apps you pick. Copies that an app marks as secret are always ignored.
- A single word with no spaces that is not a link (a password, a one-time code, a key) is let go of at once: nothing is kept or converted, even when the app gave no hint that it was secret.
- Settings → Privacy shows a log of what Morph read: time, app and size, never the content. The log lives in memory and is gone when Morph stops.
- Only Morph's own program can talk to its GNOME helper (the part that can read the clipboard and press Ctrl V). Any other program, including apps in a Flatpak or Snap sandbox, is refused.
- The only network use is an optional daily update check (it asks the website for `version.json`, nothing else is sent) and the optional image-tables download. Reading a table from an image never uses the network.
- The website and the in-browser demo load nothing from other sites: no fonts, no analytics.
- `morph --uninstall` removes the program, the GNOME helper, settings, logs, caches and the optional image-tables files, and only those: files of other programs with similar names, and anything else you put in Morph's folder, stay where they are.

Because the code is readable, you can check these claims yourself. The privacy gate lives in `daemon/core.js` (`mayRead`).

## Build and test

```
node test/run-all.js                  # all test suites
bash tools/build-linux-zip.sh $PWD/dist   # the zip the installer downloads
bash tools/build-deb.sh $PWD/dist         # a .deb for Debian and Ubuntu
```

The tests need Node.js 18 or newer. The window tests also use Chromium through Playwright.

## Contributing and reporting problems

See [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs through GitHub Issues. For security problems, see [SECURITY.md](SECURITY.md).

## License

Morph is source-available under the [Functional Source License 1.1 (Apache 2.0 future license)](LICENSE). You can use, modify and share it for any purpose except offering a competing commercial product. Each version becomes Apache 2.0 two years after it is released.

## Testing

`npm test` runs the fast tests; `npm run lab` runs Morph Lab, which drives a real (headless) GNOME Shell with Morph and stand-in apps, and writes an HTML report with screenshots. See [TESTING.md](TESTING.md).
