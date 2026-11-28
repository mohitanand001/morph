# Testing Morph

Morph lives inside GNOME Shell, reads the clipboard of other apps and presses keys for you. That is hard to check by
hand, so almost everything is checked by machine, in two layers:

| | What it runs | How long | Command |
|---|---|---|---|
| **Fast tests** | Morph's logic with a pretend desktop: conversions, settings, privacy rules, install and uninstall in a throwaway home folder | about a minute | `npm test` |
| **Morph Lab** | A real GNOME Shell (headless, invisible), Morph's real helper and real background program, and stand-in apps that copy and paste through the real clipboard | about 3 minutes | `npm run lab` |

Run both before every release: `npm run test:all`.

The Mac app has its own layer: `test/mac-host.test.js` and `test/mac-panel.test.js` run here with the fast tests, and
`.github/workflows/mac.yml` builds the app on a real Mac and runs its self-test. See [mac/README.md](mac/README.md).

## Morph Lab

The lab starts its own GNOME Shell with no screen, in its own temporary home folder and its own session. It never
touches your desktop, your settings or a Morph you have installed. Then it does what a person does: opens apps,
selects text, presses Ctrl+C, switches windows, clicks Morph's buttons, presses Ctrl+V, and checks what arrived.

```
npm run lab                  # every scenario
npm run lab -- privacy       # only scenarios whose name or file contains "privacy"
```

