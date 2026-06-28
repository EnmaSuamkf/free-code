"""
FastAPI RAG Knowledge Base server.

Endpoints:
  POST /createkb   - Create KB directories for a namespace
  POST /deletekb   - Delete a KB namespace (files + index)
  POST /addkb     - Index one file: JSON body {"filename": "<basename>", "kb": "<knowledge-base>"}
  POST /removekb  - Remove one indexed file from a KB and rebuild that KB index
  GET  /query     - Similarity search: ?text=<question>&kb=<knowledge-base>
  GET  /discover  - List *.knowledge.md metadata files for a KB (not vector-indexed)
  GET  /kbs       - List known knowledge bases
  GET  /health    - Health check
"""
import logging
import os
import re
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel

from src.data_loader import (
    SUPPORTED_EXTENSIONS,
    get_knowledge_base_dir,
    is_knowledge_metadata_filename,
    is_knowledge_metadata_source,
    is_knowledge_sidecar_chunk_content,
    load_all_documents,
    load_file,
)
from src.vectorstore import FaissVectorStore

logger = logging.getLogger("rag-server")

_DEFAULT_PERSIST_DIR = os.path.join(os.path.expanduser("~"), ".free-code", "faiss_store")
PERSIST_DIR = os.environ.get("FAISS_PERSIST_DIR", _DEFAULT_PERSIST_DIR)
KB_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
DEFAULT_KB = "default"

_stores: Dict[str, FaissVectorStore] = {}
_indexing_in_progress = False

# Limits for GET /discover (UTF-8 character counts after read).
_DISCOVER_MAX_CHARS_PER_FILE = 50_000
_DISCOVER_MAX_TOTAL_CHARS = 120_000


def _normalize_kb_name(kb: Optional[str]) -> str:
    value = (kb or DEFAULT_KB).strip()
    if not value:
        value = DEFAULT_KB
    if not KB_NAME_PATTERN.fullmatch(value):
        raise ValueError("Invalid knowledge base name. Use only letters, numbers, '-' or '_'.")
    return value


def _is_safe_filename(filename: str) -> bool:
    return bool(filename) and filename == os.path.basename(filename) and ".." not in filename and "/" not in filename and "\\" not in filename


def _kb_data_dir(kb: str) -> Path:
    root = get_knowledge_base_dir()
    target = (root / kb).resolve()
    root_resolved = root.resolve()
    rel = target.relative_to(root_resolved)
    if ".." in str(rel):
        raise ValueError("Invalid knowledge base path")
    target.mkdir(parents=True, exist_ok=True)
    return target


def _kb_persist_dir(kb: str) -> str:
    target = os.path.join(PERSIST_DIR, kb)
    os.makedirs(target, exist_ok=True)
    return target


def _kb_persist_path_only(kb: str) -> str:
    return os.path.join(PERSIST_DIR, kb)


def _legacy_default_file_path(filename: str) -> Path:
    return get_knowledge_base_dir() / filename


def _kb_file_path(kb: str, filename: str) -> Path:
    kb_path = _kb_data_dir(kb) / filename
    if kb == DEFAULT_KB and not kb_path.exists():
        legacy_path = _legacy_default_file_path(filename)
        if legacy_path.exists():
            return legacy_path
    return kb_path


def _kb_persist_has_index(kb: str) -> bool:
    base = _kb_persist_dir(kb)
    return os.path.exists(os.path.join(base, "faiss.index")) and os.path.exists(os.path.join(base, "metadata.pkl"))


def _get_store(kb: str) -> FaissVectorStore:
    store = _stores.get(kb)
    if store is not None:
        return store
    persist = _kb_persist_dir(kb)
    store = FaissVectorStore(persist)
    if _kb_persist_has_index(kb):
        store.load()
    _stores[kb] = store
    return store


