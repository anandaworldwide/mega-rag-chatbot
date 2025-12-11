# Dockerfile for Ananda Crawler
# Builds containerized crawler for ECS Fargate deployment
# Uses Playwright's official image for full browser support

FROM mcr.microsoft.com/playwright/python:v1.57.0-jammy

# Install build tools for Python packages that need compilation (like thinc)
RUN apt-get update && apt-get install -y \
    build-essential \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy crawler-specific requirements (minimal dependencies)
COPY data_ingestion/crawler/requirements.txt /app/requirements.txt

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download spaCy model (avoids runtime download on every container start)
RUN python -m spacy download en_core_web_sm

# Copy crawler code (build context is project root)
COPY data_ingestion/crawler/ /app/crawler/
COPY data_ingestion/utils/ /app/utils/
COPY pyutil/ /app/pyutil/

# Create directories for DB and logs (will be mounted from EFS)
RUN mkdir -p /app/data/db /app/data/logs

# Set Python path
ENV PYTHONPATH=/app

# Default command runs supervisor (can be overridden in task definition)
CMD ["python", "/app/crawler/crawler_supervisor.py", "--site", "ananda-public"]
