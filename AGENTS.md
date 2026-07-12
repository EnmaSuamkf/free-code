# free-code monorepo — development rules

Rules for **this repository only**. When working here, also follow [packages/coding-agent/AGENTS.md](packages/coding-agent/AGENTS.md) (default agent behavior shipped with free-code for any project).

## First Message

If the user did not give you a concrete task in their first message,
read README.md, then ask which module(s) to work on. Based on the answer, read the relevant README.md files in parallel.

- packages/ai/README.md
- packages/tui/README.md
- packages/agent/README.md
- packages/coding-agent/README.md
- packages/mom/README.md
- packages/pods/README.md
- packages/web-ui/README.md

## Code Quality (free-code)

- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Base keybindings live in `TUI_KEYBINDINGS` in `packages/tui/src/keybindings.ts` (add new entries there via the `Keybindings` interface declaration merging). Extensions register their own hotkeys at runtime with `pi.registerShortcut(shortcut, { description, handler })` (`packages/coding-agent/src/core/extensions/types.ts`) — never invent `DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS` constants, they do not exist.

## Registering Commands and Subcommands

Slash commands are registered **once** in `packages/coding-agent/default-extensions/*.ts` via `pi.registerCommand()`. That core is shared by every environment (CLI, VS Code plugin, macOS bridge), so a command registered there is available everywhere automatically. Only **hotkeys** and **VS Code command-palette entries** need per-environment wiring.

### The environments

| Environment | Where it lives | What you may need to register there |
| --- | --- | --- |
| **CLI / TUI** | `packages/coding-agent/default-extensions/*.ts` | `pi.registerCommand()` for the slash command; `pi.registerShortcut()` for a hotkey. Update `SUBCOMMANDS` / `KB_SUBCOMMANDS` arrays, `switch` cases, the `description` string, and any usage-text `notify()` calls. |
| **VS Code / Cursor plugin** | `packages/vscode-free-code` + `packages/free-desktop-host/src/activate-vscode.mjs` | Slash commands are inherited from the core. Add a **command-palette** entry in `activate-vscode.mjs` (`vscode.commands.registerCommand`) and, if you want a hotkey, a `keybindings.json` contribution. |
| **macOS desktop** | `packages/free-desktop-host/src/stdio-mac.mjs` (an stdio bridge that reuses the coding-agent core) | Slash commands are inherited from the core. No separate `FreeCodeMac` package exists; do not look for one. |
| **web-ui** | `packages/web-ui` | Slash commands are inherited from the core. For purely web features (e.g. `getDisplayMedia`, Web Speech) add the web-specific wiring here. |

### Checklist for every new command or subcommand

- [ ] `packages/coding-agent/default-extensions/<manager>.ts` — add to `SUBCOMMANDS` array, add `case` in switch, update description string and all usage `notify()` calls
- [ ] If the command needs a hotkey: `pi.registerShortcut()` in the extension; and a VS Code `keybindings.json` contribution if it should work in the plugin
- [ ] If the command should appear in the VS Code command palette: add a `vscode.commands.registerCommand` entry in `packages/free-desktop-host/src/activate-vscode.mjs`
- [ ] Run `npm run build` in the affected package and verify no TypeScript errors
- [ ] Update root `AGENTS.md` or `packages/coding-agent/AGENTS.md` if the command introduces a new workflow pattern agents should follow

---

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Only run specific tests if user instructs: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Run tests from the package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.

## Testing free-code Interactive Mode with tmux

To test free-code's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s free-code-test -x 80 -y 24

# Start free-code from source (see repo README: ./pi-test.sh, CLI name: free-code)
tmux send-keys -t free-code-test "cd /path/to/free-code && ./pi-test.sh" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t free-code-test -p

# Send input
tmux send-keys -t free-code-test "your prompt here" Enter

# Send special keys
tmux send-keys -t free-code-test Escape
tmux send-keys -t free-code-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t free-code-test
```

---

## GitHub Issues

When reading issues:

- Always read all comments on the issue
- Use this command to get everything in one call:
  ```bash
  gh issue view <number> --json title,body,comments,labels,state
  ```

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown directly via `--body` in shell commands
- Preview the exact comment text before posting
- Post exactly one final comment unless the user explicitly asks for multiple comments
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## OSS Weekend

- If the user says `enable OSS weekend mode until X`, run `node scripts/oss-weekend.mjs --mode=close --end-date=YYYY-MM-DD --git` with the requested end date
- If the user says `end OSS weekend mode`, run `node scripts/oss-weekend.mjs --mode=open --git`
- The script updates `README.md`, `packages/coding-agent/README.md`, and `.github/oss-weekend.json`
- With `--git`, the script stages only those OSS weekend files, commits them, and pushes them
- During OSS weekend, `.github/workflows/oss-weekend-issues.yml` auto-closes new issues from non-maintainers, and `.github/workflows/pr-gate.yml` auto-closes PRs from approved non-maintainers with the weekend message

## Tools

- GitHub CLI for issues/PRs
- Add package labels to issues/PRs: pkg:agent, pkg:ai, pkg:coding-agent, pkg:mom, pkg:pods, pkg:tui, pkg:web-ui

---

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

---

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider option types that should remain available from the root entry
- Register the provider in `packages/ai/src/providers/register-builtins.ts` via lazy loader wrappers, do not statically import provider implementation modules there
- Add credential detection in `packages/ai/src/env-api-keys.ts`

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)

Add provider to: `stream.test.ts`, `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to `DEFAULT_MODELS`
- `src/cli/args.ts`: Add env var documentation
- `README.md`: Add provider setup instructions

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`
