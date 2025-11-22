# Backend Structure

**Purpose:** This document describes the architecture and organization of the backend for the Ananda Library Chatbot
application. It details API endpoints, data storage, authentication mechanisms, and key server-side processes to
facilitate understanding and future development.

---

## 1. Architecture Overview

### System Architecture

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                                 FRONTEND                                      │
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐ │
│ │   Next.js App   │    │ WordPress Plugin│    │     Admin Interface         │ │
│ │                 │    │                 │    │                             │ │
│ │ • Chat UI       │    │ • Chatbot Widget│    │ • Model Stats               │ │
│ │ • Authentication│    │ • JWT Auth      │    │ • Downvotes Review          │ │
│ │ • Answer Pages  │    │ • Site Embed    │    │ • Related Questions Mgmt    │ │
│ └─────────────────┘    └─────────────────┘    └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
                          ┌─────────────────────────┐
                          │      API GATEWAY        │
                          │                         │
                          │ • JWT Authentication    │
                          │ • Rate Limiting (Redis) │
                          │ • CORS & Security       │
                          └─────────────────────────┘
                                       │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND SERVICES                                   │
│                                                                                 │
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐   │
│ │   Chat Engine   │    │  Data Ingestion │    │    Analytics & Logging      │   │
│ │                 │    │                 │    │                             │   │
│ │ • LangChain RAG │    │ • PDF Processing│    │ • Chat Logs (Firestore)     │   │
│ │ • OpenAI LLM    │    │ • Web Crawler   │    │ • User Feedback             │   │
│ │ • Streaming     │    │ • Audio/Video   │    │ • Usage Analytics           │   │
│ │ • Geo-Awareness │    │ • Database Sync │    │ • Error Monitoring          │   │
│ └─────────────────┘    └─────────────────┘    └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
┌────────────────────────────────────────────────────────────────────────────────┐
│                             DATA LAYER                                         │
│                                                                                │
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐  │
│ │ Pinecone Vector │    │   Firestore     │    │        Redis Cache          │  │
│ │   Database      │    │   NoSQL DB      │    │                             │  │
│ │                 │    │                 │    │ • Rate Limiting             │  │
│ │ • Embeddings    │    │ • Chat History  │    │ • Session Storage           │  │
│ │ • Semantic      │    │ • User Data     │    │ • Temporary Data            │  │
│ │   Search        │    │ • Feedback      │    │                             │  │
│ │ • Multi-tenant  │    │ • Analytics     │    │                             │  │
│ └─────────────────┘    └─────────────────┘    └─────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

- **Framework:** The backend is built primarily using **Next.js**, leveraging both the `pages/api` directory for
  traditional serverless functions and the `app/api` directory (App Router) for edge-compatible routes.
- **Language:** **TypeScript** is the primary language for the Next.js backend logic. **Python** is used for data
  ingestion and processing scripts, including website crawling (`data_ingestion/crawler/website_crawler.py`), PDF
  parsing, audio transcription, and SQL data conversion.
- **Hosting:** Likely deployed on **Vercel** (implied by Next.js usage and edge functions) and potentially uses **AWS
  S3** for media storage and **Firebase** services (Firestore).
- **Key Technologies:**
  - **Node.js:** Runtime for the Next.js application.
  - **LangChain:** Framework used for building the core chat logic, orchestrating retrieval, context management, and LLM
    interaction (`makechain.ts`).
  - **OpenAI:** Used for Large Language Model (LLM) inference and text embeddings (via LangChain).
  - **Pinecone:** Vector database used for storing and retrieving document embeddings for the Retrieval-Augmented
    Generation (RAG) process (`pinecone-client.ts`, `config/pinecone.ts`).
  - **Firestore:** NoSQL database used for storing chat logs, user data, votes, cached related questions, and
    potentially ingestion queue state (`firestoreUtils.ts`, `services/firebase.ts`).
  - **Redis:** In-memory data store used primarily for API rate limiting (`redisUtils.ts`, `genericRateLimiter.ts`).
  - **AWS S3:** Object storage used for hosting source audio files and prompt templates with environment separation
    (`awsConfig.ts`, `data_ingestion/utils/s3_utils.py`).
  - **AssemblyAI / Whisper:** Likely used for audio transcription within the Python ingestion scripts.

### Prompt Template Storage

The system supports two storage methods for prompt templates:

**1. Source Tree Storage** (files in codebase):

- **Path**: `web/site-config/prompts/template.txt`
- **Configuration**: `"file": "template-name.txt"` (no `s3:` prefix)
- **Use Case**: Public prompts that don't require privacy protection

**2. S3 Storage** (environment-separated):

