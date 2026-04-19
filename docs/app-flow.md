# Ananda Library Chatbot - Application Flow

## Ananda Library Chatbot - App Flow Document

**Purpose:** This document outlines the typical user journey, navigation, and key interactions within the Ananda Library
Chatbot application.

**Contents:**

1. **User Workflows**
2. **Screen Transitions / States**
3. **Key Interactions**
4. **Integration Points**

---

### 1. User Workflows

#### Chat Interaction Flow

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    User     │    │  Frontend   │    │   Backend   │    │   AI/Data   │
│             │    │   (Next.js) │    │    APIs     │    │  Services   │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │                  │
       │ 1. Enter Question│                  │                  │
       ├─────────────────→│                  │                  │
       │                  │ 2. JWT + Query   │                  │
       │                  ├─────────────────→│                  │
       │                  │                  │ 3. Vector Search │
       │                  │                  ├─────────────────→│
       │                  │                  │ 4. Context Chunks│
       │                  │                  │←─────────────────┤
       │                  │                  │ 5. LLM Generate  │
       │                  │                  ├─────────────────→│
       │                  │ 6. Stream Answer │ 6. Stream Response│
       │                  │←─────────────────┤←─────────────────┤
       │ 7. Display Answer│                  │                  │
       │←─────────────────┤                  │                  │
       │                  │                  │ 8. Log to DB     │
       │                  │                  ├─────────────────→│
       │ 9. Feedback      │                  │                  │
       ├─────────────────→│ 10. Store Vote   │                  │
       │                  ├─────────────────→│                  │
```

#### A. Basic Question & Answer Flow (Unauthenticated/Default)

1. **User Accesses Chatbot:** The user lands on the page hosting the chatbot (either the main Next.js application page
   or a WordPress page where the plugin is embedded).
2. **View Chat Interface:** The user sees the chat interface, including:
   - A message display area.
   - An input field for questions.
   - A submit button.
   - (Optional) A selector for choosing a knowledge base/collection (`hooks/useMultipleCollections.ts`).
   - (Optional) Example/suggested questions (`public/data/.../whole_library_queries.txt`).
3. **(Optional) Select Collection:** The user might select a specific library or collection to query against.
4. **Enter Question:** The user types their question into the input field.
5. **Submit Question:** The user clicks the submit button or presses Enter.
6. **Receive Answer:**
   - The frontend sends the question (and selected collection) to the backend chat API (`app/api/chat/v1/route.ts`).
   - The backend processes the question, retrieves relevant information (likely from Pinecone vector store -
     `utils/server/pinecone-client.ts`, `utils/server/makechain.ts`), generates an answer, and streams it back.
   - The frontend displays the answer, potentially showing sources.
7. **(Optional) Provide Feedback:** The user can provide feedback on the answer using voting buttons
   (`utils/client/voteHandler.ts`, `pages/api/vote.ts`).

#### B. Authenticated User Flow

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    User     │    │  Frontend   │    │   Backend   │    │  Database   │
│             │    │   (Next.js) │    │    APIs     │    │ (Firestore) │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │                  │
       │ 1. Access Site   │                  │                  │
       ├─────────────────→│                  │                  │
       │                  │ 2. Check Auth    │                  │
       │                  ├─────────────────→│                  │
       │                  │ 3. Redirect Login│                  │
       │                  │←─────────────────┤                  │
       │ 4. Enter Creds   │                  │                  │
       ├─────────────────→│                  │                  │
       │                  │ 5. Login Request │                  │
       │                  ├─────────────────→│                  │
       │                  │                  │ 6. Verify Hash   │
       │                  │                  ├─────────────────→│
       │                  │                  │ 7. User Valid    │
       │                  │                  │←─────────────────┤
       │                  │ 8. JWT + Cookie  │                  │
       │                  │←─────────────────┤                  │
       │ 9. Chat Access   │                  │                  │
       │←─────────────────┤                  │                  │
```

If the site is configured to require user login:

1. **User Navigates to Login:** The user accesses a login mechanism (potentially a dedicated page or modal).
2. **Enter Credentials:** The user provides credentials - a password shared by all users of the site.
3. **Submit Login:** The user submits the login form, triggering the login API (`pages/api/login.ts`). Authentication
   might involve JWT (`utils/server/jwtUtils.ts`) and password hashing (`utils/server/passwordUtils.ts`). Middleware
   (root `middleware.ts`, `utils/server/apiMiddleware.ts`, `utils/server/jwtUtils.ts`) handles session/token validation
   for subsequent requests.
