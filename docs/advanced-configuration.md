# Local setup (free-code fork)

This guide is for developers cloning **this modified repository** and running the agent locally with the **free-code** branding and the data directory **`~/.free-code/agent/`**.

## Requirements

- **Node.js** ≥ 20 (see `engines` in the root `package.json`).
- **npm** (this repo uses workspaces).
- Optional: **LM Studio** or any other OpenAI-compatible server if you use local models.

## Quickstart (install & run)

Typical workflow (installs the global `free-code` binary from your clone):

```bash
git clone <url-to-your-fork-or-repo> free-code
cd free-code
npm install
npm run build
npm install -g ./packages/coding-agent
free-code
```

Example with a local model (LM Studio) and without built-in tools:

```bash
free-code --no-tools --model 'lmstudio/google/gemma-4-e2b:2'
```

Development alternative (no global install):

```bash
chmod +x free-code-test.sh   # first time only
./free-code-test.sh
```

## 1. Install dependencies

```bash
npm install
```

## 2. Build

```bash
npm run build
```

Without this, running from source won’t find the internal packages’ `dist/` output.

## 3. Install & run `free-code` (recommended)

From the repo root (after building):

```bash
npm install -g ./packages/coding-agent
free-code
```

During a global install, bundled skills from `packages/coding-agent/skills/` are copied into `~/.free-code/skills/`, and files from `packages/coding-agent/mcps/` (synced from the repo-level `mcps/` folder on build) are copied into `~/.free-code/agent/` only when the target path does not already exist — your existing `mcp.json`, `.env`, or other files there are never replaced. Additionally, when `example.env` is present in the bundled `mcps/` folder and **`~/.free-code/agent/.env` does not exist yet**, that template is copied **as** `.env` (fill in tokens locally); the repo’s real `mcps/.env` is never bundled. Paths named `.env` under `mcps/` are skipped when building the package so secrets are not bundled. The package build syncs skills from the repo-level `.free-code/skills/` directory into that bundled `skills/` folder first.

**Before** `npm install -g ./packages/coding-agent`, run `cd packages/coding-agent && npm run sync-project-mcps` (or `npm run build` there) so `packages/coding-agent/mcps/` includes `example.env` and `mcp.json` from the repo `mcps/` folder. If npm prints **up to date**, it usually **does not** rerun `postinstall`; use `npm install -g ./packages/coding-agent --force` after syncing, or run `FREE_CODE_INSTALL_BUNDLED_SKILLS=1 node packages/coding-agent/scripts/install-bundled-skills.mjs` from the repo root.

### Alternative: run the CLI from source (development)

```bash
chmod +x free-code-test.sh   # first time only
./free-code-test.sh
```

This is equivalent to `./pi-test.sh`: it runs `tsx` on `packages/coding-agent/src/cli.ts`.

## Deleted `~/.free-code` — recreate everything

You **do not** need to `mkdir` manually. Follow this order:

1. **Build** from your clone so `packages/coding-agent/skills/` and `packages/coding-agent/mcps/` are populated (repo `.free-code/skills/` → bundle; repo `mcps/` → bundle):

   ```bash
   cd /path/to/free-code
   npm install
   npm run build
   ```

2. **Seed bundled skills + MCP files** into your home (`~/.free-code/skills/`, `~/.free-code/agent/mcp.json`, and `~/.free-code/agent/.env` from `example.env` only when `.env` is missing):

   ```bash
   npm install -g ./packages/coding-agent --force
   ```

   If npm says **up to date** and skips `postinstall`, run:

   ```bash
   FREE_CODE_INSTALL_BUNDLED_SKILLS=1 node packages/coding-agent/scripts/install-bundled-skills.mjs
   ```

   Optionally sync MCP only then install script:

   ```bash
   cd packages/coding-agent && npm run sync-project-mcps && cd ../..
   ```

3. **Run `free-code` once** (or `./free-code-test.sh`). The CLI creates **`~/.free-code/agent/`** and writes `settings.json`, session dirs, `auth.json`, etc., as you use features.

