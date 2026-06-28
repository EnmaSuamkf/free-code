# Free Code (macOS)

SwiftUI shell with `WKWebView` loading the same chat assets as the VS Code extension (`chat-mac.html`, `chat.js`, `chat.css`, `webview-mac-preamble.js`). A bundled **Node** process runs [`stdio-mac.mjs`](../../packages/free-desktop-host/src/stdio-mac.mjs) from [`@free/free-desktop-host`](../../packages/free-desktop-host) (copied into `Sources/FreeCodeMac/HostSrc` for the SwiftPM resource bundle).

## Requirements

- macOS 13+
- **Xcode** (from the App Store), not only “Command Line Tools”. Swift Package Manager needs the full toolchain under `Xcode.app` to compile `Package.swift`; with only CLT you often get linker errors on `PackageDescription` (see troubleshooting below).
- **Node.js** on the PATH or at `/opt/homebrew/bin/node` / `/usr/local/bin/node` (the app does not embed Node yet; see release script).
- **`free-code`** built or installed, same as the [VS Code extension README](../../packages/vscode-free-code/README.md).

## Build (Swift Package Manager)

Point the active developer directory at **Xcode.app** (after installing and opening Xcode once to accept the license):

```bash
xcode-select -p
# If this prints .../CommandLineTools, switch:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Then:

```bash
cd apps/free-code-macos
swift build -c release
```

Run the binary:

```bash
.build/release/FreeCodeMac
```

**Alternative:** open `Package.swift` in Xcode (**File → Open**), select the `FreeCodeMac` scheme, and **Product → Run** (or Build). That uses the same toolchain without relying on a correct `xcode-select` from the terminal.

## Troubleshooting

### `Invalid manifest` / `Undefined symbols` for `PackageDescription.Package`

Typical when Swift is coming from **Command Line Tools** (`/Library/Developer/CommandLineTools/...`) instead of **Xcode.app**. Install Xcode from the App Store, open it once, then run:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Verify:

```bash
xcode-select -p
# should print: /Applications/Xcode.app/Contents/Developer
swift build -c release
```

## Sync Host + media from monorepo

After changing `packages/free-desktop-host` or `packages/vscode-free-code/media`, refresh vendored copies:

```bash
./scripts/sync-macos-app-resources.sh
```

## Distribution (outline)

1. **Embed Node**: extend [`scripts/bundle-node-macos.sh`](../../scripts/bundle-node-macos.sh) to download the official `darwin` tarball for the target arch, place `node` under `Contents/Resources` in a `.app` bundle, and point `HostProcessModel` at that binary instead of system Node.
2. **codesign**: sign the app bundle, Node, and any dylibs with your Developer ID.
3. **notarization**: `xcrun notarytool submit` then staple the ticket.
4. **DMG**: `create-dmg` or `hdiutil` for distribution.

See Apple’s [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution) for current steps.
