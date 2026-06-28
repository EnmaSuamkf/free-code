"""
RAG Knowledge Base Server entry point.
Starts the FastAPI server on port 8085.
"""
import os
import uvicorn


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8085"))
    reload = os.environ.get("RELOAD", "false").lower() == "true"

    print(f"[INFO] Starting RAG Knowledge Base Server on {host}:{port}")
    print(f"[INFO] Knowledge base dir: ~/.free-code/knowledgeBase/")
    print(f"[INFO] API docs: http://localhost:{port}/docs")

    uvicorn.run(
        "src.api:app",
        host=host,
        port=port,
        reload=reload,
    )


if __name__ == "__main__":
    main()
