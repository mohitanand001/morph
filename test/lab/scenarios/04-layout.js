// Pressing a button never moves anything else (the most annoying thing a panel can do).
const TABLE = { text: 'Area\tOwner\nAuth\tPriya\nSearch\tSam', html: '<table><tr><td>Area</td><td>Owner</td></tr><tr><td>Auth</td><td>Priya</td></tr><tr><td>Search</td><td>Sam</td></tr></table>' };
const parent = (p) => (p ? p.split('/').slice(0, -1).join('/') : '#');

module.exports = [
  {
    name: 'converting, undoing and saving a PDF move nothing else',
    settings: { autoFormat: false },
    run: async (lab, t) => {
      const docs = await lab.app('gdocs');
      const jira = await lab.app('jira');
      await docs.focus(); await docs.copy(TABLE);
      await jira.focus(); await lab.open();
      for (const press of ['Confluence', 'Undo', 'Save as PDF']) {
        const own = await lab.partOf(press);
        // The PDF button's slot swaps to Open / Show in folder by design: the slot may change, nothing around it.
        const allow = press === 'Save as PDF' ? [parent(own)] : [own];
        const sh = await lab.shifts(() => lab.click(press), allow);
        await lab.shot('After pressing ' + press);
        t.check('pressing ' + press + ' moves nothing else', sh.ok, sh.detail);
      }
    },
  },
  {
    name: 'Settings: switching options moves nothing else',
    run: async (lab, t) => {
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.click('Settings');
      await lab.click('Apps');
      await lab.shot('Settings → Apps');
      for (const label of ['All apps (off)', 'All apps (on)']) {
        const own = await lab.partOf('All apps');
        const sh = await lab.shifts(() => lab.click('All apps'), [own]);
        await lab.shot('After switching ' + label);
        t.check('switching ' + label + ' moves nothing else', sh.ok, sh.detail);
      }
    },
  },
];
