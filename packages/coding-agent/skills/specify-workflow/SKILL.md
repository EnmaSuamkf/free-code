---
name: specify-workflow
description: "Generates development specifications (spec-{issue_key}.md) from a single Jira Story, Task, or Bug. Use when the user runs /specify with a Story/Task/Bug, needs to generate a spec from a Jira ticket, or wants to create spec-{issue_key}.md. Requires mcp-atlassian, mcp-github, mcp-slack, mcp-cx. Output: <repository>/analysis/spec-{issue_key}.md"
---

# Specify Workflow

## Invocation Rules (from specify command)

When invoked (e.g. via `/specify` or "specify {issue_key}"):

- **Required**: issue key (e.g. OCTOPUS-10820)
- **If no issue key**: STOP and ask "Which issue key do you want to specify? (e.g. OCTOPUS-10820)"
- **Step 0 (routing)**: Call `jira_get_issue` first to resolve issue type
- **Critical**: Don't assume anything — follow the plan exactly
- **Critical**: Stop at transitions (Step 4) and ask the user to select the Jira transition for the Story, Task, Bug, or Epic before proceeding

---

Generates the development specification document from a single Jira issue (Story, Task, or Bug). All steps are sequential and mandatory. Do not skip or reorder.

> **Agent instructions**: is mandatory when you create the spec execute all spets, do not jump any of them

## Prerequisites

- **Get repository**: use `{issue_key}` to get repository and identify `<repository>`
- **Input**: `{issue_key}` (e.g., OCTOPUS-10820) and `<repository>/README.md`
- **Output**: `<repository>/analysis/spec-{issue_key}.md`
- **MCP servers**: atlassian, github, slack, cx

## CONTEXT ENGINEERING

**Objective**: get context for previous commits and add it to the spec.

**Action**:

1. Call **context-engineering** skill with `{issue_key}` and `<repository>`.
2. Take the result (CONTEXT ENGINEERING section) that context-engineering returns.
3. Add that result as the 'CONTEXT ENGINEERING' section inside `<repository>/analysis/spec-{issue_key}.md`.

**Output**: CONTEXT ENGINEERING section written into `<repository>/analysis/spec-{issue_key}.md`.

## Step Order

Execute 1 → 2 → 3 → 4 . Do NOT proceed to step N until step N-1 has completed successfully.

- > **MANDATORY checkpoint**: STOP on mandatory checkpoints and waint for user input.
- > **BLOCKING steps (5)**: Always stop and ask the user. Never infer "skip" from prior messages (e.g. "continua", "continue", "proceed").

## Step 1: Initial Triage

- Use mcp-atlassian `jira_get_issue` for `{issue_key}`
- **On failure**: abort

## Step 2: Cleanup Before Spec

- If `<repository>/analysis/spec-{issue_key}.md` exists: delete the file
- Use mcp-atlassian `jira_update_issue` to remove labels `bot-cx-ai-spec` and `bot-cx-ai-plan` from the Jira issue (if present)
- Only remove labels that are present; no error if absent

## Step 3: Create Spec and Post

- **Create** the spec file at `<repository>/analysis/spec-{issue_key}.md`.
- **Critital**: Do NOT create it in the repository root.
- Add label `{issue_key}` `bot-cx-ai-spec`

## Step 4: Review Spec

- **Review** the spec file at `<repository>/analysis/spec-{issue_key}.md`
- **Action**: run agent again to review in deep way the spec and modified it

## Step 5: Execute Epic, Story, Task, or Bug transition (BLOCKING STEP)

> **MANDATORY checkpoint**: this is a breakpoint ask and wait for user input

- **Ask User**: Present the available status options to the user.
- **WAIT**: Stop execution here. Do not generate the file yet.
- **Action**: Only after the user chooses and the transition is executed via `jira_transition_issue`

| Step | Action                               | Command / Description                                                                    |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1    | transition Epic, Story, Task, or Bug | transition Epic, Story, Task, or Bug. Transition `{issue_key}` use jira-transition skill |

## Token Optimization

- **focus_window**: Only index files mentioned in `<repository>/analysis/spec-{issue_key}.md`
- **reflection_step**: Perform Security_Vibe_Check before PR creation
