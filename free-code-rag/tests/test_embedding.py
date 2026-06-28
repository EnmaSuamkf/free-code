"""Tests for embedding module."""
import pytest

from src.embedding import EmbeddingPipeline


def test_chunk_documents_returns_chunks(sample_documents):
    pipeline = EmbeddingPipeline(chunk_size=500, chunk_overlap=50)
    chunks = pipeline.chunk_documents(sample_documents)
    assert len(chunks) >= 1
    for chunk in chunks:
        assert hasattr(chunk, "page_content")


def test_embed_chunks_returns_embeddings(sample_documents):
    pipeline = EmbeddingPipeline()
    chunks = pipeline.chunk_documents(sample_documents)
    embeddings = pipeline.embed_chunks(chunks)
    assert embeddings.shape[0] == len(chunks)
    assert embeddings.shape[1] > 0
