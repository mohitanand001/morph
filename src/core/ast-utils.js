(function () {
// Shared helpers used by every normalizer and renderer.
window.FB = window.FB || {};

FB.marks = function marks(overrides) {
  return Object.assign({ bold: false, italic: false, strike: false, code: false }, overrides || {});
};

FB.text = function text(value, marks) {
  return Object.assign({ type: 'text', text: value }, FB.marks(marks));
};

// Wrap text in a markdown-style delimiter, keeping leading/trailing
// whitespace OUTSIDE the delimiters. "*bold *" is not bold in Slack or
// GitHub; " *bold* " is.
FB.wrapMark = function wrapMark(text, open, close) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m[2]) return text;
  return m[1] + open + m[2] + (close == null ? open : close) + m[3];
};

function sameMarks(a, b) {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;
}

// Merge adjacent text nodes with identical marks, drop empty ones, and
// recurse into link children. Adjacent "*a**b*" fragments otherwise break
// Slack/GitHub emphasis.
FB.tidyInline = function tidyInline(nodes) {
  const out = [];
  (nodes || []).forEach((n) => {
    if (n.type === 'text') {
      if (!n.text) return;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text' && sameMarks(prev, n)) {
        prev.text += n.text;
        return;
      }
      out.push(Object.assign({}, n));
      return;
    }
    if (n.type === 'link') {
      out.push(Object.assign({}, n, { children: FB.tidyInline(n.children) }));
      return;
    }
    out.push(n);
  });
  return out;
};

// Trim whitespace at the start and end of a run of inline nodes.
FB.trimInline = function trimInline(nodes) {
  const out = FB.tidyInline(nodes);
  while (out.length && out[0].type === 'hardBreak') out.shift();
  while (out.length && out[out.length - 1].type === 'hardBreak') out.pop();
  if (out.length && out[0].type === 'text' && !out[0].code) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    if (!out[0].text) out.shift();
  }
  const last = out[out.length - 1];
  if (last && last.type === 'text' && !last.code) {
    last.text = last.text.replace(/\s+$/, '');
    if (!last.text) out.pop();
  }
  return out;
};

FB.inlineToPlain = function inlineToPlain(nodes) {
  return (nodes || [])
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'link') return FB.inlineToPlain(n.children);
      if (n.type === 'mention') return '@' + n.displayName;
      if (n.type === 'emoji') return FB.emojiChar(n.shortcode) || ':' + n.shortcode + ':';
      if (n.type === 'image') return n.alt || '';
      if (n.type === 'hardBreak') return '\n';
      return '';
    })
    .join('');
};

// Visit every block (depth-first), including blocks nested in lists,
// quotes and panels. fn(block, depth).
FB.walkBlocks = function walkBlocks(blocks, fn, depth) {
  depth = depth || 0;
  (blocks || []).forEach((b) => {
    if (!b) return;
    fn(b, depth);
    if (b.children && b.type !== 'paragraph' && b.type !== 'heading') {
      FB.walkBlocks(b.children, fn, depth + 1);
    }
    if (b.items) {
      b.items.forEach((item) => {
        if (b.type !== 'taskList') FB.walkBlocks(item.children, fn, depth + 1);
        if (item.nested) FB.walkBlocks(item.nested, fn, depth + 1);
      });
    }
  });
};

// Visit every inline node in the document.
FB.walkInline = function walkInline(blocks, fn) {
  const visit = (nodes) =>
    (nodes || []).forEach((n) => {
      fn(n);
      if (n.type === 'link') visit(n.children);
    });
  FB.walkBlocks(blocks, (b) => {
    if (b.type === 'paragraph' || b.type === 'heading') visit(b.children);
    if (b.type === 'taskList') b.items.forEach((i) => visit(i.children));
    if (b.type === 'table') {
      b.headerRow.forEach((c) => visit(c.children));
      b.rows.forEach((r) => r.forEach((c) => visit(c.children)));
    }
  });
};

