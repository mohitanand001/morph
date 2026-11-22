// App window tests in Chromium (the engine Electron uses).
//  - Browser mode: paste every fixture, check detection, every destination's
//    preview and what Copy puts on the clipboard.
//  - Desktop mode: a stand-in window.bridge plays the system clipboard, so the
//    Read clipboard button, auto-read on focus, the inspector and Copy through
//    the bridge are all exercised without Electron.
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP app tests: Playwright is not installed.'); process.exit(0); }

const PAGE = 'file://' + path.join(__dirname, '..', 'src', 'index.html');
const DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text'];
const FIX = path.join(__dirname, 'fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort()
  .map((f) => Object.assign({ file: f.replace('.json', '') }, JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))));
const destKey = (d) => (d === 'github' ? 'markdown' : d); // fixtures were written for the extension

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else { failed++; console.log('FAIL  ' + name + (detail ? '\n        ' + String(detail).slice(0, 300) : '')); }
}
async function paste(page, html, text) {
  await page.evaluate(([h, t]) => {
    const dt = new DataTransfer();
    if (h) dt.setData('text/html', h);
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, [html || '', text]);
  await page.waitForTimeout(200);
}
async function readClip(page) {
  return page.evaluate(async () => {
    const out = { plain: '', html: '' };
    for (const it of await navigator.clipboard.read()) {
      if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
      if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
    }
    return out;
  });
}

(async () => {
  const browser = await chromium.launch();

  // ---------------------------------------------------------- browser mode, every fixture
  for (const fx of fixtures) {
    const ctx = await browser.newContext({ viewport: { width: 1240, height: 840 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(PAGE);
    await paste(page, fx.html, fx.text);
    const ex = fx.expect;
    const label = fx.file;
    check(label + ': source ' + ex.source, (await page.inputValue('#source-select')) === ex.source, await page.inputValue('#source-select'));
    const out = {};
    for (const d of DESTS) {
      await page.click('.dest[data-dest="' + d + '"]');
      const prev = await page.$eval('#preview', (e) => e.innerText.trim());
      check(label + ' -> ' + d + ': preview not empty', prev.length > 0);
      await page.click('#copy-btn');
      await page.waitForTimeout(120);
      out[d] = await readClip(page);
      const hay = out[d].plain + '\n' + out[d].html;
      check(label + ' -> ' + d + ': copy wrote something', hay.trim().length > 0);
      check(label + ' -> ' + d + ': no undefined/[object', !/undefined|\[object/.test(hay));
    }
    const tables = (out.jira.html.match(/<table/g) || []).length;
    check(label + ': ' + ex.tables + ' table(s)', tables === ex.tables, 'got ' + tables);
    Object.entries(ex.contains || {}).forEach(([d, needles]) => {
      const k = destKey(d);
      const hay = out[k].plain + '\n' + out[k].html;
      needles.forEach((n) => check(label + ' -> ' + k + ' contains ' + JSON.stringify(n), hay.includes(n), hay.slice(0, 200)));
    });
    (ex.excludes || []).forEach((n) => DESTS.forEach((d) => check(label + ' -> ' + d + ' excludes ' + JSON.stringify(n), !(out[d].plain + out[d].html).includes(n))));
    Object.entries(ex.excludesIn || {}).forEach(([d, needles]) => {
      const k = destKey(d);
      needles.forEach((n) => check(label + ' -> ' + k + ' excludes ' + JSON.stringify(n), !(out[k].html || out[k].plain).includes(n)));
    });
    if (!ex.skipWords) {
      const words = Array.from(new Set(fx.text.toLowerCase().match(/[a-z0-9]{4,}/g) || []));
      const plain = out.text.plain.toLowerCase();
      const lost = words.filter((w) => !plain.includes(w) && !(ex.ignoreWords || []).includes(w));
      check(label + ': no words lost', lost.length === 0, lost.join(', '));
    }
    // email output must be classless, style-block-free
    check(label + ' -> email: inline styles only', !/class=|<style/i.test(out.email.html));
    check(label + ': no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------- passthrough: Slack to Slack is untouched
  {
    const fx = fixtures.find((f) => f.file === 'slack-message-table-mention');
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await page.goto(PAGE);
    await paste(page, fx.html, fx.text);
    await page.click('.dest[data-dest="slack"]');
    check('passthrough: Slack->Slack note says "as is"', (await page.textContent('.dest[data-dest="slack"] .note')).trim() === 'as is');
    await page.click('#copy-btn');
    await page.waitForTimeout(120);
    const c = await readClip(page);
    check('passthrough: Slack->Slack copies the original HTML', c.html.includes('acme.slack.com/team/U0AAAAAAA1'));
    await ctx.close();
  }

  // ---------------------------------------------------------- list repair through the UI
  {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await page.goto(PAGE);
    await paste(page, '', 'Plan:\n• Ship the app\n\t◦ Linux first\n\t◦ Mac later\n• Write tests');
    check('ui: list repair is announced', (await page.textContent('#repairs')).includes('list indentation'));
    await page.click('.dest[data-dest="jira"]');
    const nestedUl = await page.$$eval('#preview ul ul li', (els) => els.map((e) => e.textContent));
    check('ui: Jira preview has a nested list', JSON.stringify(nestedUl) === '["Linux first","Mac later"]', JSON.stringify(nestedUl));
    const outlook = '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·&nbsp;&nbsp;</span>Alpha</p><p class="MsoListParagraph" style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o&nbsp;&nbsp;</span>Beta</p><p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·&nbsp;&nbsp;</span>Gamma</p>';
    await paste(page, '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>' + outlook + '</body></html>', 'Alpha\nBeta\nGamma');
    check('ui: Outlook list detected as outlook', (await page.inputValue('#source-select')) === 'outlook');
    await page.click('.dest[data-dest="markdown"]');
    const md = await page.textContent('#preview');
    check('ui: Outlook paragraphs become a nested list', md.includes('- Alpha\n  - Beta\n- Gamma'), md);
    await ctx.close();
  }

  // ---------------------------------------------------------- companion with a stand-in bridge
  {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 640 } });
    await ctx.addInitScript(() => {
      const L = { shown: [], change: [], quick: [], hist: [], histClear: [], pdf: [] };
      window.__hist = [];
      window.__pdf = [];
      window.__clip = {
        formats: ['text/plain', 'text/html', 'chromium/x-web-custom-data', 'image/png'],
        text: 'Name\tQty\nApple\t3\nPear\t10',
        html: '<meta charset="utf-8"><table><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr><tr><td>Pear</td><td>10</td></tr></table>',
        rtf: '',
        image: { width: 2, height: 2, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EBCjgAAB8YAf0Yv2QOAAAAAElFTkSuQmCC' },
        others: [{ format: 'chromium/x-web-custom-data', bytes: 12, text: null, hex: '01 02 03' }],
      };
      window.__written = [];
      window.__hidden = 0;
      window.__tray = [];
      window.__done = [];
      window.bridge = {
        platform: 'linux',
        info: async () => ({ version: '0.2.0', shortcut: 'CommandOrControl+Alt+V', platform: 'linux', companion: true }),
        readClipboard: async () => JSON.parse(JSON.stringify(window.__clip)),
        writeClipboard: async (p) => { window.__written.push(p); window.__clip = { formats: ['text/plain', 'text/html'], text: p.text, html: p.html, rtf: '', image: null, others: [] }; return true; },
        onShown: (cb) => L.shown.push(cb),
        onClipboardChange: (cb) => L.change.push(cb),
        onQuickConvert: (cb) => L.quick.push(cb),
        hide: () => { window.__hidden++; },
        setTrayStatus: (t) => window.__tray.push(t),
        quickDone: (r) => window.__done.push(r),
        setHistory: (items) => window.__hist.push(items),
        onUseHistory: (cb) => L.hist.push(cb),
        onClearHistory: (cb) => L.histClear.push(cb),
        savePdf: async (d) => { window.__pdf.push(d); return { ok: true, name: 'x.pdf', folder: 'Downloads' }; },
        pdfDone: () => {},
        onMakePdf: (cb) => L.pdf.push(cb),
      };
      window.__fire = (k, arg, arg2) => L[k].forEach((cb) => cb(arg, arg2));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE + '?mode=companion');
    check('companion: body has the companion layout', await page.evaluate(() => document.body.classList.contains('companion')));
    check('companion: hide button shown', await page.locator('#hide-btn').isVisible());
    check('companion: version shown', (await page.textContent('#ver')) === 'v0.2.0');
    await page.evaluate(() => window.__fire('shown'));
    await page.waitForTimeout(200);
    check('companion: opening reads the clipboard', (await page.textContent('#input-box')).includes('Apple'));
    check('companion: tray status describes the copy', await page.evaluate(() => (window.__tray[window.__tray.length - 1] || '').includes('1 table')), await page.evaluate(() => window.__tray.join(' | ')));
    check('companion: nothing written to disk', await page.evaluate(() => localStorage.getItem('fb.last') === null));
    await page.click('.dest[data-dest="slack"]');
    check('companion: spreadsheet HTML becomes a Slack table', await page.locator('#preview table').count() === 1);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#copy-btn').getBoundingClientRect().bottom <= innerHeight);
    check('companion: fits the popover with Copy visible', fits);
    {
      const fx = fixtures.find((f) => f.file === 'slack-message-table-mention');
      await page.evaluate(([h, t]) => { window.__clip = { formats: ['text/plain', 'text/html'], text: t, html: h, rtf: '', image: null, others: [] }; }, [fx.html, fx.text]);
      await page.click('#read-btn');
      for (const d of ['jira', 'email', 'markdown']) {
        await page.click('.dest[data-dest="' + d + '"]');
        const ok = await page.evaluate(() => document.querySelector('#copy-btn').getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth);
        check('companion: Copy stays visible with a big table (' + d + ')', ok);
      }
      await page.evaluate(() => { window.__clip = { formats: ['text/plain', 'text/html'], text: 'Name\tQty\nApple\t3', html: '<table><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr></table>', rtf: '', image: null, others: [] }; });
      await page.click('#read-btn');
    }
    // edits survive re-opening with the same clipboard
    await page.click('#input-box');
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await page.evaluate(() => window.__fire('shown'));
    await page.waitForTimeout(150);
    check('companion: reopening with the same clipboard keeps edits', (await page.textContent('#input-box')).includes('edited'));
    // a new copy elsewhere shows up
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: '• one\n\t◦ two', html: '', rtf: '', image: null, others: [] }; window.__fire('change'); });
    await page.waitForTimeout(200);
    check('companion: a new copy replaces the content', (await page.textContent('#input-box')).includes('one') && !(await page.textContent('#input-box')).includes('Apple'));
    // tray quick-convert: no window needed
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: '| A | B |\n|---|---|\n| 1 | 2 |', html: '', rtf: '', image: null, others: [] }; window.__fire('quick', 'jira'); });
    await page.waitForTimeout(300);
    const last = await page.evaluate(() => window.__written[window.__written.length - 1]);
    check('companion: tray "convert for Jira" writes a Jira table', !!last && last.html.includes('<table') && last.html.includes('<th>A</th>'), last && last.html);
    check('companion: tray convert reports success', await page.evaluate(() => { const d = window.__done[window.__done.length - 1]; return d && d.ok && d.name === 'Jira'; }));
    // our own write is not treated as a new copy
    const before = await page.textContent('#input-box');
    await page.evaluate(() => window.__fire('change'));
    await page.waitForTimeout(150);
    check('companion: our own write does not re-import', (await page.textContent('#input-box')) === before);
    // secrets are skipped
    await page.evaluate(() => { window.__clip = { formats: ['text/plain', 'x-kde-passwordManagerHint'], secret: true, text: '', html: '', rtf: '', image: null, others: [] }; window.__fire('change'); });
    await page.waitForTimeout(150);
    check('companion: password-manager copies are ignored', (await page.textContent('#input-box')) === before);
    // empty clipboard quick-convert
    await page.evaluate(() => { window.__clip = { formats: [], text: '', html: '', rtf: '', image: null, others: [] }; window.__fire('quick', 'slack'); });
    await page.waitForTimeout(200);
    check('companion: tray convert with nothing copied says so', await page.evaluate(() => window.__done[window.__done.length - 1].ok === false));
    // switching formats converts from your original copy, not from our last output
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: '| A | B |\n|---|---|\n| 1 | 2 |', html: '', rtf: '', image: null, others: [] }; window.__fire('quick', 'jira'); });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__fire('quick', 'linear'));
    await page.waitForTimeout(250);
    const lin = await page.evaluate(() => window.__written[window.__written.length - 1]);
    check('companion: a second conversion starts from the original copy', !!lin && lin.html === '' && /\| A \| B \|/.test(lin.text), lin);
    for (const [d, want] of [['notion', (o) => o.html.includes('<table') && /\| A/.test(o.text)], ['teams', (o) => o.html.includes('<table') && !o.text.includes('---')], ['linear', (o) => o.html === '' && o.text.includes('| --- |')]]) {
      await page.evaluate((x) => window.__fire('quick', x), d);
      await page.waitForTimeout(200);
      const o = await page.evaluate(() => window.__written[window.__written.length - 1]);
      check('companion: converts for ' + d, !!o && want(o), o && { html: o.html.slice(0, 80), text: o.text.slice(0, 120) });
    }
    // text copied from a PDF is rebuilt into paragraphs and lists
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: 'Text copied from a PDF viewer is a common case where every\nline ends with a hard break and words are hyphen-\nated at the end of a line, which looks broken when you\npaste it anywhere else, so we join the lines again.\n• First point that wraps onto a second line in the\noriginal document.\n• Second ﬁxed point.', html: '', rtf: '', image: null, others: [] }; window.__fire('change'); });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__fire('quick', 'markdown'));
    await page.waitForTimeout(200);
    const pd = await page.evaluate(() => window.__written[window.__written.length - 1].text);
    check('companion: PDF text is detected and repaired', /hyphenated at the end of a line, which looks broken/.test(pd) && /- First point that wraps onto a second line in the original document\./.test(pd) && pd.includes('fixed point'), pd);
    check('companion: PDF repairs are listed', (await page.textContent('#repairs')).includes('PDF'));
    await page.click('#pdf-btn');
    await page.waitForTimeout(150);
    check('companion: Save as PDF sends clean HTML with a title', await page.evaluate(() => { const d = window.__pdf[0]; return d && d.html.includes('<ul') && /^Text copied from a PDF/.test(d.title); }));
    check('companion: Save as PDF reports where it went', (await page.textContent('#status')).includes('Downloads'));
    await page.evaluate(() => window.__fire('pdf'));
    await page.waitForTimeout(200);
    check('companion: the pill can ask for a PDF too', await page.evaluate(() => window.__pdf.length === 2));
    check('companion: Save as PDF shows in the desktop app', await page.evaluate(() => !!window.bridge.savePdf) === (await page.locator('#pdf-btn').isVisible()));
    // link back to the source: only when on, only into another app, never plain text
    await page.evaluate(() => { window.__clip = { formats: ['text/plain', 'text/html'], text: 'Ship it', html: '<p>Ship it</p>', rtf: '', image: null, others: [], linkBack: true, context: { tool: 'Slack', label: '#design-review (acme)', url: 'https://acme.slack.com/archives/C1/p1', dest: 'slack' } }; window.__fire('change'); });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__fire('quick', 'jira'));
    await page.waitForTimeout(250);
    const lj = await page.evaluate(() => window.__written[window.__written.length - 1]);
    check('companion: link back adds a linked source line', !!lj && /Source: Slack/.test(lj.html) && lj.html.includes('href="https://acme.slack.com/archives/C1/p1"') && lj.text.includes('https://acme.slack.com/archives/C1/p1'), lj && lj.html);
    await page.evaluate(() => window.__fire('quick', 'text'));
    await page.waitForTimeout(200);
    check('companion: never into plain text', await page.evaluate(() => !window.__written[window.__written.length - 1].text.includes('Source:')));
    await page.evaluate(() => window.__fire('quick', 'slack'));
    await page.waitForTimeout(200);
    check('companion: never back into the same app', await page.evaluate(() => !window.__written[window.__written.length - 1].text.includes('Source:')));
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: 'No link please', html: '', rtf: '', image: null, others: [], linkBack: false, context: { tool: 'Slack', label: '#x', url: '', dest: 'slack' } }; window.__fire('change'); });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__fire('quick', 'jira'));
    await page.waitForTimeout(200);
    check('companion: off means no link', await page.evaluate(() => !window.__written[window.__written.length - 1].text.includes('Source:')));
    // recent copies: kept in memory, listed without the current one, reusable
    await page.evaluate(() => { window.__clip = { formats: ['text/plain'], text: 'second copy\nmore', html: '', rtf: '', image: null, others: [] }; window.__fire('change'); });
    await page.waitForTimeout(200);
    const hist = await page.evaluate(() => window.__hist[window.__hist.length - 1]);
    const tableCopy = Array.isArray(hist) ? hist.find((h) => h.label.startsWith('| A | B |')) : null;
    check('companion: recent copies list the earlier ones, labelled', !!tableCopy && hist[0].label === 'No link please' && !hist.some((h) => h.label === 'second copy'), JSON.stringify(hist));
    await page.evaluate((id) => window.__fire('hist', id, 'jira'), tableCopy.id);
    await page.waitForTimeout(250);
    const hw = await page.evaluate(() => window.__written[window.__written.length - 1]);
    check('companion: an earlier copy can be pasted, converted', !!hw && hw.html.includes('<th>A</th>'), hw);
    check('companion: using it makes it current again', (await page.textContent('#input-box')).includes('| A | B |'));
    await page.evaluate((id) => window.__fire('hist', id, ''), (await page.evaluate(() => window.__hist[window.__hist.length - 1]))[0].id);
    await page.waitForTimeout(200);
    check('companion: without an app, the original goes back as it was', await page.evaluate(() => { const w = window.__written[window.__written.length - 1]; const d = window.__done[window.__done.length - 1]; return w.text.startsWith('second copy') && d.restored === true; }));
    await page.evaluate(() => window.__fire('histClear'));
    check('companion: forgetting clears the earlier copies', await page.evaluate(() => window.__hist[window.__hist.length - 1].length === 0));
    check('companion: recent copies never touch storage', await page.evaluate(() => !Object.keys(localStorage).some((k) => /second copy|\| A/.test(localStorage.getItem(k)))));
    // inspector + Esc
    await page.evaluate(() => { window.__clip = { formats: ['text/plain', 'text/html', 'chromium/x-web-custom-data'], text: 'x y', html: '<p>x <b>y</b></p>', rtf: '', image: null, others: [{ format: 'chromium/x-web-custom-data', bytes: 3, text: null, hex: '01 02 03' }] }; });
    await page.click('#read-btn');
    await page.click('#tab-inspect');
    await page.click('.fmt:has-text("chromium/x-web-custom-data")');
    check('companion: inspector shows binary formats as hex', (await page.textContent('#format-view')).includes('01 02 03'));
    await page.keyboard.press('Escape');
    check('companion: Esc hides the popover', await page.evaluate(() => window.__hidden === 1));
    await page.click('#hide-btn');
    check('companion: the ✕ button hides it', await page.evaluate(() => window.__hidden === 2));
    check('companion: no page errors', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: require('path').join(__dirname, 'out', 'companion.png') }).catch(() => {});
    await ctx.close();
  }

  // ---------------------------------------------------------- the window pill (Mac, Linux without GNOME)
  {
    const SPEC = {
      visible: true, theme: 'graphite', size: 'm', side: 'r', chips: 'chips', dot: 'has', handleColor: '#1d9bd1', settled: false,
      title: 'Copied from Slack', sub: '#design-review · Table, 3 rows',
      primary: { label: 'Paste into Confluence', hint: '+ link', action: 'paste:confluence', color: '#1d9bd1', busy: 'Pasting…' },
      secondary: { label: 'Only copy it, I’ll paste', action: 'fix:confluence', busy: 'Copying…' },
      section: 'Copy for another app',
      options: [[{ label: 'Slack', action: 'fix:slack', color: '#e01e5a', busy: 'Slack…' }, { label: 'Jira', action: 'fix:jira', color: '#2684ff' }, { label: 'Markdown', action: 'fix:markdown', color: 'red;background:url(x)' }]],
      recentTitle: 'Earlier copies', recent: [{ label: '<img src=x onerror=alert(1)>', hint: 'Jira', action: 'hist:3' }],
      links: [{ label: 'Auto-format', action: 'auto:', color: '#3fb950', hint: 'on' }, { label: 'Settings', action: 'view:settings' }, { label: 'Bad', action: 'rm -rf:/' }],
    };
    const ctx = await browser.newContext({ viewport: { width: 420, height: 700 } });
    await ctx.addInitScript(() => {
      const L = { spec: [], collapse: [], toggle: [] };
      window.__actions = [];
      window.__sizes = [];
      window.__drags = [];
      window.pill = {
        platform: 'darwin',
        action: (a) => window.__actions.push(a),
        size: (w, h, open) => window.__sizes.push({ w, h, open }),
        drag: (p) => window.__drags.push(p),
        onSpec: (cb) => L.spec.push(cb), onCollapse: (cb) => L.collapse.push(cb), onToggle: (cb) => L.toggle.push(cb),
      };
      window.__fire = (k, v) => L[k].forEach((cb) => cb(v));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(__dirname, '..', 'src', 'pill.html'));
    const open = async () => (await page.getAttribute('#pill-root', 'data-open')) === 'true';
    await page.evaluate((s) => window.__fire('spec', s), SPEC);
    await page.waitForTimeout(50);
    check('pill: starts tucked away as a slim tab', !(await open()) && await page.locator('#handle').isVisible());
    check('pill: reports the tab size so the window fits it', await page.evaluate(() => { const s = window.__sizes.at(-1); return s && s.w === 28 && s.h === 72 && !s.open; }), await page.evaluate(() => JSON.stringify(window.__sizes)));
    check('pill: the tab dot shows the app colour when something is copied', (await page.$eval('#dot', (d) => d.style.backgroundColor)) === 'rgb(29, 155, 209)');
    await page.click('#handle');
    await page.waitForTimeout(50);
    check('pill: a click opens it and says so', await open() && await page.evaluate(() => window.__actions.includes('opened:')));
    check('pill: reports the panel size', await page.evaluate(() => { const s = window.__sizes.at(-1); return s && s.open && s.w === 296 && s.h > 200; }), await page.evaluate(() => JSON.stringify(window.__sizes.at(-1))));
    check('pill: title and where it came from', (await page.textContent('.title')) === 'Morph' && (await page.textContent('.src-title')) === 'Copied from Slack' && (await page.textContent('.sub')).includes('#design-review'));
    check('pill: text from the spec is never HTML', (await page.locator('.panel img').count()) === 0 && (await page.textContent('.recent')).includes('<img'));
    check('pill: bad colours are ignored', await page.evaluate(() => [...document.querySelectorAll('.kdot')].every((d) => /^rgb/.test(d.style.backgroundColor))) && (await page.locator('.option').nth(2).locator('.kdot').count()) === 0);
    check('pill: bad actions are not wired', await page.evaluate(() => { const b = [...document.querySelectorAll('.link')].find((x) => x.textContent === 'Bad'); b.click(); return !window.__actions.some((a) => a.startsWith('rm')); }));
    await page.click('.primary');
    check('pill: the main button sends its action and shows progress at once', await page.evaluate(() => window.__actions.includes('paste:confluence')) && await page.locator('.primary.busy').count() === 1);
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { sub: 'other' })), SPEC);
    check('pill: progress survives a redraw while waiting', await page.locator('.primary.busy').count() === 1);
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { settled: true, primary: { label: '✓ Pasted into Confluence', done: true }, collapseAfterMs: 300 })), SPEC);
    check('pill: the answer replaces the progress', (await page.textContent('.primary .label')) === '✓ Pasted into Confluence' && await page.locator('.primary.done').count() === 1);
    await page.waitForTimeout(450);
    check('pill: tucks itself away after a paste', !(await open()));
    await page.click('#handle');
    await page.locator('.option').first().click();
    check('pill: any format chip works', await page.evaluate(() => window.__actions.includes('fix:slack')));
    const pressed = await page.evaluate(async () => {
      const b = document.querySelector('.option:nth-child(2)');
      return getComputedStyle(b).transitionProperty.includes('transform');
    });
    check('pill: buttons animate when pressed', pressed);
    await page.click('.tuck');
    check('pill: › tucks it away', !(await open()));
    await page.click('#handle');
    await page.click('.x');
    check('pill: ✕ closes it completely', !(await open()) && await page.evaluate(() => window.__actions.includes('hide:')));
    const xInControls = await page.evaluate(() => { const c = document.querySelector('.controls'); return c && c.querySelector('.x') !== null; });
    check('pill: ✕ sits at the screen-side edge (right)', xInControls);
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { side: 'l', theme: 'light', size: 'l' })), SPEC);
    await page.click('#handle');
    check('pill: docked left, ✕ moves to the left edge', await page.evaluate(() => document.querySelector('.controls .x') !== null) && (await page.locator('.tuck svg').count()) === 1);
    check('pill: looks and sizes apply', await page.evaluate(() => { const r = document.getElementById('pill-root'); return r.classList.contains('theme-light') && r.classList.contains('size-l') && document.getElementById('panel').getBoundingClientRect().width === 336; }));
    await page.mouse.move(400, 680);
    await page.waitForTimeout(1700);
    check('pill: tucks away when the mouse leaves for a moment', !(await open()));
    // drag: press on the tab, move, let go
    const hb = await page.locator('#handle').boundingBox();
    await page.mouse.move(hb.x + 5, hb.y + 20);
    await page.mouse.down();
    await page.mouse.move(hb.x + 5, hb.y + 80, { steps: 4 });
    await page.mouse.up();
    check('pill: dragging the tab moves it instead of opening', !(await open()) && await page.evaluate(() => window.__drags[0] === 'start' && window.__drags.includes('move') && window.__drags.at(-1) === 'end'), await page.evaluate(() => JSON.stringify(window.__drags)));
    await page.evaluate(() => window.__fire('toggle'));
    check('pill: the shortcut opens it', await open());
    await page.mouse.move(1000, 690);
    await page.evaluate(() => window.__fire('collapse'));
    check('pill: switching apps tucks it away', !(await open()));
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { openNow: true, settled: true, sub: 'This isn’t one of your apps.', subTone: 'warn' })), SPEC);
    check('pill: the app can open it to say something', await open() && (await page.locator('.sub.warn').count()) === 1);
    // the tab: blank board, scribbled once something's copied
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { openNow: false, dot: 'none', theme: 'sol-light' })), SPEC);
    check('pill: tab board is blank when nothing is copied', await page.evaluate(() => !document.getElementById('pill-root').classList.contains('copied') && getComputedStyle(document.querySelector('.scribble path')).strokeDashoffset !== '0px'));
    await page.evaluate(() => { const t = document.querySelector('.tuck'); if (t && t.offsetParent) t.click(); });
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { openNow: false, dot: 'has', theme: 'sol-light' })), SPEC);
    await page.waitForTimeout(900);
    check('pill: tab board is scribbled once something is copied', await page.evaluate(() => document.getElementById('pill-root').classList.contains('copied') && [...document.querySelectorAll('.scribble path')].every((p) => parseFloat(getComputedStyle(p).strokeDashoffset) === 0)));
    // settings view: sidebar + pane, like the design
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { view: 'settings', title: 'Settings', back: 'view:main', openNow: true, size: 'm', side: 'r',
      nav: [{ label: 'General', icon: 'tune', action: 'view:settings', on: true }, { label: 'Apps', icon: 'grid_view', action: 'view:edit' }],
      pane: { title: 'General', lede: 'x', opts: [{ icon: 'bolt', label: 'Convert automatically', sub: 'y', sw: 'on', action: 'toggle:auto' }],
        apps: [{ label: 'Slack', dest: 'slack', sw: 'on', action: 'dest:slack' }, { label: 'Jira', dest: 'jira', sw: 'on', action: 'dest:jira' }, { label: 'Notion', dest: 'notion', sw: 'on', action: 'dest:notion' }, { label: 'Linear', dest: 'linear', sw: 'off', action: 'dest:linear' }] } })), SPEC);
    check('pill settings: wider panel with a sidebar', await page.evaluate(() => document.getElementById('panel').getBoundingClientRect().width === 460) && (await page.locator('.navitem').count()) === 2 && (await page.locator('.navitem.on').textContent()) === 'General');
    await page.locator('.navitem').nth(1).click();
    check('pill settings: the sidebar switches pane', await page.evaluate(() => window.__actions.at(-1) === 'view:edit'));
    await page.click('.opt');
    check('pill settings: a switch row sends its action', await page.evaluate(() => window.__actions.at(-1) === 'toggle:auto') && (await page.locator('.opt .sw.on').count()) === 1);
    {
      const rows = page.locator('.applist').first().locator('.app-row');
      const a = await rows.nth(0).boundingBox();
      const c = await rows.nth(2).boundingBox();
      await page.mouse.move(a.x + 60, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 60, a.y + 20, { steps: 3 });
      await page.mouse.move(c.x + 60, c.y + c.height / 2, { steps: 6 });
      check('pill settings: a dragged row shows where it lands', (await page.locator('.applist').first().locator('.app-row .name').allTextContents()).join() === 'Jira,Notion,Slack');
      await page.mouse.up();
      check('pill settings: dropping moves the app', await page.evaluate(() => window.__actions.at(-1) === 'dput:0t2'), await page.evaluate(() => window.__actions.slice(-3).join()));
    }
    check('pill settings: hidden apps are listed apart, with a switch', (await page.locator('.applist').nth(1).locator('.app-row').count()) === 1);
    await page.locator('.applist').nth(1).locator('.swbtn').click();
    check('pill settings: switching a hidden app on sends it', await page.evaluate(() => window.__actions.at(-1) === 'dest:linear'));
    // the next row makes way once the held row covers half of it
    {
      const rows = page.locator('.applist').first().locator('.app-row');
      const a = await rows.nth(0).boundingBox();
      await page.mouse.move(a.x + 60, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 60, a.y + a.height / 2 + a.height * 0.6, { steps: 4 });
      check('pill settings: a row makes way before you reach it', (await page.locator('.applist').first().locator('.app-row .name').allTextContents())[0] === 'Notion', (await page.locator('.applist').first().locator('.app-row .name').allTextContents()).join());
      await page.mouse.up();
    }
    // a long list: holding near the top edge scrolls the pane up
    await page.evaluate((s) => window.__fire('spec', Object.assign({}, s, { view: 'settings', title: 'Settings', back: 'view:main', openNow: true, size: 'm', side: 'r',
      nav: [{ label: 'Apps', icon: 'grid_view', action: 'view:edit', on: true }],
      pane: { title: 'Apps', lede: 'x', apps: Array.from({ length: 12 }, (_x, i) => ({ label: 'App' + i, dest: 'slack', sw: 'on', action: 'dest:slack' })) } })), SPEC);
    {
      await page.evaluate(() => { const c = document.querySelector('.content'); c.scrollTop = c.scrollHeight; });
      const rows = page.locator('.applist').first().locator('.app-row');
      const last = await rows.nth(11).boundingBox();
      const pane = await page.locator('.content').boundingBox();
      await page.mouse.move(last.x + 60, last.y + last.height / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + 60, pane.y + 6, { steps: 8 });
      await page.waitForTimeout(1500);
      check('pill settings: dragging to the top edge scrolls the list up', await page.evaluate(() => document.querySelector('.content').scrollTop === 0));
      await page.mouse.up();
      check('pill settings: and the row lands first', await page.evaluate(() => window.__actions.at(-1) === 'dput:11t0'), await page.evaluate(() => window.__actions.at(-1)));
    }
    await page.click('.back');
    check('pill settings: back returns to the main view', await page.evaluate(() => window.__actions.at(-1) === 'view:main'));
    check('pill: no page errors', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: path.join(__dirname, 'out', 'pill.png') }).catch(() => {});
    await ctx.close();
  }

  // ---------------------------------------------------------- quick mode (app icons on the tab) and Original
  {
    const BASE = { visible: true, theme: 'sol-light', size: 'm', side: 'r', dot: 'has', title: 'Morph', section: 'Copy it for',
      source: { icon: 'content_paste', title: 'Copied from Slack', sub: 'Table, 3 rows' },
      options: [[{ label: 'Jira', dest: 'jira', action: 'fix:jira' }]], links: [] };
    const TAB = [{ label: 'Slack', dest: 'slack', action: 'fix:slack' }, { label: 'Jira', dest: 'jira', action: 'fix:jira' }, { label: 'Confluence', dest: 'confluence', action: 'fix:confluence' }, { label: 'Email', dest: 'email', action: 'fix:email' }, { label: 'Extra', dest: 'text', action: 'fix:text' }];
    const ctx = await browser.newContext({ viewport: { width: 420, height: 700 } });
    await ctx.addInitScript(() => {
      const L = { spec: [], collapse: [], toggle: [] };
      window.__actions = []; window.__sizes = []; window.__drags = [];
      window.pill = { platform: 'linux', action: (a) => window.__actions.push(a), size: (w, h, o) => window.__sizes.push({ w, h, open: o }), drag: (p) => window.__drags.push(p),
        onSpec: (cb) => L.spec.push(cb), onCollapse: (cb) => L.collapse.push(cb), onToggle: (cb) => L.toggle.push(cb) };
      window.__fire = (k, v) => L[k].forEach((cb) => cb(v));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + path.join(__dirname, '..', 'src', 'pill.html'));
    const fire = (s) => page.evaluate((x) => window.__fire('spec', x), s);
    await fire(Object.assign({}, BASE, { tab: [] }));
    await page.waitForTimeout(40);
    check('quick mode: off by default, the tab is the plain clipboard', (await page.locator('.sbtn').count()) === 0 && !(await page.$eval('#handle', (h) => h.classList.contains('has-strip'))));
    await fire(Object.assign({}, BASE, { tab: TAB }));
    await page.waitForTimeout(80);
    check('quick mode: four app icons sit on the closed tab (never more)', (await page.locator('#handle .sbtn').count()) === 4);
    check('quick mode: each icon is a real brand/UI svg, not text', await page.evaluate(() => [...document.querySelectorAll('#handle .sbtn')].every((b) => b.querySelector('svg'))));
    const hb = await page.locator('#handle').boundingBox();
    check('quick mode: the tab grows to fit them and stays on screen', hb.height > 120 && hb.height < 200 && hb.width === 28, JSON.stringify(hb));
    check('quick mode: the window is told the taller tab size', await page.evaluate(() => { const s = window.__sizes.at(-1); return s && !s.open && s.h > 120; }), await page.evaluate(() => JSON.stringify(window.__sizes.at(-1))));
    await page.locator('#handle .sbtn').nth(1).click();
    await page.waitForTimeout(40);
    check('quick mode: one click converts and does not open the panel', await page.evaluate(() => window.__actions.includes('fix:jira')) && (await page.getAttribute('#pill-root', 'data-open')) === 'false' && await page.evaluate(() => !window.__actions.includes('opened:')));
    check('quick mode: a click on an icon never starts a drag', await page.evaluate(() => window.__drags.length === 0));
    await fire(Object.assign({}, BASE, { tab: [{ label: 'Slack', dest: 'slack', done: true }, TAB[1], TAB[2], TAB[3]] }));
    await page.waitForTimeout(40);
    check('quick mode: a finished one shows a check and cannot be clicked', (await page.locator('#handle .sbtn.done').count()) === 1 && await page.$eval('#handle .sbtn.done', (b) => b.disabled && !!b.querySelector('svg')));
    await page.locator('#handle .scribble').first().waitFor({ state: 'attached' });
    await page.click('#handle', { position: { x: 14, y: 12 } });
    await page.waitForTimeout(40);
    check('quick mode: the clipboard part of the tab still opens the panel', (await page.getAttribute('#pill-root', 'data-open')) === 'true');
    // Original
    await fire(Object.assign({}, BASE, { tab: [], original: { label: 'Original', hint: 'as copied', action: 'orig:', busy: 'Restoring…' } }));
    await page.waitForTimeout(40);
    check('original: a row at the end of the app list', (await page.locator('.list .row.original').count()) === 1 && (await page.textContent('.row.original .label')) === 'Original');
    await page.click('.row.original');
    await page.waitForTimeout(40);
    check('original: it sends orig: and shows progress', await page.evaluate(() => window.__actions.includes('orig:')) && await page.locator('.row.original.busy').count() === 1);
    await fire(Object.assign({}, BASE, { tab: [], options: [], original: null }));
    await page.waitForTimeout(40);
    check('original: nothing copied means no Original row', (await page.locator('.row.original').count()) === 0);
    // source card: the app's own logo; Original turns into a tick
    await fire(Object.assign({}, BASE, { tab: [], source: { icon: 'table', dest: 'slack', title: 'Copied from Slack', sub: '#x' }, original: { label: 'Original', done: true } }));
    await page.waitForTimeout(40);
    check('source card: shows the app logo when the app is known', (await page.locator('.source .stile.logo svg').count()) === 1);
    check('original: after restoring the row is a tick, not a message', (await page.locator('.row.original.done').count()) === 1 && (await page.locator('.msg').count()) === 0);
    await fire(Object.assign({}, BASE, { tab: [], source: { icon: 'table', dest: '', title: 'Copied', sub: '' } }));
    await page.waitForTimeout(40);
    check('source card: falls back to the plain glyph', (await page.locator('.source .stile.logo').count()) === 0 && (await page.locator('.source svg').count()) >= 1);
    // Small shows fewer rows and scrolls the rest
    const MANY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => [{ label: 'App ' + i, dest: 'slack', action: 'fix:slack' }]);
    await fire(Object.assign({}, BASE, { size: 's', tab: [], options: MANY, original: null }));
    await page.waitForTimeout(80);
    check('small: the list is capped and scrolls', await page.evaluate(() => { const b = document.querySelector('.body'); return b.clientHeight <= 252 && b.scrollHeight > b.clientHeight + 20; }), await page.evaluate(() => { const b = document.querySelector('.body'); return b.clientHeight + '/' + b.scrollHeight; }));
    await fire(Object.assign({}, BASE, { size: 'l', tab: [], options: MANY, original: null }));
    await page.waitForTimeout(80);
    check('large: a taller cap than small', await page.evaluate(() => { const b = document.querySelector('.body'); return b.clientHeight > 330 && b.clientHeight <= 422; }), await page.evaluate(() => document.querySelector('.body').clientHeight));
    await fire(Object.assign({}, BASE, { size: 'm', tab: [], options: [[{ label: 'Jira', dest: 'jira', action: 'fix:jira' }]], original: null }));
    await page.waitForTimeout(60);
    // nothing copied: apps are shown but inert (no "couldn't convert")
    await fire(Object.assign({}, BASE, { tab: [{ label: 'Slack', dest: 'slack', off: true }, { label: 'Jira', dest: 'jira', off: true }], options: [[{ label: 'Slack', dest: 'slack', off: true }, { label: 'Jira', dest: 'jira', off: true }]], original: null }));
    await page.waitForTimeout(60);
    await page.mouse.move(410, 690); // away from the pill, or a collapse is politely ignored
    await page.evaluate(() => { window.__actions.length = 0; window.__fire('collapse'); });
    await page.waitForFunction(() => document.getElementById('pill-root').dataset.open === 'false', null, { timeout: 8000 });
    await page.waitForTimeout(80);
    await page.locator('#handle .sbtn').first().click({ force: true }).catch(() => {});
    check('nothing copied: tab icons are dimmed and do nothing', (await page.locator('#handle .sbtn.off').count()) === 2 && await page.evaluate(() => !window.__actions.some((a) => a.startsWith('fix:'))));
    await page.click('#handle', { position: { x: 14, y: 12 }, timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('pill-root').dataset.open === 'true');
    await page.waitForTimeout(60);
    await page.locator('.list .row.off').first().click({ force: true }).catch(() => {});
    check('nothing copied: app rows are dimmed and do nothing', (await page.locator('.list .row.off').count()) === 2 && await page.evaluate(() => !window.__actions.some((a) => a.startsWith('fix:'))));
    await page.screenshot({ path: require('path').join(__dirname, 'out', 'pill-main.png') }).catch(() => {});
    check('quick mode: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }


  // ---------------------------------------------------------- the Apps panel
  {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 720 } });
    await ctx.addInitScript(() => {
      window.__saved = [];
      const settings = {
        rules: [
          { id: 'slack', name: 'Slack', dest: 'slack', app: 'slack', title: '- Slack', enabled: true },
          { id: 'jira', name: 'Jira', dest: 'jira', app: '', title: 'Jira', enabled: true },
        ],
        pillEnabled: true, pillMode: 'apps',
        canTheme: true, theme: 'sol-light', themes: [{ id: 'sol-light', name: 'Light' }, { id: 'sol-dark', name: 'Dark' }],
        size: 'm', sizes: [{ id: 's', name: 'Small' }, { id: 'm', name: 'Medium' }, { id: 'l', name: 'Large' }],
        shortcuts: [
          { id: 'paste', name: 'Paste, fixed', accel: '<Control><Alt>v', label: 'Ctrl Alt V', on: true, taken: false },
          { id: 'pill', name: 'Open or close the pill', accel: '<Control><Alt>f', label: 'Ctrl Alt F', on: true, taken: true },
        ],
        pillDests: ['slack', 'jira'],
        detection: { provider: 'gnome', status: 'unavailable' },
        current: { app: 'Google-chrome', title: 'Board - Jira - Google Chrome' },
      };
      window.bridge = {
        platform: 'linux',
        info: async () => ({ version: '0.3.0', shortcut: null, platform: 'linux', companion: true }),
        readClipboard: async () => ({ formats: [], text: '', html: '', rtf: '', image: null, others: [] }),
        writeClipboard: async () => true,
        onShown() {}, onClipboardChange() {}, onQuickConvert() {}, hide() {}, setTrayStatus() {}, quickDone() {},
        onSelect() {}, onApps() {},
        getSettings: async () => JSON.parse(JSON.stringify(settings)),
        setSettings: async (n) => { window.__saved.push(JSON.parse(JSON.stringify(n))); if (n.shortcuts) settings.shortcuts = JSON.parse(JSON.stringify(n.shortcuts)).map((k) => Object.assign({}, settings.shortcuts.find((o) => o.id === k.id) || {}, k, { label: k.accel ? k.accel.replace(/<Control>/, 'Ctrl ').replace(/<Shift>/, 'Shift ').replace(/<Alt>/, 'Alt ').replace(/([a-z])$/, (m) => m.toUpperCase()).trim() : '' })); return true; },
      };
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE + '?mode=companion');
    await page.click('#apps-btn');
    await page.waitForTimeout(150);
    check('apps: panel opens over the popover', await page.locator('#apps-panel').isVisible() && await page.locator('.cols').isHidden());
    check('apps: explains when the GNOME helper is missing', (await page.textContent('#apps-detect')).includes('GNOME helper'));
    check('apps: lists the rules', (await page.locator('#rules li').count()) === 2);
    check('apps: shows the window that was in front', (await page.textContent('#current-win')).includes('Board - Jira'));
    await page.locator('#rules li').nth(0).locator('input[type=checkbox]').uncheck();
    check('apps: turning a rule off saves it', await page.evaluate(() => window.__saved.at(-1).rules[0].enabled === false));
    await page.locator('#rules li').nth(1).locator('select').selectOption('confluence');
    check('apps: changing the destination saves it', await page.evaluate(() => window.__saved.at(-1).rules[1].dest === 'confluence'));
    await page.fill('#add-name', 'Notion');
    await page.fill('#add-title', 'Notion');
    await page.selectOption('#add-dest', 'markdown');
    await page.click('#add-rule button[type=submit]');
    check('apps: adding an app saves it', await page.evaluate(() => { const r = window.__saved.at(-1).rules; return r.length === 3 && r[2].name === 'Notion' && r[2].title === 'Notion'; }));
    await page.click('input[name="pill-mode"][value="always"]');
    check('apps: switching to every app saves it', await page.evaluate(() => window.__saved.at(-1).pillMode === 'always'));
    await page.locator('#rules li').nth(2).locator('.del').click();
    check('apps: removing an app saves it', await page.evaluate(() => window.__saved.at(-1).rules.length === 2));
    // Apps pane: reorder (arrows and drag) and select
    const panelBox = await page.evaluate(() => { const r = document.querySelector('#spanes').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    await page.click('#nav-apps');
    check('settings: Apps lists every format with the enabled ones first, in order', (await page.locator('#pill-dests .drow').count()) === 10 && (await page.locator('#pill-dests .drow .dname').allTextContents()).slice(0, 2).join() === 'Slack,Jira');
    check('settings: the Apps pane keeps the same size', await page.evaluate(() => { const r = document.querySelector('#spanes').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }).then((b) => b.join() === panelBox.join()));
    check('settings: the scrollbar is hidden', await page.evaluate(() => getComputedStyle(document.querySelector('#spanes'), '::-webkit-scrollbar').display === 'none'));
    check('settings: app marks come from the icon set', (await page.locator('#pill-dests .dtile svg').count()) === 10);
    await page.locator('#pill-dests .drow').nth(0).locator('button[aria-label="Move Slack down"]').click();
    check('settings: moving an app down saves the new order', await page.evaluate(() => { const o = window.__saved.at(-1).pillDestsOrder; return o && o.join() === 'jira,slack'; }));
    await page.locator('#pill-dests .drow').nth(1).dragTo(page.locator('#pill-dests .drow').nth(0));
    check('settings: dragging a row reorders', (await page.locator('#pill-dests .drow .dname').allTextContents()).slice(0, 2).join() === 'Slack,Jira');
    await page.locator('#pill-dests .drow').nth(3).locator('input[type=checkbox]').click();
    check('settings: selecting an app adds it to the pill list', await page.evaluate(() => window.__saved.at(-1).pillDests.length === 3));
    await page.click('#nav-size');
    await page.click('#size-cards [data-id="l"]');
    check('settings: size is saved', await page.evaluate(() => window.__saved.at(-1).size === 'l'));
    await page.click('#nav-look');
    await page.click('#theme-cards [data-id="sol-dark"]');
    check('settings: look is saved', await page.evaluate(() => window.__saved.at(-1).theme === 'sol-dark'));
    check('settings: the window follows the look', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
    await page.click('#nav-about');
    check('settings: About carries the trademark note', (await page.textContent('#spane-about')).includes('not affiliated'));
    await page.click('#nav-keys');
    check('settings: shortcuts are listed with their keys', (await page.locator('#keys li').count()) === 2 && (await page.textContent('#keys li:nth-child(1) .kbtn')) === 'Ctrl Alt V');
    check('settings: a shortcut GNOME refused says so', (await page.textContent('#keys li:nth-child(2) .ktaken')).includes('taken'));
    await page.locator('#keys li').nth(0).locator('input[type=checkbox]').uncheck();
    check('settings: turning a shortcut off saves it', await page.evaluate(() => window.__saved.at(-1).shortcuts[0].on === false));
    await page.click('#keys li:nth-child(1) .kbtn');
    await page.keyboard.press('k');
    check('settings: a plain letter is not accepted as a shortcut', (await page.textContent('#keys li:nth-child(1) .kbtn')) === 'Press keys…');
    await page.keyboard.press('Control+Alt+F');
    check('settings: keys used by another shortcut are refused', (await page.textContent('#keys li:nth-child(1) .kbtn')).includes('Used by'));
    await page.keyboard.press('Control+Shift+K');
    check('settings: recording a new key saves it and turns it on', await page.evaluate(() => { const k = window.__saved.at(-1).shortcuts[0]; return k.accel === '<Control><Shift>k' && k.on === true; }));
    check('settings: shown in readable form', (await page.textContent('#keys li:nth-child(1) .kbtn')) === 'Ctrl Shift K');
    await page.keyboard.press('Escape');
    check('apps: Esc closes the panel, not the popover', await page.locator('#apps-panel').isHidden() && await page.locator('.cols').isVisible());
    check('apps: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------- shell
  {
    const ctx = await browser.newContext({ viewport: { width: 1240, height: 840 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE);
    check('shell: ten destinations', (await page.locator('.dest').count()) === 10);
    check('shell: copy disabled when empty', await page.locator('#copy-btn').isDisabled());
    check('shell: read button hidden in browser mode', await page.locator('#read-btn').isHidden());
    await page.keyboard.press('4');
    check('shell: number keys pick a destination', (await page.getAttribute('body', 'data-dest')) === 'email');
    await page.setViewportSize({ width: 375, height: 800 });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check('shell: no sideways scroll at phone width', sw <= 375, 'scrollWidth ' + sw);
    check('shell: no errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (app)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL app tests crashed: ' + e.message); process.exit(1); });