4. **Access Authenticated Features:** Once logged in, the user has access to
   - The main chat interaction page.
   - The All Answers page (if turned on for the site).
   - Individual answer pages.
5. **Perform Actions:** The user interacts with the chatbot as in the basic flow, but potentially with elevated
   privileges or access.
6. **Logout:** The user initiates logout, triggering the logout API (`pages/api/logout.ts`).

#### C. WordPress Integration Flow

1. **User Visits WordPress Page:** The user navigates to a WordPress page containing the chatbot embed code provided by
   the plugin (`wordpress/plugins/ananda-ai-chatbot/ai-chatbot.php`).
2. **Chatbot Widget Loads:** The chatbot JavaScript (`assets/js/chatbot.js`) initializes the chat interface widget on
   the page. Authentication might be handled via WordPress mechanisms feeding into the chatbot's auth
   (`assets/js/chatbot-auth.js`, `pages/api/web-token.ts`).
3. **Interact with Widget:** The user interacts with the chatbot within the widget, following the Basic Question &
   Answer Flow described above. API calls are made from the WordPress frontend to the Next.js backend API.

#### D. Conversation History & Sharing Flow

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    User     │    │  Frontend   │    │   Backend   │    │   Database  │
│             │    │   (Next.js) │    │    APIs     │    │ (Firestore) │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │                  │
       │ 1. Start New Chat│                  │                  │
       ├─────────────────→│                  │                  │
       │                  │ 2. Generate convId│                 │
       │                  ├─────────────────→│                  │
       │                  │ 3. AI Title Gen  │                  │
       │                  ├─────────────────→│ 4. Store w/convId│
       │                  │                  ├─────────────────→│
       │ 5. URL: /chat/[convId]              │                  │
       │←─────────────────┤                  │                  │
       │                  │                  │                  │
       │ 6. View History  │                  │                  │
       ├─────────────────→│ 7. Fetch Convos │                  │
       │                  ├─────────────────→│ 8. Query by UUID │
       │                  │                  ├─────────────────→│
       │                  │                  │ 9. Grouped Convos│
       │                  │                  │←─────────────────┤
       │ 10. Display List │                  │                  │
       │←─────────────────┤                  │                  │
       │                  │                  │                  │
       │ 11. Share Link   │                  │                  │
       ├─────────────────→│ 12. Generate     │                  │
       │                  │ /share/[docId]   │                  │
       │ 13. Share URL    │                  │                  │
       │←─────────────────┤                  │                  │
