# RAG Knowledge Base Server

Local RAG server that indexes documents (PDF, DOCX, TXT, MD) from `~/.free-code/knowledgeBase/<kb>/` and exposes a query API for the `free-code` RAG skill.

---

## Quick Start

```bash
pip3 install -r requirements.txt
python3 main.py
```

The server starts on **`localhost:8085`**. API docs at http://localhost:8085/docs

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
python3 main.py
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

The Docker setup mounts `~/.free-code/knowledgeBase` and `faiss_store/` from the host.

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
