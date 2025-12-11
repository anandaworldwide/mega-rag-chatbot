# Getting Started with Mega RAG Chatbot

This guide walks you through setting up your development environment and getting your first RAG chatbot running.

## Prerequisites

Before you begin, ensure you have the following installed:

1. **Node.js** (version 18+) - [Download from nodejs.org](https://nodejs.org/)
2. **Python 3.12.3** - We recommend using pyenv for Python version management
3. **Firebase CLI** (optional for local development)

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/anandaworldwide/mega-rag-chatbot
cd mega-rag-chatbot
```

### Step 2: Install Node Dependencies

This project uses npm workspaces. Run the following at the root:

```bash
npm install
```

After installation, you should see a `node_modules` folder.

### Step 3: Set Up Python Virtual Environment

#### Install pyenv (if not already installed)

**For macOS/Linux:**

```bash
curl https://pyenv.run | bash
```

**For Windows (use pyenv-win):**

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://raw.githubusercontent.com/pyenv-win/pyenv-win/master/pyenv-win/install-pyenv-win.ps1" `
  -OutFile "./install-pyenv-win.ps1"; &"./install-pyenv-win.ps1"
```

#### Install Python 3.12.3 and Create Virtual Environment

```bash
# Install Python 3.12.3
pyenv install 3.12.3

# Create a virtual environment
pyenv virtualenv 3.12.3 mega-rag-chatbot

# Activate it automatically when you enter the directory
pyenv local mega-rag-chatbot

# Install Python dependencies
pip install -r requirements.txt
```

## Environment Variables Setup

### Step 1: Create Environment Files

Copy the example environment file and create site-specific configs:

```bash
cp .env.example .env
cp .env.example .env.[site]
```

Replace `[site]` with your specific site name (e.g., `ananda`, `mysite`).

### Step 2: Configure Required Variables

Fill in the required values in your `.env.[site]` file:

```env
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Pinecone Configuration
PINECONE_API_KEY=your_pinecone_api_key_here
PINECONE_INDEX_NAME=your_pinecone_index_name

# Firebase Configuration
GOOGLE_APPLICATION_CREDENTIALS=path/to/your/firebase-credentials.json

# Redis Configuration (for rate limiting)
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

# Site Configuration
SITE=your_site_name
```

### Step 3: Get Your API Keys

- **OpenAI**: Visit [OpenAI API Keys](https://help.openai.com/en/articles/4936850-where-do-i-find-my-secret-api-key) to
  retrieve your API key
- **Pinecone**: Visit [Pinecone](https://pinecone.io/) to create an account and retrieve your API keys, environment, and
  index name from the dashboard. **Important**: Use 1,536 dimensions when setting up your Pinecone index.
- **Upstash**: Visit [Upstash](https://upstash.com/) to create a Redis instance for caching keywords and rate limiting

## Site Configuration

### Create Your Site Config

1. Create a new JSON file for your site in the `site-config` directory:

   ```bash
   touch site-config/your-site-name.json
   ```

2. Use the following structure as a template:

   ```json
   {
     "name": "Your Site Name",
     "tagline": "Your site's tagline",
     "greeting": "Welcome message for users",
     "modelName": "gpt-4o-mini",
     "temperature": 0.7,
     "requireLogin": false,
     "enableGeoAwareness": false,
     "includedLibraries": ["Your Library Name"]
   }
   ```

3. For more examples, see existing configs in the `site-config` directory.

## Data Ingestion

Before you can chat with your content, you need to ingest it into the vector database.

### Ingest PDF Documents

```bash
npm run ingest:pdf -- --file-path ./your-docs --site mysite --library-name "My Library"
```

### Ingest from WordPress Database

```bash
python data_ingestion/sql_to_vector_db/ingest_db_text.py \
  --site mysite \
  --database your_database_name \
  --library-name "My Library"
```

### Crawl and Ingest Websites

```bash
python data_ingestion/crawler/website_crawler.py \
  --domain yourdomain.com \
  --site mysite
```

### Ingest Audio/Video Content

```bash
# Add to queue
python data_ingestion/audio_video/ingest_queue.py \
  --audio 'media/to-process' \
  --author 'Author Name' \
  --library 'Library Name' \
  --site mysite

# Process queue
python data_ingestion/audio_video/transcribe_and_ingest_media.py
```

For detailed ingestion options and commands, see the main README or run any script with `--help`.

## Running the Development Server

Start the development server for your site:

```bash
npm run dev [site]
```

Then open your browser to `http://localhost:3000` and start chatting!

## Testing

### Run JavaScript/TypeScript Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:ci

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm run test:changed -- path/to/file.ts
```

### Run Python Tests

```bash
# Run all Python tests
python -m unittest discover -s data_ingestion/tests/ -p 'test*.py'

# Run a specific test file
python -m unittest data_ingestion/tests/test_file.py
```

### Pre-commit Checks

This repository uses Husky and lint-staged to run tests on changed files before committing, helping catch issues early.

## Python Code Quality

This project uses [Ruff](https://github.com/astral-sh/ruff) for Python linting and formatting.

### Setup for VS Code/Cursor

1. Install the Ruff extension (search for "Ruff" by Charlie Marsh)
2. The project includes pre-configured settings in `.vscode/settings.json` that will:
   - Enable Ruff as the default linter and formatter
   - Auto-fix issues on save
   - Organize imports automatically
   - Show linting errors in the Problems panel

### Manual Linting Commands

```bash
# Check for linting issues
ruff check .

# Fix auto-fixable issues
ruff check --fix .

# Format code
ruff format .
```

## Optional: Firebase Emulator Setup

The Firebase Emulator is optional for local development. It simulates Firebase services locally, which is useful for
development and debugging while avoiding Firebase service charges.

### Install and Configure

```bash
# Install Firebase CLI globally
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize Firebase emulators
firebase init emulators
```

### Enable the Emulator

Add to your shell configuration (e.g., `.bashrc`, `.zshrc`):

```bash
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
```

## Advanced Configuration

### Adding a New Site

1. Copy an existing site config:

   ```bash
   cp site-config/config.json site-config/config.[newsite].json
   ```

2. Edit the new config file with your site's details

3. Create a system prompt file:

   ```bash
   touch site-config/prompts/[newsite]-prompt.txt
   ```

4. Update the config file to reference the correct prompt

5. Create a site-specific environment file:

   ```bash
   cp .env.example .env.[newsite]
   ```

6. Configure your site's API keys and settings

### Using S3 for Prompts (Optional)

You can store prompt files in AWS S3 instead of the local filesystem.

#### Configure S3 Access

Add to your `.env` file:

```env
AWS_REGION=us-west-1
S3_BUCKET_NAME=your-bucket-name
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

#### Reference S3 Files in Config

In your site's prompt config (e.g., `site-config/prompts/[site].json`), prefix S3-stored files with `s3:`:

```json
{
  "templates": {
    "baseTemplate": {
      "file": "s3:your-site-base.txt"
    },
    "localTemplate": {
      "file": "local-file.txt"
    }
  }
}
```

#### Manage S3 Prompts

```bash
# Pull a prompt from S3 (and acquire lock)
npm run prompt [site] pull [filename]

# Edit the local copy
npm run prompt [site] edit [filename]

# See differences between local and S3 version
npm run prompt [site] diff [filename]

# Push changes back to S3 (and release lock)
npm run prompt [site] push [filename]
```

**Note**: S3 prompt files are currently shared between development and production environments. Changes affect all
environments immediately.

## Next Steps

- Review the [Architecture Documentation](backend-structure.md) to understand the system
- Explore [Site Configuration Options](PRD.md) for customization details
- Read [Security Best Practices](SECURITY-README.md) before deploying to production
- Check out the [WordPress Plugin](../wordpress/plugins/ananda-ai-chatbot/README.md) for website integration

## Need Help?

- Check the [Troubleshooting Guide](TROUBLESHOOTING.md) for common issues
- Visit the [GitHub Discussions](https://github.com/anandaworldwide/mega-rag-chatbot/discussions) for community support
- Report bugs in the [Issue Tracker](https://github.com/anandaworldwide/mega-rag-chatbot/issues)
