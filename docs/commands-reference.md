# free-code command reference

Quick reference for the **free-code** CLI (terminal agent built on [pi](../README.md)). Full details are in the linked sections.

## Basic invocation

```bash
free-code [options] [@files...] [messages...]
```

| Usage | Command |
|-------|---------|
| Start interactive | `free-code` |
| Initial message | `free-code "your question"` |
| Help / version | `free-code -h` · `free-code -v` |

Configuration directory: defaults to `~/.free-code/agent` (env var `FREE_CODE_CODING_AGENT_DIR`; legacy `PI_CODING_AGENT_DIR`). Much older documentation references `~/.pi/agent/`; effective behavior depends on your environment. See [settings.md](settings.md).

---

## Editor commands (`/`)

Type `/` in the editor to open the command menu. Extensions can add more; skills appear as `/skill:name` and prompt templates as `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch model |
| `/scoped-models` | Enable or disable models for the Ctrl+P cycle |
| `/settings` | Reasoning level, theme, message delivery, transport |
| `/resume` | Pick a previous session |
| `/new` | New session |
| `/name <name>` | Visible name for the session |
| `/session` | Session info (path, tokens, cost) |
| `/tree` | Jump to a point in history and continue from there |
| `/fork` | New session branching from the current one |
| `/compact [instructions]` | Compact context (optional: instructions) |
| `/copy` | Copy the last assistant reply to clipboard |
| `/export [file]` | Export session: **`.md`** → Markdown (thinking, tools, compaction, model changes, … in the current thread); **`.jsonl`** → JSONL copy of the thread; **other / no extension** → interactive HTML |
| `/share` | Upload as a private GitHub gist with an HTML link |
| `/reload` | Reload shortcuts, extensions, skills, prompts, and context |
| `/hotkeys` | List all keyboard shortcuts |
| `/changelog` | Version history |
| `/rag addFile <path>` | (RAG) Add a document to the knowledge base (requires RAG extension/skill) |
| `/rag addGroup <folder>` | (RAG) Add all supported files from a folder |
| `/rag addGithubUrl <url> [subpath]` | (RAG) Clone a GitHub repo and index its files |
| `/rag addDrive <google_drive_url>` | (RAG) Download a Google Drive document and index it (uses agent_browser) |
| `/rag search <query>` | (RAG) Query the knowledge base and use the result as context |
| `/rag list` | (RAG) List files indexed in the knowledge base |
| `/rag remove <file>` | (RAG) Remove a file from the knowledge base |
| `/rag-kb create <name>` | (RAG) Create a knowledge base |
| `/rag-kb delete <name>` | (RAG) Delete a knowledge base |
| `/rag-kb use <name>` | (RAG) Select the active knowledge base for the session |
| `/rag-kb list` | (RAG) List available knowledge bases |
| `/browse [url] [goal]` | Open a URL in the visible browser via `agent_browser` (same as the globe button in the plugin); defaults to Google if no URL given |
| `/gemini ask <message>` · `/gemini download <file>` · `/gemini open [chat_id]` | Gemini flows with skills / CDP (requires synced extension and browser tool) |
| `/codeGraph-index [--force]` | Index the project for the code graph (see [code-graph.md](code-graph.md)) |
| `/codeGraph-symbols <query> [--kind type] [--limit n]` | Search symbols by name in the index |
| `/codeGraph-callers <name> [--limit n]` | Find who calls a function or method |
| `/codeGraph-context <name> [--file partial-path]` | Source code and callees of a symbol |
| `/quit` | Quit |

More context: [session.md](session.md), [tree.md](tree.md), [compaction.md](compaction.md), [code-graph.md](code-graph.md).

---

## Keyboard shortcuts (summary)

Customization: `keybindings.json` (see [keybindings.md](keybindings.md)). After editing, run `/reload`.

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel / abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward / backward |
| Shift+Tab | Cycle reasoning level ("thinking") |
| Ctrl+O | Collapse / expand tool output |
| Ctrl+T | Collapse / expand thinking blocks |

In the editor: `@` for files, `!command` / `!!command` for bash (see README and [keybindings.md](keybindings.md)).

---

## Subagents

| Command | Description |
|---------|-------------|
| `sub` | Start a subagent with a task: `/sub <task>` |
| `subcont` | Continue a conversation with a subagent: `/subcont <number> <prompt>` |
| `subrm` | Remove a specific subagent: `/subrm <number>` |
| `subclear` | Clear all subagent widgets |

---

## Sessions (CLI)

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and pick a session |
| `--session <path\|id>` | Specific session (file or partial UUID) |
| `--fork <path\|id>` | Fork that session into a new one |
| `--session-dir <dir>` | Session storage directory |
| `--no-session` | Ephemeral mode (no save) |

---

## free-code packages

| Command | Description |
|---------|-------------|
| `free-code install <source> [-l]` | Install a package (`-l` = project-local) |
| `free-code remove \| uninstall <source> [-l]` | Uninstall |
| `free-code update [source]` | Update (skips pinned versions) |
| `free-code list` | List installed packages |
| `free-code config` | Enable or disable package resources |

Typical sources: `npm:@scope/package`, `git:...`, URL. See [packages.md](packages.md).

---

## Output modes

| Mode | How | Documentation |
|------|-----|----------------|
| Interactive | (default) | README, [tui.md](tui.md) |
| Print | `-p`, `--print` | Single response and exit; accepts piped stdin |
| JSON line-by-line | `--mode json` | [json.md](json.md) (replace `pi` with `free-code` in examples) |
| RPC | `--mode rpc` | [rpc.md](rpc.md) |
| Export session | `--export <input.jsonl> [output]` | HTML if output does not end in `.md`; **Markdown** if the second arg is `*.md` (no second arg: default name next to the session) |

Export examples from the terminal (without opening the TUI):

```bash
free-code --export ~/.free-code/agent/sessions/…/session.jsonl
free-code --export session.jsonl report.html
free-code --export session.jsonl report.md
```

Print example:

```bash
cat README.md | free-code -p "Summarize this text"
```

---

## Model and tools (CLI)

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider |
| `--model <pattern>` | Model or `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P |
| `--list-models [search]` | List available models |
| `--tools <list>` | Built-in tools (default: `read,bash,edit,write,grep,find,ls`) |
| `--no-tools` | No built-in tools (extension tools still load) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `code_index`, `code_symbols`, `code_callers`, `code_context` (see [code-graph.md](code-graph.md)).