- **Development Environment**: `s3://bucket/site-config/dev/prompts/`
- **Production Environment**: `s3://bucket/site-config/prod/prompts/`
- **Legacy Path**: `s3://bucket/site-config/prompts/` (maintained for backward compatibility)
- **Configuration**: `"file": "s3:template-name.txt"` (with `s3:` prefix)
- **Use Case**: Private/sensitive prompts requiring environment separation

**Environment Detection Logic** (for S3-stored prompts only):

1. Checks `NODE_ENV` environment variable
2. Falls back to `VERCEL_ENV` for preview deployments (uses prod path)
3. Defaults to 'dev' for safety

**Prompt Management** (`web/scripts/manage-prompts.ts`):

- Provides secure pull/push/edit/promote workflow for S3-stored prompts
- Implements file locking to prevent conflicts
- Automatic testing and rollback on failures
- Interactive confirmation for production changes
- **Note**: Source tree prompts are managed directly via filesystem edits

---

## 2. API Endpoints

API endpoints are defined in `pages/api/` and `app/api/`. Most endpoints are protected and require authentication.

**Core Chat:**

- **`POST /api/chat/v1`** (`app/api/chat/v1/route.ts`)
  - **Purpose:** Main endpoint for handling user chat queries. Implements the RAG pipeline.
  - **Auth:** Requires JWT authentication (validated via `appRouterJwtUtils.ts`).
  - **Logic:** Takes user question, history, and selected namespace. Retrieves relevant context from Pinecone, interacts
    with LLM via LangChain, streams the response, logs interaction to Firestore.
  - **Response:** Streams `StreamingResponseData` containing text chunks, source documents, and related questions.

**Authentication & Authorization:**

- **`POST /api/login`** (`pages/api/login.ts`)
  - **Purpose:** Authenticates users based on username/password.
  - **Auth:** Open.
  - **Logic:** Compares provided password with stored hash (`passwordUtils.ts`), generates a JWT (`jwtUtils.ts`), and
    sets it as an HttpOnly cookie.

**Authorization Utilities:**

- **Answers Page Authorization (`answersPageAuth.ts`):**
  - Implements admin-only access control for the answers page.
  - **Login-required sites:** Only superusers can access.
  - **No-login sites:** Anyone can access (not advertised).
  - **Discrete link visibility:** Only shown to highest privilege users (superusers on login sites, sudo users on
    no-login sites).
  - Functions: `isAnswersPageAllowed()`, `shouldShowAnswersPageLink()`, `getAnswersPageErrorMessage()`.
- **`POST /api/logout`** (`pages/api/logout.ts`)
  - **Purpose:** Logs out the user.
  - **Auth:** Requires valid JWT.
  - **Logic:** Clears the authentication cookie.
- **`GET /api/web-token`** (`pages/api/web-token.ts`)
  - **Purpose:** Generates a short-lived token, likely for embedding the chatbot in external sites.
  - **Auth:** Requires API key/secret validation.
- **`POST /api/get-token`** (`pages/api/get-token.ts`)
  - **Purpose:** Part of a secure token exchange flow, potentially for WordPress integration.
  - **Auth:** Requires specific token validation.
- **`POST /api/sudoCookie`** (`pages/api/sudoCookie.ts`)
  - **Purpose:** Sets or clears an admin "sudo mode" cookie, bypassing certain restrictions.
  - **Auth:** Requires admin-level privileges (checks JWT for admin role).

**Data Interaction & Features:**

- **`POST /api/vote`** (`pages/api/vote.ts`)
  - **Purpose:** Records user upvotes or downvotes on chat answers.
  - **Auth:** Requires JWT authentication (`authMiddleware.ts`).
  - **Logic:** Updates vote counts in Firestore (`firestoreUtils.ts`).
- **`GET /api/answers`** (`pages/api/answers.ts`)
  - **Purpose:** Retrieves specific answers or question details for admin users.
  - **Auth:** Requires admin-level authorization (superuser for login-required sites, sudo for no-login sites).
  - **Logic:** Fetches data from Firestore (`answersUtils.ts`), validates access via `answersPageAuth.ts`.

**Answers Page Authorization:**

- **`GET /api/answers/link-visibility`** (`pages/api/answers/link-visibility.ts`)
  - **Purpose:** Determines if the discrete answers page link should be shown to the current user.
  - **Auth:** Uses `answersPageAuth.ts` to check user privileges.
  - **Logic:** Returns visibility status based on user role and site configuration.

**Conversation History & Management:**

