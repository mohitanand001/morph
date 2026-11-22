(function () {
// @mentions carry a display name and nothing else, so no destination can
// notify anyone from a paste. The panel lets you attach an email address to
// each name; destinations then get a mailto: link, which Docs, Gmail and
// Jira keep and which is the closest a paste gets to a real mention.
window.FB = window.FB || {};

FB.EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

FB.mentionKey = (name) => String(name || '').trim().toLowerCase();

// Unique mention names in reading order.
FB.collectMentions = function collectMentions(ast) {
  const seen = new Map();
  const visit = (nodes) => (nodes || []).forEach((n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mention') {
      const k = FB.mentionKey(n.displayName);
      if (k && !seen.has(k)) seen.set(k, n.displayName);
    }
    if (n.children) visit(n.children);
    if (n.items) n.items.forEach((i) => { visit(i.children); visit(i.nested); });
    if (n.headerRow) visit(n.headerRow.flatMap((c) => c.children || []));
    if (n.rows) n.rows.forEach((r) => r.forEach((c) => visit(c.children)));
  });
  visit(ast.children);
  return Array.from(seen.values());
};

// Emails that came with the mentions themselves (Docs chips). With
// onlyCheck, just says whether there are any.
FB.mentionEmails = function mentionEmails(ast, onlyCheck) {
  const found = {};
  const visit = (nodes) => (nodes || []).forEach((n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mention' && n.email && FB.EMAIL_RE.test(n.email)) found[FB.mentionKey(n.displayName)] = n.email;
    if (n.children) visit(n.children);
    if (n.items) n.items.forEach((i) => { visit(i.children); visit(i.nested); });
    if (n.headerRow) n.headerRow.forEach((c) => visit(c.children));
    if (n.rows) n.rows.forEach((r) => r.forEach((c) => visit(c.children)));
  });
  visit(ast.children);
  return onlyCheck ? Object.keys(found).length > 0 : found;
};

// Copy of the AST where mentions that have a valid email become mailto links.
FB.applyPeople = function applyPeople(ast, people) {
  const has = (people && Object.keys(people).some((k) => FB.EMAIL_RE.test(people[k] || ''))) || FB.mentionEmails(ast, true);
  if (!has) return ast;
  const clone = JSON.parse(JSON.stringify(ast));
  const fix = (nodes) => (nodes || []).forEach((n, idx, arr) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mention') {
      const email = ((people && people[FB.mentionKey(n.displayName)]) || n.email || '').trim();
      if (FB.EMAIL_RE.test(email)) {
        arr[idx] = { type: 'link', href: 'mailto:' + email, person: n.displayName, children: [FB.text('@' + n.displayName)] };
      }
      return;
    }
    if (n.children) fix(n.children);
    if (n.items) n.items.forEach((i) => { fix(i.children); fix(i.nested); });
    if (n.headerRow) n.headerRow.forEach((c) => fix(c.children));
    if (n.rows) n.rows.forEach((r) => r.forEach((c) => fix(c.children)));
  });
  fix(clone.children);
  return clone;
};
})();
