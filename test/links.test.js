'use strict';
const assert = require('assert');
const { extractLinks } = require('../lib/links');

function test(name, fn) { try { fn(); console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + ': ' + e.message); process.exitCode = 1; } }

console.log('links');

test('extracts URLs from text', () => {
  const links = extractLinks('Check https://example.com/page and https://other.org/doc', '', '');
  assert.strictEqual(links.length, 2);
  assert.strictEqual(links[0].kind, 'url');
  assert.strictEqual(links[0].url, 'https://example.com/page');
  assert.strictEqual(links[1].url, 'https://other.org/doc');
});

test('extracts URLs from HTML too', () => {
  const links = extractLinks('', '<a href="https://example.com/page">click</a>', '');
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].url, 'https://example.com/page');
});

test('deduplicates URLs found in both text and HTML', () => {
  const links = extractLinks('Visit https://example.com/page', '<a href="https://example.com/page">link</a>', '');
  assert.strictEqual(links.length, 1);
});

test('extracts Jira tickets when atlassianSite is set', () => {
  const links = extractLinks('Fix PROJ-1234 and TEAM-567', '', 'https://myco.atlassian.net');
  const jira = links.filter((l) => l.kind === 'jira');
  assert.strictEqual(jira.length, 2);
  assert.strictEqual(jira[0].label, 'PROJ-1234');
  assert.strictEqual(jira[0].url, 'https://myco.atlassian.net/browse/PROJ-1234');
  assert.strictEqual(jira[1].label, 'TEAM-567');
});

test('does not extract Jira tickets without atlassianSite', () => {
  const links = extractLinks('Fix PROJ-1234', '', '');
  const jira = links.filter((l) => l.kind === 'jira');
  assert.strictEqual(jira.length, 0);
});

test('skips Jira ticket if full URL already found', () => {
  const links = extractLinks('See https://myco.atlassian.net/browse/PROJ-1234 for PROJ-1234', '', 'https://myco.atlassian.net');
  // URL found first, then Jira ticket's url matches → deduped
  assert.strictEqual(links.filter((l) => l.url.includes('PROJ-1234')).length, 1);
});

test('extracts email addresses', () => {
  const links = extractLinks('Contact alice@example.com for help', '', '');
  const emails = links.filter((l) => l.kind === 'email');
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0].label, 'alice@example.com');
  assert.strictEqual(emails[0].url, 'mailto:alice@example.com');
});

test('caps at MAX_LINKS (6)', () => {
  const text = Array.from({ length: 20 }, (_, i) => 'https://example.com/page' + i).join(' ');
  const links = extractLinks(text, '', '');
  assert.ok(links.length <= 6);
});

test('skips Slack permalink URLs', () => {
  const links = extractLinks('See https://myteam.slack.com/archives/C01234/p5678', '', '');
  assert.strictEqual(links.length, 0);
});

test('strips trailing punctuation from URLs', () => {
  const links = extractLinks('Visit https://example.com/page.', '', '');
  assert.strictEqual(links[0].url, 'https://example.com/page');
});

test('shortens long URLs for labels', () => {
  const links = extractLinks('https://example.com/very/long/path/that/goes/on/and/on/forever/page.html', '', '');
  assert.ok(links[0].label.length <= 40);
  assert.ok(links[0].label.endsWith('…'));
});

test('returns empty for empty input', () => {
  assert.deepStrictEqual(extractLinks('', '', ''), []);
  assert.deepStrictEqual(extractLinks(null, null, ''), []);
});
