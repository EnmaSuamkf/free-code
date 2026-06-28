---
name: handler_storybook_url
description: 'Handles Storybook URLs (path=/story). When opening/navigating: open as-is. When taking a screenshot: temporarily add full=1, take the screenshot, then navigate back to the original URL (without full=1). Spanish triggers: captura de storybook, screenshot de storybook, abrir Storybook, URL de Storybook, navegar a storybook.'
---

# Handler Storybook URL

## Invocation Rules (CRITICAL)

**This skill MUST be applied automatically — no explicit user mention required.**

- **Trigger**: ANY user message that contains a URL with `path=/story`
- **If the intent is to open / navigate**: open the URL **as-is**, do NOT add `full=1`
- **If the intent is to take a screenshot**: follow the screenshot workflow below
- **If URL does NOT contain `path=/story`**: skip this skill entirely

---

## Screenshot workflow (the only case where `full=1` is used)

When the user asks to **take a screenshot** of a Storybook component or page — even without providing an explicit URL (e.g. "make a screenshot of this storybook component"):

1. **Resolve the current URL**: if no URL was given, use `agent_browser eval --stdin` with `return location.href` to get the current page URL.
2. **Check it is a Storybook URL**: if the resolved URL contains `path=/story`, proceed. Otherwise skip this skill.
3. **Build the full=1 URL**: append `&full=1` (or `?full=1` if no `?` exists yet) to the resolved URL.
4. **Navigate** to the `full=1` URL with `agent_browser open`.
5. **Take the screenshot** with `agent_browser screenshot`.
6. **Restore**: navigate back to the original URL (without `full=1`) with `agent_browser open`.
7. Save / report the screenshot as requested.

### Pseudocode

```
# Step 1 — resolve URL
if user provided a URL:
  originalUrl = that URL
else:
  originalUrl = result of: agent_browser eval --stdin  (stdin: "return location.href")

# Step 2 — guard
if originalUrl does not contain "path=/story":
  skip this skill

# Steps 3-6
screenshotUrl = append full=1 to originalUrl

agent_browser open screenshotUrl
agent_browser screenshot [--path ...]
agent_browser open originalUrl                  # restore — remove full=1
```

---

## Eval workflow (inspecting the story canvas)

When the user asks to **inspect, extract content, or run JavaScript** against a Storybook component/page (e.g. "check the DOM of this storybook component", "get the text of this story"):

1. **Resolve the current URL** the same way as the screenshot workflow (use `agent_browser eval --stdin` with `return location.href` if no URL is given).
2. **Check it is a Storybook URL**: must contain `path=/story`.
3. **Navigate** to the `full=1` URL with `agent_browser open`.
4. **Run the eval** with `agent_browser eval --stdin`.
5. **Restore**: navigate back to the original URL (without `full=1`) with `agent_browser open`.

### Pseudocode

```
originalUrl   = given URL or result of: agent_browser eval --stdin  (stdin: "return location.href")

if originalUrl does not contain "path=/story":
  skip this skill

screenshotUrl = append full=1 to originalUrl

agent_browser open screenshotUrl
agent_browser eval --stdin  (stdin: <user eval expression>)
agent_browser open originalUrl                  # restore — remove full=1
```

> **Why**: without `full=1` the Storybook shell (sidebar, toolbar, wrapping iframes) is present in the DOM and can contaminate eval results that target the story canvas.

---

## Opening / navigating (normal case)

When the intent is only to open or navigate to a Storybook URL, do **not** add `full=1`. Open the URL exactly as provided.

---

## Detection (Storybook URL)

Treat a string as a Storybook story URL when it contains the substring **`path=/story`** (literal, case-sensitive).

Examples that match:
- `https://host.example/?path=/story/foo--bar`
- `http://localhost:6006/?path=/story/components-button--primary&args=...`

Examples that do **not** match:
- URLs without `path=/story`
- `path=/docs/...` only

---

## Adding full=1

1. If the URL already contains `full=1`, do not duplicate it.
2. If the URL already has `?`, append `&full=1`.
3. If the URL has no `?`, append `?full=1`.
4. If the URL has a `#` fragment, insert before `#`.

---

## Removing full=1 (restore step)

Strip `full=1` (and its leading `&` or `?`) from the URL to restore the original form:
- `?full=1&rest` → `?rest`
- `?full=1` → remove `?` entirely (or keep bare base URL)
- `&full=1` → remove `&full=1`

---

## Response style

When outputting URLs, show the final URL once. Do not strip existing `args=` or other Storybook query keys.
