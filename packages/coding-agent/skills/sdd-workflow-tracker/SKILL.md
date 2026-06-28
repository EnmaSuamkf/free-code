---
name: sdd-workflow-tracker
description: "Tracks SDD workflow adoption via Jira labels (bot-cx-ai-spec, bot-cx-ai-plan, bot-cx-ai-dev, bot-cx-ai-code-review). Filters by assignee (person) or project (team), and optionally by date range or last N days. Use when the user wants to know SDD workflow usage, adoption metrics, funnel conversion, or phase counts per person/team. Requires mcp-atlassian. Read-only."
---

# SDD Workflow Tracker

Reports **SDD workflow adoption and phase progression** for Jira issues by inspecting current labels:

| # | Phase       | Label                    |
|---|-------------|--------------------------|
| 1 | Specify     | `bot-cx-ai-spec`         |
| 2 | Plan        | `bot-cx-ai-plan`         |
| 3 | Dev         | `bot-cx-ai-dev`          |
| 4 | Code Review | `bot-cx-ai-code-review`  |

Does **not** transition issues, change labels, or modify any data. **Read-only**.

Canonical label semantics and skill ownership: **`workflows/SDD/README.md`**.

## Invocation

### Required — at least one filter

- **`--assignee`** (person): Jira username, e.g. `pablo.castaneda`.
- **`--project`** (team): Jira project key, e.g. `SUMO`, `OCTOPUS`.

Both can be combined. If **neither** is provided: STOP and ask "¿Para qué persona (--assignee) o equipo/proyecto (--project) quieres el reporte?"

### Optional — date range

One of:

- **`--days N`**: last N calendar days from today (e.g. `--days 20`).
- **`--from-date YYYY-MM-DD`** and **`--to-date YYYY-MM-DD`**: explicit inclusive range.

Cannot combine `--days` with `--from-date`/`--to-date`.

- **`--date-field`**: `updated` (default) or `created`. Controls which Jira field bounds the JQL range.

If no date filter is provided, all matching issues are returned (no time constraint).

### Output format

- Default: **markdown** report (phase adoption table, funnel, issues detail).
- **`--json`**: structured JSON output.

## Prerequisites

1. **Primary**: `mcp-atlassian` with `jira_search` capability.
2. **Fallback**: Jira **REST API** + Personal Access Token via **`scripts/sdd_workflow_tracker.py`** (stdlib only; read-only).

Do **not** commit tokens or paste them into specs/chats.

### Credentials file (REST fallback only)

When MCP is unavailable and you run the script in the shell, resolve credentials in this **order**:

1. **Try automatically first** (no question yet):
   - Read **`~/.cursor/mcp.json`** (user-level Cursor MCP config).
   - Find the **`mcp-atlassian`** server entry and scan its `args` for **`--env-file`**, then use the **next** argument as the env file path.
   - If that path **exists**, load it: `set -a && source "/absolute/path/.env" && set +a`. Never print or paste token values into the chat.
2. **If that fails**: ask the user for an absolute path or confirm vars are already exported.
3. **If they give a path**: `source` only that file.
4. **If they say env is already set**: run the script without sourcing; if `JIRA_URL` is still missing, stop and ask again.

**Auth behavior (REST script)**:

- **Bearer first**: scripts send `Authorization: Bearer` with `JIRA_PERSONAL_TOKEN` or `JIRA_API_TOKEN`. On **401**, retry once with HTTP Basic (`JIRA_USERNAME` + token) unless `JIRA_FORCE_BEARER_ONLY=1`.
- **`--basic`**: force Basic only; requires `JIRA_USERNAME` + token.

## Step 1 — Build JQL and search issues (MCP preferred)

### Using mcp-atlassian

Call `jira_search` with JQL built from filters:

```
labels in ("bot-cx-ai-spec", "bot-cx-ai-plan", "bot-cx-ai-dev", "bot-cx-ai-code-review")
AND assignee = "{assignee}"
AND project = "{project}"
AND {date_field} >= "{from_date}"
AND {date_field} < "{to_date + 1 day}"
ORDER BY key ASC
```

Include only the clauses for provided filters. Request fields: `key`, `summary`, `labels`, `assignee`, `project`, `status`.

Paginate (max 50 per page) until all issues are collected.

### Using REST fallback

**First**: follow **Credentials file** section above.

**Command**:

```bash
python3 scripts/sdd_workflow_tracker.py --assignee pablo.castaneda --days 20
python3 scripts/sdd_workflow_tracker.py --project SUMO --from-date 2026-03-01 --to-date 2026-03-31
python3 scripts/sdd_workflow_tracker.py --assignee pablo.castaneda --project OCTOPUS --days 30 --json
```

