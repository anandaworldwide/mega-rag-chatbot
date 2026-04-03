FROM ubuntu

# Install Python 3.11
RUN apt-get update && apt-get install -y \
    software-properties-common \
    curl \
    git \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3.11-distutils \
    python3.11-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install pip for Python 3.11
RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Set Python 3.11 as the default python3
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

# Pre-install spaCy globally to speed up virtual environment setup
RUN pip3 install spacy && python3 -m spacy download en_core_web_sm

# Install Node.js 20 using nvm in /opt to avoid root permission issues
ENV NVM_DIR=/opt/nvm
RUN mkdir -p $NVM_DIR \
    && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | NVM_DIR=$NVM_DIR bash \
    && . $NVM_DIR/nvm.sh \
    && nvm install 20 \
    && nvm use 20 \
    && nvm alias default 20

# Add nvm and node to PATH for subsequent RUN commands
ENV PATH="$NVM_DIR/versions/node/v20.*/bin:$PATH"
    
# Verify installation
RUN . $NVM_DIR/nvm.sh && nvm use 20 && python3 --version && pip3 --version && uv --version && node --version && npm --version

# Set environment variable for virtual environment path
ENV PATH="/workspace/.venv/bin:$PATH"