def _list_known_kbs() -> List[str]:
    kbs: Set[str] = set()
    data_root = get_knowledge_base_dir()
    if data_root.exists():
        for entry in data_root.iterdir():
            if entry.is_dir() and KB_NAME_PATTERN.fullmatch(entry.name):
                kbs.add(entry.name)
        legacy_files = [p for p in data_root.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS]
        if legacy_files:
            kbs.add(DEFAULT_KB)

    persist_root = Path(PERSIST_DIR)
    if persist_root.exists():
        for entry in persist_root.iterdir():
            if entry.is_dir() and KB_NAME_PATTERN.fullmatch(entry.name):
                faiss = entry / "faiss.index"
                meta = entry / "metadata.pkl"
                if faiss.exists() and meta.exists():
                    kbs.add(entry.name)

    if not kbs:
        return []
    return sorted(kbs)


def _create_kb_dirs(kb: str) -> None:
    _kb_data_dir(kb)
    _kb_persist_dir(kb)


def _delete_kb(kb: str) -> None:
    data_dir = _kb_data_dir(kb)
    persist_dir = _kb_persist_path_only(kb)

    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir)
    if os.path.isdir(persist_dir):
        shutil.rmtree(persist_dir)

    _stores.pop(kb, None)


def _rebuild_kb_index(kb: str) -> int:
    data_dir = _kb_data_dir(kb)
    docs = load_all_documents(str(data_dir))
    persist = _kb_persist_dir(kb)
    shutil.rmtree(persist, ignore_errors=True)
    os.makedirs(persist, exist_ok=True)
    _stores.pop(kb, None)
    if not docs:
        return 0
    store = FaissVectorStore(persist)
    store.build_from_documents(docs)
    _stores[kb] = store
    return store.index.ntotal if store.index else 0


