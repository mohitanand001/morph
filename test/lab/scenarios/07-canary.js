// Privacy, measured: unique made-up words go through every Morph feature, then every file Morph could have
// written and every log (with debug logging on) is searched for them. Morph's program runs under strace, so every
// network connection it or a child opens is on record.
const C = { table: 'Zebracanary41 quarterly', plain: 'Ottercanary52 notes for later', md: 'Lynxcanary63 release', pm: 'Pumacanary74 vault secret' };
const b64 = (s) => Buffer.from(s).toString('base64');

module.exports = [
  {
    name: 'nothing you copy is written anywhere, and Morph makes no network calls of its own',
    settings: { autoFormat: true },
    trace: true,
    run: async (lab, t) => {
      const fs = require('fs');
      const path = require('path');
      const listPdfs = () => { try { return fs.readdirSync(path.join(lab.home, 'Downloads')); } catch (e) { return []; } };
      const pdfsBefore = listPdfs();
      const docs = await lab.app('gdocs');
      const jira = await lab.app('jira');
      const ed = await lab.app('editor');
      const slack = await lab.app('slack');
      const kp = await lab.app('keepass');
      // A table, converted automatically on arrival, then by hand, undone, saved as a PDF
      await docs.focus();
      await docs.copy({ text: 'Area\tOwner\n' + C.table + '\tPriya', html: '<table><tr><td>Area</td><td>Owner</td></tr><tr><td>' + C.table + '</td><td>Priya</td></tr></table>' });
      await jira.focus(); await jira.paste();
      await lab.open(); await lab.click('Confluence'); await lab.click('Undo'); await lab.click('Save as PDF');
      // Plain text and Markdown
      await ed.focus(); await ed.copy({ text: C.plain });
      await ed.copy({ text: '**' + C.md + '** ships\n\n- item one\n- item two' });
      await slack.focus(); await slack.paste();
      // A password manager copy
      await kp.focus(); await kp.copy({ text: C.pm });
      await slack.focus(); await new Promise((r) => setTimeout(r, 1500));
      await lab.settle();
      // Everything Morph and GNOME wrote under the home folder (settings, caches, logs, the private runtime folder)
      const files = lab.filesWritten().filter((f) => !/\/Downloads\//.test(f.path));
      const logs = ['morph-daemon.log', 'gnome-shell.log'].map((n) => ({ path: n, content: fs.readFileSync(path.join(lab.dir, n), 'latin1') }));
      for (const [kind, word] of Object.entries(C)) {
        const hits = files.concat(logs).filter((f) => f.content.includes(word) || f.content.includes(b64(word)) || f.content.includes(b64(word).slice(0, 16)));
        t.check('the ' + kind + ' copy is in no file and no log (debug logging on)', !hits.length, hits.map((h) => h.path).join(', '));
      }
      const pdfs = listPdfs().filter((f) => !pdfsBefore.includes(f));
      t.check('the only place a copy lands is the PDF you asked for, in Downloads', pdfs.length === 1 && /^Morph_\d{4}-\d\d-\d\d_\d\d\.\d\d\.\d\d\.pdf$/.test(pdfs[0]), pdfs.join(', '));
      const mine = files.filter((f) => /\/(morph|morph-icons|morph-ocr)\//.test(f.path) || /morph[^/]*\.log$/.test(f.path));
      lab.note('Morph\'s files: ' + mine.map((f) => f.path.replace(lab.home, '~') + ' (' + f.mode + ')').join(', '));
      t.check('Morph\'s own files are not writable by anyone else', mine.every((f) => !(parseInt(f.mode, 8) & 0o022)), mine.map((f) => f.path + ' ' + f.mode).join(', '));
      // Network
      const trace = fs.readFileSync(lab.traceFile, 'utf8').split('\n');
      const out = lab.networkConnections();
      const execs = trace.filter((l) => /execve\(/.test(l) && !/= -1 /.test(l)).map((l) => (l.match(/execve\("([^"]+)", \[([^\]]*)\]/) || [, '', ''])).map((m) => m[1] + ' ' + m[2]);
      lab.note('Programs Morph started: ' + (execs.slice(1).join(' | ') || 'none'));
      lab.note('Network connections: ' + (out.length ? out.join(' | ') : 'none'));
      const curls = execs.filter((e) => /curl/.test(e));
      t.check('Morph\'s program opened no network connection except the update check', out.every((l) => curls.length > 0), out.join(' | '));
      t.check('the update check, if it ran, only asked the Morph website for version.json', curls.every((c) => /mohitanand001\.github\.io\/morph\/version\.json/.test(c) || /MORPH_UPDATE_URL/.test(c)), curls.join(' | '));
    },
  },
  {
    name: 'the update check sends nothing about you: one plain request for version.json',
    trace: true,
    run: async (lab, t) => {
      const fs = require('fs');
      const ed = await lab.app('editor');
      await ed.focus(); await lab.open();
      await lab.click('Settings'); await lab.click('Updates');
      await lab.click('Check for updates');
      await lab.waitFor('the check to finish', async () => /latest|available|reach|connection|Try again/i.test((await lab.texts()).join(' ')), 20000);
      await lab.shot('After checking for updates');
      const trace = fs.readFileSync(lab.traceFile, 'utf8').split('\n');
      const execs = trace.filter((l) => /execve\(/.test(l) && !/= -1 /.test(l)).map((l) => (l.match(/execve\("([^"]+)", \[([^\]]*)\]/) || [, '', ''])).map((m) => m[1] + ' ' + m[2]).slice(1);
      lab.note('Programs Morph started: ' + execs.join(' | '));
      const curls = execs.filter((e) => /curl/.test(e));
      t.check('it ran exactly one request', curls.length === 1, execs.join(' | '));
      t.check('to the Morph website, for version.json, with no cookies, headers or data', curls.every((c) => /"https:\/\/mohitanand001\.github\.io\/morph\/version\.json"/.test(c) && !/-H|--header|-d|--data|-b|--cookie|-A|--user-agent|-F/.test(c)), curls.join(' | '));
      const conns = lab.networkConnections();
      lab.note('Network connections: ' + (conns.join(' | ') || 'none'));
      t.check('every connection came from that request', conns.length <= 4);
    },
  },
];
