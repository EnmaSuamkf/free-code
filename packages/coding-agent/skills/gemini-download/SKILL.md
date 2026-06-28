---
name: gemini-download
description: 'Download a file Gemini produced in the chat (markdown, code, plaintext, etc.) using agent_browser only. Use when the user asks to download, save, or export an attachment, generated file, or code block from Gemini/Gimini in the visible browser session (e.g. ''descarga el .md de gemini'', ''baja el archivo que generó gimini'', ''download the file from Gemini'', ''/gemini download <name>'').'
---

# Gemini Download (agent_browser, two paths)

## Purpose

Download what Gemini produced in the latest assistant message. Two cases:

- **Path A — Attachment chip**: Gemini attached a file as a chip (e.g. `generic "tips_gemini MD" clickable`). Open the viewer, get the filename + Download ref from the viewer.
- **Path B — Code block**: Gemini emitted an inline code block (e.g. `Plaintext`, `Markdown`, `JavaScript`) with a `Download code` button. Use that button directly. Filename comes from the user-passed argument of `/gemini download <name>`.

Both paths converge to: single `agent_browser download` attempt → single `click` fallback → verify + rename UUID → STOP.

## Default destination

`<DEST_DIR>` MUST be an **absolute path**. Do NOT pass a tilde or `~` to `agent_browser`; CDP-controlled Chrome will treat `~` as a literal directory under the current working directory and the file will end up in `<cwd>/~/Downloads/...`.

- Default: the **expanded** absolute Downloads path of the current user, e.g. `/Users/<your-username>/Downloads`.
- Resolve `<your-username>` from `$HOME` or the `whoami` of the running shell before constructing the path.
- Never write `~/Downloads/...` in the `agent_browser download` arguments.

## Hard rules

- **Never** restart the workflow. After Step 7 finishes, do **NOT** call `agent_browser download` or `click` again.
- **Single attempt per run**:
  - max **1** `agent_browser download` call,
  - max **1** click fallback,
  - then verify + rename + STOP.
- If `agent_browser download` aborts/errors, do **NOT** retry it. Go straight to the click fallback (once), then verify+rename.
- **Always** pass an **absolute, tilde-expanded path** to `agent_browser download` (e.g. `/Users/<you>/Downloads/<file>`). Never `~/Downloads/...`.
- Save with absolute path. If the saved file is UUID-named, rename it to the original/intended filename in the same directory.
- Never mutate DOM (no temporary `setAttribute('aria-label', ...)`).
- This skill covers **download only**. Use `gemini-browser` for write/send.

## Workflow (do exactly this, in order)

### Step 1 — Scroll to the end of the chat

```text
agent_browser(args=["eval", "--stdin"])
```

stdin:

```javascript
(() => {
  const sels = ['infinite-scroller', 'main', '.conversation-container', 'body'];
  let el = sels.map(s => document.querySelector(s)).find(Boolean)
    || document.scrollingElement
    || document.documentElement;
  el.scrollTop = el.scrollHeight;
  return {
    tag: el.tagName,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 8,
  };
})();
```

### Step 2 — Snapshot the chat and decide path

```text
agent_browser(args=["snapshot", "-i"])
```

Look in the latest assistant message:

- **Path A (preferred)**: there is a clickable file chip such as
  - `generic "<NAME> MD" [ref=eN] clickable`
  - `generic "<NAME> TXT" [ref=eN] clickable`
  - `generic "<NAME>.md" [ref=eN] clickable`
  Record `CHIP_REF`. Go to **Step 3A**.

- **Path B**: there is no chip, but there is a code block with a download control:
  - `button "Download code" [ref=eN]`
  Record `CODE_DOWNLOAD_REF`. Go to **Step 3B**.

If neither exists, **STOP** and report what was visible.

### Step 3A — Open the viewer (chip path)

```text
agent_browser(args=["click", "@CHIP_REF"])
```

### Step 4A — Snapshot the viewer and capture name + ref

```text
agent_browser(args=["snapshot", "-i"])
```

