(function () {
// Guesses which tool a pasted clipboard payload came from. Returns
// { source, how } where how is 'markup' (fingerprint in the HTML, reliable)
// or 'text' (heuristics on plain text, a guess). The UI always lets the user
// override.
window.FB = window.FB || {};

FB.SOURCES = {
  gdocs: 'Google Docs',
  atlassian: 'Jira / Confluence',
  github: 'GitHub',
  slack: 'Slack',
  outlook: 'Outlook',
  'rich-text': 'Web page or app',
  'code-editor': 'Code editor',
  code: 'Code (plain text)',
  terminal: 'Terminal output',
  'ai-chat': 'AI chat (Claude, ChatGPT)',
  markdown: 'Markdown (Claude, Cursor, ChatGPT)',
  'slack-mrkdwn': 'Slack message text',
  'plain-text': 'Plain text',
  pdf: 'PDF',
  log: 'Log output',
};

FB.detectSource = function detectSource(html, plain) {
  if (html && html.trim() && /<[a-z]/i.test(html)) {
    const lower = html.toLowerCase();

    if (lower.includes('docs-internal-guid') || lower.includes('google-sheets-html-origin')) {
      return { source: 'gdocs', how: 'markup' };
    }
    if (
      lower.includes('ak-renderer') ||
      lower.includes('data-node-type') ||
      lower.includes('data-pm-slice') ||
      lower.includes('confluence-information-macro') ||
      lower.includes('conf-macro') ||
      lower.includes('fabric-')
    ) {
      return { source: 'atlassian', how: 'markup' };
    }
    if (
      lower.includes('markdown-body') ||
      lower.includes('highlight-source-') ||
      lower.includes('task-list-item') ||
      lower.includes('markdown-alert') ||
      lower.includes('octicon')
    ) {
      return { source: 'github', how: 'markup' };
    }
    if (
      lower.includes('data-stringify-type') ||
      lower.includes('c-mrkdwn') ||
      lower.includes('c-message') ||
      lower.includes('c-texty') ||
      lower.includes('p-rich_text') ||
      /https?:\/\/[a-z0-9-]+\.slack\.com\/(team|archives|files)\//.test(lower)
    ) {
      return { source: 'slack', how: 'markup' };
    }
    if (lower.includes('urn:schemas-microsoft-com') || lower.includes('mso-') || lower.includes('xmlns:o=')) {
      return { source: 'outlook', how: 'markup' };
    }

    // Terminals (GNOME Terminal, iTerm, VS Code's terminal) often put HTML
    // on the clipboard too. A shell prompt or colour codes in the text give
    // them away, whatever the markup looks like.
    if (plain && FB.looksLikeTerminal && FB.looksLikeTerminal(plain) && !/<(p|h[1-6]|ul|ol|li|table|a|blockquote)[\s>]/i.test(html)) {
      return { source: 'terminal', how: 'text' };
    }

    // Claude and ChatGPT pages (selected text keeps their class names).
    if (
      lower.includes('font-claude') ||
      lower.includes('data-message-author-role') ||
      lower.includes('claude-message') ||
      lower.includes('conversation-turn')
    ) {
      return { source: 'ai-chat', how: 'markup' };
    }

    // Code editors (VS Code, JetBrains) copy code as monospace,
    // white-space:pre markup.
    const monoFont = /font-family:[^;"]*(mono|courier|consolas|menlo|monaco)/i.test(html);
    // ...but only when the whole payload is code. A message that merely
    // contains a code block also has paragraphs, links or tables around it.
    const outsidePre = html.replace(/<pre[\s\S]*?<\/pre>/gi, '');
    const mixed = /<(p|h[1-6]|ul|ol|li|table|strong|b|em|i|a|blockquote)[\s>]/i.test(outsidePre);
    if (monoFont && !mixed && (/white-space:\s*pre/i.test(html) || /<pre[\s>]/i.test(html))) {
      return { source: 'code-editor', how: 'markup' };
    }

    // HTML with no real structure (e.g. a terminal or editor that wraps
    // plain text in a <pre> or a single <div>) — treat as text.
    const hasStructure = /<(p|h[1-6]|ul|ol|li|table|strong|b|em|i|a|blockquote|code)[\s>]/i.test(html);
    if (hasStructure) return { source: 'rich-text', how: 'markup' };
  }

  if (plain && plain.trim()) {
    const flavor = guessTextFlavor(plain);
    // Copied out of a PDF: lines broken mid-sentence, split words.
    // ("•" bullets alone also look like Slack text; real Slack text has <@U…> or <#C…>.)
    const weakSlack = flavor === 'slack-mrkdwn' && !/<[@#!][A-Z]|<https?:/.test(plain);
    if ((flavor === 'plain-text' || weakSlack) && FB.looksLikePdfText && FB.looksLikePdfText(plain)) return { source: 'pdf', how: 'text' };
    return { source: flavor, how: 'text' };
  }
  return { source: 'plain-text', how: 'text' };
};

function guessTextFlavor(text) {
  let md = 0;
  let slack = 0;
  const heading = /^#{1,6}\s+\S/m.test(text);
  if (heading) md += 3;
  if (/\*\*[^*\n]+\*\*/.test(text)) md += 3;
  if (/__[^_\n]+__/.test(text)) md += 2;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(text)) md += 3;
  if (/^\s*\|.*\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}/m.test(text)) md += 3;
  if (/^\s*[-*+]\s+\[[ xX]\]\s/m.test(text)) md += 3;
  if (/~~[^~\n]+~~/.test(text)) md += 2;
  if (/^```[a-z]+/m.test(text)) md += 1;
  if (/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(text)) md += 3;

  if (/<@[UW][A-Z0-9]+(\|[^>]+)?>/.test(text)) slack += 4;
  if (/<#C[A-Z0-9]+(\|[^>]*)?>/.test(text)) slack += 4;
  if (/<https?:\/\/[^|>\s]+\|[^>]+>/.test(text)) slack += 4;
  if (/(^|\s)\*[^*\s][^*\n]*\*(\s|[.,!?]|$)/m.test(text) && !/\*\*/.test(text)) slack += 1;
  if (/(^|\s)~[^~\s][^~\n]*~(\s|$)/m.test(text) && !/~~/.test(text)) slack += 1;
  if (/^\s*•\s/m.test(text)) slack += 1;

  if (slack > md) return 'slack-mrkdwn';
  // Code has "#" comments that look like headings, so a heading alone must
  // not veto code; any other markdown signal does.
  const mdStrong = md - (heading ? 3 : 0);
  if (mdStrong === 0 && FB.looksLikeTerminal && FB.looksLikeTerminal(text)) return 'terminal';
  if (mdStrong === 0 && looksLikeLog(text)) return 'log';
  if (mdStrong === 0 && looksLikeCode(text)) return 'code';
  if (md > 0) return 'markdown';
  // No strong signal: markdown parsing is a safe superset for plain text
  // (lists, paragraphs, links still come through).
  return 'plain-text';
}

// Server logs and stack traces: lines that start with a timestamp or a level, or are a Python/JS/Java
// stack frame. Half the lines (or a "Traceback" with a few lines around it) is enough. Kept as lines:
// without this the PDF check would glue them into one paragraph.
function looksLikeLog(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  const STAMP = /^\s*[\[(]?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2})/;
  const LEVEL = /^\s*[\[(]?[^\sA-Za-z]*\s?\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/;
  const FRAME = /^\s+at\s+\S+.*[(:]\S*:\d+|^\s*File "[^"]+", line \d+|^\s*Caused by:|^\s+\.\.\. \d+ more|^\s*at .+\.(java|js|ts|kt|cs):\d+/;
  const TRACE = /^Traceback \(most recent call last\)|^[\w.]+(Error|Exception)(:|$)|^\s*panic:|^goroutine \d+/;
  let hits = 0, trace = false;
  lines.forEach((l) => {
    if (TRACE.test(l)) { trace = true; hits++; } else if (STAMP.test(l) || LEVEL.test(l) || FRAME.test(l)) hits++;
  });
  return hits / lines.length >= 0.5 || (trace && hits >= 3);
}

// At least three non-blank lines, half of which look like code: statement
// endings, braces, keywords, arrows, deep indentation or comment markers.
function looksLikeCode(text) {
  if (/^```/m.test(text)) return false;
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  // Keywords are case-sensitive and need a code character on the line, so
  // prose that starts with "If" or "for example" doesn't count.
  const KEYWORD = /^\s*(function|const|let|var|def|class|import|from|export|return|if|for|while|try|catch|public|private|protected|static|void|package|using|async|await|elif|else|switch|case|fn|func)\b|^\s*(SELECT|INSERT|UPDATE|CREATE|DELETE|FROM|WHERE)\b|^\s*#include\b/;
  let hits = 0;
  lines.forEach((l) => {
    if (/[;{}]\s*$/.test(l) || /^\s*[})\]]+[;,]?\s*$/.test(l)) hits++;
    else if (KEYWORD.test(l) && /[(){}[\]=;]/.test(l)) hits++;
    else if ((/=>|->|::|\)\s*\{|:\s*$/.test(l)) && /[(){}[\]=]/.test(l)) hits++;
    else if (/^( {4,}|\t+)\S/.test(l)) hits++;
    else if (/^\s*(\/\/|#!|\/\*|\*\/|--\s)/.test(l)) hits++;
  });
  return hits / lines.length >= 0.5;
}
})();
