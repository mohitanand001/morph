// Turns the converted document into a list of simple page items for the PDF drawer:
// styled text (Pango markup), code boxes, quotes, panels, tables, rules. No drawing here,
// so it can be tested anywhere. daemon/pdf.js lays these out on pages with Cairo and Pango.
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Characters Pango's markup parser or the PDF can't take.
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
const SIZE = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 12 };
const PANEL = { note: '#f1f3f4', info: '#e8f0fe', success: '#e6f4ea', warning: '#fef7e0', error: '#fce8e6' };
const LINK = '#0969da';

function inline(nodes) {
  return (nodes || []).map((n) => {
    switch (n.type) {
      case 'text': {
        let t = esc(clean(n.text));
        if (n.code) t = '<span font_family="monospace" background="#eef0f2">' + t + '</span>';
        if (n.strike) t = '<s>' + t + '</s>';
        if (n.italic) t = '<i>' + t + '</i>';
        if (n.bold) t = '<b>' + t + '</b>';
        return t;
      }
      case 'link': return '<span foreground="' + LINK + '" underline="single">' + inline(n.children) + '</span>';
      case 'image': return '<span foreground="' + LINK + '" underline="single">' + esc(clean(n.alt || 'image')) + '</span>';
      case 'mention': return '<b>@' + esc(clean(n.displayName)) + '</b>';
      case 'emoji': return esc((FB.emojiChar && FB.emojiChar(n.shortcode)) || ':' + n.shortcode + ':');
      case 'hardBreak': return '\n';
      default: return '';
    }
  }).join('');
}

function listItems(kind, items, start, depth, out) {
  (items || []).forEach((it, i) => {
    const mark = it.checked !== undefined ? (it.checked ? '☑' : '☐') : kind === 'ol' ? ((start || 1) + i) + '.' : '•';
    const kids = it.children || [];
    const first = kids.find((k) => k.type === 'paragraph');
    const text = kids.filter((k) => k.type === 'paragraph').map((k) => inline(k.children)).join('\n');
    out.push({ kind: 'text', markup: text || '', size: 11, indent: 14 + depth * 18, mark, before: 0, after: 3 });
    kids.filter((k) => k !== first && k.type !== 'paragraph').forEach((k) => blockInto(k, out, depth + 1));
    if (it.nested) (it.nested || []).forEach((k) => blockInto(k, out, depth + 1));
  });
}

function blockInto(b, out, depth) {
  const d = depth || 0;
  switch (b.type) {
    case 'heading': out.push({ kind: 'text', markup: '<b>' + inline(b.children) + '</b>', size: SIZE[b.level] || 13, indent: d * 18, before: 10, after: 5, keepNext: true }); break;
    case 'paragraph': out.push({ kind: 'text', markup: inline(b.children), size: 11, indent: d * 18, before: 0, after: 7 }); break;
    case 'bulletList': listItems('ul', b.items, 1, d, out); out.push({ kind: 'gap', h: 4 }); break;
    case 'orderedList': listItems('ol', b.items, b.start, d, out); out.push({ kind: 'gap', h: 4 }); break;
    case 'taskList': listItems('ul', (b.items || []).map((i) => Object.assign({}, i, { checked: !!i.checked })), 1, d, out); out.push({ kind: 'gap', h: 4 }); break;
    case 'codeBlock': out.push({ kind: 'code', markup: esc(clean((b.content || '').replace(/\t/g, '    '))), size: 9.5, indent: d * 18, before: 2, after: 9 }); break;
    case 'blockquote': { const sub = []; (b.children || []).forEach((k) => blockInto(k, sub, d)); sub.forEach((s) => { if (s.kind === 'text' || s.kind === 'code') s.quote = true; out.push(s); }); break; }
    case 'panel': {
      const label = ((FB.PANEL_ICON && FB.PANEL_ICON[b.variant]) || '') + ' ' + ((FB.PANEL_LABEL && FB.PANEL_LABEL[b.variant]) || '');
      const sub = [{ kind: 'text', markup: '<b>' + esc(label.trim()) + '</b>', size: 11, indent: d * 18, before: 0, after: 4 }];
      (b.children || []).forEach((k) => blockInto(k, sub, d));
      sub.forEach((s) => { s.bg = PANEL[b.variant] || PANEL.note; out.push(s); });
      out.push({ kind: 'gap', h: 6 });
      break;
    }
    case 'table': {
      const cells = (row) => row.map((c) => inline(c.children));
      out.push({ kind: 'table', head: cells(b.headerRow || []), rows: (b.rows || []).map(cells), size: 10, indent: d * 18, before: 2, after: 10 });
      break;
    }
    case 'divider': out.push({ kind: 'rule', before: 6, after: 8 }); break;
    case 'unsupported': out.push({ kind: 'code', markup: esc(clean(b.raw || '')), size: 9.5, indent: d * 18, before: 2, after: 9 }); break;
    default: break;
  }
}

// ast -> [{ kind: 'text'|'code'|'table'|'rule'|'gap', ... }]
function pdfItems(ast) {
  const out = [];
  ((ast && ast.children) || []).forEach((b) => blockInto(b, out, 0));
  return out;
}

module.exports = { pdfItems, esc, clean };
