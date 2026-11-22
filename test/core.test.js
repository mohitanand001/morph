// Unit tests for the DOM-free parts: markdown + mrkdwn parsers, all
// renderers, fidelity notes. Run: node test/node-test.js
// (HTML parsing needs a real DOM; that's covered by test/browser-test.js.)
global.window = global;
require('../src/core/ast-utils.js');
require('../src/core/lift.js');
require('../src/core/people.js');
require('../src/core/terminal.js');
require('../src/core/render-text.js');
require('../src/core/detect.js');
require('../src/core/normalize-markdown.js');
require('../src/core/normalize-mrkdwn.js');
require('../src/core/render-slack.js');
require('../src/core/render-slack-html.js');
require('../src/core/render-jira.js');
require('../src/core/render-github.js');
require('../src/core/render-gdocs.js');
require('../src/core/fidelity.js');
require('../src/core/lists.js');
require('../src/core/render-email.js');
require('../src/core/pdf.js');

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
  }
}
function section(t) {
  if (process.env.VERBOSE) console.log('\n=== ' + t + ' ===');
}

// ------------------------------------------------------------------ markdown in
const claudeMd = [
  '## Incident summary',
  '',
  'The **checkout-api** service timed out in _prod_ after a ~~small~~ schema change in `payments_db`.',
  'See [the runbook](https://example.com/runbook) or https://example.com/inc/42.',
  '',
  '- Root cause: pool exhaustion',
  '  - triggered by migration `0042`',
  '  - no feature flag',
  '- Fix: rollback',
  '',
  '1. Add a pre-deploy check',
  '2. Alert on pool usage',
  '',
  '- [x] Roll back',
  '- [ ] Write postmortem',
  '',
  '| Service | Status | Owner |',
  '| --- | :---: | --- |',
  '| checkout-api | Resolved | Jane Doe |',
  '| payments-db | Monitoring | Raj Patel |',
  '',
  '```sql',
  'SELECT count(*) FROM pool;',
  '```',
  '',
  '> [!WARNING]',
  '> Don’t rerun the migration yet.',
  '',
  '> Escalated at 02:14 UTC.',
  '',
  '---',
  '',
  'Thanks :tada: snake_case_name stays as is.',
].join('\n');

const md = FB.markdownToAst(claudeMd);
const types = md.children.map((b) => b.type);
section('markdown AST block types');
if (process.env.VERBOSE) console.log(types.join(', '));
check('md: block sequence', JSON.stringify(types) === JSON.stringify([
  'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'table', 'codeBlock', 'panel', 'blockquote', 'divider', 'paragraph',
]), types.join(','));
check('md: heading level 2', md.children[0].level === 2);
const p1 = md.children[1].children;
check('md: bold', p1.some((n) => n.type === 'text' && n.bold && n.text === 'checkout-api'));
check('md: italic', p1.some((n) => n.type === 'text' && n.italic && n.text === 'prod'));
check('md: strike', p1.some((n) => n.type === 'text' && n.strike && n.text === 'small'));
check('md: inline code keeps underscore', p1.some((n) => n.type === 'text' && n.code && n.text === 'payments_db'));
check('md: link', p1.some((n) => n.type === 'link' && n.href === 'https://example.com/runbook'));
check('md: bare url', p1.some((n) => n.type === 'link' && n.href === 'https://example.com/inc/42'));
const nested = md.children[2].items[0].children;
check('md: nested list', nested.length === 2 && nested[1].type === 'bulletList' && nested[1].items.length === 2);
check('md: ordered list', md.children[3].items.length === 2);
check('md: task list states', md.children[4].items[0].checked === true && md.children[4].items[1].checked === false);
check('md: table header + rows', md.children[5].headerRow.length === 3 && md.children[5].rows.length === 2);
check('md: table alignment', md.children[5].align[1] === 'center');
check('md: code lang', md.children[6].language === 'sql' && md.children[6].content === 'SELECT count(*) FROM pool;');
check('md: alert -> panel', md.children[7].variant === 'warning');
check('md: emoji', md.children[10].children.some((n) => n.type === 'emoji' && n.shortcode === 'tada'));
check('md: intraword underscores not italic', FB.inlineToPlain(md.children[10].children).includes('snake_case_name'));

