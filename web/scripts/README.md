# Scripts Directory

This directory contains utility scripts for the Ananda Library Chatbot project.

## Available Scripts

### `dev.js`

A wrapper script for starting the Next.js development server with environment configuration.

#### Usage of dev.js

```bash
npm run dev
# OR with a specific environment
node scripts/dev.js ananda
```

#### How dev.js works

1. Loads environment variables from a specified .env file (e.g., `.env.ananda`)
2. Falls back to the default `.env` file if the specified one doesn't exist
3. Starts the Next.js development server with the loaded environment

### `vercel-ignore-build.mjs`

Vercel Ignored Build Step for the four chatbot projects that share `web/vercel.json`.

#### Usage of vercel-ignore-build.mjs

Vercel runs this command from `ignoreCommand` in `web/vercel.json`:

```bash
node ./scripts/vercel-ignore-build.mjs
```

#### How vercel-ignore-build.mjs works

1. Exit `0` skips the build. Exit `1` runs the build.
2. Production (`VERCEL_ENV=production`) always builds.
3. Non-production builds run only for ananda-chatbot.
4. The script treats a project as ananda-chatbot when `SITE_ID` is `ananda` or
   `VERCEL_PROJECT_NAME` is `ananda-chatbot`.

The repo has no earlier custom skip command. This command replaces the default
Vercel file-diff skip.

### `build.js`

A wrapper script for building the Next.js application with environment configuration.

#### Usage of build.js

```bash
npm run build
# OR with a specific environment
node scripts/build.js ananda
```

#### How build.js works

1. Loads environment variables from a specified .env file (e.g., `.env.ananda`)
2. Falls back to the default `.env` file if the specified one doesn't exist
3. Builds the Next.js application with the loaded environment

### `manage-prompts.ts`

A script for managing prompt templates stored in S3.

#### Usage of manage-prompts.ts

```bash
npm run prompt -- [command] [filename]
```

#### Commands for manage-prompts.ts

- `pull`: Download a prompt template from S3
- `push`: Upload a prompt template to S3
- `edit`: Download, edit, and upload a prompt template
- `diff`: Show differences between local and remote prompt templates

#### How manage-prompts.ts works

1. Manages prompt templates stored in S3
2. Provides locking mechanisms to prevent conflicts
3. Supports staging area for local edits
4. Integrates with the user's preferred editor

### `typecheck.cjs`

A script to type-check staged files using a specific tsconfig file.

#### Usage of typecheck.cjs

```bash
node scripts/typecheck.cjs [file1.ts] [file2.tsx] ...
```

#### How typecheck.cjs works

1. Gets files from command line arguments
2. Filters TypeScript files into test and non-test categories
3. Creates a temporary tsconfig for test files
4. Executes the TypeScript compiler with the appropriate configuration
5. Reports errors and cleans up temporary files

### `find-untested-files.js`

This script identifies files in the codebase that have no unit test coverage. It compares all source files against the
Jest coverage report to find files that aren't being tested at all.

#### Usage of find-untested-files.js

Run directly:

```bash
node scripts/find-untested-files.js
```

Or use the npm script:

```bash
npm run find-untested
```

#### How find-untested-files.js works

1. The script reads the Jest coverage report from `coverage/coverage-summary.json`
2. It scans the following directories for source files:
   - app
   - components
   - pages
   - services
   - utils
   - contexts
   - hooks
3. It compares the list of source files with the files in the coverage report
4. It outputs a list of files with no test coverage, grouped by directory

#### Output of find-untested-files.js

The script provides:

- A list of all untested files, organized by directory
- The total number of untested files
- The total number of covered files
- The total number of source files
- The overall coverage percentage (files with at least some coverage)

#### Requirements for find-untested-files.js

- Run Jest with coverage before using this script:

  ```bash
  npm test -- --coverage
  ```

  or

  ```bash
  npm run test:ci
  ```

#### Customization of find-untested-files.js

To modify which directories are scanned or which file types are included, edit the `dirsToCheck` and `extensions` arrays
in the script.
