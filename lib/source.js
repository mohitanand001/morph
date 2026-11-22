// Where something was copied from, so a pasted copy can carry a link back
// ("Source: Slack · #design-review"). Built from the window you copied in
// (its title) and any links inside what you copied. Runs in the main process.
'use strict';
const { slackTarget } = require('./slack');

const BROWSER_SUFFIX = /\s+[-—–]\s+(Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Microsoft Edge|Vivaldi|Opera|Arc)$/i;

function cleanTitle(t) {
  return String(t || '').replace(BROWSER_SUFFIX, '').replace(/^\(\d+\)\s+/, '').trim();
}

// Links inside the copied HTML that point at the place itself.
function findUrl(html, re) {
  const m = String(html || '').match(re);
  return m ? m[0].replace(/&amp;/g, '&') : '';
}
const SLACK_PERMALINK = /https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+(?:\/p\d+)?(?:\?[^"'\s<>]*)?/;
const ATLASSIAN_SITE = /https:\/\/[a-z0-9-]+\.atlassian\.net/i;

function siteOf(html) {
  const m = String(html || '').match(ATLASSIAN_SITE);
  return m ? m[0].toLowerCase() : '';
}

const OUTLOOK_FOLDERS = /^(mail|inbox|outlook|sent items|sent|drafts|archive|deleted items|junk email|junk|calendar|people|contacts|to do|tasks|search|search results|focused|other|new message|untitled message|untitled|settings|groups|notes|outbox|conversation history|rss feeds|snoozed|scheduled|starred|favourites|favorites)$/i;
// The email's subject from an Outlook window title, or '' if the title only
// names a folder.
function outlookSubject(title) {
  let t = cleanTitle(title).replace(/\s+[-–|]\s+(Microsoft\s+)?Outlook(\s*\(PWA\))?$/i, '').trim();
  if (!t || /^(Microsoft\s+)?Outlook$/i.test(t)) return '';
  const parts = t.split(/\s+-\s+/);
  // The last part is usually the account ("Priya Shah", "priya@acme.com").
  if (parts.length >= 2) parts.pop();
  const subject = parts.join(' - ').replace(/\s*[•·]\s*.*$/, '').trim();
  if (!subject || OUTLOOK_FOLDERS.test(subject) || /^(mail|inbox)\b/i.test(subject) && subject.split(/\s+/).length <= 2) return '';
  return subject;
}

// win: { app, title } at the moment you copied; rule: the matched app rule
// (or null); html: the copied HTML; sites: { atlassian } learned earlier.
function describeSource(win, rule, html, sites) {
  if (!win || (!win.title && !win.app)) return null;
  const title = cleanTitle(win.title);
  const id = rule ? rule.id : '';
  const site = siteOf(html) || (sites && sites.atlassian) || '';
  let tool = rule ? rule.name : '';
  let label = '';
  let url = '';

  if (id === 'slack' || / - Slack$/.test(title)) {
    tool = 'Slack';
    const t = slackTarget(title);
    if (t) label = (t.kind === 'channel' ? '#' + t.name : t.name) + ' (' + t.workspace + ')';
    else label = title.replace(/^[*!]\s+/, '').replace(/ - Slack$/, '');
    url = findUrl(html, SLACK_PERMALINK);
  } else if (id === 'jira' || / - Jira$/.test(title)) {
    tool = 'Jira';
    const m = /\[([A-Z][A-Z0-9_]+-\d+)\]\s*(.*?)(?: - Jira)?$/.exec(title);
    if (m) {
      label = m[1] + (m[2] ? ' ' + m[2] : '');
      const key = m[1];
      url = findUrl(html, new RegExp('https://[^"\'\\s<>]+/browse/' + key + '\\b')) || (site ? site + '/browse/' + key : '');
    } else label = title.replace(/ - Jira$/, '');
  } else if (id === 'confluence' || / - Confluence$/.test(title)) {
    tool = 'Confluence';
    const m = /^(.+?) - (.+?) - Confluence$/.exec(title);
    label = m ? m[1] + ' (' + m[2] + ')' : title.replace(/ - Confluence$/, '');
    url = findUrl(html, /https:\/\/[a-z0-9-]+\.atlassian\.net\/wiki\/spaces\/[^"'\s<>]+\/pages\/\d+[^"'\s<>]*/i);
  } else if (id === 'gdocs' || / - Google Docs$/.test(title)) {
    tool = 'Google Docs';
    label = title.replace(/ - Google Docs$/, '');
  } else if (id === 'outlook' || /\s[-–|]\s(Microsoft )?Outlook$/i.test(title)) {
    // "Re: Q3 plan - Priya Shah - Outlook" when a message is open in its own
    // window or tab; just "Mail - Priya Shah - Outlook" otherwise (no source
    // line then: a folder name says nothing about where it came from).
    tool = 'Outlook';
    const subject = outlookSubject(title);
    if (!subject) return null;
    label = subject;
  } else if (/^(evince|org\.gnome\.(evince|papers)|papers|okular|org\.kde\.okular|xreader|atril|zathura|preview|acrobat|foxit)/i.test(win.app || '') || /\.pdf\b/i.test(title)) {
    // A PDF viewer (or a PDF open in the browser): mark it, so the text is
    // repaired as PDF text.
    tool = 'PDF';
    const seg = title.split(/\s+[-—–|]\s+/).find((x) => /\.pdf\b/i.test(x)) || title;
    label = seg.split(/[\\/]/).pop().trim();
    return { tool, label: label.slice(0, 120), url: '', ruleId: id, dest: rule ? rule.dest : '', pdf: true };
  } else {
    if (!rule) return null; // only apps you chose, never an arbitrary window
    label = title;
  }
  label = label.slice(0, 120);
  if (!label) return null;
  return { tool, label, url: /^https:\/\//.test(url) ? url.slice(0, 500) : '', ruleId: id, dest: rule ? rule.dest : '' };
}

module.exports = { describeSource, cleanTitle, siteOf, outlookSubject };
