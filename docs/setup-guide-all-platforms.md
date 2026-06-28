# Build Guide: `.app` and `.vsix` (Developers)

How to generate the free-code distributable artifacts locally.

---

## Quick Reference

### FreeCodeMac (.app)

```bash
npm install
npm run build
cd apps/free-code-macos
swift build -c release
./scripts/package-free-code-macos-app.sh          # → dist/FreeCodeMac.app
./scripts/package-free-code-macos-app.sh --pkg    # → dist/FreeCodeMac.pkg
cp -R dist/FreeCodeMac.app /Applications/
```

### VS Code / Cursor plugin (.vsix)

```bash
npm install
npm run build
cd packages/vscode-free-code
npm run package                                  # → vscode-free-code-X.X.X.vsix
cursor --install-extension vscode-free-code-*.vsix
# or: code --install-extension vscode-free-code-*.vsix
```

---

## Requirements

| Tool | Minimum version | Purpose |
|------|----------------|---------|
| Node.js | 20+ | all packages |
| npm | 9+ | workspace dependencies |
| Git | any | clone the repo |
| Xcode (command-line tools) | 15+ | macOS `.app` only |
| macOS | 13+ | macOS `.app` only |

Install Xcode command-line tools if not present:

```bash
xcode-select --install
```

---

## Initial setup

```bash
git clone https://github.com/badlogic/free-code.git
cd free-code
npm install
```

`npm install` installs all workspace dependencies. The monorepo packages are:

- `packages/ai` — model registry and providers
- `packages/agent` — agent runtime
- `packages/coding-agent` — CLI and RPC server
- `packages/tui` — terminal UI
- `packages/vscode-free-code` — VS Code/Cursor extension
- `apps/free-code-macos` — native macOS application

---

## Build all packages

```bash
npm run build
```

Compiles TypeScript, syncs extensions and MCP configs, and copies assets to each `dist/`. Takes 2–5 minutes on the first run.

### Partial build (single package)

```bash
npm run build --workspace=packages/coding-agent
```

---

## FreeCodeMac (.app)

### Build

```bash
cd apps/free-code-macos
swift build -c release
```

The binary is placed at `.build/release/FreeCodeMac`.

### Package as a distributable .app

From the repo root:

```bash
./scripts/package-free-code-macos-app.sh          # → apps/free-code-macos/dist/FreeCodeMac.app
./scripts/package-free-code-macos-app.sh --pkg    # also generates .pkg
```

### Install locally

```bash
cp -R apps/free-code-macos/dist/FreeCodeMac.app /Applications/
open /Applications/FreeCodeMac.app
```

### After changes

```bash
npm run build              # if you edited TypeScript
cd apps/free-code-macos
swift build -c release     # if you edited Swift
```

### How FreeCodeMac finds the agent

1. First looks for `packages/coding-agent/dist/cli.js` (local monorepo build)
2. If not found, uses the `free-code` on PATH (global install)
3. Can be overridden in **Preferences → Executable Path**

No need for `npm install -g` if you have already run `npm run build` in the monorepo.

### Swift development

```bash
cd apps/free-code-macos
swift build -c debug
swift run FreeCodeMac
```

---

## VS Code / Cursor plugin (.vsix)

### Build

```bash
npm run build                    # build packages/coding-agent first
cd packages/vscode-free-code
npm run package                  # → vscode-free-code-X.X.X.vsix
```

### Install

From the command line:

```bash
cursor --install-extension vscode-free-code-0.66.1.vsix
# or
code --install-extension vscode-free-code-0.66.1.vsix
```

From the UI:
1. **Extensions** (`Cmd+Shift+X`) → menu `···` → **Install from VSIX...**
2. Select the `.vsix`
3. `Cmd+Shift+P` → **Developer: Reload Window**

> The plugin bundles only the UI. The agent it runs is `packages/coding-agent/dist/cli.js` (if it exists in the monorepo) or the `free-code` on PATH. Every time you touch `packages/coding-agent`, rebuild with `npm run build`.

### After changes

```bash
npm run build                    # recompile the agent
cd packages/vscode-free-code
npm run package                  # regenerate the .vsix
# reinstall the .vsix and Reload Window
```

---

## Summary table

| Artifact | Build | Install | Requires |
|----------|-------|---------|----------|
| `.app` | `swift build -c release` + `package-free-code-macos-app.sh` | `cp -R *.app /Applications/` | Xcode 15+, macOS 13+ |
| `.vsix` | `npm run package` in `packages/vscode-free-code` | `cursor/code --install-extension *.vsix` | Node 20+ |
