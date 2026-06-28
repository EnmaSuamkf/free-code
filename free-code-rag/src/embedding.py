"""
EmbeddingPipeline: chunk documents and generate embeddings using sentence-transformers.
Uses RecursiveCharacterTextSplitter from langchain for chunking.
"""
from typing import List, Any
import numpy as np

from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer


def load_embedding_model(model_name: str) -> SentenceTransformer:
    """Load the sentence-transformers model defensively.

    Fixes "Cannot copy out of meta tensor; no data!" at indexing time. The cause:
    transformers initializes the weights on the 'meta' device (the default
    low_cpu_mem_usage / accelerate path), and on Apple Silicon sentence-transformers
    then moves the module to MPS with .to("mps"). Moving a still-meta module raises
    that exact error. Passing low_cpu_mem_usage=False materializes real CPU tensors
    up front, so the subsequent move to the device succeeds.

    We deliberately keep the default device (MPS on Apple Silicon): forcing device="cpu"
    makes torch use libomp for inference, which then double-loads against faiss-cpu's
    own OpenMP and segfaults. Running on MPS sidesteps that conflict entirely.
    """
    try:
        return SentenceTransformer(
            model_name,
            model_kwargs={"low_cpu_mem_usage": False},
        )
    except TypeError:
        # Older sentence-transformers without model_kwargs passthrough.
        return SentenceTransformer(model_name)


class EmbeddingPipeline:
    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.model = load_embedding_model(model_name)

    def chunk_documents(self, documents: List[Any]) -> List[Any]:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", " ", ""],
        )
        return splitter.split_documents(documents)

    def embed_chunks(self, chunks: List[Any]) -> np.ndarray:
        texts = [chunk.page_content for chunk in chunks]
        embeddings = self.model.encode(texts, show_progress_bar=True)
        return embeddings
