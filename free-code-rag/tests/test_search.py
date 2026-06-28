"""Tests for search module."""
import pytest

from src.search import RAGSearch
from src.vectorstore import FaissVectorStore
from langchain_core.documents import Document


@pytest.fixture
def populated_store(tmp_path):
    docs = [
        Document(
            page_content="GitHub Actions allows you to configure workflows using YAML files. "
            "Create a .github/workflows directory and add your workflow file.",
            metadata={"page": 1, "source": "github-actions.txt"},
        ),
    ]
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    persist_dir = tmp_path / "faiss_store"
    store = FaissVectorStore(persist_dir=str(persist_dir))
    store.build_from_documents(docs)
    return str(persist_dir), str(data_dir)


def test_rag_search_returns_relevant_chunks(populated_store):
    persist_dir, data_dir = populated_store
    rag = RAGSearch(persist_dir=persist_dir, data_dir=data_dir)
    snippets = rag.search("How to configure a workflow?", top_k=3)
    assert len(snippets) >= 1
    assert any("workflow" in s.lower() or "yaml" in s.lower() for s in snippets)


def test_rag_search_empty_store_returns_empty_list(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    persist_dir = tmp_path / "faiss_store"
    persist_dir.mkdir()
    rag = RAGSearch(persist_dir=str(persist_dir), data_dir=str(data_dir))
    snippets = rag.search("any query", top_k=5)
    assert snippets == []
