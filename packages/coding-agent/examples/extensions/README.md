# Pi Coding Agent - Extension Examples

This directory contains a wide variety of example extensions for the `pi` coding agent. These examples serve as a reference for building your own extensions and demonstrate the capabilities of the extension API.

## How to Use

To use an extension, load it with the `-e` or `--extension` flag when starting `pi`:

```bash
pi -e extensions/theme-cycler.ts
```

You can load multiple extensions by repeating the flag:

```bash
pi -e extensions/system-select.ts -e extensions/minimal.ts
```

## By token consumption

Extensions are grouped by **typical LLM token footprint** (low / medium / high). This is a rule of thumb: actual cost depends on the model, the size of your rules, and how you use each tool.

| Level | What it usually means |
| ----- | --------------------- |
| **Low** | No extra model calls from the extension itself; or only UI / local flows / one-off prompts without steadily inflating the system prompt. |
| **Medium** | More text in context, occasional model calls (summarize, custom compaction, handoff), or tools that trigger another model/API step when used. |
| **High** | Multiple agents or subagents, chained turns, or large, persistent instruction injection on every request. |

File names appear in backticks; descriptions are in English like the rest of this tree.

### Low token consumption

**UI & appearance** — TUI and themes; generally no model tokens consumed by the extension itself.

- **`custom-header.ts` / `custom-footer.ts`**: Replace the default TUI header or footer with custom components.
- **`minimal-mode.ts`**: A theme that provides a more compact, minimal rendering for tool calls and results.
- **`mac-system-theme.ts`**: Syncs the `pi` light/dark theme with the macOS system appearance.
- **`message-renderer.ts`**: Demonstrates custom rendering for different types of messages in the chat history.
- **`pure-focus.ts`**: A distraction-free mode that removes all UI elements except for the core conversation.
- **`rainbow-editor.ts`**: A visual effect that renders the word "ultrathink" with an animated rainbow shine.
- **`status-line.ts`**: Shows the current agent turn status in the footer.
- **`theme-cycler.ts` / `theme-toggle.ts`**: Add commands and shortcuts to cycle through or toggle color themes.
- **`titlebar-spinner.ts`**: Displays a spinner animation in the terminal's title bar while the agent is thinking.
- **`widget-placement.ts`**: Demonstrates how to place custom UI widgets in various locations on the screen.
- **`session-name.ts`**: Allows you to name your session for easier identification.
- **`hidden-thinking-label.ts`**: Customizes the text shown for collapsed "thinking" blocks.
- **`built-in-tool-renderer.ts`**: Overrides the display of built-in tools for a more compact view.

**Games** — Play does not use the LLM.

- **`snake.ts`**: The classic Snake game, playable with the `/snake` command.
- **`space-invaders.ts`**: The classic Space Invaders game, playable with `/invaders`.

**Tools & commands** — Tools and slash commands that do not, by themselves, add another full model pass.

- **`bookmark.ts`**: Adds a `/bookmark` command to label important messages for easy navigation.
- **`commands.ts`**: Adds a `/commands` command to list all available slash commands.
- **`hello.ts`**: A minimal "Hello, World" tool to demonstrate basic custom tool creation.
- **`dynamic-tools.ts`**: Shows how to register new tools dynamically at runtime.
- **`inline-bash.ts`**: Allows executing shell commands inline within a prompt by wrapping them in `!{...}`.
- **`interactive-shell.ts`**: Enables running interactive shell commands (e.g., `vim`, `htop`) from `pi`.
- **`question.ts` / `questionnaire.ts`**: Tools that allow the agent to ask the user single or multiple-choice questions.
- **`resource-picker.ts`**: Registers `/pick-tools`, `/pick-skill`, and `/pick-agent` so you can toggle optional tool groups, skills, and agent catalog entries during a session (bundled copy is aligned with startup `/profile` selection instead of automatic pickers).
- **`rpc-demo.ts`**: A technical demo that exercises every available UI method over RPC for testing purposes.
- **`send-user-message.ts`**: Demonstrates how an extension can programmatically send a message as the user.
- **`shutdown-command.ts`**: Adds a `/quit` command to cleanly exit the `pi` application.
- **`ssh.ts`**: A wrapper that allows core tools (`read`, `bash`, etc.) to be executed on a remote machine via SSH.
- **`todo.ts`**: A tool for managing a simple to-do list.
- **`tools.ts`**: Adds a `/tools` command to interactively enable or disable available tools.
- **`tool-override.ts`**: An example of how to override a built-in tool (`read`) to add custom logic like logging and access control.
- **`tool-counter.ts` / `tool-counter-widget.ts`**: Track and display the usage count for each tool.

