# Agent guidance

## Large reads and context window

Before starting a task, decide whether it will require reading many files (broad exploration, unfamiliar areas, or multi-module changes).

- If **yes**: spawn subagents to read or explore **disjoint subsets** of the codebase in parallel (e.g. by directory, feature, or question). Each subagent works in its own context; have them return **summaries, paths, and findings** rather than pasting entire files unless necessary.
- The **main agent** orchestrates: splits the work, merges subagent outputs, asks follow-up reads only where needed, and keeps the primary thread focused on decisions and edits.

Goal: avoid loading the orchestrating agent’s context with full trees of unrelated files.

## Documentation (`docs/`)

On **every** change, decide whether it belongs in `docs/` (updates to existing guides, READMEs, runbooks, or architecture notes).

For **new features**, also decide whether a **new** document is needed (a dedicated guide or page), not only edits to existing files.

## Web docs (`web-docs/`)

`web-docs/` is a static HTML site that presents free-code's capabilities to new users. It must stay in sync with `docs/`.

On **every** change that affects user-facing behavior (new commands, new tools, new features, changed workflows), also update the relevant page in `web-docs/`:

- `index.html` — landing page; feature grid and quick start
- `capabilities.html` — per-feature deep dives (RAG, browser, MCP, subagents, code graph, …)
- `commands.html` — all slash commands, keyboard shortcuts, and CLI flags
- `installation.html` — installation steps for macOS, VS Code/Cursor, and CLI
- `code-graph.html` — code graph feature page

All pages are plain HTML with no build step. Edit them directly.

## Webview UI (chat.js / chat.css)

The files `packages/vscode-free-code/media/chat.js` and `media/chat.css` are **generated build outputs** — never edit them directly.

The actual source is split into small modules:

```
packages/vscode-free-code/media/src/js/   ← 16 JS modules (01-dom-refs … 16-events)
packages/vscode-free-code/media/src/css/  ← 14 CSS modules (01-splash … 14-questionnaire)
```

To make changes:
1. Edit the relevant module in `media/src/js/` or `media/src/css/`
2. Run `npm run build:webview` from `packages/vscode-free-code/` to regenerate `chat.js` and `chat.css`
3. Reload the VS Code / Cursor window (`Developer: Reload Window`) to pick up the changes

The build script is `packages/vscode-free-code/scripts/build-webview.cjs`. It concatenates the modules in numeric order into the single output files that the extension loads.

**Important:** `npm run build` at the monorepo root does NOT rebuild the webview — it skips `vscode-free-code` entirely. Always run the build from inside `packages/vscode-free-code/`.
