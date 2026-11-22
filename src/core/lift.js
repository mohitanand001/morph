(function () {
// Finds structure that arrived as plain text and gives it its real type:
//
// - Text tables (Slack posts markdown tables as raw "| a | b |" lines, and
//   people paste psql/mysql output or our own aligned Slack tables inside
//   code blocks) become real table nodes, so Jira, Docs and GitHub get real
//   tables instead of monospace text.
// - Runs of monospace paragraphs (Google Docs code, some editors) become
//   one code block.
window.FB = window.FB || {};

// Header separator: ---|---   | --- | :---: |   ---+---
const SEP = /^\s*\|?\s*:?-+:?\s*(?:[|+]\s*:?-+:?\s*)+\|?\s*$/;
const BORDER_ONLY = /^[\s+\-=┌┐└┘├┤┬┴┼─═╔╗╚╝╠╣╦╩╬╪╫]+$/;
const BORDER_MARK = /[+┌┐└┘├┤┬┴┼─═╔╗╚╝╠╣╦╩╬╪╫]/;
const FOOTER = /^\(\d+ rows?\)$/;
const TEXTY_LANG = /^(|text|txt|plain|plaintext|console|output|table|ascii|log)$/i;

const nb = (line) => String(line).replace(/[│║┃]/g, '|');
const isBorder = (line) => BORDER_ONLY.test(line) && BORDER_MARK.test(line);

function splitCells(line) {
  let s = nb(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// Parse a block of lines that is entirely a table. Returns a table node or null.
FB.parseTextTable = function parseTextTable(text) {
  let lines = String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\r\n?/g, '\n').split('\n').map((l) => nb(l).replace(/\s+$/, ''));
  // Blank lines never belong inside a table, but Slack and Docs sometimes
  // put one between every row.
  lines = lines.filter((l) => l.trim());
  while (lines.length && (!lines[lines.length - 1].trim() || FOOTER.test(lines[lines.length - 1].trim()))) lines.pop();
  if (lines.length < 2) return null;

  // Tab-separated (copied from a spreadsheet as plain text).
  if (lines.length >= 2 && !lines.some((l) => l.includes('|')) && lines.every((l) => l.includes('\t') && !/^\s/.test(l))) {
    const split = lines.map((l) => l.split('\t').map((c) => c.trim()));
    const n = split[0].length;
    if (n >= 2 && split.every((r) => r.length === n)) {
      const mk = (t, h) => ({ children: t ? [FB.text(t)] : [], isHeader: !!h });
      return { type: 'table', headerRow: split[0].map((t) => mk(t, true)), rows: split.slice(1).map((r) => r.map((t) => mk(t))) };
    }
  }

  let header;
  let body;
  let align = null;
  if (lines.some(isBorder)) {
    // +----+----+ (mysql) or ┌──┬──┐ (box drawing): borders carry no data.
    lines = lines.filter((l) => !isBorder(l));
    if (lines.length < 2) return null;
    header = lines[0];
    body = lines.slice(1);
  } else {
    if (lines.length < 3 || !SEP.test(lines[1])) return null;
    header = lines[0];
    body = lines.slice(2);
    align = splitCells(lines[1]).map((c) => {
      const l = c.startsWith(':');
      const r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
    });
  }

  if (!body.length) return null;
  if (![header].concat(body).every((l) => l.includes('|'))) return null;

  const headerCells = splitCells(header);
  const cols = headerCells.length;
  if (cols < 2) return null;

  const rows = [];
  for (const l of body) {
    const cells = splitCells(l);
    if (cells.length > cols) return null;
    // A trailing "|" after an empty last cell reads as a closing border.
    while (cells.length < cols) cells.push('');
    rows.push(cells);
  }

  const cell = (t, isHeader) => ({ children: t ? [FB.text(t)] : [], isHeader: !!isHeader });
  return {
    type: 'table',
    align: align || undefined,
    headerRow: headerCells.map((t) => cell(t, true)),
    rows: rows.map((r) => r.map((t) => cell(t))),
  };
};

// Look for a table somewhere inside a list of lines (a paragraph may have
// intro text before it). Returns { start, end, table } or null.
FB.findTextTable = function findTextTable(lines) {
  const L = lines.map(nb);

  for (let s = 1; s < L.length; s++) {
    if (!SEP.test(L[s]) || !L[s - 1].includes('|')) continue;
    let end = s + 1;
    while (end < L.length && L[end].trim() && L[end].includes('|') && !SEP.test(L[end])) end++;
    const table = FB.parseTextTable(L.slice(s - 1, end).join('\n'));
    if (table) return { start: s - 1, end, table };
  }

  const b = L.findIndex(isBorder);
  if (b !== -1) {
    let end = b;
    while (end < L.length && (isBorder(L[end]) || L[end].includes('|'))) end++;
    if (end < L.length && FOOTER.test(L[end].trim())) end++;
    const table = FB.parseTextTable(L.slice(b, end).join('\n'));
    if (table) return { start: b, end, table };
  }

  return null;
};

function paragraphOf(text) {
  const t = text.trim();
  return t ? { type: 'paragraph', children: [FB.text(t)] } : null;
}

function isCodePara(b) {
  if (b.type !== 'paragraph' || !b.children.length) return false;
  let any = false;
  for (const n of b.children) {
    if (n.type === 'text' && n.code) any = true;
    else if (n.type === 'text' && !n.text.trim()) continue;
    else if (n.type === 'hardBreak') continue;
    else return false;
  }
  return any;
}

function codeLine(p) {
  return p.children.map((n) => (n.type === 'hardBreak' ? '\n' : n.text)).join('').replace(/ /g, ' ');
}

function mergeCodeRuns(blocks, stats) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({ type: 'codeBlock', content: run.map(codeLine).join('\n') });
      stats.codeBlocks++;
    } else {
      run.forEach((b) => out.push(b));
    }
    run = [];
  };
  blocks.forEach((b) => {
    if (isCodePara(b)) run.push(b);
    else {
      flush();
      out.push(b);
    }
  });
  flush();
  return out;
}

function liftBlocks(blocks, stats) {
  const out = [];
  (blocks || []).forEach((orig) => {
    let b = orig;

    if ((b.type === 'blockquote' || b.type === 'panel') && b.children) {
      b = Object.assign({}, b, { children: liftBlocks(b.children, stats) });
    }
    if ((b.type === 'bulletList' || b.type === 'orderedList') && b.items) {
      b = Object.assign({}, b, {
        items: b.items.map((it) => Object.assign({}, it, { children: liftBlocks(it.children, stats) })),
      });
    }

    if (b.type === 'codeBlock' && TEXTY_LANG.test(b.language || '')) {
      const table = FB.parseTextTable(b.content);
      if (table) {
        out.push(table);
        stats.tables++;
        return;
      }
    }

    if (b.type === 'paragraph') {
      const text = FB.inlineToPlain(b.children);
      if (text.includes('|') && text.includes('\n')) {
        const lines = text.split('\n');
        const found = FB.findTextTable(lines);
        if (found) {
          const before = paragraphOf(lines.slice(0, found.start).join('\n'));
          const after = paragraphOf(lines.slice(found.end).join('\n'));
          if (before) out.push(before);
          out.push(found.table);
          if (after) out.push(after);
          stats.tables++;
          return;
        }
      }
    }

    out.push(b);
  });
  return mergeCodeRuns(out, stats);
}

FB.liftStructure = function liftStructure(ast) {
  const stats = { tables: 0, codeBlocks: 0 };
  ast.children = liftBlocks(ast.children, stats);
  ast.lifted = stats;
  return ast;
};
})();
