---
name: commit-and-push
description: "Executes git add, commit, push, PR creation, Jira label bot-cx-ai-code-review (code review phase), and Jira transitions for a single Jira Story, Task, or Bug. Use ONLY when the user has an issue key in format PROJECT-NUMBER (e.g., OCTOPUS-10820, CAT-4045) and wants to commit/push/PR for that specific Epic, Story, Task, or Bug. Do NOT use for generic commits, pushes, or PRs without an issue key. Requires mcp-atlassian, mcp-github. Prerequisite: /implement has completed and local changes exist (unstaged)."
---

# Commit and Push (Issue)

## Invocation Rules (from commitAndPush command)

When invoked (e.g. via `/commitAndPush` or "commit and push {issue_key}"):

- **Required**: issue key (e.g. OCTOPUS-10820)
- **If no issue key**: STOP and ask "Which issue key do you want to commit and push?"
- **Step 0 (routing)**: Call `jira_get_issue` first to resolve issue type
- **Prerequisites**: `plan-{issue_key}.md` must exist and local changes must exist
- **Critical**: Don't assume anything — follow the plan exactly
- **Critical**: Stop at transitions (Step 7) and ask the user to select the Jira transition for the Story, Task, Bug, or Epic before proceeding

---

Executes Phase 2 of the development workflow for a **single Jira issue** (Epic, Story, Task, or Bug): git operations, PR creation, and Jira updates. Use ONLY when an issue key (`PROJECT-NUMBER`) is provided. Do not use for generic commits or PRs.

## Prerequisites

- **Input**: `{issue_key}` in format `PROJECT-NUMBER` (e.g., OCTOPUS-10820, CAT-4045)
- **Required**: `/analysis/plan-{issue_key}.md` must exist
- **Required**: Local changes exist (unstaged). Run /implement first if not.
- **MCP servers**: atlassian, github

## Step Order

Execute sequentially. On failure: abort with clear message.

---

## Route by number of changed files

**MANDATORY CHECK**

Count changed files: `git diff --name-only` + `git status --short` (untracked).

- **≤ 15** → Single PR workflow (one PR)
- **> 15** → Ask user; if they accept split → Split PR workflow (2 or more stacked PRs)

| Changed files | Workflow                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **≤ 15**      | `references/single_pr_workflow.md`                                                                                                                                                                                                                                       |
| **> 15**      | Ask user: "Big number of changes detected. Do you want to split into stacked (smaller) PRs? How it work: will devide code in diff PR for exmaple: Master <- PR_1 <- PR_2 <- PR_N" → If YES: `references/split_pr_workflow.md`; If NO: `references/single_pr_workflow.md` |

## Jira label: code review

Same pattern as specify-workflow (`bot-cx-ai-spec` in **Step 3: Create Spec and Post**). After the PR is created and you run Jira updates for `{issue_key}`:

- Use mcp-atlassian `jira_update_issue` to add label **`bot-cx-ai-code-review`** to the issue
- **When**: immediately after **Create PR** (per `references/single_pr_workflow.md` / `references/split_pr_workflow.md`), before or together with the Jira transition step — the label marks that the ticket is in the code-review phase (open PR)

---
