#!/usr/bin/env bash
# Double-click in Finder to install and launch free-code on macOS.
#
# This variant does not install Homebrew or Colima.
#
# Steps:
#   1. Install nvm + Node (latest LTS), set as nvm default
#   2. npm install (repo dependencies)
#   3. npm run build (compiles packages/coding-agent/dist — required, see below)
#   4. npm install -g ./packages/coding-agent
#   5. npm install -g agent-browser
#   6. Create free-code-rag/.venv and install Python dependencies
#   7. Copy FreeCodeMac.app -> /Applications
#   8. Launch free-code
#
# Why step 3 is mandatory: packages/coding-agent declares bin `free-code` ->
# `dist/cli.js`, and `dist/` is git-ignored (never committed). The package has no
# `prepare` script, so `npm install -g ./packages/coding-agent` does NOT build it.
#
# To skip launching at the end:
#   INSTALL_FREE_CODE_NO_LAUNCH=1 bash installation/install-free-code-mac_2.command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_SRC="${REPO_ROOT}/apps/free-code-macos/dist/FreeCodeMac.app"
APP_DEST="/Applications/FreeCodeMac.app"
RAG_DIR="${REPO_ROOT}/free-code-rag"
RAG_VENV="${RAG_DIR}/.venv"
RAG_REQUIREMENTS="${RAG_DIR}/requirements.txt"

FAILED_STEPS=()

has_cmd() { command -v "$1" >/dev/null 2>&1; }
die()      { echo "Error: $*" >&2; exit 1; }

# free-code requires Node 20+ (see "engines" in package.json).
REQUIRED_NODE_MAJOR=20
check_node_version() {
  has_cmd node || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "${major}" -ge "${REQUIRED_NODE_MAJOR}" ]]
}

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
    echo "Warning: nvm install failed." >&2
    return 1
  fi
  load_nvm || { echo "Warning: nvm.sh not found after install." >&2; return 1; }
}

ensure_python_venv() {
  echo "==> Python venv for free-code-rag"

  if [[ ! -d "${RAG_DIR}" ]]; then
    echo "Warning: free-code-rag directory not found at ${RAG_DIR}; skipping Python venv." >&2
    FAILED_STEPS+=("free-code-rag directory not found")
    return 0
  fi

  if [[ ! -f "${RAG_REQUIREMENTS}" ]]; then
    echo "Warning: requirements.txt not found at ${RAG_REQUIREMENTS}; skipping Python dependency install." >&2
    FAILED_STEPS+=("free-code-rag requirements.txt not found")
    return 0
  fi

  if ! has_cmd python3; then
    echo "Warning: python3 is required to create ${RAG_VENV} but was not found on PATH." >&2
    FAILED_STEPS+=("python3 not available")
    return 0
  fi

  if [[ ! -d "${RAG_VENV}" ]]; then
    if ! python3 -m venv "${RAG_VENV}"; then
      echo "Warning: could not create Python venv at ${RAG_VENV}." >&2
      FAILED_STEPS+=("Create free-code-rag/.venv")
      return 0
    fi
  else
    echo "Using existing venv: ${RAG_VENV}"
  fi

  if ! "${RAG_VENV}/bin/python" -m pip install --upgrade pip; then
    echo "Warning: pip upgrade failed in ${RAG_VENV}." >&2
    FAILED_STEPS+=("Upgrade pip in free-code-rag/.venv")
  fi

  if ! "${RAG_VENV}/bin/python" -m pip install -r "${RAG_REQUIREMENTS}"; then
    echo "Warning: pip install -r requirements.txt failed for free-code-rag." >&2
    FAILED_STEPS+=("Install free-code-rag Python dependencies")
  fi
}

main() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS only."

  # ── 1. Node (latest LTS via nvm) ───────────────────────────────────────────
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
    echo "Warning: nvm unavailable. Install Node.js manually, then rerun this installer." >&2
    FAILED_STEPS+=("Node.js not available")
  fi

  if has_cmd node && ! check_node_version; then
    echo "Warning: Node $(node --version) is older than the required v${REQUIRED_NODE_MAJOR}." >&2
    echo "         The build and the free-code CLI will fail. Upgrade Node and rerun." >&2
    FAILED_STEPS+=("Node.js older than v${REQUIRED_NODE_MAJOR}")
  fi

  # ── 2. Repo dependencies ───────────────────────────────────────────────────
  echo "==> npm install (repo dependencies)"
  if has_cmd npm; then
    if ! (cd "${REPO_ROOT}" && npm install); then
      echo "Warning: npm install failed in repo root; npm global installs may also fail." >&2
      FAILED_STEPS+=("npm install (repo root)")
    fi
  else
    echo "Warning: npm not found; skipping repo dependency install." >&2
    FAILED_STEPS+=("npm not available")
  fi

  # ── 2b. Build the workspace ────────────────────────────────────────────────
  # Mandatory: packages/coding-agent/dist is git-ignored and the package has no
  # `prepare` script, so the global install below would link a missing dist/cli.js.
  echo "==> npm run build (compiles packages/coding-agent/dist)"
  if has_cmd npm; then
    if ! (cd "${REPO_ROOT}" && npm run build); then
      echo "Warning: npm run build failed; 'free-code' will not work until this succeeds." >&2
      FAILED_STEPS+=("npm run build (repo root)")
    fi
  else
    echo "Warning: npm not found; skipping build." >&2
  fi

  if [[ ! -f "${REPO_ROOT}/packages/coding-agent/dist/cli.js" ]]; then
    echo "Warning: ${REPO_ROOT}/packages/coding-agent/dist/cli.js is missing after the build." >&2
    echo "         The global 'free-code' command and the VS Code plugin will not work." >&2
    FAILED_STEPS+=("packages/coding-agent/dist/cli.js not built")
  fi

  # ── 3. Install coding-agent globally ──────────────────────────────────────
  echo "==> npm install -g ./packages/coding-agent"
  if has_cmd npm; then
    if ! npm install -g "${REPO_ROOT}/packages/coding-agent"; then
      echo "Warning: global install of coding-agent failed." >&2
      FAILED_STEPS+=("npm install -g coding-agent")
    fi
  else
    echo "Warning: npm not found; skipping global coding-agent install." >&2
  fi

  # ── 4. Install agent-browser globally ─────────────────────────────────────
  echo "==> npm install -g agent-browser"
  if has_cmd npm; then
    if ! npm install -g agent-browser; then
      echo "Warning: global install of agent-browser failed." >&2
      FAILED_STEPS+=("npm install -g agent-browser")
    fi
  else
    echo "Warning: npm not found; skipping global agent-browser install." >&2
  fi

  # ── 5. free-code-rag Python environment ───────────────────────────────────
  ensure_python_venv

  # ── 6. Copy FreeCodeMac.app to /Applications ──────────────────────────────
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

  # ── Summary ───────────────────────────────────────────────────────────────
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

  # ── 7. Launch free-code ───────────────────────────────────────────────────
  if [[ -z "${INSTALL_FREE_CODE_NO_LAUNCH:-}" ]]; then
    if has_cmd free-code; then
      echo "==> Launching free-code"
      cd "${REPO_ROOT}"
      exec free-code
    else
      echo "Warning: 'free-code' command not found on PATH." >&2
      echo "         Open a new terminal (so nvm/npm global bin is on PATH) and run: free-code" >&2
    fi
  fi
}

main "$@"
