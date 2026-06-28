---
name: context-engineering
description: "Gathers relevant commit context for a Jira issue by analyzing the last 100 commits. Use when generating specs, building CONTEXT ENGINEERING sections, or when the user needs prior commit context for an issue (e.g., 'get commit context for OCTOPUS-10820', 'what commits relate to this ticket?', 'find relevant changes for spec'). Requires mcp-atlassian. Output: CONTEXT ENGINEERING section returned to user (never appended to spec file)."
---

# Context Engineering

## Invocation Rules (from contextEngineering command)

When invoked (e.g. via `/contextEngineering` or "context engineering {issue_key}"):

- **Required**: issue key (e.g. OCTOPUS-10820)
- **If no issue key**: STOP and ask "Which issue key do you want commit context for? (e.g. OCTOPUS-10820)"
- **Output**: CONTEXT ENGINEERING section (relevant prior commits + key takeaways); return to user only — do NOT append to spec file

---

Gathers relevant commit history for a Jira issue to inform spec creation or implementation. Analyzes the last 100 commits, filters by relevance to the issue description, and produces a CONTEXT ENGINEERING section.

## Prerequisites

- **Input**: `{issue_key}` (e.g., OCTOPUS-10820) and `<repository>` path
- **MCP server**: mcp-atlassian (for issue description)
- **Repository**: Must be a git repo with commit history

## Workflow

### Step 1: Get Issue Description

Use mcp-atlassian `jira_get_issue` for `{issue_key}`. Extract the **description** and **summary** — these define what "relevant" means for filtering commits.

### Step 2: Get Last 100 Commits

From `<repository>`, run:

```bash
git log -100 --oneline --no-merges
```

Filter out commits that are purely release-related (e.g., "Release v1.2.3", "Merge release/\*"). Commits that mention `{issue_key}` are often highly relevant — keep them. Adjust filtering based on the repo's conventions.

### Step 3: Filter by Relevance

For each commit message, assess relevance to the issue description and summary. Consider:

- Shared domain terms (feature names, module paths, entities)
- Related functionality (e.g., "auth" commit for "login" issue)
- Same area of the codebase

Keep commits that could inform the spec or implementation. Typically 3–15 commits will be relevant; avoid including everything.

### Step 4: Inspect Relevant Commits

For each relevant commit, run:

```bash
git show <commit-sha> --stat
git show <commit-sha>
```

Use `git diff <commit-sha>^..<commit-sha>` if you need a cleaner diff view. Capture:

- Files changed
- Summary of what changed and why it matters for the current issue

### Step 5: Write CONTEXT ENGINEERING Section

Produce a section in this format:

```markdown
## CONTEXT ENGINEERING

### Relevant Prior Commits

| Commit  | Summary                            | Relevance                       |
| ------- | ---------------------------------- | ------------------------------- |
| abc1234 | feat(auth): add JWT validation     | Same auth flow as current issue |
| def5678 | fix(api): handle timeout edge case | Related error handling          |

### Key Takeaways

- [Insight 1 from commit history]
- [Insight 2 from commit history]
```

**Output**: Return the section as the response for the user. Do NOT append to spec-{issue_key}.md.

## Token Optimization

- Limit the number of commits you inspect in detail (e.g., top 5–10 most relevant)
- Summarize diffs rather than including full patches
- Focus on architectural decisions and patterns, not line-by-line changes

## Edge Cases

- **No relevant commits**: Output an empty or minimal CONTEXT ENGINEERING section stating no prior related work was found.
- **Repository not found**: Abort and ask the user for the correct path.
- **Shallow clone**: If `git log -100` returns fewer commits, work with what is available and note it in the section.