// Tricky inline cases
const inl = (s) => FB._markdownParseInline(s);
check('md: bold+italic ***x***', inl('***x***').every((n) => n.bold && n.italic));
check('md: italic containing bold', (() => {
  const r = inl('*a **b** c*');
  return r.length === 3 && r.every((n) => n.italic) && r[1].bold;
})());
check('md: lone asterisk stays literal', FB.inlineToPlain(inl('5 * 3 = 15')) === '5 * 3 = 15');
check('md: time stays text', FB.inlineToPlain(inl('at 10:30:00')) === 'at 10:30:00');
check('md: escaped star', FB.inlineToPlain(inl('\\*not italic\\*')) === '*not italic*');

// ------------------------------------------------------------------ detection
check('detect: claude markdown', FB.detectSource('', claudeMd).source === 'markdown');
check('detect: slack mrkdwn', FB.detectSource('', 'ping <@U12345|jane> about *this* <https://x.com|link>').source === 'slack-mrkdwn');
check('detect: plain', FB.detectSource('', 'just some words').source === 'plain-text');
check('detect: gdocs html', FB.detectSource('<b style="font-weight:normal;" id="docs-internal-guid-abc"><p>x</p></b>', 'x').source === 'gdocs');
check('detect: github html', FB.detectSource('<div class="markdown-body"><p>x</p></div>', 'x').source === 'github');
check('detect: slack html', FB.detectSource('<b data-stringify-type="bold">x</b>', 'x').source === 'slack');
check('detect: structureless html falls back to text', FB.detectSource('<meta charset="utf-8"><span>## Hi **there**</span>', '## Hi **there**').source === 'markdown');

// ------------------------------------------------------------------ github out
const gh = FB.astToGithub(md);
section('GitHub output');
if (process.env.VERBOSE) console.log(gh);
check('gh: heading', gh.startsWith('## Incident summary'));
check('gh: bold', gh.includes('**checkout-api**'));
check('gh: italic', gh.includes('_prod_'));
check('gh: strike', gh.includes('~~small~~'));
check('gh: code', gh.includes('`payments_db`'));
check('gh: link', gh.includes('[the runbook](https://example.com/runbook)'));
check('gh: bare url as autolink', gh.includes('<https://example.com/inc/42>'));
check('gh: nested list indented', /- Root cause: pool exhaustion\n  - triggered by migration `0042`/.test(gh), gh);
check('gh: ordered', gh.includes('1. Add a pre-deploy check\n2. Alert on pool usage'));
check('gh: tasks', gh.includes('- [x] Roll back\n- [ ] Write postmortem'));
check('gh: table', gh.includes('| Service | Status | Owner |\n| --- | :---: | --- |'));
check('gh: code fence lang', gh.includes('```sql\nSELECT count(*) FROM pool;\n```'));
check('gh: alert', gh.includes('> [!WARNING]\n> Don’t rerun the migration yet.'));
check('gh: divider', /\n---\n/.test(gh));
check('gh: emoji shortcode kept', gh.includes(':tada:'));
check('gh: snake_case not escaped', gh.includes('snake_case_name'));
// Round trip: GitHub output parses back to the same structure
const rt = FB.markdownToAst(gh);
check('gh: round-trips block types', JSON.stringify(rt.children.map((b) => b.type)) === JSON.stringify(types), rt.children.map((b) => b.type).join(','));
// Mentions don't ping on GitHub
const mentionAst = { type: 'doc', children: [{ type: 'paragraph', children: [FB.text('cc '), { type: 'mention', displayName: 'jane' }] }] };
check('gh: mention is code, not a live @', FB.astToGithub(mentionAst).trim() === 'cc `@jane`');
// Whitespace inside marks moves outside the delimiters
const wsAst = { type: 'doc', children: [{ type: 'paragraph', children: [FB.text('bold ', { bold: true }), FB.text('text')] }] };
check('gh: trailing space outside **', FB.astToGithub(wsAst).trim() === '**bold** text');
check('slack: trailing space outside *', FB.astToSlack(wsAst).trim() === '*bold* text');
// Literal markdown characters in text get escaped
const litAst = { type: 'doc', children: [{ type: 'paragraph', children: [FB.text('# not a heading, 2*3, [x]')] }] };
check('gh: escapes literal markdown', FB.astToGithub(litAst).trim() === '\\# not a heading, 2\\*3, \\[x\\]', FB.astToGithub(litAst));

