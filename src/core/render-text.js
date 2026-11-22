(function () {
// Plain text: no marks at all. For terminals, commit messages, SMS, and any
// box that takes text only. Tables become aligned columns.
window.FB = window.FB || {};

FB.astToPlainText = function astToPlainText(ast) {
  return (ast.children || []).map((b) => block(b, 0)).filter((s) => s !== '').join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
};

function inline(nodes) {
  return (nodes || []).map((n) => {
    switch (n.type) {
      case 'text': return n.text;
      case 'link': {
        const label = inline(n.children);
        const shown = n.href.replace(/^mailto:/i, '');
        return label && label !== shown ? label + ' (' + shown + ')' : shown;
      }
      case 'image': return (n.alt ? n.alt + ' ' : '') + '(' + n.src + ')';
      case 'mention': return '@' + n.displayName + (n.email ? ' (' + n.email + ')' : '');
      case 'emoji': return FB.emojiChar(n.shortcode) || ':' + n.shortcode + ':';
      case 'hardBreak': return '\n';
      default: return '';
    }
  }).join('');
}

function list(items, ordered, start, depth) {
  const pad = '  '.repeat(depth);
  return items.map((it, i) => {
    const mark = it.checked !== undefined ? (it.checked ? '[x] ' : '[ ] ') : '';
    const bullet = ordered ? (start + i) + '. ' : '- ';
    const parts = (it.children || []).map((c) => (c.type === 'paragraph' ? inline(c.children) : block(c, depth + 1)));
    let s = pad + bullet + mark + parts.shift();
    parts.forEach((p) => { s += '\n' + p; });
    if (it.nested) it.nested.forEach((n) => { s += '\n' + block(n, depth + 1); });
    return s;
  }).join('\n');
}

function table(b) {
  const rows = [b.headerRow.map((c) => inline(c.children).replace(/\s*\n\s*/g, ' '))]
    .concat(b.rows.map((r) => r.map((c) => inline(c.children).replace(/\s*\n\s*/g, ' '))));
  const w = b.headerRow.map((_, i) => Math.max(...rows.map((r) => Array.from(r[i] || '').length)));
  const fmt = (r) => r.map((c, i) => c + ' '.repeat(w[i] - Array.from(c).length)).join(' | ').replace(/\s+$/, '');
  return [fmt(rows[0]), w.map((n) => '-'.repeat(n)).join('-|-')].concat(rows.slice(1).map(fmt)).join('\n');
}

function block(b, depth) {
  switch (b.type) {
    case 'heading': return inline(b.children);
    case 'paragraph': return inline(b.children);
    case 'bulletList': return list(b.items, false, 1, depth);
    case 'orderedList': return list(b.items, true, b.start || 1, depth);
    case 'taskList': return list(b.items.map((i) => Object.assign({}, i, { checked: !!i.checked })), false, 1, depth);
    case 'codeBlock': return b.content || '';
    case 'blockquote': return (b.children || []).map((c) => block(c, depth)).join('\n\n').split('\n').map((l) => '> ' + l).join('\n');
    case 'panel': return (FB.PANEL_LABEL[b.variant] || 'Note').toUpperCase() + ': ' + (b.children || []).map((c) => block(c, depth)).join('\n');
    case 'table': return table(b);
    case 'divider': return '---';
    case 'unsupported': return b.raw || '';
    default: return '';
  }
}
})();
