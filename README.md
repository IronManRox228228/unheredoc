# unheredoc

`unheredoc` is a Claude Code plugin that prevents wasteful token re-transmissions when Bash heredocs or PowerShell here-strings fail due to shell escaping or quoting errors.

## Fewer output tokens. Lower bill.

Output tokens are the most expensive tokens you pay for, and a failed heredoc makes the model write the whole command out a second time. `unheredoc` makes the retry a one-line `sed` instead.

**Benchmark: a 193-line heredoc with a syntax error, `claude-haiku-5-5`, headless Claude Code, 5 runs per arm.**

| | Without | With `unheredoc` | Change |
|---|---|---|---|
| Output tokens | 8,658 | **5,266** | **-39%** |
| Cost per run | $0.0110 | **$0.0087** | **-21%** |
| API time | 27.1 s | **24.0 s** | **-11%** |

- All 5 runs with the plugin fixed the script with a single `sed` and rerun. No resend, no `Read`.
- Every run in both arms ended with a working script.
- The saving grows with the size of the command. The resend costs more as the body gets longer. The fix stays about the same.

**Be aware:** on a short, 40-line heredoc the plugin saved nothing. The resend is already cheap, and the fix still takes two turns. It pays off on long scripts, config files and multi-file generation.

Small sample (5 runs per arm, one task, one model). Run your own: set `UNHEREDOC_DEBUG=1` and compare sessions with the plugin on and off.

## What it does

When an AI coding agent executes shell commands with multiline bodies (such as `cat <<EOF` or `@' ... '@`), shell quoting issues often cause the command to fail. Normally, the agent repeats the entire multiline payload on retry, consuming excessive output tokens.

`unheredoc` captures the command text before shell execution. When a failure occurs, the plugin presents the saved script path along with a targeted excerpt of the problematic lines. The agent reads the excerpt, edits only the broken lines in-place, and reruns the script file without re-sending the whole command.

The model retains full autonomy over fixing the issue; the plugin never alters tool calls or attempts automated fixes.

## How it works

1. **PreToolUse Hook (`pre`):**
   - Monitors `Bash` and `PowerShell` tool invocations.
   - Saves commands containing heredocs (`<<`), PowerShell here-strings (`@'` or `@"`), or commands longer than 300 characters to `.unheredoc/<sequence>.(sh|ps1)`.
   - Records the command mapping in `.unheredoc/index.json`.
   - Prunes old files, retaining the 20 most recent scripts.
   - Automatically maintains `.unheredoc/.gitignore` with `*` to avoid committing temporary scripts.

2. **PostToolUse (`post`) / PostToolUseFailure (`fail`) Hook:**
   - On success: Immediately deletes the temporary script and cleans up the index.
   - On failure: Leaves the file intact and responds with structured JSON:
     - Reports the absolute script location and total line count.
     - Displays an excerpt of up to 15 numbered lines around the error (or the first 10 lines if unlocalized). Line numbers from bash are corrected for the offset Claude Code's `eval` wrapper adds.
     - Provides the rerun command:
       - Bash: `bash "<path>"`
       - PowerShell: `pwsh -NoProfile -ExecutionPolicy Bypass -File "<path>"`
     - Tells the agent not to resend the command, but to fix the saved file with one `sed -i` (no `Read` needed) and rerun it.
   - Failures are detected from `PostToolUseFailure`, from a nonzero exit code, and from the shapes Claude Code uses for failed commands that still arrive as a plain `PostToolUse` (a trailing `exit=N` line, bash's `syntax error` message, or the unterminated `here-document` warning).

## Installation

Inside Claude Code:

```
/plugin marketplace add IronManRox228228/unheredoc
/plugin install unheredoc@unheredoc
```

To try a local checkout without installing:

```bash
claude --plugin-dir /path/to/unheredoc
```

## Debugging

Set `UNHEREDOC_DEBUG=1` in the environment Claude Code runs in. Every raw hook payload is then appended to `.unheredoc/debug.log`.

## Limitations

- **Subshell execution:** Rerunning a saved script runs it in a child subshell. Directory changes (`cd`), exported environment variables (`export`), and shell function definitions do not persist into the parent agent session.
- **Tool scope:** Interception applies exclusively to commands invoked through the `Bash` and `PowerShell` tools.
- **Platform requirements:** Requires Node.js >= 18. Supported across Windows (PowerShell 7 / Git Bash), macOS, and Linux.

## License

Apache License 2.0. See [LICENSE](LICENSE).