Expected:

```text
- dialog "Showing viewer."
  - document "Displaying <ORIGINAL_FILENAME>" [ref=...]
  - button "Download" [ref=eN]
```

Record:

- `ORIGINAL_FILENAME` (e.g. `tips_gemini.md`)
- `DOWNLOAD_REF` (the `button "Download"` ref)

If the viewer did not open, **STOP** and report. Do not retry.

### Step 3B / 4B — Code block path

No viewer. Use what you already have:

- `DOWNLOAD_REF = CODE_DOWNLOAD_REF` (the `button "Download code"` ref).
- `ORIGINAL_FILENAME` is the **target filename** the user passed to `/gemini download <name>`.
  - If `<name>` has no extension, infer one from the code block language label visible in the message (e.g. `Plaintext` → `.txt`, `Markdown` → `.md`, `JavaScript` → `.js`, `Python` → `.py`, `JSON` → `.json`, `CSV` → `.csv`, `TypeScript` → `.ts`). Default to `.txt` if unknown.
  - Examples:
    - `/gemini download Plaintext` + label `Plaintext` → `Plaintext.txt`
    - `/gemini download notes` + label `Markdown` → `notes.md`

### Step 5 — Single download attempt

Resolve `<DEST_DIR>` to an **absolute** path (no tilde). Default: `${HOME}/Downloads` expanded, for example `/Users/<your-username>/Downloads`.

Try exactly **once**:

```text
agent_browser(args=["download", "@DOWNLOAD_REF", "<ABSOLUTE_DEST_DIR>/<ORIGINAL_FILENAME>"])
```

Example (DO):

```text
agent_browser(args=["download", "@e7", "/Users/pablo.castaneda/Downloads/tips_gemini.md"])
```

Example (DO NOT — Chrome+CDP will create a literal `~` folder under the cwd):

```text
agent_browser(args=["download", "@e7", "~/Downloads/tips_gemini.md"])
```

Outcomes:

- **Success**: skip to Step 7.
- **Aborted / error / no file written**: continue to Step 6 (single click fallback).

Do **not** retry `agent_browser download` after this.

### Step 6 — Single click fallback (only if Step 5 failed)

```text
agent_browser(args=["click", "@DOWNLOAD_REF"])
```

Then wait briefly (~2s). Continue to Step 7. Do **not** click again.

### Step 7 — Verify, rename if needed, STOP

Use the **absolute** `<ABSOLUTE_DEST_DIR>` from Step 5 (default `${HOME}/Downloads`).

1. List `<ABSOLUTE_DEST_DIR>` and find candidates written in the last ~60s:
   - exact match `<ORIGINAL_FILENAME>`, or
   - UUID-like names: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, or `^[0-9a-f-]{32,}$`.
2. If `<ABSOLUTE_DEST_DIR>/<ORIGINAL_FILENAME>` already exists, you are done.
3. Else, take the most recent UUID-named file (by mtime) and rename it to `<ORIGINAL_FILENAME>` in `<ABSOLUTE_DEST_DIR>`.
4. Delete older UUID duplicates from this turn, if any.
5. Also check the agent's current working directory for an accidental literal `~/Downloads/` folder (created when a tilde-style path leaked through). If present, move the most recent UUID file from there into `<ABSOLUTE_DEST_DIR>/<ORIGINAL_FILENAME>` and delete the stray `<cwd>/~` directory.
6. Final state: a single file at `<ABSOLUTE_DEST_DIR>/<ORIGINAL_FILENAME>` with the expected content.

**Hard stop**:

- After Step 7 finishes, do **NOT** call `agent_browser download` or `click` again.
- If verification fails, report what was found in `<ABSOLUTE_DEST_DIR>` and STOP. Never loop.

## Reporting

- Final response: confirm the saved path (`<DEST_DIR>/<ORIGINAL_FILENAME>`), which path was used (chip or code-block), and whether it required the click+rename fallback.
- Never say "the file is downloaded" if Step 7 did not find a non-UUID file with content.
