// Draws the page items from pdf-doc.js into an A4 PDF with Cairo and Pango, both already part of
// GNOME. No browser, no extra packages. Runs under GJS only.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const PAGE = { w: 595.28, h: 841.89 };
const M = 43; // 0.6 inch margins, like before
const SCALE = Pango.SCALE;
const INK = [0.114, 0.122, 0.137];

const rgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const stripTags = (m) => String(m).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function makeLayout(cr, markup, size, width, mono) {
  const ctx = PangoCairo.create_context(cr);
  PangoCairo.context_set_resolution(ctx, 72); // points on the page, not screen pixels
  const l = Pango.Layout.new(ctx);
  l.set_font_description(Pango.FontDescription.from_string((mono ? 'Monospace ' : 'Sans ') + size));
  l.set_width(Math.max(10, Math.floor(width * SCALE)));
  l.set_wrap(Pango.WrapMode.WORD_CHAR);
  try { Pango.parse_markup(markup, -1, '\0'); l.set_markup(markup, -1); } catch (e) { l.set_text(stripTags(markup), -1); }
  return l;
}
function lineRanges(l) {
  const out = [];
  const it = l.get_iter();
  do { const r = it.get_line_yrange(); out.push([r[0] / SCALE, r[1] / SCALE]); } while (it.next_line());
  return out;
}

export function renderPdf(items, path) {
  const surface = new Cairo.PDFSurface(path, PAGE.w, PAGE.h);
  const cr = new Cairo.Context(surface);
  const W = PAGE.w - 2 * M;
  const top = M;
  const bottom = PAGE.h - M;
  let y = top;
  const newPage = () => { cr.showPage(); y = top; };
  const color = (c) => cr.setSourceRGB(c[0], c[1], c[2]);

  function drawText(it) {
    const mono = it.kind === 'code';
    const pad = mono ? 6 : it.bg ? 5 : 0;
    const quote = it.quote ? 12 : 0;
    const x = M + (it.indent || 0) + quote;
    const boxX = x - (it.mark ? 14 : 0);
    const textX = x + pad;
    const width = W - (it.indent || 0) - quote - 2 * pad;
    const l = makeLayout(cr, it.markup || ' ', it.size || 11, width, mono);
    const lines = lineRanges(l);
    if (y > top) y += it.before || 0;
    if (it.keepNext && bottom - y < 70) newPage();
    let i = 0;
    while (i < lines.length) {
      const avail = bottom - y - 2 * pad;
      let j = i;
      while (j < lines.length && lines[j][1] - lines[i][0] <= avail) j++;
      if (j === i) { if (y > top + 1) { newPage(); continue; } j = i + 1; }
      const h = lines[j - 1][1] - lines[i][0];
      if (mono || it.bg) {
        color(rgb(mono ? '#f3f4f6' : it.bg));
        cr.rectangle(boxX, y, width + 2 * pad + (it.mark ? 14 : 0), h + 2 * pad);
        cr.fill();
      }
      if (it.quote) { color(rgb('#d0d7de')); cr.rectangle(M + (it.indent || 0), y, 3, h + 2 * pad); cr.fill(); }
      cr.save();
      cr.rectangle(boxX, y + pad - 0.5, width + 2 * pad + 20, h + 1);
      cr.clip();
      color(it.quote ? rgb('#57606a') : INK);
      cr.moveTo(textX, y + pad - lines[i][0]);
      PangoCairo.show_layout(cr, l);
      cr.restore();
      if (it.mark && i === 0) {
        const ml = makeLayout(cr, it.mark, it.size || 11, 20, false);
        color(INK);
        cr.moveTo(x - 14, y + pad);
        PangoCairo.show_layout(cr, ml);
      }
      y += h + 2 * pad;
      i = j;
      if (i < lines.length) newPage();
    }
    y += it.after || 0;
  }

  function drawTable(it) {
    const cols = Math.max(it.head.length, ...it.rows.map((r) => r.length), 1);
    const x0 = M + (it.indent || 0);
    const avail = W - (it.indent || 0);
    const weights = [];
    for (let c = 0; c < cols; c++) {
      const cells = [it.head[c]].concat(it.rows.map((r) => r[c])).filter((v) => v != null);
      weights.push(Math.min(40, Math.max(6, ...cells.map((m) => stripTags(m).length))));
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.max(48, avail * w / sum));
    const scale = avail / widths.reduce((a, b) => a + b, 0);
    for (let c = 0; c < cols; c++) widths[c] *= scale;
    const pad = 4;
    const rowsAll = (it.head.length ? [{ cells: it.head, head: true }] : []).concat(it.rows.map((r) => ({ cells: r, head: false })));
    if (y > top) y += it.before || 0;
    rowsAll.forEach((row) => {
      const ls = [];
      let h = 0;
      for (let c = 0; c < cols; c++) {
        const m = row.cells[c] || ' ';
        const l = makeLayout(cr, row.head ? '<b>' + m + '</b>' : m, it.size, widths[c] - 2 * pad, false);
        ls.push(l);
        h = Math.max(h, l.get_size()[1] / SCALE);
      }
      h += 2 * pad;
      if (y + h > bottom && y > top + 1) newPage();
      h = Math.min(h, bottom - y);
      let x = x0;
      for (let c = 0; c < cols; c++) {
        if (row.head) { color(rgb('#f3f4f6')); cr.rectangle(x, y, widths[c], h); cr.fill(); }
        color(rgb('#c9d1d9'));
        cr.setLineWidth(0.6);
        cr.rectangle(x, y, widths[c], h);
        cr.stroke();
        cr.save();
        cr.rectangle(x, y, widths[c], h);
        cr.clip();
        color(INK);
        cr.moveTo(x + pad, y + pad);
        PangoCairo.show_layout(cr, ls[c]);
        cr.restore();
        x += widths[c];
      }
      y += h;
    });
    y += it.after || 0;
  }

  try {
    items.forEach((it) => {
      if (it.kind === 'text' || it.kind === 'code') drawText(it);
      else if (it.kind === 'table') drawTable(it);
      else if (it.kind === 'rule') {
        if (y > top) y += it.before || 0;
        if (y > bottom - 10) newPage();
        color(rgb('#d0d7de'));
        cr.setLineWidth(0.8);
        cr.moveTo(M, y); cr.lineTo(M + W, y); cr.stroke();
        y += it.after || 0;
      } else if (it.kind === 'gap') y += it.h || 0;
    });
    cr.showPage();
  } finally {
    surface.finish();
    cr.$dispose();
  }
}
