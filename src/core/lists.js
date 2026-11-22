(function () {
// List and indentation repair.
//
// Lists lose their structure on the way between apps in two ways:
//  1. As text: bullets arrive as glyphs (•, ◦, ▪, –), numbers as "a)" or
//     "iv.", and nesting as whatever mix of tabs and spaces the source used.
//     repairTextLists() rewrites those lines as clean markdown lists with
//     consistent indentation, before the text is parsed.
//  2. As HTML: Outlook and Word send list items as ordinary paragraphs that
//     start with a bullet symbol (the level is only in an mso-list style).
//     repairListParagraphs() turns runs of such paragraphs back into real,
//     nested lists in the AST.
window.FB = window.FB || {};

const GLYPH = '•◦▪▫‣⁃●○■□∙·–—▸►➢✓✔-*+';
const BULLET_RE = new RegExp('^([ \\t\\u00a0]*)([' + GLYPH.replace(/[-\\^\]]/g, '\\$&') + '])[ \\t\\u00a0]+(\\S.*)$');
const ORDERED_RE = /^([ \t ]*)(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})([.)])[ \t ]+(\S.*)$/;
const width = (ws) => ws.replace(/\t/g, '    ').replace(/ /g, ' ').length;

function parseLine(line) {
  const o = line.match(ORDERED_RE);
  // "I think..." or "A. Smith" are sentences, not list items: single
  // letters only count when they are followed by ")" or the line is indented.
  if (o && (/\d/.test(o[2]) || o[3] === ')' || width(o[1]) > 0)) {
    return { indent: width(o[1]), ordered: true, text: o[4] };
  }
  const b = line.match(BULLET_RE);
  // "- " and "* " are already markdown; still normalised for indentation.
  if (b) return { indent: width(b[1]), ordered: false, text: b[3] };
  return null;
}

// Text in, text out. Lines that aren't list items are left exactly as they
// were; code fences are skipped.
FB.repairTextLists = function repairTextLists(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let stack = []; // [{ indent, width }]: source indent -> output marker width
  let changed = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; stack = []; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    const item = parseLine(line);
    if (!item) {
      if (!line.trim()) stack = [];
      out.push(line);
      continue;
    }
    while (stack.length && item.indent < stack[stack.length - 1].indent) stack.pop();
    if (stack.length && item.indent > stack[stack.length - 1].indent) {
      stack.push({ indent: item.indent });
    } else if (!stack.length) {
      stack.push({ indent: item.indent });
    } else {
      stack[stack.length - 1].indent = item.indent;
    }
    // Markdown nests a child under its parent's text, so each level is
    // indented by the width of the parent's marker ("- " = 2, "1. " = 3).
    let pad = '';
    for (let i = 0; i < stack.length - 1; i++) pad += ' '.repeat(stack[i].marker || 2);
    const marker = item.ordered ? '1. ' : '- ';
    stack[stack.length - 1].marker = marker.length;
    const rebuilt = pad + marker + item.text;
    if (rebuilt !== line) changed = true;
    out.push(rebuilt);
  }
  return { text: out.join('\n'), changed };
};

// ---------------------------------------------------------------- AST repair

const PARA_BULLET = new RegExp('^[' + GLYPH.replace(/[-\\^\]]/g, '\\$&') + '§o\\uF0B7\\uF0A7][\\s\\u00a0]+');
const PARA_ORDERED = /^(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)][\s ]+/;

function leadText(p) {
  const first = (p.children || [])[0];
  return first && first.type === 'text' ? first.text : '';
}
function stripLead(p, re) {
  const kids = p.children.slice();
  kids[0] = Object.assign({}, kids[0], { text: kids[0].text.replace(re, '') });
  if (!kids[0].text) kids.shift();
  return kids;
}
function listInfo(p) {
  if (p.type !== 'paragraph') return null;
  const t = leadText(p);
  const level = p.listLevel || 1;
  if (PARA_BULLET.test(t)) return { ordered: false, level, children: stripLead(p, PARA_BULLET) };
  if (PARA_ORDERED.test(t) && (p.listLevel || /^\d/.test(t))) return { ordered: true, level, children: stripLead(p, PARA_ORDERED) };
  return null;
}

// Builds nested lists from a run of {ordered, level, children} entries.
function build(entries, start, level) {
  const ordered = entries[start].ordered;
  const list = { type: ordered ? 'orderedList' : 'bulletList', items: [] };
  if (ordered) list.start = 1;
  let i = start;
  while (i < entries.length && entries[i].level >= level) {
    const e = entries[i];
    if (e.level > level && list.items.length) {
      const [child, next] = build(entries, i, e.level);
      list.items[list.items.length - 1].children.push(child);
      i = next;
      continue;
    }
    if (e.level === level && e.ordered !== ordered && list.items.length) break;
    list.items.push({ children: [{ type: 'paragraph', children: e.children }] });
    i++;
  }
  return [list, i];
}

FB.repairListParagraphs = function repairListParagraphs(ast) {
  let repaired = 0;
  const fix = (blocks) => {
    const out = [];
    let i = 0;
    while (i < blocks.length) {
      const info = listInfo(blocks[i]);
      if (!info) {
        const b = blocks[i];
        if (b.type === 'blockquote' || b.type === 'panel') b.children = fix(b.children || []);
        out.push(b);
        i++;
        continue;
      }
      const run = [];
      while (i < blocks.length && listInfo(blocks[i])) { run.push(listInfo(blocks[i])); i++; }
      // A single bullet-looking line is probably prose ("- see above"),
      // unless Outlook told us it was a list item.
      if (run.length < 2 && !blocks[i - 1].listLevel) { out.push(blocks[i - 1]); continue; }
      const minLevel = Math.min(...run.map((r) => r.level));
      let j = 0;
      while (j < run.length) {
        const [list, next] = build(run, j, minLevel);
        out.push(list);
        j = next;
      }
      repaired += run.length;
    }
    return out;
  };
  ast.children = fix(ast.children || []);
  ast.repairedListItems = repaired;
  return ast;
};
})();
