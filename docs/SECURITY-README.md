# Security Measures

## Token-Based Security System

This document outlines the implementation of the token-based security system for the Vercel backend and WordPress plugin
integration.

### Overview

The system uses JSON Web Tokens (JWT) to secure API communication between:

1. The web frontend and backend API
2. The WordPress plugin and backend API

### Security Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                      │
│                                                                                │
│ ┌──────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐ │
│ │   Web Client     │    │ WordPress Plugin│    │     Admin Client            │ │
│ │                  │    │                 │    │                             │ │
│ │ • JWT Tokens     │    │ • Site ID Check │    │ • Admin JWT                 │ │
│ │ • HttpOnly       │    │ • Secure API    │    │ • Elevated Permissions      │ │
│ │   Cookies        │    │   Client        │    │ • Sudo Mode                 │ │
│ │ • CSRF Protection│    │ • Token Exchange│    │                             │ │
│ └──────────────────┘    └─────────────────┘    └─────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
                                       │
                            ┌─────────────────────────┐
                            │     SECURITY GATEWAY    │
                            │                         │
                            │ • JWT Validation        │
                            │ • Rate Limiting (Redis) │
                            │ • CORS Policy           │
                            │ • Request Sanitization  │
                            │ • IP-based Blocking     │
                            └─────────────────────────┘
                                       │
┌───────────────────────────────────────────────────────────────────────────────┐
│                           AUTHENTICATION LAYER                                │
│                                                                               │
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐ │
│ │  JWT Service    │    │ Password Service│    │     Session Management      │ │
│ │                 │    │                 │    │                             │ │
│ │ • Token Issue   │    │ • bcrypt Hash   │    │ • Cookie Management         │ │
│ │ • Token Verify  │    │ • Salt Rounds   │    │ • Session Expiry            │ │
│ │ • Refresh Logic │    │ • Hash Compare  │    │ • Secure Flags              │ │
│ │ • Role Claims   │    │ • Complexity    │    │ • SameSite Policy           │ │
│ │                 │    │   Validation    │    │                             │ │
│ └─────────────────┘    └─────────────────┘    └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
┌───────────────────────────────────────────────────────────────────────────────┐
│                           AUTHORIZATION LAYER                                 │
│                                                                               │
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐ │
│ │ Access Control  │    │  API Protection │    │     Data Protection         │ │
│ │                 │    │                 │    │                             │ │
│ │ • Role-based    │    │ • Endpoint      │    │ • Access Level Filter       │ │
│ │   Permissions   │    │   Guards        │    │ • Kriyaban Content          │ │
│ │ • Admin Roles   │    │ • Method        │    │ • PII Encryption            │ │
│ │ • User Roles    │    │   Validation    │    │ • Data Anonymization        │ │
│ │ • Sudo Mode     │    │ • Input         │    │                             │ │
│ │ • Firestore     │    │   Sanitization  │    │                             │ │
│ │   Role Verify   │    │                 │    │                             │ │
│ │   (Source of    │    │                 │    │                             │ │
│ │    Truth)       │    │                 │    │                             │ │
│ └─────────────────┘    └─────────────────┘    └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
┌────────────────────────────────────────────────────────────────────────────────┐
│                             MONITORING LAYER                                   │
│                                                                                │
│ ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────────────┐ │
│ │ Security Logs   │    │  Threat Detection│    │     Incident Response       │ │
│ │                 │    │                  │    │                             │ │
│ │ • Auth Failures │    │ • Rate Limit     │    │ • Alert System              │ │
│ │ • Access Logs   │    │   Violations     │    │ • Auto-blocking             │ │
│ │ • Error Tracking│    │ • Suspicious     │    │ • Manual Review             │ │
│ │ • Audit Trail   │    │   Patterns       │    │ • Recovery Procedures       │ │
│ └─────────────────┘    └──────────────────┘    └─────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### Vercel Backend

- **Token Issuance Endpoint** (`/api/get-token`): Verifies shared secrets and issues JWT tokens
- **Web Token Endpoint** (`/api/web-token`): Securely generates tokens for web frontend
- **Protected API Endpoint** (`/api/secure-data`): Example endpoint that requires JWT authentication
- **JWT Utilities** (`utils/server/jwtUtils.ts`): Helper functions for token verification

#### Web Frontend

- **SecureDataFetcher Component**: React component demonstrating the secure API flow
- **API Demo Page**: Example page that showcases the secure token-based API integration
- **Token Manager** (`utils/client/tokenManager.ts`): Utility for obtaining and managing JWT tokens in the frontend

#### WordPress Plugin

- **Secure API Client** (`secure-api-client.php`): Handles token-based authentication for WordPress
- **Secure API Test Page**: Admin interface for testing the secure API connection
- **Site ID Validation**: Prevents accidental connections to wrong backend environments

### Authentication Types

The system supports two types of authentication which can be used independently or together:

1. **JWT Token Authentication**
   - **REQUIRED for ALL frontend-to-backend API calls without exception**
   - This includes login, logout, and all other API endpoints
   - Ensures only our frontend can access our backend APIs
   - JWT tokens are short-lived (15 minutes) and signed with the SECURE_TOKEN

2. **siteAuth Cookie Authentication**
   - Required only for logged-in user features
   - Managed by the login/logout system
   - Not required for public endpoints that still need frontend-to-backend security

#### Public JWT-Only Endpoints

