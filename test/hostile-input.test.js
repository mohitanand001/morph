// Hostile clipboard content. What you copy can come from any web page, so the converter must never hang, crash, or
// carry a script, an event handler or a javascript: link into what it writes for another app.
'use strict';
const fs = require('fs');
const path = require('path');
globalThis.window = globalThis;
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
[...html.matchAll(/<script src="(core\/[^"]+)"><\/script>/g)].forEach((m) => require(path.join(__dirname, '..', 'src', m[1])));
const FB = globalThis.FB;

let passed = 0, failed = 0;
const check = (name, ok, why) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + name + (why ? '  (' + why + ')' : '')); } };
const DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
const LIMIT_MS = 1500; // per conversion; a normal copy takes a few milliseconds

const rep = (s, n) => s.repeat(n);
const CASES = {
  // ReDoS shapes: long runs the regular expressions might backtrack over
  'table separator lookalike': { text: '|' + rep(' -', 20000) + 'x\n|a|b|\n' + rep('| - ', 5000) + '!' },
  'pipes and spaces': { text: rep('|   ', 30000) + '\n' + rep('-   |', 30000) },
  'emphasis runs': { text: rep('*', 50000) + 'a' + rep('_', 50000) },
  'backtick runs': { text: rep('`', 40000) + 'code' + rep('`', 39999) },
  'fence lookalikes': { text: rep('```\n', 5000) + rep('~', 20000) },
  'link brackets': { text: rep('[', 30000) + rep('](', 30000) + rep(')', 30000) },
  'html angle soup': { text: rep('<', 50000), html: rep('<a', 30000) },
  'unclosed tags': { text: 'x', html: rep('<b><i><u>', 20000) + 'text' },
  'deep nesting': { text: 'x', html: rep('<div>', 60000) + 'deep' + rep('</div>', 60000) },
  'deep lists': { text: 'x', html: rep('<ul><li>', 20000) + 'item' + rep('</li></ul>', 20000) },
  'huge table': { text: 'x', html: '<table>' + rep('<tr>' + rep('<td>cell</td>', 60) + '</tr>', 2000) + '</table>' },
  'long single line': { text: rep('word ', 400000) },
  'many lines': { text: rep('line\n', 300000) },
  'terminal prompt lookalike': { text: rep('user@host:~$ ', 20000) + '\n' + rep('$ ls\n', 20000) },
  'mention lookalikes': { text: rep('@', 50000) + rep('@a.b ', 20000) },
  'null and control chars': { text: 'a\u0000b\u0001c‮' + rep('​', 50000) + 'd', html: '<p>a\u0000b</p>' },
  'surrogates': { text: rep('\ud83d', 20000) + rep('😀', 20000) },
  // Script smuggling: none of this may survive into another app's clipboard
  'script tag': { text: 'hello', html: '<p>hello</p><script>alert(1)</script><img src=x onerror="alert(1)">' },
  'javascript link': { text: 'click', html: '<a href="javascript:alert(document.cookie)">click</a> <a href=" JaVaScRiPt:alert(1)">two</a> <a href="vbscript:x">three</a>' },
  'data html link': { text: 'click', html: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>' },
  'event handlers': { text: 'x', html: '<div onclick="alert(1)" onmouseover=alert(2)><b onload="x()">bold</b></div><svg onload="alert(1)"><circle/></svg>' },
  'style and iframes': { text: 'x', html: '<style>*{display:none}</style><iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y"><p>ok</p>' },
  'markdown javascript link': { text: '[click](javascript:alert(1)) and ![img](javascript:alert(2)) and <javascript:alert(3)>' },
  'form and meta': { text: 'x', html: '<form action="https://evil.example"><input name="p"></form><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">' },
};

const DANGER = /<script\b|<iframe\b|<object\b|<embed\b|<form\b|<meta\b[^>]*refresh|<base\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)|\]\(\s*javascript:/i;

for (const [name, clip] of Object.entries(CASES)) {
  for (const dest of DESTS) {
    const t0 = Date.now();
    let r, err = null;
    try { r = FB.engine.run({ text: clip.text || '', html: clip.html || '' }, dest); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    if (ms > LIMIT_MS) check(name + ' → ' + dest + ' finishes quickly', false, ms + ' ms');
    if (err) { check(name + ' → ' + dest + ' does not crash', false, String(err && err.message).slice(0, 120)); continue; }
    const out = r && r.out ? (r.out.html || '') + '\n' + (r.out.text || '') : '';
    if (/script|javascript|onerror|onclick|onload|iframe|object|embed|style|form|meta|base|data html|event|markdown javascript/.test(name)) {
      check(name + ' → ' + dest + ' carries no script, handler or javascript: link', !DANGER.test(out), (out.match(DANGER) || [''])[0]);
    }
    passed++;
  }
}
// The link check itself
for (const [u, ok] of [['https://example.com', true], ['HTTP://EXAMPLE.COM', true], ['mailto:a@b.c', true], ['tel:+1555', true], ['/relative/path', true], ['#top', true], ['www.example.com', true],
  ['javascript:alert(1)', false], [' JaVaScRiPt:alert(1)', false], ['java\tscript:alert(1)', false], ['java\u200bscript:x', false], ['\u0000javascript:x', false], ['vbscript:x', false], ['data:text/html,<b>', false], ['file:///etc/passwd', false], ['slack://open', false]]) {
  check('link ' + JSON.stringify(u) + (ok ? ' is kept' : ' is dropped'), FB.safeUrl(u) === ok);
}
check('images: only from the web', FB.safeUrl('https://x/y.png', true) && !FB.safeUrl('data:image/svg+xml,<svg onload=x>', true) && !FB.safeUrl('javascript:x', true));
// The PDF goes through the same engine and draws text itself: it never fetches what a copy links to.
{
  const pdfSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'pdf.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'daemon', 'pdf-doc.js'), 'utf8');
  check('the PDF maker never fetches anything (no http, no file loading by URL)', !/Soup|fetch\(|new_for_uri|https?:\/\/(?!www\.w3\.org)/.test(pdfSrc));
}
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (hostile input)');
process.exit(failed ? 1 : 0);
