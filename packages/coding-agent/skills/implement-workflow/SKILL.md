---
name: implement-workflow
description: "Implements code from plan-{issue_key}.md. Use when the user runs /implement or asks to implement after plan. Before any git or code: resolve plan Execution Plan BLOCKING steps in order—phrases like implement {issue_key} or /implement only start the skill; they do not waive step 1 Jira transition. Requires mcp-atlassian and git. Prerequisite: plan-{issue_key}.md exists. Phase 2 is commit-and-push-issue."
---

# Implement Workflow

## Invocation Rules

When invoked (e.g. via `/implement` or "implement {issue_key}"):

- **Required**: `{issue_key}` (e.g. OCTOPUS-10820). If missing, ask which issue to implement.
- **Routing**: Call `jira_get_issue` to confirm the ticket.
- **Prerequisite**: `<repository>/analysis/plan-{issue_key}.md` must exist. If not, abort with a clear message to run plan workflow first.
- **Critical**: Execute only Phase 1. Do not run commit, push, PR, or Jira code-review actions—those belong to **commit-and-push-issue** after this skill completes.
- **BLOCKING checkpoints**: Read `plan-{issue_key}.md` and treat any **BLOCKING** step, **MANDATORY checkpoint**, or equivalent (e.g. “stop and ask the user”) as a hard stop. The next work starts only after the user has explicitly decided (picked a transition, confirmed a command, etc.). This rule overrides casual follow-ups—see below.

---

## Debunk a common mistake (read this before acting)

**Wrong inference:** “The user said e.g _implement JIRA-1234_ (or `/implement`), so they want technical work now—I can go straight to git checkout and coding.”

**Correct rule:** That wording only **opens** this skill. It does **not** satisfy **Execution Plan step 1** (or any other BLOCKING row) in `plan-{issue_key}.md`. Plan-workflow almost always puts **Jira transition (BLOCKING)** as step 1; you must treat that as **pending** until the user picks a transition (or explicitly opts out if your process allows **no transition this run**).

If you skip step 1 and start git or codegen, you violated both this skill and the plan, even though the user sounded “action-oriented.”

---

## Pre-flight gate (before git, branch, or code)

Right after you load `plan-{issue_key}.md` (and optionally `jira_get_issue` for context):

1. **Scan** the plan’s **Execution Plan** (or equivalent ordered table) **from step 1 upward**.
2. **Identify** the first **BLOCKING** / **MANDATORY checkpoint** you have **not** yet cleared in this session.
3. **If one exists**, your **next user-facing turn** must be **only** that checkpoint’s interaction—typically:
   - current Jira status (from issue or transition context),
   - `jira_get_transitions` for `{issue_key}`,
   - present choices per **jira-transition** skill: **AskQuestion** (questionnaire) as **primary** when available; **numbered chat list** only as **fallback** when AskQuestion is unavailable,
   - a clear ask: which transition to apply, **or** explicit instruction to skip transition **only if** the team allows it.
4. **Forbidden until that checkpoint is cleared**: `git checkout`, `git pull`, `git switch`, new branch creation, editing product code, installs, code generation, refactors—**any** “implementation” work.

After the user answers and you apply `jira_transition_issue` (or record an allowed skip), move to the **next** plan step and repeat: if the next step is BLOCKING, stop again before git/code.

---

## Execution Plan table — respect BLOCKING (typical six-step shape)

Plans from **plan-workflow** often include an **Execution Plan** table like the one below. **Your job is to follow the plan’s actual table** and **BLOCKING** when step request, no matter what the user said to start the session.
E.G:
| Action | Command / description |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jira transition (BLOCKING)** | Ask the user which workflow transition to apply to `{issue_key}`; call `jira_get_transitions`; present options via **AskQuestion** per **jira-transition** skill (fallback: numbered list in chat); run `jira_transition_issue` **only** after an **explicit** choice (or an explicit team-approved “no transition this run”). |
| **Pre-dev commands (BLOCKING)** | Ask whether to run any command **before** implementation (e.g. `npm ci`, env setup). **Wait** for the answer; run only what the user approves. |
| **Post-dev commands (BLOCKING)** | Ask whether to run any command **after** implementation. **Wait** for the answer. |

---

## Mandatory BLOCKING checkpoints (special attention)

Pay **more** attention here than to any other part of the skill. If the plan marks a checkpoint as blocking, **it does not matter** what the user said earlier or how eager they sound to move on: **you must still stop**.

- **STOP**: At each BLOCKING / mandatory checkpoint, halt implementation, present the choices or question from the plan, and **wait** for the user’s explicit answer or selection.
- **Do not infer skip**: Phrases like “continue”, “proceed”, “resume”, “go ahead”, “next”, “continua”, or “siguiente” **do not** waive a BLOCKING step you have not yet resolved. **Neither does** “implement {issue_key}”, “run implement”, or `/implement`. Only continue **after** that checkpoint is actually satisfied (for example, the user chose a Jira transition and you applied it via mcp-atlassian, or the user answered a required pre/post command question).
- **Jira transitions** at BLOCKING steps: use **jira-transition** skill / `jira_get_transitions`, show options (**AskQuestion** when available; fallback per that skill), wait for the user’s pick, then `jira_transition_issue`—same pattern as plan-workflow.
- **One checkpoint at a time**: After the user clears one BLOCKING step, advance to the next plan item. Do not assume later BLOCKING steps are “already approved.”
- **If the plan is silent on blocking**: Still stop before irreversible or workflow-sensitive actions (e.g. first Jira move to In Dev, optional pre/post commands if the constitution or plan implies user confirmation) and ask if unsure.

---

## Scope

Inside `<repository>/analysis/`, implement the plan whose filename matches (or partially matches) `{issue_key}`.

Execute the plan in the order it defines; do not skip or reorder mandatory blocks. **BLOCKING rows always take precedence** over speed or implicit continuation.

### Critical — do NOT execute

Do **not** run:

- `git add`
- `git commit`
- `git push`
- Create PR

**End state**: `git status` must show changes **not staged** (unstaged working tree). The user runs commit-and-push when ready.

### Plan table phases

If `plan-{issue_key}.md` includes an "Implementation Plan" table with a **Phase** column, execute **only** rows marked **`/implement`**. Ignore `/commitAndPush` rows during this skill.

---

## Repository and conventions

- Resolve `<repository>` from the issue and workspace (same pattern as specify-workflow and plan-workflow).
- If `<repository>/AGENT.md` exists, read it and align implementation with project conventions.
- Respect plan references to patterns, modules, and Sonar/testing gates.

---

## Relationship to other SSD skills

| Phase                      | Skill / command       |
| -------------------------- | --------------------- |
| Spec                       | specify-workflow      |
| Plan                       | plan-workflow         |
| **Implement (this skill)** | `/implement`          |
| Commit / PR / code review  | commit-and-push-issue |

After this skill completes successfully, the user should run **commit-and-push-issue** (or `/commitAndPush`) for the same `{issue_key}` when they are ready to open a PR.
