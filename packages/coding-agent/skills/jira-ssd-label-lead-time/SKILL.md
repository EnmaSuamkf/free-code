---
name: jira-ssd-label-lead-time
description: "SSD spec→code-review lead time via Jira changelog: first bot-cx-ai-spec add → first bot-cx-ai-review-passed add (preferred) or bot-cx-ai-code-review. Single issue or batch (--from-date/--to-date) via lead_time_batch_by_date.py. Prefer mcp-atlassian for search; REST + PAT for changelog. Read-only."
---

# Jira SSD label lead time (spec → review)

Reports **elapsed wall-clock time from spec to code review** for one issue, using Jira **labels** in the changelog:

- **Start**: first time `bot-cx-ai-spec` was **added**.
- **End**: first **`bot-cx-ai-review-passed`** add in the changelog, else first **`bot-cx-ai-code-review`** add. If both exist, **review-passed** is the duration endpoint.

Does not transition issues or change labels. Does **not** compute other segments (creation, plan, issue-definition, etc.).

Canonical label semantics and skill ownership: **`SSD_Workflow/README.md`**.

## Invocation

Two supported modes. **Same metric** in both: first add `bot-cx-ai-spec` → first add `bot-cx-ai-review-passed` if present in changelog, else first add `bot-cx-ai-code-review` (wall-clock).

### A — Single issue

- **Required**: `{issue_key}` (e.g. `OCTOPUS-10820`, `CAT-4045`).
- **If missing**: STOP and ask for the issue key.

### B — Date range (batch)

- **Required**: **from date** and **to date**, inclusive, as calendar days `YYYY-MM-DD` (e.g. `2026-03-01`, `2026-03-20`).
- **Optional knobs** (document when reporting):
  - **`--date-field`**: `updated` (default) or `created`. The batch JQL restricts which issues appear in the list by that field: `field >= from` and `field < to + 1 day` so **to** is inclusive for the whole last day.
  - **`--labels-mode`**: `both` (default) — `bot-cx-ai-spec` **and** (`bot-cx-ai-review-passed` **or** `bot-cx-ai-code-review`) on the issue. `spec-only` — only `bot-cx-ai-spec`; more issues; some rows may be **N/A** if no end label appears in the changelog.
- **If dates missing**: STOP and ask for from / to.

**Preferred implementation**: run **`scripts/lead_time_batch_by_date.py`** after credentials (see Step 1b). It runs **`POST /rest/api/2/search`**, paginates, then reuses the same changelog analysis as the single-issue script for each key, and prints a **markdown table + sum + mean** (or `--json`).

```bash
python3 scripts/lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20
python3 scripts/lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20 --json
python3 scripts/lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20 --date-field created --labels-mode spec-only
```

**Important**: the date filter is **not** “first spec label in this window”; it filters issues by **`updated` or `created`** per JQL. Lead times are still computed from **changelog** first-adds. Say so in the report if users might confuse the two.

**“Last N days” (e.g. 20 days)** — map to calendar **`--from-date` / `--to-date`** with the same caveats:

- Example (GNU `date`): `--from-date "$(date -v-20d +%Y-%m-%d)" --to-date "$(date +%Y-%m-%d)"` on macOS, or use your shell’s date arithmetic equivalent on Linux.
- Default **`--date-field updated`** matches “issues touched in that window”, **not** “review-passed label first added in that window”. The latter would require filtering by parsed changelog timestamps (not built into the batch script).

**Alternative**: `mcp-atlassian` `jira_search` with equivalent JQL to list keys, then `lead_time_from_changelog.py KEY --json` per key — equivalent, usually slower to orchestrate; prefer the batch script when the user gives a date range.

## Prerequisites

1. **Primary**: `mcp-atlassian` with a working **`expand=changelog`** path (see Step 1).
2. **Fallback**: Jira **REST API** + Personal Access Token (see Step 1b). The skill ships **`scripts/lead_time_from_changelog.py`** (stdlib only; read-only).

