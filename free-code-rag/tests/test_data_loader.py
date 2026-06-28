"""Tests for data_loader module."""
from pathlib import Path

import pytest

from src.data_loader import (
    load_all_documents,
    load_new_documents,
    load_file,
    list_knowledge_base_files,
    _sanitize_data_dir,
    SUPPORTED_EXTENSIONS,
    is_knowledge_metadata_filename,
    is_knowledge_metadata_source,
    is_knowledge_sidecar_chunk_content,
)


def test_sanitize_data_dir_rejects_path_traversal():
    with pytest.raises(ValueError, match="Path traversal"):
        _sanitize_data_dir("/tmp/../../../etc/passwd")


def test_load_all_documents_empty_directory(temp_data_dir):
    result = load_all_documents(str(temp_data_dir))
    assert result == []


def test_load_all_documents_with_txt(temp_data_dir):
    txt_path = temp_data_dir / "sample.txt"
    txt_path.write_text("Hello world", encoding="utf-8")
    result = load_all_documents(str(temp_data_dir))
    assert len(result) >= 1
    doc = result[0]
    assert hasattr(doc, "page_content")
    assert hasattr(doc, "metadata")
    assert "source" in doc.metadata


def test_load_new_documents_excludes_indexed(temp_data_dir):
    (temp_data_dir / "old.txt").write_text("Old content", encoding="utf-8")
    (temp_data_dir / "new.txt").write_text("New content", encoding="utf-8")
    old_path = str((temp_data_dir / "old.txt").resolve())
    result = load_new_documents(str(temp_data_dir), indexed_sources=[old_path])
    assert len(result) == 1
    assert "New content" in result[0].page_content


def test_load_all_documents_excludes_knowledge_md(temp_data_dir):
    (temp_data_dir / "a.txt").write_text("body text", encoding="utf-8")
    (temp_data_dir / "a.knowledge.md").write_text("sidecar meta", encoding="utf-8")
    result = load_all_documents(str(temp_data_dir))
    joined = "\n".join(d.page_content for d in result)
    assert "body text" in joined
    assert "sidecar meta" not in joined


def test_is_knowledge_metadata_helpers():
    assert is_knowledge_metadata_filename("Doc.KNOWLEDGE.md")
    assert not is_knowledge_metadata_filename("readme.md")
    assert is_knowledge_metadata_source("/tmp/foo/bar.knowledge.md")
    assert not is_knowledge_metadata_source("/tmp/foo/bar.md")


def test_is_knowledge_sidecar_chunk_content():
    assert is_knowledge_sidecar_chunk_content("# Foo — knowledge base metadata\n\nBody")
    assert not is_knowledge_sidecar_chunk_content("plain text knowledge base metadata")
    assert not is_knowledge_sidecar_chunk_content("# Regular heading\n\nNo marker here.")
def test_load_file_unsupported_extension(temp_data_dir):
    csv_path = temp_data_dir / "data.csv"
    csv_path.write_text("a,b,c\n1,2,3", encoding="utf-8")
    result = load_file(csv_path)
    assert result == []


def test_list_knowledge_base_files(temp_data_dir):
    (temp_data_dir / "file1.txt").write_text("Content 1", encoding="utf-8")
    (temp_data_dir / "file2.txt").write_text("Content 2", encoding="utf-8")
    files = list_knowledge_base_files(str(temp_data_dir))
    assert len(files) == 2
    assert all("name" in f and "path" in f and "size_bytes" in f for f in files)


def test_supported_extensions_include_expected_types():
    assert ".txt" in SUPPORTED_EXTENSIONS
    assert ".md" in SUPPORTED_EXTENSIONS
    assert ".pdf" in SUPPORTED_EXTENSIONS
    assert ".docx" in SUPPORTED_EXTENSIONS
    assert ".doc" in SUPPORTED_EXTENSIONS
