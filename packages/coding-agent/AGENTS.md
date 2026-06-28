# Agent rules (any project)

Default rules shipped with free-code and seeded into `~/.free-code/agent/AGENTS.md`. They apply in every session unless a project `AGENTS.md` overrides them.

## **CRITICAL** Code Search and Research — Use the Code Graph **CRITICAL**

Whenever you investigate, explore, or search code in a repository, you **MUST** use the code graph tools **before** falling back to grep/read/bash.

### Mandatory workflow for any code research task

1. **Run `code_index` first** (or `code_index({ force: true })` after large refactors) to build/update the graph.
2. **Use `code_symbols`** to locate functions, classes, methods, types by name.
3. **Use `code_context`** to get the full source of a symbol plus its direct callees — never use `read` + manual scanning for this.
4. **Use `code_callers`** to find every place that calls a function — never use `grep` for call-site discovery.
5. Only use `grep` / `read` / `bash` for things the code graph cannot answer (e.g. regex over string literals, config files, non-TS files).

### Trigger conditions — these ALWAYS require the code graph first

- "How does X work?" / "Where is X defined?" → `code_symbols` + `code_context`
- "Who calls X?" / "Where is X used?" → `code_callers`
- Tracing a data flow or execution path → `code_context` chain (follow callees recursively)
- Investigating a bug or understanding a feature → `code_index` → `code_symbols` → `code_context` / `code_callers`
- Before editing any non-trivial function → `code_context` to read it with full call context

### What NOT to do

- ❌ Jump straight to `grep` to find where a function is called
- ❌ Use `read` with offsets to manually scan for a symbol definition
- ❌ Use `bash find` to locate files when `code_symbols` can find the symbol directly
- ❌ Skip `code_index` because "it was indexed before" — re-index when files changed

## First Message

If the user did not give you a concrete task in their first message, ask something like "What do you want to work on today?"

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

---

## **CRITICAL** Step-by-step Execution — No Skipping **CRITICAL**

When a command, skill, or prompt gives you an explicit ordered procedure (numbered or labeled steps), you MUST:

- Execute **every** step, **in order**. Skipping, reordering, or merging steps is forbidden.
- Never assume the result of a step you did not run. If a step says to snapshot, inspect, read, or verify before continuing, perform it and read its output before moving on — do not infer success or guess the outcome.
- Treat verification/inspection steps (snapshots, reads, status checks) as **mandatory gates**, not optional. A step that tells you to check for a dialog/element/state must be performed even if you expect it to be absent.
- If a step cannot be completed, **stop and report** what you observed. Never silently jump ahead to a later step or shortcut to the end result.

This applies in every environment (free-code CLI, VS Code/Cursor plugin, FreeCodeMac) and to all workflows with explicit steps (skills, slash commands, MCP tools).

---

## **CRITICAL** Tool Usage Rules **CRITICAL**

- NEVER use sed/cat to read a file or a range of a file. Always use the read tool (use offset + limit for ranged reads).
- You MUST read every file you modify in full before editing.

### Mandatory edit workflow (avoid generic errors like `An unknown error occurred`)

Follow **all three** steps on every file edit (search-replace, apply_patch, or similar):

1. **Small, single-purpose patches** — One logical change per tool call. Do not merge distant hunks in one patch. Set `old_string` / the removal region from the **latest** file read, **byte-for-byte** (spaces, blank lines, and line endings must match). If the patch is large, split into several calls.

2. **JSON-safe tool payloads** — Tool arguments are serialized as JSON. Follow the subsection **JSON-safe tool arguments** below: no raw control characters inside JSON strings; use `\n` / `\t` escapes or the environment's native patch mechanism instead of hand-building huge escaped strings.

3. **Verify, then retry or change approach** — If the tool errors or the outcome is unclear, **re-read the file** before doing anything else. If the edit did not land: refresh context from that read, retry with a **smaller** uniquely identifying `old_string` (never paste the same failing payload again). If it still fails, switch methods (e.g. a short script + shell, a minimal patch file, or ask the user to apply a diff). This is mandatory; do not assume success without confirmation.

### JSON-safe tool arguments (edits, patches, replacements)

Tool and agent runtimes serialize tool arguments as **JSON**. In JSON, **string values cannot contain raw control characters** (U+0000–U+001F): unescaped newlines, tabs, and other ASCII controls inside a quoted string make `JSON.parse` fail with errors like `Bad control character in string literal in JSON`.

- **Escape** what belongs inside a string: `\n` for newlines, `\t` for tab, `\r` for carriage return, `\\` for backslash, `\"` for double quote.
- **Do not** paste or emit **literal line breaks** inside a JSON string value; use `\n` sequences instead.
- For **large or multiline** edits, prefer the supported apply/patch path for this environment (so the runtime handles escaping) instead of stuffing unescaped source into a single JSON string by hand.
- If a tool accepts **path-based** or **chunked** input, use that to avoid one giant escaped string.

### Edit tool failures and retries

Some agent runtimes return a generic error (for example `An unknown error occurred`) when an edit payload is invalid, too large, or the patch did not match the file exactly.

- **Always** treat a failed or ambiguous edit result as unapplied until you **re-read the file** and confirm the expected text is present.
- **Retry** with a **smaller, uniquely matching** `old_string` (one hunk at a time), or split the change across multiple patch calls. Do not repeat the same failing payload verbatim.
- **Mismatch** is a common cause: trailing whitespace, different line endings, or stale `old_string` from an earlier read. Re-read before the second attempt.
- Do not spin in an infinite retry loop; after one or two structured retries, pivot to another method or ask the user.

## **CRITICAL** agent_browser / agent-browser Rules **CRITICAL**

When using `agent_browser` (or `agent-browser` via bash), the `fill` and `type` commands take the text to input as a **plain positional argument**, not a flag:

```bash
# CORRECT
agent-browser fill @e2 "hello world"
agent-browser type @e2 " world"

# WRONG — never do this
agent-browser fill @e2 --keys "hello world"
agent-browser fill @e2 --keys hello --keys Enter
```

- **Never** pass `--keys`, `--submit`, `--enter`, or similar invented flags as part of the text argument in `fill`, `type`, or any input command.
- **Never** append `--keys Enter` to submit a form. Use `agent-browser press Enter` or `agent-browser click @ref` as a separate call instead.
- The text to input is always the **last positional argument** after the selector. It is opaque content — pass it exactly as the user wrote it, with no extra flags or decorations.

### Closing the browser

When the user says "close browser" (or similar), **always** kill the process by PID — never use `agent_browser close` or any MCP/tool-level close action:

```bash
kill $(ps aux | grep "remote-debugging-port=<port>" | grep -v grep | awk '{print $2}')
```

Replace `<port>` with the port used when `agent_browser` was started. Track it from launch. This applies in every context (CLI, plugin, MCP).

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- NEVER commit unless the user asks

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add path/to/file-you-changed.ts

# 3. Commit
git commit -m "fix(scope): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.

---

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it

## Figma MCP

When downloading images from Figma using `download_figma_images`:

1. Run `pwd` via bash to get the absolute current working directory.
2. Parse `fileKey` and `nodeId` from the Figma URL:
   - `fileKey`: segment after `/design/` in the URL
   - `nodeId`: value of the `node-id` query param, replacing `-` with `:` (e.g. `5148-5071` → `5148:5071`)
3. Call `download_figma_images` with `localPath` set to the absolute path from step 1. **Never** use a relative path like `.` — it will save to the MCP server's base directory (`~/.free-code/agent`) instead of the project.
4. Verify the file exists with `ls -lh <path>/<filename>` after the download.
