# Morph

Copy from Slack, Jira, Confluence, Outlook, Google Docs, a spreadsheet, an AI chat or a terminal, and paste it correctly anywhere: Slack, Jira, Confluence, email, Google Docs, Markdown or plain text.

Morph is a small background program for the GNOME desktop on Linux. It re-shapes what you copy for the app you paste into, so tables stay tables, lists stay lists and code keeps its indentation.

> **Status: release candidate (0.15.0-rc.1).** It is being tested. Expect rough edges and please report them.

## Install

Open a terminal and run:

```
curl -fsSL https://mohitanand001.github.io/morph/install.sh | bash
```

The installer checks the download against a fingerprint before it installs anything. A short welcome opens by itself; there is nothing to set up. No log out is needed.

Needs GNOME (tested on Ubuntu with Wayland) and `gjs`, which GNOME already includes. Other commands: `morph --status`, `--restart`, `--setup` (show the welcome again), `--update`, `--uninstall`.

You can read the installer first: [`site/install.sh`](site/install.sh).

## What it does

- **Tables**: Slack text tables, spreadsheet ranges, psql/mysql output and HTML tables become real tables in Jira, Confluence, Slack, email and Docs.
- **Destination-aware copy**: each destination gets the format it understands. Pairs that already paste fine are passed through untouched, and Morph says so.
- **Lists and indentation**: odd bullets, `a) b)` numbering, mixed tabs and spaces and Outlook's fake lists become real nested lists.
- **Terminal output** and **PDF text** are cleaned up too.
- **A pill** on the screen edge shows what you copied and offers the apps to convert it for. Click an app, then paste with Ctrl+V.
- **Optional table OCR**: reads a table from a copied image, on your device, only when you click. Turn it on in Settings, Privacy (a ~1 GB install of PaddleOCR).

## Privacy

- Morph never stores what you copy and never sends it anywhere. Conversion happens on your computer.
- Morph works in all apps by default, except password managers. In Settings → Apps you can limit it to only the apps you pick. Copies that an app marks as secret are always ignored.
- Settings, Privacy shows a log of what Morph read: time, app and size, never the content.
- The only network use is an optional daily update check and the optional OCR install.
- `morph --uninstall` removes the program, the GNOME helper, settings, logs and caches.

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
