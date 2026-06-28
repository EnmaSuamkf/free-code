# macOS Installation

## Main installation

The recommended way to install free-code on macOS is via the installation script included in the repository.

**Double-click** `installation/install-free-code-mac.command` in Finder, or run it from the terminal:

```bash
bash installation/install-free-code-mac.command
```

The script automatically installs everything needed:

| Step | What it does |
|------|--------------|
| Homebrew | Installs it if not present |
| Colima | Installs it via Homebrew |
| Node.js (LTS) | Installs nvm and the latest LTS version; sets it as default |
| Dependencies | `npm install` at the repo root |
| `free-code` CLI | `npm install -g ./packages/coding-agent` |
| `agent-browser` | `npm install -g agent-browser` |
| FreeCodeMac.app | Copies the `.app` bundle to `/Applications` |
| Launch | Runs `free-code` on completion |

---

## Plugin for Cursor / VS Code (optional)

If you have **Cursor** or **VS Code** installed, you can install the free-code plugin to use it directly from the editor.

The `.vsix` file is at:
```
packages/vscode-free-code/vscode-free-code-0.66.1.vsix
```

### Prerequisite: enable the `cursor` or `code` command in the terminal

Before installing the plugin from the command line, the editor executable must be available on your PATH.

#### Cursor

Option A — symlink (recommended):
```bash
sudo ln -s /Applications/Cursor.app/Contents/Resources/app/bin/cursor /usr/local/bin/cursor
```

If you use Apple Silicon (M1/M2/M3) and the path above does not work:
```bash
sudo ln -s /Applications/Cursor.app/Contents/MacOS/Cursor /usr/local/bin/cursor
```

Option B — add to PATH in `~/.zshrc`:
```bash
export PATH="/Applications/Cursor.app/Contents/Resources/app/bin:$PATH"
```
Then reload: `source ~/.zshrc`

Verify:
```bash
cursor --version
```

#### VS Code

Easiest option: open VS Code, press `Cmd+Shift+P`, and run:
```
Shell Command: Install 'code' command in PATH
```

Or manually:
```bash
sudo ln -s "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" /usr/local/bin/code
```

Verify:
```bash
code --version
```

### Install the plugin

Once the editor command works in the terminal:

```bash
# Cursor
cursor --install-extension packages/vscode-free-code/vscode-free-code-0.66.1.vsix

# VS Code
code --install-extension packages/vscode-free-code/vscode-free-code-0.66.1.vsix
```

Graphical alternative:
1. Open **Extensions** (`Cmd+Shift+X`).
2. Menu `···` → **Install from VSIX...**.
3. Select the `.vsix` file.

After installing, reload the editor:
```
Cmd+Shift+P → Developer: Reload Window
```

For more details on plugin configuration and usage see [vscode-cursor-plugin-guide.md](vscode-cursor-plugin-guide.md).
