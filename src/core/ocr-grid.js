(function () {
// Rebuild a table from words found in a picture and where they sit. The same steps as ocr/morph_ocr.py
// (grid_from_words, strip_sheet_labels, grid_html), so the Mac (macOS's own text recognition) and Linux
// (RapidOCR) turn the same words into the same table. test/ocr-grid.test.js checks both give the same answer.
'use strict';
window.FB = window.FB || {};

// texts: ['Employee Name', …]; boxes: [[x1, y1, x2, y2], …] in pixels, y growing downwards.
// Returns rows of cell strings, or null when the words don't form a grid.
FB.ocrGrid = function ocrGrid(texts, boxes) {
  const items = [];
  for (let i = 0; i < Math.min(texts.length, boxes.length); i++) {
    const t = String(texts[i]).trim();
    const b = boxes[i];
    if (!Array.isArray(b) || b.length < 4) continue;
    const [x1, y1, x2, y2] = b.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (t && x2 > x1 && y2 > y1) items.push({ t, x1, y1, x2, y2, yc: (y1 + y2) / 2 });
  }
  if (items.length < 4) return null;
  const hs = items.map((i) => i.y2 - i.y1).sort((a, b) => a - b);
  const h = hs[Math.floor(hs.length / 2)];
  // Rows: words at the same height.
  let rows = [];
  for (const it of items.slice().sort((a, b) => a.yc - b.yc)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.yc - last.reduce((s, i) => s + i.yc, 0) / last.length) <= 0.5 * h) last.push(it);
    else rows.push([it]);
  }
  const most = Math.max(...rows.map((r) => r.length));
  if (most < 2) return null;
  // Columns: the horizontal ranges of the full rows' words, merged only where they overlap.
  let full = rows.filter((r) => r.length === most);
  if (full.length < 2) full = rows.filter((r) => r.length >= Math.max(2, most - 1));
  const bands = [];
  for (const w of [].concat(...full).sort((a, b) => a.x1 - b.x1)) {
    const last = bands[bands.length - 1];
    if (last && w.x1 < last[1]) last[1] = Math.max(last[1], w.x2);
    else bands.push([w.x1, w.x2]);
  }
  if (bands.length < 2) return null;
  const inside = (w) => {
    const width = w.x2 - w.x1;
    for (let k = 0; k < bands.length; k++) if (Math.min(w.x2, bands[k][1]) - Math.max(w.x1, bands[k][0]) >= 0.6 * width) return k;
    return null;
  };
  const nearest = (w) => {
    const c = (w.x1 + w.x2) / 2;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < bands.length; k++) {
      const d = bands[k][0] <= c && c <= bands[k][1] ? 0 : Math.min(Math.abs(c - bands[k][0]), Math.abs(c - bands[k][1]));
      if (d < bestD) { best = k; bestD = d; }
    }
    return best;
  };
  // The table is the longest run of rows whose words mostly sit inside the columns.
  const fits = rows.map((r) => r.length >= 2 && r.filter((w) => inside(w) !== null).length * 2 > r.length);
  let best = [0, 0], cur = null;
  fits.concat([false]).forEach((ok, i) => {
    if (ok && cur === null) cur = i;
    else if (!ok && cur !== null) { if (i - cur > best[1] - best[0]) best = [cur, i]; cur = null; }
  });
  rows = rows.slice(best[0], best[1]);
  if (rows.length < 2) return null;
  let grid = rows.map((r) => {
    const cells = bands.map(() => []);
    for (const w of r.slice().sort((a, b) => a.x1 - b.x1)) { const k = inside(w); cells[k !== null ? k : nearest(w)].push(w.t); }
    return cells.map((c) => c.join(' '));
  });
  // Columns nobody uses are dropped.
  const keep = bands.map((_, k) => k).filter((k) => grid.some((r) => r[k]));
  grid = grid.map((r) => keep.map((k) => r[k]));
  if (keep.length < 2) return null;
  grid = FB.stripSheetLabels(grid);
  if (grid.length < 2 || grid[0].length < 2) return null;
  const filled = grid.reduce((n, r) => n + r.filter((c) => c).length, 0) / (grid.length * grid[0].length);
  return filled >= 0.6 ? grid : null;
};

// A screenshot of a spreadsheet carries its column letters (A B C) and row numbers (1 2 3): leave them out.
FB.stripSheetLabels = function stripSheetLabels(grid) {
  const first = grid[0].map((c) => c.trim());
  const letters = first.filter((c) => c);
  if (letters.length < 2 || !letters.every((c) => c.length === 1 && /^[A-Z]$/.test(c))) return grid;
  if (!letters.every((c, i) => c.charCodeAt(0) === letters[0].charCodeAt(0) + i)) return grid;
  let body = grid.slice(1);
  const col = body.map((r) => r[0].trim());
  if (!first[0] && col.length && col.every((c) => /^\d+$/.test(c)) && col.every((c, i) => parseInt(c, 10) === parseInt(col[0], 10) + i)) body = body.map((r) => r.slice(1));
  return body;
};

FB.ocrGridHtml = function ocrGridHtml(grid) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = '<tr>' + grid[0].map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>';
  const body = grid.slice(1).map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('');
  return '<table>' + head + body + '</table>';
};
})();
