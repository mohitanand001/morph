(function () {
// Converts Slack mrkdwn (or plain text that looks similar enough) into the
// shared AST. Line-based block parser + a small inline tokenizer.
window.FB = window.FB || {};

FB.mrkdwnToAst = function mrkdwnToAst(text) {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code block
    if (line.trim().startsWith('```')) {
      const langMatch = line.trim().match(/^```(\w+)?/);
      const lang = langMatch && langMatch[1] ? langMatch[1] : undefined;
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ type: 'codeBlock', language: lang, content: codeLines.join('\n') });
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        children: [{ type: 'paragraph', children: FB.trimInline(parseInline(quoteLines.join('\n'))) }],
      });
      continue;
    }

    // lists (bullets and numbers, nested by indentation)
    if (LIST_LINE.test(line)) {
      const entries = [];
      while (i < lines.length && LIST_LINE.test(lines[i])) {
        const m = lines[i].match(/^([ \t]*)([-*•◦▪]|\d+[.)])\s+(.*)$/);
        entries.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), children: FB.trimInline(parseInline(m[3])) });
        i++;
      }
      const levels = [];
      entries.forEach((e) => {
        while (levels.length && e.indent < levels[levels.length - 1]) levels.pop();
        if (!levels.length || e.indent > levels[levels.length - 1]) levels.push(e.indent);
        e.level = levels.length;
      });
      let j = 0;
      while (j < entries.length) {
        const [list, next] = buildList(entries, j, entries[j].level);
        blocks.push(list);
        j = next;
      }
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        items.push({ children: [{ type: 'paragraph', children: FB.trimInline(parseInline(m[1])) }] });
        i++;
      }
      blocks.push({ type: 'orderedList', items });
      continue;
    }

    // paragraph: collect contiguous non-blank lines, but stop early if a
    // line starting a new block type (list, quote, code fence) appears
    // without a blank line separating it from this paragraph — common in
    // real Slack messages.
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !startsNewBlock(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }

    // Slack posts markdown tables as raw "| a | b |" lines. Find them on the
    // raw lines, before inline parsing can mangle cell text.
    const found = FB.findTextTable ? FB.findTextTable(paraLines) : null;
    if (found) {
      const before = paraLines.slice(0, found.start).join('\n');
      const after = paraLines.slice(found.end).join('\n');
      if (before.trim()) blocks.push({ type: 'paragraph', children: FB.trimInline(parseInline(before)) });
      blocks.push(found.table);
      if (after.trim()) blocks.push({ type: 'paragraph', children: FB.trimInline(parseInline(after)) });
      continue;
    }

    const inline = FB.trimInline(parseInline(paraLines.join('\n')));
    if (inline.length) blocks.push({ type: 'paragraph', children: inline });
  }

  return { type: 'doc', children: blocks };
};

const LIST_LINE = /^[ \t]*([-*•◦▪]|\d+[.)])\s+/;

function buildList(entries, start, level) {
  const ordered = entries[start].ordered;
  const list = { type: ordered ? 'orderedList' : 'bulletList', items: [] };
  if (ordered) list.start = 1;
  let i = start;
  while (i < entries.length && entries[i].level >= level) {
    const e = entries[i];
    if (e.level > level && list.items.length) {
      const [child, next] = buildList(entries, i, e.level);
      list.items[list.items.length - 1].children.push(child);
      i = next;
      continue;
    }
    if (e.ordered !== ordered && list.items.length) break;
    list.items.push({ children: [{ type: 'paragraph', children: e.children }] });
    i++;
  }
  return [list, i];
}

function startsNewBlock(line) {
  return (
    line.trim().startsWith('```') ||
    /^>\s?/.test(line) ||
    LIST_LINE.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  );
}

function isWordChar(c) {
  return !!c && /[A-Za-z0-9]/.test(c);
}

// Slack only treats * _ ~ as formatting at word boundaries, so
// snake_case_name and 2*3*4 stay literal.
function findClose(text, from, ch) {
  for (let j = from; j < text.length; j++) {
    if (text[j] !== ch) continue;
    if (j === from) continue;
    if (/\s/.test(text[j - 1])) continue;
    if (isWordChar(text[j + 1])) continue;
    return j;
  }
  return -1;
}

function canOpen(text, i) {
  return !isWordChar(text[i - 1]) && !!text[i + 1] && !/\s/.test(text[i + 1]);
}

function parseInline(text) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(FB.text(buf));
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // <url|label>, <@user|name>, <#channel|name>
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);

        if (inner.startsWith('@')) {
          flush();
          const name = inner.includes('|') ? inner.split('|')[1] : inner.slice(1);
          out.push({ type: 'mention', displayName: name });
          i = end + 1;
          continue;
        }
        if (inner.startsWith('#')) {
          flush();
          const name = inner.includes('|') ? inner.split('|')[1] : inner.slice(1);
          out.push(FB.text('#' + name));
          i = end + 1;
          continue;
        }

        // <!here>, <!channel>, <!everyone>
        if (inner.startsWith('!')) {
          flush();
          const name = inner.includes('|') ? inner.split('|')[1] : inner.slice(1);
          out.push(FB.text('@' + name.replace(/^@/, '')));
          i = end + 1;
          continue;
        }

        if (/^(https?:|mailto:)/i.test(inner)) {
          const parts = inner.split('|');
          flush();
          const sl = FB.cleanSlackLink(parts[0], parts[1] || '');
          if (sl.isUser && sl.label && !/^https?:/i.test(sl.label)) {
            out.push({ type: 'mention', displayName: sl.label.replace(/^@/, '') });
            i = end + 1;
            continue;
          }
          out.push({
            type: 'link',
            href: parts[0],
            children: [FB.text(parts[1] || parts[0])],
          });
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push(FB.text(text.slice(i + 1, end), { code: true }));
        i = end + 1;
        continue;
      }
    }

    if ((ch === '*' || ch === '_' || ch === '~') && canOpen(text, i)) {
      const end = findClose(text, i + 1, ch);
      if (end !== -1) {
        flush();
        const key = ch === '*' ? 'bold' : ch === '_' ? 'italic' : 'strike';
        out.push(FB.text(text.slice(i + 1, end), { [key]: true }));
        i = end + 1;
        continue;
      }
    }

    if (ch === ':') {
      const m = text.slice(i).match(/^:([a-z0-9_+-]+):/i);
      if (m && FB.isKnownEmoji(m[1])) {
        flush();
        out.push({ type: 'emoji', shortcode: m[1] });
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return FB.tidyInline(out);
}

// exposed for reuse/testing
FB._mrkdwnParseInline = parseInline;
})();
