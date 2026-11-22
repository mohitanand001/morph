(function () {
// Renders the shared AST as HTML for email: Gmail, Outlook (desktop, web,
// Mac), Apple Mail.
//
// Email is the least forgiving destination. Outlook for Windows renders with
// Word's engine: no CSS classes, no white-space:pre, no border-radius, and
// paragraph margins it invents itself. Gmail strips <style> blocks. So:
// - every style is inline, on the element it applies to;
// - tables carry both the old border/cellpadding attributes and inline CSS;
// - code keeps its indentation with &nbsp; and <br>, inside a shaded cell;
// - lists use explicit margins so Outlook doesn't double-indent them;
// - a fallback font stack on every text element.
window.FB = window.FB || {};

const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;";
const MONO = "font-family:Consolas,'Courier New',monospace;font-size:13px;";
const PANEL = { note: '#f1f3f4', info: '#e8f0fe', success: '#e6f4ea', warning: '#fef7e0', error: '#fce8e6' };
const P = 'margin:0 0 10px 0;' + FONT;

FB.astToEmailHtml = function astToEmailHtml(ast) {
  return '<div style="' + FONT + '">' + blocks(ast.children) + '</div>';
};

function blocks(list) {
  return (list || []).map(block).filter(Boolean).join('');
}

function cellBox(inner, bg) {
  return (
    '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 12px 0;">' +
    '<tr><td bgcolor="' + bg + '" style="background-color:' + bg + ';padding:10px 12px;">' + inner + '</td></tr></table>'
  );
}

function listHtml(tag, items, start) {
  const attr = tag === 'ol' && start && start !== 1 ? ' start="' + start + '"' : '';
  return (
    '<' + tag + attr + ' style="margin:0 0 10px 0;padding-left:24px;">' +
    items.map((it) => '<li style="margin:0 0 4px 0;' + FONT + '">' + item(it) + '</li>').join('') +
    '</' + tag + '>'
  );
}

function item(it) {
  const prefix = it.checked === undefined ? '' : it.checked ? '☑ ' : '☐ ';
  const kids = it.children || [];
  const html = kids
    .map((b, i) => (b.type === 'paragraph' ? (i ? '<br>' : '') + inline(b.children) : block(b)))
    .join('');
  const nested = it.nested ? blocks(it.nested) : '';
  return prefix + html + nested;
}

function block(b) {
  switch (b.type) {
    case 'heading': {
      const size = { 1: 22, 2: 19, 3: 17, 4: 15, 5: 14, 6: 14 }[b.level] || 15;
      return '<p style="margin:16px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:' + size + 'px;font-weight:bold;color:#1f2328;">' + inline(b.children) + '</p>';
    }
    case 'paragraph':
      return '<p style="' + P + '">' + inline(b.children) + '</p>';
    case 'bulletList':
      return listHtml('ul', b.items);
    case 'orderedList':
      return listHtml('ol', b.items, b.start);
    case 'taskList':
      return listHtml('ul', b.items.map((i) => Object.assign({}, i, { checked: !!i.checked })));
    case 'codeBlock': {
      const lines = (b.content || '').replace(/\t/g, '    ').split('\n');
      const html = lines.map((l) => FB.escapeHtml(l).replace(/ /g, '&nbsp;') || '&nbsp;').join('<br>');
      return cellBox('<div style="' + MONO + 'color:#1f2328;">' + html + '</div>', '#f3f4f6');
    }
    case 'blockquote':
      return (
        '<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px 0;"><tr>' +
        '<td width="3" bgcolor="#d0d7de" style="background-color:#d0d7de;width:3px;"></td>' +
        '<td style="padding:2px 0 2px 12px;color:#57606a;">' + blocks(b.children) + '</td></tr></table>'
      );
    case 'panel': {
      const label = '<p style="' + P + 'font-weight:bold;">' + FB.PANEL_ICON[b.variant] + ' ' + FB.PANEL_LABEL[b.variant] + '</p>';
      return cellBox(label + blocks(b.children), PANEL[b.variant] || PANEL.note);
    }
    case 'table': {
      const cell = (c, head) =>
        '<td valign="top" style="border:1px solid #c9d1d9;padding:6px 10px;' + FONT + (head ? 'font-weight:bold;background-color:#f3f4f6;' : '') + '"' +
        (head ? ' bgcolor="#f3f4f6"' : '') + '>' + inline(c.children) + '</td>';
      return (
        '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #c9d1d9;margin:0 0 12px 0;">' +
        '<tr>' + b.headerRow.map((c) => cell(c, true)).join('') + '</tr>' +
        b.rows.map((r) => '<tr>' + r.map((c) => cell(c, false)).join('') + '</tr>').join('') +
        '</table>'
      );
    }
    case 'divider':
      return '<hr style="border:0;border-top:1px solid #d0d7de;margin:12px 0;">';
    case 'unsupported':
      return cellBox('<div style="' + MONO + '">' + FB.escapeHtml(b.raw || '') + '</div>', '#f3f4f6');
    default:
      return '';
  }
}

function inline(nodes) {
  return (nodes || []).map((n) => {
    switch (n.type) {
      case 'text': {
        let t = FB.escapeHtml(n.text);
        if (n.code) t = '<span style="' + MONO + 'background-color:#f3f4f6;">' + t + '</span>';
        if (n.strike) t = '<s>' + t + '</s>';
        if (n.italic) t = '<i>' + t + '</i>';
        if (n.bold) t = '<b>' + t + '</b>';
        return t;
      }
      case 'link':
        return '<a href="' + FB.escapeHtml(n.href) + '" style="color:#0969da;text-decoration:underline;">' + inline(n.children) + '</a>';
      case 'image':
        return '<a href="' + FB.escapeHtml(n.src) + '" style="color:#0969da;">' + FB.escapeHtml(n.alt || 'image') + '</a>';
      case 'mention':
        return n.email
          ? '<a href="mailto:' + FB.escapeHtml(n.email) + '" style="color:#0969da;">@' + FB.escapeHtml(n.displayName) + '</a>'
          : '<b>@' + FB.escapeHtml(n.displayName) + '</b>';
      case 'emoji':
        return FB.emojiChar(n.shortcode) || ':' + FB.escapeHtml(n.shortcode) + ':';
      case 'hardBreak':
        return '<br>';
      default:
        return '';
    }
  }).join('');
}
})();
