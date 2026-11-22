(function () {
// Text copied out of a PDF: every visual line ends in a hard line break,
// words are split with hyphens at line ends, bullets are odd characters,
// "fi" may be a single ligature character, and page numbers come along.
// These turn it back into paragraphs and lists (as markdown text).
window.FB = window.FB || {};

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const BULLET = /^\s*([•●▪■◦○‣⁃∙·]|[])\s*/;
const DASH_BULLET = /^\s*[–—]\s+/;
const NUMBERED = /^\s*(\d{1,3}|[a-zA-Z])[.)]\s+/;
const PAGE_NUM = /^\s*(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$/i;
const SENTENCE_END = /[.!?:;"”’)\]]$/;

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Does this plain text look like it was copied from a PDF?
FB.looksLikePdfText = function looksLikePdfText(text) {
  const t = String(text || '');
  if (/[ﬀ-ﬆ]/.test(t) && t.length > 40) return true;
  const lines = t.replace(/\r/g, '').split('\n');
  const full = lines.filter((l) => l.trim());
  if (full.length < 4) return false;
  // Not code, markdown, tables or a terminal.
  if (full.some((l) => /^\s*(```|\||#{1,6}\s|\$ |> |[-*+] \[[ x]\])/.test(l)) || /\t/.test(t)) return false;
  const lens = full.map((l) => l.trim().length);
  const med = median(lens);
  if (med < 35 || med > 130) return false;
  // Lines that stop mid-sentence: no closing punctuation and the next line
  // carries on in lower case, or the line is about as long as the others.
  let wrapped = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    if (!a || !b) continue;
    if (!SENTENCE_END.test(a) && (/^[a-z(]/.test(b) || a.length >= med * 0.8)) wrapped++;
    if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) wrapped++;
  }
  // Blank lines between almost every line means real paragraphs, not wrapping.
  const blanks = lines.length - full.length;
  return wrapped >= Math.max(2, full.length * 0.35) && blanks < full.length * 0.5;
};

FB.repairPdfText = function repairPdfText(text) {
  const stats = { joined: 0, hyphens: 0, ligatures: 0, pages: 0, bullets: 0 };
  let t = String(text || '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => { stats.ligatures++; return LIGATURES[c]; });
  t = t.replace(/­/g, '').replace(/ /g, ' ');

  const lines = t.split('\n');
  const lens = lines.map((l) => l.trim().length).filter((n) => n > 0);
  const med = median(lens) || 80;

  // Classify each line.
  const items = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+/g, ' ').trim();
    if (!line) { items.push({ kind: 'blank' }); continue; }
    if (PAGE_NUM.test(line)) { stats.pages++; continue; }
    if (BULLET.test(line) || DASH_BULLET.test(line)) {
      stats.bullets++;
      items.push({ kind: 'item', marker: '- ', text: line.replace(BULLET, '').replace(DASH_BULLET, '') });
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n && line.length < med * 1.3) { items.push({ kind: 'item', marker: n[1] + '. ', text: line.slice(n[0].length) }); continue; }
    items.push({ kind: 'line', text: line });
  }

  // Join lines into paragraphs (and list items with their wrapped tails).
  const out = [];
  let cur = null; // { marker, text, lastLen }
  const flush = () => { if (cur) out.push((cur.marker || '') + cur.text); cur = null; };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'blank') { flush(); out.push(''); continue; }
    if (it.kind === 'item') {
      if (cur && !cur.marker) { flush(); out.push(''); } else flush();
      cur = { marker: it.marker, text: it.text, lastLen: it.text.length };
      continue;
    }
    if (!cur) { cur = { marker: '', text: it.text, lastLen: it.text.length }; continue; }
    const prev = cur.text;
    // A short line that ends a sentence closes the paragraph; a short line
    // with no punctuation followed by a capital is a heading.
    const shortPrev = cur.lastLen < med * 0.7;
    const startsLower = /^[a-z(,;]/.test(it.text);
    if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(it.text)) {
      cur.text = prev.slice(0, -1) + it.text;
      stats.hyphens++;
    } else if (!startsLower && SENTENCE_END.test(prev) && it.text.length < med * 0.6 && !SENTENCE_END.test(it.text)) {
      // A short line after a finished sentence, itself without punctuation:
      // a heading. Keep it on its own.
      flush();
      out.push('', it.text, '');
      continue;
    } else if (!startsLower && shortPrev) {
      flush();
      out.push('');
      cur = { marker: '', text: it.text, lastLen: it.text.length };
      continue;
    } else {
      cur.text = prev + ' ' + it.text;
    }
    cur.lastLen = it.text.length;
    stats.joined++;
  }
  flush();

  const result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const changes = [];
  if (stats.joined) changes.push('Joined ' + stats.joined + ' broken PDF lines back into paragraphs.');
  if (stats.hyphens) changes.push('Rejoined ' + stats.hyphens + (stats.hyphens === 1 ? ' word' : ' words') + ' split across lines.');
  if (stats.bullets) changes.push('Turned PDF bullet characters into a real list.');
  if (stats.ligatures) changes.push('Replaced ' + stats.ligatures + ' ligature characters (ﬁ → fi).');
  if (stats.pages) changes.push('Removed ' + stats.pages + (stats.pages === 1 ? ' page number.' : ' page numbers.'));
  return { text: result, changes, changed: changes.length > 0 };
};
})();
