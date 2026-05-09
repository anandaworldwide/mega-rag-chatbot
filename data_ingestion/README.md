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

If the source `wp_posts` table has a numeric column for content access, pass it explicitly:

```bash
python sql_to_vector_db/ingest_db_text.py \
  --site ananda \
  --database anandalib_2025_03_06 \
  --library "Ananda Library" \
  --required-access-level-field luca_required_access_level
```

Missing or blank source values default to public (`required_access_level: 0`). The script also writes the legacy
`access_level` string for compatibility.

### Audio & Video Transcription

#### Media File Processing

Queue and transcribe audio files from local directories:

```bash
# Queue audio files for processing
python audio_video/manage_queue.py \
  --directory bhaktan-talks \
  --site ananda \
  --default-author 'Swami Kriyananda' \
  --library bhaktan \
  --required-access-level 0

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
  --library 'Ananda Youtube' \
  --required-access-level 0

# Process transcription queue
python audio_video/transcribe_and_ingest_media.py --site ananda
```

Media access metadata is set when content is queued. Use the numeric level from the site's access-control config, for
example `--required-access-level 200` for Kriyaban-only Luca content.

### Ingestion Run History

Manual non-crawler ingestion commands are recorded in an append-only local JSONL
ledger at `.cache/ingestion-runs/ingestion_runs.jsonl` by default. This covers:

- SQL/database ingestion via `sql_to_vector_db/ingest_db_text.py`
- Media queue creation and management via `audio_video/manage_queue.py`
- Media queue processing via `audio_video/transcribe_and_ingest_media.py`

List the most recent successful runs before starting the next ingestion:

```bash
python bin/list_ingestion_runs.py --site ananda --status completed
```

Useful filters:

```bash
python bin/list_ingestion_runs.py --site ananda --method sql_database
python bin/list_ingestion_runs.py --site ananda --method media_queue --library bhaktan
python bin/list_ingestion_runs.py --site ananda --method media_process --index ananda-production
```

Each record includes a copy-pasteable `command`, raw Python argv, parsed
arguments, target Pinecone index from the environment, source summary, queue
status or processing counts, git SHA, and whether the repo was dirty. Set
`INGESTION_RUN_LOG_PATH` to write or read a different ledger location.

After successful ingestion that adds or changes `metadata.title` values, refresh
the title catalog using the checklist in `../docs/title-scope-ingestion-guide.md`.

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

## Dependencies

- **Python 3.10+**
- **spaCy**: Semantic text processing
- **LangChain**: Document processing pipeline
- **Pinecone**: Vector database operations
- **AssemblyAI**: Audio transcription service
- **pdfplumber**: PDF text extraction with superior layout preservation
