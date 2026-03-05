# Project Memory - Essential Lessons Learned

## Critical Bug Patterns to Avoid

### HTML Processing Issues

- **Issue**: Inline tags like `<em>`, `<strong>`, `<span>` incorrectly treated as paragraph boundaries
- **Fix**: Use `soup.get_text()` without separator parameter, handle block vs inline elements separately
- **Location**: `data_ingestion/utils/text_processing.py`

### Python @patch Decorator Paths When Refactoring

- **Issue**: `@patch` decorators need path updates when modules are moved
- **Fix**: Update both import statements AND @patch decorator paths
- **Critical Rule**: Patch where the function is **USED**, not where it's **DEFINED**
- **Example**: If `crawl_loop.py` does `from .browser import _setup_crawler_browser`, patch
  `crawler.crawl_loop._setup_crawler_browser`, NOT `crawler.browser._setup_crawler_browser`
- **Pattern**: `@patch("data_ingestion.audio_video.s3_utils.*")` → `@patch("data_ingestion.utils.s3_utils.*")`

### Python Relative Imports for Both Module and Direct Execution

- **Issue**: Relative imports (`from .config import ...`) fail when running script directly
- **Fix**: Use try/except to support both execution modes:

```python
try:
    from .config import load_config  # Module execution
except ImportError:
    from config import load_config  # type: ignore  # Direct execution
```

- **Apply to**: All modules with relative imports when refactoring to submodules

### Environment Variables Don't Persist

- **Issue**: Environment variables don't persist across terminal sessions
- **Fix**: Always source `.env.ananda` and set variables in same shell session before running scripts
- **Critical**: Check which embedding models you're actually comparing

### Package-lock.json Changes

- **Issue**: Root `npm install` adds unnecessary platform-specific packages
- **Fix**: Always discard with `git checkout package-lock.json` - they're optional dependencies

## Performance and Architecture Decisions

### Chunking Strategy - PROVEN OPTIMAL

- **Current**: 600 tokens, 20% overlap with spaCy sentence-boundary chunking
- **Result**: 70%+ target range compliance (225-450 words)
- **Don't change**: All evaluations show current system is optimal

### Audio/Video Chunking Strategy

- **Rule**: Keep timestamp alignment **word-based** (derive `start_time`/`end_time` from Whisper word timestamps) to
  avoid drift.
- **Tuning**: You can increase chunk size for retrieval quality without affecting timestamp correctness by changing the
  **word-count target**, not by mapping text chunks back onto words.

### Embedding Models

- **Production**: text-embedding-ada-002 (1536D) - proven performance
- **Avoid**: text-embedding-3-large (3072D) - 84-90% performance degradation
- **Lesson**: Higher dimensions != better performance for this domain

### Rate Limiting Implementation

- **Tool**: Redis-based with exponential backoff
- **Location**: `web/src/utils/server/genericRateLimiter.ts`
- **Cleanup**: Use cron job to prune old entries

## Development Workflow

### Memory Management (Critical)

- **Always read** `@self.md` and `@project.md` first
- **Always update** memory after fixing mistakes
- **Only store** general, reusable lessons (not request-specific details)

### Testing Requirements

- **Frontend**: `cd web && npm run test:all`
- **Python**: `cd data_ingestion && python -m pytest`
- **Python dependency security audit**: Run `./bin/run-pip-audit.sh` from repo root to audit all maintained requirements
  files (`requirements.txt`, `reranking/requirements.txt`, `data_ingestion/crawler/requirements.txt`,
  `wordpress/analytics/requirements.txt`)
- **If pip-audit is not found locally**: run with `PATH="$HOME/.local/bin:$PATH" ./bin/run-pip-audit.sh`
- **Pattern**: Write tests first, add to existing test files when logical

### CLI Argument Patterns

