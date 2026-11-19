#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const PARSE_ERRORS = /syntax error|unexpected EOF|here-document|ParserError|The string is missing the terminator|Missing closing/i;
const HEREDOC_EOF_WARNING = /warning: here-document at line \d+ delimited by end-of-file/;
const TRAILING_NONZERO_EXIT = /(?:^|\n)exit=[1-9]\d*\s*$/;
const BASH_SYNTAX_ERROR = /(?:^|\n)\S*bash: (?:eval: )?line \d+: syntax error/;
const HEREDOC_REGEX = /<<\s*-?\s*['"]?[a-zA-Z_][\w-]*['"]?/;
const HERESTRING_REGEX = /@['"]\s*$/m;

function shouldSave(cmd) {
  return typeof cmd === 'string' && (cmd.length > 300 || HEREDOC_REGEX.test(cmd) || HERESTRING_REGEX.test(cmd));
}

function detectFailure(event, data = {}) {
  if (event === 'fail' || data.hook_event_name === 'PostToolUseFailure' || data.error || data.is_error || data.interrupted) return true;
  const res = data.tool_response;
  if (res === undefined || res === null) return false;
  if (typeof res === 'object') {
    const code = res.exitCode ?? res.exit_code ?? res.returnCode ?? res.status;
    if (code !== undefined && code !== null && Number(code) !== 0 && !isNaN(Number(code))) return true;
    if (res.is_error || res.isError || res.interrupted) return true;
    // Only scan error streams: stdout of a successful command may legitimately contain these phrases.
    const text = [res.stderr, res.error].filter(s => typeof s === 'string').join('\n');
    if (PARSE_ERRORS.test(text)) return true;
    // Claude Code's Bash tool merges stderr into stdout, and an unterminated heredoc only warns (exit 0).
    // Match bash's exact warning so ordinary output mentioning "syntax error" is not a false positive.
    // Seen live: a failed command can arrive as a plain PostToolUse (no error flag) whose stdout ends
    // with a trailing "exit=N" line and bash's own "bash: line N: syntax error" message.
    const out = typeof res.stdout === 'string' ? res.stdout : '';
    return HEREDOC_EOF_WARNING.test(out) || TRAILING_NONZERO_EXIT.test(out) || BASH_SYNTAX_ERROR.test(out);
  }
  return typeof res === 'string' && PARSE_ERRORS.test(res);
}

// lineOffset: Claude Code runs Bash commands via `eval`, and bash numbers lines inside eval
// starting after the outer parse has already counted every newline of the command.
// So a reported line is too high by (command lines - 1); callers pass that for .sh files.
function findLikelyProblemLine(lines, err = '', lineOffset = 0) {
  const s = typeof err === 'string' ? err : '';
  // Prefer the heredoc's start line; bash's "line N" in that warning is just end of input.
  const m = s.match(/here-document at line (\d+)/i) || s.match(/(?:at\s+line:?|line\s+|:)(\d+)(?::|\s|,|\b)/i);
  if (m) {
    const num = parseInt(m[1], 10) - lineOffset;
    if (num >= 1 && num <= lines.length) return num;
  }
  for (let i = 0; i < lines.length; i++) {
    if (/<<\s*-?\s*['"]?[a-zA-Z_]/.test(lines[i]) || /@['"]|['"]@/.test(lines[i])) return i + 1;
  }
  return null;
}

function formatLine(n, text) {
  const pad = String(n).padStart(4, ' ');
  return text ? `${pad}| ${text}` : `${pad}|`;
}

function getExcerpt(lines, targetLine) {
  if (!lines || !lines.length) return '';
  let start = 1, end = Math.min(lines.length, 10);
  if (targetLine && targetLine >= 1) {
    const max = 15;
    if (lines.length <= max) {
      start = 1;
      end = lines.length;
    } else {
      start = Math.max(1, targetLine - 7);
      end = Math.min(lines.length, start + max - 1);
      if (end - start + 1 < max) start = Math.max(1, end - max + 1);
    }
  }
  const res = [];
  for (let i = start; i <= end; i++) res.push(formatLine(i, lines[i - 1]));
  return res.join('\n');
}

function buildMessage(relPath, content = '', errorText = '', isPowerShell = false) {
  if (typeof relPath === 'object' && relPath !== null) {
    ({ relPath, content = '', errorText = '', isPowerShell = false } = relPath);
  }
  const isPs = Boolean(isPowerShell || /\.ps1$/i.test(relPath));
  const lines = typeof content === 'string' && content.length > 0 ? content.split(/\r?\n/) : [];
  const lineOffset = isPs ? 0 : Math.max(0, lines.length - 1);
  const excerpt = getExcerpt(lines, findLikelyProblemLine(lines, errorText, lineOffset));
  const rerunCmd = isPs ? `pwsh -NoProfile -ExecutionPolicy Bypass -File "${relPath}"` : `bash "${relPath}"`;

  return [
    `unheredoc: command saved to ${relPath} (${lines.length} lines).`,
    excerpt,
    'Do not resend the command. Fix the broken lines in the saved file with one Bash sed -i (use the line numbers above; no Read needed), then rerun it.',
    `Rerun command: ${rerunCmd}`,
    "Note: runs in a subshell; cd/export/functions won't persist."
  ].filter(Boolean).join('\n');
}

function getProjectDir(data = {}) {
  return process.env.CLAUDE_PROJECT_DIR || data?.cwd || process.cwd();
}

function getUnheredocDir(data = {}) {
  return path.join(getProjectDir(data), '.unheredoc');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n', 'utf8');
}

function readIndex(dir) {
  try {
    const p = path.join(dir, 'index.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

function writeIndex(dir, index) {
  const p = path.join(dir, 'index.json');
  const tmp = path.join(dir, `.index.json.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    try {
      fs.writeFileSync(p, JSON.stringify(index, null, 2), 'utf8');
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

function pruneOldFiles(dir, max = 20) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter(n => /^\d+.*?\.(sh|ps1)$/.test(n))
      .map(n => ({ n, p: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length > max) {
      const removed = new Set();
      for (const item of files.slice(max)) {
        try { fs.unlinkSync(item.p); removed.add(item.n); } catch {}
      }
      const index = readIndex(dir);
      let changed = false;
      for (const [id, f] of Object.entries(index)) {
        const fn = typeof f === 'string' ? f : f?.filename;
        if (removed.has(fn) || !fs.existsSync(path.join(dir, fn))) {
          delete index[id]; changed = true;
        }
      }
      if (changed) writeIndex(dir, index);
    }
  } catch {}
}

function getErrorText(data) {
  if (!data) return '';
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return data.error.message;
  const res = data.tool_response;
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') return res.stderr || res.error || res.output || res.text || '';
  return '';
}

function main(cliEvent) {
  try {
    let raw = '';
    if (!process.stdin.isTTY) {
      try { raw = fs.readFileSync(0, 'utf8'); } catch {}
    }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Opt-in: set UNHEREDOC_DEBUG=1 to append every raw hook payload to .unheredoc/debug.log.
    if (process.env.UNHEREDOC_DEBUG) {
      try {
        const dir = getUnheredocDir(data);
        ensureDir(dir);
        fs.appendFileSync(path.join(dir, 'debug.log'), `[${cliEvent}] ${raw.trim()}\n`, 'utf8');
      } catch {}
    }

    const evName = data.hook_event_name || '';
    const event = cliEvent || (
      evName === 'PreToolUse' ? 'pre' :
      evName === 'PostToolUseFailure' ? 'fail' :
      evName === 'PostToolUse' ? 'post' : ''
    );

    if (event === 'pre') {
      const cmd = data?.tool_input?.command;
      const id = data?.tool_use_id;
      if (!cmd || !id || !shouldSave(cmd)) return;

      const dir = getUnheredocDir(data);
      ensureDir(dir);
      const isPs = /powershell/i.test(data?.tool_name || '');
      const ext = isPs ? '.ps1' : '.sh';

      let maxSeq = 0;
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d+)/);
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
      }
      const seq = String(maxSeq + 1).padStart(4, '0');
      let filename = `${seq}${ext}`;
      if (fs.existsSync(path.join(dir, filename))) {
        filename = `${seq}_${Math.random().toString(36).slice(2, 6)}${ext}`;
      }

      const fullPath = path.join(dir, filename);
      const tmpPath = path.join(dir, `.${filename}.tmp.${process.pid}.${Date.now()}`);
      const content = isPs ? cmd : cmd.replace(/\r\n/g, '\n');
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, fullPath);

      const index = readIndex(dir);
      index[id] = filename;
      writeIndex(dir, index);
      pruneOldFiles(dir, 20);
      return;
    }

    if (event === 'post' || event === 'fail') {
      const id = data?.tool_use_id;
      if (!id) return;
      const dir = getUnheredocDir(data);
      const index = readIndex(dir);
      const entry = index[id];
      if (!entry) return;
      const filename = typeof entry === 'string' ? entry : entry?.filename;
      if (!filename) return;

      const fullPath = path.join(dir, filename);
      if (!detectFailure(event, data)) {
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch {}
        delete index[id];
        writeIndex(dir, index);
        return;
      }

      let content = '';
      try { if (fs.existsSync(fullPath)) content = fs.readFileSync(fullPath, 'utf8'); } catch {}
      const isPs = /\.ps1$/i.test(filename) || /powershell/i.test(data?.tool_name || '');
      // Absolute path with forward slashes: survives `cd` in the agent's shell and works in Git Bash and pwsh.
      const shownPath = fullPath.split(path.sep).join('/');
      const message = buildMessage(shownPath, content, getErrorText(data), isPs);
      const hookEventName = evName || (event === 'fail' ? 'PostToolUseFailure' : 'PostToolUse');
      // Synchronous write: process.exit() follows, and async pipe writes can be dropped (e.g. macOS).
      fs.writeSync(1, JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: message }
      }) + '\n');
    }
  } catch {}
}

if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  main(process.argv[2]);
  process.exit(0);
}

module.exports = {
  shouldSave,
  detectFailure,
  findLikelyProblemLine,
  formatLine,
  getExcerpt,
  buildMessage,
  getProjectDir,
  getUnheredocDir,
  ensureDir,
  readIndex,
  writeIndex,
  pruneOldFiles,
  getErrorText,
  main,
  PARSE_ERRORS,
  HEREDOC_REGEX,
  HERESTRING_REGEX
};
