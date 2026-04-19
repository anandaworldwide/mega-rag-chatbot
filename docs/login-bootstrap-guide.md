# Login Bootstrap Superuser Guide

## Overview

This guide covers creating the initial superuser account for sites that require user authentication. **This process is
only needed if your site has login requirements enabled.**

> **Note**: If your site allows anonymous access without user login, you can skip this entire bootstrap process.

## When Bootstrap is Required

Bootstrap a superuser account only if:

- ✅ Your site configuration requires user authentication
- ✅ You need admin access to manage users and view analytics
- ✅ You want to control who can access the chatbot

If your site allows public access without login, this bootstrap process is unnecessary.

## Prerequisites

Before bootstrapping, ensure your development environment is properly configured with:

- Environment files (`.env.<site>`) with Firebase credentials
- Firestore database access
- Node.js 20+ with npm/tsx installed

_Refer to the main setup documentation for environment configuration details._

## Bootstrap Process

### 1. Run the Bootstrap Script

Use the bootstrap script to create your first superuser account:

```bash
cd web
npx tsx scripts/bootstrap-superuser.ts --site <site> --env <dev|prod> --email <email>
```

### 2. Command Parameters

- **`--site`** (required): Site configuration (`ananda`, `crystal`, `jairam`, `ananda-public`)
- **`--env`** (optional): Target environment - `dev` or `prod` (defaults to `dev`)
- **`--email`** (optional): Superuser email address (prompts if not provided)

### 3. Examples

```bash
# Interactive mode - prompts for environment and email
npx tsx scripts/bootstrap-superuser.ts --site ananda

# Non-interactive mode - all parameters provided
npx tsx scripts/bootstrap-superuser.ts --site ananda --env prod --email admin@example.com

# Development environment
npx tsx scripts/bootstrap-superuser.ts --site crystal --env dev --email dev-admin@example.com
```

### 4. Success Confirmation

The script will output:

```text
Loaded environment from /path/to/.env.ananda
Created superuser: admin@example.com in prod_users
Done.
```

## What the Bootstrap Creates

The superuser account is created with these properties:

```typescript
{
  email: "admin@example.com",
  role: "superuser",
  entitlements: { basic: true },
  inviteStatus: "accepted",
  verifiedAt: Timestamp.now(),
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now()
}
```

## User Collections

Bootstrap creates users in environment-specific Firestore collections:

- **Development**: `dev_users`
- **Production**: `prod_users`

## Role Hierarchy

The system supports three role levels:

1. **`user`**: Basic chat access
2. **`admin`**: User management and analytics access
3. **`superuser`**: Full system access, can grant admin privileges

## After Bootstrap

Once your superuser is created:

### 1. Test Login

1. Navigate to your application's login page
2. Enter the superuser email to request a magic login link
3. Check your email and click the login link
4. Verify you can access the admin dashboard at `/admin`

### 2. Create Additional Users

From the admin dashboard:

1. Go to **Admin Dashboard** → **Users**
2. Click **Add User** to invite new users
3. Assign appropriate roles (`admin` or `user`)

## Blocking Users (Email Blacklist)

Superusers can block specific email addresses from all authentication and admin-invite flows on a per-site basis.

### Accessing the Blacklist Editor

1. Go to **Admin Dashboard** → **Email Blacklist** (visible only to superusers on sites with `requireLogin: true`)
2. Edit the plain-text list: one email per line, `#` for comments, blank lines allowed
3. Save — changes propagate within ~60 seconds across serverless instances

### What It Blocks

- **Self-service auth**: password login, magic-link request, magic-link verify, activation links, and new-user access requests all return `403 Access denied. Please contact your administrator.`
- **Admin-driven flows**: adding users, resending invites, approving pending requests, and changing a user's email all return `Email is blacklisted` to the admin.
- **Active sessions**: every JWT-authenticated API call re-checks the blacklist. Blacklisted users are booted mid-session — auth cookies are cleared and the client is redirected to `/login?reason=revoked`.

### Storage & Safety

- Stored as a plain-text file in S3 at `site-config/{dev|prod}/blacklist/{SITE_ID}.txt`. You can edit directly in S3 in a pinch; the cache refreshes within 60 seconds.
- Server validates each line is a well-formed email before saving; invalid lines are reported back with line numbers.
- Self-blacklist guard: the editor rejects any save that would include your own email (prevents self-lockout).
- Fails open on S3 errors (with a short 5-second retry TTL and an ops alert) so a bucket outage can't lock everyone out.
- Every block and session revocation is written to the audit log.

For implementation details and enforcement points, see [SECURITY-README.md](SECURITY-README.md#email-blacklist).

## Multi-Site Bootstrap

For deployments with multiple sites requiring authentication:

```bash
# Bootstrap each site separately
npx tsx scripts/bootstrap-superuser.ts --site ananda --env prod --email ananda-admin@example.com
npx tsx scripts/bootstrap-superuser.ts --site crystal --env prod --email crystal-admin@example.com
npx tsx scripts/bootstrap-superuser.ts --site jairam --env prod --email jairam-admin@example.com
```

## Verification

To verify the superuser was created successfully:

1. **Check Firestore**: Look for the user document in the appropriate collection (`dev_users` or `prod_users`)
2. **Test Login**: Use the magic link authentication flow
3. **Access Admin**: Confirm you can reach the admin dashboard

## Security Notes

- Limit superuser accounts to essential personnel only
- Use strong, unique passwords for email accounts associated with superusers
- Consider enabling MFA for superuser email accounts
- Regularly audit user roles and permissions

## Related Documentation

- **[Security Guide](SECURITY-README.md)**: Authentication and security implementation
- **[Backend Structure](backend-structure.md)**: User management system architecture
- **[Deployment Guide](deployment-guide.md)**: Production deployment procedures