Some endpoints require JWT authentication but not siteAuth cookies, such as:

- `/api/contact`: Allows contact form submissions from non-logged-in users
- `/api/answers/[id]`: Allows access to publicly shared answers
- `/api/login`: Handles user authentication (still requires JWT for frontend verification)
- `/api/logout`: Handles user logout (still requires JWT for frontend verification)

These endpoints use the `withJwtOnlyAuth` middleware which:

- Enforces JWT authentication for frontend-to-backend security
- Does not require the siteAuth cookie
- Applies common security checks (CSRF, rate limiting, etc.)

### Password Authentication System

The system supports optional password-based authentication alongside magic link authentication for sites with
`requireLogin: true`. This provides users with faster login options while maintaining security.

#### Authentication Methods

Users can authenticate using either method:

1. **Magic Link Authentication** (Default)
   - Email-based authentication with temporary tokens
   - No password required
   - Ideal for infrequent users
   - Always available as backup

2. **Password Authentication** (Optional)
   - Traditional email + password login
   - Faster for frequent users
   - Optional - users can choose to set or not set a password
   - bcrypt-hashed password storage

#### Password Security Implementation

**Password Storage**:

- Passwords are hashed using bcrypt with 10 salt rounds
- Stored in Firestore `users` collection as `passwordHash` field
- Never stored in plaintext
- `passwordSetAt` timestamp tracks when password was first set

**Password Requirements**:

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- Validated on both client and server side

**Password Management Endpoints**:

- `/api/auth/setPassword` - Set initial password (requires JWT Bearer token)
- `/api/auth/changePassword` - Change existing password (requires JWT Bearer token)
- `/api/auth/loginWithPassword` - Login with email + password (issues session cookie)
- `/api/auth/requestPasswordReset` - Request password reset link via email
- `/api/auth/resetPassword` - Reset password using email token
- `/api/auth/checkAuthMethod` - Check if user has password set (for login UI)

**Rate Limiting**:

- Password login: 5 attempts per 15 minutes per IP
- Password reset request: 3 attempts per hour per IP
- Change password: 5 attempts per 15 minutes per IP

**Security Features**:

- No user enumeration - reset requests always return success message
- Reset tokens are cryptographically secure (32-byte random)
- Reset tokens are bcrypt-hashed before storage
- Reset tokens expire after 1 hour
- Failed login attempts don't reveal whether email or password is incorrect

#### User Experience Flow

**Initial Account Activation**:

1. User receives activation email
2. Clicks link, verifies email, enters name
3. Redirected to `/choose-auth-method` interstitial
4. Can choose to set password or skip and use magic links

**Login Flow**:

1. User enters email on `/login`
2. System checks if user has password via `/api/auth/checkAuthMethod`
3. If password set: Shows password input with "Email me a Magic Login Link" option
4. If no password: Proceeds with magic link flow

**Password Promotion**:

- Dismissible banner shown to users without passwords after magic link login
- Banner links to settings page
- Once dismissed via `/api/profile` PATCH, never shown again
- Only shown on sites with `requireLogin: true`

**Settings Page**:

- Shows password status (set/not set with timestamp)
- "Set Password" button if no password
- "Change Password" button if password exists
- Validates password strength in real-time
- Show/hide toggles for all password fields

**Admin Visibility**:

- Admin user detail page shows if user has password set
- Shows `passwordSetAt` timestamp
- Never shows actual password or hash

#### Implementation Files

**Backend APIs**:

- `web/src/pages/api/auth/setPassword.ts`
- `web/src/pages/api/auth/changePassword.ts`
- `web/src/pages/api/auth/loginWithPassword.ts`
- `web/src/pages/api/auth/requestPasswordReset.ts`
- `web/src/pages/api/auth/resetPassword.ts`
- `web/src/pages/api/auth/checkAuthMethod.ts`

**Frontend Pages**:

- `web/src/pages/login.tsx` - Email-first login with dynamic password/magic link options
- `web/src/pages/settings.tsx` - Password management section
- `web/src/pages/set-password.tsx` - Standalone password setup page
- `web/src/pages/forgot-password.tsx` - Password reset request page
- `web/src/pages/reset-password.tsx` - Password reset with token page
- `web/src/pages/choose-auth-method.tsx` - Post-activation interstitial

**Components**:

- `web/src/components/PasswordPromoBanner.tsx` - Dismissible promotion banner
- `web/src/components/PasswordStrengthIndicator.tsx` - Real-time password validation

**Utilities**:

- `web/src/utils/server/passwordUtils.ts` - Password hashing, comparison, validation
- `web/src/utils/server/passwordResetUtils.ts` - Reset token generation, email sending

**Types**:

- `web/src/types/user.ts` - Extended with `hasPassword`, `passwordSetAt`, `dismissedPasswordPromo`, `PasswordValidation`

#### Site Configuration

Password authentication is only available on sites with `requireLogin: true` in `site-config/config.json`.

All password-related endpoints check `siteConfig?.requireLogin` and return 403 if not enabled.

### Domain Whitelist Configuration

The system supports domain-based whitelisting to streamline user onboarding for trusted organizations. Users from
whitelisted email domains can skip admin approval and password verification, while still requiring activation email
verification.

#### How It Works

When a user attempts to sign up or log in:

1. **Domain Check**: System extracts the email domain (e.g., `user@ananda.org` → `ananda.org`)
2. **Whitelist Lookup**: Checks if domain exists in site-specific whitelist file
3. **Automatic User Creation**: If whitelisted, creates user with `inviteStatus: "pending"` immediately
4. **Activation Email**: Sends activation email (same as normal flow, 14-day expiry)
5. **Skip Approval**: Bypasses admin approval request and password requirement

#### File Configuration

Whitelist files are stored in `web/site-config/` with environment-specific naming:

- **Development**: `dev-{siteId}-whitelist.json` (e.g., `dev-ananda-whitelist.json`)
- **Production**: `{siteId}-whitelist.json` (e.g., `ananda-whitelist.json`)

**File Format**:

```json
["ananda.org", "expandinglight.org", "anandavillage.org"]
```

#### Implementation Details

**Utilities**:

- `web/src/utils/server/domainWhitelistUtils.ts` - Whitelist loading and checking functions
  - `loadDomainWhitelist(siteId: string)` - Loads whitelist file based on environment
  - `isEmailDomainWhitelisted(email: string, siteId: string)` - Checks if email domain is whitelisted

**API Endpoints Using Whitelist**:

- `/api/auth/requestLoginLink` - Checks whitelist when user not found
- `/api/auth/verifyAccess` - Skips password requirement for whitelisted domains
- `/api/admin/requestApproval` - Bypasses admin approval for whitelisted domains

**User Experience**:

- Whitelisted users see notification: "Your email domain is approved. We're sending you an activation email
  immediately."
- Users still complete activation email verification (security requirement)
- No password required during initial signup flow
- Normal activation flow applies after email verification

#### Security Considerations

- **Email Verification Still Required**: Whitelisted domains skip admin approval but still require activation email
  verification
- **Audit Logging**: All whitelist-based user creation is logged with `outcome: "created_pending_user_whitelisted"` or
  `"resent_pending_activation_whitelisted"`
- **Case-Insensitive Matching**: Domain comparison is case-insensitive for reliability
- **Graceful Fallback**: If whitelist file is missing or invalid, system falls back to normal approval flow
- **Environment Separation**: Development and production use separate whitelist files for isolation

#### Maintenance

- Add domains to whitelist files as needed for trusted organizations
- Keep production whitelist minimal - only add domains for organizations with established trust
- Use development whitelist for testing with test domains (e.g., `gmail.com` for development)
- Whitelist files are JSON arrays - validate syntax before committing changes

### Best Practices for JWT Implementation

#### Frontend Implementation

- **Always use JWT tokens**: All API calls from the frontend to backend must include a valid JWT token in the
  Authorization header
- **Use helper functions**: Prefer using the helper functions (`fetchWithAuth`, `withAuth`, `queryFetch`) over manually
  adding tokens
- **Avoid duplication**: Don't duplicate token fetching and header construction logic across the codebase
- **Consistent approach**: Use the provided utilities in `tokenManager.ts` and `reactQueryConfig.ts`
- **Handle token errors**: Let the helper functions handle token failures and retries

#### Correct Usage Examples

```typescript
// Example 1: PREFERRED - Using fetchWithAuth (simplest approach)
import { fetchWithAuth } from "@/utils/client/tokenManager";

async function makeApiCall() {
  const response = await fetchWithAuth("/api/endpoint", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: "example" }),
  });
}

// Example 2: Using withAuth helper for custom fetch scenarios
import { withAuth } from "@/utils/client/tokenManager";

async function makeCustomApiCall() {
  const options = await withAuth({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const response = await fetch("/api/endpoint", options);
}

// Example 3: Using queryFetch for React Query
import { queryFetch } from "@/utils/client/reactQueryConfig";

async function makeQueryApiCall() {
  const response = await queryFetch("/api/endpoint", {
    method: "POST",
    body: JSON.stringify({ data: "example" }),
  });
}

// Example 4: NOT RECOMMENDED - Manual token handling
import { getToken } from "@/utils/client/tokenManager";

async function manualTokenHandling() {
  // Avoid this approach - it duplicates logic and is error-prone
  const token = await getToken();
  const response = await fetch("/api/endpoint", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
```

### Configuration

#### Environment Variables

The system reuses existing environment variables:

- `SECURE_TOKEN`: Used for JWT signing and web frontend authentication
- `SECURE_TOKEN_HASH`: Used to validate token integrity

No new variables are required, which simplifies security management.

#### WordPress Integration

For WordPress integration, you have two options in wp-config.php:

1. Direct secret (less secure):

   ```php
   define('WP_API_SECRET', 'your-secret-here');
   ```

2. Using Vercel token (recommended):

   ```php
   define('CHATBOT_BACKEND_SECURE_TOKEN', 'your-secure-token-value');
   ```

Option 2 is recommended as it automatically derives the WordPress token from the same SECURE_TOKEN used in the Vercel
backend.

#### Site ID Validation

The system includes site ID validation to prevent accidental connections to the wrong backend environment:

1. **WordPress Plugin Configuration**:
   - Each WordPress installation specifies an expected site ID (defaults to "ananda-public")
   - This is configurable in the plugin settings page
   - The setting is stored in WordPress options as `aichatbot_expected_site_id`

2. **Token Request Process**:
   - The WordPress plugin sends the expected site ID with each token request
   - The backend checks if this ID matches its actual SITE_ID environment variable
   - If there's a mismatch, the backend returns a clear error message

