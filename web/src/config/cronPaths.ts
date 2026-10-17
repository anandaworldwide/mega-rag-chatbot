/**
 * Cron paths from web/vercel.json. Keep this list in lockstep with that file.
 * A Jest test fails if the lists diverge.
 *
 * The proxy lets these paths through only when Authorization Bearer matches
 * CRON_SECRET. A Bearer header on any other route does not skip login.
 */
export const VERCEL_CRON_PATHS: readonly string[] = [
  "/api/admin/digestSelfProvision",
  "/api/admin/cleanupExpiredInvitations",
  "/api/cron/download-locations",
  "/api/cron/processOnboardingEmails",
  "/api/cron/processReengagementEmails",
  "/api/cron/processSpecialDayEmails",
  "/api/cron/processNpsSurveyEmails",
  "/api/admin/model-performance-digest",
  "/api/admin/downvoteFeedbackDigest",
  "/api/cron/nagPendingAccessRequests",
  "/api/cron/remindLucaS3Backup",
];

export function isVercelCronPath(pathname: string): boolean {
  return VERCEL_CRON_PATHS.includes(pathname);
}
