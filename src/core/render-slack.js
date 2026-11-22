(function () {
// Renders the shared AST as Slack mrkdwn text. Used as the copied text
// when the content has a table (a pasted ``` fence becomes a real code
// block in Slack; pasted HTML would win over it otherwise), and as the
// text/plain fallback the rest of the time.
//
// Slack has no headings, tables or checkboxes: headings become bold lines,
// tables become an aligned monospace block, tasks become ☐/☑ lines.
window.FB = window.FB || {};

let plainLinks = false;
FB.astToSlack = function astToSlack(ast, opts) {
  plainLinks = !!(opts && opts.plainLinks);
  return (ast.children || [])
    .map((b) => renderBlock(b, 0))
    .filter((s) => s !== null && s !== '')
    .join('\n\n');
};

function renderBlock(block, depth) {
  switch (block.type) {
    case 'heading':
      return FB.wrapMark(FB.inlineToPlain(block.children), '*');

    case 'paragraph':
      return renderInline(block.children);

    case 'bulletList':
      return block.items.map((item) => indent(depth) + '• ' + renderItemChildren(item.children, depth)).join('\n');

    case 'orderedList': {
      const start = block.start || 1;
      return block.items
        .map((item, idx) => indent(depth) + (start + idx) + '. ' + renderItemChildren(item.children, depth))
        .join('\n');
    }

    case 'taskList':
      return block.items
        .map((item) => {
          let line = indent(depth) + (item.checked ? '☑ ' : '☐ ') + renderInline(item.children);
          if (item.nested) line += '\n' + item.nested.map((b) => renderBlock(b, depth + 1)).join('\n');
          return line;
        })
        .join('\n');

    case 'codeBlock':
      return '```\n' + (block.content || '') + '\n```';

    case 'blockquote':
      return quote(block.children.map((b) => renderBlock(b, 0)).filter(Boolean).join('\n'));

    case 'panel': {
      const body = block.children.map((b) => renderBlock(b, 0)).filter(Boolean).join('\n');
      return quote(FB.PANEL_ICON[block.variant] + ' *' + FB.PANEL_LABEL[block.variant] + '*\n' + body);
    }

    case 'table':
      return renderTableAsText(block);

    case 'divider':
      return '───────────────';

    case 'unsupported':
      return '```\n' + (block.raw || '[unsupported content]') + '\n```';

    default:
      return null;
  }
}

function quote(text) {
  return text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

function renderItemChildren(children, depth) {
  return (children || [])
    .map((b, idx) => {
      if (b.type === 'paragraph') return (idx ? '\n' + indent(depth + 1) : '') + renderInline(b.children);
      return '\n' + renderBlock(b, depth + 1);
    })
    .join('');
}

function indent(depth) {
  return '    '.repeat(depth);
}

function renderInline(children) {
  return (children || []).map(renderInlineNode).join('');
}

function renderInlineNode(node) {
  switch (node.type) {
    case 'text': {
      if (node.code) return '`' + node.text + '`';
      let t = node.text;
      if (node.strike) t = FB.wrapMark(t, '~');
      if (node.italic) t = FB.wrapMark(t, '_');
      if (node.bold) t = FB.wrapMark(t, '*');
      return t;
    }
    case 'link': {
      const label = FB.inlineToPlain(node.children);
      // Slack's composer doesn't read <url|label> on paste, so the
      // table copy (plain text only) writes "label (url)" instead.
      if (plainLinks) {
        const shown = node.href.replace(/^mailto:/i, '');
        return label && label !== shown ? label + ' (' + shown + ')' : shown;
      }
      return label && label !== node.href ? '<' + node.href + '|' + label + '>' : node.href;
    }
    case 'image':
      return node.alt ? '<' + node.src + '|' + node.alt + '>' : node.src;
    case 'mention':
      return '@' + node.displayName;
    case 'emoji':
      return ':' + node.shortcode + ':';
    case 'hardBreak':
      return '\n';
    default:
      return '';
  }
}

function renderTableAsText(table) {
  const rows = [table.headerRow].concat(table.rows);
  const rendered = rows.map((row) => row.map((cell) => FB.inlineToPlain(cell.children).replace(/\n/g, ' ')));
  const widths = table.headerRow.map((_, idx) => Math.max(...rendered.map((r) => [...(r[idx] || '')].length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - [...s].length));
  const lines = rendered.map((row) => row.map((cell, idx) => pad(cell || '', widths[idx])).join(' | ').replace(/\s+$/, ''));
  lines.splice(1, 0, widths.map((w) => '-'.repeat(Math.max(w, 1))).join('-|-'));
  return '```\n' + lines.join('\n') + '\n```';
}
})();
