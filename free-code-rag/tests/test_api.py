"""Tests for FastAPI RAG server endpoints."""
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from langchain_core.documents import Document

import src.api as api_module
from src.api import app
from src.vectorstore import FaissVectorStore


@pytest.fixture(autouse=True)
def reset_store():
    """Reset the global store singleton between tests."""
    api_module._stores = {}
    api_module._indexing_in_progress = False
    yield
    api_module._stores = {}


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert "index_loaded" in data
    assert "total_chunks" in data
    assert "knowledge_base_dir" in data
    assert "knowledge_bases" in data


def test_query_empty_store(client):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            r = client.get("/query", params={"text": "test search"})
            assert r.status_code == 200
            data = r.json()
            assert "results" in data
            assert isinstance(data["results"], list)
            assert len(data["results"]) == 0


def test_query_requires_text(client):
    r = client.get("/query")
    assert r.status_code == 422


def test_query_rejects_empty_text(client):
    r = client.get("/query", params={"text": ""})
    assert r.status_code == 422


def test_addkb_requires_filename(client):
    r = client.post("/addkb", json={})
    assert r.status_code == 422


def test_addkb_file_not_found(client):
    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(api_module, "get_knowledge_base_dir", return_value=Path(tmp)):
            r = client.post("/addkb", json={"filename": "nonexistent.txt", "kb": "team-docs"})
            assert r.status_code == 404
            assert "not found" in r.json()["detail"]


def test_addkb_unsupported_extension(client):
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "team-docs").mkdir(parents=True, exist_ok=True)
        (tmp_path / "team-docs" / "data.csv").write_text("a,b,c", encoding="utf-8")
        with patch.object(api_module, "get_knowledge_base_dir", return_value=tmp_path):
            r = client.post("/addkb", json={"filename": "data.csv", "kb": "team-docs"})
            assert r.status_code == 400
            assert "Unsupported" in r.json()["detail"]


def test_addkb_rejects_path_traversal(client):
    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(api_module, "get_knowledge_base_dir", return_value=Path(tmp)):
            r = client.post("/addkb", json={"filename": "../../../etc/passwd", "kb": "team-docs"})
            assert r.status_code == 400
            assert "traversal" in r.json()["detail"].lower()


def test_addkb_with_valid_file(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "This is a test document about workflow and YAML configuration.",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                r = client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})
                assert r.status_code == 200
                data = r.json()
                assert data["status"] == "ok"
                assert data["chunks"] > 0
                assert "test.txt" in data["message"]
                assert data["kb"] == "team-docs"


def test_query_returns_results_after_indexing(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "This is a test document about workflow and YAML configuration.",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})

                r = client.get("/query", params={"text": "workflow configuration", "kb": "team-docs"})
                assert r.status_code == 200
                data = r.json()
                assert len(data["results"]) > 0
                assert any("workflow" in chunk.lower() or "yaml" in chunk.lower() for chunk in data["results"])


def test_kbs_endpoint_lists_indexed_knowledge_bases(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "This is a test document about workflow and YAML configuration.",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})
                r = client.get("/kbs")
                assert r.status_code == 200
                assert "team-docs" in r.json()["knowledge_bases"]


def test_removekb_removes_file_and_rebuilds_index(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "This is a test document about workflow and YAML configuration.",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})
                rm = client.post("/removekb", json={"filename": "test.txt", "kb": "team-docs"})
                assert rm.status_code == 200
                assert rm.json()["chunks"] == 0
                r = client.get("/query", params={"text": "workflow", "kb": "team-docs"})
                assert r.status_code == 200
                assert r.json()["results"] == []


def test_removekb_is_idempotent_when_file_missing(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "This is a test document about workflow and YAML configuration.",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})
                (kb_root / "team-docs" / "test.txt").unlink()
                rm = client.post("/removekb", json={"filename": "test.txt", "kb": "team-docs"})
                assert rm.status_code == 200
                assert rm.json()["status"] == "ok"
                assert rm.json()["chunks"] == 0


def test_addkb_rejects_invalid_kb_name(client, kb_dir_with_txt):
    kb_root = Path(kb_dir_with_txt)
    with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
        r = client.post("/addkb", json={"filename": "test.txt", "kb": "../bad"})
        assert r.status_code == 400
        assert "knowledge base" in r.json()["detail"].lower()


def test_createkb_creates_namespace(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        kb_root = Path(kb_dir_with_txt)
        with (
            patch.object(api_module, "PERSIST_DIR", persist_dir),
            patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root),
        ):
            r = client.post("/createkb", json={"kb": "team-docs"})
            assert r.status_code == 200
            data = r.json()
            assert data["status"] == "ok"
            assert data["kb"] == "team-docs"
            assert (kb_root / "team-docs").exists()
            assert (Path(persist_dir) / "team-docs").exists()


def test_addkb_knowledge_metadata_not_indexed(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        with patch.object(api_module, "PERSIST_DIR", persist_dir):
            api_module._stores = {}
            kb_root = Path(kb_dir_with_txt)
            (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
            (kb_root / "team-docs" / "test.txt").write_text(
                "indexed content about dragons and caves.",
                encoding="utf-8",
            )
            (kb_root / "team-docs" / "test.knowledge.md").write_text(
                "metadata scope secret keywords",
                encoding="utf-8",
            )
            with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
                r1 = client.post("/addkb", json={"filename": "test.txt", "kb": "team-docs"})
                assert r1.status_code == 200
                c1 = r1.json()["chunks"]
                r2 = client.post("/addkb", json={"filename": "test.knowledge.md", "kb": "team-docs"})
                assert r2.status_code == 200
                assert r2.json()["chunks"] == c1
                assert "not indexed" in r2.json()["message"].lower()
                rq = client.get("/query", params={"text": "secret keywords scope", "kb": "team-docs"})
                assert rq.status_code == 200
                combined = " ".join(rq.json()["results"]).lower()
                assert "secret keywords" not in combined


def test_discover_returns_knowledge_files(client, kb_dir_with_txt):
    kb_root = Path(kb_dir_with_txt)
    (kb_root / "team-docs").mkdir(parents=True, exist_ok=True)
    (kb_root / "team-docs" / "x.knowledge.md").write_text("# Overview\nHello KB", encoding="utf-8")
    with patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root):
        r = client.get("/discover", params={"kb": "team-docs"})
        assert r.status_code == 200
        data = r.json()
        assert data["kb"] == "team-docs"
        assert len(data["files"]) == 1
        assert data["files"][0]["filename"] == "x.knowledge.md"
        assert "Overview" in data["files"][0]["content"]
        assert "Hello KB" in data["files"][0]["content"]


def test_deletekb_removes_namespace(client, kb_dir_with_txt):
    with tempfile.TemporaryDirectory() as persist_dir:
        kb_root = Path(kb_dir_with_txt)
        with (
            patch.object(api_module, "PERSIST_DIR", persist_dir),
            patch.object(api_module, "get_knowledge_base_dir", return_value=kb_root),
        ):
            client.post("/createkb", json={"kb": "team-docs"})
            r = client.post("/deletekb", json={"kb": "team-docs"})
            assert r.status_code == 200
            data = r.json()
            assert data["status"] == "ok"
            assert data["kb"] == "team-docs"
            assert not (kb_root / "team-docs").exists()
            assert not (Path(persist_dir) / "team-docs").exists()
