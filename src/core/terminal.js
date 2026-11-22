(function () {
// Terminal copies are plain text with the shell's furniture still in them:
// prompts, colour codes, carriage returns, trailing spaces. This recognises
// them and cleans them up so they paste as a tidy code block.
window.FB = window.FB || {};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;
const BASH_PROMPT = /^[\w.-]+@[\w.-]+(?::|\s)[^\n$#]*?[$#](?:\s+(?=\S)|\s*$)/;
const LS_LONG = /^[-dlbcps][rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s/;
const DOLLAR_PROMPT = /^\s*[$%]\s+(?=[A-Za-z.\/~_-])/;
const PS_PROMPT = /^PS [A-Za-z]:\\[^>\n]*>\s?/;
const PY_PROMPT = /^>>>\s/;

FB.stripAnsi = (t) => String(t).replace(ANSI, '');

FB.looksLikeTerminal = function looksLikeTerminal(text) {
  const raw = String(text || '');
  if (ANSI.test(raw)) { ANSI.lastIndex = 0; return true; }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  // user@host:path$ anywhere is a giveaway (a copy often starts mid-output
  // and ends on a fresh prompt); the looser "$ cmd" forms only count near
  // the top, where plain prose rarely puts them.
  if (lines.some((l) => BASH_PROMPT.test(l) || PS_PROMPT.test(l))) return true;
  if (lines.filter((l) => LS_LONG.test(l)).length >= 2) return true;
  return lines.slice(0, 4).some((l) => DOLLAR_PROMPT.test(l) || PY_PROMPT.test(l));
};

// -> { content, language }
FB.cleanTerminal = function cleanTerminal(text) {
  let language = 'bash';
  const lines = FB.stripAnsi(String(text || ''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  const out = lines.map((l) => {
    if (PS_PROMPT.test(l)) { language = 'powershell'; return 'PS> ' + l.replace(PS_PROMPT, ''); }
    if (PY_PROMPT.test(l)) { language = 'python'; return l; }
    if (BASH_PROMPT.test(l)) return ('$ ' + l.replace(BASH_PROMPT, '')).replace(/\s+$/, '');
    return l;
  });
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { content: out.join('\n'), language };
};
})();
