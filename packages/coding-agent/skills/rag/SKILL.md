---
name: rag
description: "Handles ANY request to search, find, or look up information — including generic phrasing like 'search for X', 'find info about X', 'tell me about X', 'who is X' — by querying the local RAG server HTTP API first (GET /query on localhost:8085). Also handles adding, removing, and listing documents in ~/.free-code/knowledgeBase/. CRITICAL: /rag commands are internal TUI slash commands — NEVER run them in a shell. The agent must call the RAG server API directly or operate on the KB directory."
---

# RAG (retrieval-augmented generation)

## CRITICAL — /rag is NOT a shell command

`/rag-kb create|delete|use|list`, `/rag addFile`, `/rag addGroup`, `/rag search`, `/rag list`, `/rag remove` are **internal free-code TUI slash commands**. They only work when a **human user** types them in the free-code chat input.

**As an agent, you MUST NOT:**

- Run `/rag ...` in a shell (bash, zsh) — it will fail with `/bin/bash: /rag: No such file or directory`
- Attempt to send `/rag ...` as a shell command via any tool

**Instead, perform the equivalent operation directly** using the HTTP API or filesystem, as described below.

### HTTP API ↔ TUI commands (full emulation map)

Base URL: `http://localhost:8085` (override with `FREE_CODE_RAG_SERVER_URL`). On disk, each KB is a folder: `~/.free-code/knowledgeBase/<KB>/`. Use the same `<KB>` string in JSON bodies and query parameters.

| TUI command | Emulate with |
| --- | --- |
| `/rag-kb list` | `GET /kbs` — JSON shape `{ "knowledge_bases": ["..."] }` |
| `/rag-kb create <name>` | `POST /createkb` — body `{"kb":"<name>"}` |
| `/rag-kb delete <name>` | `POST /deletekb` — body `{"kb":"<name>"}` |
| `/rag-kb use <name>` | **No HTTP route** — remember `<name>` as the active `<KB>` for this session for every `kb` field; optionally `GET /discover?kb=<name>` to load `*.knowledge.md` overviews (404 on older servers: skip overview). |
| `/rag search <query>` | `GET /query?text=<query>&kb=<KB>&top_k=3` — **`kb` is required** for correct retrieval; the host UI remembers the KB after `/rag-kb use`, but when you call HTTP yourself you must supply the same string (resolve per “Query strategy” in this skill). |
| `/rag addFile <path>` | Copy the file into `~/.free-code/knowledgeBase/<KB>/`, then `POST /addkb` — body `{"filename":"<basename>","kb":"<KB>"}` |
| `/rag addGroup <folder>` | Same as add-file for each supported file under the folder (default: non-recursive unless the user specifies recursive) |
| `/rag addGithubUrl <url> [subpath]` | `git clone --depth 1 <url>` into a temp dir, then apply add-group flow on `subpath` (defaults to repo root if omitted); temp dir is deleted after indexing; source is registered in `sources.json` |
| `/rag refresh` | Re-fetches all sources registered in `sources.json` (GitHub URLs and local file paths) and re-indexes them |
| `/rag schedule [daily\|weekly\|hourly\|<cron>\|off]` | Sets up a durable cron job (via CronCreate) to auto-refresh GitHub sources. Only works if the KB has at least one GitHub source. Auto-expires after 7 days. No arg = show current schedule. `off` = cancel. |
| `/rag list` | List `~/.free-code/knowledgeBase/<KB>/` (e.g. `ls`); use `GET /kbs` first if you need valid KB names |
| `/rag remove <filename>` | Remove `~/.free-code/knowledgeBase/<KB>/<filename>`, then `POST /removekb` — body `{"filename":"<basename>","kb":"<KB>"}` |

Other endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | Readiness / liveness before RAG work |
| `/discover` | `GET` | `?kb=<KB>` — all `*.knowledge.md` contents for KB overview (not returned by `/query`) |

Full contract (status codes, errors, sidecar indexing rules): `docs/rag-server-spec.md`.

---

## Invocation Rules

**This skill triggers on ANY information lookup request**, not only when the user explicitly says "knowledge base" or "internal docs". The RAG knowledge base is the **default source of truth** when the user asks to search, find, or look up information.

Trigger when the user says things like:

- "search for X" / "find information about X" / "look up X"
- "tell me about X" / "who is X" / "what do we know about X"
- "busca informacion sobre X" / "dime sobre X" / "quien es X"
- Any phrasing that requests factual lookup, even without mentioning "knowledge base", "KB", "docs", or "RAG"

**Do NOT trigger** only when:

