# Data Ingestion Overview

The data ingestion system processes various content types into a unified vector database using semantic chunking for
optimal RAG performance.

## Content Sources

### PDF Processing

Ingest PDF documents with full-document processing and spaCy semantic chunking.

```bash
python pdf_to_vector_db.py \
  --site crystal \
  --library "Crystal Clarity" \
  --file-path media/pdf-docs/crystal/ALL/
```

### Database Text Ingestion

Import structured text data from MySQL databases.

```bash
python sql_to_vector_db/ingest_db_text.py \
  --site ananda \
  --database anandalib_2025_03_06 \
  --library "Ananda Library"
```

### Audio & Video Transcription

#### Media File Processing

Queue and transcribe audio files from local directories:

```bash
# Queue audio files for processing
python audio_video/manage_queue.py \
  --directory bhaktan-talks \
  --site ananda \
  --default-author 'Swami Kriyananda' \
  --library bhaktan

# Process transcription queue
python audio_video/transcribe_and_ingest_media.py --site ananda
```

#### YouTube Playlist Processing

Bulk process YouTube videos from spreadsheet playlists:

```bash
# Queue videos from playlist spreadsheet
python audio_video/manage_queue.py \
  --playlists-file audio_video/data/youtube-links.xlsx \
  --site ananda \
  --default-author 'Swami Kriyananda' \
  --library 'Ananda Youtube'

# Process transcription queue
python audio_video/transcribe_and_ingest_media.py --site ananda
```

### Web Content Crawling

Crawl and ingest website content with automatic content extraction:

```bash
python crawler/website_crawler.py --site ananda-public
```

## Architecture

### Semantic Chunking

- **Strategy**: spaCy paragraph-based chunking
- **Target Range**: 225-450 words per chunk
- **Overlap**: 20% for context preservation
- **Quality**: 70% of chunks fall within target range

**Note that as of June 2025, the tests on this new semantic chunking were poor** compared to the old chunking strategy.
See the task "New production pinecone corpus" in Notion for more details on what to try next.

### Vector Storage

- **Database**: Pinecone vector database
- **Embeddings**: OpenAI text-embedding models
- **Namespaces**: Site-specific data isolation
- **Metadata**: Rich metadata for filtering and attribution

### Site Configuration

Each deployment site (e.g., ananda, crystal, jairam, ananda-public) has:

- Dedicated Pinecone namespace
- Custom processing parameters
- Site-specific content libraries
- Environment-specific credentials

## Testing

Run comprehensive integration tests to validate chunking quality:

```bash
# From data_ingestion directory
python -m pytest tests/test_integration_chunk_quality.py --site test
```

### Visualization Metadata Precomputation

Precompute UMAP projections and HDBSCAN clusters for visualization:

```bash
# Install dependencies (use pre-built wheels to avoid CMake requirement)
pip install --only-binary :all: umap-learn hdbscan

# Run the script
python data_ingestion/update_viz_metadata.py --site ananda
```

**Note**: If pre-built wheels fail, install CMake first:

- macOS: `brew install cmake`
- Linux: `apt-get install cmake` (or equivalent)

## Dependencies

- **Python 3.10+**
- **spaCy**: Semantic text processing
- **LangChain**: Document processing pipeline
- **Pinecone**: Vector database operations
- **AssemblyAI**: Audio transcription service
- **pdfplumber**: PDF text extraction with superior layout preservation
- **umap-learn**: UMAP dimensionality reduction (optional, for visualization)
- **hdbscan**: HDBSCAN clustering (optional, for visualization)
