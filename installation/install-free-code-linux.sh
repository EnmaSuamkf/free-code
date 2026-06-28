#!/usr/bin/env bash
# Install and launch free-code on Linux (Ubuntu/Debian and other distros).
#
# This is the Linux counterpart of install-free-code-mac_2.command.
# There is no GUI .app bundle on Linux, so this installs the free-code CLI
# and its dependencies instead of copying an app into /Applications.
#
# Steps:
#   1. Ensure base build tools (curl, git, python3-venv) are present
#   2. Install nvm + Node (latest LTS), set as nvm default
#   3. npm install (repo dependencies)
#   4. npm install -g ./packages/coding-agent
#   5. npm install -g agent-browser
#   6. Create free-code-rag/.venv and install Python dependencies
#   7. Launch free-code
#
# Usage:
#   bash installation/install-free-code-linux.sh
#
# To skip launching at the end:
#   INSTALL_FREE_CODE_NO_LAUNCH=1 bash installation/install-free-code-linux.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RAG_DIR="${REPO_ROOT}/free-code-rag"
RAG_VENV="${RAG_DIR}/.venv"
RAG_REQUIREMENTS="${RAG_DIR}/requirements.txt"

FAILED_STEPS=()

has_cmd() { command -v "$1" >/dev/null 2>&1; }
die()      { echo "Error: $*" >&2; exit 1; }

# Run a command with sudo if available, otherwise plain (e.g. inside containers
# already running as root).
maybe_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif has_cmd sudo; then
    sudo "$@"
  else
    echo "Warning: need root for: $* (no sudo found); skipping." >&2
    return 1
  fi
}

ensure_system_packages() {
  echo "==> System packages (curl, git, python3, python3-venv)"

  if has_cmd apt-get; then
    if ! maybe_sudo apt-get update; then
      echo "Warning: apt-get update failed; continuing." >&2
      FAILED_STEPS+=("apt-get update")
    fi
    if ! maybe_sudo apt-get install -y curl git ca-certificates python3 python3-venv python3-pip; then
      echo "Warning: apt-get install of base packages failed." >&2
      FAILED_STEPS+=("Install base packages via apt-get")
    fi
  elif has_cmd dnf; then
    maybe_sudo dnf install -y curl git ca-certificates python3 python3-virtualenv python3-pip \
      || FAILED_STEPS+=("Install base packages via dnf")
  elif has_cmd pacman; then
    maybe_sudo pacman -Sy --noconfirm curl git ca-certificates python python-pip \
      || FAILED_STEPS+=("Install base packages via pacman")
  else
    echo "Warning: no supported package manager (apt-get/dnf/pacman) found." >&2
    echo "         Make sure curl, git and python3 (with venv) are installed manually." >&2
    FAILED_STEPS+=("System package install (unsupported package manager)")
  fi
}

load_nvm() {
  declare -F nvm >/dev/null 2>&1 && return 0
  local nvm_sh
  for nvm_sh in \
      "${NVM_DIR:-$HOME/.nvm}/nvm.sh" \
      "/usr/local/nvm/nvm.sh"; do
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
      echo "         On Debian/Ubuntu install the python3-venv package and retry." >&2
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
  [[ "$(uname -s)" == "Linux" ]] || die "This script is for Linux only."

  # ── 0. System packages ─────────────────────────────────────────────────────
  ensure_system_packages

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

  # ── 6. Launch free-code ────────────────────────────────────────────────────
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