- **`GET /api/chats`** (`pages/api/chats.ts`)
  - **Purpose:** Retrieves user's conversation history with AI-generated titles.
  - **Auth:** Requires JWT authentication.
  - **Logic:** Fetches conversations grouped by `convId` from Firestore, returns last 20 conversations with lazy-loading
    support.
  - **Response:** Array of conversations with `convId`, `title`, `lastMessage`, `timestamp`, and `messageCount`.
- **`GET /api/conversation/[convId]`** (`pages/api/conversation/[convId].ts`)
  - **Purpose:** Retrieves full conversation history for a specific conversation ID.
  - **Auth:** Requires JWT authentication (owner verification).
  - **Logic:** Fetches all messages in a conversation grouped by `convId`, supports timestamp filtering for sharing.
  - **Response:** Complete conversation thread with all messages and metadata.
- **`GET /api/document/[docId]`** (`pages/api/document/[docId].ts`)

  - **Purpose:** Retrieves single document for ownership verification and conversation lookup.
  - **Auth:** Optional JWT authentication (supports anonymous sharing).
  - **Logic:** Fetches document metadata including `convId` and ownership information.
  - **Response:** Document metadata with `convId`, `uuid`, and basic conversation info.

**Star Functionality:**

- **`POST /api/conversations/star`** (`pages/api/conversations/star.ts`)
  - **Purpose:** Stars or unstars entire conversations for quick access.
  - **Auth:** Requires JWT authentication (owner verification).
  - **Logic:** Batch updates all documents in a conversation with `isStarred` field, validates conversation ownership.
  - **Request:** `{ convId: string, action: "star" | "unstar" }`
  - **Response:** Success confirmation with documents updated count.
- **`GET /api/conversations/starred`** (`pages/api/conversations/starred.ts`)

  - **Purpose:** Retrieves user's starred conversations with pagination.
  - **Auth:** Requires JWT authentication.
  - **Logic:** Queries Firestore for conversations with `isStarred: true`, groups by `convId`, supports cursor-based
    pagination.
  - **Query Params:** `limit` (max 100), `cursor` (timestamp for pagination)
  - **Response:** Array of starred conversations with pagination metadata (`hasMore`, `nextCursor`).

- **`POST /api/contact`** (`pages/api/contact.ts`)
  - **Purpose:** Handles contact form submissions.
  - **Auth:** Likely open or uses basic CSRF protection.
  - **Logic:** Sends email or stores contact message.

**User Profile Management:**

- **`GET /api/profile`** (`pages/api/profile.ts`)
  - **Purpose:** Retrieves current user's profile information.
  - **Auth:** Requires JWT authentication.
  - **Logic:** Returns user's email, UUID, role, first name, last name, and email change status.
  - **Response:** User profile data including pending email changes.
- **`PATCH /api/profile`** (`pages/api/profile.ts`)
  - **Purpose:** Updates user profile information and handles activation completion.
  - **Auth:** Requires JWT authentication.
  - **Logic:** Updates first name, last name, or cancels email changes. When a user with `activated_pending_profile`
    status completes their profile, automatically transitions them to `accepted` status, logs activation completion, and
    sends welcome email.
  - **Welcome Email:** Automatically sent when user completes activation (transitions from `activated_pending_profile`
    to `accepted`). Email includes site-specific branding and a button to access the chatbot homepage.
  - **Request:** `{ firstName?: string, lastName?: string, cancelEmailChange?: boolean }`
  - **Response:** Success confirmation.
- **`POST /api/submitNpsSurvey`** (`pages/api/submitNpsSurvey.ts`)
  - **Purpose:** Stores Net Promoter Score survey results.
  - **Auth:** Requires JWT authentication.
  - **Logic:** Writes survey data to Firestore.

**Admin Approver Selection System:**

- **`GET /api/admin/approvers`** (`pages/api/admin/approvers.ts`)
  - **Purpose:** Retrieves admin approver lists from S3 for self-provisioning flow.
  - **Auth:** Open (skipAuth: true) for self-provisioning access.
  - **Logic:** Loads site configuration, fetches approver data from S3 using site-specific keys
    (`{envPrefix}{siteId}-admin-approvers.json`), caches results for 5 minutes.
  - **Response:** JSON structure with lastUpdated timestamp and regional admin groupings.
- **`POST /api/admin/requestApproval`** (`pages/api/admin/requestApproval.ts`)
  - **Purpose:** Processes self-provisioning approval requests and sends notification emails.
  - **Auth:** Open for self-provisioning access.
  - **Logic:** Stores pending request in Firestore collection, sends approval request email to selected admin with
    review link, sends confirmation email to requester.
  - **Request:** `{ email: string, name: string, selectedAdmin: { name, email, location } }`
  - **Response:** Success confirmation with request ID.
