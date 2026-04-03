# Reranking Module

This module contains tools for fine-tuning and evaluating cross-encoder reranking models to improve document retrieval
relevance.

## UV Workspace Environment

This module now uses the shared UV workspace and Python 3.11. Sync just the reranking environment when you need it.

### Quick Setup

```bash
# From the project root
uv sync --locked --package mega-rag-chatbot-reranking --no-default-groups
```

### Automatic Environment Activation (Recommended)

This module includes a `.envrc` file for automatic environment activation using `direnv`. Once set up, you can use
`uv run --package mega-rag-chatbot-reranking ...` from inside the directory without manual venv management.

**One-time direnv setup:**

```bash
# Install direnv (if not already installed)
brew install direnv  # macOS with Homebrew
# OR
sudo apt install direnv  # Ubuntu/Debian

# Add direnv hook to your shell profile
# For bash, add to ~/.bashrc:
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc

# For zsh, add to ~/.zshrc:
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc

# Restart your shell or source the config
source ~/.bashrc  # or source ~/.zshrc
```

**First time in the reranking directory:**

```bash
cd reranking
direnv allow  # Grant permission for this directory
```

Now the environment will automatically activate/deactivate:

```bash
cd reranking
uv run --package mega-rag-chatbot-reranking python label_relevance.py --site ananda
cd ..
```

### Manual Usage (Alternative)

If you prefer not to use direnv, run commands directly through UV:

```bash
uv run --package mega-rag-chatbot-reranking python reranking/label_relevance.py --site ananda
```

## Module Contents

### 1. Document Relevance Labeling Tool (`label_relevance.py`)

This tool helps create fine-tuning and evaluation datasets for a cross-encoder reranker by letting you manually label
the relevance of documents retrieved from Pinecone.

## Features

- Retrieves documents from Pinecone for sample queries
- Filters documents by library based on site configuration
- Highlights query terms in documents for easier relevance assessment
- Opens markdown files in Typora (or default app) for manual labeling
- Tracks progress between sessions
- Creates both evaluation and fine-tuning datasets
- Handles interruptions gracefully
- Supports per-site data isolation with the required `--site` parameter
- Uses site-specific environment variables (`.env.<site>` files)
- Includes debugging features to troubleshoot Pinecone connectivity issues

## Prerequisites

- Python 3.11
- Pinecone API key
- OpenAI API key
- Pinecone index name
- Typora Markdown editor (optional but recommended)
- Site-specific environment file (`.env.<site>`)
- Site configuration in `web/site-config/config.json`

## Dependencies

This module exports a compatibility `requirements.txt` file from the shared `uv.lock`. The primary dependency source is
`reranking/pyproject.toml`.

- `transformers` - Hugging Face transformers library
- `optimum[onnxruntime]` - Optimized inference with ONNX Runtime
- `torch` - PyTorch for model training and inference
- `scikit-learn` - Machine learning utilities
- `numpy` - Numerical computing (version 2.x)
- `protobuf` - Protocol buffers for serialization

**Important:** Use the UV reranking package environment rather than manual `pip install -r` flows.

## Environment Setup

You must create a site-specific environment file for each site you want to label:

- Create a `.env.<site_name>` file (e.g., `.env.ananda`) with site-specific variables:

  ```env
  PINECONE_API_KEY=your_pinecone_key
  OPENAI_API_KEY=your_openai_key
  PINECONE_INDEX_NAME=your_index_name
  ```

The site name specified in the `--site` parameter must match:

1. The environment file name (`.env.<site>`)
2. A site ID in the `web/site-config/config.json` file

## Site Configuration and Library Filtering

The tool uses the site configuration from `web/site-config/config.json` to determine which libraries to include in the
search. For example:

```json
"ananda": {
  "includedLibraries": [
    "Ananda Library",
    "Ananda Youtube",
    "Treasures",
    "The Bhaktan Files"
  ]
}
```

Documents in Pinecone are filtered based on their `library` metadata field matching one of these included libraries.
This ensures that only relevant documents for the specific site are included in the labeling process.

## How to Use

1. Run the tool with a required site parameter:

   ```bash
   # The --site parameter is required
   python reranking/label_relevance.py --site ananda

   # Reset progress and start over for a specific site
   python reranking/label_relevance.py --site ananda --reset

   # Run with debug mode to check Pinecone connectivity and troubleshoot issues
   python reranking/label_relevance.py --site ananda --debug
   ```

2. For each query, the tool will:
   - Retrieve documents from Pinecone (filtered by libraries from site config)
   - Create a markdown file with the documents
   - Open the file in Typora (or default application)
   - Wait for you to assign relevance scores and save/close the file
   - Parse your scores and save them to the datasets

3. To assign scores:
   - For each document, replace `[Enter 0-3]` with a number:
     - `3`: Highly Relevant - Directly answers the query
     - `2`: Relevant - Contains information related to the query
     - `1`: Marginally Relevant - Mentions query topics but not directly helpful
     - `0`: Irrelevant - Not related to the query

## Troubleshooting

If you're not getting any results from Pinecone:

1. Use the `--debug` flag to run diagnostics:

   ```bash
   python reranking/label_relevance.py --site ananda --debug
   ```

2. The diagnostics will:
   - Check your connection to the Pinecone index
   - Verify if your libraries exist in the index
   - Test the embedding generation
   - Report any dimension mismatches or other issues

3. Common issues:
   - Libraries from your site config not found in the index
   - Empty index (no vectors uploaded)
   - Incorrect Pinecone API key or index name
   - Embedding dimension mismatch

4. When no documents are found for a query, the tool will offer to retry without the library filter to help determine if
   the issue is with the library filter or the query itself.

## Output Files

For each site (specified with `--site`), the tool produces:

- `reranking/evaluation_dataset_<site_id>.jsonl`: Contains all labeled documents with graded relevance scores (0-3)
- `reranking/fine_tuning_dataset_<site_id>.jsonl`: Contains binary labeled documents (1.0 for relevant, 0.0 for
  irrelevant)
- `reranking/relevance_labeling_progress_<site_id>.json`: Progress tracking file
- `reranking/markdown_files/<site_id>/`: Directory with generated markdown files
- `reranking/labeled_data/<site_id>/`: Directory for additional labeled data

## JSONL Format

JSONL (JSON Lines) is a text format where each line is a valid JSON object. Each line in the output files represents one
document/query pair:

### Evaluation Dataset Example

```json
{"query": "how to deepen Kriya meditation practice", "document": "content...", "relevance": 3,
 "metadata": {...}, "site_id": "ananda_village"}
```

### Fine-tuning Dataset Example

```json
{"query": "how to deepen Kriya meditation practice", "document": "content...", "label": 1.0,
 "metadata": {...}, "site_id": "ananda_village"}
```

## Tips

- The tool automatically saves progress after each query, so you can quit and resume later
- Query terms are highlighted in bold to help with relevance assessment
- For fine-tuning data, scores 2-3 are converted to positive examples (1.0) and scores 0-1 to negative examples (0.0)
- The tool aims to create a balanced fine-tuning dataset with equal positive and negative examples
- Use different site IDs to create separate datasets for different sites or content collections
- Always create site-specific environment files (`.env.<site>`) with the required variables
