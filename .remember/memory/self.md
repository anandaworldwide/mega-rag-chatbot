# self.md

## Critical Lessons Learned

### 1. Always Add `--site` CLI Argument and Environment Loading

**Wrong**: Creating scripts without `--site` command-line option and not calling `load_env(site)`.

```python
# Missing site arg and env load
args = parser.parse_args()
# ... directly uses get_pinecone_client() → env vars not loaded
```

**Correct**: Always follow ingestion-script pattern:

```python
from pyutil.env_utils import load_env

args = parser.parse_args()
load_env(args.site)  # loads .env.<site>
# now safe to access Pinecone/OpenAI env vars
```

### 2. Token vs Word Count Confusion in Chunking Systems

**Problem**: Chunking systems use **token-based targets** (600 tokens) but analysis/statistics often report **word
counts**, creating evaluation mismatches.

**Wrong**: Measuring words when system uses token targets.

```python
word_count = len(text.split())
target_range = 225-450  # words
```

**Correct**: Use same tokenization as production system.

```python
import tiktoken
encoding = tiktoken.encoding_for_model("text-embedding-ada-002")
token_count = len(encoding.encode(text))
target_range = 450-750  # tokens (75%-125% of 600-token target)
```

### 3. HTML Processing Destroying Paragraph Structure

**Wrong**: Aggressive whitespace normalization destroys paragraph breaks.

```python
text = soup.get_text()
text = re.sub(r'\s+', ' ', text).strip()  # DESTROYS ALL PARAGRAPHS
```

**Correct**: Preserve block structure, then selectively normalize.

```python
text = soup.get_text(separator='\n\n', strip=True)  # PRESERVES BLOCK STRUCTURE
text = re.sub(r'[ \t]+', ' ', text)        # Fix spacing within lines
text = re.sub(r'\n{3,}', '\n\n', text)     # Normalize excessive newlines
```

### 4. Test During Development, Not at End

**Wrong**: Separating unit tests into "Phase III" at the end.

**Correct**: Test immediately after each component:

```markdown
### [ ] 1. Create `utils/text_processing.py`

- [ ] Functions to extract...
- [ ] Create unit tests for `text_processing.py` ← IMMEDIATE
- [ ] Validate one script works before moving on
```

### 5. Explicit TypeScript Typing for Firestore Operations

**Wrong**: Implicit 'any' types in Firestore map functions.

```typescript
querySnapshot.docs.map((doc) => ...)  // 'doc' has implicit 'any' type
```

**Correct**: Always explicitly type Firestore document parameters.

```typescript
querySnapshot.docs.map(
  (doc: firebase.firestore.QueryDocumentSnapshot) => ...
);
```

### 6. Implement Retry Logic for External Service Failures

**Pattern**: Google Cloud/Firestore intermittent failures (code 14, "Policy checks unavailable").

**Solution**: Centralized retry utilities with exponential backoff.

```typescript
import { firestoreGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";

// Instead of direct Firestore calls
const doc = await firestoreGet(docRef, "operation name", "context");
```

### 7. Overlap Logic Must Respect Token Limits

**Wrong**: Blindly adding overlap without validation.

```python
overlapped_chunk = overlap_text + " " + chunk  # Could exceed 600 tokens!
```

**Correct**: Calculate available token budget first.

```python
chunk_tokens = len(self._tokenize_text(chunk))
max_overlap_tokens = self.chunk_size - chunk_tokens

if max_overlap_tokens > 0:
    actual_overlap = min(self.chunk_overlap, max_overlap_tokens)
    # Only add overlap that fits within token budget
```

### 8. HTML Paragraph Tag Processing for PDF Generation

**Wrong**: BeautifulSoup tree manipulation with insert_before/insert_after can fail to preserve newlines.

```python
# Unreliable - BeautifulSoup may not preserve inserted newlines
for p_tag in soup.find_all("p"):
    p_tag.insert_before("\n\n")
    p_tag.insert_after("\n\n")
    p_tag.unwrap()
```