```

**Conversation History Workflow:**

1. **New Conversation Creation:**

   - User starts a new chat from home page (`/`)
   - System generates unique `convId` (UUID v4) for the conversation
   - AI generates 4-5 word title for the conversation
   - URL updates to `/chat/[convId]` after first answer
   - Conversation appears in sidebar history with AI-generated title

2. **Conversation History Access:**

   - Authenticated users see conversation history in left sidebar (hamburger menu on mobile)
   - Last 20 conversations displayed with lazy-loading for more
   - Conversations grouped by `convId` with AI-generated titles
   - Cross-device sync via UUID for logged-in users

3. **Conversation Continuation:**

   - User clicks on conversation in history sidebar
   - System loads full conversation via `/api/conversation/[convId]`
   - User can continue conversation from where they left off
   - Follow-up messages maintain same `convId` and URL

4. **Conversation Sharing:**

   - User clicks share button on any message in conversation
   - System generates `/share/[docId]` URL for that specific message point
   - Share link shows conversation up to that timestamp only
   - Recipients see view-only conversation without continuation ability
   - No authentication required for share links

5. **Privacy Controls:**
   - Users choose between two conversation types (with third option planned):
     - **Public**: Saved and shared on answers page for community browsing
     - **Temporary**: Not saved or stored (renamed from "Private Session")
     - **Private**: Saved in user account but not shared publicly (coming soon)

### 2. Screen Transitions / States

- **Initial Load:** Chat interface is displayed, possibly with introductory text or suggested questions.
- **Collection Selection:** If multiple collections exist, the UI updates to reflect the selected collection.
- **Question Input:** User focuses on the input field.
- **Loading/Waiting for Answer:** After submitting a question, a loading indicator (e.g.,
  `styles/loading-dots.module.css`) appears while waiting for the backend response.
- **Answer Display:** The chat area updates with the user's question and the chatbot's streamed response. Source links
  or related questions might appear alongside the answer.
- **Feedback State:** Buttons for liking/disliking might change appearance after being clicked.
- **(Authenticated) Login Screen:** A separate view/modal for entering credentials.
- **(Authenticated) Logged-in State:** UI might show user status or provide access to logout/admin features.
- **(Conversation History) Sidebar Open:** Left sidebar displays conversation history with AI-generated titles
  (hamburger menu on mobile).
- **(Conversation History) Loading State:** Conversation history loads asynchronously after main chat interface.
- **(Conversation History) Conversation Selected:** Clicking a conversation loads full history and updates URL to
  `/chat/[convId]`.
- **(Sharing) Share Modal:** Modal displays shareable link for specific conversation point with copy-to-clipboard
  functionality.
- **(Sharing) View-Only Mode:** Recipients of share links see read-only conversation view without input capabilities.
- **(Privacy Selection) Session Type:** User selects between Public or Temporary conversation modes before starting
  (Private mode coming soon).

### 3. Key Interactions

- **Sending a Chat Message:** Typing text and submitting via button or Enter key (`hooks/useChat.ts`).
- **Selecting a Collection:** Choosing from a dropdown or list (`hooks/useMultipleCollections.ts`).
- **Voting on an Answer:** Clicking thumbs-up/down icons (`utils/client/voteHandler.ts`, `pages/api/vote.ts`).
- **Viewing Sources:** Clicking links associated with an answer to see the origin of the information.
- **Viewing All Answers:** Viewing answers from all users (if turned on for the site).
- **Viewing Related Questions:** Clicking on suggested follow-up questions.
- **(Authenticated) Logging In/Out:** Using forms/buttons to manage authentication state.
- **(WordPress) Opening/Closing Chat Widget:** Interacting with the embedded chat element on the page.
- **(Conversation History) Opening Sidebar:** Clicking hamburger menu (mobile) or sidebar toggle to view conversation
  history.
- **(Conversation History) Selecting Conversation:** Clicking on conversation title in sidebar to load and continue
  conversation.
- **(Conversation History) New Conversation:** Clicking "New Conversation" button to start fresh chat and reset URL.
- **(Sharing) Generating Share Link:** Clicking share button on any message to generate `/share/[docId]` URL.
- **(Sharing) Copying Share Link:** Using copy-to-clipboard functionality in share modal.
- **(Privacy) Selecting Session Type:** Choosing between Public or Temporary conversation modes via UI controls (Private
  mode coming soon).
- **(Navigation) URL-based Loading:** Direct navigation to `/chat/[convId]` or `/share/[docId]` URLs loads appropriate
  conversation state.

### 4. Integration Points

- **Backend API:** The core interaction point is the chat API (`app/api/chat/v1/route.ts`), handling question processing
  and answer generation.
- **Vector Database (Pinecone):** Used for retrieving relevant document chunks based on the user's query
  (`config/pinecone.ts`, `utils/server/pinecone-client.ts`). Data is populated into Pinecone through various ingestion
  processes, including a website crawler (`data_ingestion/crawler/website_crawler.py`), PDF processing, audio/video
  transcription, and direct SQL database imports.
- **Database (Firestore):** Likely used for storing chat logs, user votes, configuration, or other persistent data
  (`services/firebase.ts`, `utils/server/firestoreUtils.ts`).
- **Authentication System:** Manages user login, logout, and potentially JWT tokens (`pages/api/login.ts`,
  `pages/api/logout.ts`, `utils/server/jwtUtils.ts`).
- **WordPress:** The chatbot can be embedded and interact within a WordPress environment via the plugin (`wordpress/`).
- **Rate Limiting (Redis):** Mechanisms to prevent abuse (`utils/server/redisUtils.ts`,
  `utils/server/genericRateLimiter.ts`, `pages/api/pruneRateLimits.ts`).

This flow provides a high-level overview based on the project structure.
