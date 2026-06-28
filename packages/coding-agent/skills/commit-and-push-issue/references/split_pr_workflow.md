# Split PR workflow

Use when local changes must be split into **2 or more** PRs (stacked). The exact number of PRs is determined during the workflow based on dependencies and logical grouping.

## Step 1: Plan Prerequisite

- Verify `/analysis/plan-{issue_key}.md` exists
- **On failure**: abort with "Plan not found. Run /plan first."

## Step 2: Validate Local Changes

- Run `git status` — must show modified or untracked files
- **If no changes**: abort with "No local changes. Run /implement first."
- **If conflicts or merge issues**: abort with clear message

## Step 3: Propose PR division plan

- Use `File Dependency Graph` or `Step_by_step_task_plan` from `plan-{issue_key}.md` if available.
- Group files so each PR is self-contained: tests pass and coverage ≥ 90% after each group.
- Prefer: detect better logical order.
- Output a **proposed plan** as a table: PR number, branch name, base, files/scope for each group.
- The number of groups (2 or more) determines the number of PRs.

## Step 4: Self-review (agent)

Before presenting to the user, critically review the proposed plan:

- **Dependencies**: Does each PR only depend on code from earlier PRs (or principal)? No PR should depend on code from a later PR.
- **Testability**: Would each PR pass tests in isolation? Are providers/hooks included in the right PR so dependent tests can run?
- **Coverage**: Is ≥ 90% achievable per group for new/modified files?
- **Order**: Is the merge order logical (foundations first, then consumers)?

**If issues found**: Revise the grouping and repeat the self-review. Do NOT proceed until the plan passes.

**If plan passes**: Proceed to Step 5.

## Step 5: User review (BLOCKING STEP)

> **MANDATORY checkpoint**: this is a breakpoint ask and wait for user input

- Present the proposed PR division plan to the user (table + brief rationale).
- Ask: "Does this plan look good? Reply 'yes' to proceed, or describe changes you want."
- **If user says no or requests changes**: Revise the plan, repeat Step 3 and 4, then present again.
- **If user approves**: Proceed to Step 6. Do NOT execute git commands before user approval.

## Step 6: Prepare base

- Principal = master/main/trunk
- `git stash` (if needed to switch cleanly)
- `git checkout <principal>` → `git pull`
- `git stash pop` (restore uncommitted changes)

## Step 7: Create stacked branches

Each branch is created from the previous one (pr1 from principal, prN from prN-1). Push goes to `origin` — the new branch is created on the remote when it doesn't exist yet.

### PR1 (base = principal)

1. `git checkout -b {branch_type}/{issue_key}-pr1`
2. `git add <files_for_PR1>` → `git commit -m "..."`
3. `git push -u origin {branch_type}/{issue_key}-pr1` — pushes to `origin` and creates the branch on the remote; `-u` sets upstream for future pushes
4. Create PR: branch pr1 → base principal

### PR2, PR3, … (base = previous branch)

For each additional PR (N = 2, 3, …):

1. `git checkout -b {branch_type}/{issue_key}-prN` — creates branch from current (prN-1)
2. `git add <files_for_PRN>` → `git commit -m "..."`
3. `git push -u origin {branch_type}/{issue_key}-prN` — pushes to `origin`, creates the branch on the remote
4. Create PR: branch prN → base prN-1

Repeat until all changes are committed and pushed. The number of PRs (2 or more) depends on the grouping from Step 3.

## Step 8: Update plan

- Append to `analysis/plan-{issue_key}.md` a new section (number of rows = number of PRs created):

```markdown
## PR Division (Stacked PRs)

| PR  | Branch                  | Base   | Files / Scope                   |
| --- | ----------------------- | ------ | ------------------------------- |
| PR1 | feature/{issue_key}-pr1 | master | infra, query, provider          |
| PR2 | feature/{issue_key}-pr2 | pr1    | integration, useAncillariesInfo |
| ... | ...                     | ...    | ... (add rows for each PR)      |

### Structure (example for 3 PRs; adjust for 2 or more)

master
│
└── PR1 (base: master)
│
└── PR2 (base: PR1)
│
└── PR3 (base: PR2)
...

### Merge order

1. Merge PR1 → master
2. For each subsequent PR: change its base to master, then merge
```

## Step 9: Jira

- Use mcp-atlassian `jira_update_issue` to add label `bot-cx-ai-code-review` to `{issue_key}` (same convention as `bot-cx-ai-spec` / `bot-cx-ai-plan` in specify-workflow and plan-workflow)
- Add comment to `{issue_key}` with links to all PRs and the merge order.

---

### Rules for Split PR Workflow

- **Plan approval**: Do NOT execute Steps 4–7 until the plan passes self-review (Step 3b) AND user approval (Step 3c).
- **Tests**: Each PR group must pass tests before creating the next branch.
- **Coverage**: Maintain ≥ 90% for new/modified files (SonarQube compliance).
- **Provider/tests**: If a PR adds a provider or hook used by components, include provider in testing setup so dependent tests pass.