- The user explicitly says "search the **web**" or "Google this"
- The user asks about a general concept unrelated to their organization (e.g., "explain what RAG means in AI")
- The request is clearly about code, git, Jira, or another tool — not an information lookup

**Default behavior:** When in doubt, **query the RAG server first**. If it returns no results or is unreachable, then fall back to general knowledge and tell the user.

### Query strategy (max 3 queries)

When the user asks a question, **you decide which queries to run** against the RAG server. Break the user's request into the most important angles and issue up to **3 separate queries** (never more). Each query should target a different facet of the question to maximize coverage.

**Resolving `kb` for every `GET /query`:** The HTTP API expects `kb=<namespace>`. The host remembers the KB when the **human** runs `/rag-kb use <name>` in the chat UI, but **you do not receive that as a hidden session variable** unless it appears in the visible transcript (for example after a successful `GET /discover`, the injected overview names the KB in its header) or the user states the KB name. If you are unsure which KB to use:

1. Prefer the KB name the user explicitly mentioned or just selected.
2. If the `get_active_profile` tool is available, its `RAG KB:` line reflects the KB stored on the **saved profile** — it may match the current session or lag until the user saves the profile after `/rag-kb use`.
3. Otherwise call `GET /kbs` and pick the only KB if there is exactly one; if there are several, **ask the user** which namespace to query (do not guess).

**Example:** User asks "tell me about Pablo Castaneda and his team" and the active KB is `people-docs` (known from context or resolved via the steps above)

1. `GET /query?text=Pablo+Castaneda&kb=people-docs&top_k=3` — direct lookup on the person
2. `GET /query?text=OCTOPUS+team+members&kb=people-docs&top_k=3` — lookup on the team
3. (optional third query only if needed)

**Rules:**

- **Minimum 1 query, maximum 3 queries** per user request.
- **Always** include `kb=` on every `GET /query` URL (same string as the folder name under `~/.free-code/knowledgeBase/`). Omitting `kb` is incorrect when teaching or constructing examples.
- You choose the query text — rephrase, simplify, or split the user's question into effective search terms.
- Run all queries, collect all returned chunks, then **synthesize a single answer** grounded in the combined results.
- Cite which chunk `[N]` from which query supports each claim.
- If all queries return empty results, say the knowledge base has no information on the topic.
- If the server is unreachable, tell the user: server base `http://localhost:8085` (override `FREE_CODE_RAG_SERVER_URL`), KB dir `~/.free-code/knowledgeBase/`.

---

## Natural language → agent action (mandatory routing)

| User intent (examples) | Agent action |
| --- | --- |
| Create/delete/select/list knowledge bases (`/rag-kb create/delete/use/list`) | **KB management**: manage KB namespaces and set active KB for subsequent `add/search/list/remove` |
| Add / include / put this document in the knowledge base; index this file | **Add file**: copy file to `~/.free-code/knowledgeBase/`, then `POST /addkb` (see below) |
| Add all supported docs from a folder | **Add group**: iterate files in folder and apply add-file flow to each supported file |
| Add docs from a GitHub repo (`/rag addGithubUrl <url> [subpath]`) | **Add GitHub URL**: clone the repo to a temp dir, apply add-group on `subpath` (or root if omitted), delete temp dir; registers source in `sources.json` |
| Refresh / sync / update the knowledge base | **Refresh**: re-fetches all tracked sources from `sources.json` and re-indexes them |
| Schedule automatic refresh / auto-update KB / cron for KB | **Schedule**: `/rag schedule daily\|weekly\|hourly\|<cron>` — requires at least one GitHub source; creates a durable CronCreate job. `/rag schedule off` cancels it. |
| Remove / delete this document from the knowledge base | **Remove**: delete file from `~/.free-code/knowledgeBase/`, then `POST /removekb` (see below) |
| What documents are in the knowledge base? List KB files | **List**: list files in `~/.free-code/knowledgeBase/` |
| Search / find / look up information about "X"; tell me about X; who is X; any factual lookup | **Query**: `GET /query?text=...` on the RAG server, then answer grounded in retrieved chunks (vector chunks only; not `*.knowledge.md`) |
| Understand what a KB covers after switching KB | **Discover**: `GET /discover?kb=...` — read all `*.knowledge.md` metadata files for that namespace |

---

## How to execute each action

### Query (equivalent of `/rag search <query>`)

For each query you decide to run:

```bash
curl -s "http://localhost:8085/query?text=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' '<QUERY>')&kb=<KB>&top_k=3"
```

Replace `<KB>` with the real namespace (see **Resolving `kb` for every `GET /query`** above). The placeholder is not optional in real requests.

