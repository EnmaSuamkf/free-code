.PHONY: venv start docker-dev docker-build test

# Prefer the project venv (created by `make venv` or by the free-code installers).
# Fall back to python3, which exists on Linux/macOS where bare `python` often does not.
PYTHON := $(shell if [ -x .venv/bin/python ]; then echo .venv/bin/python; else echo python3; fi)

# Installing into a venv avoids PEP 668 "externally-managed-environment" errors
# on Debian/Ubuntu and Homebrew pythons. Downloads ~2-3 GB (torch) on first run.
venv:
	python3 -m venv .venv
	.venv/bin/python -m pip install --upgrade pip
	.venv/bin/python -m pip install -r requirements.txt

start:
	$(PYTHON) main.py

docker-dev:
	docker compose -f docker-compose.dev.yml up rag-server

docker-build:
	docker compose -f docker-compose.dev.yml build

test:
	$(PYTHON) -m pytest tests/ -v