// ------------------------------------------------------------------ gdocs out
const gd = FB.astToGdocsHtml(md);
check('gdocs: heading tag', gd.includes('<h2>Incident summary</h2>'));
check('gdocs: bold', gd.includes('<b>checkout-api</b>'));
check('gdocs: inline code is monospace span', /<span style="font-family:[^"]*monospace;[^"]*">payments_db<\/span>/.test(gd));
check('gdocs: nested ul', /<li>Root cause: pool exhaustion<ul><li>/.test(gd));
check('gdocs: table has cell borders', /<td style="border:1px solid/.test(gd));
check('gdocs: code block is a shaded box', gd.includes('background-color:#f1f3f4') && gd.includes('SELECT&nbsp;count(*)&nbsp;FROM&nbsp;pool;'));
check('gdocs: panel label', gd.includes('⚠️ <b>Warning</b>'));
check('gdocs: emoji becomes character', gd.includes('🎉') && !gd.includes(':tada:'));

// ------------------------------------------------------------------ slack + jira out
const sl = FB.astToSlack(md);
section('Slack mrkdwn');
if (process.env.VERBOSE) console.log(sl);
check('slack: heading -> bold line', sl.startsWith('*Incident summary*'));
check('slack: link mrkdwn', sl.includes('<https://example.com/runbook|the runbook>'));
check('slack: table fenced + aligned', /```\nService\s+\| Status\s+\| Owner\n-+-\|-/.test(sl), sl);
check('slack: alert -> quote with label', sl.includes('> ⚠️ *Warning*'));
const slh = FB.astToSlackHtml(md);
check('slack html: no heading tags', !/<h\d/.test(slh));
check('slack html: tables are real tables (Slack renders pasted tables since 2026)', /<table><tbody><tr><td><b>/.test(slh) || !/\|/.test(FB.astToSlack(ast)));
const jh = FB.astToJiraHtml(md);
check('jira: table', jh.includes('<th>Service</th>'));
check('jira: emoji char', jh.includes('🎉'));

// ------------------------------------------------------------------ mrkdwn in (regression)
const slackSample = [
  '*Deploy failed* for service _checkout-api_ in prod.',
  'Root cause:',
  '- timeout talking to `payments-db`',
  '> escalated to <@U123|jane> at 02:14 UTC',
  'Tracking link: <https://example.com/incidents/42|INC-42>',
].join('\n');
const sAst = FB.mrkdwnToAst(slackSample);
check('mrkdwn: list split from paragraph', sAst.children.some((b) => b.type === 'bulletList'));
check('mrkdwn: mention parsed', JSON.stringify(sAst).includes('"displayName":"jane"'));
check('mrkdwn -> github link', FB.astToGithub(sAst).includes('[INC-42](https://example.com/incidents/42)'));

// ------------------------------------------------------------------ fidelity
const notesSlack = FB.fidelityNotes(md, 'slack');
check('fidelity: slack warns about table + plain text', notesSlack.length >= 2 && /table/i.test(notesSlack[0]));
check('fidelity: github clean except panel', FB.fidelityNotes(md, 'github').length === 1);
check('fidelity: empty doc has no notes', FB.fidelityNotes({ children: [] }, 'slack').length === 0);
check('stats summary', FB.astStats(md).summary.startsWith('1 heading'));

// ------------------------------------------------------------------ text tables -> real tables
// Our own Slack output comes back as a real table (Slack -> Jira/Docs/GitHub).
const back = FB.liftStructure(FB.mrkdwnToAst(sl));
const backTable = back.children.find((b) => b.type === 'table');
check('slack text table lifts to a real table', !!backTable && backTable.headerRow.length === 3 && backTable.rows.length === 2);
const cellText = (c) => FB.inlineToPlain(c.children);
check('lifted cells keep their text', backTable && cellText(backTable.rows[0][0]) === 'checkout-api' && cellText(backTable.rows[0][2]) === 'Jane Doe');
check('lifted table -> Jira table', FB.astToJiraHtml(back).includes('<th>Service</th>'));
check('lifted table -> Docs table', FB.astToGdocsHtml(back).includes('<td style="border:1px solid'));
check('lifted table -> GitHub pipe table', FB.astToGithub(back).includes('| Service | Status | Owner |'));
check('lift counts what it found', back.lifted.tables === 1);

// Raw "| a | b |" lines in a Slack message, with text around the table.
const rawSlack = ['Status update:', '| Service | Status |', '|---|---|', '| api | up |', '| db | snake_case_name |', 'Thanks!'].join('\n');
const rawAst = FB.liftStructure(FB.mrkdwnToAst(rawSlack));
check('raw pipe lines become a table between paragraphs', JSON.stringify(rawAst.children.map((b) => b.type)) === '["paragraph","table","paragraph"]', rawAst.children.map((b) => b.type).join(','));
check('underscores in cells survive', cellText(rawAst.children[1].rows[1][1]) === 'snake_case_name');

// Other text-table dialects.
const mysql = '+----+------+\n| id | name |\n+----+------+\n|  1 | ann  |\n|  2 | bob  |\n+----+------+';
const mt = FB.parseTextTable(mysql);
check('mysql-style table', mt && mt.headerRow.length === 2 && mt.rows.length === 2 && cellText(mt.rows[0][1]) === 'ann');
const psql = ' id | name \n----+------\n  1 | ann\n  2 | bob\n(2 rows)';
const pt = FB.parseTextTable(psql);
check('psql-style table (footer ignored)', pt && pt.rows.length === 2 && cellText(pt.rows[1][1]) === 'bob');
const box = '┌────┬──────┐\n│ id │ name │\n├────┼──────┤\n│ 1  │ ann  │\n└────┴──────┘';
const bt = FB.parseTextTable(box);
check('box-drawing table', bt && bt.headerRow.length === 2 && cellText(bt.rows[0][1]) === 'ann');
check('empty last cell kept', (() => {
  const t = FB.parseTextTable('a | b | c\n--|---|--\n1 | 2 |');
  return t && t.rows[0].length === 3 && cellText(t.rows[0][2]) === '';
})());

// Things that must NOT become tables.
check('shell pipes are not a table', FB.parseTextTable('cat a.txt | grep foo\nls | wc -l\necho hi | tee x') === null);
check('ragged rows are not a table', FB.parseTextTable('a | b\n--|--\n1 | 2 | 3') === null);
const jsBlock = { type: 'doc', children: [{ type: 'codeBlock', language: 'js', content: 'Service | Status\n--------|-------\napi | up' }] };
check('a js code block is never turned into a table', FB.liftStructure(jsBlock).children[0].type === 'codeBlock');

// Runs of monospace paragraphs (Docs code) become one code block.
const codePara = (t) => ({ type: 'paragraph', children: [FB.text(t, { code: true })] });
const runAst = FB.liftStructure({ type: 'doc', children: [codePara('const a = 1;'), codePara('  run(a);')] });
check('code paragraph run -> one code block', runAst.children.length === 1 && runAst.children[0].type === 'codeBlock' && runAst.children[0].content === 'const a = 1;\n  run(a);');
const oneAst = FB.liftStructure({ type: 'doc', children: [codePara('npm test')] });
check('a single code paragraph stays inline code', oneAst.children[0].type === 'paragraph');

// ------------------------------------------------------------------ code fidelity
const codeContent = 'function f(a, b) {\n  if (a < b && b > 0) {\n    return `x${a}`;\n  }\n}';
const codeAst = { type: 'doc', children: [{ type: 'codeBlock', language: 'js', content: codeContent }] };
const ghCode = FB.astToGithub(codeAst);
check('code: GitHub fence + language', ghCode.startsWith('```js\n') && ghCode.includes(codeContent));
check('code: GitHub round trip is exact', FB.markdownToAst(ghCode).children[0].content === codeContent);
check('code: Jira escapes < & >', FB.astToJiraHtml(codeAst).includes('a &lt; b &amp;&amp; b &gt; 0'));
check('code: Docs keeps indentation with nbsp', FB.astToGdocsHtml(codeAst).includes('&nbsp;&nbsp;if'));
check('code: Slack fenced, content intact', FB.astToSlack(codeAst) === '```\n' + codeContent + '\n```');
const tick = { type: 'doc', children: [{ type: 'codeBlock', content: 'echo ```hi```' }] };
check('code: content with ``` gets a longer GitHub fence', FB.astToGithub(tick).startsWith('````\n'));
check('code: GitHub fence with ``` inside round-trips', FB.markdownToAst(FB.astToGithub(tick)).children[0].content === 'echo ```hi```');

// ------------------------------------------------------------------ code detection
check('detect: python is code', FB.detectSource('', 'def add(a, b):\n    return a + b\n\nprint(add(1, 2))').source === 'code');
check('detect: js is code', FB.detectSource('', 'const x = 5;\nfunction f() {\n  return x;\n}').source === 'code');
check('detect: code with # comments is still code', FB.detectSource('', '# setup\nx = 1;\n# run\nrun(x);\n').source === 'code');
check('detect: prose starting with If/For is not code', FB.detectSource('', 'If this fails, rerun it.\nFor example, try again.\nWhile waiting, relax a bit.').source === 'plain-text');
check('detect: markdown with a code fence stays markdown', FB.detectSource('', '## T\n```js\nconst a = 1;\n```\nText').source === 'markdown');
const vscode = '<meta charset=\'utf-8\'><div style="color:#d4d4d4;background-color:#1e1e1e;font-family:Consolas, \'Courier New\', monospace;font-weight:normal;font-size:14px;line-height:19px;white-space:pre;"><div><span>const a = 1;</span></div></div>';
check('detect: VS Code html is a code editor', FB.detectSource(vscode, 'const a = 1;').source === 'code-editor');

// ------------------------------------------------------------------ slack text parser fixes
const mp = (s) => FB.inlineToPlain(FB._mrkdwnParseInline(s));
check('mrkdwn: snake_case stays literal', mp('see payments_db_pool now') === 'see payments_db_pool now');
check('mrkdwn: italic at word boundaries still works', FB._mrkdwnParseInline('an _italic_ word')[1].italic === true);
check('mrkdwn: 2*3*4 stays literal', mp('2*3*4') === '2*3*4');
check('mrkdwn: <!here> becomes @here', mp('<!here> hi') === '@here hi');

// ------------------------------------------------------------------ slack mention links
const U = 'https://x.slack.com/team/U0AAAAAAA1';
const ms = FB.mrkdwnToAst('Hey, <' + U + '|@priya.shah>, hi');
const mnode = ms.children[0].children.find((n) => n.type === 'mention');
check('mrkdwn <team-url|@name> is a mention', !!mnode && mnode.displayName === 'priya.shah');
check('mention -> Slack text is @name, no url', FB.astToSlack(ms) === 'Hey, @priya.shah, hi');
check('mention -> Docs has no url', !FB.astToGdocsHtml(ms).includes('slack.com'));
const cl = FB.cleanSlackLink(U, U + '|@priya.shah');
check('cleanSlackLink splits url|label text', cl.isUser && cl.label === '@priya.shah' && cl.href === U);
const lk = FB.mrkdwnToAst('see <https://example.com/a|the runbook>');
check('slack plain-text copy writes label (url)', FB.astToSlack(lk, { plainLinks: true }) === 'see the runbook (https://example.com/a)');
check('slack html copy keeps <url|label>', FB.astToSlack(lk) === 'see <https://example.com/a|the runbook>');

// ------------------------------------------------------------------ people
const pa = FB.mrkdwnToAst('Hey <@U1|priya> and <@U2|Raj Patel>, ping <@U1|priya> again');
check('collectMentions is unique and ordered', JSON.stringify(FB.collectMentions(pa)) === '["priya","Raj Patel"]');
const mapped = FB.applyPeople(pa, { priya: 'a@x.com', 'raj patel': 'not-an-email' });
check('valid email -> mailto link', FB.astToGdocsHtml(mapped).includes('<a href="mailto:a@x.com"') && FB.astToGdocsHtml(mapped).includes('>priya</span></a>'));
check('invalid email is ignored', FB.astToGdocsHtml(mapped).includes('@Raj Patel') && !FB.astToGdocsHtml(mapped).includes('not-an-email'));
check('applyPeople does not mutate the source ast', FB.collectMentions(pa).length === 2);
check('mailto -> Jira link', FB.astToJiraHtml(mapped).includes('mailto:a@x.com'));
check('mailto -> Slack plain text shows the address', FB.astToSlack(mapped, { plainLinks: true }).includes('@priya (a@x.com)'));
check('no people -> same ast object', FB.applyPeople(pa, {}) === pa);

// ------------------------------------------------------------------ detection: code inside a message
const mixedHtml = '<meta charset="utf-8"><p>Hey</p><pre style="font-family:Monaco,monospace;white-space:pre">a | b\n--|--\n1 | 2</pre><p>Thanks</p>';
check('message with a code block is not a code editor', FB.detectSource(mixedHtml, 'x').source !== 'code-editor');
check('slack team link in html => slack', FB.detectSource('<a href="https://x.slack.com/team/U1">@a</a><p>hi</p>', 'x').source === 'slack');
check('docs table has column widths', /<td style="[^"]*width:\d+%/.test(FB.astToGdocsHtml(FB.liftStructure(FB.mrkdwnToAst(sl)))));

// ------------------------------------------------------------------ Docs people chips
const chipAst = FB.applyPeople(FB.mrkdwnToAst('hi <@U1|priya shah>'), { 'priya shah': 'priya@example.com' });
const chipHtml = FB.astToGdocsHtml(chipAst);
check('docs chip: mailto + data-rich-links person', chipHtml.includes('href="mailto:priya@example.com"') && chipHtml.includes('data-rich-links="{&quot;per_n&quot;:&quot;priya shah&quot;,&quot;per_e&quot;:&quot;priya@example.com&quot;,&quot;type&quot;:&quot;person&quot;}"'));
check('docs chip: only for Docs (Jira gets a plain link)', !FB.astToJiraHtml(chipAst).includes('data-rich-links'));
const withEmail = { type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'mention', displayName: 'Sam', email: 's@x.com' }] }] };
check('mention carrying an email becomes a link without the box', FB.astToGdocsHtml(FB.applyPeople(withEmail, {})).includes('mailto:s@x.com'));
check('mentionEmails reads emails off nodes', FB.mentionEmails(withEmail).sam === 's@x.com');