- **`GET /api/admin/pendingRequests`** (`pages/api/admin/pendingRequests.ts`)
  - **Purpose:** Retrieves pending approval requests for authenticated admin review.
  - **Auth:** Requires JWT authentication and admin privileges.
  - **Logic:** Queries Firestore for pending requests assigned to current admin, supports approve/deny actions with
    optional messages, updates request status and sends notification emails.
  - **Response:** Array of pending requests with requester details and action capabilities.

**Admin & Maintenance:**

- **`GET /api/firestoreCron`** (`pages/api/firestoreCron.ts`)
  - **Purpose:** Scheduled task endpoint for Firestore maintenance (e.g., data cleanup, aggregation).
  - **Auth:** Requires Cron Secret (`cronAuthUtils.ts`).
- **`POST /api/pruneRateLimits`** (`pages/api/pruneRateLimits.ts`)
  - **Purpose:** Scheduled task endpoint to clean up expired rate limit entries in Redis.
  - **Auth:** Requires Cron Secret.
- **`POST /api/admin/digestSelfProvision`** (`pages/api/admin/digestSelfProvision.ts`)
  - **Purpose:** Daily digest of user activation attempts and completions.
  - **Auth:** Requires Cron Secret or JWT authentication.
  - **Schedule:** Daily at 1:00 PM UTC (configured in `vercel.json`).
- **`POST /api/admin/cleanupExpiredInvitations`** (`pages/api/admin/cleanupExpiredInvitations.ts`)
  - **Purpose:** Daily cleanup of expired pending account invitations (older than 14 days).
  - **Auth:** Requires Cron Secret or JWT authentication.
  - **Schedule:** Daily at 2:00 AM UTC (configured in `vercel.json`).
  - **Logic:** Queries Firestore for pending invitations with `inviteExpiresAt <= now`, deletes expired documents,
    writes audit logs, and sends ops alerts with cleanup summary.
- **`GET /api/stats`**, **`GET /api/downvotedAnswers`**, **`POST /api/adminAction`**
  - **Purpose:** Various endpoints for administrative tasks like viewing statistics, managing content.
  - **Auth:** Requires admin-level privileges (JWT validation).
- **`POST /api/cron/download-locations`** (`pages/api/cron/download-locations.ts`)
  - **Purpose:** Daily download and update of location data CSV from external source to S3.
  - **Auth:** Requires Cron Secret or JWT authentication (hybrid auth).
  - **Schedule:** Daily at 3:00 AM UTC (configured in `vercel.json`).
  - **Logic:** Downloads CSV from `LOCATION_DATA_DOWNLOAD_URL` if defined, compares to existing S3 file (`site-config/location/${siteId}-locations.csv`), uploads if different. Sends ops alerts on updates or failures.

**Middleware:**

- **Next.js Middleware (`middleware.ts`):** Intercepts requests globally or for specific paths. Handles JWT verification
  for protected pages/routes and potentially redirects.
- **API Middleware:** Wrappers applied to API handlers to enforce authentication (JWT validation), CORS policies, rate
  limiting, and error handling.

---

## 3. Database Schema

Data is stored across multiple services:

- **Firestore:**

  - **`chatLogs` (Collection):** Stores records of each chat interaction.
    - `question`: User's query.
    - `answer`: LLM's generated response.
    - `sources`: Array of source document metadata used for the answer.
    - `timestamp`: Time of the interaction.
    - `userId`: Identifier for the user (if logged in).
    - `sessionId`: Identifier for the chat session.
    - `vote`: Number indicating vote status (e.g., 1 for up, -1 for down, 0 for none).
    - `messageId`: Unique ID for the message pair.
    - `namespace`: The Pinecone namespace used.
    - **`convId`**: UUID v4 string that groups messages into conversations. New conversations generate new IDs;
      follow-ups reuse existing IDs.
    - **`title`**: AI-generated conversation title (~4-5 words) stored only on the first message of each conversation.
      Follow-up messages reference the initial title.
    - **`uuid`**: User identifier for cross-device conversation sync and ownership verification.
    - **`isStarred`**: Boolean indicating if the conversation is starred by the user. Applied to all documents in a
      conversation for consistent querying and filtering.
    - (Other potential fields: feedback, model used, etc.)
  - **`answers` (Collection):** Possibly stores standalone answers or references chat logs for voting/retrieval. Schema
    likely overlaps significantly with `chatLogs`.
  - **`votes` (Collection):** Tracks individual votes.
    - `userId`: Voting user.
    - `questionId`/`messageId`: Identifier for the voted item.
    - `voteType`: 'up' or 'down'.
  - **`users` (Collection - Inferred):** Stores user login credentials.
    - `username`: User identifier.
    - `passwordHash`: Hashed password (`bcrypt` used in `passwordUtils.ts`).
    - `roles`: (Potentially) User roles (e.g., 'admin').
  - **`npsSurveys` (Collection):** Stores NPS survey responses.

  - **`modelComparisons`, `modelComparisonVotes` (Collections):** Data related to A/B testing or comparing different LLM
    responses.
  - **`ingestQueue` (Collection - Inferred):** Used by Python scripts to manage the data ingestion pipeline for sources
    like websites, PDFs, audio, video, and SQL databases.

