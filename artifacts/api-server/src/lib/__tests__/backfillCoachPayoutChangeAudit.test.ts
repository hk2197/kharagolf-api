/**
 * Task #2119 — Regression coverage for the coach-side payout-change
 * audit backfill (`src/lib/backfillCoachPayoutChangeAudit.ts`, originally
 * Task #1702).
 *
 * The backfill walks every `coach_payout_account_history` row that does
 * not yet have a coach-side `notification_audit_log` row and synthesises
 * three rows (one per channel: email / in_app / push) so the audit
 * dashboard can answer "did we ever tell this coach?" for pre-Task #1406
 * dispatches. The contract this test pins down:
 *
 *   1. A history row WITH a `coach_payout_account_change_notify_attempts`
 *      row copies the per-channel `email_status` / `last_email_error`
 *      and `push_status` / `last_push_error` straight onto the
 *      synthesised audit rows. In-app is always `unknown` /
 *      `backfilled_pre_audit` because the attempts table doesn't track
 *      that leg.
 *
 *   2. A history row WITHOUT an attempts row falls back to
 *      `unknown` / `backfilled_pre_audit` for email + push too, and
 *      resolves the coach userId via `teaching_pros.user_id`.
 *
 *   3. A history row that already has an audit row for the same
 *      `(notification_key, coach userId, payload.historyId)` triple is
 *      NOT touched (the NOT EXISTS idempotency latch).
 *
 *   4. A history row whose pro has no linked app user AND no attempts
 *      row is skipped (counted in `historyRowsSkippedNoUser`) — there
 *      is no userId to attribute the audit to.
 *
 *   5. Re-running the backfill is a no-op: `rowsInserted` for the
 *      second pass is 0 and the audit row count for our seeded
 *      historyIds is unchanged.
 *
 *   6. The schema gate aborts loudly when the join column on
 *      `coach_payout_account_change_notify_attempts` is missing —
 *      better to fail than silently mark every row
 *      `backfilled_pre_audit`.
 *
 * The Postgres database is real (matches the convention used by every
 * other api-server integration test under this folder).
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-backfill-coach-payout-change-audit";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  db,
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  assertSchemaGate,
  runBackfill,
  COACH_NOTIFY_KEY,
  BACKFILL_REASON,
} from "../backfillCoachPayoutChangeAudit.js";

// ── Cleanup tracking ─────────────────────────────────────────────────────

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];
const createdProIds: number[] = [];
const createdHistoryIds: number[] = [];

afterAll(async () => {
  // Audit rows are not FK-cascaded by historyId (the table has no FK to
  // history), so wipe them by (key, userId) before tearing down users.
  if (createdUserIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, COACH_NOTIFY_KEY),
      inArray(notificationAuditLogTable.userId, createdUserIds),
    ));
  }
  // Attempts rows cascade off history; history off pro; pro off org. We
  // still issue explicit deletes in dependency order to keep teardown
  // predictable when a test inserts a row out of band.
  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.historyId, createdHistoryIds));
    await db.delete(coachPayoutAccountHistoryTable)
      .where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  if (createdProIds.length > 0) {
    await db.delete(teachingProsTable).where(inArray(teachingProsTable.id, createdProIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOrg(label: string): Promise<number> {
  const stamp = uniq(label);
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`,
    slug: stamp,
  }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(label: string): Promise<number> {
  const stamp = uniq(label);
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `payout-backfill-${stamp}`,
    username: `pb_${stamp}`,
    email: `${stamp}@example.com`,
    displayName: `Coach ${label}`,
    role: "player",
  }).returning();
  createdUserIds.push(user.id);
  return user.id;
}

async function makePro(orgId: number, opts: { userId: number | null }): Promise<number> {
  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    userId: opts.userId,
    displayName: `Coach ${uniq("c")}`,
  }).returning({ id: teachingProsTable.id });
  createdProIds.push(pro.id);
  return pro.id;
}

async function makeHistoryRow(opts: {
  proId: number;
  organizationId: number;
  changedByUserId: number | null;
  changedByRole?: "coach" | "admin";
  changeKind?: "created" | "updated";
  method?: "upi" | "bank_account";
}): Promise<number> {
  const method = opts.method ?? "upi";
  const [h] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId: opts.proId,
    organizationId: opts.organizationId,
    changedByUserId: opts.changedByUserId,
    changedByRole: opts.changedByRole ?? "coach",
    changeKind: opts.changeKind ?? "updated",
    method,
    accountHolderName: "Test Coach",
    upiVpaMasked: method === "upi" ? "te****@ybl" : null,
    bankAccountLast4: method === "bank_account" ? "4321" : null,
    bankIfsc: method === "bank_account" ? "HDFC0001234" : null,
    ipAddress: "10.0.0.1",
    userAgent: "vitest",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(h.id);
  return h.id;
}

async function makeAttemptsRow(opts: {
  historyId: number;
  organizationId: number;
  proId: number;
  coachUserId: number;
  changeKind: string;
  method: string;
  emailStatus: string | null;
  lastEmailError?: string | null;
  pushStatus: string | null;
  lastPushError?: string | null;
}): Promise<void> {
  await db.insert(coachPayoutAccountChangeNotifyAttemptsTable).values({
    historyId: opts.historyId,
    organizationId: opts.organizationId,
    proId: opts.proId,
    coachUserId: opts.coachUserId,
    changeKind: opts.changeKind,
    method: opts.method,
    emailStatus: opts.emailStatus,
    lastEmailError: opts.lastEmailError ?? null,
    pushStatus: opts.pushStatus,
    lastPushError: opts.lastPushError ?? null,
  });
}

interface AuditRow {
  channel: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown>;
  userId: number | null;
}

async function loadAuditsForHistory(historyId: number): Promise<AuditRow[]> {
  const rows = await db.select({
    channel: notificationAuditLogTable.channel,
    status: notificationAuditLogTable.status,
    reason: notificationAuditLogTable.reason,
    payload: notificationAuditLogTable.payload,
    userId: notificationAuditLogTable.userId,
  }).from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.notificationKey, COACH_NOTIFY_KEY),
      sql`(${notificationAuditLogTable.payload}->>'historyId')::int = ${historyId}`,
    ));
  return rows;
}

// ── Schema gate ──────────────────────────────────────────────────────────

describe("backfillCoachPayoutChangeAudit — schema gate", () => {
  it("succeeds when the join column is present on the live attempts table", async () => {
    // Sanity check: the production defaults must always pass against
    // the test DB, otherwise the suite below can't run either.
    await expect(assertSchemaGate()).resolves.toBeUndefined();
  });

  it("aborts loudly when the join column is missing", async () => {
    // We don't actually drop the production column (other tests share
    // this DB). Instead we point the gate at a column name that is
    // guaranteed not to exist on the attempts table — the gate's only
    // signal is the information_schema probe, so this exercises the
    // exact failure code path.
    await expect(
      assertSchemaGate(
        "coach_payout_account_change_notify_attempts",
        "history_id_does_not_exist_2119",
      ),
    ).rejects.toThrow(/schema gate failed/i);
  });

  it("aborts loudly when the table itself is missing", async () => {
    await expect(
      assertSchemaGate("table_does_not_exist_2119", "history_id"),
    ).rejects.toThrow(/Aborting before writing any audit rows/);
  });
});

// ── Backfill behaviour ───────────────────────────────────────────────────

interface SeededScenario {
  orgId: number;
  // 1: with attempts row carrying real per-channel state
  withAttempts: { historyId: number; coachUserId: number; proId: number };
  // 2: no attempts row, pro.userId resolves the coach
  noAttempts: { historyId: number; coachUserId: number; proId: number };
  // 3: history row that already has a coach-side audit row
  alreadyAudited: { historyId: number; coachUserId: number; proId: number };
  // 4: history row with no resolvable coach userId at all
  noCoachUser: { historyId: number; proId: number };
  // 5: attempts row exists but per-channel statuses are NULL (older
  //    notify version) — backfill must mark those `unknown` instead of
  //    asserting a state we can't prove.
  attemptsPartial: { historyId: number; coachUserId: number; proId: number };
}

let scenario: SeededScenario;

beforeAll(async () => {
  const orgId = await makeOrg("audit-backfill");

  // Scenario 1: with attempts row, both channels have real outcomes.
  const withAttemptsCoach = await makeUser("with-attempts-coach");
  const withAttemptsPro = await makePro(orgId, { userId: withAttemptsCoach });
  const withAttemptsHistory = await makeHistoryRow({
    proId: withAttemptsPro,
    organizationId: orgId,
    changedByUserId: withAttemptsCoach,
    method: "upi",
    changeKind: "updated",
  });
  await makeAttemptsRow({
    historyId: withAttemptsHistory,
    organizationId: orgId,
    proId: withAttemptsPro,
    coachUserId: withAttemptsCoach,
    changeKind: "updated",
    method: "upi",
    emailStatus: "sent",
    lastEmailError: null,
    pushStatus: "failed",
    lastPushError: "expo timeout",
  });

  // Scenario 2: no attempts row at all; falls back to teaching_pros.user_id.
  const noAttemptsCoach = await makeUser("no-attempts-coach");
  const noAttemptsPro = await makePro(orgId, { userId: noAttemptsCoach });
  const noAttemptsHistory = await makeHistoryRow({
    proId: noAttemptsPro,
    organizationId: orgId,
    changedByUserId: noAttemptsCoach,
    method: "bank_account",
    changeKind: "created",
    changedByRole: "admin",
  });

  // Scenario 3: pre-existing audit row → must be skipped entirely.
  const alreadyCoach = await makeUser("already-audited-coach");
  const alreadyPro = await makePro(orgId, { userId: alreadyCoach });
  const alreadyHistory = await makeHistoryRow({
    proId: alreadyPro,
    organizationId: orgId,
    changedByUserId: alreadyCoach,
    method: "upi",
    changeKind: "updated",
  });
  // Insert the pre-existing audit row that the live notify path would
  // have written. We only need ONE row for the NOT EXISTS guard to
  // skip the entire history row — pick `email` so we can prove the
  // backfill never wrote a fresh `email`/`in_app`/`push` triple on
  // top of it.
  await db.insert(notificationAuditLogTable).values({
    notificationKey: COACH_NOTIFY_KEY,
    userId: alreadyCoach,
    channel: "email",
    status: "sent",
    reason: null,
    payload: {
      historyId: alreadyHistory,
      proId: alreadyPro,
      organizationId: orgId,
      // Intentionally NOT setting `backfilled: true` — this is the
      // pre-existing live row, not a synthesised one.
    },
  });

  // Scenario 4: no resolvable coach userId. Pro has userId=null AND no
  // attempts row, so the backfill cannot attribute the audit to anyone
  // and must skip the row.
  const noUserPro = await makePro(orgId, { userId: null });
  const noUserHistory = await makeHistoryRow({
    proId: noUserPro,
    organizationId: orgId,
    changedByUserId: null,
    method: "upi",
    changeKind: "created",
  });

  // Scenario 5: attempts row exists but per-channel statuses are NULL.
  // The lib treats `null` as "not attempted" and falls back to
  // `unknown`/`backfilled_pre_audit` for those channels.
  const partialCoach = await makeUser("partial-attempts-coach");
  const partialPro = await makePro(orgId, { userId: partialCoach });
  const partialHistory = await makeHistoryRow({
    proId: partialPro,
    organizationId: orgId,
    changedByUserId: partialCoach,
    method: "upi",
    changeKind: "updated",
  });
  await makeAttemptsRow({
    historyId: partialHistory,
    organizationId: orgId,
    proId: partialPro,
    coachUserId: partialCoach,
    changeKind: "updated",
    method: "upi",
    emailStatus: null,
    pushStatus: null,
  });

  scenario = {
    orgId,
    withAttempts: { historyId: withAttemptsHistory, coachUserId: withAttemptsCoach, proId: withAttemptsPro },
    noAttempts: { historyId: noAttemptsHistory, coachUserId: noAttemptsCoach, proId: noAttemptsPro },
    alreadyAudited: { historyId: alreadyHistory, coachUserId: alreadyCoach, proId: alreadyPro },
    noCoachUser: { historyId: noUserHistory, proId: noUserPro },
    attemptsPartial: { historyId: partialHistory, coachUserId: partialCoach, proId: partialPro },
  };
});

describe("backfillCoachPayoutChangeAudit — runBackfill", () => {
  let firstRunSummary: Awaited<ReturnType<typeof runBackfill>>;

  it("processes all eligible history rows on first run and skips the unresolvable one", async () => {
    firstRunSummary = await runBackfill();

    // We can't pin down the absolute candidate / inserted counts (the
    // shared test DB may carry stray history rows from sibling suites
    // that didn't clean up), but everything we seeded must be reflected.
    expect(firstRunSummary.historyRowsSkippedNoUser).toBeGreaterThanOrEqual(1);
    expect(firstRunSummary.skippedNoUserHistoryIds).toContain(
      scenario.noCoachUser.historyId,
    );
    // The historyRowsBackfilled × 3 invariant is enforced inside the
    // transaction by the post-insert sanity check; surfacing it here
    // means an integer-multiple-of-3 result is also a contract.
    expect(firstRunSummary.rowsInserted).toBe(firstRunSummary.historyRowsBackfilled * 3);
  });

  it("copies per-channel attempts state onto the synthesised audit rows when an attempts row exists", async () => {
    const audits = await loadAuditsForHistory(scenario.withAttempts.historyId);
    expect(audits).toHaveLength(3);

    const byChannel = new Map(audits.map((r) => [r.channel, r]));

    // Every row is attributed to the coach (the snapshot from
    // attempts.coachUserId, not pro.userId).
    for (const row of audits) {
      expect(row.userId).toBe(scenario.withAttempts.coachUserId);
    }

    // Email: status copied from attempts.email_status, reason carries
    // the (null) lastEmailError verbatim.
    const email = byChannel.get("email")!;
    expect(email.status).toBe("sent");
    expect(email.reason).toBeNull();

    // Push: status copied from attempts.push_status, reason carries
    // the per-channel last error string.
    const push = byChannel.get("push")!;
    expect(push.status).toBe("failed");
    expect(push.reason).toBe("expo timeout");

    // In-app is ALWAYS unknown/backfilled_pre_audit by spec — the
    // attempts table doesn't track it.
    const inApp = byChannel.get("in_app")!;
    expect(inApp.status).toBe("unknown");
    expect(inApp.reason).toBe(BACKFILL_REASON);

    // Payload mirrors the live notify shape plus the backfill markers.
    for (const row of audits) {
      expect(row.payload.historyId).toBe(scenario.withAttempts.historyId);
      expect(row.payload.proId).toBe(scenario.withAttempts.proId);
      expect(row.payload.organizationId).toBe(scenario.orgId);
      expect(row.payload.method).toBe("upi");
      expect(row.payload.changeKind).toBe("updated");
      expect(row.payload.changedByRole).toBe("coach");
      expect(row.payload.changedByUserId).toBe(scenario.withAttempts.coachUserId);
      expect(row.payload.backfilled).toBe(true);
      expect(row.payload.backfillTask).toBe(1702);
    }
  });

  it("falls back to unknown/backfilled_pre_audit for every channel when no attempts row exists", async () => {
    const audits = await loadAuditsForHistory(scenario.noAttempts.historyId);
    expect(audits).toHaveLength(3);

    // Resolved via teaching_pros.user_id (no attempts snapshot).
    for (const row of audits) {
      expect(row.userId).toBe(scenario.noAttempts.coachUserId);
      expect(row.status).toBe("unknown");
      expect(row.reason).toBe(BACKFILL_REASON);
      expect(row.payload.backfilled).toBe(true);
      expect(row.payload.backfillTask).toBe(1702);
      // Payload reflects the history-row metadata even with no
      // attempts snapshot to crib from.
      expect(row.payload.method).toBe("bank_account");
      expect(row.payload.changeKind).toBe("created");
      expect(row.payload.changedByRole).toBe("admin");
    }

    // All three channels are present.
    const channels = new Set(audits.map((r) => r.channel));
    expect(channels).toEqual(new Set(["email", "in_app", "push"]));
  });

  it("treats an attempts row with NULL per-channel statuses as not-attempted (unknown/backfilled)", async () => {
    const audits = await loadAuditsForHistory(scenario.attemptsPartial.historyId);
    expect(audits).toHaveLength(3);

    for (const row of audits) {
      expect(row.userId).toBe(scenario.attemptsPartial.coachUserId);
      expect(row.status).toBe("unknown");
      expect(row.reason).toBe(BACKFILL_REASON);
    }
  });

  it("does NOT touch a history row that already has a coach-side audit row", async () => {
    const audits = await loadAuditsForHistory(scenario.alreadyAudited.historyId);

    // Only the single pre-existing email row should be present — the
    // backfill must NOT have written a fresh email/in_app/push triple
    // on top of it.
    expect(audits).toHaveLength(1);
    const [only] = audits;
    expect(only.channel).toBe("email");
    expect(only.status).toBe("sent");
    expect(only.reason).toBeNull();
    // And critically, the pre-existing row is NOT a backfilled one.
    expect(only.payload.backfilled).toBeUndefined();
  });

  it("never writes any audit row for a history row whose pro has no app user and no attempts snapshot", async () => {
    const audits = await loadAuditsForHistory(scenario.noCoachUser.historyId);
    expect(audits).toHaveLength(0);
  });

  it("is idempotent: a second run inserts zero new audit rows for the seeded history rows", async () => {
    // Snapshot the audit row count for our seeded historyIds before
    // the second pass. The script processes the whole DB, so any
    // strays from sibling suites are noise — restrict the assertion
    // to the historyIds we actually own.
    const ourHistoryIds = [
      scenario.withAttempts.historyId,
      scenario.noAttempts.historyId,
      scenario.alreadyAudited.historyId,
      scenario.noCoachUser.historyId,
      scenario.attemptsPartial.historyId,
    ];

    async function countAuditRowsForOurs(): Promise<number> {
      const rows = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM ${notificationAuditLogTable}
        WHERE ${notificationAuditLogTable.notificationKey} = ${COACH_NOTIFY_KEY}
          AND (${notificationAuditLogTable.payload}->>'historyId')::int
              IN (${sql.join(ourHistoryIds.map((id) => sql`${id}`), sql`, `)})
      `);
      const row = rows.rows?.[0] ?? (rows as unknown as Array<{ count: number }>)[0];
      return Number(row?.count ?? 0);
    }

    const before = await countAuditRowsForOurs();
    // Sanity check the first run actually wrote what we expect:
    //   3 channels × 3 backfilled history rows (with-attempts,
    //   no-attempts, attempts-partial) + 1 pre-existing audit row
    //   from the alreadyAudited scenario = 10.
    // (noCoachUser contributes 0.)
    expect(before).toBe(10);

    const secondRunSummary = await runBackfill();

    // Whatever the script saw on this run, none of OUR historyIds
    // should have produced a new audit row.
    const after = await countAuditRowsForOurs();
    expect(after).toBe(before);

    // The "no resolvable coach userId" history row keeps showing up as
    // a candidate forever (it has no audit row to satisfy the NOT
    // EXISTS guard, and no userId to attribute one to). That's fine —
    // it's counted in `historyRowsSkippedNoUser` on every pass.
    expect(secondRunSummary.skippedNoUserHistoryIds).toContain(
      scenario.noCoachUser.historyId,
    );

    // None of OUR historyIds should be in `historyRowsBackfilled` on
    // the second pass. The summary doesn't expose per-history counts,
    // so verify via the audit-row delta above (already asserted) and
    // additionally check the count of NEW backfilled audit rows for
    // the historyIds we own is exactly zero.
    const ourNewBackfilledRows = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM ${notificationAuditLogTable}
      WHERE ${notificationAuditLogTable.notificationKey} = ${COACH_NOTIFY_KEY}
        AND (${notificationAuditLogTable.payload}->>'historyId')::int
            IN (${sql.join(ourHistoryIds.map((id) => sql`${id}`), sql`, `)})
        AND ${notificationAuditLogTable.payload}->>'backfilled' = 'true'
    `);
    const backfilledCount = Number(
      (ourNewBackfilledRows.rows?.[0] ?? (ourNewBackfilledRows as unknown as Array<{ count: number }>)[0])?.count ?? 0,
    );
    // 9 from the first run (3 channels × 3 backfilled history rows),
    // unchanged after the second run.
    expect(backfilledCount).toBe(9);
  });
});
