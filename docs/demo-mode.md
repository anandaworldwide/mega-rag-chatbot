# Demo Mode

Masks personally identifiable information (PII) in admin interface for safe demonstrations.

## Configuration

Add to your `.env` file:

```bash
DEMO_MODE=true
```

Accepted values: `true`, `1`, or `yes`

## What It Does

- **Email masking**: `user@example.com` → `u***@e***.com`
- **Name replacement**: Real names → deterministic fake names (e.g., "Jordan Smith")
- **Deterministic**: Same user always gets the same fake name (based on UUID hash)

## Where It Works

All admin pages:

1. Active Users (`/admin/users`) - Links use UUID instead of masked email
2. User Details (`/admin/users/[userId]`) - Accepts UUID or email, displays masked data
3. Pending Users (`/admin/users/pending`) - Displays masked emails
4. Leaderboard (`/admin/leaderboard`) - Links use UUID, displays masked data
5. Newsletter History (`/admin/newsletters`) - Masks sender emails

## Implementation

- **Server-side**: All masking happens in API responses
- **URL routing**: User detail pages use UUID in URLs to avoid 404s with masked emails
- **Backward compatibility**: API accepts both UUID and email identifiers
- **Utilities**: `web/src/utils/server/demoMode.ts` and `web/src/utils/client/demoMode.ts`
- **API endpoints**: Modified `listActiveUsers`, `users/[userId]`, `listPendingUsers`, `leaderboard`,
  `newsletters/history`

## Important Notes

- For demonstration only - do not use in production
- UUIDs and roles remain visible
- Database unchanged - masking only affects API responses
- Must restart server after changing environment variable

## Testing

```bash
# Set environment variable
DEMO_MODE=true

# Restart server
npm run dev

# Visit admin pages
open http://localhost:3000/admin/users
```

Verify emails show as `x***@y***.com` and names are generic like "Alex Smith".