def _run_indexing_file(filename: str, kb: str) -> dict:
    """Index a single file from the selected knowledge base directory."""
    global _indexing_in_progress
    _indexing_in_progress = True
    try:
        if not _is_safe_filename(filename):
            raise ValueError("Invalid filename: path traversal not allowed")

        file_path = _kb_file_path(kb, filename)
        if not file_path.exists():
            raise FileNotFoundError(f"File '{filename}' not found in KB '{kb}' ({file_path.parent})")

        ext = file_path.suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise ValueError(
                f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
            )

        if is_knowledge_metadata_filename(file_path.name):
            store = _get_store(kb)
            total = store.index.ntotal if store and store.index else 0
            logger.info(
                "Skipping vector index for metadata file '%s' in kb='%s' (total chunks: %d)",
                filename,
                kb,
                total,
            )
            return {
                "status": "ok",
                "message": (
                    f"Metadata file '{filename}' is stored on disk but not indexed for vector search "
                    f"(KB '{kb}'). Use GET /discover to read *.knowledge.md sidecars."
                ),
                "chunks": total,
                "kb": kb,
            }

        docs = load_file(file_path)
        if not docs:
            return {"status": "ok", "message": f"No content extracted from '{filename}'", "chunks": 0, "kb": kb}

        store = _get_store(kb)
        added = store.add_documents(docs)
        total = store.index.ntotal if store.index else 0
        logger.info("Indexed file '%s' into kb='%s' — %d chunks (total: %d)", filename, kb, added, total)
        return {
            "status": "ok",
            "message": f"Indexed '{filename}' in KB '{kb}' ({added} chunk(s))",
            "chunks": total,
            "kb": kb,
        }
    finally:
        _indexing_in_progress = False


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Preload known knowledge-base indexes if present on disk."""
    for kb in _list_known_kbs():
        try:
            _get_store(kb)
        except Exception:
            logger.exception("Failed to preload index for kb='%s'", kb)
    yield


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

app = FastAPI(
    title="RAG Knowledge Base Server",
    description="Local RAG server for ~/.free-code/knowledgeBase/",
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    body_bytes = await request.body()
    body_preview = body_bytes.decode("utf-8", errors="replace")[:200] if body_bytes else ""

    logger.info(
        "→ %s %s%s%s",
        request.method,
        request.url.path,
        f"?{request.url.query}" if request.url.query else "",
        f"  body={body_preview}" if body_preview else "",
    )

    response = await call_next(request)
    elapsed_ms = (time.time() - start) * 1000

    logger.info(
        "← %s %s %d (%.0fms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


class QueryResponse(BaseModel):
    results: List[str]


class AddKBRequest(BaseModel):
    filename: str
    kb: Optional[str] = None


class AddKBResponse(BaseModel):
    status: str
    message: str
    chunks: int
    kb: str


class RemoveKBRequest(BaseModel):
    filename: str
    kb: Optional[str] = None


class RemoveKBResponse(BaseModel):
    status: str
    message: str
    chunks: int
    kb: str


class KnowledgeBasesResponse(BaseModel):
    knowledge_bases: List[str]


class CreateKBRequest(BaseModel):
    kb: str


class DeleteKBRequest(BaseModel):
    kb: str


class KBMutationResponse(BaseModel):
    status: str
    message: str
    kb: str


class DiscoverFileEntry(BaseModel):
    filename: str
    content: str
    truncated: bool = False


class DiscoverResponse(BaseModel):
    kb: str
    files: List[DiscoverFileEntry]
    truncated: bool = False
    message: Optional[str] = None


def _discover_kb_sidecars(kb: str) -> tuple[List[dict], bool, Optional[str]]:
    """Read *.knowledge.md under the KB directory with size limits."""
    kb_dir = _kb_data_dir(kb)
    files_out: List[dict] = []
    total_chars = 0
    any_truncated = False
    note: Optional[str] = None
    paths = sorted(p for p in kb_dir.rglob("*.knowledge.md") if p.is_file())
    for path in paths:
        rel = path.relative_to(kb_dir).as_posix()
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.warning("discover: could not read %s: %s", path, exc)
            continue
        file_truncated = False
        if len(raw) > _DISCOVER_MAX_CHARS_PER_FILE:
            raw = raw[:_DISCOVER_MAX_CHARS_PER_FILE]
            file_truncated = True
            any_truncated = True
        remaining = _DISCOVER_MAX_TOTAL_CHARS - total_chars
        if remaining <= 0:
            note = "Total size limit reached; remaining metadata files were omitted."
            any_truncated = True
            break
        if len(raw) > remaining:
            raw = raw[:remaining]
            file_truncated = True
            any_truncated = True
            note = note or "Total size limit reached; some file contents were truncated."
        total_chars += len(raw)
        files_out.append(
            {
                "filename": rel,
                "content": raw,
                "truncated": file_truncated,
            }
        )
    return files_out, any_truncated, note


@app.get("/health")
def health() -> dict:
    known_kbs = _list_known_kbs()
    loaded = {}
    total_chunks = 0
    for kb in known_kbs:
        store = _stores.get(kb)
        chunks = store.index.ntotal if store and store.index else 0
        loaded[kb] = chunks
        total_chunks += chunks
    return {
        "status": "ok",
        "index_loaded": total_chunks > 0,
        "total_chunks": total_chunks,
        "knowledge_base_dir": str(get_knowledge_base_dir()),
        "persist_dir": PERSIST_DIR,
        "indexing_in_progress": _indexing_in_progress,
        "knowledge_bases": known_kbs,
        "loaded_kbs": loaded,
    }


@app.post("/addkb", response_model=AddKBResponse)
def add_kb(request: AddKBRequest) -> AddKBResponse:
    """
    Index a specific file from ~/.free-code/knowledgeBase/.
    The filename must exist in the knowledge base directory.

    Example body: {"filename": "test-guide.txt", "kb": "hr"}
    """
    if _indexing_in_progress:
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    if not request.filename or not request.filename.strip():
        raise HTTPException(status_code=422, detail="filename is required")

    try:
        kb = _normalize_kb_name(request.kb)
        result = _run_indexing_file(request.filename.strip(), kb)
        return AddKBResponse(**result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("addkb failed for filename=%r", request.filename)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/removekb", response_model=RemoveKBResponse)
def remove_kb(request: RemoveKBRequest) -> RemoveKBResponse:
    """
    Remove a specific file from ~/.free-code/knowledgeBase/<kb>/ and rebuild that KB index.
    """
    if _indexing_in_progress:
        raise HTTPException(status_code=409, detail="Indexing already in progress")
    if not request.filename or not request.filename.strip():
        raise HTTPException(status_code=422, detail="filename is required")

    try:
        kb = _normalize_kb_name(request.kb)
        filename = request.filename.strip()
        if not _is_safe_filename(filename):
            raise ValueError("Invalid filename: path traversal not allowed")
        target = _kb_file_path(kb, filename)
        removed = False
        if target.exists():
            target.unlink()
            removed = True
        chunks = _rebuild_kb_index(kb)
        return RemoveKBResponse(
            status="ok",
            message=(
                f"Removed '{filename}' from KB '{kb}'"
                if removed
                else f"File '{filename}' was already absent in KB '{kb}'; index rebuilt"
            ),
            chunks=chunks,
            kb=kb,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("removekb failed for filename=%r", request.filename)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/kbs", response_model=KnowledgeBasesResponse)
def list_kbs() -> KnowledgeBasesResponse:
    return KnowledgeBasesResponse(knowledge_bases=_list_known_kbs())


@app.post("/createkb", response_model=KBMutationResponse)
def create_kb(request: CreateKBRequest):
    try:
        kb = _normalize_kb_name(request.kb)
        _create_kb_dirs(kb)
        return KBMutationResponse(
            status="ok",
            message=f"Knowledge base '{kb}' created",
            kb=kb,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("createkb failed for kb=%r", request.kb)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/deletekb", response_model=KBMutationResponse)
def delete_kb(request: DeleteKBRequest):
    try:
        kb = _normalize_kb_name(request.kb)
        if kb not in _list_known_kbs():
            raise FileNotFoundError(f"Knowledge base '{kb}' not found")
        _delete_kb(kb)
        return KBMutationResponse(
            status="ok",
            message=f"Knowledge base '{kb}' deleted",
            kb=kb,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("deletekb failed for kb=%r", request.kb)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/query", response_model=QueryResponse)
def query(
    text: str = Query(..., min_length=1, description="Search query text"),
    top_k: int = Query(default=5, ge=1, le=20, description="Maximum number of results"),
    kb: Optional[str] = Query(default=None, description="Knowledge base name"),
) -> QueryResponse:
    """
    Perform similarity search on the knowledge base.
    Returns the most relevant text chunks for the given query.
    """
    kb_name = _normalize_kb_name(kb)
    store = _get_store(kb_name)
    if store.index is None or store.index.ntotal == 0:
        return QueryResponse(results=[])

    fetch_k = min(20, max(top_k * 4, top_k))
    raw_results = store.query(text, top_k=fetch_k, distance_threshold=3.0)
    results: List[str] = []
    for r in raw_results:
        meta = r.get("metadata") or {}
        src = meta.get("source", "")
        chunk_text = meta.get("text", "")
        if is_knowledge_metadata_source(str(src)):
            continue
        if chunk_text and is_knowledge_sidecar_chunk_content(str(chunk_text)):
            continue
        if chunk_text:
            results.append(chunk_text)
        if len(results) >= top_k:
            break

    return QueryResponse(results=results)


@app.get("/discover", response_model=DiscoverResponse)
def discover(
    kb: Optional[str] = Query(default=None, description="Knowledge base name"),
) -> DiscoverResponse:
    """
    Return contents of *.knowledge.md sidecar files for a KB (metadata only; not in vector index).
    """
    kb_name = _normalize_kb_name(kb)
    files_raw, truncated, note = _discover_kb_sidecars(kb_name)
    message = note
    if not files_raw and not message:
        message = f"No *.knowledge.md metadata files found in KB '{kb_name}'."
    return DiscoverResponse(
        kb=kb_name,
        files=[DiscoverFileEntry(**f) for f in files_raw],
        truncated=truncated,
        message=message,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.api:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8085")),
        reload=os.environ.get("RELOAD", "false").lower() == "true",
    )
