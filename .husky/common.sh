# Sourced by husky hooks. GUI Git clients often run hooks with a minimal PATH
# (no Homebrew / nvm / fnm), so `npm` is missing unless we fix the environment.

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# asdf
if [ -f "${HOME}/.asdf/asdf.sh" ]; then
	# shellcheck source=/dev/null
	. "${HOME}/.asdf/asdf.sh"
fi

# nvm
export NVM_DIR="${HOME}/.nvm"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
	# shellcheck source=/dev/null
	. "${NVM_DIR}/nvm.sh"
fi

# fnm (when installed but not on default PATH)
if command -v fnm >/dev/null 2>&1; then
	eval "$(fnm env)"
fi
