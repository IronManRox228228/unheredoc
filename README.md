# unheredoc

`unheredoc` is a Claude Code plugin that prevents wasteful token re-transmissions when Bash heredocs or PowerShell here-strings fail due to shell escaping or quoting errors.

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
     - Reports the relative script location and total line count.
     - Displays an excerpt of up to 15 numbered lines around the error (or the first 10 lines if unlocalized).
     - Provides the rerun command:
       - Bash: `bash "<path>"`
       - PowerShell: `pwsh -NoProfile -ExecutionPolicy Bypass -File "<path>"`
     - Reminds the agent to edit only the broken lines using file editing tools or `sed -i`.

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
