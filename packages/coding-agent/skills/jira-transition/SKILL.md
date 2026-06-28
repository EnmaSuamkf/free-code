---
name: jira-transition
description: Gets available Jira workflow transitions for an issue and helps the user move it to a new status. Presents transition choices via Cursor AskQuestion (questionnaire UI) when available. Use this skill whenever the user wants to change a Jira issue status, move a ticket to another state, transition an issue, check what statuses are available for a ticket, or asks "what can I do with this Jira issue?" — even if they say "move OCTOPUS-10820 to In Progress", "change status of CAT-4045", or "what are the next steps for this ticket?". Requires mcp-atlassian.
---

# Jira Transition

Gets the available workflow transitions for a Jira issue and guides the user to transition it to the desired status. The agent fetches transitions, presents them through the **questionnaire UI** (**AskQuestion**) when that tool is available—one option per transition plus **Do not apply**—waits for an explicit choice, then either executes that transition or skips it and continues if the user chose **Do not apply**.

## ⚠️ CRITICAL — Never Skip User Confirmation

**NEVER** call `jira_transition_issue` without first:

1. **Presenting** the available transitions to the user using **AskQuestion** (primary): one selectable option per transition (option **label** = human-readable transition **name**; option **id** = string form of Jira transition **id**, e.g. `"21"`). Always include a **Do not apply** option (recommended option id: `do_not_apply`). If **AskQuestion** is unavailable in the runtime, use the **fallback** numbered chat list in Step 2—still require an explicit answer before Step 3.
2. **Asking** which transition they want (questionnaire submission or explicit reply mapping to one transition or **Do not apply**).
3. **Waiting** for their explicit choice (no inferring from unrelated messages).
4. **No matter** the Jira status, do not assume — stop and ask.

This applies even when executing a plan, batch of tasks, or automated workflow. The user must always choose an option before any transition runs. Choosing **Do not apply** is explicit confirmation to skip `jira_transition_issue` and continue.

## Prerequisites

- **Input**: `{issue_key}` (e.g., OCTOPUS-10820, CAT-4045)
- **MCP server**: mcp-atlassian (atlassian)
- **Cursor**: **AskQuestion** tool for questionnaire UI (when present)

## Workflow

### Step 1: Get Available Transitions

Use mcp-atlassian `jira_get_transitions` with the issue key:

```
jira_get_transitions(issue_key: "{issue_key}")
```

The response is a list of objects with `id` and `name`:

```json
[
  { "id": 21, "name": "Start Progress" },
  { "id": 31, "name": "Ready for Review" },
  { "id": 41, "name": "Done" }
]
```

### Step 2: Present Options and Ask — Mandatory

**Primary path (use when AskQuestion is available)**

Call **AskQuestion** with a single question, for example:

- **Prompt**: e.g. `Which Jira workflow transition should be applied to {issue_key}?` (include current status if helpful.)
- **Options**: For each transition from Step 1, add one option:
  - **id**: string form of Jira `id` (e.g. `"31"`)
  - **label**: transition **name**, optionally with id in parentheses for clarity (e.g. `Ready for Review (id: 31)`)
- **Always add** a final option:
  - **id**: `do_not_apply`
  - **label**: e.g. `Do not apply — no transition now; continue with the rest of the task`

**Rules**

- Do **not** call `jira_transition_issue` until the user submits the questionnaire (or explicitly confirms in chat when using fallback).
- **Single transition**: Still use **AskQuestion** (or fallback) so the pick is explicit.
- **Mapping after selection**: If the user chose option id `do_not_apply`, skip Step 3–4. Otherwise pass the selected option **id** as `transition_id` (string) to `jira_transition_issue`.

**Fallback (when AskQuestion is not available)**

Present the same choices as a **numbered list** in chat (transition id + name) and **Do not apply**, then wait for an explicit reply (name, number, or unambiguous match). This is secondary to the questionnaire UI.

**Do not apply** (no Jira transition; continue): If the user chooses **Do not apply**, or equivalent intent ("No transition", "skip transition", "none", "keep current status", "proceed without transitioning", "issue already in the right status"):

- Do **not** call `jira_transition_issue`.
- Do **not** treat this as an error or as aborting the overall request.
- Acknowledge briefly (e.g., "No transition applied. Issue remains in its current status.") and **continue** with whatever the user or parent workflow asked for next (other skills, steps, or instructions). Skip Step 3–4 of this skill only.

### Step 3: Execute Transition

Use mcp-atlassian `jira_transition_issue`:

```
jira_transition_issue(
  issue_key: "{issue_key}",
  transition_id: "{id}"  // string from the selected questionnaire option id, e.g. "31"
)
```

Optional parameters:

- `comment`: Add a comment during the transition
- `fields`: Update fields (e.g., assignee, resolution) if the transition requires them

### Step 4: Confirm

After the transition succeeds, confirm to the user: "Issue {issue_key} has been moved to [new status]."

## Edge Cases

- **User selects "Do not apply"** (or equivalent): Do not execute any transition. Acknowledge and **continue** with the rest of the task or workflow; do not block or end the session solely because no transition was applied.
- **No transitions available**: Inform the user. The issue may already be in a terminal state or the user may lack permissions.
- **Transition requires fields**: Some transitions (e.g., "Done") may require a resolution. Use the `fields` parameter. If unsure, ask the user for the required values.
- **Invalid issue key**: If the issue is not found, report the error clearly.
- **Many transitions**: Prefer one **AskQuestion** with one option per transition. If the client imposes a practical limit on options or the list is unwieldy, split into multiple questionnaire steps by category **or** use the **fallback** numbered list for that run; always preserve explicit user confirmation before `jira_transition_issue`.

## Example Flow

**User**: "What can I do with OCTOPUS-10820?"

**Agent** (using this skill):

1. Calls `jira_get_transitions` for OCTOPUS-10820
2. Calls **AskQuestion** with options such as: `Start Progress` (id `"21"`), `Ready for Review` (id `"31"`), `Do not apply` (id `do_not_apply`)
3. User selects **Ready for Review** (questionnaire option id `"31"`)
4. Calls `jira_transition_issue` with `transition_id: "31"`
5. "OCTOPUS-10820 has been moved to Ready for Review."