3. **Error Handling**:
   - Site mismatch errors include specific information about which site was expected vs. actual
   - The WordPress admin interface shows a user-friendly error with instructions on how to fix it

This feature prevents common development errors when multiple environments exist (staging, production, etc.) and helps
users quickly identify and fix configuration issues.

#### Setup Instructions

1. **Vercel Project**:
   - Ensure SECURE_TOKEN and SECURE_TOKEN_HASH are set in your environment variables
   - Set the SITE_ID environment variable to uniquely identify your site/environment
   - No additional environment variables needed

2. **WordPress Plugin**:
   - Add `define('CHATBOT_BACKEND_SECURE_TOKEN', 'your-secure-token-value');` to `wp-config.php`
   - The value should match the SECURE_TOKEN in your Vercel project
   - Configure the Expected Site ID in the plugin settings to match your target environment
   - Activate the plugin in WordPress admin

### Security Considerations

- Uses the same SECURE_TOKEN already proven secure in your login system
- JWT tokens are set to expire after 15 minutes
- For WordPress integration, a derived token is created using a WordPress-specific salt
- Communication happens over HTTPS

### API Flow

1. Client requests a token from the server with the appropriate secret
2. Server validates the secret and issues a short-lived JWT
3. Client includes the JWT in the Authorization header for API requests
4. Server verifies the JWT before processing protected API requests

#### WordPress Authentication Flow

1. WordPress plugin reads the configured `aichatbot_expected_site_id` and `ANANDA_WP_API_SECRET`
2. Plugin sends both values to the `/api/get-token` endpoint on the configured Vercel backend
3. Backend validates:
   - That the site ID matches its own SITE_ID environment variable
   - That the secret matches either the direct SECURE_TOKEN or the WordPress-specific derived token
4. If validation passes, a JWT token is issued; otherwise, an appropriate error is returned
5. The plugin uses the JWT token for subsequent API calls until it expires

#### Special Case: Public JWT-Only Endpoints

For public endpoints that need API security but not user login:

1. Client requests a token from `/api/web-token` with the appropriate referer header
2. Server identifies the request is for a public endpoint and issues a JWT without checking siteAuth
3. Client includes the JWT in API requests to the public endpoint
4. Server verifies the JWT using the `withJwtOnlyAuth` middleware

### Testing

- Use the WordPress admin "Secure API Test" page to test the WordPress integration
- Visit the `/api-demo` page to test the web frontend integration

### JWT Authentication Implementation

This project implements JWT authentication for secure API access. This document outlines the key components and patterns
used.

#### Core Components

##### Server-Side

- **JWT Middleware**: `/utils/server/jwtUtils.ts` provides the `withJwtAuth` HOC to secure API endpoints.
- **JWT-Only Middleware**: `/utils/server/apiMiddleware.ts` provides the `withJwtOnlyAuth` HOC for public endpoints.
- **Secured Endpoints**: All API endpoints in `/pages/api/` are protected with appropriate JWT authentication.

##### Client-Side

- **Token Manager**: `/utils/client/tokenManager.ts` manages JWT token lifecycle and includes them in requests.
- **React Query Configuration**: `/utils/client/reactQueryConfig.ts` includes JWT handling for all API requests.
- **Auth Hooks**:
  - `useAnswers`: Fetches paginated answers with authentication
  - `useVote`: Handles voting on messages

#### How It Works

1. **Authentication Flow**:
   - JWTs are issued upon login/authentication or for public endpoint access
   - Tokens are stored securely in memory and included with each API request
   - Protected API routes validate tokens before processing requests

2. **Data Fetching Pattern**:
   - React Query handles all data fetching, caching, and error handling
   - The custom `queryFetch` function automatically adds authentication headers
   - Hooks provide a clean API for components

3. **Error Handling**:
   - Auth errors (401/403) are caught and handled appropriately
   - The system provides feedback for authentication failures

#### Using the Auth System

##### Securing API Routes

For routes that require both JWT and siteAuth (logged-in users):

```typescript
import { withJwtAuth } from "@/utils/server/jwtUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Your implementation here
}

export default withJwtAuth(handler);
```

For public routes that require JWT but not siteAuth:

```typescript
import { withJwtOnlyAuth } from "@/utils/server/apiMiddleware";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Your implementation here
}

export default withJwtOnlyAuth(handler);
```

##### Using Data Hooks in Components

```typescript
// Example of using hooks in a component
import { useAnswers } from "@/hooks";

function MyComponent() {
  // Fetch data with authentication
  const { data, isLoading } = useAnswers(1, "mostRecent");

  // Handle voting
  const voteMutation = useVote();

  const handleVote = (answerId, voteType) => {
    voteMutation.mutate({ answerId, voteType });
  };

  // Rest of component...
}
```

#### JWT Auth Security Considerations

- JWTs are signed with a secret key to prevent tampering
- Tokens have a limited lifespan to reduce risk from token theft
- API endpoints verify token validity before processing requests
- The system implements rate limiting to prevent abuse
- Public JWT-only endpoints still require valid JWT tokens

#### Role Verification from Firestore (Source of Truth)

For sensitive operations, the system verifies user roles directly from Firestore rather than relying solely on JWT
tokens. This ensures that role changes (e.g., admin demoted to user) take effect immediately rather than waiting for JWT
expiration.

