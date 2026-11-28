// The lab itself works: GNOME Shell, Morph's helper and program, a stand-in app and the clipboard.
module.exports = [
  {
    name: 'smoke: the tab is on screen and the panel opens',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus();
      const st = await lab.state();
      t.check('the tab is on screen', st.visible);
      await lab.open();
      await lab.shot('Morph open over a text editor');
      t.check('the panel is open', (await lab.state()).open);
      t.check('the panel says Morph', (await lab.texts()).includes('Morph'));
    },
  },
];
