#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$ROOT/apps/free-code-macos/Sources/FreeCodeMac"
mkdir -p "$MAC/Media" "$MAC/HostSrc"
cp "$ROOT/packages/vscode-free-code/media/chat.js" \
  "$ROOT/packages/vscode-free-code/media/chat.css" \
  "$ROOT/packages/vscode-free-code/media/webview-mac-preamble.js" \
  "$MAC/Media/"
cp -R "$ROOT/packages/free-desktop-host/src/"* "$MAC/HostSrc/"
echo "Synced Media + HostSrc into $MAC"
