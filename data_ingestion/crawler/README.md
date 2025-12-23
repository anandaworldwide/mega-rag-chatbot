# Website Crawler

A robust, production-ready website crawler designed for the Ananda Library Chatbot project. The crawler extracts content
from websites, processes it using spaCy-based semantic chunking, and stores embeddings in Pinecone for
retrieval-augmented generation (RAG) systems.

## Features

### Core Functionality

- **Intelligent Crawling**: Respects robots.txt, implements rate limiting, and handles failures gracefully
- **Content Processing**: Uses spaCy for semantic text chunking with 300-500 token targets and 20% overlap
- **Vector Storage**: Automatically generates and stores embeddings in Pinecone vector database
- **Multi-Site Support**: Configurable for different domains with site-specific settings
- **Change Detection**: Only processes content when it has actually changed (SHA-256 hash comparison)
- **CSV Mode**: High-priority processing of URLs from CSV exports with modification date tracking

### Reliability & Monitoring

- **Database-Driven Queue**: SQLite-based crawl queue with retry logic and exponential backoff
- **Health Check Server**: Flask-based monitoring endpoint with detailed statistics
- **Email Alerts**: Automatic email notifications for critical issues (process down, wedged crawler, database errors)
- **Supervisor Service**: macOS launchd integration with bounded execution (45-minute cycles)
- **Log Rotation**: Python-based log rotation with compression and automatic cleanup
- **Graceful Shutdown**: Proper signal handling and state preservation

### Advanced Features

- **Priority System**: High-priority URLs (e.g., from CSV) are processed first
- **Failure Classification**: Distinguishes between temporary and permanent failures
- **Menu Expansion**: JavaScript-based menu interaction for comprehensive link discovery
- **Content Extraction**: Multiple fallback methods including readability library
- **Robots.txt Compliance**: Automatic robots.txt checking with 24-hour caching

## Installation

### Prerequisites

- Python 3.10+
- Required Python packages (see requirements.txt)
- macOS (for daemon support) or Docker (for cloud deployment)
- Access to Pinecone and OpenAI APIs

### Deployment Options

The crawler can run in two modes:

1. **Local (macOS)**: Uses macOS LaunchAgent for 24/7 operation
2. **Cloud (AWS ECS)**: Scheduled execution on AWS Fargate (9am-5pm PT daily)

See [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md) for cloud deployment instructions.

### Setup

1. **Install Dependencies**

   ```bash
   cd data_ingestion
   pip install -r requirements.txt
   ```

2. **Configure Environment** Create a `.env.{site_id}` file in the project root:

   ```bash
   # Example: .env.ananda-public
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_INGEST_EMBEDDINGS_MODEL=text-embedding-3-large
   PINECONE_API_KEY=your_pinecone_api_key
   PINECONE_INGEST_INDEX_NAME=your_index_name
   ```

3. **Create Site Configuration** Create `crawler_config/{site_id}-config.json`:

   ```json
   {
     "domain": "example.com",
     "skip_patterns": ["/admin/", "/wp-admin/", "\\.pdf$", "/feed/"],
     "crawl_frequency_days": 14,
     "crawl_delay_seconds": 1,
     "csv_export_url": "https://example.com/export.csv",
     "csv_modified_days_threshold": 1
   }
   ```

## Usage

### Basic Crawling

```bash
# Start crawling a site
python website_crawler.py --site ananda-public

# Start with debug logging and screenshots
python website_crawler.py --site ananda-public --debug

# Clear existing vectors and start fresh
python website_crawler.py --site ananda-public --clear-vectors

# Process only 10 pages (for testing)
python website_crawler.py --site ananda-public --stop-after 10

# Retry previously failed URLs
python website_crawler.py --site ananda-public --retry-failed

# Start with a clean database
python website_crawler.py --site ananda-public --fresh-start
```

### Health Monitoring

The crawler includes a comprehensive health monitoring system using macOS LaunchAgents:

```bash
# Run hourly health check (sends alerts if issues detected)
python health_cron_check.py --site ananda-public

# Run daily health report (comprehensive email report)
python health_daily_report.py --site ananda-public
```

See [HEALTH_CRON_README.md](HEALTH_CRON_README.md) for detailed setup instructions.

