// Which apps the pill appears in, and which destination each one means.
// A rule matches the window in front by its app id (WM class on Linux,
// application name on macOS) and/or by text in its title (for web apps
// that all live inside one browser).
'use strict';

const DEFAULT_RULES = [
  { id: 'slack', name: 'Slack', dest: 'slack', app: 'slack', title: '- Slack', enabled: true },
  { id: 'jira', name: 'Jira', dest: 'jira', app: '', title: 'Jira', enabled: true },
  { id: 'confluence', name: 'Confluence', dest: 'confluence', app: '', title: 'Confluence', enabled: true },
  { id: 'gdocs', name: 'Google Docs', dest: 'gdocs', app: '', title: 'Google Docs', enabled: true },
  { id: 'gmail', name: 'Gmail', dest: 'email', app: '', title: 'Gmail', enabled: false },
  { id: 'outlook', name: 'Outlook', dest: 'email', app: 'outlook', title: 'Outlook', enabled: true },
  { id: 'teams', name: 'Teams', dest: 'teams', app: 'teams', title: 'Microsoft Teams', enabled: true },
  { id: 'notion', name: 'Notion', dest: 'notion', app: 'notion', title: '- Notion', enabled: true },
  { id: 'linear', name: 'Linear', dest: 'linear', app: 'linear', title: '- Linear', enabled: true },
  { id: 'github', name: 'GitHub', dest: 'markdown', app: '', title: 'GitHub', enabled: false },
  { id: 'chatgpt', name: 'ChatGPT', dest: 'markdown', app: '', title: 'ChatGPT', enabled: false },
  { id: 'claude', name: 'Claude', dest: 'markdown', app: 'claude', title: 'Claude', enabled: false },
  { id: 'terminal', name: 'Terminal', dest: 'text', app: 'terminal|iterm|ghostty|warp|kitty|alacritty|wezterm', title: '', enabled: false },
];
const DESTS = ['slack', 'jira', 'confluence', 'email', 'gdocs', 'markdown', 'text', 'notion', 'linear', 'teams'];
// Our own windows never count as "the app in front".
const SELF = /format.?bridge|^formatter$|^morph$|^dev\.morph\./i; // (dev.morph.*: the Mac app)

function clean(rule) {
  const r = Object.assign({}, rule);
  r.id = String(r.id || ('custom-' + Date.now().toString(36))).slice(0, 40);
  r.name = String(r.name || 'App').slice(0, 40);
  r.dest = DESTS.includes(r.dest) ? r.dest : 'markdown';
  r.app = String(r.app || '').slice(0, 80);
  r.title = String(r.title || '').slice(0, 80);
  r.enabled = r.enabled !== false;
  return r;
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return DEFAULT_RULES.map(clean);
  const out = rules.map(clean).filter((r) => r.app || r.title);
  return out.length ? out : DEFAULT_RULES.map(clean);
}

function isSelf(win) {
  return !!win && (SELF.test(win.app || '') || SELF.test(win.title || ''));
}

// First enabled rule whose app id and/or title text matches. A rule with
// both an app and a title matches if either does (Slack desktop has the app
// id, Slack in a browser has the title).
function matchRule(rules, win) {
  if (!win || (!win.app && !win.title)) return null;
  const app = String(win.app || '').toLowerCase();
  const title = String(win.title || '').toLowerCase();
  for (const r of rules) {
    if (!r.enabled) continue;
    // "a|b|c": any of them (a terminal is one of several apps; Mac apps go by bundle id, Linux ones by app id)
    const appHit = r.app && r.app.toLowerCase().split('|').some((a) => a && app.includes(a));
    const titleHit = r.title && r.title.toLowerCase().split('|').some((t) => t && title.includes(t));
    if (appHit || titleHit) return r;
  }
  return null;
}

// Apps added in later versions show up once in existing setups; a rule you
// deleted after that stays deleted.
function addNewDefaults(rules, seen) {
  const seenSet = new Set(Array.isArray(seen) ? seen : []);
  const have = new Set(rules.map((r) => r.id));
  const out = rules.slice();
  for (const d of DEFAULT_RULES) if (!have.has(d.id) && !seenSet.has(d.id)) out.push(clean(d));
  return { rules: out, seen: DEFAULT_RULES.map((d) => d.id) };
}

module.exports = { DEFAULT_RULES, DESTS, normalizeRules, matchRule, isSelf, addNewDefaults };
