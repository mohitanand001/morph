// Reads the Slack channel (or DM) you're in from the Slack window title.
// No Slack API, no token: the title already says it, e.g.
//   "design-review (Channel) - Acme - Slack"
// with Slack's extras: "* " or "! " in front when there's something unread,
// "Thread - " in front of a thread, " - 3 new items" before " - Slack".
'use strict';

function slackTarget(title) {
  let t = String(title || '').trim().replace(/^[*!]\s+/, '');
  t = t.replace(/\s+-\s+\d+\s+new\s+items?(?=\s+-\s+Slack$)/i, '');
  const m = /^(?:Thread\s+-\s+)?(.+?) \((Channel|Private channel|DM|Group DM|Direct message)\) - (.+?) - Slack$/i.exec(t);
  if (!m) return null;
  const kind = /channel/i.test(m[2]) ? 'channel' : /group/i.test(m[2]) ? 'group' : 'dm';
  return { kind, name: m[1].replace(/^#/, '').trim(), workspace: m[3].trim() };
}

module.exports = { slackTarget };