Do **not** commit tokens or paste them into specs/chats.

### Credentials file (REST fallback only)

When you need **Step 1b** (or MCP is unavailable and you run the script in the shell), resolve credentials in this **order**:

1. **Try automatically first** (no question yet):
   - Read **`~/.cursor/mcp.json`** (user-level Cursor MCP config).
   - Find the **`mcp-atlassian`** server entry and scan its `args` for **`--env-file`**, then use the **next** argument as the env file path (same pattern Docker uses: `"--env-file", "/absolute/path/.env"`).
   - If that path **exists**, load it in the shell only: `set -a && source "/absolute/path/.env" && set +a`. Never print or paste file contents or token values into the chat.
2. **If that fails** (no file, unreadable path, no `mcp-atlassian`, or still missing `JIRA_URL` or a token after load): **then ask the user** for an absolute path or confirm vars are already exported.
   - **Prompt** (adapt wording): “No encontré un `--env-file` usable para `mcp-atlassian` en `~/.cursor/mcp.json` (o faltan variables). ¿Desde qué archivo debo cargar `JIRA_URL` y `JIRA_PERSONAL_TOKEN` (o `JIRA_API_TOKEN`)? Pásame la ruta absoluta, o di si ya están exportadas en la terminal.”
3. **If they give a path**: `source` only that file (same `set -a && source ... && set +a` pattern).
4. **If they say env is already set**: run the script without sourcing; if `JIRA_URL` is still missing, stop and ask again.

**Auth behavior (REST scripts)**:

- **Bearer first**: scripts send **`Authorization: Bearer`** with `JIRA_PERSONAL_TOKEN` or **`JIRA_API_TOKEN`** even when `JIRA_USERNAME` is set. On **401**, they **retry once** with **HTTP Basic** (`JIRA_USERNAME` + same token) unless **`JIRA_FORCE_BEARER_ONLY=1`** is set (`1` / `true` / `yes`).
- **`--basic`**: force Basic only (single-issue and batch scripts); requires `JIRA_USERNAME` + token.
- **Legacy 401 workaround**: `env -u JIRA_USERNAME …` still works if you need Bearer only without setting `JIRA_FORCE_BEARER_ONLY`.

## Labels used for this metric

| Label                      | Role                                      |
| -------------------------- | ----------------------------------------- |
| `bot-cx-ai-spec`           | Segment **start** (spec phase).           |
| `bot-cx-ai-review-passed`  | Segment **end** (preferred).              |
| `bot-cx-ai-code-review`    | Segment **end** (fallback in changelog).  |

Other `bot-cx-ai-*` labels may appear on the issue; they are **ignored** for duration calculation unless you add an optional diagnostic note (see Step 4).

## Step 1 — Fetch issue with changelog (MCP)

Call **mcp-atlassian** `jira_search` **or** `jira_get_issue` with:

- `issue_key`: `{issue_key}`
- `fields`: include at least **`created`** and **`labels`** (e.g. add `summary` for the report header).
- `expand`: **`changelog`** (Jira must return `changelog.histories`).

If your MCP exposes `expand` as a comma-separated string, use `changelog`.

**On error** (issue not found, permission denied): return the error message and stop.

**If the MCP fails on `expand`** (e.g. JSON/client errors when changelog is requested): **stop retrying MCP** for changelog — use **Step 1b (REST)** immediately. Do not loop on the same broken tool path.

Record:

- **Issue created at**: parse `created` from the issue (ISO-8601).
- **Current labels**: from `fields.labels` (or rendered equivalent).

## Step 1b — Fetch issue with changelog (Jira REST, fallback)

When MCP `expand=changelog` is unreliable, run the bundled script from this skill directory (or pass the absolute path).

**First**: follow **Credentials file (REST fallback only)** above — try **`mcp.json` → `--env-file`** first; only **then** ask the user if needed.

