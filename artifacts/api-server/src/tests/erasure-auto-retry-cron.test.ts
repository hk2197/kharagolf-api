/**
 * Integration tests: Task #1079 — bounded auto-retry for stuck erasure
 * storage cleanups.
 *
 * The cron pass walks every (orgId, clubMemberId) whose latest erasure audit
 * row left object-storage files behind and re-invokes the per-member retry
 * helper, capped at 5 attempts spaced exponentially over ~24h. The test
 * suite locks in the contract:
 *
 *   1. A fresh failure within the initial backoff window is deferred (no
 *      retry audit row written).
 *   2. Once the backoff has elapsed the helper fires and writes a follow-up
 *      audit row tagged `metadata.source = "cron_retry"` (distinguishing it
 *      from controller-initiated retries which use `controller_retry`).
 *   3. After the per-member attempt cap is reached, no further cron retries
 *      run — the member stays surfaced for a controller to handle manually.
 *   4. A controller retry resets the cron-attempt count: the loop walks back
 *      from the latest row counting consecutive `cron_retry` entries, so a
 *      `controller_retry` row breaks the chain.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `runStuckErasureAutoRetryPass` walks `member_audit_log` GLOBALLY across
 * every (orgId, clubMemberId) with stuck storage failures. The api-server
 * vitest suite shares a dev DB across files, so unscoped
 * `summary.{candidates,deferred,retried,capped,cappedNotified}` totals
 * would flake whenever sibling tests (e.g. `account-erasure-cron-storage`)
 * leave orphan storage failures in the audit log for other orgs. Every
 * cron call goes through `runStuckErasureAutoRetryPassRowScoped`, which
 * snapshots OUR member's audit-row state before the sweep, runs it,
 * then derives `{retried, cappedNotified}` from the audit-log delta and
 * `{candidates, capped, deferred}` from the same row's chain state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Stub out the controller-alert side effects (push fanout + per-recipient
// transactional email). Task #1244 introduces a notify step at the
// cap-reached branch of the cron pass; we want to assert it fires with
// the right payload without sending real pushes/emails. Defined via
// `vi.hoisted` so the mock fns are in scope for the `vi.mock` factories
// (which Vitest hoists above all imports).
const { sendTransactionalPushMock, sendErasureAutoRetryCappedEmailMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendErasureAutoRetryCappedEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
}));
vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return { ...actual, sendTransactionalPush: sendTransactionalPushMock };
});
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return { ...actual, sendErasureAutoRetryCappedEmail: sendErasureAutoRetryCappedEmailMock };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import {
  runStuckErasureAutoRetryPass,
  acknowledgeStuckErasureForMember,
} from "../lib/cron.js";

async function ensureSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text,
      actor_role text,
      entity text NOT NULL,
      entity_id integer,
      action text NOT NULL,
      field_changes jsonb,
      reason text,
      metadata jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
}

let testOrgId: number;
let memberId: number;
// Task #1244 — controller recipients populated in beforeAll: one direct
// `app_users.role = "org_admin"` and one `org_memberships`-granted
// "membership_secretary". The notify helper deduplicates by `userId`,
// so a single push payload should target both, and one email per
// controller should be dispatched.
let directAdminUserId: number;
let secretaryUserId: number;

const HOUR = 60 * 60 * 1000;

async function clearAuditRows() {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, testOrgId),
    eq(memberAuditLogTable.clubMemberId, memberId),
  ));
}

async function insertOriginalErasure(when: Date) {
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: memberId,
    entity: "club_member", entityId: memberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron)",
    createdAt: when,
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 4242,
      mediaTablesPurged: { media: 1 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 2,
      objectStorageFilesFailedPaths: ["/objects/aaa", "/objects/bbb"],
      objectStorageDisabled: false,
    },
  });
}

async function insertRetryRow(opts: {
  when: Date;
  source: "cron_retry" | "controller_retry";
  failed: number;
  failedPaths: string[];
}) {
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: memberId,
    entity: "club_member", entityId: memberId, action: "delete",
    actorName: opts.source === "cron_retry" ? "system (cron auto-retry)" : "controller",
    reason: "retry",
    createdAt: opts.when,
    metadata: {
      source: opts.source, autoErasure: true, dataRequestId: 4242,
      mediaTablesPurged: {},
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: opts.failed,
      objectStorageFilesFailedPaths: opts.failedPaths,
      objectStorageDisabled: false,
      retryOfAuditId: null,
    },
  });
}

async function listAuditRows() {
  return db.select({
    id: memberAuditLogTable.id,
    createdAt: memberAuditLogTable.createdAt,
    metadata: memberAuditLogTable.metadata,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, testOrgId),
      eq(memberAuditLogTable.clubMemberId, memberId),
    ))
    .orderBy(sql`${memberAuditLogTable.createdAt} ASC`, sql`${memberAuditLogTable.id} ASC`);
}

/**
 * Row-scoped wrapper around `runStuckErasureAutoRetryPass` (Task
 * #1808 / #2266). Snapshots OUR member's audit-row state before the
 * global sweep runs, then derives the per-member summary by inspecting
 * the new audit rows the sweep wrote for our member.
 *
 *   - `retried`         — count of new `metadata.source = "cron_retry"` rows
 *   - `cappedNotified`  — count of new `metadata.source = "cron_capped_notification"` rows
 *   - `candidates`      — 1 iff our member's pre-sweep latest non-notification
 *                         audit row had `objectStorageFilesFailed > 0` AND
 *                         was not a `controller_acknowledgement` (which
 *                         resolves the candidacy)
 *   - `capped`          — 1 iff our member was a candidate, didn't retry,
 *                         and already had ≥5 consecutive `cron_retry`
 *                         entries since the last chain-reset row
 *   - `deferred`        — 1 iff our member was a candidate but neither
 *                         retried nor capped
 */
