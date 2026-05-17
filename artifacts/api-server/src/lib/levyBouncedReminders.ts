/**
 * Shared aggregation for unresolved bounced levy reminders (Tasks #213, #242).
 *
 * The dashboard banner endpoint and the daily admin digest cron both need the
 * same per-org rollup: one entry per levy whose latest reminder per
 * (member, channel) is still in `failed` state and has not been superseded by
 * a later successful send. Centralising the logic here keeps the two surfaces
 * in lockstep so the digest count always matches what admins see in-app.
 */
import { db, memberMessagesTable, memberLeviesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export type BouncedLevySummary = {
  levyId: number;
  name: string;
  currency: string;
  unresolvedFailedCount: number;
  channels: Record<string, number>;
  latestFailureAt: string | null;
  sampleError: string | null;
};

export type BouncedLeviesResult = {
  levies: BouncedLevySummary[];
  totalBounced: number;
};

export async function getBouncedLeviesForOrg(
  orgId: number,
  opts?: { memberId?: number },
): Promise<BouncedLeviesResult> {
  const conds = [
    eq(memberMessagesTable.organizationId, orgId),
    eq(memberMessagesTable.relatedEntity, "levy"),
    eq(memberLeviesTable.organizationId, orgId),
  ];
  if (opts?.memberId != null && Number.isFinite(opts.memberId)) {
    conds.push(eq(memberMessagesTable.clubMemberId, opts.memberId));
  }
  const msgs = await db
    .select({
      levyId: memberMessagesTable.relatedEntityId,
      clubMemberId: memberMessagesTable.clubMemberId,
      channel: memberMessagesTable.channel,
      status: memberMessagesTable.status,
      sentAt: memberMessagesTable.sentAt,
      errorMessage: memberMessagesTable.errorMessage,
      levyName: memberLeviesTable.name,
      currency: memberLeviesTable.currency,
    })
    .from(memberMessagesTable)
    .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberMessagesTable.relatedEntityId))
    .where(and(...conds))
    .orderBy(desc(memberMessagesTable.sentAt));

  type Latest = {
    status: string; channel: string; sentAt: Date | string | null;
    errorMessage: string | null; levyName: string; currency: string;
  };
  const latest = new Map<string, Latest>();
  for (const m of msgs) {
    if (m.levyId == null) continue;
    const key = `${m.levyId}::${m.clubMemberId}::${m.channel}`;
    if (!latest.has(key)) {
      latest.set(key, {
        status: m.status ?? "sent", channel: m.channel,
        sentAt: m.sentAt, errorMessage: m.errorMessage,
        levyName: m.levyName, currency: m.currency,
      });
    }
  }

  const byLevy = new Map<number, BouncedLevySummary>();
  for (const [key, v] of latest.entries()) {
    if (v.status !== "failed") continue;
    const levyId = Number(key.split("::")[0]);
    const entry = byLevy.get(levyId) ?? {
      levyId, name: v.levyName, currency: v.currency,
      unresolvedFailedCount: 0, channels: {},
      latestFailureAt: null, sampleError: null,
    };
    entry.unresolvedFailedCount += 1;
    entry.channels[v.channel] = (entry.channels[v.channel] ?? 0) + 1;
    const ts = v.sentAt ? new Date(v.sentAt).toISOString() : null;
    if (ts && (!entry.latestFailureAt || ts > entry.latestFailureAt)) {
      entry.latestFailureAt = ts;
    }
    if (!entry.sampleError && v.errorMessage) entry.sampleError = v.errorMessage;
    byLevy.set(levyId, entry);
  }

  const levies = [...byLevy.values()].sort((a, b) => {
    const at = a.latestFailureAt ?? "";
    const bt = b.latestFailureAt ?? "";
    return bt.localeCompare(at);
  });
  const totalBounced = levies.reduce((s, l) => s + l.unresolvedFailedCount, 0);
  return { levies, totalBounced };
}

/**
 * Lightweight pre-filter for the daily digest cron. Returns the orgs that have
 * at least one failed levy reminder message on record — the cron then runs the
 * full unresolved-aggregation per org to decide whether to actually email.
 * (We can't tell from a single query whether a failure was superseded later,
 * so this is intentionally a candidate list, not the final set.)
 */
export async function listOrgIdsWithFailedLevyMessages(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ orgId: memberMessagesTable.organizationId })
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.relatedEntity, "levy"),
      eq(memberMessagesTable.status, "failed"),
    ));
  return rows.map(r => r.orgId).filter((n): n is number => typeof n === "number");
}
