# Crawler Daemon Management

The web crawler runs as a macOS LaunchAgent daemon that automatically manages the crawling process with bounded
execution and intelligent restarts.

> **Note**: If you're switching between cloud (AWS ECS) and local (daemon) operation, see the
> [Switching Between Cloud and Local Operation](../CLOUD-DEPLOYMENT.md#switching-between-cloud-and-local-operation)
> section in `CLOUD-DEPLOYMENT.md`. **Never run both simultaneously** - this causes duplicate crawling and database
> conflicts.

## Quick Start

### One-time Setup

1. **Copy the plist file to LaunchAgents:**

   ```bash
   cp com.ananda.crawler.plist ~/Library/LaunchAgents/com.ananda.crawler.${SITE}.plist
   ```

2. **Load the service:**

   ```bash
   launchctl load ~/Library/LaunchAgents/com.ananda.crawler.${SITE}.plist
   ```

   Replace `${SITE}` with your site name (e.g., `ananda-public`, `crystal`, `jairam`)

### Daily Management

Use the `manage_crawler.sh` script for all crawler operations:

```bash
# Restart the crawler (most common operation)
./manage_crawler.sh restart

# Show crawler status
./manage_crawler.sh status

# View logs in real-time
./manage_crawler.sh logs

# Stop the crawler
./manage_crawler.sh stop

# Start the crawler
./manage_crawler.sh start

# Get help
./manage_crawler.sh help
```

## Management Script

### `manage_crawler.sh`

All-in-one script for managing the crawler daemon.

**Usage:**

```bash
./manage_crawler.sh [command] [site-name]
```

**Available Commands:**

- `start` - Start the crawler daemon
- `stop` - Stop the crawler daemon
- `restart` - Restart the crawler daemon (most common)
- `status` - Show current status and recent logs
- `logs` - Tail the log files in real-time

**Examples:**

```bash
./manage_crawler.sh restart             # Restart default site (ananda-public)
./manage_crawler.sh status crystal      # Show status for crystal site
./manage_crawler.sh logs jairam         # Follow logs for jairam site
```

## Manual launchctl Commands

If you prefer to use launchctl directly (replace `${SITE}` with your site name):

```bash
# Restart (kill and restart atomically)
launchctl kickstart -k gui/$(id -u)/com.ananda.crawler.${SITE}

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.ananda.crawler.${SITE}.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.ananda.crawler.${SITE}.plist

# Check if service is loaded
launchctl list | grep crawler

# View service details
launchctl print gui/$(id -u)/com.ananda.crawler.${SITE}
```

## Log Files

Logs are written to `~/Library/Logs/AnandaCrawler/`:

- **Supervisor log:** `supervisor_${SITE}.log` - Daemon management and restart logic
- **Crawler log:** `crawler_${SITE}.log` - Actual crawling activity

**View logs:**

```bash
# Follow both logs (replace ${SITE} with your site name)
tail -f ~/Library/Logs/AnandaCrawler/supervisor_${SITE}.log \
        ~/Library/Logs/AnandaCrawler/crawler_${SITE}.log

# View last 100 lines
tail -100 ~/Library/Logs/AnandaCrawler/crawler_${SITE}.log

# Search all logs for errors
grep ERROR ~/Library/Logs/AnandaCrawler/*.log
```

## How the Daemon Works

1. **LaunchAgent** starts `crawler_supervisor.py` on system startup
2. **Supervisor** manages crawler instances with bounded execution (45-minute runs)
3. **Crawler** processes URLs, then exits after 45 minutes
4. **Supervisor** waits 5 minutes (cooldown) and starts a new crawler instance
5. **Health monitoring** restarts the crawler if it becomes wedged
6. **KeepAlive** ensures the supervisor restarts if it crashes

This design prevents:

- Memory leaks from long-running processes
- Browser process accumulation
- Database connection staleness
- Resource exhaustion

## Configuration

### Plist Configuration

Key settings in `com.ananda.crawler.${SITE}.plist`:

- **Label:** `com.ananda.crawler.${SITE}` (must match filename)
- **KeepAlive:** `true` (supervisor always runs)
- **RunAtLoad:** `true` (start on system boot)
- **ThrottleInterval:** 30 seconds (rate limit restarts)
- **StandardOutPath/StandardErrorPath:** Log file location

### Crawler Configuration

Crawler settings in `crawler_config/${SITE}-config.json`:

- **domain:** Target website
- **skip_patterns:** URL patterns to ignore
- **crawl_frequency_days:** How often to re-crawl URLs
- **crawl_delay_seconds:** Delay between requests
- **csv_export_url:** Optional CSV feed for priority updates

## Environment Files

The crawler loads environment variables from `.env.${SITE}` in the project root:

```bash
# Required variables
PINECONE_API_KEY=...
PINECONE_INGEST_INDEX_NAME=...
OPENAI_API_KEY=...
OPENAI_INGEST_EMBEDDINGS_MODEL=...
SITE=${SITE}
```

Example: For `ananda-public`, create `.env.ananda-public` with `SITE=ananda-public`

## Security & Permissions

- Service runs as your user account (not root)
- Logs readable only by you
- Database files have user-only permissions
- Lock files prevent multiple simultaneous crawls

## Uninstalling

To completely remove the crawler daemon:

```bash
# Stop and unload the service
launchctl unload ~/Library/LaunchAgents/com.ananda.crawler.ananda-public.plist

# Remove the plist file
rm ~/Library/LaunchAgents/com.ananda.crawler.ananda-public.plist

# Optionally remove logs and database
rm -rf ~/Library/Logs/AnandaCrawler/
rm -rf data_ingestion/crawler/db/
```
