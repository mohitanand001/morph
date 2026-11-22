(function () {
// Renders the shared AST as HTML for pasting into Google Docs.
//
// Docs keeps semantic tags (h1-h6, p, ul/ol, table, a, b/i/s) and inline
// styles on paste, but ignores classes and most block-level CSS (borders
// on paragraphs, <pre> backgrounds). So:
// - Inline code: a monospace span with a light highlight.
// - Code blocks and panels: a one-cell table with a shaded cell — the
//   reliable way to get a visible box into a Doc.
// - Tables: explicit cell borders and padding, header row bold + shaded.
// - Emoji shortcodes become real characters.
window.FB = window.FB || {};

const MONO = "'Roboto Mono','Courier New',monospace";
const PANEL_BG = { note: '#f1f3f4', info: '#e8f0fe', success: '#e6f4ea', warning: '#fef7e0', error: '#fce8e6' };
const CELL = 'border:1px solid #c7c7c7;padding:5pt 7pt;vertical-align:top;';

FB.astToGdocsHtml = function astToGdocsHtml(ast) {
  return '<meta charset="utf-8">' + renderBlocks(ast.children);
};

function renderBlocks(blocks) {
  return (blocks || []).map(renderBlock).filter(Boolean).join('');
}

function box(innerHtml, bg) {
  return (
    '<table style="border-collapse:collapse;width:100%;margin:6pt 0;"><tbody><tr>' +
    '<td style="background-color:' + bg + ';border:1px solid ' + bg + ';padding:8pt 10pt;">' +
    innerHtml +
    '</td></tr></tbody></table><p></p>'
  );
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
      return (
        '<ul style="list-style-type:none;">' +
        block.items
          .map(
            (i) =>
              '<li>' + (i.checked ? '☑ ' : '☐ ') + renderInline(i.children) +
              (i.nested ? renderBlocks(i.nested) : '') + '</li>'
          )
          .join('') +
        '</ul>'
      );

    case 'codeBlock': {
      // Docs collapses runs of spaces, so every space becomes &nbsp; to
      // keep indentation.
      const lines = (block.content || '').replace(/\t/g, '    ').split('\n');
      const inner = lines
        .map(
          (l) =>
            '<p style="margin:0;line-height:1.3;"><span style="font-family:' + MONO + ';font-size:10pt;white-space:pre-wrap;">' +
            (FB.escapeHtml(l).replace(/ /g, '&nbsp;') || '&nbsp;') +
            '</span></p>'
        )
        .join('');
      return box(inner, '#f1f3f4');
    }

    case 'blockquote':
      return renderBlocks(block.children).replace(
        /<p>/g,
        '<p style="margin-left:24pt;color:#5f6368;font-style:italic;">'
      );

    case 'panel': {
      const label = FB.PANEL_ICON[block.variant] + ' <b>' + FB.PANEL_LABEL[block.variant] + '</b>';
      const inner = '<p style="margin:0 0 4pt 0;">' + label + '</p>' + renderBlocks(block.children);
      return box(inner, PANEL_BG[block.variant] || PANEL_BG.note);
    }

    case 'table': {
      // Column widths follow the longest cell so short words don't wrap
      // mid-word in a narrow column.
      const cols = block.headerRow.length;
      const len = (c) => FB.inlineToPlain(c.children || []).length;
      const weights = [];
      for (let i = 0; i < cols; i++) {
        let m = len(block.headerRow[i]);
        block.rows.forEach((r) => { if (r[i]) m = Math.max(m, len(r[i])); });
        weights.push(Math.min(Math.max(m, 6), 40));
      }
      const total = weights.reduce((a, b) => a + b, 0);
      const w = (i) => 'width:' + Math.round((weights[i] / total) * 100) + '%;';
      const head =
        '<tr>' +
        block.headerRow
          .map((c, i) => '<td style="' + CELL + w(i) + 'background-color:#f1f3f4;"><b>' + renderInline(c.children) + '</b></td>')
          .join('') +
        '</tr>';
      const body = block.rows
        .map((r) => '<tr>' + r.map((c, i) => '<td style="' + CELL + w(i) + '">' + renderInline(c.children) + '</td>').join('') + '</tr>')
        .join('');
      return '<table style="border-collapse:collapse;width:100%;"><tbody>' + head + body + '</tbody></table><p></p>';
    }

    case 'divider':
      return '<hr>';

    case 'unsupported':
      return box('<p><span style="font-family:' + MONO + ';">' + FB.escapeHtml(block.raw || '') + '</span></p>', '#f1f3f4');

    default:
      return '';
  }
}

function renderItem(children) {
  return (children || [])
    .map((b) => (b.type === 'paragraph' ? renderInline(b.children) : renderBlock(b)))
    .join('');
}

function renderInline(children) {
  return (children || []).map(renderInlineNode).join('');
}

function renderInlineNode(node) {
  switch (node.type) {
    case 'text': {
      let t = FB.escapeHtml(node.text);
      if (node.code) {
        t = '<span style="font-family:' + MONO + ';background-color:#f1f3f4;">' + t + '</span>';
      }
      if (node.strike) t = '<s>' + t + '</s>';
      if (node.italic) t = '<i>' + t + '</i>';
      if (node.bold) t = '<b>' + t + '</b>';
      return t;
    }
    case 'link':
      if (node.person && /^mailto:/i.test(node.href)) {
        // Docs turns this markup into a people chip (the same thing its own
        // @ picker makes): the name and email ride in data-rich-links.
        const email = node.href.replace(/^mailto:/i, '');
        const info = JSON.stringify({ per_n: node.person, per_e: email, type: 'person' });
        return (
          '<a href="mailto:' + FB.escapeHtml(email) + '" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#1155cc;font-weight:700;text-decoration:underline;" data-rich-links="' +
          FB.escapeHtml(info) + '">' + FB.escapeHtml(node.person) + '</span></a>'
        );
      }
      return '<a href="' + FB.escapeHtml(node.href) + '">' + renderInline(node.children) + '</a>';
    case 'image':
      return '<img src="' + FB.escapeHtml(node.src) + '" alt="' + FB.escapeHtml(node.alt || '') + '">';
    case 'mention':
      return '<b>@' + FB.escapeHtml(node.displayName) + '</b>';
    case 'emoji':
      return FB.emojiChar(node.shortcode) || ':' + FB.escapeHtml(node.shortcode) + ':';
    case 'hardBreak':
      return '<br>';
    default:
      return '';
  }
}
})();