## Step 2 — Classify issues by SDD phase

For each issue, check which tracked labels are present in `fields.labels`:

- `bot-cx-ai-spec` → passed **Specify** phase
- `bot-cx-ai-plan` → passed **Plan** phase
- `bot-cx-ai-dev` → passed **Dev** phase
- `bot-cx-ai-code-review` → passed **Code Review** phase

An issue may have multiple labels (normal progression) or be missing intermediate labels (e.g. spec + code-review but no plan — possible if labels were cleaned up).

## Step 3 — Compute adoption metrics

### Phase adoption

Count how many issues have each label. Compute percentage of total.

### Conversion funnel

For consecutive phases, compute the conversion rate:

- Spec → Plan: how many issues with spec also have plan
- Plan → Dev: how many issues with plan also have dev
- Dev → Code Review: how many with dev also have code-review

## Step 4 — Output format (mandatory)

### Markdown (default)

```markdown
## SDD Workflow Tracker

### Filters

- **Assignee**: `pablo.castaneda`
- **Project**: `SUMO`
- **Date range** (`updated`): `2026-03-20` → `2026-04-09`
- **Issues found**: 25

**JQL**:

```text
labels in (...) AND assignee = "..." AND ...
```

### Phase Adoption

| # | Phase       | Label                    | Count | % of Total |
|---|-------------|--------------------------|------:|-----------:|
| 1 | Specify     | `bot-cx-ai-spec`         |    25 |      100%  |
| 2 | Plan        | `bot-cx-ai-plan`         |    20 |       80%  |
| 3 | Dev         | `bot-cx-ai-dev`          |    15 |       60%  |
| 4 | Code Review | `bot-cx-ai-code-review`  |    12 |       48%  |

### Conversion Funnel

| Transition            | Rate              |
|-----------------------|------------------:|
| Specify → Plan        | 80.0% (20/25)     |
| Plan → Dev            | 75.0% (15/20)     |
| Dev → Code Review     | 80.0% (12/15)     |

| CAT | Tickets | More info |
| --- | ---: | --- |
| Pedro Dantas | 4 | CAT-101 (type story, status done), CAT-102 (type epic, status closed) |
| Raphael Alexandre | 2 | CAT-200 (type story, status in progress) |
| Felipe Gonzalez | 1 | CAT-300 (type bug, status done) |
| **Total CAT** | **7** | |

| SUMO | Tickets | More info |
| --- | ---: | --- |
| Vladyslav Lukos | 1 | SUMO-50 (type story, status done) |
| Joel Filipe Silva | 2 | SUMO-60 (type task, status in review) |
| **Total SUMO** | **3** | |

| OCTOPUS | Tickets | More info |
| --- | ---: | --- |
| Pablo Castañeda | 2 | OCTOPUS-820 (type story, status done) |
| Ana Navarro | 3 | OCTOPUS-900 (type story, status in progress) |
| **Total OCTOPUS** | **5** | |

### Data source

Jira REST / mcp-atlassian (read-only). Tracks current labels on issues.
```

### JSON

When `--json` is used, emit a single JSON object with: `assignee`, `project`, `date_from`, `date_to`, `date_field`, `jql`, `total_issues`, `phase_counts`, `funnel`, `by_project` (grouped by project → assignee → issue list with key, summary, issuetype, status).

## Edge cases

- **No issues found**: report zero counts; state the JQL used so the user can verify filters.
- **Missing assignee AND project**: STOP and ask for at least one filter.
- **`--days` combined with `--from-date`/`--to-date`**: error; mutually exclusive.
- **Labels on issue without changelog history**: this skill checks **current labels** only (not changelog). For changelog-based timing, use `jira-ssd-label-lead-time`.
- **Credentials**: PATs are secrets; keep them in a local gitignored file. Resolve `--env-file` from `~/.cursor/mcp.json` first; if that fails, ask the user.
- **Permissions**: read-only; never call `jira_transition_issue` or label update APIs.

## Example prompts

- "Track SDD workflow usage for pablo.castaneda in the last 20 days"
- "SDD adoption for team SUMO last 30 days"
- "How many issues went through SDD phases for project OCTOPUS from 2026-03-01 to 2026-03-31?"
- "SDD funnel for pablo.castaneda"
- "Workflow tracker --assignee pablo.castaneda --project SUMO --days 20"
- "¿Cuántos tickets pasaron por spec, plan y dev en SUMO los últimos 15 días?"
