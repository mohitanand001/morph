// Detect clickable references in copied content: URLs, Jira ticket IDs,
// email addresses.  Returns an array of { kind, label, url } objects,
// deduplicated, capped at a reasonable limit for the pill.
'use strict';

// --------------- patterns ------------------------------------------------
const URL_RE = /https?:\/\/[^\s<>"')\]}{,]+/gi;
const JIRA_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

const MAX_LINKS = 6;

// Strip trailing punctuation that got swept in by the URL regex
function cleanUrl(u) {
  return u.replace(/[.),:;!?]+$/, '');
}

// Shorten a URL for display: drop protocol, trim path
function shortUrl(u) {
  let s = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (s.length > 40) s = s.slice(0, 37) + '…';
  return s;
}

// Extract cross-links from plain text and HTML.
// atlassianSite: e.g. 'https://myco.atlassian.net' for building Jira links.
function extractLinks(text, html, atlassianSite) {
  const seen = new Set();
  const out = [];

  function add(kind, label, url) {
    if (out.length >= MAX_LINKS) return;
    const key = url || label;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, label, url });
  }

  const src = (text || '') + '\n' + (html || '');

  // URLs first (most useful)
  let m;
  while ((m = URL_RE.exec(src)) !== null) {
    const url = cleanUrl(m[0]);
    // Skip Slack archive permalinks (those are source links, already shown)
    if (/\.slack\.com\/archives\//.test(url)) continue;
    add('url', shortUrl(url), url);
  }

  // Jira tickets (only when we know the Atlassian site)
  if (atlassianSite) {
    JIRA_RE.lastIndex = 0;
    while ((m = JIRA_RE.exec(src)) !== null) {
      const key = m[1];
      const url = atlassianSite + '/browse/' + key;
      // Skip if we already found the full Jira URL
      if (seen.has(url)) continue;
      add('jira', key, url);
    }
  }

  // Email addresses
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(src)) !== null) {
    add('email', m[0], 'mailto:' + m[0]);
  }

  return out;
}

module.exports = { extractLinks };
