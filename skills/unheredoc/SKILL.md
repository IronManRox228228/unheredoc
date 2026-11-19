---
name: unheredoc
description: Use when a Bash or PowerShell command with a heredoc or here-string fails, or when a hook message says "unheredoc: command saved".
---

# Fixing Failed Heredocs and Long Shell Commands

When a command fails and unheredoc saves it to disk (`.unheredoc/<file>`):

1. **Do not resend the full command.** Resending large commands or heredocs wastes output tokens and risks repeating escaping errors.
2. **Inspect and edit only broken lines:**
   - Use the `Read` tool to inspect the saved script around the reported line, or rely on the excerpt provided in the hook message.
   - Use the `Edit` tool (or a targeted `sed -i` for single-line changes) to fix only the broken lines.
3. **Rerun the saved file:**
   - Bash: `bash ".unheredoc/<file>.sh"`
   - PowerShell: `pwsh -NoProfile -ExecutionPolicy Bypass -File ".unheredoc/<file>.ps1"`
   - *Note:* The script runs in a subshell; changes like `cd`, `export`, or environment functions will not persist in the main session.

## Best Practices to Prevent Errors

- **Writing files:** Always prefer the dedicated `Write` tool over shell heredocs (`cat <<EOF > file`).
- **Commit messages:** Prefer writing messages to a temporary file and running `git commit -F <file>` instead of multiline strings in the CLI.
- **Quote heredoc delimiters:** Default to quoted delimiters (`<<'EOF'`) in Bash to prevent unintended variable expansion and escaping issues.
- **PowerShell here-strings:** The closing delimiter (`'@` or `"@`) must start at column 0 on its own line with no leading whitespace.
- **Syntax differences:** Bash heredoc syntax (`<<EOF`) does not work in PowerShell; PowerShell uses here-strings (`@' ... '@`).