**Why Firestore Verification?**

JWT tokens contain role information at the time of issuance. If a user's role is changed in Firestore (the source of
truth), the JWT token still contains the old role until it expires (up to 24 hours). This creates a security window
where:

1. User logs in as admin → receives JWT with `role: "admin"`
2. Superuser demotes them to `user` in Firestore
3. Client still has old JWT with `role: "admin"` until expiration
4. Client could potentially access admin endpoints until token expires

**Implementation**

The system provides two verification functions in `utils/server/authz.ts`:

- `requireAdminRoleFromFirestore(req)`: Verifies admin or superuser role from Firestore
- `requireSuperuserRoleFromFirestore(req)`: Verifies superuser role from Firestore

These functions:

1. Extract email from JWT token (cookie or Authorization header)
2. Fetch user document from Firestore
3. Read role from Firestore (source of truth)
4. Throw error if role is insufficient
5. Fall back to JWT role if Firestore lookup fails (defensive programming)

**Endpoints Using Firestore Verification**

Sensitive operations that require Firestore role verification:

**Newsletter Management** (superuser only):

- `/api/admin/sendNewsletter` - Send newsletters to subscribers
- `/api/admin/deleteNewsletterQueue` - Delete newsletter queue items
- `/api/admin/processNewsletterBatch` - Process newsletter batches
- `/api/admin/newsletters` - List newsletters
- `/api/admin/newsletters/[id]` - Get newsletter details
- `/api/admin/newsletters/history` - Get newsletter history

**User Management** (admin or superuser):

- `/api/admin/addUser` - Add new users
- `/api/admin/resendActivation` - Resend activation emails
- `/api/admin/listPendingUsers` - List pending users
- `/api/admin/pendingUsersCount` - Get pending user count
- `/api/admin/pendingRequests` - Manage approval requests

**Usage Pattern**

```typescript
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Verify superuser role from Firestore (source of truth)
    await requireSuperuserRoleFromFirestore(req);

    // Proceed with sensitive operation
    // ...
  } catch (error: any) {
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({ error: "Forbidden: Superuser privileges required" });
    }
    throw error;
  }
}
```

**Security Benefits**

- **Immediate Effect**: Role changes take effect immediately, not after JWT expiration
- **Source of Truth**: Firestore is the authoritative source for user roles
- **Defense in Depth**: Falls back to JWT verification if Firestore lookup fails
- **Audit Trail**: All role checks are logged for security monitoring
- **Prevents Privilege Escalation**: Compromised admin accounts cannot access superuser endpoints

**Performance Considerations**

- Firestore lookups add ~50-100ms latency per request
- Acceptable trade-off for sensitive operations
- Non-sensitive endpoints continue using JWT-only verification for performance

## Cron Job Security

Cron-invoked endpoints use a hybrid authentication pattern that supports both Vercel cron requests (with CRON_SECRET)
and manual admin access (with JWT tokens). This provides flexibility while maintaining security.

### Hybrid Authentication Pattern

The `withJwtOrCronAuth` middleware provides dual authentication support:

```typescript
/**
 * Middleware that allows either JWT authentication or Vercel cron requests
 * @param handler The API route handler to wrap
 * @returns A wrapped handler that checks for either valid JWT or Vercel cron
 */
function withJwtOrCronAuth(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const userAgent = req.headers["user-agent"] || "";
    const isVercelCron = userAgent.startsWith("vercel-cron/");
    const authHeader = req.headers.authorization || "";

    if (isVercelCron) {
      // Verify that cron requests provide the correct secret
      if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      // Allow authorized Vercel cron requests through
      return handler(req, res);
    } else {
      // For all other requests, require JWT authentication
      return withJwtAuth(handler)(req, res);
    }
  };
}
```

### Implementation Pattern

Cron endpoints use this pattern with API middleware:

```typescript
// Apply API middleware, skipping its default auth check and relying solely on withJwtOrCronAuth
export default withApiMiddleware(withJwtOrCronAuth(handler), {
  skipAuth: true,
});
```

### Security Validation

The system validates requests using two criteria:

1. **Vercel Cron Detection**: Checks for `vercel-cron/` user-agent prefix
2. **Secret Validation**: Verifies `CRON_SECRET` in Authorization header

This dual validation ensures that only legitimate Vercel cron jobs can bypass JWT authentication.

### Endpoints using Hybrid Authentication

- `/api/admin/digestSelfProvision` (daily digest of self-provision attempts)

### Additional Safeguards

- Apply `genericRateLimiter` with conservative limits for cron endpoints (defense in depth)
- Log failures for visibility (401s, rate-limit triggers, unexpected errors)
- User-agent validation prevents spoofing attempts
- Manual admin access still requires valid JWT tokens

### Vercel Configuration

- Set `CRON_SECRET` in the project environment variables
- Vercel automatically provides the correct user-agent header (`vercel-cron/1.0`)
- Cron jobs automatically include the Authorization header:

```http
Authorization: Bearer ${CRON_SECRET}
User-Agent: vercel-cron/1.0
```

### Benefits

- **Flexibility**: Admins can manually trigger cron endpoints during development/debugging
- **Security**: Vercel cron jobs bypass JWT requirements while maintaining secret validation
- **Auditability**: All access is logged and can be traced back to either cron or admin users
- **Consistency**: Uses the same middleware patterns as other protected endpoints

