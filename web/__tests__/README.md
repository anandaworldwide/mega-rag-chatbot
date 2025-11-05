# Testing System

This directory contains tests for the Ananda Library chatbot. Our testing approach ensures high-quality code through
standardized test patterns and automated test execution.

## Test Templates

Templates for creating new tests are available in the `.templates` directory:

- `component.test.tsx`: For React component tests
- `utility.test.ts`: For utility function tests
- `api-route.test.ts`: For API endpoint tests

See the [templates documentation](./.templates/README.md) for detailed usage instructions.

## Coverage Requirements

We have established minimum coverage thresholds in Jest configuration:

```js
// From jest.config.cjs
coverageThreshold: {
  global: {
    statements: 65,
    branches: 60,
    functions: 60,
    lines: 65,
  },
  './components/': {
    statements: 70,
    branches: 60,
    functions: 55,
    lines: 70,
  },
  './utils/': {
    statements: 70,
    branches: 70,
    functions: 65,
    lines: 70,
  },
  './app/api/': {
    statements: 70,
    branches: 60,
    functions: 60,
    lines: 70,
  },
}
```

These thresholds are enforced during CI builds but not during pre-commit hooks to keep the commits fast.

## Pre-commit Hooks

We use Husky and lint-staged to run tests on changed files before each commit. This helps catch bugs early and prevents
regressions.

### How it works

1. When you attempt to commit changes, Git triggers the pre-commit hook
2. The hook runs the TypeScript type checker on all TypeScript files
3. The hook then runs Jest tests only on the files you modified (without coverage checks)
4. If all tests pass, your commit proceeds
5. If any test fails, the commit is aborted until you fix the failing tests

### Setup

The hooks are set up automatically when you run `npm install` thanks to the `prepare` script in package.json. If you
need to manually set up the hooks, run:

```bash
npm run setup-hooks
```

### How to bypass hooks (in emergency)

Sometimes you might need to bypass the hooks (e.g., when committing a work-in-progress that doesn't pass tests yet):

```bash
git commit -m "WIP commit" --no-verify
```

**Note**: Use this sparingly! It's usually better to fix failing tests.

### Commands

- `npm test` - Run all tests
- `npm run test:changed -- file1.ts file2.ts` - Run tests for specific files
- `npm run test:watch` - Run tests in watch mode during development
- `npm run test:ci` - Run tests with coverage reporting

#### Specialized Semantic Tests

These tests validate LLM responses using embedding similarity (skipped by default):

**Ananda Public Site:**

- `npm run test:queries:ananda-public` - Run all Ananda Public semantic and location tests (60 tests total)
- `npm run test:location:ananda-public` - Run only location/geo-awareness tests (20 tests)

**Ananda Site:**

- `npm run test:queries:ananda` - Run all Ananda semantic tests (17 tests total)

**Requirements:**

- Valid `OPENAI_API_KEY` environment variable (for embeddings)
- Valid `SECURE_TOKEN` environment variable (for JWT generation)
- Running backend server (default: `http://localhost:3000`)
- Site-specific environment variables (e.g., `.env.ananda` or `.env.ananda-public`)

**Test Files:**

- `__tests__/site_specific/ananda-public/semanticSearch.test.ts` - 40 semantic response tests
- `__tests__/site_specific/ananda-public/locationSemantic.test.ts` - 20 location/geo-awareness tests
- `__tests__/site_specific/ananda/semanticSearch.test.ts` - 17 semantic response tests (identity, naming conventions,
  content references, unrelated question rejection)

## Test Organization

Tests are organized following the structure of the codebase:

- `__tests__/components/` - Tests for React components
- `__tests__/utils/` - Tests for utility functions
- `__tests__/api/` - Tests for API endpoints
- `__tests__/services/` - Tests for external services integration

## Best Practices

1. Write tests **before** or alongside your implementation code
2. Use the provided templates to ensure consistent test coverage
3. Ensure tests are independent and don't rely on external state
4. Mock external dependencies appropriately
5. Focus on testing behavior rather than implementation details
6. Add tests for bug fixes to prevent regressions
7. Run the full test suite periodically, not just the changed files