// ------------------------------------------------------------------ terminal
const term = 'priya@box:~/src/app$ git status\n\x1b[32mOn branch main\x1b[0m  \nnothing to commit\n';
check('terminal: prompt + ANSI detected', FB.detectSource('', term).source === 'terminal');
const ct = FB.cleanTerminal(term);
check('terminal: prompt becomes "$ ", ANSI stripped, trailing space trimmed', ct.content === '$ git status\nOn branch main\nnothing to commit' && ct.language === 'bash');
check('terminal: $ prompt alone is enough', FB.detectSource('', '$ npm test\n> app@1.0.0 test\n> jest\nPASS a.test.js').source === 'terminal');
check('terminal: python REPL', FB.cleanTerminal('>>> 1 + 1\n2').language === 'python');
check('terminal: powershell prompt', FB.cleanTerminal('PS C:\\Users\\me> Get-Date').content === 'PS> Get-Date' && FB.cleanTerminal('PS C:\\Users\\me> Get-Date').language === 'powershell');
check('prose with "$ 5 million" is not a terminal', FB.detectSource('', 'We raised $ 5 million\nand hired three people\nin the spring.').source !== 'terminal');
check('terminal -> markdown fence says bash', FB.astToGithub({ type: 'doc', children: [{ type: 'codeBlock', language: ct.language, content: ct.content }] }).startsWith('```bash\n$ git status'));

