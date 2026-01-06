# Manual Test Checklist

This document contains manual tests for all uncommitted changes related to NPS Survey functionality, email validation,
input sanitization, and related features.

## 1. NPS Survey Page (`/survey`)

### Token-Based Pre-Selection (from email links)

- [ ] Navigate to `/survey?score=7&token=<valid_token>` - score 7 should be pre-selected
- [ ] Invalid token: `/survey?score=7&token=bad` - should show survey without pre-selection
- [ ] Mismatched score/token: `/survey?score=5&token=<token_for_score_7>` - should not pre-select

### Submission Flow

- [ ] Submit with score only - should succeed
- [ ] Submit with score + feedback - should succeed
- [ ] Submit with all fields - should succeed
- [ ] Success shows toast "Thank you for your feedback!"
- [ ] After success, redirects to homepage after ~3 seconds
- [ ] Duplicate submission within same minute returns 409 error

---

## 3. NPS Survey Cron (`POST /api/cron/processNpsSurveyEmails`)

### Prerequisites

Must have test user with:

- `inviteStatus: "accepted"`
- `lastActivityAt` within last 24 hours
- No `lastNpsSurveySentAt` in last 180 days
- No `lastContentEmailSentAt` in last 7 days
- `emailPreferences.nps !== false`

### Test Mode (with `NPS_SURVEY_TEST_EMAIL` env var)

- [ ] Set `NPS_SURVEY_TEST_EMAIL` to a test email
- [ ] Call endpoint → should only process that single user
- [ ] Response includes `testMode: true`

### Normal Mode

- [ ] Endpoint requires cron auth or JWT
- [ ] Returns JSON with `processed`, `sent`, `errors` counts
- [ ] Check that `lastNpsSurveySentAt` timestamp is set on user doc
- [ ] Check that `lastContentEmailSentAt` timestamp is set on user doc
- [ ] Verify email is actually received in inbox

### Edge Cases

- [ ] Site with `enableNpsSurveyEmail: false` → returns 200 with `sent: 0`
- [ ] Site without NPS template file → returns 200 with message about missing template
- [ ] User unsubscribed from NPS (`emailPreferences.nps: false`) → skipped

---

## 4. Email Link Tracking

### NPS Survey Email

- [ ] Click on a score (0-10) in email → navigates to survey page with correct score pre-selected
- [ ] Click tracking URL recorded in analytics
- [ ] Unsubscribe link in email → works correctly
- [ ] Open tracking pixel fires

---

## 5. Site Configuration

### Config.json Changes

- [ ] Verify `ananda` site has `enableNpsSurveyEmail: true`
- [ ] Verify other sites without the flag are not affected by NPS cron

---

## 6. Input Sanitization (Cross-Feature)

Test these in **any form submission** (survey feedback, contact forms, etc.):

- [ ] Input with `<script>alert(1)</script>` → sanitized/blocked
- [ ] Input with Excel formula `=SUM(A1:A10)` → sanitized (prefix stripped)
- [ ] Input with excessive whitespace → trimmed
- [ ] Input with null bytes → removed

---

## 7. Existing Email Flows (Regression Tests)

### Onboarding Emails

- [ ] Test user triggers onboarding → emails send correctly
- [ ] `lastContentEmailSentAt` updated after send

### Reengagement Emails

- [ ] Inactive user triggers reengagement → emails send correctly
- [ ] Content email cooldown respected

### Special Day Emails

- [ ] Special day email sends correctly
- [ ] Content email cooldown respected

### Newsletter Batch (`/api/admin/processNewsletterBatch`)

- [ ] Admin can trigger newsletter → sends correctly

---

## 8. Component UI Tests

### NPSSurvey Component

- [ ] Score label colors are neutral (all identical, no red/green bias)
- [ ] "least" and "most" labels display correctly
- [ ] Component animates in (framer-motion)

### Layout Changes

- [ ] Main layout renders correctly on all pages
- [ ] No visual regressions on homepage, chat page, etc.

---

## 9. NPS Template (`web/site-config/nps-templates/ananda.json`)

- [ ] Template variables render: `{{shortname}}` → "Luca"
- [ ] Template variables render: `{{firstName}}` → user's first name
- [ ] Template variables render: `{{other_visitors_reference}}` → "your Gurubhais"

---

## 10. API Error Responses

Verify all error responses use consistent format:

- [ ] Errors include `error` and `code` fields
- [ ] HTTP status codes match error types (400, 401, 403, 429, 500)

---

## Quick Smoke Test Sequence

1. **Login** to the app as a test user
2. Navigate to **`/survey`** → modal appears
3. Select score **8**, add feedback, submit → success toast, redirect
4. **Check Google Sheet** for the submitted data
5. **Check Firestore** user doc for `lastNpsSurveySentAt` timestamp
6. Attempt to **resubmit** → should get blocked

---

## Environment Requirements

Ensure these are configured for manual testing:

- `NPS_SURVEY_GOOGLE_SHEET_ID` - Google Sheet for survey responses
- `GOOGLE_APPLICATION_CREDENTIALS` - Service account JSON
- `SECURE_TOKEN` - JWT signing secret for survey tokens
- `CRON_SECRET` - For cron endpoint auth
- `NPS_SURVEY_TEST_EMAIL` (optional) - For testing cron in isolation

---

## Files Changed Summary

### New Files

- `web/src/pages/api/cron/processNpsSurveyEmails.ts`
- `web/src/utils/server/npsSurveyEmailUtils.ts`
- `web/src/utils/server/npsSurveyTokenUtils.ts`
- `web/src/utils/server/emailValidation.ts`
- `web/src/utils/server/contentEmailTracker.ts`
- `web/src/utils/server/apiErrorResponse.ts`
- `web/src/utils/server/emailTemplateLoader.ts`
- `web/src/utils/server/templateUtils.ts`
- `web/src/config/emailCampaigns.ts`
- `web/site-config/nps-templates/ananda.json`

### Modified Files

- `web/src/pages/api/submitNpsSurvey.ts`
- `web/src/pages/survey.tsx`
- `web/src/components/NPSSurvey.tsx`
- `web/src/utils/server/emailUtils.ts`
- `web/src/utils/server/inputSanitization.ts`
- `web/src/utils/server/emailTemplates.ts`
- `web/src/utils/server/emailTrackingUtils.ts`
- `web/src/utils/server/onboardingEmailUtils.ts`
- `web/src/utils/server/reengagementEmailUtils.ts`
- `web/src/utils/server/specialDayEmailUtils.ts`
- `web/src/utils/server/emailPreferenceUtils.ts`
- `web/site-config/config.json`
- `web/vercel.json` (cron schedule added)
