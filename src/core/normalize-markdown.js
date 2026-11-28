(function () {
// Parses GitHub-flavored markdown (also what Claude, Cursor and ChatGPT put
// on the clipboard from their copy buttons) into the shared AST.
//
// Covers: ATX + setext headings, paragraphs, **bold**/__bold__,
// *italic*/_italic_, ~~strike~~, `code`, links, images, autolinks and bare
// URLs, nested bullet/ordered lists, task lists, block quotes, GitHub
// alerts (> [!NOTE]), fenced code with language, pipe tables, thematic
// breaks, hard breaks, :emoji: shortcodes.
window.FB = window.FB || {};

FB.markdownToAst = function markdownToAst(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return { type: 'doc', children: parseBlocks(lines) };
};

const RE = {
  fence: /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)?.*$/,
  heading: /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
  setext: /^ {0,3}(=+|-+)\s*$/,
};

function isBlank(line) {
  return !line || !line.trim();
}

function startsBlock(line, next) {
  return (
    RE.fence.test(line) && /^(\s*)(`{3,}|~{3,})/.test(line) ||
    RE.heading.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    RE.list.test(line) ||
    (line.includes('|') && next !== undefined && RE.tableSep.test(next) && next.includes('-'))
  );
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const marker = fence[2];
      const lang = fence[3] || undefined;
      const body = [];
      i++;
      while (i < lines.length) {
        const close = new RegExp('^\\s*' + marker[0].replace('`', '\\`') + '{' + marker.length + ',}\\s*$');
        if (close.test(lines[i])) {
          i++;
          break;
        }
        body.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
        i++;
      }
      blocks.push({ type: 'codeBlock', language: lang, content: body.join('\n') });
      continue;
    }

    // ATX heading
    const heading = RE.heading.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: FB.trimInline(parseInline(heading[2] || '')),
      });
      i++;
      continue;
    }

    // Thematic break (checked before lists: "- - -" is a break)
    if (RE.hr.test(line)) {
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
        i++;
      }
      const cell = (t, isHeader) => ({ children: FB.trimInline(parseInline(t)), isHeader: !!isHeader });
      blocks.push({
        type: 'table',
        align,
        headerRow: header.map((t) => cell(t, true)),
        rows: rows.map((r) => r.map((t) => cell(t))),
      });
      continue;
    }

    // Block quote / GitHub alert
    if (RE.quote.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (RE.quote.test(lines[i])) inner.push(lines[i].replace(RE.quote, ''));
        else if (inner.length && !startsBlock(lines[i], lines[i + 1])) inner.push(lines[i]); // lazy continuation
        else break;
        i++;
      }
      const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(inner[0] || '');
      if (alert) {
        blocks.push({
          type: 'panel',
          variant: FB.ALERT_TO_PANEL[alert[1].toUpperCase()],
          children: parseBlocks(inner.slice(1)),
        });
      } else {
        blocks.push({ type: 'blockquote', children: parseBlocks(inner) });
      }
      continue;
    }

    // List
    if (RE.list.test(line)) {
      const res = parseList(lines, i);
      blocks.push(res.block);
      i = res.next;
      continue;
    }

    // Paragraph (+ setext heading)
    const para = [];
    while (i < lines.length && !isBlank(lines[i])) {
      if (para.length && RE.setext.test(lines[i])) {
        const level = lines[i].trim()[0] === '=' ? 1 : 2;
        blocks.push({ type: 'heading', level, children: FB.trimInline(parseInline(para.join('\n'))) });
        para.length = 0;
        i++;
        break;
      }
      if (para.length && startsBlock(lines[i], lines[i + 1])) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      const inline = FB.trimInline(parseInline(para.map((l) => l.replace(/^\s+/, '')).join('\n')));
      if (inline.length) blocks.push({ type: 'paragraph', children: inline });
    }
  }

  return blocks;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseList(lines, start) {
  const first = RE.list.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : undefined;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = RE.list.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;

    const contentIndent = m[1].length + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const itemLines = [m[4]];
    i++;

    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A blank line belongs to the item only if more indented content follows.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (let k = i; k < j; k++) itemLines.push('');
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent || (ind > baseIndent && RE.list.test(l))) {
        itemLines.push(l.slice(Math.min(contentIndent, ind)));
        i++;
        continue;
      }
      // Lazy paragraph continuation (unindented text right after the item line)
      const sib = RE.list.exec(l);
      if (!sib && !startsBlock(l, lines[i + 1]) && itemLines.length && !isBlank(itemLines[itemLines.length - 1])) {
        itemLines.push(l.trim());
        i++;
        continue;
      }
      break;
    }

    items.push(itemLines);
    // Allow a single blank line between sibling items (loose lists)
    if (i < lines.length && isBlank(lines[i])) {
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      const sib = j < lines.length && RE.list.exec(lines[j]);
      if (sib && sib[1].length === baseIndent && /\d/.test(sib[2]) === ordered) i = j;
    }
  }

  const parsed = items.map((itemLines) => {
    const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(itemLines[0]);
    if (task) {
      const rest = [task[2]].concat(itemLines.slice(1));
      const blocks = parseBlocks(rest);
      const firstPara = blocks[0] && blocks[0].type === 'paragraph' ? blocks.shift() : null;
      return {
        task: true,
        checked: task[1].toLowerCase() === 'x',
        inline: firstPara ? firstPara.children : [],
        nested: blocks,
      };
    }
    return { task: false, blocks: parseBlocks(itemLines) };
  });

  let block;
  if (parsed.length && parsed.every((p) => p.task)) {
    block = {
      type: 'taskList',
      items: parsed.map((p) => ({
        checked: p.checked,
        children: p.inline,
        nested: p.nested && p.nested.length ? p.nested : undefined,
      })),
    };
  } else {
    const toItem = (p) => {
      if (!p.task) return { children: p.blocks };
      const box = FB.text(p.checked ? '☑ ' : '☐ ');
      return {
        children: [{ type: 'paragraph', children: [box].concat(p.inline) }].concat(p.nested || []),
      };
    };
    block = ordered
      ? { type: 'orderedList', start: startNum, items: parsed.map(toItem) }
      : { type: 'bulletList', items: parsed.map(toItem) };
  }

  return { block, next: i };
}

function indentOf(line) {
  return line.length - line.replace(/^\s+/, '').length;
}

// ---------------------------------------------------------------- inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function parseInline(src, marks) {
  marks = marks || FB.marks();
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(Object.assign({ type: 'text', text: buf }, marks));
    buf = '';
  };
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    // Hard break: backslash or two+ spaces before a newline
    if (ch === '\\' && src[i + 1] === '\n') {
      flush();
      out.push({ type: 'hardBreak' });
      i += 2;
      continue;
    }
    if (ch === ' ' && /^ {2,}\n/.test(rest)) {
      flush();
      out.push({ type: 'hardBreak' });
      i += rest.indexOf('\n') + 1;
      continue;
    }
    if (ch === '\n') {
      buf += ' ';
      i++;
      continue;
    }

    // Escapes
    if (ch === '\\' && PUNCT.test(src[i + 1] || '')) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    // Code span
    if (ch === '`') {
      const run = /^`+/.exec(rest)[0];
      const close = src.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        let code = src.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push(FB.text(code, Object.assign({}, marks, { code: true })));
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    // Image
    if (ch === '!' && src[i + 1] === '[') {
      const link = matchLink(src, i + 1);
      if (link) {
        flush();
        out.push({ type: 'image', src: link.url, alt: link.text });
        i = link.end;
        continue;
      }
    }

    // Link
    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push({ type: 'link', href: link.url, children: FB.tidyInline(parseInline(link.text, marks)) });
        i = link.end;
        continue;
      }
    }

    // Autolink <https://…>
    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^>\s]+)>/i.exec(rest);
      if (auto) {
        flush();
        out.push({ type: 'link', href: auto[1], children: [FB.text(auto[1].replace(/^mailto:/i, ''), marks)] });
        i += auto[0].length;
        continue;
      }
    }

    // Bare URL
    if ((ch === 'h' || ch === 'w') && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const bare = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/i.exec(rest);
      if (bare) {
        flush();
        const href = /^www\./i.test(bare[0]) ? 'https://' + bare[0] : bare[0];
        out.push({ type: 'link', href, children: [FB.text(bare[0], marks)] });
        i += bare[0].length;
        continue;
      }
    }

    // Emoji shortcode (only known ones, so "10:30:00" stays text)
    if (ch === ':') {
      const em = /^:([a-z0-9_+-]+):/i.exec(rest);
      if (em && FB.isKnownEmoji(em[1])) {
        flush();
        out.push({ type: 'emoji', shortcode: em[1] });
        i += em[0].length;
        continue;
      }
    }

    // Emphasis: *, _, ~~
    if (ch === '*' || ch === '_' || (ch === '~' && src[i + 1] === '~')) {
      const runLen = /^([*_~])\1*/.exec(rest)[0].length;
      const n = ch === '~' ? 2 : Math.min(runLen, 3);
      const next = src[i + n];
      const prev = src[i - 1];
      const leftFlanking = next && !/\s/.test(next) && !(ch === '_' && prev && /[A-Za-z0-9]/.test(prev));
      if (leftFlanking && runLen <= 3) {
        const close = findCloser(src, i + n, ch, n);
        if (close !== -1) {
          flush();
          const inner = src.slice(i + n, close);
          const m = Object.assign({}, marks);
          if (ch === '~') m.strike = true;
          else if (n === 1) m.italic = true;
          else if (n === 2) m.bold = true;
          else {
            m.bold = true;
            m.italic = true;
          }
          parseInline(inner, m).forEach((node) => out.push(node));
          i = close + n;
          continue;
        }
      }
      buf += src.slice(i, i + runLen);
      i += runLen;
      continue;
    }

    buf += ch;
    i++;
  }

  flush();
  return FB.tidyInline(out);
}

function findCloser(src, from, ch, n) {
  let j = from;
  let fallback = -1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(j))[0];
      const end = src.indexOf(run, j + run.length);
      j = end === -1 ? j + run.length : end + run.length;
      continue;
    }
    if (c === ch) {
      const run = new RegExp('^\\' + ch + '+').exec(src.slice(j))[0].length;
      const prev = src[j - 1];
      const after = src[j + run];
      const rightFlanking = prev && !/\s/.test(prev) && !(ch === '_' && after && /[A-Za-z0-9]/.test(after));
      if (rightFlanking && j > from) {
        if (run === n) return j;
        if (run > n && fallback === -1) fallback = j + (run - n);
      }
      j += run;
      continue;
    }
    j++;
  }
  return fallback;
}

// A link's text and address are short. Looking only this far keeps a page full of "[" from taking time that
// grows with the square of its length (each "[" would otherwise scan to the end).
const LINK_TEXT_MAX = 1000;
const LINK_URL_MAX = 4096;
function matchLink(src, start) {
  // [text](url "title")
  let depth = 0;
  let k = start;
  const textEnd = Math.min(src.length, start + LINK_TEXT_MAX);
  for (; k < textEnd; k++) {
    if (src[k] === '\\') {
      k++;
      continue;
    }
    if (src[k] === '[') depth++;
    else if (src[k] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[k + 1] !== '(') return null;
  const text = src.slice(start + 1, k);
  let p = k + 2;
  let parens = 1;
  let urlPart = '';
  const urlEnd = Math.min(src.length, p + LINK_URL_MAX);
  for (; p < urlEnd; p++) {
    if (src[p] === '(') parens++;
    if (src[p] === ')') {
      parens--;
      if (parens === 0) break;
    }
    urlPart += src[p];
  }
  if (parens !== 0) return null;
  const m = /^\s*<?([^\s>]*)>?(?:\s+["'(].*["')])?\s*$/.exec(urlPart);
  if (!m) return null;
  return { text, url: m[1], end: p + 1 };
}

FB._markdownParseInline = parseInline;
})();
