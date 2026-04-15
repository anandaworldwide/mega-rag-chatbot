# Dockerfile for Ananda Crawler
# Container image for production Linux VM (Docker + systemd) or local testing
# Uses Playwright's official image for full browser support

FROM mcr.microsoft.com/playwright/python:v1.57.0-jammy

# Install build tools and tzdata for zoneinfo support
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    build-essential \
    g++ \
    gcc \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Copy lock and project metadata needed to resolve the crawler environment
COPY pyproject.toml /app/pyproject.toml
COPY uv.lock /app/uv.lock
COPY data_ingestion/crawler/pyproject.toml /app/data_ingestion/crawler/pyproject.toml
COPY reranking/pyproject.toml /app/reranking/pyproject.toml
COPY wordpress/analytics/pyproject.toml /app/wordpress/analytics/pyproject.toml

# Install Python dependencies into a project-local virtual environment
RUN uv sync --locked --package mega-rag-chatbot-crawler --no-default-groups --no-editable

# Pre-download spaCy model (avoids runtime download on every container start)
RUN uv run --package mega-rag-chatbot-crawler python -m spacy download en_core_web_sm

# Copy crawler code (build context is project root)
COPY data_ingestion/crawler/ /app/crawler/
COPY data_ingestion/utils/ /app/utils/
COPY pyutil/ /app/pyutil/

# Create directories for DB and logs (will be mounted from EFS)
# Ensure proper ownership for non-root user (UID 1000)
RUN mkdir -p /app/data/db /app/data/logs && \
    chown -R 1000:1000 /app

# Set Python path and virtual environment path
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app

# Run as non-root user (UID 1000) for security hardening
# This matches the task definition user setting
USER 1000:1000

# Default command runs supervisor (can be overridden in task definition)
CMD ["python", "/app/crawler/crawler_supervisor.py", "--site", "ananda-public"]
