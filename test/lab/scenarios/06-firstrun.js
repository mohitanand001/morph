// First run, labels and the tab: what a new user sees.
module.exports = [
  {
    name: 'a new install shows the welcome card once, and Got it closes it',
    settings: null, // no settings file: a brand-new install
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus();
      await lab.waitFor('the welcome card', async () => (await lab.texts()).includes('Got it'), 8000);
      await lab.shot('Welcome card');
      const texts = (await lab.texts()).join(' ');
      t.check('it says Morph converts when you switch apps (on by default)', /converts your copy when you switch/.test(texts), texts.slice(0, 300));
      await lab.click('Got it');
      t.check('Got it closes it', !(await lab.texts()).includes('Got it'));
    },
  },
  {
    name: 'icon buttons say what they do on hover',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.hover('Settings');
      await lab.shot('Hovering the gear');
      const tip = (await lab.tree()).filter((n) => n.path.startsWith('tip') && n.text).map((n) => n.text);
      t.check('the gear shows "Settings"', tip.includes('Settings'), JSON.stringify(tip));
    },
  },
  {
    name: 'the ✕ only folds Morph into its tab',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.click('Close');
      const st = await lab.state();
      t.check('the panel closed', !st.open);
      t.check('the tab is still there', st.visible);
    },
  },
];