This hybrid approach provides the best of both worlds: automated cron execution with CRON_SECRET validation, and manual
admin access with full JWT authentication.

---

## Security Best Practices

This section outlines security best practices implemented across the codebase and recommendations for maintaining
security.

### CORS Configuration Best Practices

#### Credentials and Origin Verification

**Critical Rule**: Never set `Access-Control-Allow-Credentials: true` without verifying the origin.

**Why**: Setting credentials with a wildcard origin (`*`) allows any website to make authenticated requests, leading to
credential leakage.

**Implementation**:

```typescript
// ✅ CORRECT: Verify origin before setting credentials
if (origin && isAllowedOrigin(origin, allowedDomains)) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

// ❌ WRONG: Setting credentials with wildcard
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Credentials", "true"); // DANGEROUS!
```

**Best Practices**:

- Always verify origin against an allowlist before setting credentials
- Use specific origins, never wildcards (`*`) when credentials are enabled
- In development, only set credentials when origin is present (not null)
- Log rejected origins for security monitoring

### Error Handling Best Practices

#### Preventing Information Leakage

**Critical Rule**: Never expose sensitive information in error messages sent to clients.

**Sensitive Information Includes**:

- API keys and tokens (Pinecone, OpenAI, AWS, etc.)
- Database connection strings
- Internal file paths
- Stack traces
- System architecture details

**Implementation Pattern**:

```typescript
import { getSafeErrorMessage, sanitizeErrorForLogging } from "@/utils/server/errorSanitization";

try {
  // ... operation ...
} catch (error: any) {
  // ✅ CORRECT: Sanitize error for logging (prevents API key leakage in logs)
  const sanitizedError = sanitizeErrorForLogging(error);
  console.error("Operation failed:", sanitizedError);

  // ✅ CORRECT: Return safe error message to client
  const safeMessage = getSafeErrorMessage(error, "Operation failed. Please try again later.");
  return res.status(500).json({ error: safeMessage });

  // ❌ WRONG: Exposing raw error messages
  // return res.status(500).json({ error: error.message }); // May contain API keys!
}
```

**Best Practices**:

- Use `getSafeErrorMessage()` for all user-facing error messages
- Use `sanitizeErrorForLogging()` for server-side logging
- Never include `error.stack` in production responses
- Never include `error.details` with raw error messages
- Log full error details server-side for debugging, but sanitize sensitive patterns

#### Error Response Structure

**Consistent Pattern**:

```typescript
// ✅ CORRECT: Simple error response
return res.status(500).json({ error: safeMessage });

// ❌ WRONG: Including details field
return res.status(500).json({
  error: "Operation failed",
  details: error.message, // May contain sensitive info!
});
```

### Input Validation and Sanitization Best Practices

#### Comprehensive Input Validation

**Critical Rule**: Validate and sanitize all user inputs before processing.

**Implementation Pattern**:

```typescript
import { sanitizeEmail, sanitizeTextInput, validateAndSanitizeQuestion } from "@/utils/server/inputSanitization";

// ✅ CORRECT: Comprehensive email validation
let sanitizedEmail: string;
try {
  sanitizedEmail = sanitizeEmail(email, 254);
} catch (error: any) {
  return res.status(400).json({
    error: `Invalid email: ${error.message || "Email validation failed"}`,
  });
}

// ✅ CORRECT: Text input sanitization with options
let sanitizedName: string;
try {
  sanitizedName = sanitizeTextInput(name, {
    maxLength: 100,
    allowNewlines: false,
    allowSpecialChars: false,
  });
} catch (error: any) {
  return res.status(400).json({
    error: `Invalid input: ${error.message || "Input validation failed"}`,
  });
}
```

**Best Practices**:

- Always validate input type before processing (`typeof input === "string"`)
- Use centralized sanitization utilities (`inputSanitization.ts`)
- Set appropriate length limits based on use case
- Prevent XSS by stripping HTML/script tags
- Prevent injection attacks by sanitizing special characters
- Validate UTF-8 encoding for international characters
- Prevent email header injection by sanitizing newlines

### Subprocess Execution Best Practices

#### Preventing Command Injection in Python Scripts

**Critical Rule**: Never use `shell=True` with variable interpolation in subprocess calls. This creates critical command
injection vulnerabilities (RCE - Remote Code Execution).

**Why**: When `shell=True` is used with string interpolation, user-controlled or external data can be injected into
shell commands, allowing attackers to execute arbitrary commands.

**Implementation Pattern**:

```python
import subprocess
import shlex

# ❌ WRONG: Command injection vulnerability
username = user_input  # Could be "admin; rm -rf /"
subprocess.run(f"mysql -u {username} -p", shell=True)  # DANGEROUS!

# ✅ CORRECT: List-based subprocess call (no shell)
subprocess.run(["mysql", "-u", username, "-p", db_name], shell=False)

# ✅ CORRECT: For command strings, use shlex.split() to safely parse
cmd_string = f"vercel ls {project}"
cmd_list = shlex.split(cmd_string) if isinstance(cmd_string, str) else cmd_string
subprocess.run(cmd_list, shell=False)

# ✅ CORRECT: For file redirection, use stdin parameter
with open(sql_file, encoding="utf-8") as f:
    subprocess.run(["mysql", "-u", username, "-p", db_name], stdin=f, text=True, check=True)
```

**Best Practices**:

