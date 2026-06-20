# @site-config

This directory contains configuration files for different sites and their associated chatbots. Each site has its own set
of configurations and prompts.

## Structure

- `config.json`: Main configuration file for all sites
- `prompts/`: Directory containing prompt templates and configurations for each site

## config.json

This file contains site-specific configurations for different chatbots. Each site has its own object with various
settings.

### Configuration Options

- `name`: The name of the chatbot
- `shortname`: A short name for the chatbot
- `tagline`: A brief description or slogan for the chatbot
- `greeting`: The initial greeting message from the chatbot
- `welcome_popup_heading`: Heading for the welcome popup
- `other_visitors_reference`: How to refer to other visitors
- `parent_site_url`: URL of the parent website
- `parent_site_name`: Name of the parent website
- `help_url`: URL for help documentation
- `help_text`: Text to display for the help link
- `collectionConfig`: Configuration for different document collections
- `libraryMappings`: Mappings for different library sources
- `enableSuggestedQueries`: Boolean to enable/disable suggested queries
- `enableMediaTypeSelection`: Boolean to enable/disable media type selection
- `enableAuthorSelection`: Boolean to enable/disable author selection
- `enableAutoAuthorScope`: Boolean (Luca only) to enable automatic per-query author scope with Master/Swami-weighted
  blended retrieval. When enabled, add an `auto` entry to `collectionConfig` and default the UI to that option.
- `authorScopeBlend`: Optional weights for auto mode (`masterSwamiWeight`, `broadMasterSwamiWeight`) controlling the
  quota split between Master/Swami-filtered retrieval and whole-library retrieval.
- `authorAliases`: Optional map of lowercase aliases (author first names or nicknames) to canonical Pinecone
  author display names for deterministic named-author detection. Do not map shared surnames (e.g. `nayaswami`) or generic
  entitlement terms (e.g. `lightbearer`) to a single author.

### Auto author scope behavior (Luca)

When `enableAutoAuthorScope` is enabled:

- The **web UI** defaults to `collection: "auto"` and sends that value to `/api/chat/v1`.
- **API clients** (WordPress plugin, direct API calls) that omit `collection` fall back to `"whole_library"` in
  [`web/src/app/api/chat/v1/route.ts`](../src/app/api/chat/v1/route.ts). They do **not** receive auto blend unless they
  explicitly send `"auto"`. This preserves backward compatibility for integrations that never sent a collection field.
- **First message in a conversation** skips the rephrase/author-scope LLM call (no chat history yet). Scope uses
  deterministic alias matching plus the default blend weights. Follow-up messages piggyback author-scope classification
  on the rephrase call.
- **Book-title / full author-list matching** is deferred: deterministic scope currently uses `authorAliases` only.
  Wiring `knownAuthors` from Firestore stats or title-catalog metadata is a follow-up if alias coverage is insufficient.
- `accessControl`: Optional site-specific access hierarchy. When enabled, `levels` defines numeric access values,
  `defaultLevel` defines public/default access, `superuserLevel` defines the highest local role level, and
  `salesforceOnlyLevels` can reserve levels for Salesforce-derived access.
- `loginImage`: Image to display on the login screen

## Prompts

Each site has its own prompt configuration in the `prompts/` directory:

- `ananda.json`: Configuration for Luca, the Ananda chatbot
- `ananda-public.json`: Configuration for Vivek, the Ananda.org chatbot
- `jairam.json`: Configuration for Free Joe Hunt chatbot
- `crystal.json`: Configuration for Crystal Clarity chatbot

### Prompt Structure

Each prompt configuration consists of:

1. `variables`: Site-specific variables used in the prompts
2. `templates`: Templates for different parts of the prompt, including the base template

The base template for each site is stored in a separate text file (e.g., `ananda-base.txt`, `jairam-base.txt`,
`crystal-prompt.txt`).

## Usage

To add a new site or modify an existing one:

1. Add or modify the site configuration in `config.json`
2. Create or update the corresponding prompt configuration in `prompts/`
3. If needed, create a new base template file for the site's prompts

Ensure that all necessary fields are filled out in both the `config.json` and the prompt configuration files.