- **Pinecone:**

  - **Index(es):** Contains vector embeddings of source documents. Organized by `namespace` (e.g., 'ananda', 'jairam',
    'crystal').
  - **Vectors:** High-dimensional representations of text chunks.
  - **Metadata (`DocMetadata.ts`):** Stored alongside vectors.
    - `source`: Original filename or URL.
    - `pageNumber`: Page number for PDFs.
    - `loc`: Location information (e.g., line numbers).
    - `txtPath`: Path to the text file.
    - `text`: The actual text chunk embedded.
    - `type`: Source type ('pdf', 'audio', 'youtube', 'txt').
    - `title`: Document title.
    - `author`: Document author.
    - `url`: URL source (e.g., from web crawling).
    - `publishedDate`: Publication date.
    - `s3Key`: Path to the audio file in S3 (for audio sources).
    - `startSecond`, `endSecond`: Timestamps for audio/video chunks.
    - `access_level`: Access control classification (default: "public", or e.g. restricted: "kriyaban").

- **Redis:**

  - Stores key-value pairs for rate limiting, typically mapping an IP address or user ID to a request count within a
    time window. Keys might look like `rateLimit:<ip_address>`.

- **AWS S3:**
  - Stores raw media files (primarily audio `.mp3`, `.wav`) processed during data ingestion. File paths are stored in
    Pinecone metadata (`s3Key`).

### Access Control Metadata

The system implements **access level-based content filtering** to exclude restricted content (e.g., Kriyaban-only
material) from search results based on site configuration.

**Metadata Field:**

- **`access_level`**: String field in Pinecone vector metadata
  - **Default value**: `"public"` (implicit for most content)
  - **Restricted values**: `"kriyaban"` for Kriyaban-only content
  - **Extensible**: Additional levels (e.g., `"admin"`, `"staff"`) can be added without code changes

**Site Configuration (`web/site-config/config.json`):**

```json
{
  "ananda": {
    "excludedAccessLevels": ["kriyaban"],
    "accessLevelPathMap": {
      "kriyaban": ["Kriyaban Only"]
    }
  }
}
```

**Data-Driven Access Control:**

- **`excludedAccessLevels`**: Array of access levels to exclude from search results
- **`accessLevelPathMap`**: Maps access levels to file path patterns for automatic classification during ingestion
- **Path Matching**: Case-insensitive substring matching against file paths
- **Multi-Site Support**: Each site can define its own access restrictions independently

**Implementation Components:**

1. **Ingestion Pipeline (`data_ingestion/`):**

   - **Path Analysis**: `pyutil/site_config_utils.py` provides `determine_access_level()` function
   - **Automatic Classification**: Files containing "Kriyaban Only" in path → `access_level="kriyaban"`
   - **Default Behavior**: All other content → `access_level="public"` (implicit)
   - **Integration**: `transcribe_and_ingest_media.py` applies access levels during vector upsert

2. **Query Filtering (`web/src/app/api/chat/v1/route.ts`):**

   - **Filter Generation**: `setupPineconeAndFilter()` creates Pinecone filters
   - **Exclusion Logic**: `{ access_level: { $nin: excludedAccessLevels } }`
   - **Combined Filters**: Access level restrictions combined with media type and collection filters
   - **Site-Specific**: Only applies to sites with configured `excludedAccessLevels`

3. **Migration Support (`bin/tag_kriyaban_vectors.py`):**
   - **Bulk Tagging**: Script to retroactively tag existing vectors
   - **Path-Based Identification**: Matches file paths containing "Kriyaban Only"
   - **Batch Processing**: Handles large vector sets with progress tracking
   - **Verification**: Confirms successful tagging with detailed logging

**Filter Structure Example:**

```typescript
// Generated Pinecone filter for ananda site
{
  $and: [
    { type: { $in: ["audio", "text"] } }, // Media type filter
    { library: { $eq: "Treasures" } }, // Collection filter
    { access_level: { $nin: ["kriyaban"] } }, // Access level exclusion
  ];
}
```

**Security Considerations:**

- **Server-Side Enforcement**: Access control applied at the vector database query level
- **No Client-Side Filtering**: Restricted content never reaches the client
- **Metadata Integrity**: Access levels set during ingestion and immutable during queries
- **Site Isolation**: Each site's access restrictions are independent and configurable

