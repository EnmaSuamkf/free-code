# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=secret,id=ca-cert,target=/tmp/ca.pem \
    SSL_CERT_FILE=/tmp/ca.pem REQUESTS_CA_BUNDLE=/tmp/ca.pem pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY main.py .

ENV PYTHONUNBUFFERED=1

EXPOSE 8085

CMD ["python", "main.py"]
