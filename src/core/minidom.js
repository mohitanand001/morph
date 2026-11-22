(function () {
// A small HTML parser with just enough of the DOM for normalize-html.js, so the converter
// can run where there is no browser (GJS on GNOME, JavaScriptCore on a Mac, Node in tests).
// It reads what apps put on the clipboard: fragments from Docs, Slack, Confluence, Jira,
// Word, VS Code and the like. It is not a full HTML5 parser.
window.FB = window.FB || {};

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
FB.NODE = { ELEMENT_NODE: ELEMENT, TEXT_NODE: TEXT, COMMENT_NODE: COMMENT };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// What closes an open <p> when it starts.
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const FORMATTING = new Set(['b', 'big', 'code', 'em', 'font', 'i', 's', 'small', 'strike', 'strong', 'tt', 'u']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', plusmn: '±', times: '×', divide: '÷',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', shy: '­', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', iexcl: '¡', iquest: '¿',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', check: '✓', hearts: '♥', loz: '◊',
};
function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!cp || cp > 0x10ffff) return '�';
      try { return String.fromCodePoint(cp); } catch (e) { return '�'; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
  });
}

// ------------------------------------------------------------------ nodes
class MNode {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === ELEMENT ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  get textContent() {
    if (this.nodeType === TEXT || this.nodeType === COMMENT) return this.data;
    let out = '';
    for (const c of this.childNodes) if (c.nodeType !== COMMENT) out += c.textContent;
    return out;
  }
}
class MText extends MNode {
  constructor(data) { super(TEXT); this.data = data; this.nodeName = '#text'; }
  cloneNode() { return new MText(this.data); }
}
class MComment extends MNode {
  constructor(data) { super(COMMENT); this.data = data; this.nodeName = '#comment'; }
  cloneNode() { return new MComment(this.data); }
}
class MElement extends MNode {
  constructor(tag) {
    super(ELEMENT);
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeName = this.tagName;
    this.attrs = {};
  }
  getAttribute(n) { const v = this.attrs[String(n).toLowerCase()]; return v === undefined ? null : v; }
  hasAttribute(n) { return this.attrs[String(n).toLowerCase()] !== undefined; }
  setAttribute(n, v) { this.attrs[String(n).toLowerCase()] = String(v); }
  get children() { return this.childNodes.filter((c) => c.nodeType === ELEMENT); }
  get firstElementChild() { return this.children[0] || null; }
  cloneNode(deep) {
    const c = new MElement(this.localName);
    c.attrs = Object.assign({}, this.attrs);
    if (deep) this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true)));
    return c;
  }
  matches(sel) { return parseSelectors(sel).some((s) => matchComplex(this, s, this)); }
  closest(sel) {
    const list = parseSelectors(sel);
    for (let n = this; n && n.nodeType === ELEMENT; n = n.parentNode) if (list.some((s) => matchComplex(n, s, null))) return n;
    return null;
  }
  querySelectorAll(sel) {
    const list = parseSelectors(sel);
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== ELEMENT) continue;
        if (list.some((s) => matchComplex(c, s, this))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// ------------------------------------------------------------------ selectors
// Supports: tag, *, [attr], [attr=v], [attr*=v], [attr^=v], [attr$=v], .class, #id, :scope,
// compound selectors, the descendant and child combinators, and comma lists.
const selCache = new Map();
function splitTop(s, ch) {
  const out = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (const c of s) {
    if (q) { if (c === q) q = ''; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === ch && !depth) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
function parseCompound(src) {
  const c = { tag: '', tests: [] };
  let i = 0;
  const ident = () => { const m = /^[A-Za-z0-9_\-]+/.exec(src.slice(i)); if (!m) throw new Error('bad selector: ' + src); i += m[0].length; return m[0]; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '*') { i++; } else if (ch === '.') { i++; const n = ident(); c.tests.push((e) => (e.getAttribute('class') || '').split(/\s+/).includes(n)); } else if (ch === '#') { i++; const n = ident(); c.tests.push((e) => e.getAttribute('id') === n); } else if (ch === ':') {
      i++; const n = ident();
      if (n === 'scope') c.tests.push((e, scope) => e === scope); else throw new Error('unsupported pseudo-class: ' + n);
    } else if (ch === '[') {
      const end = src.indexOf(']', i);
      const m = /^\s*([A-Za-z0-9_\-:]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*)))?\s*$/.exec(src.slice(i + 1, end));
      if (!m) throw new Error('bad attribute selector: ' + src);
      const name = m[1].toLowerCase();
      const op = m[2];
      const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
      c.tests.push((e) => {
        const v = e.getAttribute(name);
        if (v === null) return false;
        if (!op) return true;
        if (op === '=') return v === val;
        if (op === '*=') return val !== '' && v.indexOf(val) >= 0;
        if (op === '^=') return val !== '' && v.startsWith(val);
        if (op === '$=') return val !== '' && v.endsWith(val);
        if (op === '~=') return v.split(/\s+/).includes(val);
        return false;
      });
      i = end + 1;
    } else if (!c.tag) { c.tag = ident().toLowerCase(); } else throw new Error('bad selector: ' + src);
  }
  return c;
}
function parseSelectors(sel) {
  if (selCache.has(sel)) return selCache.get(sel);
  const list = splitTop(String(sel), ',').map((part) => withCombinators(part.trim()));
  selCache.set(sel, list);
  return list;
}
function withCombinators(part) {
  const out = [];
  let comb = ' ';
  let cur = '';
  let depth = 0;
  let q = '';
  const flush = () => { if (cur) { out.push({ comb, c: parseCompound(cur) }); cur = ''; comb = ' '; } };
  for (const ch of part) {
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (!depth && /\s/.test(ch)) { flush(); continue; }
    if (!depth && ch === '>') { flush(); comb = '>'; continue; }
    cur += ch;
  }
  flush();
  return out;
}
function matchCompound(el, c, scope) {
  if (c.tag && el.localName !== c.tag) return false;
  return c.tests.every((t) => t(el, scope));
}
// Match from the right: the last compound must match el, then walk up for the rest.
function matchComplex(el, steps, scope) {
  const last = steps.length - 1;
  if (!matchCompound(el, steps[last].c, scope)) return false;
  const up = (node, i) => {
    if (i < 0) return true;
    const step = steps[i];
    const need = steps[i + 1].comb; // how steps[i+1] relates to steps[i]
    if (need === '>') {
      const p = node.parentNode;
      return !!p && p.nodeType === ELEMENT && matchCompound(p, step.c, scope) && up(p, i - 1);
    }
    for (let p = node.parentNode; p && p.nodeType === ELEMENT; p = p.parentNode) {
      if (matchCompound(p, step.c, scope) && up(p, i - 1)) return true;
    }
    return false;
  };
  // :scope as the first compound refers to the scope element itself, which is not an ancestor match target
  return up(el, last - 1);
}