**Correct**: Use regex preprocessing before BeautifulSoup for reliable paragraph conversion.

```python
# Reliable - Convert <p> tags to newlines before parsing
content = re.sub(r'<p[^>]*>', '\n\n', content)  # Opening tags
content = re.sub(r'</p>', '\n\n', content)      # Closing tags
soup = BeautifulSoup(content, "html.parser")    # Then clean attributes
```

### 9. ReportLab PDF Generation - Remove Problematic Tags and Attributes

**Wrong**: Removing all HTML or not removing problematic tags/attributes that cause ReportLab paraparser failures.

```python
# Either too aggressive (removes formatting)
text = soup.get_text()  # Loses <em>, <strong> formatting

# Or insufficient (misses problematic tags/attributes)
if attr in ["id", "class", "style"]:  # Misses "rel", "alt", etc.
# Missing: <img> tags without src attribute cause "paraparser: syntax error: <img> needs src attribute"
```

**Correct**: Remove problematic tags completely, then clean attributes while preserving formatting tags.

```python
# STEP 1: Remove tags that cause paraparser failures
for img_tag in soup.find_all("img"):
    img_tag.decompose()  # <img> tags without src cause paraparser errors

# STEP 2: Remove problematic attributes while keeping formatting tags
problematic_attrs = [
    "id", "class", "style", "href", "onclick", "onload", "name",
    "rel", "target", "alt", "height", "width", "src",
    "title", "lang", "dir", "tabindex", "accesskey", "contenteditable",
    "draggable", "hidden", "spellcheck", "translate"
]

for attr in tag.attrs:
    if (attr in problematic_attrs
        or attr.startswith("data-")
        or attr.startswith("on")
        or attr.startswith("aria-")):
        del tag.attrs[attr]  # Remove attribute but keep the tag
```

### 10. Mobile Safari Download Issues

**Problem**: `window.open()` doesn't reliably trigger file downloads on mobile Safari (iPhone/iPad). The window opens
but no download occurs.

**Wrong**: Using `window.open()` for programmatic downloads.

```typescript
// Doesn't work on mobile Safari
window.open(signedUrl, "_blank");
```

**Correct**: Create temporary link element with download attribute and programmatically click it.

```typescript
// Works reliably on mobile Safari
const link = document.createElement("a");
link.href = signedUrl;
link.download = filename || "document.pdf";
link.style.display = "none";

document.body.appendChild(link);
link.click();
document.body.removeChild(link);
```

**Pattern**: For any programmatic file downloads, use the temporary link approach instead of `window.open()` to ensure
mobile compatibility.

**Cross-Browser Compatibility**: This fix works across all iOS browsers (Safari, Chrome, Firefox, Edge) because Apple
requires all iOS browsers to use WebKit as their rendering engine. The programmatic link clicking approach with the
`download` attribute is well-supported across WebKit-based browsers and specifically addresses mobile browser
restrictions on programmatic window opening and file downloads.

### 11. Avoid Dynamic Imports for Error Handling

**Problem**: Using dynamic imports (`await import()`) for error handling creates sloppy, hard-to-follow code patterns.

**Wrong**: Dynamic import in error handling block.

```typescript
// Sloppy - dynamic import in catch block
try {
  const { sendS3OpsAlert } = await import("./emailOps");
  await sendS3OpsAlert("load", bucket, key, error);
} catch (emailError) {
  console.error("Failed to send ops alert:", emailError);
}
```

**Correct**: Use proper static imports at the top of the file.

```typescript
// Clean - static import at top
import { sendS3OpsAlert } from "./emailOps";

// Later in error handling
try {
  await sendS3OpsAlert("load", bucket, key, error);
} catch (emailError) {
  console.error("Failed to send ops alert:", emailError);
}
```

**Pattern**: Always use static imports for dependencies that are used in error handling or other critical paths. Dynamic
imports should only be used for code splitting and lazy loading scenarios, not for error handling utilities.

### 12. Jest Mock Setup for AWS SDK

**Problem**: TypeScript linter errors when mocking AWS SDK clients due to strict typing issues.