### Supervisor Service Management

The crawler now uses a bounded execution supervisor managed by macOS launchd:

```bash
# Check service status
launchctl list com.ananda.crawler

# Start service
launchctl start com.ananda.crawler

# Stop service
launchctl stop com.ananda.crawler

# View logs
tail -f ~/Library/Logs/AnandaCrawler/supervisor_ananda-public.log

# Follow crawler activity logs
tail -f ~/Library/Logs/AnandaCrawler/crawler_ananda-public.log

# Follow both logs simultaneously
tail -f ~/Library/Logs/AnandaCrawler/supervisor_ananda-public.log ~/Library/Logs/AnandaCrawler/crawler_ananda-public.log
```

### Log Management

```bash
# Rotate logs manually
python bin/log_rotate.py --log-dir ~/Library/Logs/AnandaCrawler

# Check what would be rotated (dry run)
python bin/log_rotate.py --log-dir ~/Library/Logs/AnandaCrawler --dry-run

# Custom settings
python bin/log_rotate.py --log-dir ~/Library/Logs/AnandaCrawler --max-age-days 7 --no-compress
```

Logs are automatically rotated daily at 2 AM via LaunchAgent.

### Utility Scripts (`bin/`)

The `bin/` directory contains utility scripts for maintenance, health checks, and analysis:

#### Pinecone Health Check

Comprehensive health check for the Pinecone index:

```bash
# Full health check
python bin/pinecone_health_check.py --site ananda-public

# Quick check (skip slow orphaned detection)
python bin/pinecone_health_check.py --site ananda-public --quick

# JSON output for monitoring/alerting
python bin/pinecone_health_check.py --site ananda-public --json
```

**Health Checks Performed:**

- **Stale Records**: Counts vectors with `crawl_timestamp` > 30 days old
- **Missing Timestamps**: Identifies legacy records without `crawl_timestamp` metadata
- **Duplicate URLs**: Finds URLs with vectors from multiple crawl sessions (>1 day apart)
- **Age Distribution**: Breakdown of all vectors by age (7 days, 30 days, 60 days, 90+ days)
- **Orphaned Records**: Vectors that don't exist in the SQLite database (sampled)

**Recommended Usage**: Run weekly or monthly to monitor Pinecone health and catch stale/duplicate records early.

#### Cleanup Old Pinecone Vectors

Remove duplicate vectors by keeping only the latest crawl_timestamp for each URL:

```bash
# With confirmation prompts
python bin/cleanup_old_pinecone_vectors.py --site ananda-public --confirm

# Automatic deletion (no prompts)
python bin/cleanup_old_pinecone_vectors.py --site ananda-public
```

This script only deletes vectors that are **at least 1 day older** than the latest timestamp to avoid accidentally
removing chunks from the same crawl session.

#### Check Crawl Queue Status

Analyze the crawl queue to see what's due for processing:

```bash
python bin/check_priority_due.py --site ananda-public
```

Shows:

- Overall queue statistics by status
- Priority distribution
- URLs due for processing right now
- Recent crawling activity

#### Check Robots.txt Compliance

Verify that the crawler respected robots.txt rules:

```bash
python bin/check_robots_compliance.py --site ananda-public

# Remove disallowed URLs from database
python bin/check_robots_compliance.py --site ananda-public --clean
```

#### Delete Vectors by Skip Pattern

Remove Pinecone vectors matching URL skip patterns:

```bash
# Dry run (preview what would be deleted)
python bin/delete_by_skip_pattern.py --site ananda-public --dry-run

# Actually delete matching vectors
python bin/delete_by_skip_pattern.py --site ananda-public
```

#### Log Rotation

Rotate and compress old log files:

```bash
# Rotate logs manually
python bin/log_rotate.py --log-dir ~/Library/Logs/AnandaCrawler

# Dry run
python bin/log_rotate.py --log-dir ~/Library/Logs/AnandaCrawler --dry-run
```

### LaunchAgent Setup (macOS)

The crawler uses macOS LaunchAgents instead of traditional cron jobs for better security compliance and reliability on
modern macOS systems.

#### Log Rotation LaunchAgent