At the end it writes **`test-results/lab/index.html`**: every scenario with its steps, screenshots and checks. Open
it in a browser. Next to it: `gnome-shell.log`, `morph-daemon.log` (Morph's program, with debug output) and
`apps.log` (the stand-in apps).

**What you need** (Ubuntu 24.04 or any distro with GNOME 45+):

```
sudo apt install gnome-shell gjs dbus mutter gir1.2-gtk-4.0 librsvg2-common fonts-cantarell adwaita-icon-theme
```

On a normal desktop or a CI machine that is all. In a container without systemd, run it as root (`sudo npm run
lab`): GNOME Shell asks logind about the session, and the lab hides `/run/systemd` from that one shell with a
private mount.

**In CI** the `lab` job in `.github/workflows/test.yml` runs it on every push and keeps the report as a download
(`morph-lab-report`) under the run's Artifacts.

### What it checks today

| File | Scenarios |
|---|---|
| `01-smoke.js` | the tab shows and the panel opens |
| `02-convert.js` | Google Docs table → Jira and Undo; Markdown → Slack; Convert automatically on app switch; converted text into a plain-text app |
| `03-privacy.js` | password manager copies are never read (also after switching apps and waiting); a lone password-like word is dropped; other programs can't use Morph's helper; window titles are never broadcast; Morph's program offers nothing on the bus |
| `04-layout.js` | pressing Jira/Undo/Save as PDF, and switching options in Settings, move nothing else on the panel |
| `05-keyboard.js` | Settings works with Tab/Enter/Esc; typing still reaches your app with Morph open; a click outside gives the keyboard back |
| `06-firstrun.js` | the welcome card on a new install; hover labels; ✕ only folds Morph into its tab |
| `07-canary.js` | made-up words copied through every feature are then searched for in every file and log (debug on): none may appear; Morph's program runs under strace and may open no connection but the update check, which may send nothing but a request for version.json |

### Writing a scenario

Add a file under `test/lab/scenarios/` (they run in file-name order). Each exports a list:

```js
module.exports = [
  {
    name: 'a Slack message pastes into Confluence as a table',
    settings: { autoFormat: false },          // Morph's settings for this scenario (null: a brand-new install)
    run: async (lab, t) => {
      const slack = await lab.app('slack');    // a stand-in window Morph sees as Slack
      const conf = await lab.app('confluence');
      await slack.focus();
      await slack.copy({ text: 'A\tB\n1\t2', html: '<table>…</table>' });   // selects this, presses Ctrl+C
      await conf.focus();
      await lab.open();                        // clicks the tab
      await lab.shot('Morph in Confluence');   // a screenshot in the report
      await lab.click('Confluence');           // clicks whatever shows that text (or icon name)
      const got = await conf.paste();          // presses Ctrl+V; returns { formats, text, html }
      t.check('Confluence gets a table', /<table/.test(got.html), got.html);
    },
  },
];
```

**The lab** (`lab`):

| | |
|---|---|
| `await lab.app(key)` | Opens a stand-in app. Keys: `slack`, `jira`, `confluence`, `gdocs`, `outlook`, `notion`, `editor` (a plain-text app), `keepass` (a password manager). Any other key opens a generic app; `lab.app('x', { app, title })` sets its app id and window title. |
| `app.focus()` | Brings it to the front and waits until GNOME and the app agree. |
| `app.copy({ text, html })` | Selects that content in the app and presses Ctrl+C (the app confirms it copied). |
| `app.paste()` | Presses Ctrl+V in the app and returns what arrived: `{ formats, text, html }`. |
| `lab.open()` | Clicks the tab to open Morph. |
| `lab.click(text)` | Clicks the part of Morph that shows this text, or whose icon is named this (`'Settings'`, `'Close'`, `'Undo'`). Fails with what *is* on screen if nothing matches. |
| `lab.key('tab')` | Presses keys: `'ctrl+v'`, `'shift+tab'`, `'esc'`, `'enter'`, `'ctrl+alt+f'`. |
| `lab.hover(text)` | Points at it (for hover labels). |
| `lab.state()` | Morph's state: `{ open, view, visible, source, primary, footer, sub, hasGrab, setup }`. |
| `lab.texts()` | Every text Morph shows right now. |
| `lab.tree()` | Every part of Morph with its position and size, class, text, focus. |
| `lab.focused()` | The part that has the keyboard focus, if any. |
| `lab.shifts(fn, allow)` | Runs `fn` and lists every part of Morph that moved, resized, appeared or disappeared. Fading in place doesn't count. `allow`: paths that may change (`await lab.partOf('Jira')` gives the path of the button you press). The card's message line may always change. |
| `lab.shot(caption)` | Takes a screenshot for the report. |
| `lab.call(dest, path, iface, method, sig, args, out)` | A D-Bus call made by the lab, which is *not* Morph (used to check that strangers are refused). |
| `lab.waitFor(what, fn, ms)` | Waits until `fn()` is true (it's best to wait on a condition rather than for a fixed time). |
| `lab.settle()` | Waits until Morph stops changing. |

**Checks** (`t`):

| | |
|---|---|
| `t.check(name, ok, detail)` | A normal check. `detail` is shown when it fails. |
| `t.known(name, ok, detail, why)` | A known issue: checked and shown in amber, but it doesn't fail the run. When it starts passing, the report says so: make it a normal check. |

A scenario fails if a check fails or a step throws (a click on something that isn't there, a timeout). The report
then shows a screenshot of the moment it failed.

### Known issues the lab shows

- **Converted text has no plain-text copy.** GNOME Shell's scripting language can't put more than one format on
  the clipboard, so after converting for Jira, Slack or Docs, apps that paste only plain text (terminals, code
  editors, simple fields) get nothing. "Paste as plain text" (Ctrl+Alt+Shift+V) works around it.

### How it works

- `run.js` makes a temporary home folder, starts a private session bus, and runs itself again inside it.
- `lab.js` sets GNOME's settings for a quiet test (no animations, no notifications), installs Morph's helper the way
  `morph --install` does, starts `gnome-shell --headless --unsafe-mode` with a 1280×800 virtual screen, and starts
  Morph's program fresh for every scenario.
- `driver.js` runs inside GNOME Shell (sent once through its Eval method, which only answers in unsafe mode, so only
  in the lab's own shell). It reads Morph's on-screen parts with their real positions, and moves a virtual mouse and
  keyboard whose events go through GNOME like real ones.
- `fakeapp.js` is a small GTK 4 window with any app id and title. It copies and pastes through the real Wayland
  clipboard and tells the lab what it received.
- `bridge.js` makes D-Bus calls for the lab. It is also a "stranger" on purpose: Morph's helper must refuse it.
- `report.js` writes the HTML report.
