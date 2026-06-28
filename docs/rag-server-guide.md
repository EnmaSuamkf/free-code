# RAG Server Guide

Local knowledge base system for free-code. Index your documents, GitHub repos, and files so the agent can search them during conversations.

For agent-side behavior and HTTP emulation map, see [`packages/coding-agent/skills/rag/SKILL.md`](../packages/coding-agent/skills/rag/SKILL.md).

---

## Quick Start

```bash
# 1. Start the RAG server (default port 8085)
free-code-rag

# 2. Create a knowledge base
/rag-kb create my-kb

# 3. Select it
/rag-kb use my-kb

# 4. Add documents
/rag addFile /path/to/doc.md
/rag addGroup /path/to/folder
/rag addGithubUrl https://github.com/org/repo docs/
/rag addDrive https://docs.google.com/document/d/...

# 5. Search
/rag search "how does authentication work?"
```

---

## Slash Commands

### KB Management — `/rag-kb`

Manage knowledge base namespaces. You must select a KB before using any `/rag` command.

| Command | Description |
|---|---|
| `/rag-kb create <name>` | Creates a new KB namespace |
| `/rag-kb delete <name>` | Deletes a KB and its index |
| `/rag-kb use <name>` | Selects the active KB for this session |
| `/rag-kb list` | Lists all available KBs |

KB names: letters, numbers, `-` and `_` only (max 64 chars).

---

### Document Management — `/rag`

All `/rag` commands require an active KB (`/rag-kb use <name>` first).

#### Adding documents

**`/rag addFile <path>`**

Copies a local file into the active KB and indexes it.

```
/rag addFile /Users/me/docs/api-reference.md
/rag addFile ./README.md
```

Supported types: `.pdf`, `.doc`, `.docx`, `.md`, `.txt`

Special: files ending in `.knowledge.md` are stored on disk for `GET /discover` but are **not** included in vector search results — use them as metadata overviews.

---

**`/rag addGroup <folder>`**

Indexes all supported files from a local folder (non-recursive).

```
/rag addGroup /Users/me/project/docs
```

---

**`/rag addGithubUrl <url> [subpath]`**

Clones a GitHub repo and indexes its files. Optionally target a specific subdirectory instead of the repo root.

```
# Index root-level files
/rag addGithubUrl https://github.com/org/repo

# Index only a subdirectory
/rag addGithubUrl https://github.com/org/repo docs/
/rag addGithubUrl https://github.com/org/repo src/guides/api
```

The URL and subpath are saved to `sources.json` so `/rag refresh` can re-index them later. The cloned repo is deleted after indexing.

---

**`/rag addDrive <google_drive_url>`**

Downloads a Google Drive document via `agent_browser` and indexes it directly into the active KB. The agent asks which format to download (PDF, DOCX, or TXT), downloads the file, copies it into `~/.free-code/knowledgeBase/<kb>/`, and calls `POST /addkb` to index it.

```
/rag addDrive https://docs.google.com/document/d/...
```

Requirements: Chrome debug session must be running and logged in to Google (`agent_browser` / CDP on port 9222). RAG server must be running.

Supported output formats: `.pdf`, `.docx`, `.txt`

---

#### Viewing and removing

**`/rag list`** — Lists all files currently indexed in the active KB.

**`/rag remove <filename>`** — Removes a file from the KB and rebuilds the index.

```
/rag remove api-reference.md
```

---

#### Searching

**`/rag search <query>`** — Performs a similarity search against the active KB and sends the results to the agent as context.

```
/rag search "rate limiting policies"
/rag search "how to configure authentication"
```

---

#### Keeping the KB up to date

**`/rag refresh`**

Re-fetches and re-indexes all sources that were registered via `/rag addFile` and `/rag addGithubUrl`. Useful when the upstream GitHub repo or local files have changed.

```
/rag refresh
```

Requires at least one tracked source. If the KB has no sources registered, you'll get a message explaining that.

---

**`/rag schedule [option]`**

Sets up a recurring automatic refresh for the active KB. **Requires the KB to have at least one GitHub source** registered (added via `/rag addGithubUrl`).

```
/rag schedule            # show current schedule status
/rag schedule daily      # refresh every day at ~9am
/rag schedule weekly     # refresh every Monday at ~9am
/rag schedule hourly     # refresh every hour
/rag schedule "0 9 * * 1-5"  # custom 5-field cron expression (weekdays at 9am)
/rag schedule off        # cancel the active schedule
```

Preset cron expressions:

| Preset | Cron | When |
|---|---|---|
| `hourly` | `7 * * * *` | Every hour |
| `daily` | `57 8 * * *` | Every day at ~9am |
| `weekly` | `57 8 * * 1` | Every Monday at ~9am |

