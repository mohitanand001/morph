// Sample copies for the website demo. They are shaped like real copies (the Slack one is a real capture),
// but every name, handle, host and file is made up: this page is public. test/demo.test.js enforces that.
// Each: { id, app, title, blurb, html, text, source (expected), best: [destinations worth trying first] }
const fs = require('fs');
const path = require('path');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', n + '.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Google Docs wraps everything in <b id="docs-internal-guid-…"> and puts a style on every span.
const dspan = (t, bold) => '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:' + (bold ? 700 : 400) + ';font-style:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">' + esc(t) + '</span>';
const dli = (t) => '<li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">' + dspan(t) + '</p></li>';
const dcell = (t, bold) => '<td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;">' + dspan(t, bold) + '</p></td>';
const drow = (cells, bold) => '<tr style="height:0pt">' + cells.map((c) => dcell(c, bold)).join('') + '</tr>';
const gdocsHtml = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-4f1c2a10-7fff-1a2b-3c4d-5e6f7a8b9c0d">' +
  '<h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;"><span style="font-size:17pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;white-space:pre-wrap;">Q3 launch checklist</span></h2>' +
  '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' + dspan('Owner: ') + dspan('Priya', true) + dspan(', target date ') + dspan('12 Dec', true) + dspan('.') + '</p>' +
  '<br /><ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' + dli('Finalize the pricing page copy') + dli('Record the 90-second demo video') + dli('Brief support on the new refund flow') + '</ul><br />' +
  '<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;table-layout:fixed;width:468pt"><colgroup><col /><col /><col /></colgroup><tbody>' +
  drow(['Task', 'Owner', 'Status'], true) + drow(['Pricing page', 'Priya', 'In review']) + drow(['Demo video', 'Sam', 'Blocked']) + drow(['Support brief', 'Mia', 'Done']) +
  '</tbody></table></div></b>';

// Jira and Confluence copy their editor's document tree (class names starting ak-, data-pm-slice).
const jiraHtml = '<meta charset="utf-8"><div class="ak-renderer-document">' +
  '<h2 data-renderer-start-pos="1" id="Steps-to-reproduce">Steps to reproduce</h2>' +
  '<ol class="ak-ol" start="1" data-indent-level="1"><li><p data-renderer-start-pos="24">Add any item to the cart and open <strong data-renderer-mark="true">Checkout</strong></p></li><li><p>Choose <em data-renderer-mark="true">Pay later</em> as the payment method</p></li><li><p>Press <code class="code" data-renderer-mark="true">Place order</code></p></li></ol>' +
  '<h2 id="Expected-vs-actual">Expected vs actual</h2>' +
  '<div class="TableContainer"><table data-testid="renderer-table" class="ak-renderer-table"><tbody><tr><th><p><strong>Browser</strong></p></th><th><p><strong>Expected</strong></p></th><th><p><strong>Actual</strong></p></th></tr>' +
  '<tr><td><p>Chrome 126</p></td><td><p>Order confirmed</p></td><td><p>Order confirmed</p></td></tr><tr><td><p>Safari 17</p></td><td><p>Order confirmed</p></td><td><p>Spinner never stops</p></td></tr></tbody></table></div>' +
  '<div class="code-block"><pre data-testid="code-block"><code class="language-js">const res = await fetch("/api/orders", { method: "POST" });\nif (!res.ok) throw new Error(res.status);</code></pre></div>' +
  '<p data-renderer-start-pos="310">Raised by <a href="https://example.atlassian.net/browse/KAN-42">KAN-42</a>.</p></div>';

// GitHub renders markdown inside <div class="markdown-body">.
const githubHtml = '<meta charset="utf-8"><div class="markdown-body"><h2>Release checklist</h2>' +
  '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Tag <code>v1.4.0</code></li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Publish the changelog</li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Announce in <strong>#releases</strong></li></ul>' +
  '<div class="highlight highlight-source-shell"><pre>git tag v1.4.0\ngit push origin v1.4.0</pre></div>' +
  '<blockquote><p>Heads up: the migration runs on first start and takes about a minute.</p></blockquote></div>';