**Environment** (must be set in the shell before `python3`, from the user-chosen file or prior export)

- `JIRA_URL` — base URL, e.g. `https://jira.example.org`
- `JIRA_PERSONAL_TOKEN` **or** `JIRA_API_TOKEN` — PAT used for Bearer (scripts use the first non-empty value)

Optional: **`JIRA_USERNAME`** — enables Basic **after** a 401 on Bearer, or use **`--basic`** to force Basic.

**Command** (after the user’s credentials are loaded into the environment):

```bash
python3 scripts/lead_time_from_changelog.py INFINITY-3538
```

Structured output:

```bash
python3 scripts/lead_time_from_changelog.py INFINITY-3538 --json
```

The script calls **`GET /rest/api/2/issue/{key}?expand=changelog&fields=created,labels,summary`**, applies the same label-add rules as Step 2, and prints the **Step 5** markdown report (or JSON). If `changelog.total` exceeds the first page of histories, it **follows `GET …/issue/{key}/changelog`** with `startAt` until merged (best effort; if that endpoint fails, it keeps the first page and may set a truncation warning).

JSON output may include **`diagnostic`** when **current `labels` include `bot-cx-ai-spec` or an end label** but the **changelog has no “add” event** for that label (e.g. labels set at creation, import, or bulk edit without label history).

**Batch by date**: **`scripts/lead_time_batch_by_date.py`** (see **Invocation → B**). Emits one combined markdown report (table + aggregate rows) or **`--json`** with `issues`, `total_hours_wall`, `valid_count`, and the exact `jql` used.

**Agent note**: If the user’s repo clone does not include this skill path, copy the script logic verbatim or point the user to `skillsRepository` `SSD_Workflow/skills/jira-ssd-label-lead-time/scripts/lead_time_from_changelog.py`.

## Step 2 — Build label event timeline from changelog (spec & review only)

Process `changelog.histories` in **chronological order** (sort by each history’s `created` if the API does not guarantee order).

For each history entry, inspect **items** where the field indicates **labels** changed. Jira may expose `field` as `labels`, `Labels`, or `Label` depending on version — treat case-insensitively for `'label'`.

For each such item:

1. Derive **label set before** and **label set after** the change:
   - Merge **`from` / `to`** (structured strings or arrays) with **`fromString` / `toString`** when present (the bundled script unions them).
   - Split string values on **whitespace and commas** (e.g. regex `[\s,]+`). Many Jira DC responses use **space-separated** labels in one string (`bot-cx-ai-plan bot-cx-ai-spec`). Trim tokens; dedupe case-sensitively as Jira stores labels.
2. Detect **additions**: any label present in “after” but not in “before”.
3. For each added label that is **`bot-cx-ai-spec`**, **`bot-cx-ai-review-passed`**, or **`bot-cx-ai-code-review`**, append:

   `{ iso_timestamp, label, author_display_name_optional }`

   Use the history entry’s **`created`** as the timestamp.

**Deduplicate for “first appearance”**: keep only the **earliest** event per label (by timestamp). Discard later re-adds for the main metric, but see **Step 4 (notes)**.

**If changelog is empty or has no label items**: say so explicitly; report issue `created`, current labels, and that spec→review is **N/A**.

## Step 3 — Compute spec → review only

Let:

- `t(spec)` = first time `bot-cx-ai-spec` was added, if any.
- `t(review)` = first time `bot-cx-ai-review-passed` was added, if any; **else** first time `bot-cx-ai-code-review` was added (when review-passed is absent from changelog).

**Primary metric — Spec → code review**

| Metric                 | From      | To          |
| ---------------------- | --------- | ----------- |
| **Spec → code review** | `t(spec)` | `t(review)` |

Compute **only** if **both** `t(spec)` and `t(review)` exist. Otherwise report **N/A** and state which timestamp is missing (`spec`, neither end label, or both).

