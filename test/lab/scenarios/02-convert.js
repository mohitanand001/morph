// Copy in one app, paste in another: through the real clipboard, with Morph's real conversion in between.
const fx = (n) => require('../../fixtures/' + n + '.json');
const TABLE = {
  text: 'Service\tStatus\tOwner\nAuth\tLive\tPriya\nSearch\tBeta\tSam',
  html: '<meta charset="utf-8"><table><tbody><tr><td><b>Service</b></td><td><b>Status</b></td><td><b>Owner</b></td></tr><tr><td>Auth</td><td>Live</td><td>Priya</td></tr><tr><td>Search</td><td>Beta</td><td>Sam</td></tr></tbody></table>',
};

module.exports = [
  {
    name: 'a Google Docs table becomes a Jira table, and Undo puts the original back',
    settings: { autoFormat: false },
    run: async (lab, t) => {
      const docs = await lab.app('gdocs');
      const jira = await lab.app('jira');
      await docs.focus();
      await docs.copy(TABLE);
      await jira.focus();
      await lab.open();
      await lab.shot('In Jira, after copying a table in Google Docs');
      const st = await lab.state();
      t.check('the card says where the copy came from', /Google Docs/.test(st.source && st.source.title), st.source && st.source.title);
      t.check('Jira is on top as "This app"', st.primary && st.primary.label === 'Jira' && st.primary.hint === 'This app', JSON.stringify(st.primary));
      await lab.click('Jira');
      await lab.shot('After clicking Jira');
      const got = await jira.paste();
      t.check('Jira receives a table', /<table/i.test(got.html) || /\|\|/.test(got.text), got.html.slice(0, 200) || got.text.slice(0, 200));
      t.known('the paste also carries plain text, for apps that only take text', got.text.trim().length > 0, JSON.stringify(got.formats), "GNOME Shell 46 can put only one format on the clipboard from Morph's helper (its scripting language can't offer several). Morph writes the formatted version, so plain-text apps get nothing.");
      await lab.click('Undo');
      const back = await jira.paste();
      t.check('Undo puts the original back', back.html.includes('<td>Auth</td>') || back.text.includes('Auth\tLive'), back.html.slice(0, 160));
    },
  },
  {
    name: 'converted text still pastes into a plain-text app',
    settings: { autoFormat: false },
    run: async (lab, t) => {
      const docs = await lab.app('gdocs');
      const ed = await lab.app('editor');
      await docs.focus();
      await docs.copy(TABLE);
      await lab.open();
      await lab.click('Slack');
      await ed.focus();
      const got = await ed.paste();
      t.known('a text editor gets the text, not nothing', got.text.includes('Auth'), 'formats offered: ' + JSON.stringify(got.formats) + ' text: ' + JSON.stringify(got.text.slice(0, 80)), "GNOME Shell 46 can put only one format on the clipboard from Morph's helper (its scripting language can't offer several). Morph writes the formatted version, so plain-text apps get nothing.");
    },
  },
  {
    name: 'an AI reply in Markdown becomes Slack formatting',
    settings: { autoFormat: false },
    run: async (lab, t) => {
      const f = fx('ai-markdown-reply');
      const ed = await lab.app('editor');
      const slack = await lab.app('slack');
      await ed.focus();
      await ed.copy({ text: f.text, html: f.html || '' });
      await slack.focus();
      await lab.open();
      await lab.click('Slack');
      const got = await slack.paste();
      t.check('Slack receives bold and a link, not ** and [ ]( )', !/\*\*ships\*\*/.test(got.text + got.html) && /ships/.test(got.text + got.html), (got.html || got.text).slice(0, 240));
    },
  },
  {
    name: 'Convert automatically: switch apps and plain Ctrl+V is already right',
    settings: { autoFormat: true },
    run: async (lab, t) => {
      const docs = await lab.app('gdocs');
      const jira = await lab.app('jira');
      await docs.focus();
      await docs.copy(TABLE);
      const same = await docs.paste();
      t.check('pasting back into the app you copied from is untouched', same.html.includes('<td>Auth</td>'), same.html.slice(0, 120));
      await jira.focus();
      await lab.settle(400);
      const got = await jira.paste();
      t.check('arriving in Jira converted it without opening Morph', got.html !== same.html || got.text !== same.text, (got.html || got.text).slice(0, 200));
      t.check('Morph stayed closed', !(await lab.state()).open);
    },
  },
];
