// The Mac panel (mac/ui) in a real browser engine, drawing specs made by the real logic on a pretend Mac.
// Checks: every view draws inside its window, clicks send the right actions, pressing a button moves nothing
// else, dragging the tab moves the window instead of opening it, and text from a spec is never markup.
// Screenshots go to test-results/mac-panel/ (look at them).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP mac panel tests: Playwright is not installed.'); process.exit(0); }
const { build } = require('../tools/build-mac');
const { mac, SLACK, CHROME_GPT, MD } = require('./mac-fake');

let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); } };
const OUT = path.join(__dirname, '..', 'test-results', 'mac-panel');
const RES = build(fs.mkdtempSync(path.join(os.tmpdir(), 'morph-mac-ui-')));

(async () => {
  // Specs from the real logic.
  const m = mac({ files: { '/Users/t/Library/Application Support/Morph/settings.json': JSON.stringify({ setupDone: true }) } });
  await m.start();
  const specs = {};
  specs.tab = m.panel();
  m.copy(CHROME_GPT, MD);
  await m.advance(400);
  specs.copied = m.panel();
  m.focus(SLACK);
  await m.advance(800);
  specs.converted = m.panel();
  m.ctx.__morphAction('toggle:tabicons');
  specs.strip = m.panel();
  for (const v of ['settings', 'edit', 'keys', 'privacy', 'ocr', 'updates', 'uninstall', 'about']) { m.ctx.__morphAction('view:' + v); await m.advance(50); specs['settings-' + v] = m.panel(); }
  m.ctx.__morphAction('toggle:readfrom'); // your own list of apps: switches and dragging
  m.ctx.__morphAction('view:edit'); await m.advance(50);
  specs['settings-apps-own'] = m.panel();
  const fresh = mac();
  await fresh.start();
  specs.welcome = fresh.panel();

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 700 }, deviceScaleFactor: 2 });
  // Served from its own origin, the way the Mac app serves it (morph://ui/), so the page's CSP applies.
  await page.route('http://morph.test/**', (route) => {
    const f = path.join(RES, 'ui', path.basename(new URL(route.request().url()).pathname));
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto('http://morph.test/panel.html');
  const posts = () => page.evaluate(() => (window.__morphPosts || []).slice());
  const clearPosts = () => page.evaluate(() => { window.__morphPosts = []; });
  const show = async (spec) => {
    await page.evaluate((s) => window.morphRender(JSON.stringify(s)), spec);
    await page.waitForTimeout(60);
  };
  const openPanel = async () => {
    if (await page.evaluate(() => window.morphState().open)) return;
    const box = await page.locator('.tab').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.waitForTimeout(60);
  };
  const lastSize = async () => (await posts()).filter((x) => x.type === 'size').pop();
  // Nothing may stick out of the card, at any size.
  const overflow = () => page.evaluate(() => {
    const card = document.querySelector('#root > *');
    if (!card) return 'nothing drawn';
    const c = card.getBoundingClientRect();
    const bad = [];
    card.querySelectorAll('*').forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const inScroll = e.closest('.scroll');
      if (r.right > c.right + 0.5 || r.left < c.left - 0.5 || (!inScroll && r.bottom > c.bottom + 0.5)) bad.push((e.className || e.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' in ' + Math.round(c.left) + '..' + Math.round(c.right));
    });
    return bad.slice(0, 3).join('; ');
  });

  check('the page loads with no errors (its CSP blocks nothing it needs)', errors.length === 0, errors.join(' | '));
  check('it tells the app it is ready', (await posts()).some((p) => p.type === 'ready'));

  // The tab.
  await show(specs.tab);
  let sz = await lastSize();
  check('the tab is drawn and its size sent to the app', sz && sz.mode === 'tab' && sz.w >= 26 && sz.w <= 30 && sz.h >= 68, JSON.stringify(sz));
  await page.screenshot({ path: path.join(OUT, '01-tab.png'), clip: { x: 640, y: 0, width: 60, height: 120 } });

  // Dragging the tab moves the window, and does not open the panel.
  await clearPosts();
  let box = await page.locator('.tab').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + 50, { steps: 4 });
  await page.mouse.move(box.x + 10, box.y + 90, { steps: 4 });
  await page.mouse.up();
  let ps = await posts();
  check('dragging the tab asks the app to move the window', ps.some((p) => p.type === 'drag' && p.phase === 'start') && ps.some((p) => p.type === 'drag' && p.phase === 'move' && p.dy >= 55) && ps.some((p) => p.type === 'drag' && p.phase === 'end'), JSON.stringify(ps).slice(0, 300));
  check('…and does not open Morph', !(await page.evaluate(() => window.morphState().open)));

  // A click opens it.
  await clearPosts();
  await openPanel();
  ps = await posts();
  check('a click on the tab opens the panel', await page.evaluate(() => window.morphState().open) && ps.some((p) => p.type === 'action' && p.action === 'opened:'), JSON.stringify(ps));
  for (const [k, file] of [['tab', '02-empty'], ['copied', '03-copied'], ['converted', '04-converted']]) {
    await show(specs[k]);
    const o = await overflow();
    check(k + ': everything fits inside the panel', !o, o);
    sz = await lastSize();
    check(k + ': panel width sent to the app', sz && sz.mode === 'panel' && sz.w === 296, JSON.stringify(sz));
    const r = await page.locator('.panel').boundingBox();
    await page.screenshot({ path: path.join(OUT, file + '.png'), clip: { x: r.x - 4, y: 0, width: r.width + 4, height: r.height + 4 } });
  }
  const txt = await page.locator('.panel').innerText();
  check('the converted card tells you to press ⌘V', /⌘V/.test(txt), txt.slice(0, 300));
  check('the app you are in has its own row, marked This app', /This app/.test(txt) && (await page.locator('.row.primary').count()) === 1);

  // Pressing a button: the right action, a "…" state, and nothing else on the panel moves.
  const layout = () => page.evaluate(() => [...document.querySelectorAll('.panel .row, .panel .source, .panel .foot-slot, .panel .bar, .panel .section')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); }));
  await show(specs.copied);
  const before = await layout();
  await clearPosts();
  const jira = page.locator('.row', { hasText: 'Jira' }).first();
  await jira.click();
  await page.waitForTimeout(40);
  ps = await posts();
  check('clicking Jira sends fix:jira', ps.some((p) => p.action === 'fix:jira'), JSON.stringify(ps));
  check('…and the row says it is working', /…/.test(await jira.innerText()), await jira.innerText());
  check('…and nothing else on the panel moved', JSON.stringify(await layout()) === JSON.stringify(before), (await layout()).filter((x, i) => x !== before[i]).join(' | '));
  const withUndo = JSON.parse(JSON.stringify(specs.copied));
  withUndo.secondary = { label: 'Undo', action: 'orig:', busy: 'Restoring…' };
  withUndo.settled = true;
  const src0 = await page.locator('.src-meta').boundingBox();
  await show(withUndo);
  const src1 = await page.locator('.src-meta').boundingBox();
  check('Undo appearing does not reflow the card text', src0.width === src1.width && src0.x === src1.x, JSON.stringify([src0, src1]));
  await clearPosts();
  await page.locator('.foot-btn', { hasText: 'Save as PDF' }).click();
  ps = await posts();
  check('Save as PDF sends pdf:', ps.some((p) => p.action === 'pdf:'), JSON.stringify(ps));

  // Settings, every page.
  let n = 5;
  for (const k of Object.keys(specs).filter((x) => /^settings-/.test(x))) {
    await show(specs[k]);
    const o = await overflow();
    check(k + ': everything fits', !o, o);
    sz = await lastSize();
    check(k + ': settings width', sz && sz.w === 460, JSON.stringify(sz));
    const r = await page.locator('.panel').boundingBox();
    await page.screenshot({ path: path.join(OUT, String(n++).padStart(2, '0') + '-' + k + '.png'), clip: { x: r.x - 4, y: 0, width: r.width + 4, height: r.height + 4 } });
  }
  await show(specs['settings-about']);
  check('About says Morph for Mac', /for Mac/.test(await page.locator('.panel').innerText()));
  await show(specs['settings-settings']);
  await clearPosts();
  await page.locator('.opt', { hasText: 'Convert automatically' }).click();
  await page.locator('.card', { hasText: SIZE_LABEL(specs['settings-settings']) }).click();
  ps = await posts();
  check('a switch and a size card send their actions', ps.some((p) => p.action === 'toggle:auto') && ps.some((p) => /^size:[sml]$/.test(p.action)), JSON.stringify(ps));
  await show(specs['settings-apps-own']);
  await clearPosts();
  const rows = page.locator('.app-row.drag');
  check('your own list: apps can be dragged', (await rows.count()) >= 5, String(await rows.count()));
  const r0 = await rows.nth(0).boundingBox();
  await page.mouse.move(r0.x + 60, r0.y + r0.height / 2);
  await page.mouse.down();
  await page.mouse.move(r0.x + 60, r0.y + r0.height / 2 + (r0.height + 4) * 2, { steps: 8 });
  await page.mouse.up();
  ps = await posts();
  check('dragging the first app two rows down sends dput:0t2', ps.some((p) => p.action === 'dput:0t2'), JSON.stringify(ps));

  // The welcome card.
  await show(specs.welcome);
  sz = await lastSize();
  check('a new install shows the welcome card', sz && sz.mode === 'welcome' && sz.w === 400, JSON.stringify(sz));
  check('welcome: everything fits', !(await overflow()), await overflow());
  const wr = await page.locator('.welcome').boundingBox();
  await page.screenshot({ path: path.join(OUT, '20-welcome.png'), clip: { x: wr.x - 4, y: 0, width: wr.width + 8, height: wr.height + 4 } });
  await clearPosts();
  await page.locator('.btn', { hasText: 'Got it' }).click();
  ps = await posts();
  check('Got it sends setup:ok and closes the card', ps.some((p) => p.action === 'setup:ok') && (await page.evaluate(() => window.morphState().mode)) !== 'welcome', JSON.stringify(ps));

  // Text from a spec is text, never markup; actions and colours are checked.
  const evil = JSON.parse(JSON.stringify(specs.copied));
  evil.source = { title: '<img src=x onerror="window.__pwned=1">', sub: '<b>bold</b>', dest: '../../x' };
  evil.options = [[{ label: '<script>window.__pwned=2</script>', action: 'fix:slack;rm', color: 'red;background:url(x)', dest: 'slack' }]];
  evil.footer = [];
  await show(evil);
  await openPanel();
  await clearPosts();
  await page.locator('.row', { hasText: '<script>' }).click({ force: true });
  check('markup in a spec shows as text and runs nothing', !(await page.evaluate(() => window.__pwned)) && (await page.locator('.panel img').count()) === 0 && /<img src=x/.test(await page.locator('.src-title').innerText()));
  check('a malformed action is never sent', !(await posts()).some((p) => p.type === 'action'), JSON.stringify(await posts()));

  // Closing.
  await page.evaluate(() => window.morphClose());
  check('a click elsewhere on the screen (morphClose) folds it into the tab', !(await page.evaluate(() => window.morphState().open)));
  check('no errors on the page', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (mac panel)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack)); process.exit(1); });

function SIZE_LABEL(spec) { const c = (spec.pane.cards || []).find((x) => !x.on); return c ? c.label : 'Compact'; }