**Duration format**: human-readable (e.g. `2d 5h 30m`) and **optional** raw hours; use absolute elapsed wall-clock time unless the user asks for business days.

**Ordering edge case**: if `t(review)` is **before** `t(spec)` (data oddity or changelog quirk), still report both timestamps and show duration as **negative or invalid** with a clear warning — do not hide the inconsistency.

## Step 4 — Notes on regeneration and removals

- **specify-workflow** may **remove** `bot-cx-ai-spec` / `bot-cx-ai-plan` and re-add later. Use **first** add of `bot-cx-ai-spec` for `t(spec)` so metrics stay comparable across tickets.
- Optional **“Changelog signals”**: if useful, mention last re-add of `bot-cx-ai-spec` vs first, or whether `bot-cx-ai-review-passed` was removed and re-added — without adding extra duration rows (this skill stays **spec → review only**).

## Step 5 — Output format (mandatory)

### Single issue

Return a markdown report like:

```markdown
## SSD spec → review lead time — {issue_key}

**Summary**: {e.g. "Spec → code review: X" or "N/A — missing spec label" or "N/A — missing code-review label"}

| Label                   | First added (UTC) |
| ----------------------- | ----------------- |
| bot-cx-ai-spec          | … or —            |
| bot-cx-ai-review-passed | … or —            |
| bot-cx-ai-code-review   | … or —            |

### Spec → code review

| Metric             | Duration | Notes |
| ------------------ | -------- | ----- |
| Spec → code review | …        | …     |

### Current labels

…

### Data source

Jira issue fields + changelog via **mcp-atlassian** (`expand=changelog`) **or** **REST** (`scripts/lead_time_from_changelog.py`). Read-only. **Metric**: spec first add → review-passed first add, or code-review first add if review-passed is missing from changelog.
```

Adjust timezone labeling to match what Jira returns; if all times are UTC, say **UTC**.

### Batch (date range)

Return the markdown emitted by **`lead_time_batch_by_date.py`** (or reproduce its structure). Must include:

- Date range, `date-field`, `labels-mode`, **JQL** used, count of issues, count with valid duration.
- Table: issue, hours (wall), human duration, summary.
- **Aggregate**: sum of hours (valid rows only), mean hours per valid issue.

If using **`--json`**, you may summarize from `total_hours_wall`, `valid_count`, and per-issue `duration_hours_wall` / `summary_line`.

## Edge cases

- **No changelog expand (MCP)**: use Step 1b (REST + PAT) or confirm Jira permissions.
- **Labels on the issue, no label rows in changelog**: the metric stays **N/A**; see **`diagnostic`** in `--json` output. Typical causes: issue created with labels, import, or tooling that did not emit label change items.
- **Truncated changelog**: if `changelog.total` > number of `histories` returned after merge, warn; reconcile in Jira UI or verify DC pagination behavior for your version.
- **Negative / inconsistent span**: if `t(review)` &lt; `t(spec)`, the human summary reports **INVALID**, **`duration_hours_wall`** is omitted (**`null`**) so batch sums skip it, while **`duration_human`** may still show the signed span in JSON for debugging.
- **Credentials**: PATs behave like secrets; keep them in a **user-chosen** local file (typically gitignored), not in the repo or ticket descriptions. Do **not** invent paths: resolve `--env-file` from `~/.cursor/mcp.json` first; if that fails, ask the user.
- **Permissions**: read-only; never call `jira_transition_issue` or label update APIs as part of this skill.

## Example prompts

- “Spec to review lead time for OCTOPUS-10820”
- “How long from bot-cx-ai-spec to code review on CAT-4045?”
- “When did spec and code-review labels first appear on PROJ-1?”
- “Lead time for all issues with both SSD labels from 2026-03-01 to 2026-03-20, and the total hours”
- “Batch spec→review by `updated` between fecha desde y hasta”
