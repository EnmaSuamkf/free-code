# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
# The `ca-cert` secret is optional: it is only supplied behind a TLS-inspecting
# corporate proxy (see docker-compose.dev.yml). Without it, install normally.
RUN --mount=type=secret,id=ca-cert,target=/tmp/ca.pem \
    if [ -s /tmp/ca.pem ]; then \
      SSL_CERT_FILE=/tmp/ca.pem REQUESTS_CA_BUNDLE=/tmp/ca.pem pip install --no-cache-dir -r requirements.txt; \
    else \
      pip install --no-cache-dir -r requirements.txt; \
    fi

COPY src ./src
COPY main.py .

ENV PYTHONUNBUFFERED=1

EXPOSE 8085

CMD ["python", "main.py"]
