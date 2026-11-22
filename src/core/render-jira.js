(function () {
// Renders the shared AST as HTML for Jira and Confluence. Their editors
// convert pasted semantic HTML into their own document model, so clean
// HTML is enough (confirmed: tables, lists, bold paste correctly into Jira).
window.FB = window.FB || {};

FB.astToJiraHtml = function astToJiraHtml(ast) {
  return renderBlocks(ast.children);
};

function renderBlocks(blocks) {
  return (blocks || []).map(renderBlock).filter(Boolean).join('');
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return '<h' + block.level + '>' + renderInline(block.children) + '</h' + block.level + '>';

    case 'paragraph':
      return '<p>' + renderInline(block.children) + '</p>';

    case 'bulletList':
      return '<ul>' + block.items.map((i) => '<li>' + renderItem(i.children) + '</li>').join('') + '</ul>';

    case 'orderedList':
      return (
        '<ol' + (block.start && block.start !== 1 ? ' start="' + block.start + '"' : '') + '>' +
        block.items.map((i) => '<li>' + renderItem(i.children) + '</li>').join('') +
        '</ol>'
      );

    case 'taskList':
      // A plain HTML paste can't create Jira/Confluence action items, so
      // tasks become ☐/☑ bullets.
      return (
        '<ul>' +
        block.items
          .map((i) => '<li>' + (i.checked ? '☑ ' : '☐ ') + renderInline(i.children) + (i.nested ? renderBlocks(i.nested) : '') + '</li>')
          .join('') +
        '</ul>'
      );

    case 'codeBlock':
      return (
        '<pre><code' + (block.language ? ' class="language-' + FB.escapeHtml(block.language) + '"' : '') + '>' +
        FB.escapeHtml(block.content || '') +
        '</code></pre>'
      );

    case 'blockquote':
      return '<blockquote>' + renderBlocks(block.children) + '</blockquote>';

    case 'panel':
      return (
        '<blockquote><p><strong>' + FB.PANEL_ICON[block.variant] + ' ' + FB.PANEL_LABEL[block.variant] + '</strong></p>' +
        renderBlocks(block.children) +
        '</blockquote>'
      );

    case 'table': {
      const head = '<tr>' + block.headerRow.map((c) => '<th>' + renderInline(c.children) + '</th>').join('') + '</tr>';
      const body = block.rows.map((r) => '<tr>' + r.map((c) => '<td>' + renderInline(c.children) + '</td>').join('') + '</tr>').join('');
      return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    }

    case 'divider':
      return '<hr>';

    case 'unsupported':
      return '<pre>' + FB.escapeHtml(block.raw || '') + '</pre>';

    default:
      return '';
  }
}

function renderItem(children) {
  return (children || []).map((b) => (b.type === 'paragraph' ? renderInline(b.children) : renderBlock(b))).join('');
}

function renderInline(children) {
  return (children || []).map(renderInlineNode).join('');
}

function renderInlineNode(node) {
  switch (node.type) {
    case 'text': {
      let t = FB.escapeHtml(node.text);
      if (node.code) t = '<code>' + t + '</code>';
      if (node.strike) t = '<del>' + t + '</del>';
      if (node.italic) t = '<em>' + t + '</em>';
      if (node.bold) t = '<strong>' + t + '</strong>';
      return t;
    }
    case 'link':
      return '<a href="' + FB.escapeHtml(node.href) + '">' + renderInline(node.children) + '</a>';
    case 'image':
      return '<img src="' + FB.escapeHtml(node.src) + '" alt="' + FB.escapeHtml(node.alt || '') + '">';
    case 'mention':
      return '<strong>@' + FB.escapeHtml(node.displayName) + '</strong>';
    case 'emoji':
      return FB.emojiChar(node.shortcode) || ':' + FB.escapeHtml(node.shortcode) + ':';
    case 'hardBreak':
      return '<br>';
    default:
      return '';
  }
}
})();
