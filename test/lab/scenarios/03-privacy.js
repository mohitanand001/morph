// What Morph must never do, checked on a real desktop.
const { spawn } = require('child_process');

module.exports = [
  {
    name: 'a password manager copy is never read and never changed',
    settings: { autoFormat: true },
    run: async (lab, t) => {
      const kp = await lab.app('keepass');
      const slack = await lab.app('slack');
      await kp.focus();
      await kp.copy({ text: 'correct horse battery staple' });
      await slack.focus();
      await lab.open();
      await lab.shot('After copying in a password manager');
      const st = await lab.state();
      t.check('the card says it was never read', /password manager/i.test((st.source && st.source.sub) || ''), JSON.stringify(st.source));
      const got = await slack.paste();
      t.check('Slack pastes exactly what was copied', got.text === 'correct horse battery staple' && !got.html, JSON.stringify(got));
    },
  },
  {
    name: 'a password manager copy stays unread after you switch apps and wait',
    settings: { autoFormat: false },
    run: async (lab, t) => {
      // Older versions decided by the app in front *when they looked*: a regular look after you switched to Slack
      // read the password. Now it is decided by the app the copy was made in.
      const kp = await lab.app('keepass');
      const slack = await lab.app('slack');
      await kp.focus();
      await kp.copy({ text: 'hunter2 is my password' });
      await slack.focus();
      await new Promise((r) => setTimeout(r, 2500));
      await lab.open();
      const st = await lab.state();
      t.check('Morph still has not read it: the card names the password manager and says "Never read"', /KeePassXC/.test((st.source && st.source.title) || '') && /Never read/.test((st.source && st.source.sub) || ''), JSON.stringify(st.source));
      t.check('nothing of it is shown anywhere', !(await lab.texts()).some((x) => /hunter2/.test(x)));
      const got = await slack.paste();
      t.check('Slack pastes it unchanged', got.text === 'hunter2 is my password', JSON.stringify(got));
    },
  },
  {
    name: 'a lone word that may be a password is let go of at once',
    settings: { autoFormat: true },
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      const slack = await lab.app('slack');
      await ed.focus();
      await ed.copy({ text: 'Tr0ub4dor&3xK!' });
      await slack.focus();
      const got = await slack.paste();
      t.check('it pastes unchanged', got.text === 'Tr0ub4dor&3xK!', JSON.stringify(got));
      await lab.open();
      t.check('Morph shows nothing of it', !(await lab.texts()).some((x) => /Tr0ub4dor/.test(x)));
    },
  },
  {
    name: 'other programs cannot use Morph\'s helper (clipboard, window titles, keys)',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus();
      for (const [m, sig, args, out] of [['ReadClipboard', '', [], 's'], ['Get', '', [], 's'], ['Paste', 'b', [false], ''], ['WriteClipboard', 'ss', ['text/plain', 'aGk='], '']]) {
        const r = await lab.call('org.gnome.Shell', '/dev/morph/Focus', 'dev.morph.Focus', m, sig, args, out || null);
        t.check(m + ' is refused to a stranger', !r.ok && /AccessDenied/.test(r.dbusError + r.error), JSON.stringify(r).slice(0, 200));
      }
      t.check('…while Morph itself still works', (await lab.state()).peer);
    },
  },
  {
    name: 'Morph\'s helper never broadcasts window titles to the whole session',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      const slack = await lab.app('slack');
      const mon = spawn('gdbus', ['monitor', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/dev/morph/Focus'], { env: lab.env });
      let seen = '';
      mon.stdout.on('data', (d) => { seen += d; });
      await new Promise((r) => setTimeout(r, 500));
      await ed.focus(); await slack.focus(); await ed.focus();
      await new Promise((r) => setTimeout(r, 600));
      mon.kill();
      t.check('a listener sees no Changed signal with titles', !/Changed|notes\.txt|general - Slack/.test(seen), seen.slice(0, 300));
    },
  },
];