- **Always use `shell=False`**: Prevents shell interpretation of special characters
- **Use list form for subprocess calls**: `subprocess.run(["command", "arg1", "arg2"], shell=False)`
- **For command strings**: Use `shlex.split()` to safely parse command strings into lists
- **For file redirection**: Use `stdin` parameter instead of shell redirection (`<`, `>`)
- **For pipes**: Use `subprocess.Popen` with proper argument lists, not shell pipes
- **Never interpolate variables into shell strings**: Always use list form with separate arguments
- **Validate inputs**: Even with `shell=False`, validate inputs before passing to subprocess

**Verification**:

- Run `grep -r "shell=True" --include="*.py"` - should return zero results
- Review all subprocess calls to ensure they use list form
- Test with malicious inputs (e.g., `"; rm -rf /"`) to verify injection prevention

**Files Fixed**:

- `data_ingestion/sql_to_vector_db/process_anandalib_dump.py` - Converted MySQL commands to list form
- `bin/cancel-other-deployments.py` - Added `shlex.split()` for safe command parsing

### Rate Limiting Best Practices

#### Consistent Rate Limiting

**Critical Rule**: Apply rate limiting to all public-facing endpoints.

**Implementation Pattern**:

```typescript
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ✅ CORRECT: Apply rate limiting early in handler
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "endpoint_name",
  });
  if (!allowed) return; // Rate limiter sends response automatically

  // ... rest of handler ...
}
```

**Best Practices**:

- Apply rate limiting before any expensive operations
- Use descriptive `name` parameter for monitoring
- Set appropriate limits based on endpoint sensitivity:
  - Public endpoints: 30-100 requests/minute
  - Authentication endpoints: 5-10 requests/15 minutes
  - Admin endpoints: 30-100 requests/minute
- Monitor rate limit violations for abuse patterns
- Use IP-based limiting for DDoS protection

### Authorization Best Practices

#### Firestore as Source of Truth

**Critical Rule**: For sensitive operations, verify roles from Firestore, not just JWT.

**Why**: JWT tokens can become stale if a user's role is changed server-side. The token still contains the old role
until it expires.

**Implementation Pattern**:

```typescript
import { requireSuperuserRoleFromFirestore, requireAdminRoleFromFirestore } from "@/utils/server/authz";

// ✅ CORRECT: Verify role from Firestore for sensitive operations
try {
  await requireSuperuserRoleFromFirestore(req);
} catch (error: any) {
  if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
    return res.status(403).json({ error: "Forbidden: Superuser privileges required" });
  }
  throw error;
}

// ❌ WRONG: Only checking JWT role (can be stale)
if (token.role !== "superuser") {
  return res.status(403).json({ error: "Forbidden" });
}
```

**Best Practices**:

- Use `requireSuperuserRoleFromFirestore()` for high-privilege operations (newsletter sending, user deletion)
- Use `requireAdminRoleFromFirestore()` for admin operations (user management, approval requests)
- Always handle authorization errors explicitly
- Return consistent 403 status codes for authorization failures
- Log authorization failures for security monitoring

### IP Address Handling Best Practices

#### Proper IP Extraction and Sanitization

**Critical Rule**: Properly extract and sanitize IP addresses, especially for IPv6 and proxy environments.

**Implementation Pattern**:

```typescript
import { getClientIp } from "@/utils/server/ipUtils";

// ✅ CORRECT: Use centralized IP extraction utility
const clientIP = getClientIp(req) || "unknown";

// ✅ CORRECT: Sanitize IP for Firestore document IDs (IPv6 support)
const sanitizedIP = clientIP.replace(/[:./]/g, "_");
const docId = `${sanitizedIP}_${name}`;
```

**Best Practices**:

- Use `getClientIp()` utility for consistent IP extraction
- Handle proxy headers (`x-forwarded-for`, `cf-connecting-ip`, `x-real-ip`)
- Support both IPv4 and IPv6 addresses
- Sanitize IPs before using in Firestore document IDs (replace `:`, `.`, `/` with `_`)
- Validate IP format before using in security contexts

### Security Monitoring Best Practices

#### Logging Security Events

**Best Practices**:

- Log all authentication failures with IP addresses
- Log rate limit violations for abuse detection
- Log authorization failures (403 responses)
- Use sanitized error logging to prevent credential leakage
- Include request context (endpoint, method, timestamp) in security logs
- Monitor for unusual access patterns

**Implementation Pattern**:

```typescript
// ✅ CORRECT: Log security events with context
console.error("Authorization failure:", {
  endpoint: "/api/admin/users",
  ip: getClientIp(req),
  userEmail: token?.email,
  timestamp: new Date().toISOString(),
});

// ❌ WRONG: Logging raw errors (may contain sensitive data)
console.error("Error:", error); // May contain API keys!
```

### Development vs Production Security

#### Environment-Specific Security

**Best Practices**:

- Development: More permissive CORS, detailed error messages for debugging
- Production: Strict CORS, sanitized error messages, comprehensive logging
- Use `isDevelopment()` utility to conditionally apply security measures
- Never disable security features in production for convenience
- Test security measures in staging environment before production

**Implementation Pattern**:

```typescript
import { isDevelopment } from "@/utils/env";

if (isDevelopment()) {
  // Development: More permissive
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
} else {
  // Production: Strict verification
  if (origin && isAllowedOrigin(origin, allowedDomains)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
}
```

