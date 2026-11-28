// The Morph Lab report: one page with every scenario, its steps, screenshots and checks.
'use strict';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html(results, ms) {
  const bad = results.filter((r) => !r.ok).length;
  const rows = results.map((r, i) => {
    const steps = r.steps.map((s) => {
      if (s.kind === 'shot') return s.file ? `<figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}" alt="${esc(s.caption)}"></a><figcaption>${esc(s.caption)}</figcaption></figure>` : `<p class="warn">Screenshot "${esc(s.caption)}" failed: ${esc(s.error)}</p>`;
      if (s.kind === 'known') return `<p class="known">${s.passes ? '✓ Known issue now passes:' : '~ Known issue:'} ${esc(s.name)}${s.why ? `<br><small>${esc(s.why)}</small>` : ''}${s.detail ? `<br><code>${esc(s.detail)}</code>` : ''}</p>`;
      if (s.kind === 'check') return `<p class="${s.ok ? 'pass' : 'fail'}">${s.ok ? '✓' : '✗'} ${esc(s.name)}${s.detail ? `<br><code>${esc(s.detail)}</code>` : ''}</p>`;
      return `<p class="step">${esc(s.text)}</p>`;
    }).join('\n');
    return `<details class="sc ${r.ok ? 'ok' : 'bad'}" ${r.ok ? '' : 'open'} id="s${i}"><summary><span class="dot"></span>${esc(r.name)} <small>${esc(r.file)} · ${(r.ms / 1000).toFixed(1)} s</small></summary>
${r.error ? `<p class="fail">Stopped: <code>${esc(r.error)}</code></p>` : ''}${steps}</details>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Morph Lab report</title><meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--bg:#fdf6e3;--ink:#0a3a45;--soft:#586e75;--line:#ddd3b4;--ok:#5a6e00;--bad:#b5544b;--amber:#946e00}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#10303a;--ink:#e8f1ee;--soft:#9ab5b0;--line:#1f4a55;--ok:#c2d47a;--bad:#e3897f;--amber:#e9c96e;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#10303a;--ink:#e8f1ee;--soft:#9ab5b0;--line:#1f4a55;--ok:#c2d47a;--bad:#e3897f;--amber:#e9c96e;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding-block:24px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1{margin:0 0 4px;font-size:24px}.sum{color:var(--soft);margin:0 0 20px}
.sc{border:1px solid var(--line);border-radius:12px;margin:10px 0;padding:10px 14px}
summary{cursor:pointer;font-weight:700;display:flex;gap:10px;align-items:center}summary small{font-weight:400;color:var(--soft)}
.dot{width:10px;height:10px;border-radius:5px;background:var(--ok);flex:none}.bad .dot{background:var(--bad)}
.step{margin:6px 0;color:var(--soft)}.known{color:var(--amber);margin:4px 0}.pass{color:var(--ok);margin:4px 0}.fail{color:var(--bad);margin:4px 0;font-weight:600}.warn{color:var(--bad)}
code{font-size:12px;word-break:break-word}
figure{margin:10px 0}img{max-width:100%;border:1px solid var(--line);border-radius:8px}figcaption{font-size:13px;color:var(--soft)}
</style></head><body><main>
<h1>Morph Lab</h1>
<p class="sum">${results.length - bad} of ${results.length} scenarios passed · ${results.reduce((n, r) => n + r.checks.filter((c) => !c.known).length, 0)} checks · ${results.reduce((n, r) => n + r.checks.filter((c) => c.known && !c.passes).length, 0)} known issues · ${(ms / 1000).toFixed(0)} s · real GNOME Shell (headless), Morph's real helper and program, stand-in apps on the real clipboard</p>
${rows}
</main></body></html>`;
}
module.exports = { html };
