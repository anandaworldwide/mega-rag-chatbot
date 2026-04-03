# File structure

## Purpose

This document maps out the directory and file organization of the `mega-rag-chatbot` project. It outlines the folder
hierarchy, naming conventions, and the purpose of key directories and files. This helps in understanding the codebase
structure and navigating it effectively.

This structure organizes the codebase by concern (e.g., API routes, UI components, utilities, tests, configuration) and
by technology stack (e.g., separating Python code).

## Folder Hierarchy

```plaintext
mega-rag-chatbot/
│
├── __tests__/                     # Contains unit and integration tests for the project.
│   ├── api/                      # Tests specifically for API routes (both pages and app router).
│   │   └── chat/v1/              # Tests for the v1 chat API endpoint.
│   │       └── utils/            # Utilities used within chat API tests.
│   ├── services/                 # Tests for external services integrations (e.g., Firebase).
│   └── utils/                    # Tests for utility functions.
│       ├── client/               # Tests for client-side utility functions.
│       ├── mocks/                # Mock data and functions for testing.
│       └── server/               # Tests for server-side utility functions.
│
├── app/                          # Next.js App Router directory.
│   └── api/                      # API routes defined using the App Router.
│       └── chat/v1/              # Version 1 of the chat API endpoint.
│           └── route.ts          # Handler for the /api/chat/v1 route.
│
├── bin/                          # Utility scripts for various development/operational tasks.
│
├── components/                   # Reusable React components used across the application UI.
│
├── config/                       # Configuration files for the application.
│   └── pinecone.ts               # Configuration related to the Pinecone vector database.
│
├── data_ingestion/               # Scripts and modules related to ingesting data from various sources.
│   ├── audio/                   # Scripts for processing and ingesting audio content.
│   ├── db_to_pdf/               # Scripts to convert database content to PDFs.
│   ├── crawler/                 # Web crawler for ingesting website content.
│   │   └── website_crawler.py  # Main script for crawling websites.
│   ├── scripts/                 # Other data ingestion scripts (processing, queue management).
│   ├── sql_to_vector_db/       # Scripts for converting SQL database content to vector embeddings.
│   ├── utils/                   # Python utility modules for data ingestion pipeline.
│   ├── pdf_to_vector_db.py    # Script for ingesting PDFs directly (Python based, replaces TypeScript version).
│   └── tests/                   # Tests for the data ingestion scripts.
│
├── declarations/                 # TypeScript declaration files (.d.ts) for libraries without native types.
│
├── evaluation/                   # RAG system evaluation and performance testing scripts.
│
├── hooks/                        # Custom React hooks for managing state and logic within components.
│
├── instructions/                 # Contains instructions or documentation, like adding comments.
│
├── migrations/                   # Scripts for database schema migrations or data transformations.
│
├── pages/                        # Next.js Pages Router directory.
│   └── api/                      # API routes defined using the Pages Router.
│       ├── audio/                # API routes related to audio processing.
│       ├── *.ts                  # Various API endpoints (e.g., login, vote, contact, answers).
│
├── pyutil/                       # Python utility functions used across Python scripts.
│
├── public/                       # Static assets accessible directly via URL.
│   ├── data/                     # Sample data or query files for different libraries/configurations.
│   │   ├── ananda/
│   │   ├── ananda-public/
│   │   ├── crystal/
│   │   └── jairam/
│
├── scripts/                      # General project scripts (Node.js/TypeScript) for build, dev, data ingestion, etc.
│
├── services/                     # Modules for interacting with external services (e.g., Firebase).
│
├── site-config/                  # Configuration specific to different site deployments or instances.
│   ├── config.json               # Main site configuration file.
│   ├── prompts/                  # Prompt configurations for the AI model for different site versions.
│
├── styles/                       # CSS files, including global styles, module-specific styles, and component styles.
│
├── supercut/                     # Python scripts related to creating "supercuts" from media.
│
├── types/                        # TypeScript type definitions used throughout the project.
│
├── utils/                        # Utility functions shared across the application.
│   ├── client/                   # Utilities specifically for the client-side (browser).
│   └── server/                   # Utilities specifically for the server-side (Node.js environment).
│
└── wordpress/                    # Code related to WordPress integration.
    └── plugins/
        └── ananda-ai-chatbot/    # A WordPress plugin for the Ananda AI Chatbot.
            ├── assets/           # CSS and JS assets for the plugin.
            ├── *.php             # PHP files for the plugin logic.
```

## Key Root Files

- `next.config.js`: Configuration file for the Next.js framework.
- `package.json`: Lists project dependencies and scripts (Node.js).
- `package-lock.json`: Records exact versions of Node.js dependencies.
- `tsconfig.json`: TypeScript compiler configuration.
- `pyproject.toml`: Root Python project metadata and `uv` configuration.
- `uv.lock`: Shared Python lockfile for the UV workspace.
- `requirements.txt`: Exported compatibility requirements file derived from `uv.lock`.
- `README.md`: Main project documentation file.
- `middleware.ts`: Next.js middleware configuration for intercepting requests.
- `vercel.json`: Configuration for deploying the project on Vercel.
- `firebase.json`: Configuration for Firebase services.
- `jest.setup.ts`, `jest.setup-server.ts`: Setup files for the Jest testing framework.
- `SECURITY-TODO.md`, `TESTS-TODO.md`, `TESTS-README.md`, `TOKEN-SECURITY-README.md`: Documentation regarding security,
  testing, and tokens.

## Naming Conventions

- **Folders:** Generally use `kebab-case` (e.g., `site-config`) or `camelCase` (e.g., `__tests__`, `data_ingestion` in
  Python). Standard names like `components`, `utils`, `pages`, `app`, `public`, `styles` are used.
- **Files:**
  - TypeScript/JavaScript: `camelCase` (e.g., `pineconeClient.ts`) or `kebab-case` (e.g., `get-token.ts`) seem to be
    used. React components use `PascalCase` (e.g., `CollectionSelector.jsx`). Test files often use `.test.ts` suffix.
  - Python: `snake_case` (e.g., `crawl_authors.py`, `pinecone_utils.py`).
  - CSS: `kebab-case` (e.g., `loading-dots.module.css`) or `PascalCase` for CSS Modules tied to components (e.g.,
    `MarkdownStyles.module.css`).
- **Configuration Files:** Standard names are used (e.g., `package.json`, `tsconfig.json`, `next.config.js`).
