# RAG Knowledge Base Server

Local RAG server that indexes documents (PDF, DOCX, TXT, MD) from `~/.free-code/knowledgeBase/<kb>/` and exposes a query API for the `free-code` RAG skill.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | 3.12 is what the Docker image uses |
| `python3-venv` | Debian/Ubuntu: `sudo apt-get install python3-venv` |
| ~3 GB free disk | `torch` + `sentence-transformers` wheels |
| Network access | First run downloads the `all-MiniLM-L6-v2` embedding model from Hugging Face |

---

## Quick Start

Install into a **virtual environment**. A bare `pip3 install` fails with
`error: externally-managed-environment` (PEP 668) on Debian/Ubuntu and on
Homebrew Python:

```bash
cd free-code-rag
make venv     # creates .venv and installs requirements.txt
make start    # runs .venv/bin/python main.py
```

Equivalent by hand:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python main.py
```

The server starts on **`localhost:8085`**. API docs at http://localhost:8085/docs

Verify it is up:

```bash
curl http://localhost:8085/health
```

> **You usually do not need to start this by hand.** When `free-code` starts, it
> auto-launches this server if it finds `free-code-rag/` next to the checkout and
> nothing is already listening on the RAG URL. It prefers `.venv/bin/python`, so
> creating the venv above is what makes auto-start reliable. Set
> `FREE_CODE_RAG_SERVER_AUTO=0` to disable auto-start.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address (`main.py`) |
| `PORT` | `8085` | Listen port (`main.py`) |
| `RELOAD` | `false` | uvicorn auto-reload |
| `FAISS_PERSIST_DIR` | `~/.free-code/faiss_store` | Vector index location (`src/api.py`) |

The client side (`free-code`) is pointed at this server with
`FREE_CODE_RAG_SERVER_URL` (default `http://localhost:8085`).

---

## API

### `GET /health`

```bash
curl http://localhost:8085/health
```

Returns server status, index info, and knowledge base directory path.

### `GET /kbs`

List known knowledge-base namespaces.

```bash
curl http://localhost:8085/kbs
```

### `POST /createkb`

Create an empty KB namespace.

```bash
curl -X POST http://localhost:8085/createkb \
  -H "Content-Type: application/json" \
  -d '{"kb": "team-docs"}'
```

### `POST /deletekb`

Delete a KB namespace (documents + FAISS index).

```bash
curl -X POST http://localhost:8085/deletekb \
  -H "Content-Type: application/json" \
  -d '{"kb": "team-docs"}'
```

### `POST /addkb`

Index a specific file from `~/.free-code/knowledgeBase/<kb>/`.

```bash
curl -X POST http://localhost:8085/addkb \
  -H "Content-Type: application/json" \
  -d '{"filename": "my-doc.pdf", "kb": "team-docs"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | string | yes | Name of the file in the selected KB directory |
| `kb` | string | recommended | Knowledge-base namespace |

**Response:**

```json
{"status": "ok", "message": "Indexed 'my-doc.pdf' in KB 'team-docs' (3 chunk(s))", "chunks": 3, "kb": "team-docs"}
```

### `GET /query?text=<question>&kb=<knowledge-base>`

Similarity search against indexed documents.

```bash
curl "http://localhost:8085/query?text=how+to+configure+workflows&top_k=3&kb=team-docs"
```

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | string | required | The search query |
| `top_k` | int (1-20) | 5 | Maximum number of results |
| `kb` | string | required in client workflows | Knowledge-base namespace |

**Response:**

```json
{"results": ["chunk1 text...", "chunk2 text..."]}
```

### `GET /discover?kb=<knowledge-base>`

Returns contents of all `*.knowledge.md` sidecar files under that KB (metadata overview; not included in vector `/query` results).

```bash
curl "http://localhost:8085/discover?kb=team-docs"
```

---

## Workflow

### 1. Add files to a knowledge base

Place PDF, DOCX, TXT or MD files in `~/.free-code/knowledgeBase/<kb>/`:

```bash
mkdir -p ~/.free-code/knowledgeBase/team-docs
cp my-docs/*.pdf ~/.free-code/knowledgeBase/team-docs/
```

### 2. Start the server

```bash
make start
```

The server loads existing per-KB indexes on startup.

### 3. Index a file

```bash
curl -X POST http://localhost:8085/addkb \
  -H "Content-Type: application/json" \
  -d '{"filename": "my-doc.pdf", "kb": "team-docs"}'
```

### 4. Query

```bash
curl "http://localhost:8085/query?text=your+question+here&kb=team-docs"
```

---

## Docker

```bash
make docker-dev
```

The Docker setup mounts `~/.free-code/knowledgeBase` and `faiss_store/` from the host
and publishes port 8085.

Behind a corporate TLS-inspecting proxy the image build fails on `pip install` with a
certificate error. See the comment block at the bottom of `docker-compose.dev.yml` for
the `CA_BUNDLE` override that supplies your CA bundle.

---

## Architecture

```
~/.free-code/knowledgeBase/
  ├── team-docs/
  │   ├── doc1.pdf
  │   └── notes.md
  └── product/
      └── doc2.docx
        │
        ▼
  POST /addkb(kb=...) → load → chunk → embed → faiss_store/<kb>/faiss.index + metadata.pkl
                                              │
                                              ▼
                           GET /query?text=...&kb=... → encode → search → results
```

- **Load:** PDF (pymupdf/pypdf), DOCX (python-docx), TXT/MD (langchain)
- **Chunk:** RecursiveCharacterTextSplitter (1000 chars, 200 overlap)
- **Embed:** sentence-transformers (all-MiniLM-L6-v2)
- **Store:** FAISS (IndexFlatL2)
- **Search:** Cosine similarity with distance threshold filtering

## Project Structure

```
src/
├── api.py          # FastAPI (GET /kbs, POST /createkb, POST /deletekb, POST /addkb, POST /removekb, GET /query, GET /discover, GET /health)
├── data_loader.py  # Load PDF/DOCX/TXT/MD from knowledge base
├── embedding.py    # EmbeddingPipeline (chunk + embed)
├── vectorstore.py  # FaissVectorStore (persist + query)
└── search.py       # RAGSearch (high-level search)
```

## Supported File Types

| Extension | Library |
|-----------|---------|
| `.pdf` | pymupdf (fitz) / pypdf |
| `.docx` | python-docx |
| `.doc` | python-docx |
| `.txt` | langchain TextLoader |
| `.md` | langchain TextLoader |
