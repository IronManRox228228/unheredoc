const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  shouldSave,
  detectFailure,
  findLikelyProblemLine,
  formatLine,
  getExcerpt,
  buildMessage
} = require('../hooks/unheredoc.js');

describe('unheredoc plugin tests', () => {
  describe('shouldSave', () => {
    it('detects heredoc variants', () => {
      assert.strictEqual(shouldSave('cat <<EOF\nhello\nEOF'), true);
      assert.strictEqual(shouldSave('cat <<-EOF\nhello\nEOF'), true);
      assert.strictEqual(shouldSave('cat <<\'EOF\'\nhello\nEOF'), true);
      assert.strictEqual(shouldSave('cat <<-"EOF"\nhello\nEOF'), true);
      assert.strictEqual(shouldSave('cat << \'HEREDOC\'\nhello\nHEREDOC'), true);
      assert.strictEqual(shouldSave('cat <<- \'END\'\nhello\nEND'), true);
      assert.strictEqual(shouldSave('cat << "FOO"\nhello\nFOO'), true);
      assert.strictEqual(shouldSave('cat <<EOF-TAG\nhello\nEOF-TAG'), true);
    });

    it('detects PowerShell here-strings', () => {
      assert.strictEqual(shouldSave('$str = @\'\nhello\n\'@'), true);
      assert.strictEqual(shouldSave('$str = @"\nhello\n"@'), true);
      assert.strictEqual(shouldSave('Set-Content -Value @\'\r\nhello\r\n\'@'), true);
      assert.strictEqual(shouldSave('$query = @"   \nSELECT * FROM tbl\n"@'), true);
    });

    it('detects long commands (> 300 chars)', () => {
      const longCmd = 'echo "' + 'x'.repeat(295) + '"';
      assert.ok(longCmd.length > 300);
      assert.strictEqual(shouldSave(longCmd), true);

      const exact300 = 'x'.repeat(300);
      assert.strictEqual(shouldSave(exact300), false);
    });

    it('ignores short plain commands', () => {
      assert.strictEqual(shouldSave('ls -la'), false);
      assert.strictEqual(shouldSave('git status'), false);
      assert.strictEqual(shouldSave('echo "hello world"'), false);
      assert.strictEqual(shouldSave('node -e "console.log(1)"'), false);
      assert.strictEqual(shouldSave('echo $((1 << 2))'), false);
      assert.strictEqual(shouldSave(''), false);
      assert.strictEqual(shouldSave(null), false);
      assert.strictEqual(shouldSave(undefined), false);
    });
  });

  describe('detectFailure', () => {
    it('treats fail event, error, or interrupted as failure', () => {
      assert.strictEqual(detectFailure('fail', {}), true);
      assert.strictEqual(detectFailure('post', { hook_event_name: 'PostToolUseFailure' }), true);
      assert.strictEqual(detectFailure('post', { error: 'Execution failed' }), true);
      assert.strictEqual(detectFailure('post', { error: new Error('Crash') }), true);
      assert.strictEqual(detectFailure('post', { is_error: true }), true);
      assert.strictEqual(detectFailure('post', { interrupted: true }), true);
    });

    it('detects failure from non-zero exit codes', () => {
      assert.strictEqual(detectFailure('post', { tool_response: { exitCode: 1 } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { exit_code: 127 } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { returnCode: 2 } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { status: 1 } }), true);
    });

    it('detects failure from tool_response error flags', () => {
      assert.strictEqual(detectFailure('post', { tool_response: { is_error: true } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { isError: true } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { interrupted: true } }), true);
    });

    it('detects shell parse errors in stderr or string output', () => {
      assert.strictEqual(
        detectFailure('post', { tool_response: { exitCode: 0, stderr: 'bash: line 5: syntax error near unexpected token' } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: { stderr: 'bash: syntax error: unexpected EOF' } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: { stderr: 'warning: here-document at line 1 delimited by end-of-file' } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: { stderr: 'ParserError: Missing closing delimiter' } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: { stderr: "The string is missing the terminator: '@." } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: { stderr: 'Missing closing quote' } }),
        true
      );
      assert.strictEqual(
        detectFailure('post', { tool_response: 'Syntax error encountered during parsing' }),
        true
      );
    });

    it('recognizes success', () => {
      assert.strictEqual(detectFailure('post', { tool_response: { exitCode: 0, stdout: 'ok' } }), false);
      // e.g. `grep "syntax error" app.log` succeeding must not be reported as a failure
      assert.strictEqual(detectFailure('post', { tool_response: { stdout: 'app.log: syntax error at 12:30' } }), false);
    });

    it('detects a failure delivered as plain PostToolUse with trailing exit=N (real payload)', () => {
      const failed = { stdout: 'total ports sum: 42021\nbash: line 50: syntax error: unexpected end of file\nexit=2', stderr: '', interrupted: false };
      assert.strictEqual(detectFailure('post', { tool_response: failed }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { stdout: 'x\nexit=127', stderr: '' } }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { stdout: 'BUILD REPORT DONE\nexit=0', stderr: '' } }), false);
      assert.strictEqual(detectFailure('post', { tool_response: { stdout: 'exit=1 was the old behaviour\nok', stderr: '' } }), false);
    });

    it('detects unterminated heredoc warning in merged stdout (real Claude Code Bash shape)', () => {
      const res = {
        stdout: "/usr/bin/bash: line 5: warning: here-document at line 3 delimited by end-of-file (wanted `EOF')\ncall three body\nEO",
        stderr: '', interrupted: false, isImage: false, noOutputExpected: false
      };
      assert.strictEqual(detectFailure('post', { tool_response: res }), true);
      assert.strictEqual(detectFailure('post', { tool_response: { exit_code: 0, stderr: '' } }), false);
      assert.strictEqual(detectFailure('post', { tool_response: 'Normal stdout message' }), false);
      assert.strictEqual(detectFailure('post', {}), false);
    });
  });

  describe('buildMessage', () => {
    it('formats line numbers as "  12| text"', () => {
      assert.strictEqual(formatLine(12, 'hello'), '  12| hello');
      assert.strictEqual(formatLine(1, 'first'), '   1| first');
      assert.strictEqual(formatLine(100, 'century'), ' 100| century');
      assert.strictEqual(formatLine(5, ''), '   5|');
    });

    it('centers excerpt around parsed line number from error', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line content ${i + 1}`);
      const content = lines.join('\n');
      // Real line 20 of a 30-line command, as bash reports it under Claude Code's eval (+29).
      const err = 'bash: eval: line 49: syntax error near unexpected token';
      const msg = buildMessage('.unheredoc/0001.sh', content, err, false);

      assert.match(msg, /unheredoc: command saved to \.unheredoc\/0001\.sh \(30 lines\)\./);
      assert.match(msg, /  20\| line content 20/);
      assert.match(msg, /Do not resend the command\. Fix the broken lines .* sed -i/);
      assert.match(msg, /Rerun command: bash "\.unheredoc\/0001\.sh"/);
      assert.match(msg, /Note: runs in a subshell; cd\/export\/functions won't persist\./);
    });

    it('corrects eval line offset using the heredoc start line (real payload from a 9-line command)', () => {
      const lines = Array.from({ length: 9 }, (_, i) => `l${i + 1}`);
      const err = "/usr/bin/bash: line 17: warning: here-document at line 9 delimited by end-of-file (wanted `EOF')";
      assert.strictEqual(findLikelyProblemLine(lines, err, 8), 1);
      // 40-line command, heredoc really at line 25: bash reports 25 + 39 = 64.
      const long = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
      assert.strictEqual(findLikelyProblemLine(long, 'warning: here-document at line 64 delimited by end-of-file', 39), 25);
    });

    it('falls back to heredoc line or first 10 lines if no error line', () => {
      const lines = Array.from({ length: 25 }, (_, i) => `echo ${i + 1}`);
      const content = lines.join('\n');
      const msg = buildMessage('.unheredoc/0002.sh', content, '', false);

      assert.match(msg, /   1\| echo 1/);
      assert.match(msg, /  10\| echo 10/);
      assert.doesNotMatch(msg, /  11\| echo 11/);
    });

    it('produces correct rerun command for Bash vs PowerShell', () => {
      const bashMsg = buildMessage('.unheredoc/0001.sh', 'cat <<EOF\nEOF', '', false);
      assert.match(bashMsg, /Rerun command: bash "\.unheredoc\/0001\.sh"/);

      const psMsg = buildMessage('.unheredoc/0001.ps1', '$a = @\'\n\'@', '', true);
      assert.match(psMsg, /Rerun command: pwsh -NoProfile -ExecutionPolicy Bypass -File "\.unheredoc\/0001\.ps1"/);
    });
  });

  describe('configuration validation', () => {
    it('validates hooks/hooks.json is valid JSON with expected structure', () => {
      const hooksPath = path.resolve(__dirname, '../hooks/hooks.json');
      const content = fs.readFileSync(hooksPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(parsed.hooks);
      assert.ok(parsed.hooks.PreToolUse);
      assert.ok(parsed.hooks.PostToolUse);
      assert.ok(parsed.hooks.PostToolUseFailure);
    });

    it('validates .claude-plugin/plugin.json is valid JSON with required fields', () => {
      const pluginPath = path.resolve(__dirname, '../.claude-plugin/plugin.json');
      const content = fs.readFileSync(pluginPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.name, 'unheredoc');
      assert.strictEqual(parsed.version, '0.1.0');
      assert.ok(parsed.description);
      assert.ok(parsed.author);
    });
  });

  describe('end-to-end hook execution', () => {
    let tmpDir;
    const scriptPath = path.resolve(__dirname, '../hooks/unheredoc.js');

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unheredoc-test-'));
    });

    after(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('saves on pre and reports on fail, preserving the script file', () => {
      const toolUseId = 'tool_test_fail_1';
      const command = 'cat <<EOF\necho "broken heredoc"\nEOF';
      const prePayload = JSON.stringify({
        session_id: 'sess_1',
        cwd: tmpDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: toolUseId
      });

      const preRes = spawnSync(process.execPath, [scriptPath, 'pre'], {
        input: prePayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(preRes.status, 0);
      assert.strictEqual(preRes.stdout, '');

      const unheredocDir = path.join(tmpDir, '.unheredoc');
      assert.ok(fs.existsSync(unheredocDir));
      assert.ok(fs.existsSync(path.join(unheredocDir, '.gitignore')));
      assert.strictEqual(fs.readFileSync(path.join(unheredocDir, '.gitignore'), 'utf8').trim(), '*');

      const savedFile = path.join(unheredocDir, '0001.sh');
      assert.ok(fs.existsSync(savedFile));
      assert.strictEqual(fs.readFileSync(savedFile, 'utf8'), command);

      // Now trigger fail
      const failPayload = JSON.stringify({
        session_id: 'sess_1',
        cwd: tmpDir,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: toolUseId,
        error: 'bash: line 2: syntax error near unexpected token'
      });

      const failRes = spawnSync(process.execPath, [scriptPath, 'fail'], {
        input: failPayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(failRes.status, 0);
      assert.ok(failRes.stdout.length > 0);

      const parsed = JSON.parse(failRes.stdout);
      assert.ok(parsed.hookSpecificOutput);
      assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
      // Absolute, forward-slash path so the rerun survives a `cd` in the agent's shell.
      const shown = savedFile.split(path.sep).join('/');
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes(`unheredoc: command saved to ${shown}`));
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes(`Rerun command: bash "${shown}"`));

      // Verify the file was NOT deleted on failure
      assert.ok(fs.existsSync(savedFile));
    });

    it('saves on pre and cleans up on post success', () => {
      const toolUseId = 'tool_test_success_2';
      const command = 'cat <<EOF\necho "working heredoc"\nEOF';
      const prePayload = JSON.stringify({
        session_id: 'sess_2',
        cwd: tmpDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: toolUseId
      });

      const preRes = spawnSync(process.execPath, [scriptPath, 'pre'], {
        input: prePayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(preRes.status, 0);
      const savedFile = path.join(tmpDir, '.unheredoc', '0002.sh');
      assert.ok(fs.existsSync(savedFile));

      // Trigger post success
      const postPayload = JSON.stringify({
        session_id: 'sess_2',
        cwd: tmpDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: toolUseId,
        tool_response: { exitCode: 0, stdout: 'working heredoc\n' }
      });

      const postRes = spawnSync(process.execPath, [scriptPath, 'post'], {
        input: postPayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(postRes.status, 0);
      assert.strictEqual(postRes.stdout, '');

      // Verify the saved file was deleted
      assert.ok(!fs.existsSync(savedFile));
    });

    it('handles PowerShell tool calls creating .ps1 files', () => {
      const toolUseId = 'tool_test_ps_3';
      const command = '$data = @\'\nline 1\nline 2\n\'@\nWrite-Output $data';
      const prePayload = JSON.stringify({
        session_id: 'sess_3',
        cwd: tmpDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'PowerShell',
        tool_input: { command },
        tool_use_id: toolUseId
      });

      const preRes = spawnSync(process.execPath, [scriptPath, 'pre'], {
        input: prePayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(preRes.status, 0);

      const index = JSON.parse(fs.readFileSync(path.join(tmpDir, '.unheredoc', 'index.json'), 'utf8'));
      const psFilename = index[toolUseId];
      assert.ok(psFilename && psFilename.endsWith('.ps1'));

      const savedFile = path.join(tmpDir, '.unheredoc', psFilename);
      assert.ok(fs.existsSync(savedFile));

      // Trigger fail
      const failPayload = JSON.stringify({
        session_id: 'sess_3',
        cwd: tmpDir,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'PowerShell',
        tool_use_id: toolUseId,
        error: "The string is missing the terminator: '@."
      });

      const failRes = spawnSync(process.execPath, [scriptPath, 'fail'], {
        input: failPayload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });

      assert.strictEqual(failRes.status, 0);
      const parsed = JSON.parse(failRes.stdout);
      const psShown = path.join(tmpDir, '.unheredoc', psFilename).split(path.sep).join('/');
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes(`Rerun command: pwsh -NoProfile -ExecutionPolicy Bypass -File "${psShown}"`));
    });

    it('tolerates invalid or missing input without crashing', () => {
      const res = spawnSync(process.execPath, [scriptPath, 'pre'], {
        input: 'not json',
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
      });
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout, '');
    });
  });
});
