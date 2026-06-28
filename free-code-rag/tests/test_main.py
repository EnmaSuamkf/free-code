"""Integration tests for the RAG knowledge base pipeline."""
from pathlib import Path

import pytest
from langchain_core.documents import Document

from src.data_loader import load_all_documents
from src.vectorstore import FaissVectorStore


def test_e2e_load_chunk_embed_store_query(kb_dir_with_txt):
    """Full pipeline: load TXT -> chunk -> embed -> store -> query returns results."""
    persist_dir = Path(kb_dir_with_txt).parent / "faiss_store"
    docs = load_all_documents(kb_dir_with_txt)
    assert len(docs) >= 1

    store = FaissVectorStore(persist_dir=str(persist_dir))
    store.build_from_documents(docs)

    assert store.index is not None
    assert store.index.ntotal > 0
    assert (persist_dir / "faiss.index").exists()

    results = store.query("workflow", top_k=3)
    assert isinstance(results, list)
    assert len(results) > 0


def test_e2e_empty_directory_graceful(tmp_path):
    """Empty knowledge base directory returns empty list without crashing."""
    empty_dir = tmp_path / "empty_kb"
    empty_dir.mkdir()
    docs = load_all_documents(str(empty_dir))
    assert docs == []