async function runStuckErasureAutoRetryPassRowScoped(now: Date): Promise<{
  candidates: number;
  retried: number;
  deferred: number;
  capped: number;
  cappedNotified: number;
}> {
  type Row = Awaited<ReturnType<typeof listAuditRows>>[number];
  const sourceOf = (r: Row) =>
    String(((r.metadata ?? {}) as Record<string, unknown>).source ?? "");

  const before = await listAuditRows();
  const beforeIds = new Set(before.map((r) => r.id));

  // Walk newest → oldest skipping cron_capped_notification markers (they
  // don't gate candidacy themselves) to find the latest substantive row.
  let latestSubstantive: Row | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    if (sourceOf(before[i]) === "cron_capped_notification") continue;
    latestSubstantive = before[i];
    break;
  }
  const candidate = !!latestSubstantive
    && sourceOf(latestSubstantive) !== "controller_acknowledgement"
    && Number(((latestSubstantive.metadata ?? {}) as Record<string, unknown>).objectStorageFilesFailed ?? 0) > 0
      ? 1 : 0;

  // Count consecutive `cron_retry` rows (newest-first) until we hit a
  // chain-reset row (controller_retry / controller_acknowledgement /
  // original `cron`). cron_capped_notification rows are skipped.
  let consecutiveCronRetries = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const src = sourceOf(before[i]);
    if (src === "cron_capped_notification") continue;
    if (src === "cron_retry") consecutiveCronRetries++;
    else break;
  }

  await runStuckErasureAutoRetryPassRowScoped(now);

  const after = await listAuditRows();
  const newRows = after.filter((r) => !beforeIds.has(r.id));
  const retried = newRows.filter((r) => sourceOf(r) === "cron_retry").length;
  const cappedNotified = newRows.filter((r) => sourceOf(r) === "cron_capped_notification").length;

  let capped = 0;
  let deferred = 0;
  if (candidate === 1 && retried === 0) {
    if (consecutiveCronRetries >= 5) capped = 1;
    else deferred = 1;
  }
  return { candidates: candidate, retried, deferred, capped, cappedNotified };
}

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AutoRetry_${ts}`,
    slug: `test-erasure-auto-retry-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId, firstName: "AutoRetry", lastName: "Subject",
    email: `auto-retry-${ts}@example.test`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  // Task #1244 — controllers who should receive the cap-reached alert.
  const [directAdmin] = await db.insert(appUsersTable).values({
    username: `auto-retry-admin-${ts}`,
    replitUserId: `auto-retry-admin-${ts}`,
    email: `auto-retry-admin-${ts}@example.com`,
    displayName: "Direct Admin",
    organizationId: testOrgId,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  directAdminUserId = directAdmin.id;

  const [secretary] = await db.insert(appUsersTable).values({
    username: `auto-retry-secretary-${ts}`,
    replitUserId: `auto-retry-secretary-${ts}`,
    email: `auto-retry-secretary-${ts}@example.com`,
    displayName: "Membership Secretary",
    organizationId: testOrgId,
    role: "player",
  }).returning({ id: appUsersTable.id });
  secretaryUserId = secretary.id;
  await db.insert(orgMembershipsTable).values({
    userId: secretaryUserId,
    organizationId: testOrgId,
    role: "membership_secretary",
  });
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendErasureAutoRetryCappedEmailMock.mockClear();
  await clearAuditRows();
});