**Lifecycle & session** — Hooks and utilities with no second model call by default.

- **`auto-commit-on-exit.ts`**: Automatically creates a `git commit` with the session's work upon exiting `pi`.
- **`event-bus.ts`**: Demonstrates the inter-extension event bus for communication between different extensions.
- **`file-trigger.ts`**: Triggers an action within `pi` when a specific external file is modified.
- **`git-checkpoint.ts`**: Creates a `git stash` checkpoint at each turn, allowing code state to be restored when navigating the session history.
- **`input-transform.ts`**: Intercepts and transforms user input before it's sent to the LLM (e.g., adding prefixes).
- **`provider-payload.ts`**: Logs the exact payload sent to the LLM provider (e.g., OpenAI, Anthropic) for debugging.
- **`reload-runtime.ts`**: Adds a command to hot-reload all extensions, skills, and themes without restarting.
- **`truncated-tool.ts`**: A reference implementation for a custom tool that correctly truncates large outputs.

**Control & discipline** — Rules and confirmations that typically do not spawn extra agents or load massive rule sets into the prompt.

- **`confirm-destructive.ts`**: Prompts the user for confirmation before performing destructive actions like clearing a session.
- **`dirty-repo-guard.ts`**: Prevents starting a new session if there are uncommitted changes in the current Git repository.
- **`permission-gate.ts`**: Prompts for user confirmation before executing potentially dangerous shell commands (e.g., `rm -rf`, `sudo`).
- **`protected-paths.ts`**: Blocks write/edit access to sensitive files and directories like `.env` or `.git`.

### Medium token consumption

Extra context, compaction/handoff, presets that load long instructions, or tools that invoke another model or API step depending on use.

- **`summarize.ts`**: Adds a `/summarize` command that uses an LLM to create a summary of the current conversation.
- **`qna.ts`**: A tool to extract questions from the agent's last response and prep them in the editor for the user to answer.
- **`antigravity-image-gen.ts`**: Adds a `generate_image` tool to create images from a text prompt directly in the terminal.
- **`custom-compaction.ts`**: Replaces the default conversation compaction strategy with a custom summarization routine.
- **`handoff.ts`**: Transfers the context of the current session to a new, clean session by generating a summary prompt.
- **`preset.ts`**: Allows defining and switching between named presets that configure the agent's model, tools, and system instructions.
- **`system-select.ts`**: Allows changing the agent's system prompt (personality) on the fly from a list of predefined "agent" files.
- **`purpose-gate.ts`**: Forces the user to declare a clear goal or "purpose" at the beginning of a session to keep the agent focused.
- **`tilldone.ts`**: A strict workflow discipline where the agent must define a task list *before* it can use other tools.
- **`damage-control.ts`**: A "firewall" for the agent; define rules in a YAML file to block dangerous commands or file access. Slash commands: `/damage-control` (toggle), `/damage-control on|off|status`.

### High token consumption

Multiple agents, parallel subagents, chained turns, or very large rules injected persistently into the system prompt.

- **`claude-rules.ts`**: Loads a set of rules from a `.claude/rules/` directory and injects them into the system prompt.
- **`cross-agent.ts`**: Allows loading and using commands and skills from other AI assistant configurations (e.g., from `.claude/`, `.gemini/`).
- **`agent-chain.ts`**: Orchestrates a sequence of agents where the output of one becomes the input for the next. Ideal for step-by-step workflows (e.g., plan -> code -> test).
- **`agent-team.ts`**: Creates a "dispatcher" agent that delegates tasks to a team of specialist agents, each with its own state and tools.
- **`subagent-widget.ts`**: Spawns sub-agents that run in the background, each with its own live-updating progress widget in the UI.
- **`pi-pi.ts`**: A meta-agent specialized in creating other `pi` extensions and agents. It uses a team of experts to research Pi's documentation and then writes the code.
