"""
RAGSearch: query vectorization and retrieval of relevant text snippets.
Handles empty store gracefully.
"""
import os
from typing import List, Optional

from src.data_loader import load_all_documents, get_knowledge_base_dir
from src.vectorstore import FaissVectorStore


class RAGSearch:
    def __init__(
        self,
        persist_dir: str = "faiss_store",
        embedding_model: str = "all-MiniLM-L6-v2",
        data_dir: Optional[str] = None,
    ):
        self.vectorstore = FaissVectorStore(persist_dir, embedding_model)
        self.data_dir = data_dir or str(get_knowledge_base_dir())
        faiss_path = os.path.join(persist_dir, "faiss.index")
        meta_path = os.path.join(persist_dir, "metadata.pkl")
        if os.path.exists(faiss_path) and os.path.exists(meta_path):
            self.vectorstore.load()
        else:
            docs = load_all_documents(self.data_dir)
            if docs:
                self.vectorstore.build_from_documents(docs)

    def search(
        self,
        query: str,
        top_k: int = 5,
        distance_threshold: Optional[float] = 1.2,
    ) -> List[str]:
        if self.vectorstore.index is None:
            return []
        results = self.vectorstore.query(
            query, top_k=top_k, distance_threshold=distance_threshold
        )
        texts = []
        for r in results:
            if r.get("metadata"):
                text = r["metadata"].get("text", "")
                if text:
                    texts.append(text)
        return texts