---

## Extensions and additional resources

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill (repeatable) |
| `--no-skills` | No skills |
| `--prompt-template <path>` | Prompt template (repeatable) |
| `--no-prompt-templates` | No prompt templates |
| `--theme <path>` | Theme (repeatable) |
| `--no-themes` | No themes |

---

## System prompt and files

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace the default system prompt |
| `--append-system-prompt <text>` | Append to the system prompt |

Files with `@`:

```bash
free-code @prompt.md "Answer this"
free-code -p @screenshot.png "What is in the image?"
```

---

## Environment variables (selection)

| Variable | Purpose |
|----------|---------|
| `FREE_CODE_CODING_AGENT_DIR` | Agent configuration directory |
| `PI_PACKAGE_DIR` | Package directory (e.g. Nix/Guix) |
| `PI_SKIP_VERSION_CHECK` | Skip version check at startup |
| `PI_CACHE_RETENTION` | `long` for extended prompt cache (provider-dependent) |
| `VISUAL`, `EDITOR` | External editor (e.g. Ctrl+G) |

API keys per provider: see [providers.md](providers.md).

---

## Related documentation

| Topic | File |
|-------|------|
| Full settings | [settings.md](settings.md) |
| Providers and models | [providers.md](providers.md), [models.md](models.md) |
| Skills | [skills.md](skills.md) |
| Extensions | [extensions.md](extensions.md) |
| Prompt templates | [prompt-templates.md](prompt-templates.md) |
| Themes | [themes.md](themes.md) |
| Embedded SDK | [sdk.md](sdk.md) |
| VS Code / Cursor plugin (chat export, settings) | [vscode-plugin.md](vscode-plugin.md) |
| Code graph (symbol and call index) | [code-graph.md](code-graph.md) |
| Terminal / tmux / Windows | [terminal-setup.md](terminal-setup.md), [tmux.md](tmux.md), [windows.md](windows.md) |

The broader CLI reference is in the **CLI Reference** section of [README.md](../README.md).
