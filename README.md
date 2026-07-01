# free-code

**Your AI coding agent. Runs natively on macOS, in VS Code / Cursor, and in the terminal.**

A full-featured AI coding agent with deep code understanding, local knowledge bases, browser
automation, inbound webhooks, multi-provider AI, and layered security — local-first, cloud-ready.

Runs on **Linux & macOS** · **VS Code / Cursor plugin** · **Terminal CLI** · **macOS desktop app**

> **📖 See everything in one place.** After cloning, open **`web-docs/index.html`** in your browser —
> no build step required. The full docs site covers every capability, the command reference,
> installation for all platforms, and interactive demos.

---

## What makes free-code different

- **Agentic** — real tools on your project: read and edit files, run shell commands, browse the web, and call MCP servers. It acts, not only suggests.
- **Local-first** — sessions, code graph, and knowledge bases live on your machine. Your source stays under your control by default.
- **Extensible** — skills, extensions, and MCP servers extend behavior without forking the agent.
- **Connected** — calls MCP servers, receives inbound webhooks from external systems (Flowise, CI, GitHub), and explores the web autonomously.
- **Secure** — layered guardrails: audit exports, real-time confirmation of risky bash commands, visibility into active skills/MCPs/agents, and policies you control.

---

## Features

| Feature | What it does |
| --- | --- |
| **Multi-provider AI** | Anthropic, Google Vertex/Gemini, OpenAI, Azure OpenAI, Ollama, LM Studio, or any OpenAI-compatible endpoint. Switch models mid-session. |
| **Full tool access** | Read, edit, and write files. Run shell commands. Search with grep/find. Works on your actual project, not a sandbox copy. |
| **Code Graph** | Local symbol and call-edge index. Find any function by name, trace callers, and read symbol source — without blindly scanning files. |
| **RAG knowledge base** | Local vector search over your own documents (`.txt`, `.md`, `.pdf`, `.docx`). Multiple named knowledge bases. Auto-refresh on a schedule. |
| **Browser automation** | Built-in browser control via CDP — navigate, screenshot, extract content, interact with web UIs. |
| **MCP servers** | Connect any Model Context Protocol server (databases, APIs, CI, design tools). Tools appear in the next session automatically. |
| **Inbound webhooks** | Let external systems POST events into a running session — queue them for the agent, or wake it immediately. Local, authenticated. |
| **Subagents** | Spin up parallel subagents from within a session, each with its own context. |
| **Skills & extensions** | Commit reusable agent behaviors as markdown skills; extensions add new tools and commands. |
| **Session management** | Resume, fork, compact, and branch sessions. Navigate history as a tree. Export to HTML, Markdown, or JSONL. |

---

## Quick start

Clone the repository:

```bash
git clone https://github.com/EnmaSuamkf/free-code.git
cd free-code
```

**Then open the full docs — no build step required.** Everything you need to install and use
free-code is in that local site:

- Open **`web-docs/index.html`** in your browser (double-click it), **or** from the terminal:

  ```bash
  # Linux
  xdg-open web-docs/index.html
  # macOS
  open web-docs/index.html
  ```

- In **Finder** (macOS): open the cloned `free-code` folder → `web-docs` → double-click `index.html`.

From there you can browse every capability, the command reference, installation steps for
macOS / VS Code / Cursor / CLI, and interactive demos.

### Install

```bash
# Linux — installs the CLI
bash ./installation/install-free-code-linux.sh

# macOS — installs the CLI + desktop app
bash ./installation/install-free-code-mac.command
```

On macOS you can also double-click `install-free-code-mac.command` in Finder.

**CLI only (any platform):**

```bash
npm install
npm install -g ./packages/coding-agent
```

### Start a session

```bash
free-code
```

On macOS you can also open the **FreeCodeMac** desktop app from `/Applications`. Want the editor
plugin? See [Install the VS Code / Cursor plugin](web-docs/installation.html).

---

## Highlights

- **Code Graph** — a local, on-disk symbol index and call graph so the agent navigates by structure
  instead of scanning files. Indexes multiple languages, including Python and Java.
- **RAG** — index documents once (`/rag addFile`, `/rag addGroup`, `/rag addGithubUrl`) and the agent
  retrieves the most relevant passages during a session. Runs fully locally (FAISS + a local embedding model).
- **MCP** — add servers under `mcp.json`; they start disabled and you opt in with `/mcp enable <name>`,
  so importing a config never silently runs code. Secrets stay in `.env`, out of your config.
- **Inbound webhooks** — register a hook with `/webhook add <name>`, hand its authenticated URL to an
  external system, and receive its events in `queue` (buffer for the agent to drain) or `trigger`
  (wake the agent now) mode. Local by default; each session auto-assigns a free port.

---

## Providers

Built-in providers appear in `/model` once you authenticate:

| Provider | Auth |
| --- | --- |
| `anthropic` | Claude subscription or `ANTHROPIC_API_KEY` |
| `openai-codex` | ChatGPT / Codex sign-in |
| `google-gemini-cli` | Gemini CLI sign-in |
| `google-antigravity` | Google Antigravity sign-in |
| `openai` | `OPENAI_API_KEY` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` (+ base URL) |
| `google` | `GEMINI_API_KEY` |

You can also add any OpenAI-compatible endpoint, including local models (Ollama, LM Studio). See
[Local models setup](docs/local-models-setup.md).

---

## Documentation

The full documentation site lives in **`web-docs/`** (open `web-docs/index.html`). Markdown guides:

| Topic | Web docs | Guide |
| --- | --- | --- |
| Installation (all platforms) | [installation](web-docs/installation.html) | [setup-guide-all-platforms.md](docs/setup-guide-all-platforms.md) · [mac-installation.md](docs/mac-installation.md) |
| Commands & shortcuts | [commands](web-docs/commands.html) | [commands-reference.md](docs/commands-reference.md) |
| Code graph | [code graph](web-docs/code-graph.html) | [code-graph.md](docs/code-graph.md) |
| RAG knowledge base | [rag](web-docs/rag.html) | [rag-server-guide.md](docs/rag-server-guide.md) |
| MCP servers | [mcp](web-docs/mcp.html) | — |
| Inbound webhooks | [webhooks](web-docs/webhooks.html) | — |
| Models & providers | [models](web-docs/models.html) | [local-models-setup.md](docs/local-models-setup.md) |
| Browser automation | [capabilities](web-docs/capabilities.html) | [agent-browser-guide.md](docs/agent-browser-guide.md) |
| Advanced configuration | — | [advanced-configuration.md](docs/advanced-configuration.md) |

→ **[Full documentation index](docs/README.md)**

---

## License

[MIT](LICENSE)

---

Powered by CX — developed by Pablo Castañeda