### SSRF Protection Best Practices

#### Server-Side Request Forgery Prevention

**Critical Rule**: Always validate URLs before making server-side HTTP requests to prevent SSRF attacks.

**Why**: SSRF attacks allow attackers to make the server request arbitrary URLs, potentially accessing internal
services, cloud metadata endpoints, or external resources.

**Implementation Pattern**:

```typescript
import { safeFetch, validateUrlForSSRF } from "@/utils/server/ssrfProtection";

// ✅ CORRECT: Use safeFetch for all external requests
const response = await safeFetch(url, {
  method: "GET",
  headers: { "User-Agent": "AnandaBot/1.0" },
});

// ✅ CORRECT: Validate URLs before constructing fetch calls
const validation = validateUrlForSSRF(userProvidedUrl);
if (!validation.isValid) {
  return res.status(400).json({ error: validation.error });
}
```

**Features**:

- **Domain Whitelist**: Only pre-approved domains can be accessed
- **Private IP Blocking**: Blocks access to private/internal IP ranges (10.x.x.x, 192.168.x.x, etc.)
- **Protocol Validation**: Only HTTP and HTTPS protocols allowed
- **IP Address Protection**: IP addresses must be explicitly whitelisted
- **Configurable Domains**: Additional domains via `SSRF_ALLOWED_DOMAINS` environment variable

**Default Allowed Domains**:

- `maps.googleapis.com` - Google Maps API
- `www.googleapis.com` - Google APIs
- `www.google-analytics.com` - Google Analytics
- `analytics.google.com` - Google Analytics

**Adding Custom Domains**:

Set `SSRF_ALLOWED_DOMAINS` environment variable (comma-separated):

```bash
SSRF_ALLOWED_DOMAINS=api.example.com,cdn.example.com
```

**Best Practices**:

- Always use `safeFetch()` instead of raw `fetch()` for external URLs
- Validate URLs from environment variables before use
- Log blocked SSRF attempts for security monitoring
- Never trust user-provided URLs without validation
- Use domain whitelist approach, not blacklist

**Applied To**:

- `/api/cron/download-locations` - Location data downloads
- Google Maps API calls in location services
- All external HTTP/HTTPS requests

### Content Security Policy (CSP) Best Practices

#### CSP Configuration

**Current Implementation**: CSP headers with nonce support and tightened directives.

**Key Features**:

- **Nonce Support**: Generated nonces for inline scripts (Next.js compatible)
- **Tightened connect-src**: Only specific domains allowed for API calls
- **Upgrade Insecure Requests**: Forces HTTPS for all resources
- **Strict Default Policy**: `default-src 'self'` as baseline

**CSP Directives**:

```typescript
// Current CSP configuration
default-src 'self';
script-src 'self' 'nonce-{nonce}' 'unsafe-inline' 'unsafe-eval' ...;
connect-src 'self' https://www.google-analytics.com ...;
style-src 'self' 'unsafe-inline' ...;
```

**Why `unsafe-inline` and `unsafe-eval`**:

- **`unsafe-inline`**: Required for Tailwind CSS and CSS-in-JS libraries
- **`unsafe-eval`**: Required for Next.js development mode and some React features
- Nonces are used where possible to reduce reliance on `unsafe-inline`

**Tightened `connect-src`**:

Only allows connections to:

- `'self'` - Same origin
- `https://www.google-analytics.com` - Analytics
- `https://analytics.google.com` - Analytics
- `https://*.google-analytics.com` - Analytics subdomains
- `https://maps.googleapis.com` - Google Maps API
- `https://www.googleapis.com` - Google APIs

**Best Practices**:

- Review CSP violations in browser console regularly
- Add specific domains to `connect-src` as needed (not wildcards)
- Use nonces for inline scripts when possible
- Monitor CSP reports for security issues
- Test CSP changes in staging before production

**Future Improvements**:

- Consider removing `unsafe-eval` in production builds (if Next.js allows)
- Use strict-dynamic for script-src when possible
- Implement CSP reporting endpoint for violation monitoring

### Security Checklist for New Endpoints

When creating a new API endpoint, ensure:

- [ ] **Rate Limiting**: Applied with appropriate limits
- [ ] **Input Validation**: All inputs validated and sanitized
- [ ] **Authorization**: Proper role checks (Firestore verification for sensitive ops)
- [ ] **Error Handling**: Safe error messages (no sensitive info leakage)
- [ ] **CORS**: Credentials only set when origin is verified
- [ ] **SSRF Protection**: Use `safeFetch()` for all external requests
- [ ] **Logging**: Security events logged with context
- [ ] **IP Handling**: Proper IP extraction and sanitization
- [ ] **Testing**: Security tests included in test suite

### Security Review Process

**Before Deployment**:

1. Review all error messages for sensitive information
2. Verify CORS configuration (no wildcard with credentials)
3. Check rate limiting is applied to all public endpoints
4. Verify authorization checks use Firestore for sensitive operations
5. Review input validation and sanitization
6. Check security logs for any anomalies
7. Run security test suite

**Regular Maintenance**:

- Review security logs weekly
- Update rate limits based on usage patterns
- Review and update CORS allowlists quarterly
- Audit authorization checks annually
- Update dependencies for security patches
- Review error handling patterns for new vulnerabilities
- Review and update SSRF domain whitelist as needed
