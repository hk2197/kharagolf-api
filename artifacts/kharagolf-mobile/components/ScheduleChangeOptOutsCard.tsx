import React from "react";
import { EmailOptOutsCard } from "./EmailOptOutsCard";

/**
 * Mobile mirror of the web `ScheduleChangeOptOutsCard` opt-outs panel
 * (Task #387 / Task #512). Task #1688 ports the opt-out section to mobile
 * so org admins on the phone can also see who has silenced the bounced-
 * digest schedule-change heads-up emails and re-subscribe them on the
 * spot. Sibling of the existing tie-break opt-outs card (Task #1402).
 *
 * Task #2098: this is now a thin wrapper around the shared
 * `EmailOptOutsCard`, which is also used by `TieBreakEmailOptOutsCard`.
 *
 * Self-hides on 401/403 so the section disappears for non-admin users
 * (matching the web behaviour exactly). Hits the same endpoints:
 *   GET    /api/organizations/:orgId/bounced-digest-schedule-opt-outs
 *   DELETE /api/organizations/:orgId/bounced-digest-schedule-opt-outs/:userId
 *
 * Note: the web also surfaces a "last sent" audit / resend trail next to
 * this card; that is out of scope for Task #1688, which only ports the
 * opt-out list itself.
 */
export function ScheduleChangeOptOutsCard({
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
      endpointPath="bounced-digest-schedule-opt-outs"
      iconName="mail"
      title="Schedule-change emails — opted out"
      subtitle={
        "These recipients clicked “Unsubscribe from schedule-change emails” in a " +
        "previous notification. They still receive the regular bounced-levy " +
        "digest for this organization."
      }
      emptyText="No one has opted out of schedule-change notifications."
      buildResubscribeSuccessMessage={(label) =>
        `${label} will receive schedule-change heads-up emails again.`
      }
      cardTestID="card-schedule-change-opt-outs"
      emptyTextTestID="text-no-schedule-opt-outs"
      listTestID="list-schedule-opt-outs"
      resubscribeTestIDPrefix="button-resubscribe-schedule-"
    />
  );
}
