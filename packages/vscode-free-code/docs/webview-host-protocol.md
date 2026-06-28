# WebView host protocol (VS Code extension and macOS app)

The chat UI in `media/chat.js` talks to the host via `acquireVsCodeApi().postMessage` (VS Code) or the same message shapes over the macOS bridge (see `apps/free-code-macos`).

## WebView to host (`postMessage` payload `type`)

| `type` | Fields | Purpose |
|--------|--------|---------|
| `webview_ready` | — | Host sends initial `set_tabs`, `restore_history`, indicators, slash catalog. |
| `prompt` | `text`, `attachments?` | Send user message to RPC agent. |
| `abort` | — | Abort current turn / RPC. |
| `open_agent_browser` | `url`, `instruction` | Headed browser flow. |
| `launch_chrome_debug` | — | Chrome remote debugging attach prompt. |
| `export_conversation` | — | Export markdown. |
| `request_slash_commands` | — | Refresh slash menu from RPC + builtins. |
| `new_tab` | — | New conversation tab. |
| `select_tab` | `tabId` | Switch tab. |
| `close_tab` | `tabId` | Close tab. |
| `open_file` | `path` | Open file (IDE or system default on Mac). |
| `drop_request` | — | Native file picker; host replies with `insert_paths`. |
| `workspace_indicator_click` | — | Workspace / folder UX. |
| `tool_picker_apply` | `enabledGroupKeys` | Apply tool group selection. |
| `tool_picker_cancel` | — | Close tool picker. |
| `skill_picker_apply` | `enabledSkillNames` | Apply skill selection. |
| `skill_picker_cancel` | — | Close skill picker. |
| `model_picker_apply` | `provider`, `modelId` | Set model. |
| `model_picker_cancel` | — | Close model picker. |
| `open_model` | — | Open model picker flow. |
| `questionnaire_response` | `requestId`, `answers` / `cancelled` | Answer agent questionnaire. |

## Host to WebView (`postMessage` / `MessageEvent` payload `type`)

Includes: `set_tabs`, `restore_history`, `busy`, `status`, `error`, `hint`, `insert_paths`, `abort_undo`, streaming deltas (`message_update`, etc. per RPC), `questionnaire_request`, picker open/close payloads, `tool_picker_*`, `model_picker_*`, `skill_picker_*`, and others emitted by [`src/extension.js`](../src/extension.js) via `postToWebview`.

## stdio framing (macOS Node host)

One JSON object per line on stdout/stdin:

- `{ "dir": "host_to_webview", "payload": { ... } }` — inject as `MessageEvent` in WKWebView.
- `{ "dir": "webview_to_host", "payload": { ... } }` — from Swift after a `freeCodeBridge` message.
- `{ "dir": "host_to_native", "payload": { "type": "open_panel", ... } }` — Swift handles NSOpenPanel / NSWorkspace.
- `{ "dir": "native_to_host", "payload": { ... } }` — Swift response to a pending native request.

Init line (Swift → host on startup):

- `{ "dir": "init", "payload": { "workspaceRoot", "mediaRoot", "settings" } }`
