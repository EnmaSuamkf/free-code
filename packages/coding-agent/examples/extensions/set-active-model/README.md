# set-active-model extension

Registers **`set_active_model`** and **`get_active_model`**. The LLM can change the active model in natural language (for example "change the model to gemini-2.5-pro [google-vertex]" or "cambia el modelo a claude-sonnet-4-5"). **`get_active_model`** takes no arguments and returns the current session model (`provider`, `modelId`, name)—use it before a temporary switch so you can restore the same model afterward. Pairs with the existing `/model` slash command and the model picker — both stay available; the tools are the path the LLM uses.

Without this extension the LLM has no capability to change the model itself, so it will reply things like "I cannot change the model. My capabilities do not include switching between different models." With this extension installed, the LLM calls `set_active_model(provider, modelId)`; the agent validates the pair against the available-models list (only models with configured auth) and switches the session model.

## Semantics

- The change takes effect on the **next user turn**. The current turn always finishes with the previous model, because `session.setModel` swaps the model used for subsequent calls (see [`packages/coding-agent/src/core/agent-session.ts`](../../../src/core/agent-session.ts)). The tool result text says so explicitly, so the LLM does not claim the already-streaming reply comes from the new model.
- Validation mirrors the picker: only models with configured auth (API key, OAuth, Vertex ADC, etc.) are accepted. Unknown ids, wrong provider/id pairs and providers without auth produce a tool error with a hint, which the LLM relays to the user.
- Works in CLI / TUI / RPC (VSCode plugin) the same way: it is just a tool. In the VSCode plugin the model indicator next to the chat input toolbar refreshes automatically when the tool succeeds (the plugin listens for `tool_execution_end` with this tool's name).

## Install

Copy or symlink the folder into your global extensions directory:

```bash
# Copy
cp -R packages/coding-agent/examples/extensions/set-active-model ~/.free-code/agent/extensions/

# or symlink (auto-tracks repo updates)
ln -s "$(pwd)/packages/coding-agent/examples/extensions/set-active-model" \
      ~/.free-code/agent/extensions/set-active-model
```

The agent auto-discovers any extension folder with an `index.ts` (or `index.js`) under `~/.free-code/agent/extensions/` (see [`packages/coding-agent/src/core/extensions/loader.ts`](../../../src/core/extensions/loader.ts)). No `npm install` is needed; the loader resolves `@free/pi-coding-agent` and `@sinclair/typebox` against the agent's bundled deps.

If you prefer a project-local install (only loaded when running the agent inside that repo), copy the folder to `<repo>/.free-code/agent/extensions/` instead.

## Verify

Open a chat session (TUI, plugin, or RPC):

```
/tools
```

You should see `set_active_model` and `get_active_model` listed under an extension group. Then prompt the agent:

```
change the model to gemini-2.5-pro [google-vertex]
```

Expected: a `set_active_model` tool call with the matching arguments, a successful tool result mentioning "Takes effect from the next user turn", and the model indicator (in the VSCode plugin) updates immediately. The next prompt you send is served by the new model.

## Caveats

- Not loaded when the agent runs with `--no-extensions`. The VSCode plugin runs without that flag by default; make sure **Free Code: No extensions** stays off in settings.
- The current turn finishes with the previous model. If you need an instant switch mid-turn, send Escape to abort and re-prompt; the queued prompt will use the new model.
- The LLM might mis-call this tool (false positive) if the user mentions a model name in a non-switching context. Tool description is intentionally strict ("ONLY when the user EXPLICITLY asks…") to mitigate this; if it still happens, use the `/model` slash command for direct control.
