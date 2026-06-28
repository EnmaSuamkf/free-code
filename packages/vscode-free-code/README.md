# Free Code VS Code/Cursor Extension (MVP)

Sidebar chat extension for VS Code and Cursor backed by `free-code --mode rpc`.

## Requirements

- VS Code or Cursor compatible with `engines.vscode` in this package.
- `free-code` installed and available in `PATH`, or configured with `free-code.executablePath`.
- Agent auth/models configured (see `docs/free-code-local-setup.md`).
- For visual browser control, `agent-browser` installed separately and available in `PATH`; keep `free-code.noExtensions` set to `false` so the `agent_browser` tool can load and launch a headed browser window.

## Settings

- `free-code.executablePath`: executable path (`free-code` by default). For `/tools`, `/pick-tools`, and MCP groups, this must be a **current** build of `free-code` (same repo) so the RPC includes `get_tool_picker_state` / `set_tool_picker`. If you see `Unknown command: get_tool_picker_state`, your PATH still points at an older binary: set this to the full path of a freshly built `free-code`, or use `./pi-test.sh` / `npx` from the repo (see `docs/free-code-local-setup.md`).
- `free-code.cwd`: optional working directory (defaults to first workspace folder).
- `free-code.provider`: optional provider passed to RPC startup.
- `free-code.model`: optional model passed to RPC startup.
- `free-code.env`: object of extra environment variables for the `free-code` process (e.g. `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` for Vertex). The IDE does not inherit `export` from a separate terminal; set them here, or start Cursor/VS Code from a shell that already has them.
- `free-code.noExtensions` (default **false**): if **true**, the child process runs with `--no-extensions` (no MCP or agent extension discovery, faster). If **false**, behavior matches the terminal `free-code` CLI, including optional MCP / extension tool groups for `/pick-tools`. Changing this or the executable path restarts the RPC on the next chat action.

## Features

### Tabs

Chat uses a **tab bar**: each tab is a separate agent session (RPC `sessionFile` + `new_session` / `switch_session`). **+** opens a new tab; **×** closes a tab (or resets the only tab). History and `sessionPath` are persisted in workspace state (`freeCode.chatView.tabs.v1`); the legacy single-history key is migrated on first load.

### File chips

Drag files onto the input to insert `[file #N …]` chips (same expansion on send as the TUI's `pi-tui` editor: Explorer / `text/uri-list`, and Electron `File.path` when present).

### Visual browser control

Use the `Browser` button in the chat actions, or run **Free Code: Open visible browser with agent** from the command palette. Enter a URL and an optional goal; the extension sends a structured prompt that asks the agent to open a fresh headed `agent_browser` session, take an initial snapshot, and continue with browser actions from chat.

The browser is an external Chromium/Chrome-style window, not an embedded Cursor WebView. You should see clicks, typing, and navigation happen live in that window while the chat remains the control surface.

If the agent reports that `agent_browser` is unavailable or cannot launch a visible browser, install `agent-browser` separately, ensure it is on `PATH` for the Cursor/VS Code process, and keep `free-code.noExtensions` disabled.

### Slash commands

#### Gemini

For Gemini workflows, the chat slash menu includes:

- `/browse [url] [goal]` — visible browser, same headed `agent_browser` flow as the globe button.
- `/gemini ask <message>` — uses `gemini-browser`.
- `/gemini download <file-name>` — uses `gemini-download`.
- `/gemini open [chat_id]` — launches Gemini through `agent_browser` with CDP on `http://127.0.0.1:9222`.

These commands require extensions to be enabled.

#### RAG

Local RAG slash commands mirror the CLI behavior:

- `/rag-kb create|delete|use <name>`, `/rag-kb list` — manage knowledge bases.
- `/rag addFile <path>`, `/rag addGroup <folder>` — add documents.
- `/rag search <query>`, `/rag list`, `/rag remove <filename>` — query and manage documents.

There is no implicit KB in a new conversation: select one first with `/rag-kb use <name>`. Documents are stored under `~/.free-code/knowledgeBase/<kb>/` and requests are sent to the local RAG server (`http://localhost:8085`, overridable with `FREE_CODE_RAG_SERVER_URL` via `free-code.env`).

## Quick visual test

1. Package and install the VSIX:

   ```bash
   cd packages/vscode-free-code
   npm run package
   cursor --install-extension ./vscode-free-code-0.66.1.vsix
   ```

2. Reload Cursor with **Developer: Reload Window**.
3. Open the Free Code sidebar, press `Browser`, and enter `https://example.com`.
4. Confirm that an external visible browser window opens.
5. In chat, ask the agent to click or type something on the page and watch that same window.

## Package & Install

### Package as VSIX

From this package directory:

```bash
npm run package
```

This runs `npm run build` (esbuild bundle including `@free/free-desktop-host`) then `npx @vscode/vsce package` and generates `publisher.name-version.vsix`.

For local development without packaging, run `npm run build` after changing `src/extension-entry.mjs` or the desktop host package.

### Install VSIX

**VS Code:**

```bash
code --install-extension /absolute/path/to/file.vsix
```

**Cursor:**

```bash
cursor --install-extension /absolute/path/to/file.vsix
```

Or use UI: Extensions → `...` → **Install from VSIX...**.

## Handoff checklist

Share:

1. The `.vsix` file.
2. Install instruction (`Install from VSIX` or `--install-extension`).
3. Reminder to verify `free-code` works in terminal and auth is configured.