- **Preference**: Long-form arguments first in argparse
- **Environment**: Use `--site` argument with `pyutil.env_utils.load_env(site_name)`
- **Example**: `parser.add_argument("--video", "-v", ...)` not `("-v", "--video", ...)`
- **Site and Environment Pattern**:
  - Always add `--site` argument (required) for loading `.env.[site]` files
  - Add `-e` or `--env` argument with `choices=['dev', 'prod']` and `default='prod'` (or 'dev' if appropriate)
  - Call `load_env(args.site)` from `pyutil.env_utils` after parsing arguments
  - Load environment variables from `.env.[site]` file (searches current directory and up to 3 levels up)
  - Example:

    ```python
    from pyutil.env_utils import load_env

    parser.add_argument("--site", required=True, help="Site ID for environment variables")
    parser.add_argument("-e", "--env", choices=['dev', 'prod'], default='prod', help="Environment")
    args = parser.parse_args()
    load_env(args.site)  # Loads .env.[site] file
    ```

### Running Cron Jobs from Command Line

- **Authentication**: Cron endpoints use `withJwtOrCronAuth` which checks User-Agent header
- **Required Headers**: Must set `User-Agent: vercel-cron/1.0` AND `Authorization: Bearer $CRON_SECRET` to use
  CRON_SECRET auth
- **Pattern**: Without User-Agent header, request falls back to JWT authentication instead
- **Example**:
  `curl -X POST http://localhost:3000/api/cron/processOnboardingEmails -H "Authorization: Bearer $CRON_SECRET" -H "User-Agent: vercel-cron/1.0"`
- **Location**: `web/src/utils/server/cronAuthUtils.ts` - checks `userAgent.startsWith("vercel-cron/")`

## Security and Deployment

### JWT Authentication

- **Implementation**: HttpOnly cookies with proper sameSite/secure flags
- **Location**: `web/src/utils/server/jwtUtils.ts`
- **Critical**: Always hash passwords with bcrypt

### CORS and Headers

- **Security headers**: CSP, HSTS, X-Frame-Options required
- **WordPress integration**: Use signed tokens for cross-site communication

### AWS Scheduling (Crawler)

- Prefer **EventBridge Scheduler** `ScheduleExpressionTimezone` (e.g. `America/Los_Angeles`) over hardcoding UTC cron
  expressions to avoid DST/UTC conversion mistakes.
- For the crawler, prefer **one-shot scheduled ECS tasks** with `--max-runtime-minutes` over an always-on ECS service +
  supervisor loop when you want strict “only run in this window” behavior.

### Crawler Deployment ("build and push to production")

- When the user says "build and push to production" for the crawler, this means **deploy to AWS ECS**, not git push.
- **Step 1**: `bash data_ingestion/crawler/bin/build-and-push.sh latest` — builds Docker image for linux/amd64 and
  pushes to ECR (`ananda-crawler` repo in us-west-1)
- **Step 2**: `bash data_ingestion/crawler/bin/register-task-definition.sh latest` — registers new ECS task definition
  revision and updates the EventBridge schedule to use it
- The next hourly scheduled run automatically picks up the new image

### SQLite on EFS (Network Filesystems)

- **Always use WAL mode** for SQLite on EFS/NFS to prevent "database is locked" and "database disk image is malformed"
  errors
- DELETE journal mode is not robust enough for network filesystems with latency
- Required PRAGMAs: `journal_mode=WAL`, `busy_timeout=60000`, `synchronous=NORMAL`
- Use longer connection timeouts (60s+) to handle EFS latency spikes

### AWS Cost Reporting

- Cost Explorer should be queried via `--region us-east-1`, then filtered to the workload region via the `REGION`
  dimension (e.g., `us-west-1`).

## User Preferences

### Code Style

- **TypeScript over JavaScript** - always
- **OOP over functional** - user preference
- **Testing approach**: TDD with failing → passing pattern
- **Documentation**: Update relevant docs with changes
- **Ops email subject naming**: Use site shortname (e.g., Luca, Vivek), not long site name/site ID
- **Crawler daily digest subject order**: Put error count first so inbox preview surfaces errors immediately

### Dependencies

- **Web versions take priority** - align all shared dependencies to `web/package.json`
- **Monorepo**: No local packages, duplicate utilities if needed
- **Version constraints**: `numpy<2.0` important for Python tests

## Site Configuration

