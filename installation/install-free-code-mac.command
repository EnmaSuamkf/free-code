#!/usr/bin/env bash
# Double-click in Finder to install and launch free-code on macOS.
#
# Steps:
#   1. Install Homebrew (if missing)
#   2. Install Colima
#   3. Install nvm + Node (latest LTS), set as nvm default
#   4. npm install (repo dependencies)
#   5. npm install -g ./packages/coding-agent
#   6. npm install -g agent-browser
#   7. Copy FreeCodeMac.app -> /Applications
#   8. Launch free-code
#
# To skip launching at the end:
#   INSTALL_FREE_CODE_NO_LAUNCH=1 bash installation/install-free-code-mac.command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_SRC="${REPO_ROOT}/apps/free-code-macos/dist/FreeCodeMac.app"
APP_DEST="/Applications/FreeCodeMac.app"

FAILED_STEPS=()

has_cmd() { command -v "$1" >/dev/null 2>&1; }
die()      { echo "Error: $*" >&2; exit 1; }

run_optional() {
  local label="$1"; shift
  echo "==> ${label}"
  set +e; "$@"; local ec=$?; set -e
  if [[ $ec -ne 0 ]]; then
    echo "Warning: ${label} failed (exit ${ec}); continuing." >&2
    FAILED_STEPS+=("${label}")
  fi
  return 0
}

ensure_brew_shellenv() {
  if   [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew    ]]; then eval "$(/usr/local/bin/brew shellenv)"
  fi
}

load_nvm() {
  declare -F nvm >/dev/null 2>&1 && return 0
  local nvm_sh
  for nvm_sh in \
      "${NVM_DIR:-$HOME/.nvm}/nvm.sh" \
      "/opt/homebrew/opt/nvm/nvm.sh" \
      "/usr/local/opt/nvm/nvm.sh"; do
    if [[ -s "$nvm_sh" ]]; then
      set +eu; source "$nvm_sh"; set -eu
      return 0
    fi
  done
  return 1
}

ensure_nvm_installed() {
  if load_nvm; then return 0; fi
  echo "==> Installing nvm"
  if ! curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh" | bash; then
    echo "Warning: nvm install failed; will fall back to brew node." >&2
    return 1
  fi
  load_nvm || { echo "Warning: nvm.sh not found after install." >&2; return 1; }
}

main() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS only."

  # ── 1. Homebrew ────────────────────────────────────────────────────────────
  echo "==> Homebrew"
  if ! has_cmd brew; then
    echo "Installing Homebrew (you may be asked for your password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  ensure_brew_shellenv
  has_cmd brew || die "brew not on PATH after install. Apple Silicon: eval \"\$(/opt/homebrew/bin/brew shellenv)\""
  brew --version

  # ── 2. Colima ──────────────────────────────────────────────────────────────
  echo "==> Colima"
  if ! has_cmd colima; then
    run_optional "brew install colima" brew install colima
  else
    echo "colima already installed: $(colima version 2>/dev/null | head -n1 || true)"
  fi

  # ── 3. Node (latest LTS via nvm) ───────────────────────────────────────────
  echo "==> Node.js (latest LTS via nvm)"
  if ensure_nvm_installed && declare -F nvm >/dev/null 2>&1; then
    set +eu
    nvm install --lts
    nvm use --lts
    nvm alias default "lts/*"
    set -eu
    echo "Node: $(node --version)"
    echo "npm:  $(npm --version)"
  else
    echo "Warning: nvm unavailable; falling back to brew node." >&2
    run_optional "brew install node" brew install node
    if has_cmd node; then
      echo "Node: $(node --version)"
    else
      FAILED_STEPS+=("Node.js not available")
    fi
  fi

  # ── 4. Repo dependencies ───────────────────────────────────────────────────
  echo "==> npm install (repo dependencies)"
  if ! (cd "${REPO_ROOT}" && npm install); then
    echo "Warning: npm install failed in repo root; npm global installs may also fail." >&2
    FAILED_STEPS+=("npm install (repo root)")
  fi

  # ── 5. Install coding-agent globally ──────────────────────────────────────
  echo "==> npm install -g ./packages/coding-agent"
  if ! npm install -g "${REPO_ROOT}/packages/coding-agent"; then
    echo "Warning: global install of coding-agent failed." >&2
    FAILED_STEPS+=("npm install -g coding-agent")
  fi

  # ── 6. Install agent-browser globally ─────────────────────────────────────
  echo "==> npm install -g agent-browser"
  if ! npm install -g agent-browser; then
    echo "Warning: global install of agent-browser failed." >&2
    FAILED_STEPS+=("npm install -g agent-browser")
  fi

  # ── 7. Copy FreeCodeMac.app to /Applications ────────────────────────────────
  echo "==> Copy FreeCodeMac.app -> /Applications"
  if [[ -d "${APP_SRC}" ]]; then
    rm -rf "${APP_DEST}"
    if cp -R "${APP_SRC}" "${APP_DEST}"; then
      echo "Copied ${APP_SRC} -> ${APP_DEST}"
    else
      echo "Warning: copy failed; retrying with sudo..." >&2
      if sudo cp -R "${APP_SRC}" "${APP_DEST}"; then
        echo "Copied (sudo) ${APP_SRC} -> ${APP_DEST}"
      else
        echo "Warning: could not copy FreeCodeMac.app to /Applications." >&2
        FAILED_STEPS+=("Copy FreeCodeMac.app -> /Applications")
      fi
    fi
  else
    echo "Warning: app bundle not found at ${APP_SRC}; skipping copy." >&2
    FAILED_STEPS+=("Copy FreeCodeMac.app (source not found: ${APP_SRC})")
  fi

  # ── Summary ────────────────────────────────────────────────────────────────
  echo ""
  echo "Installation completed."
  echo ""

  if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
    echo "Some steps failed (the script continued anyway):"
    for s in "${FAILED_STEPS[@]}"; do echo "  - ${s}"; done
    echo ""
  else
    echo "All steps completed without recorded failures."
    echo ""
  fi

  # ── 8. Launch free-code ─────────────────────────────────────────────────────
  if [[ -z "${INSTALL_FREE_CODE_NO_LAUNCH:-}" ]]; then
    echo "==> Launching free-code"
    cd "${REPO_ROOT}"
    exec free-code
  fi
}

main "$@"
