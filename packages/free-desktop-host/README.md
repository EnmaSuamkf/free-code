# @free/free-desktop-host

Shared **Free Code chat host** used by:

- The **VS Code / Cursor** extension (`vscode-free-code`), bundled with esbuild into `dist/extension.js`.
- The **macOS** stdio entry [`src/stdio-mac.mjs`](./src/stdio-mac.mjs) (launched by the Swift app in `apps/free-code-macos`).

## Exports

- `host.mjs` — `FreeCodeChatViewProvider`, helpers, and RPC wiring (formerly `vscode-free-code/src/extension.js`).
- `vscode-api-binding.mjs` — `setVscodeApi` / `getVscode` so the same host runs under real VS Code or the macOS shim.
- `activate-vscode.mjs` — `activate` / `deactivate` for the extension.
- `stdio-mac.mjs` — JSONL stdin/stdout bridge for the native app.

## stdio protocol

See [webview-host-protocol.md](../vscode-free-code/docs/webview-host-protocol.md).
