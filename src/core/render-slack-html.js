(function () {
// Renders the shared AST as HTML for Slack's compose box. Slack keeps
// <b>/<i>/<s>/<code>/<pre>/<a>/<ul>/<ol>/<blockquote> on paste (it does
// NOT re-parse pasted *mrkdwn* text, which is why this exists).
// Slack has no headings: they become bold paragraphs. Tables: Slack's
// composer turns a pasted HTML <table> into a real table in the message
// (seen 2026-11-08 pasting from LibreOffice), so tables go out as plain
// HTML tables with a bold first row.
window.FB = window.FB || {};

FB.astToSlackHtml = function astToSlackHtml(ast) {
  return renderBlocks(ast.children);
};

function renderBlocks(blocks) {
  return (blocks || []).map(renderBlock).filter(Boolean).join('');
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return '<p><b>' + FB.escapeHtml(FB.inlineToPlain(block.children)) + '</b></p>';

    case 'paragraph':
      return '<p>' + renderInline(block.children) + '</p>';

    case 'bulletList':
      return '<ul>' + block.items.map((i) => '<li>' + renderItem(i.children) + '</li>').join('') + '</ul>';

    case 'orderedList':
      return '<ol>' + block.items.map((i) => '<li>' + renderItem(i.children) + '</li>').join('') + '</ol>';

    case 'taskList':
      return (
        '<ul>' +
        block.items
          .map((i) => '<li>' + (i.checked ? '☑ ' : '☐ ') + renderInline(i.children) + (i.nested ? renderBlocks(i.nested) : '') + '</li>')
          .join('') +
        '</ul>'
      );

    case 'codeBlock':
      return '<pre>' + FB.escapeHtml(block.content || '') + '</pre>';

    case 'blockquote':
      return '<blockquote>' + renderBlocks(block.children) + '</blockquote>';

    case 'panel':
      return (
        '<blockquote><p>' + FB.PANEL_ICON[block.variant] + ' <b>' + FB.PANEL_LABEL[block.variant] + '</b></p>' +
        renderBlocks(block.children) +
        '</blockquote>'
      );

    case 'table': {
      const row = (cells, head) =>
        '<tr>' + cells.map((c) => '<td>' + (head ? '<b>' + renderInline(c.children) + '</b>' : renderInline(c.children)) + '</td>').join('') + '</tr>';
      return '<table><tbody>' + row(block.headerRow, true) + block.rows.map((r) => row(r, false)).join('') + '</tbody></table>';
    }

    case 'divider':
      return '<p>───────────────</p>';

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
      if (node.strike) t = '<s>' + t + '</s>';
      if (node.italic) t = '<i>' + t + '</i>';
      if (node.bold) t = '<b>' + t + '</b>';
      return t;
    }
    case 'link':
      return '<a href="' + FB.escapeHtml(node.href) + '">' + renderInline(node.children) + '</a>';
    case 'image':
      return '<a href="' + FB.escapeHtml(node.src) + '">' + FB.escapeHtml(node.alt || node.src) + '</a>';
    case 'mention':
      return '<b>@' + FB.escapeHtml(node.displayName) + '</b>';
    case 'emoji':
      return ':' + FB.escapeHtml(node.shortcode) + ':';
    case 'hardBreak':
      return '<br>';
    default:
      return '';
  }
}
})();