// ------------------------------------------------------------------ plain text destination
const plainAst = FB.liftStructure(FB.markdownToAst('## Title\n\nSome **bold** and a [link](https://x.com).\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | longer |\n\n```sh\nls -la\n```'));
const pt2 = FB.astToPlainText(plainAst);
check('plain: heading and marks removed', pt2.startsWith('Title\n\nSome bold and a link (https://x.com).'));
check('plain: bullets', pt2.includes('- one\n- two'));
check('plain: aligned table', pt2.includes('A | B     \n') || pt2.includes('A | B\n'));
check('plain: table row aligned', pt2.includes('1 | longer'));
check('plain: code without fences', pt2.includes('\nls -la') && !pt2.includes('```'));

// ------------------------------------------------------------------ tab-separated -> table
const tsv = FB.parseTextTable('Name\tQty\tPrice\nApple\t3\t1.5\nPear\t10\t2');
check('tsv becomes a table', tsv && tsv.headerRow.length === 3 && tsv.rows.length === 2);
check('tab-indented code is not a table', FB.parseTextTable('if (a) {\n\treturn 1;\n}') === null);
check('ai chat markup is recognised', FB.detectSource('<div data-message-author-role="assistant"><p>hi</p></div>', 'hi').source === 'ai-chat');

// the user's real terminal copy
const lsTxt = 'priya@laptop:~/Documents/work$ ls -la\ntotal 64860\ndrwxrwxr-x 35 priya priya     4096 Nov  7 12:39 .\n-rw-rw-r--  1 priya priya 15435161 Dec  2  2025 notes.pdf\n';
check('terminal: real ls -la paste (text only)', FB.detectSource('', lsTxt).source === 'terminal');
const termHtml = '<meta charset="utf-8"><pre style="font-family:Monospace;font-size:12pt;white-space:pre"><span style="color:#fff">priya@laptop:~/Documents/work$ ls -la\ntotal 64860</span></pre>';
check('terminal: same copy with terminal HTML', FB.detectSource(termHtml, lsTxt).source === 'terminal');
check('terminal: ls -la cleaned', FB.cleanTerminal(lsTxt).content.startsWith('$ ls -la\ntotal 64860'));

