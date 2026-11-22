// Pill logic that runs in the main process: which app rule matches the
// window in front, and reading the front window on GNOME, X11 and macOS.
const { DEFAULT_RULES, normalizeRules, matchRule, isSelf, addNewDefaults } = require('../lib/rules');
const { parseGnome, parseAction, parseXActive, parseXWindow, parseMac } = require('../lib/focus');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) passed++; else { failed++; console.log('FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };
const rules = normalizeRules(DEFAULT_RULES);
const m = (app, title) => (matchRule(rules, { app, title }) || {}).id;

check('Slack desktop by app id', m('Slack', 'general (Channel) - acme') === 'slack');
check('Slack in a browser by title', m('Google-chrome', 'general (Channel) - acme - Slack - Google Chrome') === 'slack');
check('Jira in a browser', m('Google-chrome', '[TEST-1] Login fails - Jira - Google Chrome') === 'jira');
check('Confluence in a browser', m('firefox', 'Release notes - Engineering - Confluence — Mozilla Firefox') === 'confluence');
check('Google Docs in a browser', m('Google-chrome', 'Format Bridge test - Google Docs - Google Chrome') === 'gdocs');
check('disabled rules do not match (Gmail is off by default)', m('Google-chrome', 'Inbox - Gmail') === undefined);
check('an unrelated window matches nothing', m('org.gnome.Nautilus', 'Downloads') === undefined);
check('empty window matches nothing', matchRule(rules, { app: '', title: '' }) === null);
check('our own windows are recognised', isSelf({ app: 'format-bridge', title: "Format Bridge" }) && isSelf({ app: "x", title: "Formatter" }) && isSelf({ app: "x", title: "Morph" }) && !isSelf({ app: 'Slack', title: 'x' }));
const custom = normalizeRules([{ name: 'Notion', title: 'Notion', dest: 'markdown' }, { name: 'bad' }]);
check('custom rules: kept when they match something, dropped when they match nothing', custom.length === 1 && custom[0].name === 'Notion' && custom[0].enabled === true);
check('bad destination falls back to markdown', normalizeRules([{ name: 'X', title: 'x', dest: 'evil' }])[0].dest === 'markdown');
check('Teams, Notion and Linear desktop apps match', m('teams-for-linux', 'Chat | Microsoft Teams') === 'teams' && m('Notion', 'Roadmap') === 'notion' && m('Linear', 'Inbox') === 'linear');
check('Outlook on the web is on by default', m('Google-chrome', 'Mail - Priya - Outlook - Google Chrome') === 'outlook');
check('a page about linear algebra is not Linear', m('Google-chrome', 'Linear algebra - Wikipedia - Google Chrome') === undefined);
{
  const old = normalizeRules(DEFAULT_RULES.filter((r) => !['notion', 'linear', 'teams', 'gmail'].includes(r.id)));
  const a = addNewDefaults(old, null);
  check('new apps are added to an existing setup once', ['notion', 'linear', 'teams'].every((id) => a.rules.some((r) => r.id === id)));
  const b = addNewDefaults(a.rules.filter((r) => r.id !== 'notion'), a.seen);
  check('a deleted app stays deleted', !b.rules.some((r) => r.id === 'notion'));
}
check('gnome: drag position action parses', parseAction("x: dev.morph.Focus.Action ('moved:l1y305',)") === 'moved:l1y305' && parseAction("x: dev.morph.Focus.Action ('hist:12',)") === 'hist:12');
{
  const { describeSource } = require('../lib/source');
  const R = (id) => rules.find((r) => r.id === id);
  const sl = describeSource({ app: 'Slack', title: 'design-review (Channel) - acme - Slack' }, R('slack'), '<a href="https://acme.slack.com/archives/C024BE91L/p1700000000123456">10:42</a>', {});
  check('source: Slack channel and permalink', sl && sl.tool === 'Slack' && sl.label === '#design-review (acme)' && sl.url === 'https://acme.slack.com/archives/C024BE91L/p1700000000123456', sl);
  const dm = describeSource({ app: 'Google-chrome', title: 'Priya (DM) - acme - Slack - Google Chrome' }, R('slack'), '', {});
  check('source: Slack DM in a browser', dm && dm.label === 'Priya (acme)' && dm.url === '', dm);
  const ji = describeSource({ app: 'Google-chrome', title: '[KAN-4] Login fails on Safari - Jira - Google Chrome' }, R('jira'), '', { atlassian: 'https://acme.atlassian.net' });
  check('source: Jira issue with a link from the known site', ji && ji.label === 'KAN-4 Login fails on Safari' && ji.url === 'https://acme.atlassian.net/browse/KAN-4', ji);
  const ji2 = describeSource({ app: 'Google-chrome', title: '[KAN-4] Login - Jira - Google Chrome' }, R('jira'), '<a href="https://other.atlassian.net/browse/KAN-4">x</a>', {});
  check('source: Jira link found in the copy wins', ji2 && ji2.url === 'https://other.atlassian.net/browse/KAN-4', ji2);
  const cf = describeSource({ app: 'firefox', title: 'Release notes - Engineering - Confluence — Mozilla Firefox' }, R('confluence'), '', {});
  check('source: Confluence page and space', cf && cf.label === 'Release notes (Engineering)', cf);
  check('source: unknown windows give nothing', describeSource({ app: 'org.gnome.Nautilus', title: 'Downloads' }, null, '', {}) === null);
  check('source: only https links', describeSource({ app: 'x', title: '[A-1] y - Jira' }, R('jira'), '<a href="javascript:alert(1)/browse/A-1">', {}).url === '');
}
{
  const K = require('../lib/keys');
  check('keys: defaults are valid and unique', K.normalizeShortcuts(null).every((k) => K.validAccel(k.accel)) && new Set(K.normalizeShortcuts(null).map((k) => k.accel)).size === K.SHORTCUTS.length);
  check('keys: labels and Electron names', K.accelLabel('<Shift><Control><Alt>v') === 'Ctrl Alt Shift V' && K.accelToElectron('<Control><Alt>v') === 'Control+Alt+V' && K.accelLabel('<Control><Alt>v', true) === '⌃⌥V');
  check('keys: plain letters and junk are refused', !K.validAccel('v') && !K.validAccel('<Shift>v') && !K.validAccel('<Control><Alt>vv') && !K.validAccel("<Control>v'; rm") && K.validAccel('<Super>F5'));
  const n = K.normalizeShortcuts([{ id: 'paste', accel: '<Control>x', on: true }, { id: 'plain', accel: '<Control>x', on: true }, { id: 'nope', accel: '<Control>y', on: true }, { id: 'pill', accel: 'bad', on: false }]);
  check('keys: saved settings are cleaned', n.length === K.SHORTCUTS.length && n[0].accel === '<Control>x' && n.find((k) => k.id === 'pill').accel === '<Control><Alt>f' && n.find((k) => k.id === 'pill').on === false && !n.some((k) => k.id === 'nope'));
  check('keys: two on the same keys, the second is switched off', n[0].on === true && n[1].on === false);
  const { describeSource } = require('../lib/source');
  const p1 = describeSource({ app: 'org.gnome.Papers', title: 'Q3-report.pdf' }, null, '', {});
  const p2 = describeSource({ app: 'Google-chrome', title: 'Q3-report.pdf - Google Chrome' }, null, '', {});
  check('source: PDF viewers and PDFs in a browser are recognised', p1 && p1.pdf && p1.label === 'Q3-report.pdf' && p2 && p2.pdf && p2.tool === 'PDF', [p1, p2]);
}
{
  const { slackTarget } = require('../lib/slack');
  const a = slackTarget('design-review (Channel) - Acme - Slack');
  const b = slackTarget('* design-review (Channel) - Acme - 3 new items - Slack');
  const c = slackTarget('Thread - eng-oncall (Private channel) - Acme - Slack');
  const d = slackTarget('Priya Shah (DM) - Acme - Slack');
  check('slack title: channel and workspace', a && a.kind === 'channel' && a.name === 'design-review' && a.workspace === 'Acme', a);
  check('slack title: unread markers and counts are ignored', b && b.name === 'design-review' && b.workspace === 'Acme', b);
  check('slack title: threads and private channels', c && c.kind === 'channel' && c.name === 'eng-oncall', c);
  check('slack title: DMs', d && d.kind === 'dm' && d.name === 'Priya Shah', d);
  check('slack title: other Slack views give nothing', slackTarget('Activity - Acme - Slack') === null && slackTarget('Notes.txt - gedit') === null);
  const { describeSource } = require('../lib/source');
  const u = describeSource({ app: 'Slack', title: '! design-review (Channel) - Acme - Slack' }, rules.find((r) => r.id === 'slack'), '', {});
  check('source: unread Slack channel still reads as #channel', u && u.label === '#design-review (Acme)', u);
}
{
  const { outlookSubject, describeSource } = require('../lib/source');
  check('outlook: subject of an open email', outlookSubject('Re: Q3 plan - Priya Shah - Outlook') === 'Re: Q3 plan' && outlookSubject('Re: Launch - Outlook') === 'Re: Launch');
  check('outlook: subjects with dashes keep them', outlookSubject('Re: Q3 plan - budget - Priya Shah - Outlook') === 'Re: Q3 plan - budget');
  check('outlook: folders are not subjects', ['Mail - Priya Shah - Outlook', 'Inbox - Priya Shah - Outlook - Google Chrome', '(3) Inbox - priya@acme.com - Outlook', 'Calendar - Priya Shah - Outlook', 'Outlook'].every((t) => outlookSubject(t) === ''));
  const o = describeSource({ app: 'Google-chrome', title: 'Re: Q3 plan - Priya Shah - Outlook - Google Chrome' }, rules.find((r) => r.id === 'outlook'), '', {});
  check('outlook: source line is the subject', o && o.tool === 'Outlook' && o.label === 'Re: Q3 plan', o);
  check('outlook: no source line for the inbox', describeSource({ app: 'Google-chrome', title: 'Mail - Priya Shah - Outlook' }, rules.find((r) => r.id === 'outlook'), '', {}) === null);
}
check('no rules falls back to the defaults', normalizeRules([]).length === DEFAULT_RULES.length);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
check('gnome: base64 answer', (() => { const g = parseGnome("('" + b64({ app: 'Slack', title: "Priya's \"doc\"" }) + "',)\n"); return g.app === 'Slack' && g.title === "Priya's \"doc\"" && g.pill === 0; })());
check('gnome: new helper says it can draw the pill', parseGnome("('" + b64({ app: 'Slack', title: 'x', pill: 2 }) + "',)").pill === 2);
check('gnome: pill click signal', parseAction("/dev/morph/Focus: dev.morph.Focus.Action ('fix:jira',)") === 'fix:jira' && parseAction("/dev/morph/Focus: dev.morph.Focus.Action ('open:',)") === 'open:');
check('gnome: open/apps actions parse', parseAction("x: dev.morph.Focus.Action ('opened:',)") === 'opened:' && parseAction("x: dev.morph.Focus.Action ('apps:',)") === 'apps:');
check('gnome: other signals are not clicks', parseAction("/dev/morph/Focus: dev.morph.Focus.Changed ('eyJ9',)") === null);
check('gnome: no window in front', (() => { const g = parseGnome("('" + b64({ app: '', title: '' }) + "',)"); return g.app === '' && g.title === ''; })());
check('gnome: helper missing gives null', parseGnome('') === null && parseGnome(null) === null);
check('x11: active window id', parseXActive('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n') === '0x3a00007');
check('x11: no active window', parseXActive('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0') === null);
const xw = parseXWindow('WM_CLASS(STRING) = "slack", "Slack"\n_NET_WM_NAME(UTF8_STRING) = "general (Channel) - \\"acme\\" - Slack"\n');
check('x11: class and title', xw.app === 'Slack' && xw.title === 'general (Channel) - "acme" - Slack', xw);
check('mac: app and tab title', JSON.stringify(parseMac('Google Chrome\n[TEST-1] Bug - Jira\n')) === JSON.stringify({ app: 'Google Chrome', title: '[TEST-1] Bug - Jira' }));
check('mac: app without a title', parseMac('Slack\n\n').app === 'Slack');

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed (companion)');
process.exit(failed ? 1 : 0);
