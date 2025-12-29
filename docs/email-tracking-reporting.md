# Email Campaign Tracking & Reporting Strategy

## Overview

The email tracking system supports multiple campaign types (onboarding, newsletters, re-engagement, etc.) and provides
two complementary tracking mechanisms:

1. **Google Analytics** - Automatic tracking via UTM parameters
2. **Firestore** - Detailed event logging for custom analytics

## Campaign Types Supported

- `onboarding` - Drip sequence emails (day 0, 3, 7, 14)
- `newsletter` - Admin-sent newsletters
- `reengagement` - Re-engagement campaigns (future)
- `specialDay` - Special occasion emails (future)

## Reporting Strategy

### Google Analytics (Primary for High-Level Metrics)

**Use GA for:**

- **Campaign performance overview** - See which campaigns drive the most traffic
- **User acquisition analysis** - Track email as a traffic source
- **Conversion funnels** - See how email clicks convert to actions
- **Real-time monitoring** - Quick visibility into current campaign performance
- **Cross-channel comparison** - Compare email performance vs. other channels

**Access:** GA4 → Acquisition → Campaigns → All Campaigns

**UTM Parameters Automatically Added:**

- `utm_source=email`
- `utm_medium=email`
- `utm_campaign={campaign-type}-{campaign-id}` (e.g., `onboarding-day0`, `newsletter-2024-01`)
- `utm_content={link-identifier}` (e.g., `question-1`, `cta-button`)

**Example Campaign Names:**

- `onboarding-day0` - Day 0 onboarding email
- `onboarding-day3` - Day 3 onboarding email
- `newsletter-2024-01-15` - Newsletter sent on Jan 15, 2024

### Firestore (Primary for Detailed Analytics)

**Use Firestore for:**

- **Individual user tracking** - See which users clicked/opened specific emails
- **Link-level analytics** - Track performance of individual links within emails
- **Email open rates** - Precise open tracking (not available in GA)
- **Custom reporting** - Build custom dashboards and reports
- **User segmentation** - Identify engaged vs. non-engaged users
- **A/B testing** - Compare different email variations

**Data Structure:**

```text
users/{email}/
  ├── email_clicks/
  │   └── {clickId}/
  │       ├── campaign: "onboarding" | "newsletter" | ...
  │       ├── campaignId: "0" | "newsletter-2024-01" | ...
  │       ├── type: "question" | "cta" | "unsubscribe" | "link"
  │       ├── linkId: "What are the Paths to God?" | "cta-button" | ...
  │       ├── targetUrl: "https://..."
  │       ├── timestamp: Timestamp
  │       ├── userAgent: string | null
  │       └── ip: string | null
  │
  └── email_opens/
      └── {openId}/
          ├── campaign: "onboarding" | "newsletter" | ...
          ├── campaignId: "0" | "newsletter-2024-01" | ...
          ├── timestamp: Timestamp
          ├── userAgent: string | null
          └── ip: string | null
```

**Example Queries:**

```typescript
// Get all clicks for a specific campaign
db.collection("users")
  .doc(email)
  .collection("email_clicks")
  .where("campaign", "==", "onboarding")
  .where("campaignId", "==", "0")
  .get();

// Get all opens for newsletters
db.collection("users").doc(email).collection("email_opens").where("campaign", "==", "newsletter").get();

// Get click-through rate for a specific link
const clicks = await db
  .collection("users")
  .doc(email)
  .collection("email_clicks")
  .where("linkId", "==", "What are the Paths to God?")
  .get();

// Get opens vs clicks ratio
const opens = await db
  .collection("users")
  .doc(email)
  .collection("email_opens")
  .where("campaign", "==", "onboarding")
  .get();
const clicks = await db
  .collection("users")
  .doc(email)
  .collection("email_clicks")
  .where("campaign", "==", "onboarding")
  .get();
const ctr = clicks.size / opens.size;
```

## When to Use Which System

### Use Google Analytics When

- ✅ You need quick, high-level campaign performance metrics
- ✅ You want to compare email performance with other traffic sources
- ✅ You need conversion tracking (clicks → actions on site)
- ✅ You want real-time dashboards
- ✅ You're doing campaign-level analysis

### Use Firestore When

- ✅ You need user-level tracking (which users clicked what)
- ✅ You want to track email opens (GA can't track opens reliably)
- ✅ You need link-level analytics (which specific links performed best)
- ✅ You're building custom reports or dashboards
- ✅ You're doing user segmentation or personalization
- ✅ You need to export data for external analysis

## Implementation for New Campaigns

When adding a new email campaign type:

1. **Use the tracking utilities:**

   ```typescript
   import { generateClickTrackingUrl, generateOpenTrackingUrl, addUtmParams } from "@/utils/server/emailTrackingUtils";

   // For click tracking
   const trackingUrl = generateClickTrackingUrl(
     targetUrl,
     userEmail,
     "newsletter", // campaign type
     newsletterId, // campaign ID
     "link", // link type
     linkText, // optional link ID
     baseUrl
   );

   // For open tracking
   const pixelUrl = generateOpenTrackingUrl(userEmail, "newsletter", newsletterId, baseUrl);
   ```

2. **Add UTM parameters:**

   ```typescript
   const urlWithUtm = addUtmParams(
     targetUrl,
     `newsletter-${newsletterId}`, // campaign name
     "email",
     "email",
     "cta-button" // content identifier
   );
   ```

3. **Data will automatically appear in:**
   - Google Analytics (via UTM params)
   - Firestore (via tracking endpoints)

## Future Enhancements

- **Admin Dashboard** - Build a UI to view email analytics from Firestore
- **Automated Reports** - Send weekly/monthly email performance reports
- **A/B Testing** - Track performance of different email variations
- **User Segmentation** - Identify highly engaged users based on click/open patterns
- **Re-engagement Campaigns** - Target users who haven't opened emails recently
