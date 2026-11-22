(function () {
// The headless converter: clipboard content in, converted content out. No window, no DOM,
// no storage. The app window, the background program on GNOME and the tests all call this.
window.FB = window.FB || {};

const NAMES = {
  slack: 'Slack', jira: 'Jira', confluence: 'Confluence', email: 'Email', gdocs: 'Google Docs', markdown: 'Markdown',
  text: 'Plain text', notion: 'Notion', linear: 'Linear', teams: 'Teams',
};
const TEXT_SOURCES = new Set(['markdown', 'slack-mrkdwn', 'plain-text', 'code', 'log', 'terminal', 'pdf']);
const LIST_REPAIR_SOURCES = new Set(['markdown', 'slack-mrkdwn', 'plain-text']);

const E = {};
FB.engine = E;
E.NAMES = NAMES;

// What kind of content is this? Returns { source, how }.
E.detect = function detect(html, text, context) {
  const det = FB.detectSource(html || '', text || '');
  let source = det.source;
  let how = det.how;
  // Copied in a PDF viewer: treat plain text as PDF text even if it's short.
  if (context && context.pdf && !html && (source === 'plain-text' || source === 'markdown')) { source = 'pdf'; how = 'app'; }
  return { source, how };
};

// Read the content into a document tree. Returns { ast, repairs, failed }.
E.toAst = function toAst(html, text, source) {
  let ast;
  const repairs = [];
  let failed = false;
  try {
    let t = text || '';
    if (LIST_REPAIR_SOURCES.has(source)) {
      const r = FB.repairTextLists(t);
      if (r.changed) { t = r.text; repairs.push('Rebuilt the list indentation.'); }
    }
    if (source === 'pdf') {
      const r = FB.repairPdfText(t);
      t = r.text;
      r.changes.forEach((c) => repairs.push(c));
    }
    if (source === 'terminal') {
      const c = FB.cleanTerminal(t);
      ast = { type: 'doc', children: [{ type: 'codeBlock', language: c.language, content: c.content }] };
      repairs.push('Cleaned terminal output: prompts, colour codes, trailing spaces.');
    } else if (source === 'code' || source === 'log') {
      ast = { type: 'doc', children: [{ type: 'codeBlock', content: t.replace(/^\n+|\s+$/g, '') }] };
    } else if (source === 'plain-text' && !html && FB.parseTextTable(t)) {
      ast = { type: 'doc', children: [FB.parseTextTable(t)] };
      repairs.push('Read the spreadsheet text as a real table.');
    } else if (!html || TEXT_SOURCES.has(source)) {
      ast = source === 'slack-mrkdwn' ? FB.mrkdwnToAst(t) : FB.markdownToAst(t);
    } else {
      ast = FB.htmlToAst(html);
      if (!ast.children.length && t.trim()) {
        ast = source === 'code-editor' ? { type: 'doc', children: [{ type: 'codeBlock', content: t.trim() }] } : FB.markdownToAst(t);
      }
    }
    FB.liftStructure(ast);
    FB.repairListParagraphs(ast);
    const l = ast.lifted || {};
    if (l.tables) repairs.push(l.tables === 1 ? 'Read a text table as a real table.' : 'Read ' + l.tables + ' text tables as real tables.');
    if (l.codeBlocks) repairs.push(l.codeBlocks === 1 ? 'Joined monospace lines into a code block.' : 'Joined monospace lines into ' + l.codeBlocks + ' code blocks.');
    if (ast.repairedListItems) repairs.push('Turned ' + ast.repairedListItems + ' bullet-style paragraphs into a real list.');
  } catch (err) {
    ast = { type: 'doc', children: [] };
    failed = true;
  }
  return { ast, repairs, failed };
};

E.hasContent = function hasContent(ast) { return !!(ast && ast.children && ast.children.length); };

// opts: { html, source, context, linkBack, people }
// Pairs that already paste perfectly without us: the original goes back untouched.
E.passthrough = function passthrough(dest, opts) {
  if (!opts.html) return false;
  return (dest === 'slack' && opts.source === 'slack') ||
    ((dest === 'jira' || dest === 'confluence') && opts.source === 'atlassian');
};

// A "Source: Slack · #design" line, only when asked for, only into a different app, never into plain text.
E.linkingTo = function linkingTo(dest, opts) {
  const c = opts.context;
  return !!(opts.linkBack && c && c.label && dest !== 'text' && c.dest !== dest && !E.passthrough(dest, opts));
};
E.withSourceLink = function withSourceLink(ast, dest, opts) {
  if (!E.linkingTo(dest, opts)) return ast;
  const c = opts.context;
  const it = { italic: true };
  const inl = [FB.text('Source: ' + c.tool + ' · ', it)];
  inl.push(c.url ? { type: 'link', href: c.url, children: [FB.text(c.label, it)] } : FB.text(c.label, it));
  return Object.assign({}, ast, { children: ast.children.concat([{ type: 'paragraph', children: inl }]) });
};

// The converted result for one destination: { html, text }.
E.outputs = function outputs(dest, rawAst, opts) {
  // Mentions that carry an email (Docs chips) become mail links / chips.
  const ast = E.withSourceLink(FB.applyPeople(rawAst, (opts && opts.people) || {}), dest, opts || {});
  switch (dest) {
    case 'slack': return { html: FB.astToSlackHtml(ast), text: FB.astToSlack(ast) };
    case 'jira':
    case 'confluence': return { html: FB.astToJiraHtml(ast), text: FB.astToGithub(ast) };
    case 'email': return { html: FB.astToEmailHtml(ast), text: FB.astToPlainText(ast) };
    case 'gdocs': return { html: FB.astToGdocsHtml(ast), text: FB.astToGithub(ast) };
    case 'markdown': return { html: '', text: FB.astToGithub(ast) };
    case 'text': return { html: '', text: FB.astToPlainText(ast) };
    // Notion turns clean HTML into blocks; markdown text is its fallback.
    case 'notion': return { html: FB.astToEmailHtml(ast), text: FB.astToGithub(ast) };
    // Linear's editor reads markdown.
    case 'linear': return { html: '', text: FB.astToGithub(ast) };
    // Teams takes the same simple, inline-styled HTML as email.
    case 'teams': return { html: FB.astToEmailHtml(ast), text: FB.astToPlainText(ast) };
    default: return { html: '', text: '' };
  }
};

E.notes = function notes(dest, ast, opts) {
  if (E.passthrough(dest, opts)) return [];
  const link = E.linkingTo(dest, opts) ? ['Adds a link back to where you copied it: ' + opts.context.tool + ' · ' + opts.context.label + '.'] : [];
  return link.concat(notesForContent(dest, ast, opts));
};
function notesForContent(dest, ast, opts) {
  if (dest === 'email' || dest === 'teams') {
    const f = FB.features(ast);
    const n = [];
    if (f.codeBlock) n.push('Code blocks become shaded boxes in a monospace font, without syntax colours.');
    if (f.taskList) n.push('Checkboxes become ☐ and ☑ characters.');
    if (f.panel) n.push('Callout panels become shaded boxes with their label.');
    if (f.mention) n.push('@mentions become bold names (or mail links when they carry an email).');
    if (f.image) n.push('Images become links to the original image.');
    return n;
  }
  const map = { confluence: 'jira', markdown: 'github', linear: 'github', notion: 'github' };
  return FB.fidelityNotes(ast, map[dest] || dest, opts.source)
    .map((s) => s.replace(/Jira or Confluence/g, NAMES[dest]));
}

// One call for the whole job: detect, read, convert. Returns what a pill or a test needs.
// clip: { html, text, context, linkBack, people, source? (forced) }
E.run = function run(clip, dest) {
  const html = clip.html || '';
  const text = clip.text || '';
  const det = clip.source ? { source: clip.source, how: 'manual' } : E.detect(html, text, clip.context);
  const r = E.toAst(html, text, det.source);
  const opts = { html, source: det.source, context: clip.context || null, linkBack: !!clip.linkBack, people: clip.people || {} };
  const has = E.hasContent(r.ast);
  return {
    source: det.source,
    how: det.how,
    ast: r.ast,
    repairs: r.repairs,
    failed: r.failed,
    has,
    summary: has ? (FB.SOURCES[det.source] || 'Clipboard') + ': ' + (FB.astStats(r.ast).summary || 'text') : '',
    passthrough: dest ? E.passthrough(dest, opts) : false,
    out: dest && has ? (E.passthrough(dest, opts) ? { html: html, text: text, passthrough: true } : E.outputs(dest, r.ast, opts)) : null,
    opts,
  };
};

E.pdfTitle = function pdfTitle(ast) {
  const first = ((ast && ast.children) || []).find((b) => b.type === 'heading') || ((ast && ast.children) || [])[0];
  const t = first ? FB.astToPlainText({ type: 'doc', children: [first] }).split('\n')[0].trim() : '';
  return (t || 'Morph').slice(0, 80);
};
})();
