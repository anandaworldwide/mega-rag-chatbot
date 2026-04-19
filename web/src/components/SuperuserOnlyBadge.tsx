import React from "react";

/**
 * Inline affordance for admin pages gated to superusers only.
 */
export function SuperuserOnlyBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700"
      role="status"
      aria-label="Superuser-only page"
      title="Only superusers can access this page."
    >
      <span className="material-icons text-sm leading-none" aria-hidden="true">
        lock
      </span>
      Superuser only
    </span>
  );
}