The log rotation LaunchAgent is automatically configured and runs daily at 2:00 AM:

```bash
# Check if log rotation LaunchAgent is loaded
launchctl list | grep com.ananda.log-rotate

# Manually trigger log rotation (for testing)
launchctl start com.ananda.log-rotate

# View log rotation output
tail -f ~/Library/Logs/AnandaCrawler/log-rotate.log

# View log rotation errors (if any)
tail -f ~/Library/Logs/AnandaCrawler/log-rotate-error.log
```

#### Health Monitoring LaunchAgents

For automated health monitoring, create LaunchAgents for the health check scripts:

```bash
# Create hourly health check LaunchAgent
cat > ~/Library/LaunchAgents/com.ananda.health-check.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ananda.health-check</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/$(whoami)/bin/health_cron_check.py</string>
        <string>--site</string>
        <string>ananda-public</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/$(whoami)/Library/Logs/AnandaCrawler/health-check.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/$(whoami)/Library/Logs/AnandaCrawler/health-check-error.log</string>
</dict>
</plist>
EOF

# Load the health check LaunchAgent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ananda.health-check.plist
```

**Note**: Copy the health check script to `~/bin/` first:

```bash
cp data_ingestion/crawler/health_cron_check.py ~/bin/
chmod +x ~/bin/health_cron_check.py
```

#### LaunchAgent Management Commands

```bash
# List all Ananda LaunchAgents
launchctl list | grep com.ananda

# Load a LaunchAgent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ananda.service-name.plist

# Unload a LaunchAgent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ananda.service-name.plist

# Start a LaunchAgent manually
launchctl start com.ananda.service-name

# Check LaunchAgent status
launchctl list com.ananda.service-name
```

## Configuration

### Site Configuration Options

| Option                        | Description                                  | Default  |
| ----------------------------- | -------------------------------------------- | -------- |
| `domain`                      | Target domain to crawl                       | Required |
| `skip_patterns`               | Regex patterns for URLs to skip              | `[]`     |
| `crawl_frequency_days`        | Days between re-crawling visited pages       | `14`     |
| `crawl_delay_seconds`         | Delay between requests (rate limiting)       | `1`      |
| `csv_export_url`              | URL for CSV export (optional)                | `null`   |
| `csv_modified_days_threshold` | Only process CSV URLs modified within N days | `1`      |

### Environment Variables

| Variable                         | Description                   | Required |
| -------------------------------- | ----------------------------- | -------- |
| `OPENAI_API_KEY`                 | OpenAI API key for embeddings | Yes      |
| `OPENAI_INGEST_EMBEDDINGS_MODEL` | Embedding model to use        | Yes      |
| `PINECONE_API_KEY`               | Pinecone API key              | Yes      |
| `PINECONE_INGEST_INDEX_NAME`     | Pinecone index name           | Yes      |

## Architecture

### Components

```text
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web Crawler   │    │  Health Server  │    │   Supervisor    │
│   (45-min       │    │                 │    │   Service       │
│    bounded)     │    │ • Status check  │    │ • Bounded exec  │
│ • Content fetch │    │ • Statistics    │    │ • Auto-restart  │
│ • Link discovery│    │ • Process info  │    │ • launchd       │
│ • Queue mgmt    │    │ • Email alerts  │    │ • Log rotation  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │ SQLite Database │
                    │                 │
                    │ • crawl_queue   │
                    │ • csv_tracking  │
                    └─────────────────┘
```

### Data Flow

1. **URL Discovery**: Extract links from crawled pages
2. **Queue Management**: Add new URLs to SQLite queue with priority
3. **Content Processing**: Extract and clean HTML content
4. **Text Chunking**: Use spaCy for semantic chunking (300-500 tokens)
5. **Embedding Generation**: Create vectors using OpenAI embeddings
6. **Vector Storage**: Store in Pinecone with metadata
7. **Status Tracking**: Update database with crawl status and next crawl time

### Error Handling and 404 Processing

The crawler implements intelligent error handling with special processing for 404 errors:

#### 404 Error Handling

- **Detection**: 404 HTTP status codes are automatically detected during crawling
- **Retry Logic**: 404 errors are given up to 3 retry attempts (1hr, 6hr, 24hr intervals) in case they are temporary
  server issues
