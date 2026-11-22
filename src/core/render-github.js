(function () {
// Renders the shared AST as GitHub-flavored markdown, for pasting into
// issue/PR/comment boxes (plain textareas that render markdown on submit).
//
// Choices worth knowing:
// - Panels become GitHub alerts (> [!NOTE], > [!WARNING], ...).
// - @mentions become `@name` code spans. A bare @name on GitHub notifies
//   whichever real account owns that handle, which is almost never the
//   person from Slack/Jira with the same display name.
// - Tables become pipe tables; line breaks inside cells become <br>.
window.FB = window.FB || {};

FB.astToGithub = function astToGithub(ast) {
  return renderBlocks(ast.children, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
};

function renderBlocks(blocks, indent) {
  return (blocks || [])
    .map((b) => renderBlock(b, indent))
    .filter((s) => s !== null && s !== '')
    .join('\n\n');
}

function prefixLines(text, first, rest) {
  return text
    .split('\n')
    .map((l, idx) => (idx === 0 ? first : rest) + l)
    .join('\n');
}

function renderBlock(block, indent) {
  switch (block.type) {
    case 'heading':
      return '#'.repeat(block.level) + ' ' + renderInline(block.children);

    case 'paragraph': {
      let text = renderInline(block.children);
      // Escape characters that would turn the start of a line into a block.
      text = text.replace(/^(\s*)([#>+]|-(?=\s)|\d+[.)](?=\s))/gm, '$1\\$2');
      return text;
    }

    case 'bulletList':
      return block.items.map((item) => renderItem('-', item.children)).join('\n');

    case 'orderedList': {
      const start = block.start || 1;
      return block.items.map((item, idx) => renderItem(start + idx + '.', item.children)).join('\n');
    }

    case 'taskList':
      return block.items
        .map((item) => {
          const head = '- [' + (item.checked ? 'x' : ' ') + '] ' + renderInline(item.children);
          if (!item.nested || !item.nested.length) return head;
          return head + '\n' + prefixLines(renderBlocks(item.nested, ''), '  ', '  ');
        })
        .join('\n');

    case 'codeBlock': {
      const content = block.content || '';
      const longest = Math.max(2, ...(content.match(/`+/g) || ['']).map((r) => r.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return fence + (block.language || '') + '\n' + content + '\n' + fence;
    }

    case 'blockquote':
      return prefixLines(renderBlocks(block.children, ''), '> ', '> ').replace(/^> $/gm, '>');

    case 'panel': {
      const type = FB.PANEL_TO_ALERT[block.variant] || 'NOTE';
      const body = renderBlocks(block.children, '');
      return ('> [!' + type + ']\n' + prefixLines(body, '> ', '> ')).replace(/^> $/gm, '>');
    }

    case 'table': {
      const cell = (c) => renderInline(c.children).replace(/\|/g, '\\|').replace(/\n/g, '<br>') || ' ';
      const head = '| ' + block.headerRow.map(cell).join(' | ') + ' |';
      const sep =
        '| ' +
        block.headerRow
          .map((_, idx) => {
            const a = block.align && block.align[idx];
            return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
          })
          .join(' | ') +
        ' |';
      const body = block.rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |');
      return [head, sep].concat(body).join('\n');
    }

    case 'divider':
      return '---';

    case 'unsupported':
      return '```\n' + (block.raw || '') + '\n```';

    default:
      return '';
  }
}

function renderItem(marker, children) {
  const pad = ' '.repeat(marker.length + 1);
  const parts = (children || []).map((b) => renderBlock(b, ''));
  if (!parts.length) return marker;
  // Tight list: first paragraph on the marker line, nested blocks indented.
  const [first, ...rest] = parts;
  let out = prefixLines(first, marker + ' ', pad);
  rest.forEach((p) => {
    out += '\n' + prefixLines(p, pad, pad);
  });
  return out;
}

function escapeText(t) {
  return t
    .replace(/\\/g, '\\\\')
    .replace(/([`*[\]<])/g, '\\$1')
    .replace(/(^|[^A-Za-z0-9])_/g, '$1\\_')
    .replace(/(?<!\\)_(?=[^A-Za-z0-9]|$)/g, '\\_')
    .replace(/~~/g, '\\~\\~');
}

function renderInline(children) {
  return (children || []).map(renderInlineNode).join('');
}

function renderInlineNode(node) {
  switch (node.type) {
    case 'text': {
      if (node.code) {
        const ticks = (node.text.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
        const fence = '`'.repeat(ticks + 1);
        const pad = ticks ? ' ' : '';
        let t = fence + pad + node.text + pad + fence;
        if (node.bold) t = '**' + t + '**';
        return t;
      }
      let t = escapeText(node.text);
      if (node.strike) t = FB.wrapMark(t, '~~');
      if (node.italic) t = FB.wrapMark(t, '_');
      if (node.bold) t = FB.wrapMark(t, '**');
      return t;
    }
    case 'link': {
      const label = renderInline(node.children);
      if (label === node.href || label === escapeText(node.href)) return '<' + node.href + '>';
      return '[' + label + '](' + node.href.replace(/\)/g, '%29').replace(/ /g, '%20') + ')';
    }
    case 'image':
      return '![' + escapeText(node.alt || '') + '](' + node.src + ')';
    case 'mention':
      return '`@' + node.displayName + '`';
    case 'emoji':
      return ':' + node.shortcode + ':';
    case 'hardBreak':
      return '\\\n';
    default:
      return '';
  }
}
})();