// copy that starts mid-output and ends on a bare prompt
const lsTail = 'drwxrwxr-x  2 priya priya     4096 Nov 14  2025 photos-2025\ndrwxrwxr-x  2 priya priya     4096 Jan 24  2026 tickets\ndrwxrwxr-x  2 priya priya     4096 Nov  1 16:08 logs\npriya@laptop:~/Documents/work$ ';
check('terminal: output + trailing bare prompt', FB.detectSource('', lsTail).source === 'terminal');
check('terminal: ls -l lines alone are enough', FB.detectSource('', lsTail.split('\n').slice(0, 3).join('\n')).source === 'terminal');
check('terminal: bare prompt cleans to $', FB.cleanTerminal(lsTail).content.endsWith('logs\n$'));
check('prose with an email and colon is not a terminal', FB.detectSource('', 'Mail me@x.com: it is $ 5 a month\nthanks a lot\nbye').source !== 'terminal');

// ------------------------------------------------------------------ list repair (text)
const lr = FB.repairTextLists('Plan:\n• Ship the app\n\t◦ Linux first\n\t◦ Mac later\n• Write tests\n\nSteps\na) Install\nb) Run\n\nI think this works.\nA. Smith wrote it.');
check('lists: glyph bullets become markdown', lr.text.includes('- Ship the app\n  - Linux first\n  - Mac later\n- Write tests'), lr.text);
check('lists: a) b) become a numbered list', lr.text.includes('1. Install\n1. Run'));
check('lists: prose starting with "I" or "A." is untouched', lr.text.includes('I think this works.\nA. Smith wrote it.'));
const lrAst = FB.markdownToAst(lr.text);
check('lists: nesting survives parsing', FB.astToGithub(lrAst).includes('- Ship the app\n  - Linux first'));
const nestedLr = FB.repairTextLists('1. Top\n    • child one\n    • child two\n2. Next');
check('lists: bullets under a numbered item nest under it', FB.astToGithub(FB.markdownToAst(nestedLr.text)).includes('1. Top\n   - child one'), nestedLr.text);
const fence = FB.repairTextLists('```\n• not a list in code\n```');
check('lists: code fences are left alone', !fence.changed);
check('lists: plain markdown already fine is unchanged', !FB.repairTextLists('- a\n  - b\n- c').changed);

