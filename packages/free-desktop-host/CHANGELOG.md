# Changelog

## [Unreleased]

### Changed

- Session monitor: when the RPC child is not running or stats cannot be read, the host sends `unavailable` + hint instead of synthetic zeros; the webview shows **Load session**. On load/first fetch the host polls `get_state` (up to ~45s) until the child reports a **model**, the **session file matches** the tab when `sessionPath` is known, and **message counts are non-zero** when the webview already has restored rows — avoiding a long empty grid while the JSONL hydrates.

### Fixed

- Profile apply could leave the webview model pill on the spawn default when a late `postModelIndicator` round-trip finished after `set_model` (await indicator refresh after RPC sync and after profile `set_model`).
- First message of a chat sent while MCPs/tools/agents are still loading now echoes immediately with a "Waiting for agent to finish loading…" indicator instead of clearing the input and showing nothing until the agent is ready. `handlePrompt` previously awaited `ensureClientStarted` (10-30s) before rendering the user bubble, making the message look lost; plain prompts are now echoed before that await and de-duplicated afterward.

### Added

- `/mcp` command (`list`, `enable <name>`, `disable <name>`) handled in `host.mjs`, mirroring the CLI/RPC bundled extension: reads merged `mcp.json` (global + project-local) plus `~/.free-code/agent/mcp-status.json`, defaults newly seen servers to **disabled**, and writes activation state back so the change applies on the next session. The MCP startup loading indicator now counts only enabled servers. `mcp` added to the webview slash allowlist.
- Initial package: shared chat host (`host.mjs`), VS Code activation bridge, macOS `stdio-mac.mjs`, and minimal `vscode` shim for native UI.