**Wrong**: Using strict typing that conflicts with Jest mocks.

```typescript
const mockS3Client = s3Client as jest.Mocked<typeof s3Client>; // Causes 'never' type errors
```

**Correct**: Use 'any' type for test mocks to avoid strict typing conflicts.

```typescript
const mockS3Client = s3Client as any; // Allows flexible mocking
```

**Pattern**: For Jest tests, prefer `as any` typing for external service mocks (S3, APIs) to avoid TypeScript strict
typing conflicts while maintaining test functionality.

### 13. AWS SDK Command Mocking for Integration Tests

**Problem**: AWS SDK command objects (HeadObjectCommand, GetObjectCommand) need to return proper structure for test
assertions to work.

**Wrong**: Using basic jest.fn() without implementation for command constructors.

```typescript
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn(), // Returns undefined, breaks test assertions
  GetObjectCommand: jest.fn(),
}));
```

**Correct**: Mock command constructors to return objects with input property containing parameters.

```typescript
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));
```

**Pattern**: AWS SDK commands must be mocked to return `{ input: params }` structure so that test assertions can verify
the correct parameters were passed to S3 operations.

### 14. S3 Content-Type Validation for Legacy Files

**Problem**: S3 files uploaded without proper MIME type headers return `binary/octet-stream` or
`application/octet-stream` instead of expected content types like `audio/mpeg`, causing content-type validation to fail
for valid files.

**Root Cause**: Older file uploads or uploads without explicit content-type headers default to generic octet-stream MIME
types in S3, even for valid audio/video files.

**Wrong**: Strict content-type validation that only accepts specific MIME types.

```typescript
// Too restrictive - rejects valid files with generic MIME types
if (!VALID_AUDIO_MIME_TYPES.some((type) => headResponse.ContentType?.includes(type.split("/")[1]))) {
  return res.status(400).json({ message: "File is not an audio document" });
}
```

**Correct**: Accept both specific MIME types AND generic octet-stream types for files with valid extensions.

```typescript
// More permissive - accepts valid files regardless of MIME type inconsistencies
const isValidAudioType = VALID_AUDIO_MIME_TYPES.some((type) => headResponse.ContentType?.includes(type.split("/")[1]));
const isBinaryOctetStream =
  headResponse.ContentType.includes("binary/octet-stream") ||
  headResponse.ContentType.includes("application/octet-stream");

if (!isValidAudioType && !isBinaryOctetStream) {
  return res.status(400).json({ message: "File is not an audio document" });
}
```

**Pattern**: For file validation systems, combine file extension validation (primary security) with permissive
content-type validation that accepts both specific MIME types and generic octet-stream types. This handles legacy
uploads while maintaining security through extension checks.

### 15. Universal S3 Content-Type Issue Pattern

**Issue**: Legacy file uploads in S3 commonly return `binary/octet-stream` or `application/octet-stream` instead of
specific MIME types (like `audio/mpeg`, `application/pdf`), causing strict content-type validation to fail for valid
files.

**Root Cause**: Files uploaded without explicit content-type headers, older uploads, or certain upload methods default
to generic octet-stream MIME types in S3.

**Universal Fix Pattern**: Accept both specific MIME types AND octet-stream types for all file validation endpoints.

```typescript
// Universal pattern for any file type validation
if (headResponse.ContentType) {
  const isValidSpecificType = headResponse.ContentType.includes("expected-type"); // pdf, mpeg, etc.
  const isBinaryOctetStream =
    headResponse.ContentType.includes("binary/octet-stream") ||
    headResponse.ContentType.includes("application/octet-stream");

  if (!isValidSpecificType && !isBinaryOctetStream) {
    return res.status(400).json({
      message: "File is not a [TYPE] document",
      actualType: headResponse.ContentType,
    });
  }
}
```

**Applied To**: Fixed audio endpoints (`getAudioSignedUrl`, `getPublicAudioUrl`) and PDF endpoint (`getPdfSignedUrl`)
with comprehensive test coverage for octet-stream acceptance.

