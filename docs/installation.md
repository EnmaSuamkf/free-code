# Installation Guide

The single authoritative install guide for free-code. Three independent tracks:

| Track | What you get | Go to |
|---|---|---|
| **A — CLI** | The `free-code` command in your terminal | [Track A](#track-a--cli) |
| **B — VS Code / Cursor plugin** | free-code inside your editor, talking to the CLI over RPC | [Track B](#track-b--vs-code--cursor-plugin-rpc) |
| **C — RAG server** | Local knowledge base (`/rag` commands) | [Track C](#track-c--rag-server) |

**Track B requires Track A.** The plugin ships only the UI — it spawns the CLI as a
child process. Track C is optional and independent.

---

## Common prerequisites

| Tool | Minimum | Check | Needed for |
|---|---|---|---|
| Git | any | `git --version` | all tracks |
| Node.js | **20+** | `node -v` | tracks A, B |
| npm | 9+ | `npm -v` | tracks A, B |
| Python | 3.10+ | `python3 --version` | track C |
| `python3-venv` | — | `python3 -m venv --help` | track C (Debian/Ubuntu: `sudo apt-get install python3-venv`) |

Clone once; every track starts from the repo root:

```bash
git clone https://github.com/EnmaSuamkf/free-code.git
cd free-code
```

> **The build step is not optional.** `packages/coding-agent` declares its `free-code`
> binary as `dist/cli.js`, and `dist/` is git-ignored — it is never committed. The
> package has no `prepare` script, so `npm install -g ./packages/coding-agent` will
> **not** build it for you. Skipping `npm run build` leaves you with a `free-code`
> command that points at a file that does not exist.

---

## Track A — CLI

### Prerequisites

Git, Node 20+, npm (see above).

### Install

**Option 1 — installer script (recommended).** Installs Node via nvm, builds the
workspace, installs the CLI and `agent-browser` globally, and provisions the RAG venv:

```bash
# Linux
bash ./installation/install-free-code-linux.sh

# macOS — also installs Homebrew, Colima and the FreeCodeMac desktop app
bash ./installation/install-free-code-mac.command

# macOS without Homebrew/Colima
bash ./installation/install-free-code-mac_2.command
```

On macOS you can double-click `install-free-code-mac.command` in Finder instead.

Set `INSTALL_FREE_CODE_NO_LAUNCH=1` to stop the script from starting free-code when
it finishes. The scripts are idempotent — rerunning them is safe.

**Option 2 — manual (any platform).**

```bash
npm install                              # workspace dependencies
npm run build                            # REQUIRED — builds packages/coding-agent/dist
npm install -g ./packages/coding-agent   # installs the `free-code` command
npm install -g agent-browser             # optional — browser automation
```

`npm run build` takes 2–5 minutes on a first run.

### Verify

```bash
ls packages/coding-agent/dist/cli.js   # must exist
free-code -v                           # prints the version
free-code                              # starts an interactive session
```

Then configure a provider — inside a session run `/login`, or export a key:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Add the `export` to `~/.bashrc` or `~/.zshrc` so it survives new terminals. See
[local-models-setup.md](local-models-setup.md) to use Ollama or LM Studio instead.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `free-code: command not found` | The npm global bin is not on PATH. Open a **new** terminal (nvm edits your shell profile), or run `export PATH="$(npm prefix -g)/bin:$PATH"`. |
| `Cannot find module '.../dist/cli.js'` | `npm run build` was skipped or failed. Rerun it from the repo root. |
| `npm ERR! EACCES` on global install | Do not use `sudo`. Install Node via nvm so the global prefix lives in your home directory. |
| Syntax errors on startup | Node older than 20. Check `node -v`. |
| Stale behavior after `git pull` | Rerun `npm install && npm run build && npm install -g ./packages/coding-agent`. |

---

## Track B — VS Code / Cursor plugin (RPC)

### How it works

The extension does **not** embed an agent. It spawns the CLI as a child process with
`--mode rpc` and speaks newline-delimited JSON over **stdio**. There is no TCP port
and no handshake token to configure.

The executable is resolved in this order
(`resolveFreeCodeExecutable` in `packages/free-desktop-host/src/host.mjs`):

1. The `free-code.executablePath` setting, if it is a path ending in `.js` that exists → run with `node`
2. Otherwise, if the setting is still the default `free-code`, the workspace file
   `packages/coding-agent/dist/cli.js`, if it exists
3. Otherwise, `free-code` from your PATH

So a local monorepo build always wins over an older global install.

### Prerequisites

- **Track A completed** — you need either a global `free-code` or a built
  `packages/coding-agent/dist/cli.js`
- VS Code or Cursor, version **1.90.0 or newer**

### Install

The packaged extension is committed to the repo:

```
packages/vscode-free-code/vscode-free-code-0.66.1.vsix
```

Make the `code` or `cursor` command available in your terminal first:

- **VS Code:** `Cmd/Ctrl+Shift+P` → `Shell Command: Install 'code' command in PATH`
- **Cursor:** `Cmd/Ctrl+Shift+P` → `Shell Command: Install 'cursor' command in PATH`

Then install:

```bash
code --install-extension packages/vscode-free-code/vscode-free-code-0.66.1.vsix
# or
cursor --install-extension packages/vscode-free-code/vscode-free-code-0.66.1.vsix
```

**From the UI instead:** Extensions (`Cmd/Ctrl+Shift+X`) → `···` menu →
**Install from VSIX…** → pick the file.

Finally: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

To rebuild the `.vsix` from source, see
[setup-guide-all-platforms.md](setup-guide-all-platforms.md).

### Verify

1. Open the free-code view in the editor sidebar.
2. Send a message. A reply means the RPC child process started correctly.

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `free-code.executablePath` | `free-code` | Path to the CLI, or to a `dist/cli.js` |
| `free-code.cwd` | *(empty)* | Agent working directory; defaults to the first workspace folder |
| `free-code.provider` | *(empty)* | Passed as `--provider` |
| `free-code.model` | *(empty)* | Passed as `--model` |
| `free-code.env` | `{}` | Extra environment variables for the child process |
| `free-code.noExtensions` | `false` | Passes `--no-extensions` (faster startup, no MCP discovery) |

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `spawn free-code ENOENT` | The editor's PATH has no `free-code`. GUI apps do not inherit your shell profile — set `free-code.executablePath` to an absolute path, e.g. `/abs/path/to/repo/packages/coding-agent/dist/cli.js`. |
| `Unknown command: get_tool_picker_state` | The plugin reached an **older** `free-code` on PATH. Run `npm run build` in the monorepo, or point `free-code.executablePath` at the fresh `dist/cli.js`. |
| API key works in the terminal but not in the editor | Same PATH/env issue — put the keys in `free-code.env`. |
| Changes to the agent have no effect | Rebuild with `npm run build`, then **Developer: Reload Window**. |

---

## Track C — RAG server

A local FastAPI + FAISS server that backs the `/rag` and `/rag-kb` commands.

### Prerequisites

- Python 3.10+ and `python3-venv`
- ~3 GB free disk (`torch`, `sentence-transformers`)
- Network access on first run — downloads the `all-MiniLM-L6-v2` embedding model

### Install

The Linux and macOS installer scripts already create `free-code-rag/.venv`. To do it
by hand, or to repair it:

```bash
cd free-code-rag
make venv     # python3 -m venv .venv + pip install -r requirements.txt
```

> Do **not** run a bare `pip3 install -r requirements.txt`. On Debian/Ubuntu and on
> Homebrew Python this fails with `error: externally-managed-environment` (PEP 668).

### Start

There is **no `free-code-rag` command.** Start it in one of two ways:

**Automatically (normal case).** When `free-code` starts it launches the server for
you if nothing is listening yet and it can find the project directory — via
`FREE_CODE_RAG_SERVER_DIR`, a one-line path in `~/.free-code/agent/rag-server-dir`,
or `free-code-rag/` sitting next to the checkout. It prefers `.venv/bin/python`,
which is why creating the venv matters. Disable with `FREE_CODE_RAG_SERVER_AUTO=0`.

**Manually:**

```bash
cd free-code-rag
make start          # runs .venv/bin/python main.py
```

### Verify

```bash
curl http://localhost:8085/health
```

Then, in a free-code session:

```
/rag-kb create my-kb
/rag-kb use my-kb
/rag addFile ./README.md
/rag search "how do I install this"
```

### Configuration

| Variable | Default | Side | Purpose |
|---|---|---|---|
| `PORT` | `8085` | server | Listen port (`main.py`) |
| `HOST` | `0.0.0.0` | server | Bind address (`main.py`) |
| `FAISS_PERSIST_DIR` | `~/.free-code/faiss_store` | server | Vector index location |
| `FREE_CODE_RAG_SERVER_URL` | `http://localhost:8085` | client | Where the CLI looks for the server |
| `FREE_CODE_RAG_SERVER_DIR` | *(auto)* | client | Directory holding `main.py` |
| `FREE_CODE_RAG_SERVER_AUTO` | `1` | client | Set `0` to disable auto-start |
| `FREE_CODE_RAG_MAX_CHUNKS` | `3` | client | Max chunks per query |
| `FREE_CODE_RAG_MAX_CHARS` | `3000` | client | Max characters per query |

Documents live in `~/.free-code/knowledgeBase/<kb>/`.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `error: externally-managed-environment` | You used system pip. Use `make venv` (PEP 668). |
| Auto-start times out after 90 s | First run is downloading torch and the embedding model. Run `make start` in the foreground once to watch progress. |
| `a process already listens ... but uses <dir>` | An old/foreign RAG server holds port 8085. Stop it, then `make start`. |
| `GET /discover` missing (old server) | The process on 8085 is an outdated build. Stop it and start this one. |
| FAISS dimension mismatch on indexing | Delete `~/.free-code/faiss_store` (or `FAISS_PERSIST_DIR`) and re-index. |
| Docker build fails on certificates | Corporate TLS proxy — see the `CA_BUNDLE` override in `docker-compose.dev.yml`. |

Full command and HTTP API reference: [rag-server-guide.md](rag-server-guide.md).

---

## Where things live

| Path | Contents |
|---|---|
| `~/.free-code/agent/` | Sessions, settings (override with `FREE_CODE_CODING_AGENT_DIR`) |
| `~/.free-code/knowledgeBase/<kb>/` | RAG documents |
| `~/.free-code/faiss_store/` | RAG vector indexes |

## Next steps

- [commands-reference.md](commands-reference.md) — slash commands and CLI flags
- [advanced-configuration.md](advanced-configuration.md) — MCP servers, skills, auth
- [local-models-setup.md](local-models-setup.md) — Ollama, LM Studio
- [code-graph.md](code-graph.md) · [rag-server-guide.md](rag-server-guide.md)
- [setup-guide-all-platforms.md](setup-guide-all-platforms.md) — building `.app` / `.vsix` from source
