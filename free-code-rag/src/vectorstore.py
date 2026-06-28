"""
FaissVectorStore: persistent FAISS index for similarity search.
Persists as faiss.index and metadata.pkl.
"""
import os
import pickle
from typing import List, Any, Optional

import faiss
import numpy as np

from src.embedding import EmbeddingPipeline, load_embedding_model


class FaissVectorStore:
    def __init__(
        self,
        persist_dir: str = os.path.join(os.path.expanduser("~"), ".free-code", "faiss_store"),
        embedding_model: str = "all-MiniLM-L6-v2",
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        self.persist_dir = persist_dir
        os.makedirs(self.persist_dir, exist_ok=True)
        self.index: Optional[faiss.IndexFlatL2] = None
        self.metadata: List[dict] = []
        self.embedding_model = embedding_model
        self.model = load_embedding_model(embedding_model)
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def build_from_documents(self, documents: List[Any]) -> None:
        emb_pipe = EmbeddingPipeline(
            model_name=self.embedding_model,
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )
        chunks = emb_pipe.chunk_documents(documents)
        if not chunks:
            return
        embeddings = emb_pipe.embed_chunks(chunks)
        if embeddings.size == 0:
            return

        self.index = None
        self.metadata = []

        metadatas = [
            {"text": chunk.page_content, **(chunk.metadata or {})}
            for chunk in chunks
        ]
        self.add_embeddings(np.array(embeddings).astype("float32"), metadatas)
        self.save()

    def add_documents(self, documents: List[Any]) -> int:
        faiss_path = os.path.join(self.persist_dir, "faiss.index")
        meta_path = os.path.join(self.persist_dir, "metadata.pkl")
        if self.index is None and os.path.exists(faiss_path) and os.path.exists(meta_path):
            self.load()

        emb_pipe = EmbeddingPipeline(
            model_name=self.embedding_model,
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )
        chunks = emb_pipe.chunk_documents(documents)
        if not chunks:
            return 0
        embeddings = emb_pipe.embed_chunks(chunks)
        if embeddings.size == 0:
            return 0
        metadatas = [
            {"text": chunk.page_content, **(chunk.metadata or {})}
            for chunk in chunks
        ]
        self.add_embeddings(np.array(embeddings).astype("float32"), metadatas)
        self.save()
        return len(chunks)

    def add_embeddings(
        self, embeddings: np.ndarray, metadatas: Optional[List[dict]] = None
    ) -> None:
        dim = embeddings.shape[1]
        if self.index is None:
            self.index = faiss.IndexFlatL2(dim)
        else:
            existing_dim = self.index.d
            if existing_dim != dim:
                raise ValueError(
                    f"Embedding dimension mismatch: existing index uses dimension {existing_dim}, "
                    f"but new embeddings have dimension {dim}. Delete the persist directory "
                    f"{self.persist_dir!r} (or set FAISS_PERSIST_DIR) and re-index, or use the same "
                    "sentence-transformers model as when the index was built."
                )
        self.index.add(embeddings)
        if metadatas:
            self.metadata.extend(metadatas)

    def save(self) -> None:
        faiss_path = os.path.join(self.persist_dir, "faiss.index")
        meta_path = os.path.join(self.persist_dir, "metadata.pkl")
        faiss.write_index(self.index, faiss_path)
        with open(meta_path, "wb") as f:
            pickle.dump(self.metadata, f)

    def load(self) -> None:
        faiss_path = os.path.join(self.persist_dir, "faiss.index")
        meta_path = os.path.join(self.persist_dir, "metadata.pkl")
        self.index = faiss.read_index(faiss_path)
        with open(meta_path, "rb") as f:
            self.metadata = pickle.load(f)

    def search(
        self,
        query_embedding: np.ndarray,
        top_k: int = 5,
        distance_threshold: Optional[float] = None,
    ) -> List[dict]:
        if self.index is None or self.index.ntotal == 0:
            return []
        n_candidates = min(self.index.ntotal, max(top_k * 3, top_k))
        D, I = self.index.search(query_embedding, n_candidates)
        results = []
        best_dist = float(D[0][0]) if len(D[0]) > 0 else None
        for idx, dist in zip(I[0], D[0]):
            if distance_threshold is not None and best_dist is not None:
                if dist > best_dist * distance_threshold:
                    continue
            meta = self.metadata[idx] if idx < len(self.metadata) else None
            results.append({"index": int(idx), "distance": float(dist), "metadata": meta})
            if len(results) >= top_k:
                break
        return results

    def query(
        self,
        query_text: str,
        top_k: int = 5,
        distance_threshold: Optional[float] = 3.0,
    ) -> List[dict]:
        query_emb = self.model.encode([query_text]).astype("float32")
        return self.search(query_emb, top_k=top_k, distance_threshold=distance_threshold)
