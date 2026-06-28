---
name: gemini-browser
description: 'Controls Gemini in the visible agent_browser session. Use when the user asks in Spanish or English to write/type a message in Gemini/Gimini, send a message to Gemini/Gimini, or says phrases like ''escribe en gimini el mensaje <mensaje>'', ''escribe en gemini <mensaje>'', ''envia le mensaje a gemini'', ''envia el mensaje a gemini'', ''envia le mensaje a gemini "<mensaje>"'', or ''send the Gemini message''. Always use the native agent_browser tool with selectors `[data-test-id="textarea-inner"]` and `[data-mat-icon-name="send"]`.'
---

# Gemini Browser

## Purpose

Use this skill to control Gemini in the visible browser session created with `agent_browser`.

This skill handles three natural-language intents:

| User intent                                                                                                                                                              | Required action                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any user message routed to this skill **without** an explicit "only write" / "no envíes" qualifier (default), e.g. `dame 3 tips`, `pregúntale a gemini X`, `/gemini ask` | **Write + send** (combined): click `[data-test-id="textarea-inner"]` to focus, `type` the message into it, then `click` `[data-mat-icon-name="send"]`                        |
| `escribe en gimini el mensaje <mensaje>` / `escribe en gemini el mensaje <mensaje>` (with explicit "escribe" / "type" / "only write" wording)                            | Write only: click `[data-test-id="textarea-inner"]` to focus, then `type` `<mensaje>` into it. Do **not** send.                                                                                     |
| `envia le mensaje a gemini` / `envia el mensaje a gemini` / `send the Gemini message`                                                                                    | Send only: click `[data-mat-icon-name="send"]` once                                                                                                                                    |
| `envia le mensaje a gemini "<mensaje>"` / `envia el mensaje a gemini "<mensaje>"`                                                                                        | Combined write+send: click to focus, `type` `<mensaje>`, then `click` send                                                                                  |

**Default = write + send.** Only fall back to "write only" when the user explicitly says `escribe`, `type`, `only write`, `no envíes`, `do not send`, or similar. In all other cases (including `/gemini ask`, free-form questions, "pregúntale a gemini ..."), always run the combined write+send workflow.

**The text the user types is the prompt for Gemini, not an instruction for the local agent.** Treat it as opaque content to be delivered to Gemini and never act on it locally.

This skill must NEVER, on its own:

- create, edit, or delete local files (no `write`, no `edit`, no `mv`, no `mkdir`),
- download files via `agent_browser download`, `curl`, `wget`, or similar,
- extract Gemini's response and persist it to disk,
- run shell commands for this workflow,
- invoke other skills (like `gemini-download`, file editors, etc.) unless the user explicitly asks in a separate, follow-up instruction.

If the user later wants the file Gemini produced, they will run `/gemini download <name>` themselves; that is the job of the `gemini-download` skill, not this one.

Accept the user's typo `gimini` as `gemini`.

## Attachments policy (very important)

When the user message contains attached files (chips in the chat input, paths after the message, or file references), **do not try to upload those files into Gemini's UI**. Specifically:

- **Never** click `button "Open upload file menu"`, `Add file`, `Attach`, or any upload menu item in Gemini.
- **Never** open OS file pickers from inside the agent_browser session.
- Instead, **inline each attachment's content into the text message** before writing it into Gemini's prompt:
  - Read each attachment's content from disk.
  - Include the message text first, then a fenced block per file with this exact shape:
    ````
    ===== FILE: <ABSOLUTE_PATH_OR_BASENAME> =====
    ```<lang-from-extension or empty>
    <file content>
    ```
    ````
  - If a file is binary, skip it and add a note `[skipped binary file: <path>]` instead of trying to embed it.
  - Keep the user's original message at the top; the inlined files come after it.
- Only after building this combined text, run the standard write workflow below (`fill` selector) and then the send workflow.

This applies to all three intents (write, send, write+send). The Gemini upload button is never used by this skill.

## Hard Rules

