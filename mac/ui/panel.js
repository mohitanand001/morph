// Morph's panel on the Mac: draws the "pill spec" that daemon/core.js makes (the same one the GNOME helper draws),
// and sends clicks back as "<verb>:<arg>". Text is only ever set as text (never as markup); colours and actions are
// checked before use. The app calls window.morphRender(json) with each new spec, and morphClose() on a click
// elsewhere on the screen. The page tells the app its size and asks it to move the window while you drag.
(function () {
  'use strict';
  const ICONS = window.MORPH_ICONS || { dest: {}, svg: {}, ui: {}, tab: [] };
  const ACTION_RE = /^[a-z]+:[a-z0-9]*$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const IDLE_MS = 12000;
  const BUSY_MAX_MS = 6000;
  const root = document.getElementById('root');
  const str = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max || 80);
  const arr = (v, n) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, n || 20) : []);

  // To the app: the Mac app's message handler, or (in tests) a list on the page.
  function post(msg) {
    try { window.webkit.messageHandlers.morph.postMessage(msg); } catch (e) { (window.__morphPosts = window.__morphPosts || []).push(msg); }
  }
  function send(a) { a = str(a, 60); if (ACTION_RE.test(a)) post({ type: 'action', action: a }); }

  let spec = { visible: false };
  let open = false;
  let busy = null;
  let busyTimer = 0, idleTimer = 0, collapseTimer = 0, scribbleTimer = 0;
  let hovering = false;
  let screenH = 800;
  let tabKey = '';
  let keepScroll = null;
  let press = null;     // a press on the tab or the title bar: a click, or the start of a move
  let reorder = null;   // dragging an app in Settings → Apps
  let welcomeDone = false;
  let pendingRender = false;

  // ---------------------------------------------------------------- small builders
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const NS = 'http://www.w3.org/2000/svg';
  // A Material glyph in one colour.
  function gl(name, color, size) {
    const s = size || 18;
    const box = el('span', 'ico');
    box.style.width = s + 'px'; box.style.height = s + 'px';
    const d = ICONS.ui[name];
    if (!d) return box;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960'); svg.setAttribute('width', s); svg.setAttribute('height', s);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', COLOR_RE.test(color || '') ? color : '#93a1a1');
    svg.appendChild(p);
    box.appendChild(svg);
    return box;
  }
  // An app's own mark (our own icon file only: never markup from the spec).
  const parser = new DOMParser();
  function svgMark(key, size) {
    const src = ICONS.svg[key];
    if (!src) return null;
    const doc = parser.parseFromString(src, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName !== 'svg') return null;
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    const box = el('span', 'ico');
    box.appendChild(document.importNode(svg, true));
    return box;
  }
  function destIcon(id, small) {
    const key = ICONS.dest[str(id, 20)];
    const mark = key ? svgMark(key, small ? 14 : 15) : null;
    if (!mark) return null;
    if (small) return mark;
    const t = el('span', 'dico');
    t.appendChild(mark);
    return t;
  }
  function tile(cls, name, color, size) { const t = el('span', cls); t.appendChild(gl(name, color, size)); return t; }
  function chipDot(o) {
    const ic = o.dest ? destIcon(o.dest) : null;
    if (ic) return ic;
    const d = el('span', 'kdot');
    if (COLOR_RE.test(o.color || '')) d.style.background = o.color;
    return d;
  }
  function toggle(on) { const s = el('span', 'sw' + (on ? ' on' : '')); s.appendChild(el('span', 'sw-knob')); return s; }
  // Hover labels, under the button (like the GNOME panel).
  let tipEl = null, tipTimer = 0;
  function tip(b, text) {
    if (!text) return;
    b.setAttribute('aria-label', text);
    b.addEventListener('mouseenter', () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        if (!b.isConnected || press || reorder) return;
        if (!tipEl) { tipEl = el('div', 'tip'); document.body.appendChild(tipEl); }
        tipEl.textContent = text;
        const r = b.getBoundingClientRect();
        tipEl.classList.add('show');
        const w = tipEl.offsetWidth;
        tipEl.style.left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 4)) + 'px';
        tipEl.style.top = Math.min(r.bottom + 6, window.innerHeight - 26) + 'px';
      }, 450);
    });
    b.addEventListener('mouseleave', hideTip);
    b.addEventListener('mousedown', hideTip);
  }
  function hideTip() { clearTimeout(tipTimer); if (tipEl) tipEl.classList.remove('show'); }
  function ib(cls, name, title, onClick) {
    const b = el('button', 'ib ' + cls);
    b.appendChild(gl(name, '#657b83', 18));
    b.addEventListener('click', onClick);
    tip(b, title);
    return b;
  }

  // A button that answers a click with "…" until Morph replies.
  function busyable(b, action, label, labelEl) {
    if (busy && busy.action === action) { b.classList.add('busy'); b.disabled = true; if (labelEl && busy.label) labelEl.textContent = busy.label; }
    b.addEventListener('click', () => {
      if (label) setBusy(action, label);
      send(action);
    });
  }
  function setBusy(action, label) {
    busy = { action, label: str(label, 40) };
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => { busy = null; render(); }, BUSY_MAX_MS);
    render();
  }

  // ---------------------------------------------------------------- the tab
  function tab(s) {
    const t = el('div', 'tab');
    const strip = arr(s.tab, 4);
    const hit = el('span', 'ico tab-icon');
    hit.title = 'Open Morph';
    setTabFrame(hit, 0);
    t.appendChild(hit);
    const dot = el('span', 'tab-dot' + (s.dot === 'has' ? ' has' : s.dot === 'ok' ? ' ok' : ''));
    if (s.dot === 'has' && COLOR_RE.test(s.handleColor || '')) dot.style.background = s.handleColor;
    if (!(s.dot === 'has' || s.dot === 'ok')) dot.classList.add('hidden');
    t.appendChild(dot);
    if (strip.length) {
      t.classList.add('strip');
      const box = el('div', 'tab-strip');
      strip.forEach((o) => {
        const b = el('button', 'sbtn' + (o.off ? ' off' : ''));
        b.title = o.done ? 'Copied' : o.off ? 'Copy something first' : 'Copy for ' + str(o.label, 20);
        const mark = o.done ? gl('check', '#5a6e00', 14) : o.dest ? destIcon(o.dest, true) : null;
        if (mark) b.appendChild(mark);
        const act = str(o.action);
        if (!o.done && !o.off && ACTION_RE.test(act)) b.addEventListener('click', (e) => { e.stopPropagation(); send(act); });
        else b.disabled = true;
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        box.appendChild(b);
      });
      t.appendChild(box);
    }
    t.addEventListener('mousedown', (e) => startPress(e, true));
    // the tab scribbles when something new is copied
    const copied = s.dot === 'has' || s.dot === 'ok';
    const key = copied ? JSON.stringify([s.copyId || 0, s.source && s.source.title, s.source && s.source.sub]) : '';
    if (copied && key !== tabKey) scribble(hit);
    tabKey = key;
    return t;
  }
  function setTabFrame(hit, i) {
    const src = ICONS.tab[i];
    hit.textContent = '';
    if (!src) { hit.appendChild(gl('content_paste', '#0a3a45', 18)); return; }
    const doc = parser.parseFromString(src, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName !== 'svg') return;
    svg.setAttribute('width', 18); svg.setAttribute('height', 18);
    hit.appendChild(document.importNode(svg, true));
  }
  function scribble(hit) {
    clearInterval(scribbleTimer);
    let i = 0;
    scribbleTimer = setInterval(() => {
      i++;
      const now = document.querySelector('.tab-icon');
      if (!now || i >= ICONS.tab.length) { clearInterval(scribbleTimer); return; }
      setTabFrame(now, i);
    }, 70);
  }

  // ---------------------------------------------------------------- the panel
  function panel(s) {
    const settings = s.view === 'settings';
    const p = el('div', 'panel' + (settings ? ' settings' : ''));
    const bar = el('div', 'bar');
    bar.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) startPress(e, false); });
    if (settings) bar.appendChild(ib('back', 'arrow_back', 'Back', () => send(s.back || 'view:main')));
    else bar.appendChild(tile('logo ico', 'content_paste', '#ffffff', 17));
    bar.appendChild(el('span', 'title', str(settings ? (s.title || 'Settings') : 'Morph', 40)));
    if (!settings && s.gear) bar.appendChild(ib('gear', 'settings', 'Settings', () => send(s.gear)));
    const wc = el('div', 'wc');
    wc.appendChild(ib('x', 'close', 'Close', () => setOpen(false)));
    bar.appendChild(wc);
    p.appendChild(bar);
    if (settings) { p.appendChild(fillSettings(s)); return p; }
    const scroll = el('div', 'scroll');
    const cap = ({ s: 250, l: 420 })[s.size] || 330;
    scroll.style.maxHeight = Math.min(Math.max(220, Math.floor(screenH * 0.8 - 60)), cap) + 'px';
    scroll.dataset.pane = 'main';
    scroll.appendChild(fillMain(s));
    p.appendChild(scroll);
    const footer = arr(s.footer, 2);
    if (footer.length) {
      const slot = el('div', 'foot-slot');
      footer.forEach((o) => {
        const action = str(o.action);
        const b = el('button', 'foot-btn' + (o.done ? ' done' : '') + (o.off ? ' off' : ''));
        b.appendChild(gl(str(o.icon, 20) || 'description', o.done ? '#5a6e00' : '#5c6f72', 16));
        const label = el('span', '', str(o.label, 30));
        b.appendChild(label);
        if (!o.done && !o.off && ACTION_RE.test(action)) busyable(b, action, o.busy, label); else b.disabled = true;
        slot.appendChild(b);
      });
      p.appendChild(slot);
    }
    const links = arr(s.links, 4);
    if (links.length) {
      const foot = el('div', 'links');
      links.forEach((l) => { const b = el('button', 'link', str(l.label, 30)); b.addEventListener('click', () => send(l.action)); foot.appendChild(b); });
      p.appendChild(foot);
    }
    return p;
  }
  function row(o, primary, soft) {
    const b = el('button', 'row' + (primary ? ' primary' : '') + (soft ? ' original' : ''));
    const label = el('span', 'row-label', str(o.label, 40));
    if (o.done) {
      b.classList.add('done');
      b.disabled = true;
      b.appendChild(tile('dico ok', 'check', '#ffffff', 18));
      b.appendChild(label);
      return b;
    }
    b.appendChild((o.dest && destIcon(o.dest)) || tile('dico', /pdf/i.test(str(o.action)) ? 'description' : 'content_paste', '#5c6f72', 18));
    b.appendChild(label);
    if (o.hint && (primary || soft)) b.appendChild(primary ? el('span', 'badge', str(o.hint, 24)) : el('span', 'soft-hint', str(o.hint, 24)));
    if (o.off) { b.classList.add('off'); b.disabled = true; return b; }
    if (o.tip) tip(b, str(o.tip, 60));
    const action = str(o.action);
    if (ACTION_RE.test(action)) busyable(b, action, o.busy, label); else b.disabled = true;
    return b;
  }
  function fillMain(s) {
    const body = el('div', 'body');
    const src = s.source && typeof s.source === 'object' ? s.source : { icon: 'content_paste', title: s.title, sub: '' };
    const card = el('div', 'source');
    const logo = src.dest ? destIcon(src.dest) : null;
    if (logo) { const t = el('span', 'stile'); t.appendChild(logo.firstChild || logo); card.appendChild(t); }
    else card.appendChild(tile('stile', ['table', 'content_paste', 'notes', 'description', 'image', 'lock'].includes(src.icon) ? src.icon : 'content_paste', '#137b72', 22));
    const meta = el('div', 'src-meta');
    meta.appendChild(el('div', 'src-title', str(src.title, 60)));
    const msg = s.sub ? str(s.sub, 160) : '';
    if (msg || src.sub) meta.appendChild(el('div', 'sub' + (msg && s.subTone === 'ok' ? ' ok' : msg && s.subTone === 'warn' ? ' warn' : ''), msg || str(src.sub, 160)));
    card.appendChild(meta);
    const sec = s.secondary && s.secondary.label && ACTION_RE.test(str(s.secondary.action)) ? s.secondary : null;
    if (sec) {
      const act = str(sec.action);
      if (act === 'refresh:' || act === 'orig:') {
        const b = ib('ghost-ib', act === 'orig:' ? 'undo' : 'restart_alt', str(sec.label, 40), () => {});
        b.textContent = '';
        b.appendChild(gl(act === 'orig:' ? 'undo' : 'restart_alt', '#137b72', 18));
        busyable(b, act, sec.busy);
        card.appendChild(b);
      } else {
        const b = el('button', 'ghost', str(sec.label, 30));
        busyable(b, act, sec.busy, b);
        card.appendChild(b);
      }
    } else {
      // No button right now: its room stays, so the card's text never reflows.
      const hold = ib('ghost-ib ghosted', 'undo', '', () => {});
      hold.disabled = true;
      hold.tabIndex = -1;
      card.appendChild(hold);
    }
    body.appendChild(card);
    if (s.note) body.appendChild(el('div', 'note', str(s.note, 90)));
    if (s.primary && s.primary.label) {
      const top = el('div', 'list top');
      top.appendChild(row(s.primary, !s.primary.done));
      body.appendChild(top);
    }
    const opts = [].concat(...(Array.isArray(s.options) ? s.options : []).filter(Array.isArray)).filter((o) => o && typeof o === 'object').slice(0, 14);
    const orig = s.original && s.original.label && (s.original.done || ACTION_RE.test(str(s.original.action))) ? s.original : null;
    if (opts.length) {
      body.appendChild(el('div', 'section', str(s.section || 'Copy it for', 60)));
      const list = el('div', 'list');
      opts.forEach((o) => list.appendChild(row(o, false)));
      if (orig) list.appendChild(row(orig, false, true));
      body.appendChild(list);
    } else if (orig) {
      const list = el('div', 'list');
      list.appendChild(row(orig, false, true));
      body.appendChild(list);
    }
    const recent = arr(s.recent, 5);
    if (recent.length) {
      if (s.recentTitle) body.appendChild(el('div', 'section', str(s.recentTitle, 60)));
      const list = el('div', 'list');
      recent.forEach((h) => list.appendChild(row({ label: h.label, action: h.action, busy: h.busy }, false)));
      body.appendChild(list);
    }
    return body;
  }

  // ---------------------------------------------------------------- Settings
  function setRow(cls, o, right) {
    const b = el('button', cls);
    b.appendChild(o.dest ? chipDot(o) : tile('oi', str(o.icon, 24), '#137b72', 19));
    const t = el('span', 'ot');
    t.appendChild(el('span', 'ot-b', str(o.label, 80)));
    if (o.sub) t.appendChild(el('span', 'ot-s', str(o.sub, 200)));
    if (o.under) t.appendChild(o.under);
    if (o.note) t.appendChild(el('span', 'ot-warn', str(o.note, 40)));
    b.appendChild(t);
    if (o.trail) right = right.concat([tile('oi', str(o.trail, 24), '#137b72', 19)]);
    right.forEach((r) => b.appendChild(r));
    const action = str(o.action);
    if (ACTION_RE.test(action)) b.addEventListener('click', () => send(action)); else b.disabled = true;
    return b;
  }
  function blockButton(x) {
    const kind = x.kind === 'danger' ? 'danger' : x.kind === 'primary' ? 'primary' : 'secondary';
    const b = el('button', 'btn ' + kind + (x.disabled ? ' disabled' : ''), str(x.label, 28));
    if (x.disabled) b.disabled = true; else b.addEventListener('click', () => send(x.action));
    return b;
  }
  function block(b) {
    if (b.kind === 'text') return el('div', 'blk-p', str(b.text, 400));
    if (b.kind === 'buttons') { const r = el('div', 'blk-btns'); arr(b.buttons, 3).forEach((x) => r.appendChild(blockButton(x))); return r; }
    const tone = ['ok', 'warn', 'plain'].includes(b.tone) ? b.tone : 'plain';
    const col = { ok: '#5a6e00', warn: '#946e00', plain: '#5c6f72' }[tone];
    const card = el('div', 'blk ' + tone);
    const head = el('div', 'blk-head');
    if (b.icon) head.appendChild(tile('blk-ic ' + tone, str(b.icon, 24), col, 18));
    head.appendChild(el('div', 'blk-title', str(b.title, 80)));
    card.appendChild(head);
    if (b.text) card.appendChild(el('div', 'blk-text', str(b.text, 320)));
    if (typeof b.progress === 'number' && b.progress >= 0) {
      const bar = el('div', 'prog');
      const on = el('div', 'prog-on');
      on.style.width = Math.round(Math.max(0.02, Math.min(1, b.progress)) * 100) + '%';
      bar.appendChild(on);
      card.appendChild(bar);
    }
    (Array.isArray(b.items) ? b.items : []).slice(0, 8).forEach((x) => card.appendChild(el('div', 'blk-item', (b.kind === 'status' ? '' : '•  ') + str(x, 120))));
    if (b.button && typeof b.button === 'object') card.appendChild(blockButton(b.button));
    return card;
  }
  function fillSettings(s) {
    const H = ({ s: 300, l: 380 })[s.size] || 340;
    const height = Math.min(H, Math.max(220, Math.floor(screenH * 0.8 - 60)));
    const wrap = el('div', 'settings-wrap');
    wrap.style.height = height + 'px';
    const side = el('div', 'side');
    arr(s.nav, 8).forEach((n) => {
      const b = el('button', 'nav' + (n.on ? ' on' : ''));
      b.appendChild(gl(str(n.icon, 20), n.on ? '#137b72' : '#657b83', 20));
      b.appendChild(el('span', '', str(n.label, 20)));
      b.addEventListener('click', () => send(n.action));
      side.appendChild(b);
    });
    const p = s.pane && typeof s.pane === 'object' ? s.pane : {};
    const scroll = el('div', 'scroll content');
    scroll.dataset.pane = str(p.title, 40) || 'pane';
    scroll.appendChild(el('div', 'h2', str(p.title, 40)));
    if (p.lede) scroll.appendChild(el('div', 'lede', str(p.lede, 120)));
    let first = true;
    const sep = (b) => { if (!first) b.classList.add('sep'); first = false; return b; };
    arr(p.blocks, 6).forEach((b) => scroll.appendChild(block(b)));
    arr(p.actions, 6).forEach((o) => scroll.appendChild(sep(setRow('opt', o, []))));
    arr(p.opts, 8).forEach((o) => scroll.appendChild(sep(setRow('opt', o, [toggle(o.sw === 'on')]))));
    arr(p.keys, 10).forEach((k) => {
      const keys = el('span', 'keys');
      (Array.isArray(k.keys) ? k.keys : []).slice(0, 5).forEach((x) => keys.appendChild(el('span', 'kbd', str(x, 8))));
      scroll.appendChild(sep(setRow('opt', { icon: k.icon, label: k.label, note: k.note, action: k.action, under: keys }, [toggle(k.sw === 'on')])));
    });
    const apps = arr(p.apps, 14);
    if (apps.length) {
      const list = el('div', 'applist');
      apps.forEach((x, i) => list.appendChild(appRow(x, i, list)));
      scroll.appendChild(list);
    }
    const cards = arr(p.cards, 3);
    if (cards.length) {
      if (p.cardsTitle) scroll.appendChild(el('div', 'subhead', str(p.cardsTitle, 30)));
      const box = el('div', 'cards');
      cards.forEach((c) => {
        const b = el('button', 'card' + (c.on ? ' on' : ''));
        if (c.size) {
          const holder = el('span', 'wg-holder');
          const wg = el('span', 'wg wg-' + str(c.size, 1));
          wg.appendChild(el('span', 'wg-bar'));
          wg.style.display = 'block';
          holder.appendChild(wg);
          b.appendChild(holder);
        }
        b.appendChild(el('span', 'cl', str(c.label, 20)));
        if (c.sub) b.appendChild(el('span', 'cs', str(c.sub, 30)));
        b.addEventListener('click', () => send(c.action));
        box.appendChild(b);
      });
      scroll.appendChild(box);
    }
    if (Array.isArray(p.tail)) { first = false; arr(p.tail, 3).forEach((o) => scroll.appendChild(sep(setRow('opt tail', o, [])))); }
    if (p.about && typeof p.about === 'object') {
      const hero = el('div', 'hero');
      hero.appendChild(tile('logo logo-big ico', 'content_paste', '#ffffff', 28));
      const ht = el('div');
      ht.appendChild(el('div', 'hero-name', str(p.about.name, 30)));
      ht.appendChild(el('div', 'hero-ver', str(p.about.version, 60)));
      hero.appendChild(ht);
      scroll.appendChild(hero);
      scroll.appendChild(el('div', 'about-text', str(p.about.text, 300)));
      scroll.appendChild(el('div', 'about-legal', str(p.about.legal, 400)));
    }
    wrap.appendChild(side);
    wrap.appendChild(scroll);
    return wrap;
  }
  // An app in Settings → Apps: its mark, its name, its switch. With your own list, press and drag a row to move it.
  function appRow(a, i, list) {
    const r = el('div', 'app-row' + (a.sw === 'off' ? ' off' : '') + (a.sw === 'none' ? ' none' : ''));
    r.appendChild(chipDot(a));
    r.appendChild(el('span', 'app-name', str(a.label, 30)));
    const t = el('button', 'swbtn');
    t.appendChild(toggle(a.sw === 'on'));
    if (a.sw === 'none') { t.classList.add('ghosted'); t.disabled = true; }
    else if (ACTION_RE.test(str(a.action))) t.addEventListener('click', () => send(a.action));
    r.appendChild(t);
    if (a.sw !== 'none') {
      r.classList.add('drag');
      r.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('.swbtn')) return;
        e.preventDefault();
        reorder = { from: i, to: i, y0: e.clientY, row: r, list, started: false };
      });
    }
    return r;
  }
  function reorderMove(e) {
    const g = reorder;
    if (!g.started && Math.abs(e.clientY - g.y0) < 4) return;
    g.started = true;
    hideTip();
    const rows = [...g.list.children];
    const h = g.row.offsetHeight + 4;
    const dy = e.clientY - g.y0;
    g.to = Math.max(0, Math.min(rows.length - 1, g.from + Math.round(dy / h)));
    g.row.classList.add('lifted');
    g.row.style.transform = 'translateY(' + dy + 'px)';
    rows.forEach((x, k) => {
      if (x === g.row) return;
      const shift = g.to > g.from && k > g.from && k <= g.to ? -h : g.to < g.from && k < g.from && k >= g.to ? h : 0;
      x.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }
  function reorderEnd() {
    const g = reorder;
    reorder = null;
    if (g.started && g.to !== g.from) send('dput:' + g.from + 't' + g.to);
    if (g.started || pendingRender) render();
  }

  // ---------------------------------------------------------------- welcome
  function welcome(st) {
    const card = el('div', 'welcome');
    const finish = (answer) => { welcomeDone = true; send('setup:' + answer); render(); };
    const head = el('div', 'welcome-head');
    head.appendChild(el('div', 'welcome-title', str(st.title, 60)));
    head.appendChild(ib('x', 'close', 'Close', () => finish('ok')));
    card.appendChild(head);
    (Array.isArray(st.body) ? st.body.slice(0, 4) : []).forEach((t, k) => card.appendChild(el('p', k ? 'soft' : '', str(t, 300))));
    const apps = Array.isArray(st.apps) ? st.apps.slice(0, 14) : [];
    if (apps.length) {
      const grid = el('div', 'chips');
      apps.forEach((a) => {
        const c = el('div', 'chip');
        const ic = a && a.logo ? destIcon(a.logo, true) : null;
        if (ic) c.appendChild(ic);
        c.appendChild(el('span', '', str(a && a.name, 30)));
        grid.appendChild(c);
      });
      card.appendChild(grid);
    }
    if (st.foot) card.appendChild(el('div', 'foot', str(st.foot, 400)));
    const nav = el('div', 'welcome-btns');
    const set = el('button', 'btn secondary', str(st.settings, 30) || 'Open Settings');
    const go = el('button', 'btn primary', str(st.ok, 30) || 'Got it');
    set.addEventListener('click', () => finish('settings'));
    go.addEventListener('click', () => finish('ok'));
    nav.appendChild(set); nav.appendChild(go);
    card.appendChild(nav);
    card.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) startPress(e, false); });
    return card;
  }

  // ---------------------------------------------------------------- moving the window
  function startPress(e, isTab) {
    if (e.button !== 0) return;
    e.preventDefault();
    hideTip();
    press = { x: e.screenX, y: e.screenY, tab: isTab, moved: false };
  }
  window.addEventListener('mousemove', (e) => {
    if (reorder) { reorderMove(e); return; }
    if (!press) return;
    if (!press.moved && Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) < 4) return;
    if (!press.moved) { press.moved = true; post({ type: 'drag', phase: 'start' }); }
    post({ type: 'drag', phase: 'move', dx: e.screenX - press.x, dy: e.screenY - press.y });
  });
  window.addEventListener('mouseup', () => {
    if (reorder) { reorderEnd(); return; }
    const p = press;
    press = null;
    if (!p) return;
    if (p.moved) post({ type: 'drag', phase: 'end' });
    if (!p.moved && p.tab && !open) setOpen(true);
    else if (pendingRender) render();
  });

  // ---------------------------------------------------------------- open, close, idle
  function setOpen(v) {
    if (open === v) return;
    open = v;
    hideTip();
    if (open) send('opened:');
    render();
    armIdle();
  }
  function armIdle() {
    clearTimeout(idleTimer);
    if (!open) return;
    idleTimer = setTimeout(() => { if (hovering || press || reorder) armIdle(); else setOpen(false); }, IDLE_MS);
  }
  document.documentElement.addEventListener('mouseenter', () => { hovering = true; armIdle(); });
  document.documentElement.addEventListener('mouseleave', () => { hovering = false; armIdle(); });
  window.addEventListener('mousemove', () => { if (!hovering) { hovering = true; armIdle(); } }, true);

  // ---------------------------------------------------------------- drawing
  function mode() {
    if (spec.setup && spec.setup.welcome && !welcomeDone) return 'welcome';
    if (open) return 'panel';
    return spec.visible ? 'tab' : 'hidden';
  }
  function render() {
    pendingRender = false;
    const prev = root.querySelector('.scroll[data-pane]');
    if (prev) keepScroll = { pane: prev.dataset.pane, y: prev.scrollTop };
    const m = mode();
    root.className = 'side-' + (spec.side === 'l' ? 'l' : 'r') + ' size-' + (['s', 'm', 'l'].includes(spec.size) ? spec.size : 'm');
    root.textContent = '';
    if (m === 'welcome') root.appendChild(welcome(spec.setup));
    else if (m === 'panel') root.appendChild(panel(spec));
    else if (m === 'tab') root.appendChild(tab(spec));
    const sc = root.querySelector('.scroll[data-pane]');
    if (sc && keepScroll && keepScroll.pane === sc.dataset.pane) sc.scrollTop = keepScroll.y;
    report(m);
  }
  let lastSize = '';
  function report(m) {
    const measure = () => {
      const r = root.getBoundingClientRect();
      const size = { type: 'size', mode: m, w: Math.ceil(r.width), h: Math.ceil(r.height), side: spec.side === 'l' ? 'l' : 'r', yFrac: typeof spec.yFrac === 'number' ? spec.yFrac : 0.42, monitor: Number.isInteger(spec.monitor) ? spec.monitor : -1 };
      const key = JSON.stringify(size);
      if (key !== lastSize) { lastSize = key; post(size); }
    };
    measure();
    requestAnimationFrame(measure);
  }

  window.morphRender = function morphRender(json) {
    let s;
    try { s = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
    spec = s && typeof s === 'object' ? s : { visible: false };
    if (spec.settled) { busy = null; clearTimeout(busyTimer); }
    if (!(spec.setup && spec.setup.welcome)) welcomeDone = false;
    if (spec.openNow && !open) { open = true; send('opened:'); armIdle(); }
    if (!spec.visible && open && !hovering && !spec.openNow) open = false;
    if (press || reorder) { pendingRender = true; return; } // drawn when the press ends: never rebuilt under the mouse
    render();
    clearTimeout(collapseTimer);
    if (spec.collapseAfterMs && open) collapseTimer = setTimeout(() => setOpen(false), Math.min(Number(spec.collapseAfterMs) || 1800, 10000));
  };
  window.morphClose = function morphClose() { if (open && !press && !reorder) setOpen(false); };
  window.morphScreen = function morphScreen(h) { if (Number(h) > 200) { screenH = Number(h); render(); } };
  window.morphState = function morphState() { return { open, mode: mode(), busy: busy && busy.action }; };
  post({ type: 'ready' });
})();