**Testing Coverage:**

- **Unit Tests**: `web/__tests__/api/chat/v1/accessLevelFiltering.test.ts`
- **Integration Tests**: `web/__tests__/api/chat/v1/kriyabanIntegration.test.ts`
- **Configuration Tests**: `__tests__/utils/server/siteConfigUtils.test.ts`

---

## 4. URL Navigation & Conversation Sharing

The system implements a sophisticated URL navigation pattern that separates conversation ownership from sharing
capabilities:

### URL Patterns

**Owner URLs (Full Conversation Access):**

- **`/chat/[convId]`** - Shows complete ongoing conversation for the owner
- **Behavior**: URL remains stable across follow-up messages within the same conversation
- **Access**: Requires authentication and UUID ownership verification
- **Features**: Full conversation history, ability to continue conversation, edit/delete capabilities

**Share URLs (Point-in-Time Sharing):**

- **`/share/[docId]`** - Shows conversation up to a specific message point
- **Behavior**: View-only access showing conversation history up to the shared message timestamp
- **Access**: No authentication required, works for anonymous users
- **Features**: Read-only conversation view, no continuation capability, social sharing optimized

**Legacy Redirects:**

- **`/answers/[answerId]`** - Automatically redirects to `/share/[answerId]` for backward compatibility

### Navigation Flow

1. **New Conversation**: User starts at `/` (home page)
2. **First Answer**: URL changes to `/chat/[convId]` via `window.history.pushState`
3. **Follow-up Messages**: URL remains stable at `/chat/[convId]`
4. **Sharing**: User can generate `/share/[docId]` links for any specific message point
5. **Cross-Device**: Conversation URLs work across devices for authenticated users

### Security & Access Control

**Owner Verification:**

- Server validates JWT token and UUID ownership before serving full conversations
- Non-owners are redirected to share view or denied access based on sharing settings

**Anonymous Sharing:**

- Share URLs work without authentication
- Server-side filtering ensures only content up to shared timestamp is visible
- No URL parameters to prevent tampering with conversation scope

**Privacy Controls:**

- Users can choose conversation privacy levels: public, private (saved), or temporary (not saved)
- Share links respect privacy settings and user permissions

---

## 5. Authentication Flows

- **Standard User Login:**
  1. User submits username/password to `POST /api/login`.
  2. Server validates credentials against Firestore (`users` collection).
  3. If valid, server generates a JWT containing user ID and potentially roles (`jwtUtils.ts`).
  4. JWT is set as an HttpOnly, Secure cookie in the response.
  5. Subsequent requests include this cookie.
- **API Request Verification:**
  1. Requests arrive at protected API endpoints (most endpoints).
  2. Next.js Middleware or API Route Middleware intercepts the request.
  3. Middleware extracts the JWT from the cookie.
  4. JWT signature and expiration are verified using the secret key.
  5. If valid, the request proceeds; otherwise, a 401/403 error is returned.
- **WordPress/Web Integration Token Flow:**
  1. An initial secure request hits `GET /api/web-token`.
  2. The endpoint validates the secret and generates a short-lived, single-use token.
  3. This token is potentially passed to the frontend client running within WordPress.
  4. The client might use this token to call `POST /api/get-token`.
  5. `POST /api/get-token` validates the token and issues a standard JWT cookie.
- **Cron Job Authentication:**
  1. Scheduled jobs call specific endpoints (`/api/firestoreCron`, `/api/pruneRateLimits`,
     `/api/admin/digestSelfProvision`, `/api/admin/cleanupExpiredInvitations`).
  2. The request must include an `Authorization: Bearer <CRON_SECRET>` header.
  3. The endpoint validates the secret using `cronAuthUtils.ts`.
- **Admin Sudo Mode:**
  1. An admin user calls `POST /api/sudoCookie` (likely triggered from a specific admin UI).
  2. The endpoint verifies the user's JWT confirms they are an admin.
  3. If admin, a separate "sudo mode" cookie is set (`sudoCookieUtils.ts`).
  4. Certain operations might check for this cookie to allow privileged actions.

### Site-Specific Authentication Rules

### Critical Rule: No Sudo on Login-Required Sites

The authentication system behaves differently based on the site's `requireLogin` configuration:

- **Login-Required Sites** (`siteConfig.requireLogin === true`):

  - Examples: `ananda`, `jairam` sites
  - **Admin Authorization**: Always uses JWT `role` field (`admin` or `superuser`)
  - **No Sudo Cookie**: `sudoCookie` checks are completely bypassed
  - **Implementation**: All admin pages and API endpoints use `isAdminPageAllowed()` and role-based checks
  - **Client Components**: Avoid `SudoContext` - derive admin capability from JWT role

