---
name: handler_compare_images
description: 'Compare images: call get_active_model first if available, set_active_model to github-copilot/gpt-5.4 only (exact id), compare, then restore with set_active_model. Triggers: comparar imágenes, capturas, diff visual. Use read() on workspace paths for pixels.'
---

# Handler compare images (GPT-5.4 Copilot)

## Purpose

When the user wants **visual comparison of images** (diff, layout, regressions, before/after), prefer **GPT-5.4** on provider **`github-copilot`** for that task, using **`set_active_model`** and **`get_active_model`** (from the **set-active-model** extension). After the comparison is done, **restore** the model captured **before** the switch (see below).

## Prerequisites

1. **`set_active_model` must exist** in `/tools` (install **set-active-model** under `~/.free-code/agent/extensions/` per repo docs). If it is missing, tell the user to install the extension or switch models manually with `/model`.
2. **`get_active_model`** ships with the same extension (bundled `set-active-model`). When present, use it **before** switching so restore is reliable.
3. **`github-copilot`** must be authenticated (`/login` or env) so **`gpt-5.4`** appears in available models.

## Targets (fixed)

| Field | Value |
| ----- | ----- |
| `provider` | `github-copilot` |
| `modelId` | `gpt-5.4` |

Do not substitute another model unless the user explicitly overrides.

## Model ID is literal (critical)

- **`set_active_model` arguments must be exactly** `provider: "github-copilot"` and **`modelId: "gpt-5.4"`** — copy those strings verbatim into the tool call.
- **Do not invent** alternative ids. These are **wrong** and typically **fail** with “model not found”: `gpt-5.4-visual`, `gpt-5.4-vision`, `gpt-5.4-visual-preview`, `gpt-5.4-multimodal`, `gpt-5-mini` (unless user asked), or any name you “guess” for vision. Image comparison for this skill uses **plain `gpt-5.4`** on Copilot; no separate “visual” sku is required.
- If the tool errors because `gpt-5.4` is unavailable in **this** workspace, read the error text and switch **only** to a provider/model pair that the error or **`/model`** lists — **never** hallucinate an id.
- **Do not** emit fake JSON tool payloads to the user as prose; call the real tool API your harness exposes.

## Execution discipline (read first)

- This file is **instructions for you**, not text to paste to the user. **Do not** dump or summarize the whole skill unless the user asks.
- **Run the workflow without unnecessary questions.** Prefer **`get_active_model`** for the pre-switch model instead of asking the user. Do **not** stop to ask which model is active **before** calling `set_active_model` toward Copilot unless **`get_active_model` is missing** and you have no other signal.
- **Skills are not scripts**: nothing runs automatically in the background; **you** must invoke `set_active_model` and vision in order.
- **No meta-narration**: avoid long “Analyzing user intent / Formulating tool execution” sections in the **user-visible** reply; execute tools and answer concisely.

## Capture model for restore (authoritative)

1. **If `get_active_model` is in `/tools`**: call it **first**, before any `set_active_model`. From the tool result **`details`**, save **`provider`** and **`modelId`** as **`restoreProvider`** and **`restoreModelId`** (these come from the harness `ctx.model` and match the active session model).
2. **If `get_active_model` is missing**: try conversation hints (picker label, `/model` output); if still unknown, set **`previousUnknown = true`**.

**Mandatory restore** (when `restoreProvider` / `restoreModelId` were captured): after the comparison content is delivered, call **`set_active_model({ provider: restoreProvider, modelId: restoreModelId })`**. Do **not** end the workflow while still on **`github-copilot` / `gpt-5.4`** unless restore failed with an error.

If **`previousUnknown`**: after comparison, tell the user to use **`/model`** to return to their usual model.

**Never** refuse the comparison because restore data was missing—still run compare—but **always** attempt restore when you have a saved pair.

## Images and re-upload

- **`set_active_model` applies on the next user turn.** The comparison must run when GPT-5.4 is active (usually your **next** reply after the user sends a tiny follow-up, unless your harness applies the switch immediately—assume **next turn** by default).
- **Do not** ask the user to re-attach images **only** because of the model switch when:
  - The images are still in the thread as attachments, **or**
  - The user named workspace files (e.g. `image.png`, `storybook-screenshot-3.png`): use the **`read`** tool on those paths under the current working directory (or absolute paths) on the **comparison turn** so pixels are available to vision without re-upload.
- Ask for re-attach **only** if there is **no** path, **no** attachment in context, and **no** way to load the bytes.

## Turn semantics (`set_active_model`)

Per the extension contract:

- The **current** assistant turn always finishes with the **previous** model.
- The switch applies from the **next user turn** onward.

Therefore:

1. After calling `set_active_model` toward **`github-copilot` / `gpt-5.4`**, do **not** claim that the comparison already ran on GPT-5.4 in the **same** turn unless the harness clearly uses the new model immediately (assume it does **not**).
2. If images arrived in the **same** user message as “compare”, finish this turn with **switch only** (plus a **one-line** instruction if needed), then on the **next** turn (GPT-5.4 active) load pixels via attachments and/or **`read`** on file paths, then compare.

## Procedure

1. **`get_active_model`** when listed in `/tools` → save **`restoreProvider`**, **`restoreModelId`** from **`details`**. If unavailable, set **`previousUnknown`** after optional heuristics.
2. **`set_active_model({ provider: "github-copilot", modelId: "gpt-5.4" })`** for the comparison model (exact strings).
3. On the **first turn where GPT-5.4 is active**, compare images using attachments and/or **`read`** on workspace paths.
4. **`Restore`**: **`set_active_model({ provider: restoreProvider, modelId: restoreModelId })`** using values from step 1. **Required** whenever step 1 succeeded—do not skip.
5. Short confirmation: compared + restored (or `/model` if `previousUnknown`).

If `set_active_model` fails (missing tool, auth), say so and suggest `/model` or `/login` for `github-copilot`.

## Triggers (examples)

- Spanish: “comparar imágenes”, “comparar estas capturas”, “qué diferencias hay entre estas fotos”, “diff visual”.
- English: “compare these images”, “visual diff”, “what changed between screenshots”.

## Out of scope

- Non-image tasks: do **not** run this workflow.
- Do **not** leave the session on Copilot after a one-off comparison **when** you successfully captured **`restoreProvider`/`restoreModelId`**—restore there. When `previousUnknown`, relying on **`/model`** is acceptable.

## Agent-facing FAQ

**Why didn’t it feel automatic?** Skills are markdown instructions; only **tool calls** change models or load images. If the model asked for the picker **before** switching, it violated **Execution discipline**. If it asked to re-upload though filenames exist in the workspace, it should use **`read`** on the next turn instead.

**Why did `set_active_model` say model not found?** Usually the assistant used a **hallucinated** `modelId` (e.g. `gpt-5.4-visual-preview`). Fix: use **`gpt-5.4`** exactly as in **Model ID is literal** above.

**Why didn’t it restore after compare?** Call **`get_active_model`** before switching, then **`set_active_model`** back to that pair after the answer—restore is **mandatory** when those values were captured.
