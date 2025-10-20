# Troubleshooting Guide

This guide covers common issues and their solutions when working with the Mega RAG Chatbot.

## General Guidelines

- Keep an eye on the [Issues](https://github.com/anandaworldwide/mega-rag-chatbot/issues) and
  [Discussions](https://github.com/anandaworldwide/mega-rag-chatbot/discussions) sections of this repo for solutions
- Check the console output and error logs for specific error messages
- Verify all environment variables are correctly set before debugging

## General Errors

### Node.js Version Issues

**Problem**: Build or runtime errors related to Node.js

**Solution**:

```bash
# Check your Node version
node -v

# Should be 18.x or higher
# If not, install the latest LTS version from nodejs.org
```

### PDF Processing Errors

**Problem**: Unable to process certain PDF files

**Solutions**:

- Try a different PDF to verify the script works correctly
- Your PDF may be corrupted, scanned, or require OCR to convert to text
- Convert the PDF to text first, then ingest the text file
- Check that the PDF is not password-protected or encrypted

### Environment Variables Not Loading

**Problem**: Application can't find API keys or configuration values

**Solutions**:

```bash
# Console.log the env variables to verify they're exposed
console.log(process.env.OPENAI_API_KEY); # Should not be undefined
```

- Verify you've created the correct `.env.[site]` file in the root directory
- Check that your `.env.[site]` file contains valid API keys and configuration
- Ensure there are no typos in variable names
- Restart the development server after changing environment variables

## Pinecone Errors

### Environment and Index Mismatch

**Problem**: Unable to connect to Pinecone or vectors not appearing

**Solution**:

- Verify your Pinecone dashboard `environment` and `index` match the values in your `.env.[site]` file
- Double-check the exact spelling and case of your index name
- Ensure your Pinecone API key is valid and has access to the specified index

### Vector Dimension Errors

**Problem**: Dimension mismatch errors when upserting vectors

**Solution**:

Check that you've set the `OPENAI_EMBEDDINGS_DIMENSION` environment variable correctly:

- For `text-embedding-ada-002`: use **1536**
- For `text-embedding-3-small`: use **1536**
- For `text-embedding-3-large`: use **3072** (or configurable)

Verify your Pinecone index was created with the correct dimensions matching your embedding model.

## Firebase / Firestore Errors

### Firebase Authentication Errors

**Problem**: Unable to connect to Firebase or Firestore

**Solutions**:

- Verify your `GOOGLE_APPLICATION_CREDENTIALS` path is correct and the file exists
- Check that the service account has the necessary permissions (Firestore read/write)
- Ensure the Firebase project ID matches your configuration

### Firestore Emulator Issues

**Problem**: Emulator not connecting or data not persisting

**Solutions**:

```bash
# Verify emulator environment variable is set
echo $FIRESTORE_EMULATOR_HOST
# Should output: 127.0.0.1:8080

# Restart the emulator
firebase emulators:start
```

- Make sure the emulator is running before starting your dev server
- Check that no other process is using port 8080

## Data Ingestion Issues

### WordPress Database Connection Errors

**Problem**: Cannot connect to MySQL database for WordPress ingestion

**Solutions**:

- Verify MySQL connection details in your `.env.[site]` file:
  - `DB_USER`
  - `DB_PASSWORD`
  - `DB_HOST`
  - `DB_PORT` (usually 3306)
- Test MySQL connection separately:

  ```bash
  mysql -h localhost -u your_user -p your_database
  ```

- Ensure the database exists and contains WordPress tables

### Web Crawler Not Finding Content

**Problem**: Website crawler returns few or no results

**Solutions**:

- Check the site's `robots.txt` to ensure crawling is allowed
- Verify the domain is accessible from your network
- Use `--active-hours` flag to crawl during specific times
- Review failed URLs with the `--report` flag
- Check for rate limiting or anti-bot protections on the target site

### Audio/Video Transcription Failing

**Problem**: Whisper transcription errors or timeouts

**Solutions**:

- Ensure you have enough disk space for temporary files
- Check that ffmpeg is installed and accessible:

  ```bash
  ffmpeg -version
  ```

- For large files, consider splitting them into smaller chunks
- Verify your OpenAI API key has access to Whisper API
- Check OpenAI API rate limits and quotas

## Testing Issues

### Tests Failing After Setup

**Problem**: Test suite fails on first run

**Solutions**:

- Ensure all dependencies are installed:

  ```bash
  npm install
  ```

- Clear Jest cache:

  ```bash
  npm test -- --clearCache
  ```

- Check that test environment variables are set in `.env.test`

## Production Deployment Issues

### Vercel Build Failures

**Problem**: Build fails on Vercel but works locally

**Solutions**:

- Check Vercel build logs for specific errors
- Verify all environment variables are set in Vercel dashboard
- Ensure `package.json` scripts match Vercel build configuration
- Check that `next.config.js` is properly configured for production

### Environment Variables Not Available in Production

**Problem**: App works locally but fails in production due to missing env vars

**Solutions**:

- Add all required environment variables to your deployment platform (Vercel, etc.)
- Verify variable names match exactly (case-sensitive)
- Redeploy after adding environment variables
- Check that sensitive variables are not committed to `.env` files (use `.env.local` for local secrets)

## Getting More Help

If you're still experiencing issues:

1. **Search Existing Issues**: Check the [GitHub Issues](https://github.com/anandaworldwide/mega-rag-chatbot/issues)
   page for similar problems
2. **GitHub Discussions**: Ask for help in
   [Discussions](https://github.com/anandaworldwide/mega-rag-chatbot/discussions)
3. **Create an Issue**: If you've found a bug, create a new issue with:
   - Clear description of the problem
   - Steps to reproduce
   - Error messages and logs
   - Your environment (OS, Node version, Python version)
   - Relevant configuration (with sensitive data removed)

## Diagnostic Commands

Here are useful commands for gathering diagnostic information:

```bash
# System information
node -v
python --version
npm -v

# Check environment variables (sanitized)
env | grep -i "site\|openai\|pinecone" | sed 's/=.*/=***/'

# Check port availability
lsof -i :3000

# Check disk space
df -h

# Check running processes
ps aux | grep node

# Test network connectivity
ping pinecone.io
curl -I https://api.openai.com

# View recent logs
tail -f .next/server.log  # If logging is configured
```
