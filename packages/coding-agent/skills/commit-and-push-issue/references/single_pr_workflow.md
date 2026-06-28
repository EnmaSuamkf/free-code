# Single PR workflow

## Step 1: Plan Prerequisite

- Verify `/analysis/plan-{issue_key}.md` exists
- **On failure**: abort with "Plan not found. Run /plan first."

## Step 2: Validate Local Changes

- Run `git status` — must show modified or untracked files
- **If no changes**: abort with "No local changes. Run /implement first."
- **If conflicts or merge issues**: abort with clear message

## Step 3: Git Add

```bash
git add .
```

## Step 4: Git Commit

- Format Commit Message Strategy: `branchType(issue-key): short_task_description`
- `issue_key` and `short_task_description` in **lower case**
- Example: `feature(octopus-10818): add commit and push skill`
- Use `--no-verify`

## Step 5: Git Push

```bash
git push origin {branch_type}/{issue_key}
```

**Branch type**: Story→feature, Bug→fix, Support/Defect→refactor

## Step 6: Create PR

- Use mcp-github to create PR to principal branch (main|master|trunk)
- Link PR to Jira issue if supported

## Step 7: Jira label (code review)

- Use mcp-atlassian `jira_update_issue` to add label `bot-cx-ai-code-review` to `{issue_key}` (same naming convention as `bot-cx-ai-spec` / `bot-cx-ai-plan` in specify-workflow and plan-workflow)

## Step 8: Jira Transitions

- **jira issue transition**: transition `{issue_key}`

## Step 9: Jira Comment

- Add PR reference/link to Jira issue `{issue_key}`
