(function (root) {
// How much did Morph actually change? Compares what you copied with what Morph produced, for one destination.
//   untouched  the app is the one it came from (or its twin): left exactly as copied
//   same       nothing to change: the words, markup and layout are the same
//   cleanup    same words and structure, only tidied (styles, wrappers, spacing)
//   converted  something real changed: markup became formatting (or went away), a table or code block was made,
//              prompts or colours were stripped, or the app cannot show a feature and it was swapped for the closest one
// Only measures what Morph changes. Whether an app would have coped with the raw paste by itself needs the real app.
var TOKENS = [/\*\*[^*\n]+\*\*/g, /^#{1,6}\s/gm, /^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, /`[^`\n]+`/g, /^```/gm, /<[@#!][^>\n]*>/g, /<https?:[^>|\n]+\|[^>\n]+>/g,
  /^>[ \t]/gm, /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, /(?:^|\s)_[^_\n]+_(?=\s|$)/g, /(?:^|\s)\*[^*\s][^*\n]*\*(?=\s|$)/g, /\t/g];
function junk(t) { var n = 0; TOKENS.forEach(function (re) { var m = String(t || '').match(re); if (m) n += m.length; }); return n; }
function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
function visible(h) {
  // inline tags vanish; every other tag is a break between words (cells, items, paragraphs)
  return String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<\/?(b|strong|i|em|u|s|del|strike|span|a|code|font|small|sub|sup|mark|abbr)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function words(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9@#]+/g, ' ').trim().split(' ').filter(Boolean); }
function sameWords(a, b) { var x = words(a), y = words(b); return x.length === y.length && x.every(function (w, i) { return w === y[i]; }); }
function verdict(clip, run, notes) {
  var out = (run && run.out) || { html: '', text: '' }, why = [];
  if (run && run.passthrough) return { level: 'untouched', why: ['It already came from this kind of app, so it is pasted exactly as copied.'] };
  var hasHtml = !!(clip.html && clip.html.trim());
  var repairs = (run && run.repairs) || [];
  var outVis = out.html ? visible(out.html) : out.text;
  if (!hasHtml) {
    if (!out.html && norm(out.text).replace(/ /g, '') === norm(clip.text).replace(/ /g, '')) return { level: 'same', why: ['Nothing to change: it already reads the same in this app.'] };
    var b = junk(clip.text), a = junk(outVis);
    if (b > a) why.push('Turns ' + (b - a) + ' markup symbol' + (b - a === 1 ? '' : 's') + ' (such as stars, hashes, pipes, backticks or tabs) into real formatting.');
    if (out.html && /<table/i.test(out.html) && !/\|/.test(outVis)) why.push('Builds a real table.');
    if (/<pre/i.test(out.html || '') || (!out.html && /^```/m.test(out.text) && !/^```/m.test(clip.text))) why.push('Keeps it in a code block, so spacing and indentation survive.');
    repairs.forEach(function (r) { if (why.indexOf(r) < 0) why.push(r); });
    return why.length ? { level: 'converted', why: why } : { level: 'cleanup', why: ['Same words and layout, spacing tidied.'] };
  }
  // The clipboard carries formatting.
  if (!out.html) { why.push('This app takes ' + (/^```|^#|\*\*/m.test(out.text) ? 'markdown' : 'plain text') + ', so the formatting is rewritten as that.'); return { level: 'converted', why: why }; }
  repairs.forEach(function (r) { why.push(r); });
  (notes || []).forEach(function (n) { why.push(n); });
  if (!sameWords(visible(clip.html), outVis)) return { level: 'converted', why: why.length ? why : ['The wording or layout changes.'] };
  return why.length ? { level: 'converted', why: why } : { level: 'cleanup', why: ['Same words and structure. Only the source app\'s styling and wrappers are tidied.'] };
}
var api = { verdict: verdict, junk: junk };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FBV = api;
})(typeof window !== 'undefined' ? window : this);
