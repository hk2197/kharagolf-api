/**
 * Task #2196 — CI coverage for the per-run paused-recipients snapshot
 * persisted onto `side_game_receipt_digest_runs.paused_recipients`.
 *
 * Mirrors the wallet auto-refund counterpart (Task #1759). The
 * `paused_recipients` jsonb column is the *historical* record of which
 * configured recipients the cron's bounce-aware filter dropped at the
 * moment a run executed. Without it, the dashboard's history table
 * would lose the chip the second support lifted the suppression — the
 * schedule-level chip is a live join, but past runs are immutable.
 *
 * The contract pinned here is what the dashboard panel
 * (`SideGameReceiptDigestSchedulePanel`) renders against:
 *
 *   1. A partial-suppression run records `{email, reason, bounceType,
 *      description}` for each pruned recipient and an empty array for
 *      survivors. The casing the treasurer typed in the schedule's
 *      recipients list is preserved (suppression matching is
 *      case-insensitive).
 *
 *   2. An all-suppressed run records every recipient (including the
 *      `manual` reason without a `bounceType`).
 *
 *   3. The "no recipients configured" early-exit branch records `[]`
 *      so the column stays non-null and the dashboard's defensive
 *      `pausedRecipients ?? []` fallback never has to kick in.
 *
 *   4. A clean run (no suppressions) records `[]`.
 *
 *   5. The schedule GET endpoint serializes the column on each history
 *      row so the React panel can read it without a follow-up fetch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendSideGameReceiptDigestEmail: vi.fn(async () => {}),
  };
});

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  sideGameReceiptDigestSchedulesTable,
  sideGameReceiptDigestRunsTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
  emailCtaSendStatsTable,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { runOneSideGameReceiptDigestSchedule } from "../routes/side-games-v2.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";
import { createTestApp, uid, type TestUser } from "./helpers.js";

let orgId: number;
let adminId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let scheduleId: number;

beforeAll(async () => {
  const tag = uid("t2196");
  const [org] = await db.insert(organizationsTable).values({
    name: `T2196 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Receipt Digest Snapshot Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = adminRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: adminId, role: "org_admin",
  });
  admin = {
    id: adminId,
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "side_game.receipt.digest.failed"));
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  // Clear our org's `email_cta_send_stats` rows before dropping the
  // org. The FK is `ON DELETE SET NULL` and the (notificationKey,
  // organizationId) unique constraint uses `nullsNotDistinct`, so
  // letting the cascade run can collide with a NULL row left behind by
  // a parallel test (e.g. `side-game-receipt-digest-failure.test.ts`)
  // that already inserted the same notification key.
  await db.delete(emailCtaSendStatsTable).where(eq(emailCtaSendStatsTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "side_game.receipt.digest.failed"));
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));

  const [s] = await db.insert(sideGameReceiptDigestSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    // Mixed casing so we can prove the snapshot preserves the
    // configured form even though the suppression table stores
    // lower-cased emails.
    recipients: ["Support@Example.Test", "ops@example.test"],
    nextRunAt: new Date(),
  }).returning({ id: sideGameReceiptDigestSchedulesTable.id });
  scheduleId = s.id;
});

async function loadLatestRun() {
  const [row] = await db
    .select()
    .from(sideGameReceiptDigestRunsTable)
    .where(eq(sideGameReceiptDigestRunsTable.scheduleId, scheduleId))
    .orderBy(desc(sideGameReceiptDigestRunsTable.sentAt))
    .limit(1);
  return row;
}

describe("Task #2196 — side-game receipt digest paused-recipients snapshot column", () => {
  it("records a per-recipient {email, reason, bounceType, description} snapshot when a single recipient is suppressed and writes [] for clean runs", async () => {
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: "ops@example.test",
      reason: "bounced",
      bounceType: "HardBounce",
      description: "550 mailbox does not exist",
    });

    const result = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["Support@Example.Test"]);
    expect(result.pausedRecipients).toEqual(["ops@example.test"]);

    const run = await loadLatestRun();
    expect(run.pausedRecipients).toEqual([
      {
        email: "ops@example.test",
        reason: "bounced",
        bounceType: "HardBounce",
        description: "550 mailbox does not exist",
      },
    ]);

    // Clear suppression and re-run: snapshot should now be [] on the
    // brand-new row even though an earlier row still carries the
    // historical record. Proves the snapshot is per-run, not joined.
    await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
    // Re-add the recipient that was pruned out by the previous run
    // (the cron removes paused recipients from the schedule).
    await db.update(sideGameReceiptDigestSchedulesTable)
      .set({ recipients: ["Support@Example.Test", "ops@example.test"] })
      .where(eq(sideGameReceiptDigestSchedulesTable.id, scheduleId));

    const second = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(second.status).toBe("sent");
    const cleanRun = await loadLatestRun();
    expect(cleanRun.pausedRecipients).toEqual([]);
  });

  it("records every paused recipient (including a manual suppression with no bounceType) on an all-suppressed run", async () => {
    await db.insert(emailSuppressionsTable).values([
      {
        organizationId: orgId,
        email: "support@example.test",
        reason: "bounced",
        bounceType: "HardBounce",
      },
      {
        organizationId: orgId,
        email: "ops@example.test",
        reason: "manual",
        bounceType: null,
        description: null,
      },
    ]);

    const result = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(result.status).toBe("skipped");
    expect(result.recipients).toEqual([]);

    const run = await loadLatestRun();
    const snap = (run.pausedRecipients ?? []).slice().sort((a, b) => a.email.localeCompare(b.email));
    expect(snap).toEqual([
      {
        email: "ops@example.test",
        reason: "manual",
        bounceType: null,
        description: null,
      },
      {
        // Original-cased form preserved.
        email: "Support@Example.Test",
        reason: "bounced",
        bounceType: "HardBounce",
        description: null,
      },
    ]);
  });

  it("writes an empty array for the no-recipients-configured early-exit branch so the column is always populated", async () => {
    await db.update(sideGameReceiptDigestSchedulesTable)
      .set({ recipients: [] })
      .where(eq(sideGameReceiptDigestSchedulesTable.id, scheduleId));

    const result = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toBe("no recipients configured");

    const run = await loadLatestRun();
    expect(run.pausedRecipients).toEqual([]);
  });

  it("returns the snapshot on each history row from GET /admin/side-game-receipt-failures/email-schedule so the dashboard can render the chip", async () => {
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: "ops@example.test",
      reason: "spam_complaint",
      bounceType: "SpamComplaint",
      description: "user marked as spam",
    });

    await runOneSideGameReceiptDigestSchedule(scheduleId);

    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
    expect(res.body.history.length).toBeGreaterThanOrEqual(1);
    const latest = res.body.history[0];
    expect(latest.pausedRecipients).toEqual([
      {
        email: "ops@example.test",
        reason: "spam_complaint",
        bounceType: "SpamComplaint",
        description: "user marked as spam",
      },
    ]);
  });
});
