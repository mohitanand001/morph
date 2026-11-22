(function () {
// For a given document and destination, lists what won't carry over
// exactly, in plain language. Shown under the preview and as a count on
// each destination.
window.FB = window.FB || {};

FB.DESTINATIONS = {
  slack: { name: 'Slack', short: 'Slack' },
  jira: { name: 'Jira or Confluence', short: 'Jira' },
  github: { name: 'Markdown', short: 'Markdown' },
  gdocs: { name: 'Google Docs', short: 'Docs' },
  text: { name: 'Plain text', short: 'Text' },
};

FB.features = function features(ast) {
  const f = {
    table: false, heading: false, taskList: false, panel: false, image: false,
    mention: false, nestedList: false, codeLang: false, strike: false, divider: false,
    emoji: false, unknownEmoji: false,
  };
  FB.walkBlocks(ast.children, (b, depth) => {
    if (b.type === 'table') f.table = true;
    if (b.type === 'heading') f.heading = true;
    if (b.type === 'taskList') f.taskList = true;
    if (b.type === 'panel') f.panel = true;
    if (b.type === 'divider') f.divider = true;
    if (b.type === 'codeBlock') f.codeBlock = true;
    if (b.type === 'codeBlock' && b.language) f.codeLang = true;
    if ((b.type === 'bulletList' || b.type === 'orderedList') && depth > 0) f.nestedList = true;
  });
  FB.walkInline(ast.children, (n) => {
    if (n.type === 'image') f.image = true;
    if (n.type === 'mention') f.mention = true;
    if (n.type === 'text' && n.strike) f.strike = true;
    if (n.type === 'emoji') {
      f.emoji = true;
      if (!FB.emojiChar(n.shortcode)) f.unknownEmoji = true;
    }
  });
  return f;
};

FB.fidelityNotes = function fidelityNotes(ast, dest, source) {
  if (dest === 'slack' && source === 'slack') return [];
  const f = FB.features(ast);
  const notes = [];
  const add = (text) => notes.push(text);

  if (dest === 'slack') {
    if (f.table) {
      add('The table pastes as a real Slack table. Cell text keeps bold, italic and links; other formatting inside cells may be dropped.');
    }
    if (f.heading) add('Headings become bold lines. Slack has no heading sizes.');
    if (f.taskList) add('Checkboxes become ☐ and ☑ characters.');
    if (f.panel) add('Callout panels become quotes with an icon.');
    if (f.image) add('Images become links.');
    if (f.mention) add('@mentions paste as plain text and won’t notify anyone.');
    if (f.codeLang) add('Code blocks lose their language label.');
  }

  if (dest === 'jira') {
    if (f.taskList) add('Checkboxes become ☐ and ☑ characters. Type [] in Jira to make real ones.');
    if (f.panel) add('Callout panels become quotes with a label. Use /panel in Jira for a real one.');
    if (f.mention) add('@mentions become bold names (or mail links when they carry an email). Retype them with @ to notify someone.');
    if (f.image) add('Images only come through if Jira can load them from their original link.');
    if (f.unknownEmoji) add('Some emoji shortcodes have no matching character and stay as :text:.');
  }

  if (dest === 'github') {
    if (f.mention) add('@mentions become code text, so they don’t notify a GitHub user who happens to have the same handle.');
    if (f.panel) add('Callout panels become GitHub alerts (> [!NOTE] and similar).');
    if (f.image) add('Images stay linked to their original source and only show if it’s public.');
  }

  if (dest === 'text') {
    if (f.table) add('The table becomes aligned columns separated by |.');
    if (f.heading) add('Headings become plain lines.');
    if (f.codeBlock) add('Code blocks lose their fences, so they run into the surrounding text.');
    if (f.panel) add('Callout panels become a NOTE: or WARNING: line.');
    if (f.mention) add('@mentions stay as @name' + '.');
    if (f.image) add('Images become their link.');
    add('All bold, italic and other formatting is removed, and links read “label (url)”.');
  }

  if (dest === 'gdocs') {
    if (f.taskList) add('Checkboxes become ☐ and ☑ characters, not a Docs checklist.');
    if (f.codeBlock) add('Code blocks become shaded monospace boxes without syntax colors.');
    if (f.panel) add('Callout panels become shaded boxes with a label.');
    if (f.mention) add('@mentions become bold names (or mail links when they carry an email), not people chips.');
    if (f.image) add('Images only come through if Docs can load them from their original link.');
    if (f.unknownEmoji) add('Some emoji shortcodes have no matching character and stay as :text:.');
  }

  return notes;
};
})();