- **Database Status**: Only after retry exhaustion are URLs marked with `status = 'deleted'` for Pinecone cleanup
- **Pinecone Cleanup**: The system automatically removes all vector embeddings for permanently deleted URLs
- **Processing Flow**:
  1. URL returns 404 during recrawl
  2. URL is marked as `'pending'` with `failure_type = '404_retriable'` for retry
  3. After 3 failed retry attempts, URL status is set to `'deleted'` with `failure_type = '404_permanent'`
  4. During maintenance cycles, pending deletions are processed
  5. All vectors for the URL are queried and removed from Pinecone
  6. URL is marked as `'pinecone_cleaned'` to prevent reprocessing

#### Other Error Types

- **Temporary Failures** (5xx, timeouts, connection issues): Scheduled for retry with exponential backoff
- **Permanent Failures** (4xx except 404, forbidden): Marked as failed, no retry
- **Rate Limiting**: Automatic backoff and retry with increased delays

This ensures that the vector database stays clean and doesn't contain stale content for pages that no longer exist.

### Database Schema

```sql
-- Main crawl queue
CREATE TABLE crawl_queue (
    url TEXT PRIMARY KEY,
    last_crawl TIMESTAMP,
    next_crawl TIMESTAMP,
    crawl_frequency INTEGER,
    content_hash TEXT,
    last_error TEXT,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    retry_after TIMESTAMP,
    failure_type TEXT,
    priority INTEGER DEFAULT 0,
    modified_date TIMESTAMP
);

-- CSV tracking
CREATE TABLE csv_tracking (
    id INTEGER PRIMARY KEY,
    initial_crawl_completed BOOLEAN DEFAULT 0,
    last_check_time TEXT,
    last_error TEXT
);
```

## Monitoring

### Health Check Endpoints

- **GET /health** - Comprehensive health check with database stats, process info, and configuration
- **GET /stats** - Quick statistics summary
- **GET /** - Service information and available endpoints

### Health Status Levels

- **healthy** - All systems operational
- **warning** - Minor issues (e.g., no crawler processes detected)
- **degraded** - Major issues (e.g., database unavailable)

### Log Files

Service logs are stored in `~/Library/Logs/AnandaCrawler/`:

- `supervisor-{site_id}.log` - Supervisor service output
- `crawler_{site_id}.log` - Crawler activity output
- `*_*.log.gz` - Rotated compressed logs (automatic daily rotation)

## Development

### Running Tests

```bash
# Run all crawler tests
cd data_ingestion
python -m pytest tests/test_crawler.py -v

# Run all tests
python -m pytest tests/ -v

# Run with coverage
python -m pytest tests/ --cov=crawler --cov-report=html
```

### Adding New Sites

1. Create environment file: `.env.{site_id}`
2. Create configuration: `crawler_config/{site_id}-config.json`
3. Test configuration: `python website_crawler.py --site {site_id} --stop-after 5`
4. Update launchd plist with new site ID
5. Load the service: `launchctl load ~/Library/LaunchAgents/com.ananda.crawler.plist`

### Debugging

Use the `--debug` flag for detailed logging and screenshots:

```bash
python website_crawler.py --site ananda-public --debug --stop-after 1
```

This will:

- Enable DEBUG level logging
- Save screenshots of crawled pages
- Show detailed HTML processing information
- Display menu expansion attempts

### Performance Tuning

#### Crawl Speed

- Adjust `crawl_delay_seconds` in site config
- Increase browser restart frequency (modify `PAGES_PER_RESTART`)
- Use `--stop-after` for testing

#### Memory Usage

- Automatic log rotation via LaunchAgent (daily at 2 AM)
- Set resource limits in launchd plist
- Monitor with health check endpoint

#### Storage Optimization

- Regular database cleanup of old failed URLs
- Compress rotated logs
- Monitor Pinecone usage

## Contributing

1. Follow existing code patterns and documentation standards
2. Add tests for new functionality
3. Update this README for new features
4. Test with multiple sites before submitting changes

## License

This crawler is part of the Ananda Library Chatbot project and follows the project's licensing terms.