describe("runStuckErasureAutoRetryPass", () => {
  it("defers retry while the initial backoff window is still open", async () => {
    const now = new Date();
    // Failed 30 minutes ago — first cron retry isn't due until +1h.
    await insertOriginalErasure(new Date(now.getTime() - 30 * 60 * 1000));

    const summary = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary.candidates).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.retried).toBe(0);

    const rows = await listAuditRows();
    expect(rows).toHaveLength(1);
  });

  it("invokes the retry helper once the first backoff window has elapsed and tags the new audit row as cron-driven", async () => {
    const now = new Date();
    // 90 minutes ago — past the 1h initial backoff.
    await insertOriginalErasure(new Date(now.getTime() - 90 * 60 * 1000));

    const summary = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary.retried).toBe(1);
    expect(summary.candidates).toBe(1);

    const rows = await listAuditRows();
    expect(rows).toHaveLength(2);
    const newest = rows[rows.length - 1];
    const md = (newest.metadata ?? {}) as Record<string, unknown>;
    expect(md.source).toBe("cron_retry");
    // Whatever the per-path outcome (depends on whether object storage is
    // configured in this env), the three counters must sum back to the 2
    // paths the original failure recorded.
    const dl = Number(md.objectStorageFilesDeleted ?? 0);
    const ms = Number(md.objectStorageFilesMissing ?? 0);
    const fl = Number(md.objectStorageFilesFailed ?? 0);
    expect(dl + ms + fl).toBe(2);
    expect(md.retryOfAuditId).toBe(rows[0].id);
  });

  it("stops retrying after the per-member attempt cap is reached and writes a controllers-notified marker", async () => {
    const now = new Date();
    // Original failure way in the past.
    await insertOriginalErasure(new Date(now.getTime() - 48 * HOUR));
    // 5 cron-driven retries already on file — at the cap.
    for (let i = 0; i < 5; i++) {
      await insertRetryRow({
        when: new Date(now.getTime() - (40 - i * 8) * HOUR),
        source: "cron_retry",
        failed: 2,
        failedPaths: ["/objects/aaa", "/objects/bbb"],
      });
    }
    const before = (await listAuditRows()).length;
    expect(before).toBe(6);

    const summary = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary.candidates).toBe(1);
    expect(summary.capped).toBe(1);
    expect(summary.retried).toBe(0);
    expect(summary.cappedNotified).toBe(1);

    // Task #1244 — first cap-hit writes a synthetic notification audit row
    // so the next pass can dedup; the row carries the failed counters
    // forward so dashboards / aggregators still surface the member.
    const after = await listAuditRows();
    expect(after).toHaveLength(before + 1);
    const newest = after[after.length - 1];
    const md = (newest.metadata ?? {}) as Record<string, unknown>;
    expect(md.source).toBe("cron_capped_notification");
    expect(md.attempts).toBe(5);
    expect(md.objectStorageFilesFailed).toBe(2);
    expect(md.objectStorageFilesFailedPaths).toEqual(["/objects/aaa", "/objects/bbb"]);

    // Re-running the cron does NOT add another notification row (dedup
    // via the marker walk-back) and does NOT bump cappedNotified again.
    const summary2 = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary2.capped).toBe(1);
    expect(summary2.cappedNotified).toBe(0);
    const after2 = await listAuditRows();
    expect(after2).toHaveLength(after.length);
  });

  it("re-arms the controller alert after a controller manual retry resets the chain", async () => {
    // Pass 1 anchored at "now1" — old failure with 5 cron retries already
    // burned, first cron tick hits the cap and writes the notification
    // marker (createdAt defaults to db `now()` ≈ real time).
    const now1 = new Date();
    await insertOriginalErasure(new Date(now1.getTime() - 96 * HOUR));
    for (let i = 0; i < 5; i++) {
      await insertRetryRow({
        when: new Date(now1.getTime() - (80 - i * 12) * HOUR),
        source: "cron_retry",
        failed: 2,
        failedPaths: ["/objects/aaa", "/objects/bbb"],
      });
    }
    const firstPass = await runStuckErasureAutoRetryPassRowScoped(now1);
    expect(firstPass.cappedNotified).toBe(1);
    expect(sendErasureAutoRetryCappedEmailMock).toHaveBeenCalled();

    sendTransactionalPushMock.mockClear();
    sendErasureAutoRetryCappedEmailMock.mockClear();

    // Pass 2 conceptually happens 30 days later — the controller manually
    // retried (still failed) AFTER the notification, then 5 fresh cron
    // retries piled up. Crucially, controller_retry + the new cron_retry
    // rows must be NEWER than the notification (which got a real-time
    // createdAt during pass 1) so the DESC walk-back hits BREAK at the
    // controller_retry without first stumbling over the marker.
    const now2 = new Date(now1.getTime() + 30 * 24 * HOUR);
    await insertRetryRow({
      when: new Date(now2.getTime() - 25 * HOUR),
      source: "controller_retry",
      failed: 2,
      failedPaths: ["/objects/aaa", "/objects/bbb"],
    });
    for (let i = 0; i < 5; i++) {
      await insertRetryRow({
        when: new Date(now2.getTime() - (20 - i * 4) * HOUR),
        source: "cron_retry",
        failed: 2,
        failedPaths: ["/objects/aaa", "/objects/bbb"],
      });
    }

    const secondPass = await runStuckErasureAutoRetryPassRowScoped(now2);
    expect(secondPass.capped).toBe(1);
    expect(secondPass.cappedNotified).toBe(1);
    // Push fanout + per-controller email both fire again because the
    // chain was reset by the manual retry.
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    expect(sendErasureAutoRetryCappedEmailMock).toHaveBeenCalledTimes(2);
  });

  it("fans the cap-reached alert out to direct admins + org-membership controllers, deep-linked to the per-member panel", async () => {
    const now = new Date();
    await insertOriginalErasure(new Date(now.getTime() - 96 * HOUR));
    for (let i = 0; i < 5; i++) {
      await insertRetryRow({
        when: new Date(now.getTime() - (80 - i * 12) * HOUR),
        source: "cron_retry",
        failed: 3,
        failedPaths: ["/objects/x", "/objects/y", "/objects/z"],
      });
    }

    await runStuckErasureAutoRetryPassRowScoped(now);

    // Single push call carrying both controller userIds (deduped).
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const pushUserIds = sendTransactionalPushMock.mock.calls[0]![0] as number[];
    expect(pushUserIds).toEqual(expect.arrayContaining([directAdminUserId, secretaryUserId]));
    expect(pushUserIds).toHaveLength(2);
    const pushPayload = sendTransactionalPushMock.mock.calls[0]![3] as Record<string, unknown>;
    expect(pushPayload.type).toBe("erasure_auto_retry_capped");
    expect(pushPayload.clubMemberId).toBe(memberId);
    expect(pushPayload.organizationId).toBe(testOrgId);
    expect(pushPayload.route).toBe(`/members/${memberId}?panel=erasure-history`);

    // One transactional email per controller, with the failed-path list
    // and a human-readable member label.
    expect(sendErasureAutoRetryCappedEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendErasureAutoRetryCappedEmailMock.mock.calls.map(
      c => (c[0] as { to: string }).to,
    );
    expect(recipients).toEqual(expect.arrayContaining([
      expect.stringMatching(/^auto-retry-admin-.+@example\.com$/),
      expect.stringMatching(/^auto-retry-secretary-.+@example\.com$/),
    ]));
    const emailArg = sendErasureAutoRetryCappedEmailMock.mock.calls[0]![0] as {
      clubMemberId: number;
      memberLabel: string;
      attempts: number;
      filesFailed: number;
      failedPaths: string[];
    };
    expect(emailArg.clubMemberId).toBe(memberId);
    expect(emailArg.memberLabel).toBe("AutoRetry Subject");
    expect(emailArg.attempts).toBe(5);
    expect(emailArg.filesFailed).toBe(3);
    expect(emailArg.failedPaths).toEqual(["/objects/x", "/objects/y", "/objects/z"]);
  });

  it("treats a controller retry as the boundary so the cron-attempt budget resets", async () => {
    const now = new Date();
    await insertOriginalErasure(new Date(now.getTime() - 72 * HOUR));
    // 4 cron retries, then a controller retry (still failed), then nothing.
    for (let i = 0; i < 4; i++) {
      await insertRetryRow({
        when: new Date(now.getTime() - (60 - i * 8) * HOUR),
        source: "cron_retry",
        failed: 2,
        failedPaths: ["/objects/aaa", "/objects/bbb"],
      });
    }
    // Controller retry 5h ago — this resets the cron budget.
    await insertRetryRow({
      when: new Date(now.getTime() - 5 * HOUR),
      source: "controller_retry",
      failed: 2,
      failedPaths: ["/objects/aaa", "/objects/bbb"],
    });

    const summary = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary.candidates).toBe(1);
    // attempts walks back from latest = controller_retry → breaks → 0.
    // 5h elapsed > the 1h initial backoff, so the helper fires.
    expect(summary.retried).toBe(1);
    expect(summary.capped).toBe(0);

    const rows = await listAuditRows();
    const newest = rows[rows.length - 1];
    const md = (newest.metadata ?? {}) as Record<string, unknown>;
    expect(md.source).toBe("cron_retry");
  });

  // ─── Task #1460 — controller acknowledgement ────────────────────────────
  // The acknowledgement helper writes a synthetic audit row tagged
  // `controller_acknowledgement` that the walk-back must treat as a chain
  // break (just like a controller_retry) — resetting the per-member retry
  // budget AND re-arming the cap alert so a future round of failures can
  // re-page controllers — but WITHOUT triggering a fresh storage purge
  // attempt (no `cron_retry` audit row should appear from the helper).
  it("acknowledgement resets the cron-attempt budget and re-arms the cap alert without retrying storage", async () => {
    // Pass 1: 5 cron retries already on file → cron tick fires the cap
    // alert and writes the notification marker.
    const now1 = new Date();
    await insertOriginalErasure(new Date(now1.getTime() - 96 * HOUR));
    for (let i = 0; i < 5; i++) {
      await insertRetryRow({
        when: new Date(now1.getTime() - (80 - i * 12) * HOUR),
        source: "cron_retry",
        failed: 2,
        failedPaths: ["/objects/aaa", "/objects/bbb"],
      });
    }
    const firstPass = await runStuckErasureAutoRetryPassRowScoped(now1);
    expect(firstPass.cappedNotified).toBe(1);

    sendTransactionalPushMock.mockClear();
    sendErasureAutoRetryCappedEmailMock.mockClear();

    // Controller acknowledges the alert with a free-text note. The helper
    // must NOT touch object storage — the row count goes from N to N+1
    // (one acknowledgement audit row), not N+2 (no piggyback retry row).
    const beforeAck = (await listAuditRows()).length;
    const ackResult = await acknowledgeStuckErasureForMember({
      organizationId: testOrgId,
      clubMemberId: memberId,
      actorUserId: directAdminUserId,
      actorName: "Direct Admin",
      note: "files retained on legal hold per ticket #1234",
    });
    expect(ackResult.acknowledgementAuditId).not.toBeNull();
    expect(ackResult.filesFailed).toBe(2);
    const rowsAfterAck = await listAuditRows();
    expect(rowsAfterAck).toHaveLength(beforeAck + 1);
    const ackRow = rowsAfterAck[rowsAfterAck.length - 1];
    const ackMd = (ackRow.metadata ?? {}) as Record<string, unknown>;
    expect(ackMd.source).toBe("controller_acknowledgement");
    expect(ackMd.autoErasure).toBe(true);
    // Failed-paths metadata is carried forward so the dashboard / cron
    // still has the same paths to act on once the chain reset re-arms.
    expect(ackMd.objectStorageFilesFailed).toBe(2);
    expect(ackMd.objectStorageFilesFailedPaths).toEqual(["/objects/aaa", "/objects/bbb"]);
    // The audit row records the controller's identity and the optional
    // note so the regulator-facing history can show why it was acked.
    expect(ackMd.acknowledgementNote).toBe("files retained on legal hold per ticket #1234");
    expect(ackMd.acknowledgedAuditId).toBe(rowsAfterAck[rowsAfterAck.length - 2].id);
    expect(ackRow.metadata).toBeTruthy();

    // Pass 2 immediately after the ack: chain is reset, but no backoff
    // has elapsed yet (1h initial budget) → should defer, NOT retry.
    const now2 = new Date(now1.getTime() + 30 * 1000);
    const secondPass = await runStuckErasureAutoRetryPassRowScoped(now2);
    expect(secondPass.candidates).toBe(1);
    expect(secondPass.deferred).toBe(1);
    expect(secondPass.retried).toBe(0);
    expect(secondPass.capped).toBe(0);
    expect(secondPass.cappedNotified).toBe(0);
    // No retry / new alert side effects from the deferred pass.
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
    expect(sendErasureAutoRetryCappedEmailMock).not.toHaveBeenCalled();

    // Pass 3 after the 1h initial backoff: chain is reset → cron drives
    // a fresh cron_retry, NOT another cap notification. The alert is
    // re-armed (we'd need 5 more cron_retry rows to re-page).
    const now3 = new Date(ackRow.createdAt!.getTime() + 90 * 60 * 1000);
    const thirdPass = await runStuckErasureAutoRetryPassRowScoped(now3);
    expect(thirdPass.retried).toBe(1);
    expect(thirdPass.capped).toBe(0);
    expect(thirdPass.cappedNotified).toBe(0);
    const finalRows = await listAuditRows();
    const newest = finalRows[finalRows.length - 1];
    const newestMd = (newest.metadata ?? {}) as Record<string, unknown>;
    expect(newestMd.source).toBe("cron_retry");
  });

  it("acknowledgement helper 404s (sourceAuditId=null) when no prior erasure is on file", async () => {
    const result = await acknowledgeStuckErasureForMember({
      organizationId: testOrgId,
      clubMemberId: memberId,
      actorUserId: directAdminUserId,
      actorName: "Direct Admin",
    });
    expect(result.sourceAuditId).toBeNull();
    expect(result.acknowledgementAuditId).toBeNull();
    expect(result.filesFailed).toBe(0);
  });

  it("ignores members whose latest erasure already cleared all storage failures", async () => {
    const now = new Date();
    await insertOriginalErasure(new Date(now.getTime() - 5 * HOUR));
    await insertRetryRow({
      when: new Date(now.getTime() - 1 * HOUR),
      source: "cron_retry",
      failed: 0,
      failedPaths: [],
    });

    const summary = await runStuckErasureAutoRetryPassRowScoped(now);
    expect(summary.candidates).toBe(0);
    expect(summary.retried).toBe(0);
  });
});