// A short, plain-language description of what's in the document.
FB.astStats = function astStats(ast) {
  const s = { paragraphs: 0, headings: 0, lists: 0, tables: 0, codeBlocks: 0, links: 0, images: 0 };
  FB.walkBlocks(ast.children, (b, depth) => {
    if (b.type === 'paragraph' && depth === 0) s.paragraphs++;
    if (b.type === 'heading') s.headings++;
    if ((b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') && depth === 0) s.lists++;
    if (b.type === 'table') s.tables++;
    if (b.type === 'codeBlock') s.codeBlocks++;
  });
  FB.walkInline(ast.children, (n) => {
    if (n.type === 'link') s.links++;
    if (n.type === 'image') s.images++;
  });
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const parts = [];
  if (s.headings) parts.push(plural(s.headings, 'heading', 'headings'));
  if (s.paragraphs) parts.push(plural(s.paragraphs, 'paragraph', 'paragraphs'));
  if (s.lists) parts.push(plural(s.lists, 'list', 'lists'));
  if (s.tables) parts.push(plural(s.tables, 'table', 'tables'));
  if (s.codeBlocks) parts.push(plural(s.codeBlocks, 'code block', 'code blocks'));
  if (s.links) parts.push(plural(s.links, 'link', 'links'));
  if (s.images) parts.push(plural(s.images, 'image', 'images'));
  s.summary = parts.join(', ');
  return s;
};

FB.escapeHtml = function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

// Common shortcodes (Slack and GitHub both use them). Destinations that
// don't understand shortcodes (Jira, Docs) get the real character.
const EMOJI = {
  smile: '😄', smiley: '😃', grinning: '😀', joy: '😂', slightly_smiling_face: '🙂', wink: '😉',
  thinking_face: '🤔', thinking: '🤔', sweat_smile: '😅', sob: '😭', cry: '😢', heart_eyes: '😍',
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', clap: '👏', raised_hands: '🙌', pray: '🙏',
  wave: '👋', ok_hand: '👌', muscle: '💪', point_right: '👉', point_up: '☝️', eyes: '👀',
  heart: '❤️', fire: '🔥', rocket: '🚀', tada: '🎉', sparkles: '✨', star: '⭐', boom: '💥', zap: '⚡',
  white_check_mark: '✅', heavy_check_mark: '✔️', check: '✔️', x: '❌', warning: '⚠️', no_entry: '⛔',
  rotating_light: '🚨', red_circle: '🔴', large_green_circle: '🟢', green_circle: '🟢',
  large_yellow_circle: '🟡', yellow_circle: '🟡', bulb: '💡', memo: '📝', pushpin: '📌',
  calendar: '📅', hourglass: '⌛', hourglass_flowing_sand: '⏳', lock: '🔒', key: '🔑', bug: '🐛',
  wrench: '🔧', hammer_and_wrench: '🛠️', gear: '⚙️', chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉', information_source: 'ℹ️', question: '❓', exclamation: '❗',
  coffee: '☕', 100: '💯', arrow_right: '➡️', link: '🔗', mag: '🔍', package: '📦', ship: '🚢',
};

FB.emojiChar = function emojiChar(shortcode) {
  return EMOJI[String(shortcode || '').toLowerCase()] || null;
};

FB.isKnownEmoji = function isKnownEmoji(shortcode) {
  return Object.prototype.hasOwnProperty.call(EMOJI, String(shortcode || '').toLowerCase());
};

// Panel variant <-> GitHub alert type.
FB.PANEL_TO_ALERT = { note: 'NOTE', info: 'IMPORTANT', success: 'TIP', warning: 'WARNING', error: 'CAUTION' };
FB.ALERT_TO_PANEL = { NOTE: 'note', IMPORTANT: 'info', TIP: 'success', WARNING: 'warning', CAUTION: 'error' };
FB.PANEL_LABEL = { note: 'Note', info: 'Info', success: 'Tip', warning: 'Warning', error: 'Error' };
FB.PANEL_ICON = { note: '📝', info: 'ℹ️', success: '✅', warning: '⚠️', error: '🛑' };

// Slack turns "<url|label>" into links, and a mention can come back as a
// link to /team/U123 whose text is the whole "url|label" string. Split that
// apart; report whether it points at a person.
FB.cleanSlackLink = function cleanSlackLink(href, text) {
  let h = String(href || '').trim();
  let label = String(text || '').trim().replace(/^</, '').replace(/>$/, '');
  const m = label.match(/^(https?:\/\/[^|\s]+)\|(.+)$/);
  if (m) { if (!h || h.indexOf(m[1]) === 0) h = m[1]; label = m[2]; }
  if (h.includes('|')) { const k = h.indexOf('|'); if (!label) label = h.slice(k + 1); h = h.slice(0, k); }
  if (label.includes('|') && /^https?:/i.test(label)) label = label.slice(label.lastIndexOf('|') + 1);
  const isUser = /^https?:\/\/[^/]*slack\.com\/team\/[UW][A-Z0-9]+/i.test(h);
  return { href: h, label: label.trim(), isUser };
};
})();