// ------------------------------------------------------------------ list repair (Outlook paragraphs)
const ol = { type: 'doc', children: [
  { type: 'paragraph', children: [FB.text('· First')], listLevel: 1 },
  { type: 'paragraph', children: [FB.text('o Nested')], listLevel: 2 },
  { type: 'paragraph', children: [FB.text('· Second')], listLevel: 1 },
  { type: 'paragraph', children: [FB.text('Normal text')] },
] };
FB.repairListParagraphs(ol);
check('outlook lists: paragraphs become a nested list', ol.children[0].type === 'bulletList' && FB.astToGithub(ol).startsWith('- First\n  - Nested\n- Second'), FB.astToGithub(ol));
check('outlook lists: count of repaired items', ol.repairedListItems === 3);
const lone = { type: 'doc', children: [{ type: 'paragraph', children: [FB.text('- see above')] }] };
FB.repairListParagraphs(lone);
check('a single dash line stays a paragraph', lone.children[0].type === 'paragraph');
const numbered = { type: 'doc', children: [
  { type: 'paragraph', children: [FB.text('1. One')] }, { type: 'paragraph', children: [FB.text('2. Two')] }] };
FB.repairListParagraphs(numbered);
check('numbered paragraphs become an ordered list', numbered.children[0].type === 'orderedList' && numbered.children[0].items.length === 2);