- Server returns JSON: `{ "results": ["chunk1", "chunk2", ...] }`. These snippets never include text from `*.knowledge.md` sidecars (metadata only; use `/discover` for those).
- Run **1 to 3 queries** (you choose the terms), then combine all chunks into a single grounded answer.
- Cite which chunk `[N]` supports each claim.
- If the server is unreachable or returns an error, tell the user the RAG server may not be running.
- Respect limits per query: max 3 chunks, max 3000 total characters (truncate if needed).

### KB management (equivalent of `/rag-kb create/delete/use/list`)

1. List known KBs: `GET /kbs`.
2. Create KB: `POST /createkb` with `{ "kb": "<KB>" }`.
3. Delete KB: `POST /deletekb` with `{ "kb": "<KB>" }`.
4. Ask the user to select one when no active KB is set.
5. Do not assume a default KB in the client session.
6. After the user (or host) selects a KB (`/rag-kb use`), clients may call **`GET /discover?kb=<KB>`** and pass the returned `*.knowledge.md` contents to the model as session context. If the server responds **404** (older binary without `/discover`), skip the overview silently.

### Discover (metadata overview)

```bash
curl -s "http://localhost:8085/discover?kb=<KB>"
```

- Response JSON: `{ "kb": "...", "files": [ { "filename": "...", "content": "...", "truncated": false } ], "truncated": false, "message": "..." }`.
- Use when you need KB scope/topics without running vector search.

### Add file (equivalent of `/rag addFile <path>`)

1. Verify file exists and has an allowed extension (`.pdf`, `.doc`, `.docx`, `.md`, `.txt`).
2. Ensure an active KB is selected first.
3. Copy the file into `~/.free-code/knowledgeBase/<KB>/`, then call `POST /addkb` with that basename. The server vector-indexes supported primaries; `*.knowledge.md` is accepted and stored but not indexed for similarity search.
4. Optional: add a **`<stem>.knowledge.md`** sidecar in the same folder if you want discoverable metadata (`GET /discover`); it is not required for adding the primary.
5. If a file with the same name already exists in the KB dir, the client replaces it per its own rules, then re-indexes.

```bash
curl -s -X POST http://localhost:8085/addkb -H "Content-Type: application/json" -d '{"filename":"<BASENAME>","kb":"<KB>"}'
```

### Add group (equivalent of `/rag addGroup <folder>`)

1. Ensure an active KB is selected first.
2. Iterate files in the folder (non-recursive unless specified by user).
3. For each supported file, execute the Add-file flow (one file per `POST /addkb`).
4. Return a summary: added / skipped / failed.

### List (equivalent of `/rag list`)

```bash
ls ~/.free-code/knowledgeBase/<KB>/
```

### Remove (equivalent of `/rag remove <filename>`)

1. Delete the file from `~/.free-code/knowledgeBase/<KB>/<filename>` (basename only, no paths with `/` or `..`).
2. Optionally notify:

```bash
curl -s -X POST http://localhost:8085/removekb -H "Content-Type: application/json" -d '{"filename":"<BASENAME>","kb":"<KB>"}'
```

---

## Allowed file types (add)

The `rag-manager` extension accepts: **`.pdf`**, **`.doc`**, **`.docx`**, **`.md`**, **`.txt`**, and **`*.knowledge.md`** (metadata sidecars; not included in `GET /query` results).

If the user asks to add another type, say it is not supported and suggest converting to a supported format (or using `.md` / `.txt` for plain text).

---

## RAG server

- Default URL: `http://localhost:8085`
- Override: environment variable `FREE_CODE_RAG_SERVER_URL`

The server watches `~/.free-code/knowledgeBase/`, indexes documents, and serves `GET /health`, `GET /kbs`, `POST /createkb`, `POST /deletekb`, `POST /addkb`, `POST /removekb`, `GET /query`, and `GET /discover`. See `docs/rag-server-spec.md`.

---

## Workflow (typical)

1. Ensure the RAG server is running.
2. **Add documents:** copy file to KB dir + `POST /addkb`.
3. **Query:** Decide the best 1–3 queries to answer the user's question. Run each as `GET /query?text=...&kb=<KB>&top_k=3` (see the emulation map above).
4. **Synthesize:** Combine all returned chunks into a single answer. **Cite** which excerpt `[N]` supports each claim.

---

## Relationship to repository docs

| Topic | Location |
| ----- | -------- |
| Server API and behavior | `docs/rag-server-spec.md` |
| Product vision / roadmap | `docs/rag-feature-vision.md` |
