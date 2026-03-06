# GitHub Actions Workflows

This directory contains automated CI/CD workflows for the Ananda Library Chatbot project.

## Workflows

### `monorepo-ci.yml` - Pull Request Validation

**Triggers:**

- Pull requests to `main` branch
- Changes to Python dependencies, data ingestion, or web components
- Manual trigger via GitHub Actions UI

**What it does:**

- Runs on Python 3.10, 3.11, and 3.12 in parallel
- Executes the complete **Validation Checklist** from `PYTHON_UPGRADE_TODO.md`:
  - Import sweep testing
  - Dependency integrity checks
  - Python dependency security audit with `pip-audit` across all repo requirement files
  - Static analysis with Ruff
  - PDF processing dry-run
  - Node.js linting and type checking
- Uses caching for pip and npm dependencies for faster builds

**Status:** This workflow must pass before PRs can be merged.

### `monorepo-nightly.yml` - Comprehensive Testing

**Triggers:**

- Scheduled daily at 2:00 AM UTC
- Manual trigger via GitHub Actions UI

**What it does:**

- Runs full test suite on Python 3.11
- Comprehensive validation including:
  - All Python tests with pytest
  - Full Node.js test suite
  - Security audits for both Python and Node.js dependencies
  - Complete static analysis and type checking

**Purpose:** Catch issues that might not surface in PR validation, monitor dependency health.

## Required Status Checks

To configure required status checks in GitHub:

1. Go to repository **Settings** → **Branches**
2. Add/edit branch protection rule for `main`
3. Enable "Require status checks to pass before merging"
4. Add required checks:
   - `Python CI (Python 3.10)`
   - `Python CI (Python 3.11)`
   - `Python CI (Python 3.12)`

## Environment Variables

The workflows use minimal environment variables to avoid requiring secrets in CI:

- `SITE=ananda-public` - Default site configuration
- `SKIP_ENV_VALIDATION=true` - Skip validation requiring API keys
- `NODE_ENV=test` - Test environment mode

## Caching Strategy

Both workflows implement caching to reduce build times:

- **pip cache:** `~/.cache/pip` keyed by OS, Python version, and `requirements.txt` hash
- **npm cache:** Built-in npm cache via `actions/setup-node@v4`

## Troubleshooting

### Common Issues

**Import failures in CI:**

- Expected due to missing optional dependencies in CI environment
- Workflows continue with warnings rather than failing

**Build failures due to missing secrets:**

- Node.js build requires API keys not available in CI
- Workflows perform type checking instead of full build

**Dependency conflicts:**

- Detected by `pip check` command
- May indicate need for dependency updates or pinning

### Manual Testing

Test the validation checklist locally:

```bash
# Python validation
python bin/import_sweep.py
python -m pip check
./bin/run-pip-audit.sh
python -m pytest -q tests/
python -m ruff check data_ingestion/ bin/ pyutil/ evaluation/

# Node.js validation
cd web
npm run lint
npx tsc --noEmit
```

## Integration with Dependabot

When Dependabot or similar tools create dependency update PRs, these workflows will automatically:

1. Test the new dependencies across all Python versions
2. Validate compatibility with the existing codebase
3. Ensure no breaking changes are introduced
4. Provide confidence before merging dependency updates

## Monitoring

- **Workflow runs:** GitHub Actions tab shows all runs and their status
- **Notifications:** Failed runs will notify repository maintainers
- **Trends:** Monitor build times and success rates over time

## Testing

This documentation was updated to test the Python CI workflows in our repository.