- **Multi-site support**: ananda, crystal, jairam, ananda-public
- **Environment files**: `.env.[site]` pattern
- **Pinecone namespaces**: One per site
- **Config location**: `site-config/config.json`
- **System prompts**: Located in `web/site-config/prompts/[site]-base.txt`
- **UUID identification**: All users have UUIDs (JWT token for login-required, cookies for non-login sites)
- **UUID utility**: Use `getSecureUUID()` for API endpoints that work with both authenticated and non-authenticated
  users

## Authentication and Onboarding (Decisions)

- Admin-only onboarding via Add User; no public signup for Ananda and Jairam sites
- Roles: `user`, `admin`, `superuser` (only superuser can grant/revoke admin)
- Bootstrap first admins via environment-gated route/script
- Activation links: magic link, single-use, 14-day expiry; resend allowed; no per-admin daily cap
- Basic entitlements: access to completely unrestricted Pinecone content; site-scoped entitlements and logins
- Phase I: Implement auth, add/resend, activation, audit logging; no Salesforce dependency
- Phase II: Salesforce enrichment on activation + nightly (midnight PT) cron; Salesforce is source of truth;
  auto-up/downgrade; user notified on changes; Ops alerted on repeated sync failures; no local entitlement overrides
- Duplicate handling: per (email, site) — create if none; resend if pending; no-op if already active
- Bootstrap vetted list: env var `ADMIN_BOOTSTRAP_SUPERUSERS` with comma-separated emails (typically 1–2 superusers)
- Admin audit tracking: User detail page shows which admin added/approved each user and when (from audit log)

## UI and Templates

- Use shadcn/ui for admin UI (forms, lists, buttons)
- Start with SES email templates; consider SendGrid later for richer templates/analytics
- Activation page headline should use site-config long name directly (`siteConfig.name`), not site-specific hardcoded
  text

## Entitlements (Interim)

- Extended entitlements initial set: `kriyaban`, `minister` (final list TBD by user)

## Model Comparison Feature

- **Feature**: "Try GPT-4.1" button on every answer for anecdotal user feedback
- **Implementation**: Side-by-side comparison UI (responsive for mobile/desktop)
- **Components**:
  - `ModelComparisonFeedbackModal.tsx` - feedback collection with consent checkbox
  - `AnswerComparison.tsx` - side-by-side comparison display
  - `MessageItem.tsx` - updated with regeneration button and state tracking
- **API**: `/api/model-comparison-vote` - shared endpoint with compare-models page
- **Backend**: `modelOverride` parameter in chat API for testing different models
- **Database**: Firestore collection `${prefix}model_comparison_votes` (shared with compare-models)
- **Distinction**: Inline comparisons have `source: "inline_comparison"` field
- **Privacy**: User consent checkbox controls whether Q&A is stored in database
- **Current model**: Using "gpt-4.1" model for comparison
- **UI Flow**: Button appears below comparison after streaming completes (user-controlled, no auto-popup)

## Answer Regeneration Feature

- **Feature**: Regenerate button for re-generating answers with the same model
- **Location**: Right of the link icon in MessageItem component
- **Icon**: Google Material icon "refresh"
- **Handler**: `handleRegenerateAnswer` in index.tsx
- **Behavior**: Replaces the existing answer in-place with streaming updates
- **State**: Uses existing `loading` state to prevent concurrent regenerations
- **Analytics**: Logs "regenerate_answer_clicked" event with message index

## Data Files and Versioning

### What's New JSON Files

- **Location**: `web/public/data/[site]/whats-new.json`
- **Critical Rule**: Always bump the `version` field when updating entries in whats-new.json files
- **Pattern**: Increment version number (e.g., 3 → 4) whenever adding, removing, or modifying entries
- **Purpose**: Version tracking helps detect when clients need to refresh their cached content

## Never Do Again

1. Cross-evaluate between different embedding model generations
2. Use textual similarity for RAG evaluation (use embedding-based)
3. Add platform-specific packages to root package-lock.json
4. Hardcode model names in evaluation scripts (use parameters)
5. Move modules without updating ALL @patch decorator paths
6. Update whats-new.json files without bumping the version number