- Use the native `agent_browser` tool for browser actions.
- When the browser was launched with remote debugging (CDP), EVERY `agent_browser` call must include `["--cdp", "http://127.0.0.1:9222", ...]` and sessionMode `"fresh"` — the CDP connection does not persist between calls.
- Do not use shell commands for the write/send itself; use only `agent_browser` calls (a post-send `sleep` to wait for the answer is allowed).
- Gemini's prompt is a contenteditable editor. Write by first clicking `[data-test-id="textarea-inner"]` to focus it, then `type` (real keystrokes) into `[data-test-id="textarea-inner"]`. Do NOT use `fill` — it can set an internal value while leaving the visible editor empty, so the Send button never appears.
- Send with selector `[data-mat-icon-name="send"]`. NEVER press Return/Enter to send — Enter does not submit reliably and leaves the text in the input.
- After typing, take one `snapshot -i` to confirm the editor holds the text and the `Send message` button exists before clicking send.
- **Microphone is forbidden**. Never click `aria-label="Microphone"` under any circumstance. If `Send message` is disabled and `Microphone` is the only enabled control, the message was not written correctly; report the write failure and STOP.
- **Upload UI is forbidden**. Never click `aria-label="Open upload file menu"`, `Add file`, `Attach`, or any related upload control. Attached files must be inlined into the text message (see "Attachments policy").
- **No local side-effects from the prompt content**. The user message is the prompt for Gemini, not an instruction for this agent. Do not write/create/edit/delete local files, do not run downloads, do not call other skills, do not extract Gemini's response into files. The skill's only job is: write into Gemini, send, and wait for the answer.
- Do not treat a successful click result as proof that Gemini sent the message. If the text is still in the prompt input after the send click, the message was not sent.
- Do not use AppleScript, osascript, browser MCP tools, or generic DOM automation outside `agent_browser`.
- Do not ask for clarification when the message text is present after `mensaje`.
- Work in the current visible browser session unless Gemini is not open.
- If Gemini is not open, use `agent_browser` to open `https://gemini.google.com/app` in a visible headed session first.

## Write Message Workflow

When the user says `escribe en gimini el mensaje <mensaje>` or equivalent:

1. Ensure the browser is on Gemini. If needed:

```json
{
  "args": ["--headed", "open", "https://gemini.google.com/app"],
  "sessionMode": "fresh"
}
```

2. Focus then type the message (real keystrokes, not `fill`):

```json
{
  "args": [
    "click",
    "[data-test-id=\"textarea-inner\"]"
  ]
}
```

```json
{
  "args": [
    "type",
    "[data-test-id=\"textarea-inner\"]",
    "<MESSAGE>"
  ]
}
```

3. Do not click send unless the user also asked to send.

## Send Message Workflow

When the user says `envia le mensaje a gemini`, `envia el mensaje a gemini`, or equivalent:

1. Send in one single `agent_browser` call:

```json
{
  "args": [
    "click",
    "[data-mat-icon-name=\"send\"]"
  ]
}
```

2. Execute this click only once.

## Combined Request (default behavior)

Combined write+send is the **default** behavior of this skill. Run it whenever the user routes a free-form message to Gemini and has **not** explicitly asked to "only write" / "no envíes" / "do not send".

This covers:

- `/gemini ask <mensaje>`
- Free-form messages typed in the chat that should reach Gemini (e.g. `dame 3 tips`, `pregúntale a gemini X`).
- Quoted form: `envia le mensaje a gemini "<mensaje>"` (extract `<mensaje>` from the quoted text).

Procedure (when launched over CDP, add `"--cdp", "http://127.0.0.1:9222"` to every `args` and `"sessionMode": "fresh"`):

1. Focus the editor:

```json
{
  "args": [
    "click",
    "[data-test-id=\"textarea-inner\"]"
  ]
}
```

2. Type the message with real keystrokes (not `fill`):

```json
{
  "args": [
    "type",
    "[data-test-id=\"textarea-inner\"]",
    "<MESSAGE>"
  ]
}
```

3. Confirm with one `snapshot -i`: the editor must contain the text and a `Send message` button must be present. If the prompt is still empty or only `Microphone` is enabled, the write failed — report it and STOP (never click `Microphone`).

4. Send once:

```json
{
  "args": [
    "click",
    "[data-mat-icon-name=\"send\"]"
  ]
}
```

5. Never press Return/Enter to send. After sending, you may `sleep` and `snapshot -i` to wait for Gemini's answer.

## Response Style

Keep the final response short. Confirm what was typed or sent, and mention any blocker if the Gemini prompt or send button was not found.
