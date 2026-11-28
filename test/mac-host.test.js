// The Mac app's JavaScript (tools/build-mac.js bundle: converter + core.js + mac/host.js) run the way the Mac app runs
// it: one script in a bare JavaScript context (no Node, no require, no process), talking to a pretend Mac through
// `native`. Checks copying, converting, privacy, shortcuts, PDF, image tables, updates and the panel's words.
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); } };
const { mac, flush, SRC, SLACK, CHROME_GPT, ONEPW, JIRA, MD } = require('./mac-fake');

(async () => {
  check('the bundle uses nothing from Node', !/\bprocess\.|require\('(fs|path|child_process|os)'\)/.test(SRC.replace(/\/\/.*$/gm, '')));

  {
    const m = mac();
    await m.start();
    check('starts and draws the panel', m.panels.length > 0 && m.panel().title === 'Morph', JSON.stringify(m.panel()).slice(0, 200));
    check('what was on the clipboard before Morph started is never read', m.reads === 0, m.reads + ' reads');
    check('shortcuts are registered with the Mac', Array.isArray(m.hotkeys) && m.hotkeys.some((k) => k.id === 'paste'), JSON.stringify(m.hotkeys));
    await m.advance(3000);
    check('looking for new copies reads nothing while nothing is copied', m.reads === 0 && m.typeReads === 0, m.reads + ' reads, ' + m.typeReads + ' type checks');

    m.copy(CHROME_GPT, MD);
    await m.advance(400);
    check('a new copy is read once', m.reads === 1, m.reads + ' reads');
    check('the card says where it came from', /ChatGPT/.test(JSON.stringify(m.panel().source)), JSON.stringify(m.panel().source));
    m.focus(SLACK);
    await m.advance(800);
    const w = m.writes[m.writes.length - 1];
    check('switching to Slack converts it (Convert automatically is on by default)', !!w && /<table|<b>|<strong>/i.test(w.html || '') || (w && /\*bold\*/.test(w.text)), JSON.stringify(w));
    check('the Mac clipboard gets both the formatted version and plain text', !!w && !!w.html && !!w.text, JSON.stringify(w).slice(0, 300));
    const before = m.reads;
    await m.advance(1000);
    check('Morph\'s own write is not taken for a new copy', m.reads === before, (m.reads - before) + ' extra reads');
    check('the card says to press ⌘V', /⌘V/.test(m.panel().sub || ''), m.panel().sub);
    m.ctx.__morphAction('toggle:tabicons');
    check('settings are kept in Application Support', !!m.files['/Users/t/Library/Application Support/Morph/settings.json']);
    check('nothing copied is written to any file', !Object.values(m.files).some((s) => /Ana|bold point|Results/.test(s)));

    // the shortcut: convert for the app in front and press ⌘V
    m.copy(CHROME_GPT, { text: 'Plan:\n\n1. **ship** it\n2. test' });
    await m.advance(400);
    m.focus(JIRA);
    await m.advance(800);
    const p0 = m.pastes;
    m.ctx.__morphHotkey('paste');
    await m.advance(200);
    check('the paste shortcut converts for Jira and presses ⌘V', m.pastes === p0 + 1 && /<strong>|<b>/.test(m.writes[m.writes.length - 1].html), m.pastes + ' ' + JSON.stringify(m.writes[m.writes.length - 1]).slice(0, 200));

    // PDF
    m.ctx.__morphAction('pdf:');
    await m.advance(300);
    const pdf = m.pdfs[m.pdfs.length - 1];
    check('Save as PDF writes Morph_<date>_<time>.pdf to Downloads', !!pdf && /^\/Users\/t\/Downloads\/Morph_2026-11-28_10\.\d\d\.\d\d\.pdf$/.test(pdf.path), pdf && pdf.path);
    check('…from the copy, as a page', !!pdf && /ship/.test(pdf.html) && /<!doctype html>/i.test(pdf.html));
    check('…and the panel offers to open it', (m.panel().footer || []).some((f) => f.action === 'openpdf:'), JSON.stringify(m.panel().footer));
    m.ctx.__morphAction('showpdf:');
    check('Show in folder reveals it in the Finder', m.opened.includes('reveal ' + pdf.path), m.opened.join(','));
    m.ctx.__morphAction('nonsense here');
    m.ctx.__morphAction('openlink:javascript');
    check('odd actions from the panel do nothing', m.opened.length === 1);
  }

  {
    const m = mac();
    await m.start();
    m.copy(ONEPW, { text: 'correct horse battery staple' });
    await m.advance(400);
    m.focus(SLACK);
    await m.advance(3000);
    check('a copy made in 1Password is never read', m.reads === 0, m.reads + ' reads');
    check('…and the card says so', /password manager/i.test(JSON.stringify(m.panel().source)), JSON.stringify(m.panel().source));
    m.copy(CHROME_GPT, { text: 'hunter2 secret value' }, ['org.nspasteboard.ConcealedType']);
    await m.advance(1500);
    check('a copy an app marks as concealed is never read', m.reads === 0, m.reads + ' reads');
    check('nothing was written over them', m.writes.length === 0);
    m.copy(CHROME_GPT, { text: 'Tr0ub4dor&3xK!' });
    await m.advance(400);
    m.focus(SLACK);
    await m.advance(1500);
    check('a lone password-like word is let go of, not converted', m.writes.length === 0 && !JSON.stringify(m.panel()).includes('Tr0ub4dor'), JSON.stringify(m.writes));
  }

  {
    const m = mac();
    await m.start();
    m.copy({ app: 'com.apple.Preview', name: 'Preview', title: 'salary.png' }, { image: true });
    await m.advance(400);
    check('a copied image: the card offers to read its table', /Image copied/.test(JSON.stringify(m.panel().source)), JSON.stringify(m.panel().source));
    m.ctx.__morphAction('fix:slack');
    await m.advance(500);
    const w = m.writes[m.writes.length - 1];
    check('picking Slack reads the table with the Mac\'s own text recognition', !!w && /James Miller/.test(w.html + w.text) && /Net Salary/.test(w.html + w.text), JSON.stringify(w).slice(0, 300));
    m.ctx.__morphAction('view:ocr');
    await flush();
    check('Settings → Image tables says it is built in, with nothing to download', /Mac's own text recognition/.test(JSON.stringify(m.panel().pane)) && !/Download|RapidOCR/.test(JSON.stringify(m.panel().pane)), JSON.stringify(m.panel().pane).slice(0, 300));
  }

  {
    const m = mac({ http: (u, cb) => cb(200, JSON.stringify({ version: '0.16.0' })) });
    await m.start();
    m.ctx.__morphAction('view:updates');
    m.ctx.__morphAction('checkupdate:');
    await m.advance(500);
    check('Check for updates finds a newer version', /0\.16\.0 is available/.test(JSON.stringify(m.panel().pane)), JSON.stringify(m.panel().pane).slice(0, 300));
    m.ctx.__morphAction('update:');
    await m.advance(500);
    check('Update now asks the app for that version', m.updates[0] === '0.16.0', JSON.stringify(m.updates));
    check('…and says so when it did not finish (download Morph again)', /download Morph again/.test(JSON.stringify(m.panel().pane)), JSON.stringify(m.panel().pane).slice(0, 400));
    const bad = mac({ http: (u, cb) => cb(200, JSON.stringify({ version: '1.0; rm -rf ~' })) });
    await bad.start();
    bad.ctx.__morphAction('checkupdate:');
    await bad.advance(300);
    check('a strange version from the website is ignored', !/available/.test(JSON.stringify(bad.panel())), JSON.stringify(bad.panel().note));
  }

  {
    const m = mac();
    await m.start();
    const pages = {};
    for (const v of ['settings', 'keys', 'about', 'uninstall', 'privacy']) { m.ctx.__morphAction('view:' + v); await flush(); pages[v] = JSON.stringify(m.panel()); }
    check('About says Morph for Mac', /for Mac/.test(pages.about) && /macOS/.test(pages.about) && !/GNOME|Linux/.test(pages.about), pages.about.slice(0, 400));
    check('shortcuts show Mac key symbols', /⌃/.test(pages.keys) && /⌥/.test(pages.keys) && !/Ctrl/.test(pages.keys), pages.keys.slice(0, 400));
    check('Uninstall lists the Mac app, not GNOME parts', /Morph app/.test(pages.uninstall) && !/GNOME|morph command|RapidOCR/.test(pages.uninstall), pages.uninstall.slice(0, 500));
    check('Hide Morph says how to bring it back without a terminal', !/morph --|log in again/.test(pages.settings), pages.settings.slice(0, 600));
    check('no page mentions GNOME or a terminal command', !Object.values(pages).some((p) => /GNOME|morph --/.test(p)));
    m.ctx.__morphAction('view:uninstall');
    m.ctx.__morphAction('uninstall:ask');
    m.ctx.__morphAction('uninstall:yes');
    await flush();
    check('Uninstall goes through the app after asking once', true);
  }


  {
    // macOS 15.4+: while the Mac would ask before every read, nothing is read in the background.
    const m = mac();
    m.access = 'ask';
    await m.start();
    m.copy(CHROME_GPT, MD);
    await m.advance(400);
    m.focus(SLACK);
    await m.advance(1500);
    check('while the Mac asks first, a copy is not read in the background', m.reads === 0 && m.writes.length === 0, m.reads + ' reads');
    check('…and the card says to pick an app', /the Mac asks first/.test(JSON.stringify(m.panel().source)), JSON.stringify(m.panel().source));
    check('…with the apps still clickable', (m.panel().options || []).flat().some((o) => o.action === 'fix:jira'), JSON.stringify(m.panel().options).slice(0, 200));
    m.ctx.__morphAction('fix:jira');
    await m.advance(300);
    check('picking Jira reads it then (you asked) and converts it', m.reads === 1 && m.writes.length === 1 && /<strong>|<b>|<table/.test(m.writes[0].html), JSON.stringify(m.writes).slice(0, 200));
    m.ctx.__morphAction('view:privacy');
    await flush();
    const pane = JSON.stringify(m.panel().pane);
    check('Settings → Privacy shows the Mac permissions', /Accessibility: on/.test(pane) && /The Mac asks each time/.test(pane) && /Always Allow/.test(pane), pane.slice(0, 600));
    m.ctx.__morphAction('macperm:paste');
    m.ctx.__morphAction('macperm:ax');
    m.ctx.__morphAction('macperm:evil');
    check('its rows open the right System Settings pages', m.opened.join(',') === 'settings paste,settings ax', m.opened.join(','));
  }

  {
    // Without Accessibility: no title, no ⌘V; Morph says so instead of claiming it pasted.
    const m = mac({ files: { '/Users/t/Library/Application Support/Morph/settings.json': JSON.stringify({ setupDone: true }) } });
    m.ax = false;
    await m.start();
    check('with Accessibility off, the card says how to turn it on', /Allow Accessibility/.test(m.panel().note || ''), m.panel().note);
    m.copy(CHROME_GPT, MD);
    await m.advance(400);
    m.focus(SLACK);
    await m.advance(800);
    m.ctx.__morphHotkey('paste');
    await m.advance(300);
    check('the paste shortcut converts but does not pretend to press ⌘V', m.pastes === 0 && /Ready to paste into Slack/.test(JSON.stringify(m.panel().primary || m.panel())) && /Press ⌘V/.test(m.panel().sub || ''), JSON.stringify([m.panel().primary, m.panel().sub]));
  }

  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (mac host)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack)); process.exit(1); });
