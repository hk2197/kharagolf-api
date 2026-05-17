/**
 * Task #1761 — CI coverage for the auto-refund digest's paused-recipients
 * dashboard surface (Task #1443).
 *
 * The Task #1443 work was previously verified end-to-end via a one-shot
 * Playwright run; nothing committed exercised the new GET payload field,
 * the unsuppress endpoint, or the schedule-restore behaviour. A regression
 * in the bounce-aware filter or a typo in the response shape would slip
 * through CI silently until finance noticed an empty digest. This file
 * pins the contracts the editor depends on:
 *
 *   1. GET /api/admin/wallet-topup-refunds/email-schedule returns a
 *      `pausedRecipients` array — empty when no recipients are
 *      suppressed, and populated with one row per suppressed address
 *      (preserving the casing the treasurer typed in the recipients
 *      list, but matched against the lower-cased suppression row).
 *
 *   2. PUT /api/admin/wallet-topup-refunds/email-schedule echoes the
 *      same shape so the editor can warn finance the moment they save
 *      a recipient that's already suppressed — no need to wait for the
 *      next dashboard refresh.
 *
 *   3. POST /api/admin/wallet-topup-refunds/email-schedule/unsuppress
 *      deletes the matching `email_suppressions` row and, when the
 *      address had been pruned out of the schedule by an earlier cron
 *      run, restores it to the configured recipients list. Subsequent
 *      GETs no longer include the address in `pausedRecipients`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
  emailSuppressionsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers.js";

let orgId: number;
let otherOrgId: number;
let adminId: number;
let otherAdminId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const SCHEDULE_BASE = "/api/admin/wallet-topup-refunds/email-schedule";

beforeAll(async () => {
  const tag = uid("t1761");

  const [org] = await db.insert(organizationsTable).values({
    name: `T1761 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // A separate org so we can assert suppression rows in another tenant
  // are not surfaced through this org's GET.
  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `T1761 other ${tag}`,
    slug: `${tag}-other`,
    contactEmail: `${tag}-other@example.test`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Treasurer Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = adminRow.id;

  const [otherAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-other-admin`,
    username: `${tag}_other_admin`,
    email: `admin_other_${tag}@example.test`,
    displayName: "Other Treasurer",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherAdminId = otherAdminRow.id;

  admin = {
    id: adminId,
    username: `${tag}_admin`,
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  await db.delete(walletTopupRefundEmailRunsTable)
    .where(inArray(walletTopupRefundEmailRunsTable.organizationId, [orgId, otherOrgId]));
  await db.delete(walletTopupRefundEmailSchedulesTable)
    .where(inArray(walletTopupRefundEmailSchedulesTable.organizationId, [orgId, otherOrgId]));
  await db.delete(emailSuppressionsTable)
    .where(inArray(emailSuppressionsTable.organizationId, [orgId, otherOrgId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, otherAdminId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId, otherOrgId]));
});

beforeEach(async () => {
  await db.delete(walletTopupRefundEmailRunsTable)
    .where(inArray(walletTopupRefundEmailRunsTable.organizationId, [orgId, otherOrgId]));
  await db.delete(walletTopupRefundEmailSchedulesTable)
    .where(inArray(walletTopupRefundEmailSchedulesTable.organizationId, [orgId, otherOrgId]));
  await db.delete(emailSuppressionsTable)
    .where(inArray(emailSuppressionsTable.organizationId, [orgId, otherOrgId]));
});

interface PausedRecipientRow {
  suppressionId: number;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
}

describe("Task #1761 — paused-recipients dashboard contract", () => {
  it("GET returns an empty pausedRecipients array when no schedule is configured", async () => {
    const res = await request(app)
      .get(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.schedule).toBeNull();
    expect(res.body.pausedRecipients).toEqual([]);
  });

  it("GET returns an empty pausedRecipients array when none of the saved recipients are on the suppression list", async () => {
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.test", "treasurer@example.test"],
      nextRunAt: new Date(),
    });

    const res = await request(app)
      .get(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.schedule).not.toBeNull();
    expect(res.body.pausedRecipients).toEqual([]);
  });

  it("GET surfaces suppression metadata only for the suppressed recipients (case-insensitive match, original casing preserved)", async () => {
    // Treasurer typed the recipient in mixed case. The bounce webhook
    // always stores `email_suppressions.email` lower-cased, so the join
    // must be case-insensitive — but the returned row should preserve
    // the casing the treasurer typed, so the warning row matches the
    // textarea.
    const mixedCase = "Finance@Example.Test";
    const cleanRecipient = "treasurer@example.test";
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [mixedCase, cleanRecipient],
      nextRunAt: new Date(),
    });

    // Suppression for the mixed-case recipient (lower-cased on the
    // suppression side, as the webhook does).
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: mixedCase.toLowerCase(),
      reason: "bounced",
      bounceType: "HardBounce",
      description: "The recipient's mailbox does not exist",
    });

    // A suppression for a different org but the same address should
    // NOT bleed into this org's response (organizationId scoping).
    await db.insert(emailSuppressionsTable).values({
      organizationId: otherOrgId,
      email: mixedCase.toLowerCase(),
      reason: "spam_complaint",
    });

    const res = await request(app)
      .get(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .expect(200);

    const paused = res.body.pausedRecipients as PausedRecipientRow[];
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      email: mixedCase,
      reason: "bounced",
      bounceType: "HardBounce",
      description: "The recipient's mailbox does not exist",
    });
    expect(typeof paused[0].suppressionId).toBe("number");
    expect(typeof paused[0].createdAt).toBe("string");
  });

  it("PUT echoes pausedRecipients so the editor warns immediately on save without waiting for the next refresh", async () => {
    const suppressed = "bounced@example.test";
    const fresh = "treasurer@example.test";
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: suppressed,
      reason: "unsubscribed",
    });

    const res = await request(app)
      .put(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .send({
        frequency: "weekly",
        recipients: [suppressed, fresh],
        enabled: true,
      })
      .expect(200);

    expect(res.body.schedule.recipients).toEqual([suppressed, fresh]);
    const paused = res.body.pausedRecipients as PausedRecipientRow[];
    expect(paused).toHaveLength(1);
    expect(paused[0].email).toBe(suppressed);
    expect(paused[0].reason).toBe("unsubscribed");
  });

  it("POST /unsuppress deletes the matching suppression row and clears the address from the next GET's pausedRecipients", async () => {
    const recipient = "fixed-inbox@example.test";
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [recipient],
      nextRunAt: new Date(),
    });
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: recipient,
      reason: "bounced",
      bounceType: "Transient",
    });

    const before = await request(app)
      .get(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .expect(200);
    expect(before.body.pausedRecipients).toHaveLength(1);

    const unsuppress = await request(app)
      .post(`${SCHEDULE_BASE}/unsuppress?organizationId=${orgId}`)
      .send({ email: recipient })
      .expect(200);
    expect(unsuppress.body).toMatchObject({
      ok: true,
      removed: 1,
      // Recipient was already on the schedule's recipients list, so the
      // restore-to-schedule branch must not trigger.
      restoredToSchedule: false,
    });

    // Suppression row really gone.
    const remaining = await db.select().from(emailSuppressionsTable)
      .where(and(
        eq(emailSuppressionsTable.organizationId, orgId),
        eq(emailSuppressionsTable.email, recipient),
      ));
    expect(remaining).toHaveLength(0);

    // And the dashboard's chip count drops to zero on the next refresh.
    const after = await request(app)
      .get(`${SCHEDULE_BASE}?organizationId=${orgId}`)
      .expect(200);
    expect(after.body.pausedRecipients).toEqual([]);

    // Schedule's recipients list is unchanged — the address was already
    // there, so we must not have appended a duplicate.
    expect(after.body.schedule.recipients).toEqual([recipient]);
  });

  it("POST /unsuppress restores a previously-pruned recipient back onto the schedule's recipients list", async () => {
    // Simulate the Task #1233 auto-pause: the cron previously ran,
    // detected the recipient was on the suppression list, and pruned
    // it out of the schedule's stored recipients. The address is on
    // the suppression table but NOT on the schedule.
    const pruned = "pruned-then-fixed@example.test";
    const stillThere = "treasurer@example.test";
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      // `pruned` deliberately absent — the cron already removed it.
      recipients: [stillThere],
      nextRunAt: new Date(),
    });
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: pruned,
      reason: "bounced",
      bounceType: "BadMailbox",
    });

    const res = await request(app)
      .post(`${SCHEDULE_BASE}/unsuppress?organizationId=${orgId}`)
      .send({ email: pruned })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      removed: 1,
      restoredToSchedule: true,
    });

    // Schedule now contains the restored address so finance doesn't
    // have to re-type it after fixing the inbox.
    const [sched] = await db.select().from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
    expect(sched.recipients).toEqual([stillThere, pruned]);
  });

  it("POST /unsuppress rejects missing or malformed emails with a 400", async () => {
    await request(app)
      .post(`${SCHEDULE_BASE}/unsuppress?organizationId=${orgId}`)
      .send({})
      .expect(400);

    await request(app)
      .post(`${SCHEDULE_BASE}/unsuppress?organizationId=${orgId}`)
      .send({ email: "not-an-email" })
      .expect(400);
  });
});
