# PR Learnings — Design

## What it is

A folder inside the repository that accumulates knowledge extracted from resolved PR comments.
Each learning is one small `.md` file. An index file loads into every agent session automatically.
The agent never re-processes a PR it has already reviewed.

---

## Folder structure

```
docs/learnings/
  INDEX.md          ← compact index, always loaded at session start via AGENTS.md
  REVIEWED.md       ← list of PRs already processed, to avoid duplicates
  {org}-{repo}-pr{number}-{slug}-rules.md
  {org}-{repo}-pr{number}-{slug}-rules.md
  ...
```

---

## INDEX.md format

One row per learning. Kept short — the agent uses this to decide which files to read in full.

```markdown
# Learnings Index

| File | Category | Language | Rule |
|---|---|---|---|
| edo-development-uno-frontend-pr12-no-any-in-handlers-rules.md | correctness | typescript | Never use `any` in event handler return types |
| edo-development-uno-frontend-pr45-validate-at-boundaries-rules.md | security | typescript | Validate external input at system boundaries only |
| edo-development-uno-frontend-pr88-avoid-inline-imports-rules.md | style | typescript | No dynamic inline imports — use top-level imports |
```

Updated by `capture-pr-learnings` every time a new learning file is created.

---

## REVIEWED.md format

Tracks which PRs have been fully processed. Checked before any extraction run.

```markdown
# Reviewed PRs

| Repo | PR | Reviewed At | Learnings |
|---|---|---|---|
| edo-development/uno-frontend | 12 | 2026-01-15 | 2 |
| edo-development/uno-frontend | 45 | 2026-02-03 | 1 |
| edo-development/uno-frontend | 88 | 2026-03-20 | 3 |
```

If a PR is already in this list, `capture-pr-learnings` skips it entirely.

---

## Learning document format

Filename: `{org}-{repo}-pr{number}-{slug}-rules.md`
Slug: kebab-case summary of the rule, max 40 chars.

```markdown
---
repo: org/repo
pr: 123
category: security | performance | style | correctness | architecture
language: typescript
file-pattern: "packages/ai/src/**/*.ts"
captured-at: 2026-05-26
---

## Problem

[What was wrong and why the reviewer flagged it. No PR-specific names or internal references.]

## Fix Pattern

[How it was resolved. Short code excerpt if meaningful.]

## Rule

[The general rule — phrased to apply to any codebase, not this specific PR.]
```

---

## `capture-pr-learnings` skill

**Implementation:** skill (`SKILL.md`) — no compiled code needed. The agent handles all steps using `mcp-github` for GitHub API calls and file-write tools for disk output. The synthesis step (deriving a generalizable rule from review comments) is LLM reasoning, which is why a skill is the right fit over a script.

**File:** `packages/coding-agent/skills/capture-pr-learnings/SKILL.md`

---

### Inputs

| Input | Required | Format | Example |
|---|---|---|---|
| `repo` | **yes** | full GitHub URL or `org/repo` | `https://github.com/edo-development/uno-frontend` or `edo-development/uno-frontend` |
| `last` | **yes** | positive integer — number of most recent merged/closed PRs to process | `30` |

Both inputs are required. If either is missing, the skill MUST stop immediately and respond:

```
capture-pr-learnings requires two inputs:
  - repo: the repository URL or org/repo (e.g. https://github.com/edo-development/uno-frontend)
  - last: number of most recent PRs to process (e.g. 10)

Please provide both and try again.
```

Do not attempt to infer, guess, or prompt interactively for missing inputs. Hard stop.

**Deduplication:** before processing each PR in the batch, check `REVIEWED.md`. PRs already listed are silently skipped — they do not count toward `last`. The skill processes up to `last` **unreviewed** PRs.

---

### Output

On success the skill reports a summary for the full batch:

```
edo-development/uno-frontend — last 30 PRs processed (3 already reviewed, skipped).

  PR #123 — 3 learnings
    docs/learnings/edo-development-uno-frontend-pr123-no-any-in-handlers-rules.md
    docs/learnings/edo-development-uno-frontend-pr123-validate-at-boundaries-rules.md
    docs/learnings/edo-development-uno-frontend-pr123-avoid-inline-imports-rules.md
  PR #118 — 1 learning
    docs/learnings/edo-development-uno-frontend-pr118-avoid-inline-imports-rules.md
  PR #115 — 0 learnings (no resolved threads with a generalizable rule)

  Total: 4 learnings created across 7 PRs.
  INDEX.md updated.
  REVIEWED.md updated.
```

Already-reviewed PRs are not listed individually — only the skip count in the header.

---

### Steps

1. **Validate inputs.** If `repo` or `last` is missing, stop with the error message above.
2. Normalize `repo` to `org/repo` format (strip `https://github.com/` prefix if present).
3. Fetch the `last` N most recent merged/closed PRs from GitHub API, ordered by closed date descending.
4. Read `docs/learnings/REVIEWED.md`. Filter out any PR already listed — process only unreviewed ones.
5. For each unreviewed PR, fetch its resolved comment threads.
6. Filter threads: only those that are resolved or outdated (reviewer raised something, author addressed it).
7. For each qualifying thread:
   a. Extract the reviewer's comment (the problem) and the author's fix (commits + replies).
   b. Redact PII, secrets, internal URLs, reviewer/author names.
   c. Synthesize the learning document (Problem / Fix Pattern / Rule).
   d. Determine `category` and `file-pattern` from the thread's file path.
   e. Write `docs/learnings/{org}-{repo}-pr{number}-{slug}-rules.md`.
   f. Append one row to `docs/learnings/INDEX.md`.
8. Append one row to `docs/learnings/REVIEWED.md` per processed PR (including PRs with 0 learnings).
9. Report batch output (see Output section above).

### What to skip

- Threads that are only questions with no clear correction (ambiguous, no rule derivable).
- Nitpicks without a generalizable rule (typo fixes, one-off naming).
- Threads where the fix is trivially obvious from a rule already in INDEX.md.

---

## Session auto-load

Add to `AGENTS.md`:

```markdown
## PR Learnings

At the start of every session, read `docs/learnings/INDEX.md` if it exists.
When implementing or reviewing code, check the index for relevant learnings and read
the full document for any entry that matches the current language, category, or file pattern.
```

The agent loads the index (small, always fits in context) and reads individual files on demand.

---

## Integration with `implement-workflow` and `context-engineering`

Both skills check INDEX.md before writing code:

1. Read `docs/learnings/INDEX.md`.
2. Filter rows where `language` and `file-pattern` match the current task.
3. Read the full `.md` for each matching row.
4. Inject as a **"Relevant Learnings"** block before generating code.

If `docs/learnings/` does not exist or INDEX.md is empty, continue silently.

---

## Integration with `handler-pr-comments`

After resolving a comment thread, the handler calls `capture-pr-learnings` with the PR repo and number.
The skill checks REVIEWED.md — if the PR was already captured in full, it only processes the new thread.
This is fire-and-forget: if capture fails, the handler still completes normally.

---

## Maintenance

- Learning files and INDEX.md are committed to the repo — reviewed, edited, and improved via PR like any other doc.
- To remove a bad learning: delete the file and its row in INDEX.md.
- To reprocess a PR: remove its row from REVIEWED.md and run `capture-pr-learnings` again.
- The folder grows indefinitely but stays manageable — one small file per resolved thread, not per PR.