// A Docs "people chip": a mailto link wrapping a span that carries the person as JSON.
const chip = (name, email) => '<a href="mailto:' + email + '" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#1155cc;font-weight:700;text-decoration:underline;white-space:pre-wrap;" data-rich-links="' + esc(JSON.stringify({ per_n: name, per_e: email, type: 'person' })).replace(/"/g, '&quot;') + '">' + esc(name) + '</span></a>';
const chipsHtml = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-7a2e91c4-7fff-3b10-8d2f-0c1b2a3d4e5f">' +
  '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:6pt;">' + dspan('Action items from Monday', true) + '</p><ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' +
  '<li dir="ltr" style="list-style-type:disc;" aria-level="1"><p dir="ltr" role="presentation" style="margin:0">' + chip('Priya Shah', 'priya@example.com') + dspan(' sends the pricing draft by Friday') + '</p></li>' +
  '<li dir="ltr" style="list-style-type:disc;" aria-level="1"><p dir="ltr" role="presentation" style="margin:0">' + chip('Sam Lee', 'sam@example.com') + dspan(' books the review room') + '</p></li>' +
  '<li dir="ltr" style="list-style-type:disc;" aria-level="1"><p dir="ltr" role="presentation" style="margin:0">' + dspan('Everyone: read the ') + dspan('refund policy', true) + dspan(' before Thursday') + '</p></li></ul></b>';

// Docs writes nested bullets as one flat <ul> whose <li>s carry aria-level (1, 2, ...).
const dli2 = (t, lvl) => '<li dir="ltr" style="list-style-type:' + (lvl === 1 ? 'disc' : 'circle') + ';" aria-level="' + lvl + '"><p dir="ltr" role="presentation" style="margin:0">' + dspan(t) + '</p></li>';
const notesHtml = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-91b3c2d4-7fff-5e6a-1f2b-3c4d5e6f7a8b">' +
  '<h3 dir="ltr" style="margin-top:16pt;margin-bottom:4pt;"><span style="font-size:13pt;font-family:Arial,sans-serif;font-weight:700;white-space:pre-wrap;">Launch review notes</span></h3>' +
  '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' + dli2('Pricing', 1) + dli2('Annual plan gets 20% off', 2) + dli2('Free tier stays at 3 projects', 2) +
  dli2('Support', 1) + dli2('New refund macro is live', 2) + dli2('Escalations go to #support-leads', 2) + dli2('Open question: do we ship on Friday?', 1) + '</ul></b>';

// Gmail: the reply in a <div dir="ltr">, the quoted message in <blockquote class="gmail_quote">.
const emailHtml = '<meta charset="utf-8"><div dir="ltr">Hi Sam,<div><br></div><div>Can we move the review to <b>Thursday</b>? The numbers will not be ready before then.</div><div><br></div><div>Thanks,<br>Priya</div><br>' +
  '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 10 Nov 2026 at 09:14, Sam Lee &lt;<a href="mailto:sam@example.com">sam@example.com</a>&gt; wrote:<br></div>' +
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">The review is <b>Wednesday at 3pm</b>. Please bring:<ul><li>The Q3 numbers</li><li>A draft of the launch note</li></ul></div></blockquote></div></div>';

// A web article: headings, links, a quote, inline code and a numbered list.
const webHtml = '<meta charset="utf-8"><h2>How to roll back a bad deploy</h2>' +
  '<p>If a release misbehaves, <strong>roll back first</strong> and investigate afterwards. The <a href="https://example.com/runbooks/rollback">rollback runbook</a> covers the details.</p>' +
  '<blockquote><p>Fast recovery beats a clever fix.</p></blockquote>' +
  '<ol><li>Pause the pipeline with <code>deploy pause</code></li><li>Redeploy the last good tag</li><li>Post in <em>#incidents</em></li></ol>' +
  '<p>Read more in the <a href="https://example.com/handbook/oncall">on-call handbook</a>.</p>';

// Confluence panels (info, warning) and a nested list.
const panel = (type, body) => '<div class="ak-editor-panel" data-panel-type="' + type + '"><div class="ak-editor-panel__icon"></div><div class="ak-editor-panel__content"><p>' + body + '</p></div></div>';
const confHtml = '<meta charset="utf-8"><div class="ak-renderer-document"><h2 data-renderer-start-pos="1" id="Deploy-rules">Deploy rules</h2>' +
  panel('info', 'Deploys run from the <strong>release</strong> branch only.') + panel('warning', '<strong>Never deploy on a Friday.</strong> Support is thin and rollbacks are slow.') +
  '<ul class="ak-ul" data-indent-level="1"><li><p>Before you start</p><ul class="ak-ul" data-indent-level="2"><li><p>Check the status page</p></li><li><p>Tell <strong>#releases</strong></p></li></ul></li><li><p>After you finish</p></li></ul></div>';

const LOGS = '2026-11-14 09:12:03 INFO  checkout-api  order 48213 created (3 items)\n2026-11-14 09:12:04 WARN  checkout-api  payment gateway slow: 2.4s\n2026-11-14 09:12:07 ERROR checkout-api  payment failed for order 48213\nTraceback (most recent call last):\n  File "app/payments.py", line 88, in charge\n    resp = gateway.post(url, json=body, timeout=2)\n  File "requests/api.py", line 59, in post\n    return request("post", url, **kwargs)\nrequests.exceptions.ReadTimeout: Read timed out. (read timeout=2)\n2026-11-14 09:12:07 INFO  checkout-api  order 48213 moved to retry queue';
const JSON_TEXT = '{\n  "id": "ord_48213",\n  "status": "payment_failed",\n  "items": [\n    { "sku": "TS-001", "qty": 2 },\n    { "sku": "MG-114", "qty": 1 }\n  ],\n  "retry": { "attempts": 1, "next": "2026-11-14T09:17:07Z" }\n}';
const MRKDWN = 'Hey <!here> quick update on the incident :rotating_light:\n*Root cause:* the payment gateway timed out, see <https://status.example.com/incidents/118|incident 118>\n_Owner:_ <@U02PRIYA|priya> and <@U03SAM|sam>\n• retry queue drained :white_check_mark:\n• refunds pending, ~old ETA~ done :tada:\n> We will post the full review on Friday\n`orders.retry()` is safe to re-run';
const PLAN = '## Rollout plan\n\n> [!WARNING]\n> Run the migration before flipping the flag.\n\n- [x] Back up the database\n- [ ] Run `migrate up`\n- [ ] Flip `checkout_v2`\n\n| Step | Owner | Duration |\n|------|-------|----------|\n| Backup | Sam | 10 min |\n| Migrate | Priya | 25 min |\n\n```bash\n./migrate up --env prod\n```';
const hl = (c, t) => '<span style="color:' + c + ';">' + esc(t) + '</span>';
const vl = (...p) => '<div>' + p.join('') + '</div>';
const vscodeHtml = '<meta charset=\'utf-8\'><div style="color:#d4d4d4;background-color:#1e1e1e;font-family:Consolas, \'Courier New\', monospace;font-weight:normal;font-size:14px;line-height:19px;white-space:pre;">' +
  vl(hl('#569cd6', 'export async function'), hl('#d4d4d4', ' '), hl('#dcdcaa', 'retry'), hl('#d4d4d4', '<T>(fn: () => Promise<T>, tries = 3) {')) +
  vl(hl('#d4d4d4', '  '), hl('#569cd6', 'for'), hl('#d4d4d4', ' (let i = 0; i < tries; i++) {')) +
  vl(hl('#d4d4d4', '    '), hl('#569cd6', 'try'), hl('#d4d4d4', ' { '), hl('#569cd6', 'return await'), hl('#d4d4d4', ' fn(); }')) +
  vl(hl('#d4d4d4', '    '), hl('#569cd6', 'catch'), hl('#d4d4d4', ' (err) { '), hl('#6a9955', '// back off, then try again')) +
  vl(hl('#d4d4d4', '      '), hl('#569cd6', 'await'), hl('#d4d4d4', ' sleep(2 ** i * 100);')) + vl(hl('#d4d4d4', '    }')) + vl(hl('#d4d4d4', '  }')) +
  vl(hl('#d4d4d4', '  '), hl('#569cd6', 'throw new'), hl('#d4d4d4', ' '), hl('#4ec9b0', 'Error'), hl('#d4d4d4', '('), hl('#ce9178', '`gave up after ${tries} tries`'), hl('#d4d4d4', ');')) + vl(hl('#d4d4d4', '}')) + '</div>';
const VSCODE_TEXT = 'export async function retry<T>(fn: () => Promise<T>, tries = 3) {\n  for (let i = 0; i < tries; i++) {\n    try { return await fn(); }\n    catch (err) { // back off, then try again\n      await sleep(2 ** i * 100);\n    }\n  }\n  throw new Error(`gave up after ${tries} tries`);\n}';

function base() {
  // A real Slack capture, with the owner's workspace and handle swapped for made-up ones.
  const slack = fx('slack-message-table-mention'); 
  const ai = fx('ai-markdown-reply');
  const sheet = fx('excel-tsv-text');
  const term = { text: 'dev@laptop:~/projects/shop$ ls -la\ntotal 5236\ndrwxrwxr-x 12 dev dev    4096 Nov  7 12:39 .\ndrwxr-xr-x  5 dev dev    4096 Mar 14  2026 ..\n-rw-rw-r--  1 dev dev 5120331 Dec  2  2025 report-q3.pdf\ndrwxrwxr-x  4 dev dev    4096 Nov 30  2025 checkout-api\n' };
  return [
    { id: 'slack', app: 'slack', title: 'A Slack message', blurb: 'A mention, bold text and a table pasted as code.', html: slack.html, text: slack.text, source: 'slack', best: ['jira', 'email', 'markdown'] },
    { id: 'ai', app: 'markdown', title: 'An AI chat reply', blurb: 'Markdown from Claude or ChatGPT: headings, a list, a table, code.', html: '', text: ai.text, source: 'markdown', best: ['slack', 'jira', 'gdocs'] },
    { id: 'gdocs', app: 'gdocs', title: 'A Google Docs page', blurb: 'A heading, a bulleted list and a table.', html: gdocsHtml, text: 'Q3 launch checklist\nOwner: Priya, target date 12 Dec.\nFinalize the pricing page copy\nRecord the 90-second demo video\nBrief support on the new refund flow\nTask\tOwner\tStatus\nPricing page\tPriya\tIn review\nDemo video\tSam\tBlocked\nSupport brief\tMia\tDone', source: 'gdocs', best: ['slack', 'jira', 'markdown'] },
    { id: 'jira', app: 'jira', title: 'A Jira ticket', blurb: 'Numbered steps, a table and a code block.', html: jiraHtml, text: 'Steps to reproduce\nAdd any item to the cart and open Checkout\nChoose Pay later as the payment method\nPress Place order\nExpected vs actual\nBrowser\tExpected\tActual\nChrome 126\tOrder confirmed\tOrder confirmed\nSafari 17\tOrder confirmed\tSpinner never stops\nconst res = await fetch("/api/orders", { method: "POST" });\nif (!res.ok) throw new Error(res.status);\nRaised by KAN-42.', source: 'atlassian', best: ['slack', 'email', 'gdocs'] },
    { id: 'github', app: 'markdown', title: 'A GitHub README', blurb: 'A checklist, a shell snippet and a quote.', html: githubHtml, text: 'Release checklist\nTag v1.4.0\nPublish the changelog\nAnnounce in #releases\ngit tag v1.4.0\ngit push origin v1.4.0\nHeads up: the migration runs on first start and takes about a minute.', source: 'github', best: ['slack', 'jira', 'email'] },
    { id: 'sheet', app: 'text', title: 'A spreadsheet range', blurb: 'Tab-separated cells copied from Excel or Sheets.', html: '', text: sheet.text, source: 'plain-text', best: ['slack', 'jira', 'markdown'] },
    { id: 'terminal', app: 'text', title: 'Terminal output', blurb: 'A command with its prompt and colour codes.', html: '', text: term.text, source: 'terminal', best: ['slack', 'jira', 'email'] },
  ];
}

function extra() {
  return [
    { id: 'code', app: 'markdown', title: 'Code from your editor', blurb: 'A highlighted TypeScript selection from VS Code.', html: vscodeHtml, text: VSCODE_TEXT, source: 'code-editor', best: ['slack', 'jira', 'markdown'] },
    { id: 'logs', app: 'text', title: 'A server log', blurb: 'Timestamps, levels and a Python traceback.', html: '', text: LOGS, source: 'log', best: ['slack', 'jira', 'email'] },
    { id: 'json', app: 'text', title: 'An API response', blurb: 'JSON from curl or your browser tools.', html: '', text: JSON_TEXT, source: 'code', best: ['slack', 'jira', 'markdown'] },
    { id: 'mrkdwn', app: 'slack', title: 'Slack text with @mentions', blurb: 'Raw Slack text: @here, two people, a link, emoji, a list.', html: '', text: MRKDWN, source: 'slack-mrkdwn', best: ['jira', 'markdown', 'email'] },
    { id: 'chips', app: 'gdocs', title: 'Google Docs action items', blurb: 'Google Docs people chips and a bulleted list.', html: chipsHtml, text: 'Action items from Monday\nPriya Shah sends the pricing draft by Friday\nSam Lee books the review room\nEveryone: read the refund policy before Thursday', source: 'gdocs', best: ['slack', 'jira', 'markdown'] },
    { id: 'notes', app: 'gdocs', title: 'Nested meeting notes', blurb: 'Bullets inside bullets, kept nested.', html: notesHtml, text: 'Launch review notes\nPricing\nAnnual plan gets 20% off\nFree tier stays at 3 projects\nSupport\nNew refund macro is live\nEscalations go to #support-leads\nOpen question: do we ship on Friday?', source: 'gdocs', best: ['slack', 'jira', 'markdown'] },
    { id: 'plan', app: 'markdown', title: 'An AI plan with a warning', blurb: 'A callout, a checklist, a table and a command.', html: '', text: PLAN, source: 'markdown', best: ['slack', 'jira', 'gdocs'] },
    { id: 'email', app: 'email', title: 'An email with a quoted reply', blurb: 'A Gmail reply that quotes the message above it.', html: emailHtml, text: 'Hi Sam,\n\nCan we move the review to Thursday? The numbers will not be ready before then.\n\nThanks,\nPriya\n\nOn Mon, 10 Nov 2026 at 09:14, Sam Lee <sam@example.com> wrote:\n> The review is Wednesday at 3pm. Please bring:\n> The Q3 numbers\n> A draft of the launch note', source: 'rich-text', best: ['slack', 'jira', 'markdown'] },
    { id: 'web', app: 'markdown', title: 'A web page', blurb: 'Headings, links, a quote, inline code, steps.', html: webHtml, text: 'How to roll back a bad deploy\nIf a release misbehaves, roll back first and investigate afterwards. The rollback runbook covers the details.\nFast recovery beats a clever fix.\nPause the pipeline with deploy pause\nRedeploy the last good tag\nPost in #incidents\nRead more in the on-call handbook.', source: 'rich-text', best: ['slack', 'jira', 'markdown'] },
    { id: 'confluence', app: 'confluence', title: 'A Confluence page', blurb: 'Info and warning panels and a nested list.', html: confHtml, text: 'Deploy rules\nDeploys run from the release branch only.\nNever deploy on a Friday. Support is thin and rollbacks are slow.\nBefore you start\nCheck the status page\nTell #releases\nAfter you finish', source: 'atlassian', best: ['slack', 'gdocs', 'markdown'] },
  ];
}

// Order, group and a one-line "what to look for" for each sample.
const LAYOUT = [
  ['Tables and data', [
    ['sheet', 'Tab-separated cells become a real table, with an aligned plain-text copy riding along for apps that cannot show tables.'],
    ['slack', 'Pasted back into Slack it is left alone. Pick Jira or Google Docs to see the @mention and the table converted.'],
    ['json', 'Pretty-printed JSON lands as a code block, so the indentation is not flattened.']]],
  ['Code and logs', [
    ['code', 'The editor\'s colours and dark background are dropped. What arrives is a clean code block, indentation intact.'],
    ['logs', 'Every timestamp and the whole traceback stay on their own lines, in one code block.'],
    ['terminal', 'The prompt, colour codes and trailing spaces are removed.']]],
  ['People and mentions', [
    ['mrkdwn', 'Slack\'s *bold*, _italic_ and <link|label> become real formatting in Jira and Google Docs. Mentions stay as names.'],
    ['chips', 'Google Docs people chips become @Name with their email link behind them.']]],
  ['Lists and notes', [
    ['ai', 'Headings, a list, a table and code from an AI chat, converted for each app.'],
    ['plan', 'The warning, the checklist and the table each become the closest thing the app supports. The notes under the preview say what is left to do by hand.'],
    ['notes', 'Bullets inside bullets keep their nesting.']]],
  ['Whole pages', [
    ['jira', 'Numbered steps, a table and a code block, ready for Slack or Outlook.'],
    ['confluence', 'Info and warning panels turn into callouts or labelled quotes, depending on what the app can show.'],
    ['gdocs', 'A heading, a list and a table from Google Docs, ready for Jira or GitHub.'],
    ['github', 'The checklist, the shell snippet and the quote carry over.'],
    ['email', 'The quoted reply stays a quote.'],
    ['web', 'Links, the quote, inline code and numbered steps all carry over.']]],
];
module.exports = function samples() {
  const all = base().concat(extra());
  const out = [];
  LAYOUT.forEach(([group, items]) => items.forEach(([id, look]) => {
    const smp = all.find((x) => x.id === id);
    if (!smp) throw new Error('no sample ' + id);
    out.push(Object.assign({}, smp, { group, look }));
  }));
  all.forEach((x) => { if (!out.some((o) => o.id === x.id)) throw new Error('sample not placed: ' + x.id); });
  return out;
};
