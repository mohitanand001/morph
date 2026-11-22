(function () {
// Converts pasted HTML (rendered rich text from Jira, Confluence, GitHub,
// Google Docs, Outlook, Slack, Claude, or any web page) into the shared AST.
//
// Source quirks handled here:
// - Google Docs: formatting lives in inline styles on <span>s (font-weight,
//   font-style, text-decoration, font-family), the whole fragment is
//   wrapped in <b style="font-weight:normal">, and nested lists are flat
//   <li aria-level="N"> runs.
// - GitHub: code language sits on a wrapping div (highlight-source-js),
//   alerts are div.markdown-alert, task lists use input checkboxes.
// - Slack: mentions/channels are marked with data-stringify-type.
// - Everyone: loose inline content at the top level, formatting whitespace
//   between tags, adjacent spans with identical formatting.
window.FB = window.FB || {};

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'hr', 'dl', 'dt', 'dd', 'details', 'summary',
]);
const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(',');
const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'head', 'noscript', 'template', 'button', 'svg', 'colgroup', 'col']);
const MONO_FONT = /(mono|courier|consolas|menlo|monaco|source code|fira code|jetbrains|inconsolata|sf mono)/i;

// A browser parses with its own DOM. Anywhere else (GJS, JavaScriptCore, Node) the small parser in
// minidom.js stands in; tests can force it with htmlToAst(html, true) to compare the two.
const NT = FB.NODE || { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 };
let miniMode = false;
FB.htmlToAst = function htmlToAst(htmlString, forceMini) {
  miniMode = !!forceMini || typeof DOMParser === 'undefined';
  const doc = miniMode ? FB.parseHtml(htmlString || '') : new DOMParser().parseFromString(htmlString || '', 'text/html');
  return { type: 'doc', children: walkBlockChildren(doc.body) };
};

function isInlineNode(node) {
  if (node.nodeType === NT.TEXT_NODE) return true;
  if (node.nodeType !== NT.ELEMENT_NODE) return false;
  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;
  if (BLOCK_TAGS.has(tag)) return false;
  return !node.querySelector(BLOCK_SELECTOR);
}

function walkBlockChildren(parent) {
  const out = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    const inline = [];
    run.forEach((n) => collectInline(n, inline, FB.marks()));
    const trimmed = FB.trimInline(inline);
    if (trimmed.length) out.push({ type: 'paragraph', children: trimmed });
    run = [];
  };

  const kids = Array.from(parent.childNodes);
  for (let k = 0; k < kids.length; k++) {
    const node = kids[k];
    if (node.nodeType === NT.COMMENT_NODE) continue;
    if (isInlineNode(node)) {
      if (node.nodeType === NT.ELEMENT_NODE && node.tagName.toLowerCase() === 'br') {
        // Two <br>s in a row separate paragraphs; one is a line break.
        const next = kids[k + 1];
        if (next && next.nodeType === NT.ELEMENT_NODE && next.tagName.toLowerCase() === 'br') {
          flushRun();
          k++;
          continue;
        }
      }
      run.push(node);
      continue;
    }
    flushRun();
    const block = nodeToBlock(node);
    if (!block) continue;
    if (Array.isArray(block)) out.push(...block);
    else out.push(block);
  }
  flushRun();
  return out;
}

function styleOf(el) {
  return (el.getAttribute && el.getAttribute('style')) || '';
}

function cls(el) {
  return ((el.getAttribute && el.getAttribute('class')) || '').toLowerCase();
}