// ------------------------------------------------------------------ parser
function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (attrs[name] !== undefined) continue; // the first one wins, like a browser
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = decode(v);
  }
  return attrs;
}

FB.parseHtml = function parseHtml(html) {
  const src = String(html == null ? '' : html);
  const root = new MElement('body');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const has = (tag, stopAt) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].localName === tag) return i;
      if (stopAt && stopAt.has(stack[i].localName)) return -1;
    }
    return -1;
  };
  const popTo = (i) => { stack.length = i; };
  const closeP = () => { const i = has('p', new Set(['button', 'td', 'th', 'caption', 'li', 'table', 'ul', 'ol', 'div', 'blockquote'])); if (i > 0) popTo(i); };
  const addText = (t) => {
    if (!t) return;
    const parent = top();
    const last = parent.lastChild;
    if (last && last.nodeType === TEXT) last.data += t;
    else parent.appendChild(new MText(t));
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decode(src.slice(i))); break; }
    if (lt > i) addText(decode(src.slice(i, lt)));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const data = src.slice(i + 4, end < 0 ? n : end);
      top().appendChild(new MComment(data));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') { // doctype, CDATA, processing instruction: skip
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src[i + 1] === '/') { // end tag
      const m = /^<\/([A-Za-z][^\s>\/]*)[^>]*>?/.exec(src.slice(i, i + 200));
      if (!m) { addText('<'); i++; continue; }
      i += m[0].length;
      const tag = m[1].toLowerCase();
      if (VOID.has(tag)) continue;
      const idx = has(tag, tag === 'li' ? new Set(['ul', 'ol']) : null);
      if (idx > 0) {
        // <b>bold <i>both</b> italic</i>: a browser closes the bold and reopens the italic after it.
        const above = stack.slice(idx + 1);
        const reopen = FORMATTING.has(tag) && above.length && above.every((e) => FORMATTING.has(e.localName)) ? above : [];
        popTo(idx);
        reopen.forEach((e) => { const c = e.cloneNode(false); top().appendChild(c); stack.push(c); });
      }
      continue;
    }
    const m = /^<([A-Za-z][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(src.slice(i));
    if (!m) { addText('<'); i++; continue; }
    i += m[0].length;
    const tag = m[1].toLowerCase();
    const attrSrc = m[2].replace(/\/\s*$/, '');
    const el = new MElement(tag);
    el.attrs = parseAttrs(attrSrc);

    // implied end tags
    if (CLOSES_P.has(tag)) closeP();
    if (tag === 'li') { const j = has('li', new Set(['ul', 'ol'])); if (j > 0) popTo(j); } else if (tag === 'dt' || tag === 'dd') { for (const t of ['dt', 'dd']) { const j = has(t, new Set(['dl'])); if (j > 0) { popTo(j); break; } } } else if (tag === 'tr') { const j = has('tr', new Set(['table'])); if (j > 0) popTo(j); } else if (tag === 'td' || tag === 'th') { for (const t of ['td', 'th']) { const j = has(t, new Set(['tr', 'table'])); if (j > 0) { popTo(j); break; } } } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') { for (const t of ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']) { const j = has(t, new Set(['table'])); if (j > 0) { popTo(j); break; } } } else if (tag === 'option') { const j = has('option', new Set(['select'])); if (j > 0) popTo(j); } else if (HEADINGS.has(tag)) { const t = top(); if (HEADINGS.has(t.localName)) stack.pop(); }

    // a <tr> directly inside <table> gets a <tbody>, like a browser does
    if (tag === 'tr' && top().localName === 'table') {
      const tb = new MElement('tbody');
      top().appendChild(tb);
      stack.push(tb);
    }
    top().appendChild(el);
    if (VOID.has(tag)) continue;
    if (RAW.has(tag)) {
      const close = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = src.slice(i);
      const cm = close.exec(rest);
      const body = cm ? rest.slice(0, cm.index) : rest;
      if (body) el.appendChild(new MText(tag === 'textarea' || tag === 'title' ? decode(body) : body));
      i += cm ? cm.index + cm[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
  return { body: root, documentElement: root };
};

FB.createElement = function createElement(tag) { return new MElement(tag); };
})();
