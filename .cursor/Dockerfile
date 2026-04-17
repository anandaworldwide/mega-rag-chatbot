FROM python:3.11-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install uv globally so environment install scripts can use it immediately.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Cursor config uses user "ubuntu"; create it if missing.
RUN id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu

RUN python --version && pip --version && uv --version && node --version && npm --version

ENV PATH="/workspace/.venv/bin:/usr/local/bin:${PATH}"