function nodeToBlock(node) {
  if (node.nodeType !== NT.ELEMENT_NODE) return null;
  const tag = node.tagName.toLowerCase();
  const c = cls(node);
  if (SKIP_TAGS.has(tag)) return null;

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const inline = inlineOf(node);
      if (!inline.length) return null;
      return { type: 'heading', level: parseInt(tag[1], 10), children: inline };
    }

    case 'p': {
      if (c.includes('markdown-alert-title')) return null;
      // Google Docs marks the document title/subtitle with these classes.
      if (c === 'title' || c === 'subtitle') {
        const inline = inlineOf(node);
        return inline.length ? { type: 'heading', level: c === 'title' ? 1 : 2, children: inline } : null;
      }
      const inline = inlineOf(node);
      if (!inline.length) return null;
      const para = { type: 'paragraph', children: inline };
      // Outlook and Word send list items as paragraphs; the nesting level
      // is only in the style ("mso-list:l0 level2 lfo1").
      const lvl = (node.getAttribute('style') || '').match(/mso-list:\s*l\d+\s+level(\d+)/i);
      if (lvl) para.listLevel = parseInt(lvl[1], 10);
      return para;
    }

    case 'ul':
    case 'ol':
      return listToBlock(node);

    case 'pre': {
      const codeEl = node.querySelector('code') || node;
      let lang = null;
      const own = /(?:language|lang)-([\w+#.-]+)/.exec(cls(codeEl) + ' ' + c);
      if (own) lang = own[1];
      if (!lang) {
        const wrap = node.closest('[class*="highlight-source-"]');
        const m = wrap && /highlight-source-([\w+#.-]+)/.exec(cls(wrap));
        if (m) lang = m[1];
      }
      if (!lang && node.getAttribute('lang')) lang = node.getAttribute('lang');
      if (!lang && codeEl.getAttribute('data-language')) lang = codeEl.getAttribute('data-language');
      const raw = codeEl.querySelector('br') ? codeTextOf(codeEl) : codeEl.textContent;
      return { type: 'codeBlock', language: lang || undefined, content: raw.replace(/ /g, ' ').replace(/\n$/, '') };
    }

    case 'blockquote':
      if (c.includes('panel') || c.includes('macro')) {
        return { type: 'panel', variant: panelVariant(c), children: walkBlockChildren(node) };
      }
      return { type: 'blockquote', children: walkBlockChildren(node) };

    case 'table':
      return tableToBlock(node);

    case 'hr':
      return { type: 'divider' };

    case 'details': {
      // Collapsible section: keep the summary as a bold line, then the body.
      const summary = node.querySelector('summary');
      const blocks = [];
      if (summary) blocks.push({ type: 'paragraph', children: inlineOf(summary).map((n) => (n.type === 'text' ? Object.assign({}, n, { bold: true }) : n)) });
      Array.from(node.childNodes).forEach((ch) => {
        if (ch === summary) return;
        const wrap = miniMode ? FB.createElement('div') : document.createElement('div');
        wrap.appendChild(ch.cloneNode(true));
        blocks.push(...walkBlockChildren(wrap));
      });
      return blocks;
    }

    case 'div':
    case 'section':
    case 'aside': {
      // Code editors (VS Code) copy code as a monospace, white-space:pre
      // div with one child div per line.
      const st = styleOf(node).toLowerCase();
      if (/white-space:\s*pre/.test(st) && MONO_FONT.test(st)) {
        return { type: 'codeBlock', content: codeTextOf(node).replace(/\n+$/, '') };
      }
      const alert = /markdown-alert-(note|tip|important|warning|caution)/.exec(c);
      if (alert) {
        return { type: 'panel', variant: FB.ALERT_TO_PANEL[alert[1].toUpperCase()], children: walkBlockChildren(node) };
      }
      if (
        c.includes('confluence-information-macro') ||
        /(^|\s|-)panel(\s|-|$)/.test(c) ||
        node.getAttribute('data-panel-type')
      ) {
        return { type: 'panel', variant: panelVariant(c + ' ' + (node.getAttribute('data-panel-type') || '')), children: walkBlockChildren(node) };
      }
      // GitHub's code wrapper: let the <pre> inside pick up the language.
      return walkBlockChildren(node);
    }

    default:
      return walkBlockChildren(node);
  }
}

// Text of a code element, one line per child block (<div>/<p>), keeping
// blank lines (<div><br></div>) and indentation.
function codeTextOf(el) {
  let out = '';
  el.childNodes.forEach((ch) => {
    if (ch.nodeType === NT.TEXT_NODE) {
      out += ch.textContent;
    } else if (ch.nodeType === NT.ELEMENT_NODE) {
      const t = ch.tagName.toLowerCase();
      if (t === 'br') out += '\n';
      else if (t === 'div' || t === 'p') {
        if (out && !out.endsWith('\n')) out += '\n';
        out += codeTextOf(ch);
        if (!out.endsWith('\n')) out += '\n';
      } else out += codeTextOf(ch);
    }
  });
  return out.replace(/ /g, ' ');
}

function panelVariant(c) {
  if (c.includes('warning') || c.includes('caution')) return 'warning';
  if (c.includes('error') || c.includes('danger')) return 'error';
  if (c.includes('success') || c.includes('tip')) return 'success';
  if (c.includes('info') || c.includes('information')) return 'info';
  return 'note';
}

// ---------------------------------------------------------------- lists

function listToBlock(listEl) {
  const lis = Array.from(listEl.children).filter((ch) => ch.tagName && ch.tagName.toLowerCase() === 'li');
  if (!lis.length) return null;

  // Google Docs: flat <li aria-level="N"> runs. Rebuild the nesting.
  if (lis.some((li) => parseInt(li.getAttribute('aria-level') || '1', 10) > 1)) {
    return rebuildFlatList(listEl, lis);
  }

  const ordered = listEl.tagName.toLowerCase() === 'ol';
  const isTask = (li) => !!li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"], :scope > label > input[type="checkbox"]') || /task-list-item/.test(cls(li)) || li.getAttribute('data-task-state');
  if (!ordered && lis.every(isTask)) {
    return {
      type: 'taskList',
      items: lis.map((li) => {
        const box = li.querySelector('input[type="checkbox"]');
        const checked = box ? box.checked || box.hasAttribute('checked') : li.getAttribute('data-task-state') === 'DONE';
        const nested = Array.from(li.children).filter((ch) => /^(ul|ol)$/i.test(ch.tagName)).map(listToBlock).filter(Boolean);
        const clone = li.cloneNode(true);
        Array.from(clone.children).forEach((ch) => {
          if (/^(ul|ol)$/i.test(ch.tagName)) ch.remove();
        });
        return { checked: !!checked, children: inlineOf(clone), nested: nested.length ? nested : undefined };
      }),
    };
  }

  // A list sitting directly inside a list (some editors write nested bullets this way, outside any <li>)
  // belongs to the item before it; dropping it would lose text.
  const items = [];
  Array.from(listEl.children).forEach((ch) => {
    const tag = (ch.tagName || '').toLowerCase();
    if (tag === 'li') items.push({ children: liBlocks(ch) });
    else if (tag === 'ul' || tag === 'ol') {
      const sub = listToBlock(ch);
      if (!sub) return;
      if (items.length) items[items.length - 1].children.push(sub);
      else items.push({ children: [sub] });
    }
  });
  if (ordered) {
    return { type: 'orderedList', start: parseInt(listEl.getAttribute('start') || '1', 10), items };
  }
  return { type: 'bulletList', items };
}

function liBlocks(li) {
  const blocks = walkBlockChildren(li);
  return blocks.length ? blocks : [];
}

function rebuildFlatList(listEl, lis) {
  const ordered = listEl.tagName.toLowerCase() === 'ol';
  const root = { type: ordered ? 'orderedList' : 'bulletList', items: [] };
  const stack = [{ level: 1, list: root }];
  lis.forEach((li) => {
    const level = Math.max(1, parseInt(li.getAttribute('aria-level') || '1', 10));
    const item = { children: liBlocks(li) };
    while (stack.length > 1 && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (level > top.level) {
      const parentItem = top.list.items[top.list.items.length - 1];
      const styleType = (styleOf(li).match(/list-style-type:\s*([\w-]+)/) || [])[1] || '';
      const subOrdered = /decimal|alpha|roman/.test(styleType) || (ordered && !styleType);
      const sub = { type: subOrdered ? 'orderedList' : 'bulletList', items: [] };
      if (parentItem) parentItem.children.push(sub);
      else top.list.items.push({ children: [sub] });
      stack.push({ level, list: sub });
      top = stack[stack.length - 1];
    }
    top.list.items.push(item);
  });
  return root;
}

// ---------------------------------------------------------------- tables

function tableToBlock(table) {
  const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
  if (!rows.length) return null;
  const parseRow = (tr) =>
    Array.from(tr.children)
      .filter((cell) => /^(td|th)$/i.test(cell.tagName))
      .map((cell) => ({ children: inlineOf(cell), isHeader: cell.tagName.toLowerCase() === 'th' }));

  // A one-cell table is a layout box (Docs code boxes, Confluence panels
  // pasted as tables, email layouts) — unwrap it instead of keeping a table.
  if (rows.length === 1 && parseRow(rows[0]).length === 1) {
    const inner = walkBlockChildren(rows[0].children[0]);
    // All-monospace box = a code block (Docs code boxes, our own output).
    const allCode =
      inner.length &&
      inner.every(
        (b) =>
          b.type === 'paragraph' &&
          b.children.every((n) => n.type === 'hardBreak' || (n.type === 'text' && (n.code || !n.text.trim())))
      );
    if (allCode) {
      return {
        type: 'codeBlock',
        content: inner.map((b) => FB.inlineToPlain(b.children).replace(/ /g, ' ')).join('\n'),
      };
    }
    return inner;
  }

  const parsed = rows.map(parseRow);
  const width = Math.max(...parsed.map((r) => r.length));
  parsed.forEach((r) => {
    while (r.length < width) r.push({ children: [], isHeader: false });
  });
  return {
    type: 'table',
    headerRow: parsed[0].map((c) => Object.assign({}, c, { isHeader: true })),
    rows: parsed.slice(1),
  };
}

// ---------------------------------------------------------------- inline

function inlineOf(el) {
  const out = [];
  el.childNodes.forEach((ch) => collectInline(ch, out, FB.marks()));
  return FB.trimInline(out);
}

function marksFromStyle(el, marks) {
  const style = styleOf(el).toLowerCase();
  if (!style) return marks;
  const next = Object.assign({}, marks);
  const fw = /font-weight:\s*([a-z0-9]+)/.exec(style);
  if (fw) {
    const v = fw[1];
    next.bold = v === 'bold' || v === 'bolder' || (/^\d+$/.test(v) && parseInt(v, 10) >= 600);
  }
  const fs = /font-style:\s*([a-z]+)/.exec(style);
  if (fs) next.italic = fs[1] === 'italic' || fs[1] === 'oblique';
  const td = /text-decoration(?:-line)?:\s*([^;]+)/.exec(style);
  if (td) {
    if (td[1].includes('line-through')) next.strike = true;
    else if (td[1].trim() === 'none') next.strike = false;
  }
  const ff = /font-family:\s*([^;]+)/.exec(style);
  if (ff && MONO_FONT.test(ff[1])) next.code = true;
  return next;
}

function collectInline(node, out, marks) {
  if (node.nodeType === NT.TEXT_NODE) {
    let text = node.textContent;
    if (!text) return;
    // Collapse formatting whitespace from the HTML source, except inside
    // code where indentation matters.
    if (!marks.code) text = text.replace(/[\t\n\r ]+/g, ' ');
    out.push(Object.assign({ type: 'text', text }, marks));
    return;
  }
  if (node.nodeType !== NT.ELEMENT_NODE) return;

  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (tag === 'input') return;
  if (tag === 'br') {
    out.push({ type: 'hardBreak' });
    return;
  }

  const c = cls(node);
  const stringify = node.getAttribute('data-stringify-type');

  if (tag === 'img') {
    const alt = node.getAttribute('alt') || node.getAttribute('aria-label') || '';
    const sc = /^:([a-z0-9_+-]+):$/i.exec(alt);
    if (sc || c.includes('emoji')) {
      if (sc) out.push({ type: 'emoji', shortcode: sc[1] });
      else if (alt) out.push(Object.assign({ type: 'text', text: alt }, marks));
      return;
    }
    const src = node.getAttribute('src') || '';
    if (src && !src.startsWith('data:')) out.push({ type: 'image', src, alt });
    return;
  }

  // Mentions (Slack, Atlassian, GitHub user links)
  if (stringify === 'mention' || c.includes('mention') || node.getAttribute('data-mention-id') || c.includes('user-mention')) {
    let name = node.textContent.trim();
    if (name.includes('|')) name = name.slice(name.lastIndexOf('|') + 1);
    name = name.replace(/^@/, '');
    if (name) out.push({ type: 'mention', displayName: name });
    return;
  }
  if (stringify === 'channel') {
    out.push(Object.assign({ type: 'text', text: node.textContent.trim() }, marks));
    return;
  }

  // Emoji spans (Slack/Atlassian render emoji as spans with a shortcode)
  const emojiAttr = node.getAttribute('data-emoji-short-name') || node.getAttribute('data-stringify-emoji');
  if (emojiAttr) {
    const sc = emojiAttr.replace(/:/g, '');
    out.push({ type: 'emoji', shortcode: sc });
    return;
  }

  let next = Object.assign({}, marks);
  if (tag === 'strong' || tag === 'b') next.bold = true;
  if (tag === 'em' || tag === 'i' || tag === 'cite') next.italic = true;
  if (tag === 'del' || tag === 's' || tag === 'strike') next.strike = true;
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') next.code = true;
  // Inline styles override tag semantics (Docs wraps everything in
  // <b style="font-weight:normal">).
  next = marksFromStyle(node, next);

  if (tag === 'a') {
    // A Docs people chip: <a href="mailto:.."><span data-rich-links='{"type":"person",...}'>
    const chip = node.querySelector && node.querySelector('[data-rich-links]');
    if (chip) {
      try {
        const info = JSON.parse(chip.getAttribute('data-rich-links'));
        if (info && info.type === 'person' && (info.per_n || info.per_e)) {
          out.push({ type: 'mention', displayName: info.per_n || info.per_e, email: info.per_e || '' });
          return;
        }
      } catch (e) { /* not JSON: fall through to a normal link */ }
    }
    let href = node.getAttribute('href') || '';
    // Slack writes @mentions as links to /team/U123, sometimes with the
    // text "url|@name".
    const sl = FB.cleanSlackLink(href, node.textContent);
    if (sl.isUser && sl.label && !/^https?:/i.test(sl.label)) {
      out.push({ type: 'mention', displayName: sl.label.replace(/^@/, '') });
      return;
    }
    href = sl.href || href;
    const children = [];
    node.childNodes.forEach((ch) => collectInline(ch, children, next));
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      children.forEach((n) => out.push(n));
      return;
    }
    const tidy = FB.trimInline(children);
    const plainLabel = FB.inlineToPlain(tidy);
    const fixedKids = /^https?:[^|]*\|/.test(plainLabel) ? [FB.text(sl.label, next)] : tidy;
    out.push({ type: 'link', href, children: fixedKids.length ? fixedKids : [FB.text(href, next)] });
    return;
  }

  node.childNodes.forEach((ch) => collectInline(ch, out, next));
}
})();
