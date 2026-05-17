import React from "react";
import { EmailOptOutsCard } from "./EmailOptOutsCard";

/**
 * Mobile mirror of the web `TieBreakEmailOptOutsCard` (Task #1208 →
 * Task #1402 ports it to mobile so committee admins on the phone can
 * also see and re-subscribe directors who opted out of the round-robin
 * tie-break required alert email).
 *
 * Task #2098: this is now a thin wrapper around the shared
 * `EmailOptOutsCard`, which is also used by `ScheduleChangeOptOutsCard`.
 *
 * Self-hides on 401/403 so the section disappears for non-admin users
 * (matching the web behaviour exactly). Hits the same endpoints:
 *   GET    /api/organizations/:orgId/tie-break-email-opt-outs
 *   DELETE /api/organizations/:orgId/tie-break-email-opt-outs/:userId
 */
export function TieBreakEmailOptOutsCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  return (
    <EmailOptOutsCard
      orgId={orgId}
      token={token}
      endpointPath="tie-break-email-opt-outs"
      iconName="bell-off"
      title="Tie-break alert emails — opted out"
      subtitle={
        "These directors clicked “Unsubscribe” in a previous round-robin " +
        "tie-break alert email, so they no longer receive that email for this " +
        "organization. They still receive the in-app inbox and push " +
        "notifications."
      }
      emptyText="No one has opted out of tie-break alert emails."
      buildResubscribeSuccessMessage={(label) =>
        `${label} will receive tie-break alert emails again.`
      }
      cardTestID="card-tie-break-email-opt-outs"
      emptyTextTestID="text-no-tie-break-opt-outs"
      listTestID="list-tie-break-opt-outs"
      resubscribeTestIDPrefix="button-resubscribe-tie-break-"
    />
  );
}
