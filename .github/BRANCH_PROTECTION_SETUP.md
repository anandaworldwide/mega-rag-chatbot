# Branch Protection Setup Guide

This guide explains how to configure required status checks to ensure the Python CI workflows must pass before merging
PRs.

## Required Status Checks Configuration

### Step 1: Access Repository Settings

1. Go to your repository: <https://github.com/anandaworldwide/mega-rag-chatbot>
2. Click the **Settings** tab
3. Click **Branches** in the left sidebar

### Step 2: Create/Edit Branch Protection Rule

1. Click **Add rule** (or edit existing rule for `main`)
2. Set **Branch name pattern**: `main`

### Step 3: Configure Protection Settings

Enable these options:

- ✅ **Require status checks to pass before merging**
- ✅ **Require branches to be up to date before merging**
- ✅ **Restrict pushes that create files** (optional, recommended)

### Step 4: Add Required Status Checks

In the "Status checks found in the last week for this repository" section, search for and add:

```text
Monorepo CI (Python 3.11)
```

**Note**: These checks will only appear after the workflows have run at least once. If you don't see them:

1. Create a test PR to trigger the workflows
2. Wait for them to complete
3. Return to this settings page - the checks should now be available

### Step 5: Additional Recommended Settings

- ✅ **Require a pull request before merging**
- ✅ **Require approvals**: 1 (adjust based on team size)
- ✅ **Dismiss stale PR approvals when new commits are pushed**
- ✅ **Require review from code owners** (if you have a CODEOWNERS file)

### Step 6: Save Configuration

Click **Create** or **Save changes**

## Verification

After setup, when someone creates a PR:

1. The Python CI workflows will automatically run
2. The standardized Python 3.11 workflow must pass
3. The PR cannot be merged until all checks are green
4. If any workflow fails, the merge button will be disabled

## Dependabot Integration

With the included `.github/dependabot.yml` configuration:

- Dependabot will create weekly PRs for dependency updates
- These PRs will automatically trigger the Python CI workflows
- Only PRs that pass all validation checks can be merged
- This ensures dependency updates don't break the codebase

## Troubleshooting

### Status Checks Not Appearing

If the required status checks don't appear in the dropdown:

1. Ensure the workflows have run at least once

1. Check the workflow names match exactly:

- `Monorepo CI (Python 3.11)`

1. Wait a few minutes after workflow completion

### Workflows Not Triggering

If workflows don't trigger on PRs:

1. Check the `paths` configuration in `.github/workflows/monorepo-ci.yml`
2. Ensure the PR changes files that match the trigger paths
3. Verify the workflow is enabled in the Actions tab

### Failed Status Checks

If status checks fail:

1. Click on the failed check to view detailed logs
2. Common issues and solutions are documented in `.github/workflows/README.md`
3. Fix the issue and push new commits - checks will re-run automatically
