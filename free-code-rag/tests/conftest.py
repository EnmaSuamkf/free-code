"""Pytest fixtures."""
import tempfile
from pathlib import Path

import pytest
from langchain_core.documents import Document


@pytest.fixture
def temp_data_dir():
    """Create a temporary directory for test data."""
    with tempfile.TemporaryDirectory() as tmp:
        yield Path(tmp)


@pytest.fixture
def sample_documents():
    """Sample LangChain Document objects for embedding tests."""
    return [
        Document(
            page_content="GitHub Actions is a CI/CD platform.",
            metadata={"page": 1, "source": "doc1.txt"},
        ),
        Document(
            page_content="You can configure workflows in YAML.",
            metadata={"page": 2, "source": "doc1.txt"},
        ),
    ]


@pytest.fixture
def kb_dir_with_txt(tmp_path):
    """Create a knowledge base directory with a .txt file."""
    kb = tmp_path / "knowledgeBase"
    kb.mkdir()
    (kb / "test.txt").write_text(
        "GitHub Actions workflow configuration in YAML.\n"
        "Create a .github/workflows directory and add your workflow file.",
        encoding="utf-8",
    )
    return str(kb)
