.PHONY: start docker-dev docker-build test

start:
	python main.py

docker-dev:
	docker compose -f docker-compose.dev.yml up rag-server

docker-build:
	docker compose -f docker-compose.dev.yml build

test:
	python -m pytest tests/ -v