// ------------------------------------------------------------------ email
const em = FB.astToEmailHtml(FB.markdownToAst('# Title\n\nSome **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n  x = 1\n```\n\n- one\n- two'));
check('email: no classes or <style>', !/class=|<style/.test(em));
check('email: table has border attribute and inline CSS', em.includes('<table border="1"') && em.includes('border:1px solid'));
check('email: code keeps indentation with nbsp', em.includes('&nbsp;&nbsp;x&nbsp;=&nbsp;1'));
check('email: headings are styled paragraphs (Outlook-safe)', !/<h\d/.test(em) && em.includes('font-weight:bold'));
check('email: lists have explicit margins', em.includes('<ul style="margin:0 0 10px 0;padding-left:24px;">'));


// ---------------------------------------------------------------- PDF text
{
  const pdf = 'Format Bridge converts content copied from one tool so it pastes cor-\nrectly into another. Text copied from a PDF viewer is a common case:\nevery line ends with a hard break, and words are hyphen-\nated at the end of a line.\nThe second paragraph starts here and continues on the\nnext line with more words to make it long enough to wrap.\nKey benefits\n• Paragraphs are rebuilt from the broken lines that the\nviewer produced when you copied them.\n• The ﬁrst ligature is ﬁxed.\n12\nThe end of the document comes after the page number.';
  check('pdf: detected', FB.looksLikePdfText(pdf));
  check('pdf: detectSource says pdf', FB.detectSource('', pdf).source === 'pdf');
  const r = FB.repairPdfText(pdf);
  check('pdf: split words rejoined', r.text.includes('correctly into another') && r.text.includes('hyphenated at the end'), r.text);
  check('pdf: lines joined into paragraphs', /common case: every line ends/.test(r.text), r.text);
  check('pdf: paragraph ends kept', /end of a line\.\n\nThe second paragraph/.test(r.text), r.text);
  check('pdf: heading kept on its own', /\n\nKey benefits\n\n/.test(r.text), r.text);
  check('pdf: bullets become a list, with wrapped tails joined', /- Paragraphs are rebuilt from the broken lines that the viewer produced when you copied them\./.test(r.text), r.text);
  check('pdf: ligatures replaced', r.text.includes('first ligature is fixed') && !/[\uFB00-\uFB06]/.test(r.text));
  check('pdf: page numbers dropped', !/\n12\n/.test(r.text) && r.changes.some((c) => /page number/.test(c)));
  check('pdf: becomes a real list', FB.markdownToAst(r.text).children.some((b) => b.type === 'bulletList'));
  check('pdf: ordinary notes are not PDF', !FB.looksLikePdfText('Hello team,\n\nThis is a short note.\n\nThanks,\nPriya'));
  check('pdf: markdown is not PDF', !FB.looksLikePdfText('# Title\n\nSome text here that is long enough to matter in this test.\n- a\n- b'));
  check('pdf: code is not PDF', !FB.looksLikePdfText('function a() {\n\treturn 1;\n}\nconst b = a();\nconsole.log(b);'));
  check('pdf: a terminal ls is not PDF', FB.detectSource('', 'priya@box:~$ ls -la\ntotal 8\ndrwxr-xr-x 2 priya priya 4096 Nov  9 01:00 .\ndrwxr-xr-x 9 priya priya 4096 Nov  9 01:00 ..').source !== 'pdf');
}
console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
