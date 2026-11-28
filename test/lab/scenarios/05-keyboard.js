// Keyboard: Settings can be used without a mouse; the main panel never takes the keyboard from your app.
module.exports = [
  {
    name: 'Settings works with Tab, Enter and Esc',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.click('Settings');
      t.check('Settings takes the keyboard', (await lab.state()).hasGrab);
      await lab.key('tab');
      const f1 = await lab.focused();
      t.check('Tab puts a focus ring on a control', !!f1, 'nothing focused');
      await lab.shot('Keyboard focus in Settings');
      await lab.key('tab');
      const f2 = await lab.focused();
      t.check('Tab again moves on', f2 && f1 && f2.path !== f1.path, JSON.stringify([f1 && f1.path, f2 && f2.path]));
      await lab.key('esc');
      const st = await lab.state();
      t.check('Esc goes back to the main panel and gives the keyboard back', st.view !== 'settings' && !st.hasGrab, JSON.stringify(st));
    },
  },
  {
    name: 'with Morph open, typing still goes to your app',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus();
      await ed.copy({ text: 'hello there friend' });
      await lab.open();
      const got = await ed.paste();
      t.check('Ctrl+V reaches the app with the panel open', got.text === 'hello there friend', JSON.stringify(got));
    },
  },
  {
    name: 'a click outside Settings hands the keyboard back',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.click('Settings');
      await lab.lab('click(400, 400)');
      await lab.settle();
      t.check('the keyboard is released', !(await lab.state()).hasGrab);
    },
  },
];