4. **Restore what code cannot recreate:**
   - **API keys / OAuth** — configure providers again or edit `~/.free-code/agent/auth.json`.
   - **`models.json`** — see [§6 Local models](#6-local-models-modelsjson-optional) if you use LM Studio/Ollama.
   - **`.env` for MCP** — edit `~/.free-code/agent/.env` (template from step 2) with real tokens; Docker MCP configs reference `./.env` with cwd `~/.free-code/agent/` ([§12](#12-configure-mcp-servers-mcpjson-optional)).
   - **MCP tool cache** — if tools look wrong after reconnecting, remove `~/.free-code/agent/mcp-tools-cache.json` and restart (see [§12 MCP tools cache](#mcp-tools-cache)).

## Multiline: Shift+Enter in Cursor / VS Code (integrated terminal)

**Ctrl+J** for a new line is handled inside the TUI. **Shift+Enter** is not, unless the **terminal** sends a distinct sequence: in the integrated terminal, Shift+Enter often looks identical to Enter, so the app can only run **submit**.

To make **Shift+Enter** insert a newline, add a **Cursor** (or VS Code) keybinding that injects the Kitty `CSI u` form for Shift+Return on the main Enter key. Open the Command Palette, choose **Open User Settings (JSON)** or edit the `keybindings.json` file for keybindings (not `settings.json`).

**Cursor (macOS)** — file: `~/Library/Application Support/Cursor/User/keybindings.json`

**VS Code (macOS)** — file: `~/Library/Application Support/Code/User/keybindings.json`

Append an object like this (merge into the top-level array if the file is already a JSON array):

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

The `text` value must be **`"\u001b[13;2u"`** (Kitty **CSI u**: codepoint 13 = Enter, modifier 2 = Shift). **Do not** use `"\u001b\r"` (ESC + carriage return) in `args`: that is a different sequence and will not reliably map to **Shift+Enter** / newline in the TUI (it can be confused with other key meanings depending on terminal mode).

Reload the window if the binding does not apply immediately, then try **Shift+Enter** again in the panel where `free-code` is running. Other platforms and more options are documented in [packages/coding-agent/docs/terminal-setup.md](../packages/coding-agent/docs/terminal-setup.md).

## 4. Where data is stored (`~/.free-code/agent/`)

The configuration path comes from `packages/coding-agent/package.json`:

```json
"piConfig": {
  "name": "free-code",
  "configDir": ".free-code"
}
```

Which means:

- User config directory: **`~/.free-code/`** (on Windows, the equivalent under your user profile).
- Agent data: **`~/.free-code/agent/`** (sessions, `settings.json`, `auth.json`, `models.json`, `bin/`, etc.).

**The folder is created automatically** the first time the process needs to write something (e.g. when starting interactive mode, saving settings, or creating a session). You do not need to `mkdir` anything ahead of time.

## 5. Built-in model registry (`models.generated.ts`)

The file `packages/ai/src/models.generated.ts` contains the **static list of all known models** (provider, id, name, API type, costs, context window, etc.). This registry is what powers the `/model` picker and `--list-models`.

### How it works

- The file is **not regenerated during `npm run build`**. It is a frozen snapshot that you maintain manually.
- Previously, the build step `generate-models` fetched model metadata live from three external APIs ([models.dev](https://models.dev), [OpenRouter](https://openrouter.ai/api/v1/models), and [Vercel AI Gateway](https://ai-gateway.vercel.sh/v1/models)). This was removed so builds are deterministic and you only ship models you actually use.

### Adding a model

Edit `packages/ai/src/models.generated.ts` and add an entry inside the corresponding provider block:

```ts
"my-new-model": {
  id: "my-new-model",
  name: "My New Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">,
```

### Removing models / providers

Delete the block for the model (or the entire provider object) and rebuild.

### Re-generating from external APIs (one-off)

The original script is still available if you ever want a fresh snapshot:

```bash
cd packages/ai
npx tsx scripts/generate-models.ts
```

This overwrites `src/models.generated.ts` with live data from the three APIs. Review the diff, keep what you need, and commit.

## 6. Local models (`models.json`) (optional)

If you use LM Studio (or Ollama, etc.), create or edit:

**`~/.free-code/agent/models.json`**

The first time, you can either create the file and its parent directory yourself, or let the agent create `agent/` and then add `models.json` and reload via `/model` in the TUI.

Minimal example for LM Studio at `http://localhost:1234/v1`:

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lmstudio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "your-exact-model-id-from-the-api" }]
    }
  }
}
```

The `id` must match what `GET http://localhost:1234/v1/models` returns.

## 7. Useful environment variables (optional)

### Override the agent data directory

If you want to **force** a different data directory (for example to share a directory between machines):

```bash
export FREE_CODE_CODING_AGENT_DIR="/absolute/path/to/agent"
```

The legacy variable `PI_CODING_AGENT_DIR` is also supported if you need compatibility with older scripts.

### Extensions with `-e` from another directory (`FREE_CODE_ROOT`)

`--extension` / `-e` paths are resolved relative to the **current working directory**. If you run `free-code` from another repo and want to load an extension that lives in this monorepo (e.g. `extensions/pure-focus.ts`), export the root of your free-code checkout:

```bash
export FREE_CODE_ROOT=/path/to/free-code
free-code -e extensions/pure-focus.ts
```

You can add this `export` to `~/.zshrc` (or your shell profile) so you don’t have to repeat it. Without the variable, use an **absolute path** to the `.ts` file or `cd` into the monorepo root before running `free-code -e ./extensions/pure-focus.ts`.

## 8. `free-code` on your PATH

The npm package is **`@free/pi-coding-agent`** (the binary is **`free-code`**). There is no public `free-code` package on the registry; you install it from your clone **after building**.

Global install from the monorepo:

```bash
npm install -g ./packages/coding-agent
```

Verify with `which free-code` and `free-code --version`.

**Alternative** (global symlink to the already-built package):

```bash
cd packages/coding-agent
npm link
```

The binary name is **`free-code`**, not `pi`.

## 9. Sanity check

```bash
./free-code-test.sh --list-models gemma
```

Or start without selecting a model to see the header and then `/quit`.

## 10. Migrating from `~/.pi/` (only if you used upstream)

If you previously used **`~/.pi/agent/`**, copy or sync to **`~/.free-code/agent/`** (or set `FREE_CODE_CODING_AGENT_DIR` to point at the old directory). This fork does **not** use `~/.pi` by default.

## 11. Skills (optional)

Skills are Markdown files with frontmatter that inject natural-language instructions into the LLM. Unlike extensions (TypeScript, can register tools), skills only provide context and guidance.

### Paths

| Scope                                  | Path                                  |
| -------------------------------------- | ------------------------------------- |
| **Global** (all sessions)              | `~/.free-code/skills/`                 |
| **Per project** (only that directory)  | `.free-code/skills/` (relative to cwd) |

Global skills are always loaded. Project skills are only loaded when free-code is run from that directory.

### Skill structure

Each skill is a directory containing a `SKILL.md` file:

```
~/.free-code/skills/
  my-skill/
    SKILL.md
```

`SKILL.md` contains YAML frontmatter metadata followed by Markdown instructions:

```markdown
---
name: My Skill
description: Short description of what it does
---

# Instructions

Put the instructions that will be injected into the LLM context here...
```

### Example: install a global skill

```bash
mkdir -p ~/.free-code/skills/my-skill
# Create SKILL.md with your instructions
```

### Example: project skill

```bash
mkdir -p .free-code/skills/my-skill
# Create SKILL.md with project-specific instructions
```

On startup, discovered skills from both locations are automatically added to the LLM context.

## 12. Configure MCP servers (`mcp.json`) (optional)

free-code can connect to MCP (Model Context Protocol) servers and automatically expose their tools to the LLM. The config format matches Cursor and Claude Desktop.

### Config file locations

| Scope                                  | Path                                   |
| -------------------------------------- | -------------------------------------- |
| **Global** (all sessions)              | `~/.free-code/agent/mcp.json`           |
| **Per project** (only that directory)  | `.free-code/mcp.json` (relative to cwd) |

Both files are read and merged at session start. If the same server name exists in both, the **project** config wins.

### Paths in `args` (stdio)

`command` and each entry in `args` are **not** parsed by a shell. free-code expands `~/`, `~`, `$HOME/…`, and `${HOME}` so you do not need absolute paths. Subprocesses started for stdio MCP servers use **`~/.free-code/agent`** as their working directory, so `"./.env"` with Docker’s `--env-file` resolves to `~/.free-code/agent/.env` beside the global `mcp.json`.

### Format

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server"],
      "env": {
        "BRAVE_API_KEY": "your-api-key"
      }
    },
    "remote-server": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Each entry under `mcpServers` defines a server. There are two connection modes:

- **Stdio** (local process): uses `command`, `args`, and optionally `env`. free-code starts the process and talks over stdin/stdout.
- **HTTP** (remote server): uses `url`. free-code connects via Streamable HTTP.

### Behavior

- On session start, the `mcp-client` extension connects to each server, discovers tools (`listTools`), and registers them as free-code tools.
- If two servers expose the same tool name, free-code prefixes it with the server name (e.g. `brave-search:web_search`).
- If one server fails to connect, free-code shows a warning and continues with the rest.
- On session end, all servers are disconnected.

### MCP tools cache

To avoid reconnecting to all MCPs and calling `listTools` on every startup, the `mcp-client` extension stores a snapshot of tools per server in:

```
~/.free-code/agent/mcp-tools-cache.json
```

Behavior:

- **First startup** (or after editing `mcp.json`): free-code waits for each server to connect and answer `listTools` before showing `Select tool groups`. It then writes the cache.
- **Later startups** with unchanged `mcp.json`: tools are registered instantly from the cache and the screen shows without waiting. Real connections are established in the background; if you call a tool before its server is ready, that call waits for the client.
- **Automatic invalidation**: if `command`, `args`, `env`, `url`, or `type` changes for a server, its hash won’t match and that server goes through the slow path again.

### Reset the cache

To discard the cache manually:

```bash
npm run reset-mcp-cache
```

This deletes `~/.free-code/agent/mcp-tools-cache.json`. The next `free-code` run will reconnect to all MCPs, call `listTools`, and regenerate the cache.

Manual equivalent:

```bash
rm ~/.free-code/agent/mcp-tools-cache.json
```

## 13. Use Google Vertex AI as a provider (optional)

### Authentication

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=<your_project_id>
export GOOGLE_CLOUD_LOCATION=<region>
```

You can put those `export`s in `~/.zshrc` (or your shell profile) to avoid repeating them.

### Set Vertex as the global default

Edit `~/.free-code/agent/settings.json`:

```json
{
  "defaultProvider": "google-vertex",
  "defaultModel": "gemini-2.5-pro"
}
```

With this, any new session uses Vertex without extra flags.

### One-off usage (without changing settings)

```bash
free-code --provider google-vertex --model gemini-2.5-pro
```

### Note about existing sessions

Existing sessions restore the model they were created with. To switch an existing session to Vertex, open `/model` and pick a model under `google-vertex`, or start a new session with `/new`.

### VS Code / Cursor extension

The sidebar extension runs `free-code --mode rpc` as a child process. It does **not** inherit shell `export` from a separate terminal the way an interactive CLI session does. ADC is still read from disk (`~/.config/gcloud/application_default_credentials.json` by default, or `GOOGLE_APPLICATION_CREDENTIALS` if set), but the child must see **project** and **region** via its environment.

**Option A — `free-code.env` in User or Workspace settings** (recommended):

```json
"free-code.env": {
  "GOOGLE_CLOUD_PROJECT": "<your_project_id>",
  "GOOGLE_CLOUD_LOCATION": "<region>"
}
```

In **Cursor**: **Cursor** menu → **Settings...** → **Settings** (`⌘,`), search `free-code`, then set `free-code.env` (or edit `settings.json`). *Cursor Settings* (`⇧⌘J`) is product-level config; extension keys like `free-code.env` live in standard **Settings**. In **VS Code**: **Code** → **Settings** → **Settings** (`⌘,`), same search.

**Option B — Launch Cursor/VS Code from a shell** where you already ran the `export`s (or your shell profile sets them).

UI-focused plugin reference: [vscode-plugin.md](vscode-plugin.md).

#### Vertex auth and env at a glance

| What | Where |
| --- | --- |
| `gcloud auth application-default login` | Run once in **any** terminal on your machine; use the **same** Google account you intend for Vertex. Writes ADC to the default gcloud path (unless you override with `GOOGLE_APPLICATION_CREDENTIALS`). |
| `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` | **CLI:** `export` in the shell or your profile (`~/.zshrc`, etc.). **Extension:** **Cursor** → **Settings...** → **Settings** (`⌘,`), search `free-code`, set `free-code.env` (or edit `settings.json`); VS Code: **Code** → **Settings** → **Settings**. The IDE does not inherit `export` from another terminal. |

## Summary

| Step      | Action                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1         | `npm install`                                                                                                           |
| 2         | `npm run build`                                                                                                         |
| 3         | `npm install -g ./packages/coding-agent` and then `free-code` (recommended), or `./free-code-test.sh` (dev)               |
| 4         | `~/.free-code/agent/` appears automatically when data needs to be written                                                 |
| 5         | `models.generated.ts` is a static model registry — edit manually to add/remove models; no external APIs called during build |
| 6 (opt.)  | Add `~/.free-code/agent/models.json` if you use LM Studio / custom providers                                             |
| 7 (opt.)  | `export FREE_CODE_ROOT=/path/to/free-code` if you use `free-code -e extensions/...` from another project                   |
| 8 (opt.)  | Add extra skills in `~/.free-code/skills/` (global) or `.free-code/skills/` (project); bundled skills are copied on global install |
| 9 (opt.)  | Create `~/.free-code/agent/mcp.json` or `.free-code/mcp.json` to connect MCP servers                                      |
| 10 (opt.) | Vertex: `gcloud auth application-default login`; set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` in the shell (CLI) or in `free-code.env` for the VS Code/Cursor plugin (see §13) |
| 11 (opt.) | `npm run reset-mcp-cache` to delete `~/.free-code/agent/mcp-tools-cache.json` and force a full MCP reconnect             |