### 16. macOS LaunchAgent Daemon Pattern for Background Services

**Pattern**: Use macOS LaunchAgent plist files with proper resource limits and logging for background services.

**Implementation**: Create plist template with placeholders, daemon manager script for installation/management, and
comprehensive logging setup.

**Key Components**:

1. **Plist Template**: XML configuration with resource limits, logging paths, and auto-restart settings
2. **Daemon Manager**: Python script for install/uninstall/status/start/stop/restart/logs operations
3. **Port Management**: Unique port assignment per service to avoid conflicts
4. **Logging**: Structured logging to `~/Library/Logs/` with rotation support

**Resource Limits**:

```xml
<key>SoftResourceLimits</key>
<dict>
    <key>ResidentSetSize</key>
    <integer>536870912</integer>  <!-- 512MB memory limit -->
    <key>CPU</key>
    <integer>86400</integer>      <!-- 24 hours CPU time -->
</dict>
```

**Service Management Pattern**:

```bash
# Install service
python daemon_manager.py --site site-name install

# Check status
python daemon_manager.py --site site-name status

# View logs
python daemon_manager.py --site site-name logs --follow
```

**Applied To**: Website crawler daemon and health server daemon with automatic startup on system reboot.

### 17. Test Environment Alert Suppression

**Problem**: Automated tests (including Vercel tests) were triggering real operational alert emails when tests
intentionally failed operations, causing email spam.

**Root Cause**: The `sendOpsAlert` function was sending emails whenever `OPS_ALERT_EMAIL` environment variable was set,
regardless of test environment.

**Solution**: Added test environment detection to suppress alerts during testing:

```typescript
// In emailOps.ts
// Suppress alerts during testing to prevent spam when tests intentionally fail
if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
  console.log(`[TEST MODE] Suppressing ops alert: ${subject}`);
  return true; // Return true to indicate successful "sending" for test compatibility
}
```

**Key Insight**: Test environment detection must come after basic validation (checking `OPS_ALERT_EMAIL` exists and
contains valid emails) so that tests expecting validation failures still work correctly.

**Pattern**: For operational alerts, always check for test environment using both `NODE_ENV === "test"` and
`JEST_WORKER_ID !== undefined` to cover all Jest execution scenarios.

### 18. Related Questions API Intermittent Failures - Root Cause Found

**Problem**: Related questions API (`/api/relatedQuestions`) fails intermittently with "All 3 upsert/verification
attempts failed" error after chat responses complete.

**Root Cause Found**: **Pinecone Eventual Consistency Issue**

- The error occurs in `upsertEmbeddings()` function where Pinecone upsert operations succeed but verification fails
- **Root Cause**: 500ms verification delay was insufficient for Pinecone's eventual consistency window
- **Evidence**: Debug logs showed upsert success → 500ms delay → verification failure (0 records) → retry → 500ms delay
  → verification success (1 record)

**Solution Implemented**:

- Increased verification delay from 500ms to 2000ms (2 seconds) in production
- Added logging to track the consistency delay
- Maintained shorter delay (100ms) for test environment

**Key Insight**: Pinecone has eventual consistency where:

- Upsert operations return success immediately
- Data may not be immediately available for reads
- Consistency window can be 1-2 seconds or longer

**Pattern**: For Pinecone operations requiring immediate verification, always use delays of 2+ seconds to account for
eventual consistency, not just 500ms.

**Files Modified**:

- `relatedQuestionsUtils.ts`: Increased verification delay in `upsertEmbeddings()` function

### 19. Markdownlint Error Patterns

**Common Issues**: MD013 (line length), MD022 (blanks around headings), MD032 (blanks around lists), MD024 (duplicate
headings), MD031 (blanks around fences), MD040 (fenced code language), MD050 (strong style).

**Systematic Fix Approach**:

1. **Line length (MD013)**: Break long lines at logical points (134+ chars)
2. **Blanks around headings (MD022)**: Add blank line before and after all headings
3. **Blanks around lists (MD032)**: Add blank line before and after all lists
4. **Duplicate headings (MD024)**: Make headings unique by adding context (e.g., "Test Directory Structure" → "Python
   Test Directory Structure")
5. **Fenced code blocks (MD031/MD040)**: Add blank lines around and specify language (`text,`typescript, ```python)
6. **Strong style (MD050)**: Use `**text**` instead of `__text__` for bold formatting

**Pattern**: Fix markdownlint errors systematically by category rather than line-by-line for efficiency.

### 20. Excel File Format Error Handling for Playlists

**Wrong**: Generic ValueError "not enough values to unpack (expected 4, got 1)" when Excel file has wrong format.

**Correct**: Comprehensive error handling with:

- Row number identification for errors
- Clear expected format specification
- Actual row content display
- Step-by-step format examples
- Validation function for pre-checking files
- Skip empty rows gracefully
- Proper exception chaining

**Implementation Pattern**:

```python
def validate_playlists_file_format(file_path):
    """Validates Excel format before processing."""
    # Check headers, data rows, and provide specific error messages

def process_playlists_file(args, queue):
    """Enhanced with detailed error reporting."""
    # Check row count, validate columns, provide actionable error messages
    # Skip empty rows, validate required fields
```

**Benefits**: Users get actionable error messages instead of cryptic unpacking errors, can validate files before
processing, get specific guidance on fixing format issues.

**Files Modified**: `manage_queue.py` with `validate_playlists_file_format()` function and enhanced
`process_playlists_file()` error handling.

### 21. Jest Pre-commit Configuration Module Resolution Issues

**Issue**: Tests that import admin page components fail in pre-commit Jest configuration due to Firebase initialization
requirements, even though they pass in regular Jest runs.

**Root Cause**: Pre-commit Jest config was not properly inheriting module resolution settings from the main Jest
configuration. The main config exports a function (`createJestConfig(customJestConfig)`) but the pre-commit config was
trying to spread it directly, resulting in empty configuration.

**Solution**: Fixed pre-commit Jest configuration to properly extract and inherit module resolution settings from the
main config.

**Pattern**: For Jest configurations that export functions, always call the function to get the actual configuration
object before spreading it.

**Implementation**: Modified `web/src/config/jest.pre-commit.cjs` to:

1. Properly handle the main config function vs object distinction
2. Recreate the `customJestConfig` object with proper `moduleNameMapper` settings
3. Ensure `@/services/firebase` and other path mappings work correctly

**Key Fix**: Instead of trying to extract config from `createJestConfig(customJestConfig)`, directly recreate the
`customJestConfig` object with all necessary module resolution settings.

**Result**: Pre-commit hooks now properly resolve module paths and can mock Firebase services correctly.

**Applied To**: Fixed `digestSelfProvision.test.ts` by ensuring proper module resolution in pre-commit Jest
configuration.

### 22. Chat Sidebar Conversation Limit Issue

**Issue**: Chat sidebar was only showing 5 conversations by default instead of the expected 20, even though
`useChatHistory(20)` was being called.

**Root Cause**: The API fetches individual chat messages (up to 50 by default), but the frontend groups them by `convId`
to create conversations. If users have many conversations with only a few messages each, they might only see 5
conversations even though 20+ individual messages were fetched.

**Solution**: Modified the `useChatHistory` hook to fetch more messages to ensure we get enough to group into the
desired number of conversations.

**Implementation**:

- Changed message limit calculation: `const messageLimit = Math.max(limit * 3, 50);` to fetch at least 3x the
  conversation limit or 50, whichever is higher
- Updated `hasMore` logic to use the new `messageLimit` instead of the conversation limit
- This ensures we fetch enough individual messages to group into 20 conversations

**Pattern**: For conversation grouping systems, always fetch more individual messages than the desired conversation
count to account for the grouping ratio.

**Files Modified**: `web/src/hooks/useChatHistory.ts` - updated message limit calculation and pagination logic.

**Result**: Chat sidebar now shows 20 conversations by default before showing the "Load More Conversations" button.

### 23. Star Functionality API Response Format Mismatch

**Issue**: Starred conversations showed a blank list despite backend returning data. The `fetchStarredConversations`
function expected a response object with `chats`, `hasMore`, and `nextCursor` properties, but the `/api/chats` endpoint
returns a simple array of `ChatHistoryItem` objects.

**Root Cause**: The `fetchStarredConversations` function was trying to access `data.chats` when `data` was actually the
array itself, resulting in `undefined` and empty starred conversations list.

**Solution**: Updated `fetchStarredConversations` to:

- Handle the correct API response format (direct array instead of object with `chats` property)
- Implement the same conversation grouping logic as `fetchConversations`
- Use proper pagination parameter (`startAfter` instead of `cursor`)
- Apply the same timestamp handling and sorting logic

**Pattern**: When reusing API endpoints for different purposes, ensure the response handling logic matches the actual
API response format, not assumptions about the format.

**Files Modified**: `web/src/hooks/useChatHistory.ts` - completely rewrote `fetchStarredConversations` function to match
API response format and implement proper conversation grouping.

### 24. TypeScript Build Error - Dev Scripts Included in Production Build

**Issue**: Vercel build failed with `Cannot find module 'commander'` error when TypeScript tried to compile dev-only
scripts during production build.

**Root Cause**: The `tsconfig.json` included `scripts/**/*.ts` in the compilation, causing all scripts (including
dev-only tools) to be type-checked. When these scripts imported packages not in production dependencies, the build
failed.

**Solution**: Remove dev script directories from TypeScript `include` array in `tsconfig.json`.

**Wrong**: Including script directories in production TypeScript compilation.

```json
"include": [
  "next-env.d.ts",
  "src/**/*.ts",
  "src/**/*.tsx",
  ".next/types/**/*.ts",
  "src/types/**/*.d.ts",
  "scripts/**/*.ts"  // Causes build failures for dev-only scripts
]
```

**Correct**: Only include production source code in TypeScript compilation.

```json
"include": [
  "next-env.d.ts",
  "src/**/*.ts",
  "src/**/*.tsx",
  ".next/types/**/*.ts",
  "src/types/**/*.d.ts"
  // scripts directory excluded - dev-only tools
]
```

**Pattern**: Keep dev-only scripts separate from production builds. Only include `src/**` directories in TypeScript
compilation unless scripts are explicitly needed for build processes.

**Files Modified**: `web/tsconfig.json` - removed `scripts/**/*.ts` from include array.

### 25. React Hooks exhaustive-deps with Refs and Forward Dependencies

**Issue**: ESLint `react-hooks/exhaustive-deps` warnings occur when:

1. Mutable refs (e.g., `pathRef.current`) are included in dependency arrays
2. Functions used in callbacks are defined later in the code
3. Stable function references don't need to be in dependency arrays

**Wrong**: Including mutable ref values in dependency arrays.

```typescript
useEffect(() => {
  previousPathRef.current = pathRef.current;
}, [pathRef.current]); // Refs don't trigger re-renders, making this unnecessary
```

**Correct**: Omit mutable refs and use eslint-disable for forward references.

```typescript
useEffect(() => {
  previousPathRef.current = pathRef.current;
}, []); // Empty array - runs once on mount

// For callbacks using functions defined later:
const handleStreamingResponse = useCallback(
  (data) => {
    // Uses reportMissingSourcesToBacked defined later
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [
    updateMessageState,
    // ... other deps
  ]
  // Note: reportMissingSourcesToBacked is defined after this callback
);
```

**Pattern**: For forward references (functions used before declaration), either:

1. Reorder code to define functions first, or
2. Use `eslint-disable-next-line react-hooks/exhaustive-deps` with a comment explaining why

**Additional Fixes**:

- Unescaped entities: Use `&apos;` instead of `'` in JSX text
- Next.js links: Use `<Link>` from `next/link` instead of `<a>` for internal navigation

### 26. Python Exception Chaining in Except Blocks

**Wrong**: Raising new exceptions in `except` blocks without proper chaining.

```python
try:
    result = json.loads(data)
except json.JSONDecodeError as e:
    raise ValueError(f"Invalid JSON: {e}")  # Loses original traceback
```

**Correct**: Use `raise ... from e` to chain exceptions and preserve traceback.

```python
try:
    result = json.loads(data)
except json.JSONDecodeError as e:
    raise ValueError(f"Invalid JSON: {e}") from e  # Preserves full traceback
```

**Pattern**: Always use exception chaining when re-raising exceptions to maintain full error context:

- Use `raise ... from e` when the original exception is relevant
- Use `raise ... from None` when you want to suppress the original exception (rare cases)

### 27. Rate Limiter Error Response Format Consistency

**Issue**: Rate limiter was sending `{ message: "..." }` but frontend expects `{ error: "..." }`, causing generic error
messages to be displayed instead of specific rate limit warnings.

**Wrong**: Mismatched error field names between backend and frontend.

```typescript
// Backend sends
res.status(429).json({ message: "Too many requests..." });

// Frontend expects
throw new Error(data.error || "Failed to fetch..."); // Falls back to generic message
```

**Correct**: Use consistent `error` field name across all API error responses.

```typescript
// Backend sends
res.status(429).json({ error: "Too many requests..." });

// Frontend handles properly
throw new Error(data.error || "Failed to fetch..."); // Shows specific rate limit message
```

**Pattern**: Always use `error` field for API error responses. Frontend typically uses
`data.error || "fallback message"` pattern. Ensure rate limiters, API endpoints, and other error sources use the `error`
field consistently.

**Verification**: Checked all frontend code - 24 instances of `data.error` and 13 instances of `errorData.error` found.
Zero instances of expecting `message` field for rate limit errors. All frontend code expects `error` field consistently.

**Additional Improvements**:

- Add specific 429 status code handling in frontend to show rate limit messages immediately
- Add JSON parsing error handling to catch malformed responses
- Rate limiter sends response inside the function, then returns false - frontend receives proper error message
- Add optional `message` field to `RateLimitConfig` to allow user-friendly error messages instead of exposing internal
  `name` field
- Default message is generic "Too many requests. Please wait a moment and try again." which avoids exposing internal
  implementation details

### 28. Hide Superuser-Only Features from Regular Admins

**Problem**: Admin navigation shows links to features that require superuser access (e.g., downvotes, newsletters).
Regular admins see these links but get 403 errors when clicking them, creating poor UX.

**Wrong**: Showing all admin links to all admins without role-based filtering.

```typescript
// AdminLayout shows all links to all admins
<Link href="/admin/downvotes">Review Downvotes</Link>
<Link href="/admin/newsletters">Newsletter Management</Link>
```

**Correct**: Fetch user role and conditionally render superuser-only links.

```typescript
// AdminLayout.tsx
const [isSuperuser, setIsSuperuser] = useState(false);

useEffect(() => {
  const fetchRole = async () => {
    if (!loginRequired) return;

    // Check cache first
    const cached = sessionStorage.getItem("userRole");
    if (cached) {
      const { role, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < 60 * 60 * 1000) {
        setIsSuperuser(role === "superuser");
        return;
      }
    }

    // Fetch from API
    const res = await fetch("/api/profile", { credentials: "include" });
    const data = await res.json();
    const role = (data?.role as string) || "user";
    setIsSuperuser(role === "superuser");

    // Cache result
    sessionStorage.setItem("userRole", JSON.stringify({ role, timestamp: Date.now() }));
  };

  fetchRole();
}, [loginRequired]);

// Conditionally render
{isSuperuser && <Link href="/admin/downvotes">Review Downvotes</Link>}
{loginRequired && isSuperuser && <Link href="/admin/newsletters">Newsletter Management</Link>}
```

**Pattern**: When features are restricted to superusers, fetch the user's role client-side (with sessionStorage caching)
and conditionally render UI elements. This prevents regular admins from seeing links they can't access, improving UX.

**Applied To**: AdminLayout navigation - hides downvotes and newsletters links for non-superuser admins.