- **No-Login Sites** (`siteConfig.requireLogin === false`):
  - Examples: `ananda-public`, `crystal` sites
  - **Admin Authorization**: Uses `sudoCookie` (legacy bless flow)
  - **No JWT Roles**: No user authentication system, so role checks are not applicable
  - **Implementation**: Admin access gated by `getSudoCookie()` validation

**Enforcement Pattern:**

```typescript
// Correct pattern for admin gating
if (siteConfig?.requireLogin) {
  // Use JWT role-based authorization
  const allowed = await isAdminPageAllowed(req, res, siteConfig);
} else {
  // Use sudo cookie for no-login sites
  const sudo = getSudoCookie(req, res);
  const allowed = !!sudo.sudoCookieValue;
}
```

---

## 5. Server-Side Logic

- **Chat Response Generation (`makechain.ts`, `app/api/chat/v1/route.ts`):**
  - Core RAG pipeline implementation using LangChain.
  - Selects appropriate prompt based on namespace (`site-config/prompts/`).
  - Initializes Pinecone vector store connection for the relevant namespace.
  - Uses `ConversationalRetrievalQAChain` which:
    1. Optionally rephrases the question based on history.
    2. Performs similarity search in Pinecone to find relevant document chunks.
    3. Injects retrieved context and chat history into the LLM prompt.
    4. Calls the LLM (e.g., OpenAI) to generate an answer.
    5. Streams the answer back to the client.
  - Handles source document formatting and logging.
- **Data Ingestion (`data_ingestion/`):**
  - A collection of Python scripts responsible for populating the Pinecone vector database.
  - `transcribe_and_ingest_media.py`: Main script orchestrating the process for various media types.
  - **Steps:**
    1. **Source Acquisition:** Fetches files from local paths, S3, or downloads from URLs.
    2. **Preprocessing:** Extracts text from PDFs using pdfplumber, transcribes audio/video.
    3. **Chunking:** Uses spaCy for semantic paragraph-based chunking with dynamic sizing (225-450 word target range)
       which significantly outperforms fixed-size chunking. Adaptive token sizes based on content length with smart
       merging to achieve optimal word counts. Includes fallback to sentence-based chunking for texts without
       paragraphs.
    4. **Metadata Extraction:** Gathers relevant metadata (source, author, title, etc.).
    5. **Embedding:** Generates vector embeddings for text chunks.
    6. **Upserting:** Uploads vectors and associated metadata to the correct Pinecone namespace using document-level
       hashing for efficient bulk operations.
  - **PDF Processing:** Converted from TypeScript (`pdf_to_vector_db.ts`) to Python (`pdf_to_vector_db.py`) with
    improved full-document processing instead of page-by-page to preserve context across page boundaries.
  - **Document Hashing:** Implements centralized document-level hashing (`data_ingestion/utils/document_hash.py`) where
    all chunks from the same document share the same hash, enabling easy bulk operations and deduplication.
  - Uses helper scripts for specific tasks (`youtube_utils.py`, `s3_utils.py`, `pinecone_utils.py`).
  - Manages tasks potentially via a queue (`IngestQueue.py`, `manage_queue.py`).
- **Related Questions Generation:**
  - Takes the user's query and potentially the conversation context.
  - Sends a request to an LLM to generate relevant follow-up questions.
  - Caches results (Firestore/Redis) to reduce LLM calls.
- **Voting:**
  - API endpoints receive vote requests with message/answer IDs.
  - Use Firestore transactions or atomic increments to update vote counts.
  - Record individual votes in separate collections to prevent duplicate actions.
- **Rate Limiting:**
  - Implemented as API middleware.
  - Uses Redis to store counters keyed by IP address (or potentially user ID).
  - For each request, increments the counter and checks if it exceeds the defined limit.
  - If the limit is exceeded, returns a 429 Too Many Requests error.
  - Expired keys are periodically pruned via the `/api/pruneRateLimits` cron job.
- **Email System (`userInviteUtils.ts`, `emailTemplates.ts`):**
  - **AWS SES Integration:** Uses AWS SES for reliable email delivery with proper credentials management.
  - **Activation Emails:** `sendActivationEmail()` sends branded activation links with 14-day expiry.
  - **Welcome Emails:** `sendWelcomeEmail()` automatically sent when users complete profile activation, includes
    site-specific branding and prominent button to access chatbot homepage.
  - **Email Templates:** `generateEmailContent()` creates both HTML and plain text versions with responsive design, site
    logos, and proper action buttons.
  - **Domain Detection:** Automatically uses request domain for email links (supports localhost, production, and Vercel
    preview deployments).
  - **Error Handling:** Email failures are logged but don't block user operations (e.g., profile updates continue even
    if welcome email fails).