> **Note:** Scheduled jobs auto-expire after 7 days. Run `/rag schedule daily` again to renew.

The schedule configuration (including the cron expression and job ID) is stored in `sources.json` alongside the tracked sources.

---

## Source Tracking

When you add documents via `/rag addFile` or `/rag addGithubUrl`, free-code records the origin in a `sources.json` file inside the KB directory (`~/.free-code/knowledgeBase/<kb>/sources.json`). This file is what powers `/rag refresh` and `/rag schedule`.

Example `sources.json`:

```json
{
  "sources": [
    {
      "type": "github",
      "url": "https://github.com/org/repo",
      "subPath": "docs/",
      "addedAt": "2026-05-20T09:00:00.000Z",
      "lastRefreshedAt": "2026-05-20T09:15:00.000Z"
    },
    {
      "type": "file",
      "sourcePath": "/Users/me/docs/api-reference.md",
      "addedAt": "2026-05-20T08:30:00.000Z"
    }
  ],
  "schedule": {
    "cron": "57 8 * * *",
    "preset": "daily",
    "cronJobId": "job-abc-123",
    "createdAt": "2026-05-20T09:00:00.000Z"
  }
}
```

`sources.json` is not indexed by the RAG server and does not appear in `/rag list`.

---

## File Locations

| Path | Purpose |
|---|---|
| `~/.free-code/knowledgeBase/<kb>/` | KB documents directory |
| `~/.free-code/knowledgeBase/<kb>/sources.json` | Source tracking and schedule config |
| `~/.free-code/faiss_store/` | Default FAISS vector index location |

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `FREE_CODE_RAG_SERVER_URL` | `http://localhost:8085` | RAG server base URL |
| `FREE_CODE_RAG_MAX_CHUNKS` | `3` | Max chunks returned per query |
| `FREE_CODE_RAG_MAX_CHARS` | `3000` | Max total characters returned per query |
| `FAISS_PERSIST_DIR` | `~/.free-code/faiss_store` | Override FAISS index directory |

---

## API Reference

The server runs on `localhost:8085`. All POST endpoints use `Content-Type: application/json`.

### `GET /health`

Liveness/readiness check. Returns server status and runtime info.

---

### `GET /kbs`

Returns all KB names.

```json
{ "knowledge_bases": ["my-kb", "team-docs"] }
```

---

### `POST /createkb`

Creates a KB namespace.

```json
// Request
{ "kb": "my-kb" }

// Response (200)
{ "status": "ok", "message": "...", "kb": "my-kb" }
```

---

### `POST /deletekb`

Deletes a KB and its vector index.

```json
// Request
{ "kb": "my-kb" }

// Response (200)
{ "status": "ok", "message": "...", "kb": "my-kb" }
```

---

### `POST /addkb`

Indexes a file that has already been copied to `~/.free-code/knowledgeBase/<kb>/`.

```json
// Request
{ "filename": "api-reference.md", "kb": "my-kb" }

// Response (200)
{ "status": "ok", "message": "...", "chunks": 42, "kb": "my-kb" }
```

**Error codes:**
- `422` — `filename` missing or empty
- `404` — file not found in the KB directory
- `400` — invalid filename (path traversal attempt) or unsupported extension
- `409` — indexing already in progress
- `500` — indexing failed (embedding error, corrupted PDF, FAISS dimension mismatch)

> **FAISS dimension mismatch:** Delete `~/.free-code/faiss_store` (or the path in `FAISS_PERSIST_DIR`) and retry.

Files ending in `.knowledge.md` are accepted but **not** vector-indexed — they are stored on disk for `GET /discover` only.

---

### `POST /removekb`

Removes a file from the KB and rebuilds the index.

```json
// Request
{ "filename": "api-reference.md", "kb": "my-kb" }

// Response (200)
{ "status": "ok", "message": "...", "chunks": 38, "kb": "my-kb" }
```

---

### `GET /query`

Similarity search within a KB.

```
GET /query?text=rate+limiting&kb=my-kb&top_k=3
```

```json
// Response (200)
{ "results": ["chunk1 text...", "chunk2 text...", "chunk3 text..."] }
```

`*.knowledge.md` content is excluded from results even if older indexes contain it.

---

### `GET /discover`

Returns the text of all `*.knowledge.md` files in a KB — used for metadata overviews, not for search.

```
GET /discover?kb=my-kb
```

```json
// Response (200)
{
  "kb": "my-kb",
  "files": [
    { "filename": "overview.knowledge.md", "content": "...", "truncated": false }
  ],
  "truncated": false,
  "message": ""
}
```

Returns `404` on older server versions that don't support this endpoint — clients should handle this gracefully.
