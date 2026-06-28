"""Tests for vectorstore module."""
import tempfile
from pathlib import Path

import numpy as np
import pytest

from src.embedding import EmbeddingPipeline
from src.vectorstore import FaissVectorStore
from langchain_core.documents import Document


@pytest.fixture
def sample_chunks_and_embeddings():
    docs = [
        Document(page_content="GitHub Actions workflow configuration.", metadata={"page": 1}),
        Document(page_content="YAML syntax for workflow files.", metadata={"page": 2}),
    ]
    pipeline = EmbeddingPipeline()
    chunks = pipeline.chunk_documents(docs)
    embeddings = pipeline.embed_chunks(chunks)
    return chunks, embeddings


def test_faiss_vector_store_save_and_load(sample_chunks_and_embeddings):
    chunks, embeddings = sample_chunks_and_embeddings
    metadatas = [{"text": c.page_content} for c in chunks]
    with tempfile.TemporaryDirectory() as tmp:
        store = FaissVectorStore(persist_dir=tmp)
        store.add_embeddings(embeddings.astype("float32"), metadatas)
        store.save()
        assert (Path(tmp) / "faiss.index").exists()
        assert (Path(tmp) / "metadata.pkl").exists()


def test_faiss_vector_store_reload_without_reembedding(sample_chunks_and_embeddings):
    chunks, embeddings = sample_chunks_and_embeddings
    metadatas = [{"text": c.page_content} for c in chunks]
    with tempfile.TemporaryDirectory() as tmp:
        store = FaissVectorStore(persist_dir=tmp)
        store.add_embeddings(embeddings.astype("float32"), metadatas)
        store.save()
        before = store.query("workflow configuration", top_k=2)

        store2 = FaissVectorStore(persist_dir=tmp)
        store2.load()
        after = store2.query("workflow configuration", top_k=2)

        assert len(after) == len(before)
        assert all(r["metadata"]["text"] for r in after)


def test_build_from_documents_creates_index():
    docs = [
        Document(page_content="RAG server indexes documents for search.", metadata={"source": "test.txt"}),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        store = FaissVectorStore(persist_dir=tmp)
        store.build_from_documents(docs)
        assert store.index is not None
        assert store.index.ntotal > 0
        assert (Path(tmp) / "faiss.index").exists()


def test_query_empty_store():
    with tempfile.TemporaryDirectory() as tmp:
        store = FaissVectorStore(persist_dir=tmp)
        results = store.query("anything", top_k=5)
        assert results == []