- **Configuration Management:**
  - Server loads configuration details from `site-config/config.json`.
  - Prompts specific to different namespaces/personas are loaded from JSON files within `site-config/prompts/`.

### Semantic Location Intent Detection

The system implements an advanced semantic-based location intent detection system that achieves 96.6% accuracy with full
multilingual support. This replaces traditional keyword-based approaches with contrastive learning using OpenAI
embeddings.

**Architecture Components:**

- **Seed Data Management (`web/site-config/location-intent/`):**

  - Site-specific seed files containing positive and negative location intent examples
  - `{site}-seeds.json` format with curated multilingual examples
  - Currently implemented for `ananda-public` with 68 positive and 28 negative seeds
  - **Data Sharing:** The `ananda` site uses the same location intent data as `ananda-public` by copying the embeddings
    file
  - Human-editable JSON files for easy maintenance and updates

- **Embedding Generation (`web/scripts/generate-location-intent-embeddings.ts`):**

  - One-time script to generate semantic embeddings from seed data
  - Uses configurable OpenAI embedding model (currently `text-embedding-3-large` with 3072 dimensions)
  - Batch processing with rate limiting for efficient API usage
  - Outputs embeddings to `web/private/location-intent/{site}-embeddings.json`
  - Includes metadata: model, timestamp, counts, and dimensions

- **Runtime Detection Module (`web/src/utils/server/locationIntentDetector.ts`):**
  - Loads site-specific embeddings into memory cache on initialization
  - Implements contrastive scoring algorithm:
    - Positive similarity threshold: >= 0.44
    - Contrastive threshold: positive similarity must exceed negative by >= 0.1
  - Average latency: ~250ms per query (includes OpenAI API call for query embedding)
  - Graceful fallback if embeddings unavailable

**Integration with RAG Pipeline:**

- **Initialization:** `initializeLocationIntentDetector(siteId)` called during chain setup
- **Detection:** `hasLocationIntentAsync(query)` replaces regex-based detection
- **Tool Binding:** Geo-awareness tools conditionally bound to OpenAI model based on semantic detection
- **Multilingual Support:** Works across English, Spanish, German, French, Italian, Portuguese, and Hindi

**Performance Characteristics:**

- **Accuracy:** 96.6% on multilingual test dataset
- **Latency:** ~250ms average (includes OpenAI embedding generation)
- **Scalability:** Site-specific configuration without code changes
- **Reliability:** Contrastive learning prevents false positives on meditation content queries

**File Structure:**

```text
web/
├── site-config/location-intent/
│   └── ananda-public-seeds.json          # Human-editable seed phrases
├── private/location-intent/
│   └── ananda-public-embeddings.json     # Generated embeddings (8MB)
│   └── ananda-embeddings.json            # Shared embeddings (copy of ananda-public)
├── scripts/
│   └── generate-location-intent-embeddings.ts  # Embedding generation script
└── src/utils/server/
    └── locationIntentDetector.ts         # Runtime detection module
```

**Maintenance Workflow:**

1. **Seed Updates:** Edit `{site}-seeds.json` files to add/modify examples
2. **Regeneration:** Run `npm run build:location-intent -- --site {site}` to update embeddings
3. **Data Sharing:** For sites sharing embeddings (like `ananda` using `ananda-public` data), copy the generated
   embeddings file manually
4. **Deployment:** Embeddings are committed to version control and deployed with the application
5. **Monitoring:** Detection accuracy can be monitored through chat logs and user feedback

---

## 5. Utility Scripts & Cron Jobs

The `bin/` directory and parts of `data_ingestion/audio_video/` contain various Python utility scripts for maintenance,
data processing, and analysis.

- **`bin/count_hallucinated_urls.py`**
  - **Purpose:** Analyzes Firestore `chatLogs` (effectively "Answers" based on environment) to identify and count URLs
    present in answer fields that return errors or non-2xx HTTP status codes (e.g., 404 Not Found).
  - **Functionality:**
    - Connects to Firestore.
    - Queries chat logs within specified time intervals.
    - Extracts all URLs from the 'answer' field of each log.
    - Performs HTTP HEAD requests to each unique URL to check its status.
    - Reports counts of invalid/broken URLs, categorized by time interval.
  - **Usage:** Typically run manually or as a scheduled task to monitor the health of URLs provided in chatbot answers.
    `python bin/count_hallucinated_urls.py --site <site_id> -e <environment> --interval <days> [--num-intervals <count>]`
