/**
 * Tests for the levy-ledger schedule "paused recipients" surface (Task #1763).
 *
 * Covers, for both the per-levy and the org-wide combined schedule:
 *   - GET returns `pausedRecipients` rows for any configured recipient that
 *     is currently on `email_suppressions` (case-insensitive match)
 *   - GET omits suppressions for *other* orgs and addresses not in the
 *     schedule's recipients list
 *   - PUT echoes `pausedRecipients` so the editor can warn immediately on
 *     save without waiting for a refresh
 *   - POST `/unsuppress` validates the email, deletes the suppression
 *     scoped to (org, lower(email)) only, and re-adds the address to the
 *     schedule's recipients list when Task #1444's bounce-aware filter
 *     had previously pruned it out
 *   - POST `/unsuppress` does NOT touch suppressions belonging to other
 *     orgs (defense in depth against cross-tenant unsuppress)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  memberLeviesTable,
  levyLedgerEmailSchedulesTable,
  levyLedgerEmailRunsTable,
  levyLedgerEmailOrgSchedulesTable,
  levyLedgerEmailOrgRunsTable,
  emailSuppressionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let otherOrgId: number;
let testUserId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
const levyIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function makeLevy(name = "Annual"): Promise<number> {
  const [l] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  levyIds.push(l.id);
  return l.id;
}

async function suppress(orgId: number, email: string, opts: {
  reason?: string; bounceType?: string | null; description?: string | null;
} = {}): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "permanent",
    description: opts.description ?? "smtp 550 5.1.1 user unknown",
  }).returning({ id: emailSuppressionsTable.id });
  return row.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LedgerPaused_${stamp}`,
    slug: `test-ledger-paused-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `TestOrg_LedgerPaused_Other_${stamp}`,
    slug: `test-ledger-paused-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-ledger-paused-${stamp}`,
    username: `test_ledger_paused_admin_${stamp}`,
    email: `ledger_paused_admin_${stamp}@example.com`,
    displayName: "Ledger Paused Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  admin = {
    id: testUserId,
    username: `test_ledger_paused_admin_${stamp}`,
    displayName: "Ledger Paused Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  for (const id of levyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  if (testOrgId) {
    await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, testOrgId));
    await db.delete(levyLedgerEmailOrgSchedulesTable).where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, testOrgId));
  }
  if (otherOrgId) {
    await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, otherOrgId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
  if (otherOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
  }
});

beforeEach(async () => {
  // Wipe any suppression rows leftover from prior tests so each test
  // starts from a known empty state.
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, testOrgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, otherOrgId));
});

// ─────────────────────────────────────────────────────────────────────────
// Per-levy schedule: GET / PUT / POST unsuppress
// ─────────────────────────────────────────────────────────────────────────
describe("Per-levy schedule paused recipients (Task #1763)", () => {
  it("GET returns pausedRecipients only for configured addresses on this org's suppression list", async () => {
    const levyId = await makeLevy();
    await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["Bouncy@Example.COM", "ok@example.com"],
      });

    // Bouncy is suppressed in this org (note casing differs from the
    // recipient list to prove the join is case-insensitive).
    await suppress(testOrgId, "bouncy@example.com", { reason: "bounced", bounceType: "permanent" });
    // Ghost is suppressed but NOT on the recipients list — must be
    // omitted from the response.
    await suppress(testOrgId, "ghost@example.com");
    // Bouncy is also suppressed on a different org — must NOT leak in.
    await suppress(otherOrgId, "bouncy@example.com", { reason: "spam_complaint" });

    const res = await request(app).get(`${BASE()}/levies/${levyId}/email-schedule`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pausedRecipients)).toBe(true);
    expect(res.body.pausedRecipients).toHaveLength(1);

    const row = res.body.pausedRecipients[0];
    // The returned email preserves the casing the admin typed into the
    // recipients list, not the lower-cased suppression row, so the
    // warning matches what they see in the textarea.
    expect(row.email).toBe("Bouncy@Example.COM");
    expect(row.reason).toBe("bounced");
    expect(row.bounceType).toBe("permanent");
    expect(row.description).toMatch(/smtp 550/);
    expect(typeof row.suppressionId).toBe("number");
    expect(typeof row.createdAt).toBe("string");
  });

  it("PUT echoes pausedRecipients for just-saved recipients", async () => {
    const levyId = await makeLevy();
    await suppress(testOrgId, "bad@example.com");

    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["bad@example.com", "good@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.pausedRecipients).toHaveLength(1);
    expect(res.body.pausedRecipients[0].email).toBe("bad@example.com");
    expect(res.body.pausedRecipients[0].reason).toBe("bounced");
  });

  it("POST /unsuppress validates the email", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .post(`${BASE()}/levies/${levyId}/email-schedule/unsuppress`)
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("POST /unsuppress lifts the suppression scoped to this org only", async () => {
    const levyId = await makeLevy();
    await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["bouncy@example.com"] });
    await suppress(testOrgId, "bouncy@example.com");
    const otherSuppressionId = await suppress(otherOrgId, "bouncy@example.com");

    const res = await request(app)
      .post(`${BASE()}/levies/${levyId}/email-schedule/unsuppress`)
      .send({ email: "bouncy@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.removed).toBe(1);
    // No need to restore — the address was still on the recipients list.
    expect(res.body.restoredToSchedule).toBe(false);

    // This org's suppression is gone…
    const remaining = await db.select().from(emailSuppressionsTable)
      .where(and(
        eq(emailSuppressionsTable.organizationId, testOrgId),
        eq(emailSuppressionsTable.email, "bouncy@example.com"),
      ));
    expect(remaining).toHaveLength(0);

    // …but the other org's identical suppression must be untouched.
    const stillThere = await db.select().from(emailSuppressionsTable)
      .where(eq(emailSuppressionsTable.id, otherSuppressionId));
    expect(stillThere).toHaveLength(1);
  });

  it("POST /unsuppress restores an address that Task #1444 had pruned from the schedule", async () => {
    const levyId = await makeLevy();
    // Simulate the post-cron state: Task #1444 pruned the bounced address
    // out of the schedule's recipients list, so only the good one remains.
    await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["good@example.com"] });
    await suppress(testOrgId, "previously-bounced@example.com");

    const res = await request(app)
      .post(`${BASE()}/levies/${levyId}/email-schedule/unsuppress`)
      .send({ email: "previously-bounced@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.restoredToSchedule).toBe(true);

    const [sched] = await db.select().from(levyLedgerEmailSchedulesTable)
      .where(and(
        eq(levyLedgerEmailSchedulesTable.organizationId, testOrgId),
        eq(levyLedgerEmailSchedulesTable.levyId, levyId),
      ));
    expect(sched.recipients).toContain("previously-bounced@example.com");
    expect(sched.recipients).toContain("good@example.com");
  });

  // ─── Run-snapshot sourcing (Task #1763, post-rejection fix) ─────────────
  // Once Task #1444's cron prunes a bounced address out of
  // `schedule.recipients`, the dashboard can't see it via the live
  // suppression-vs-recipients intersection any more. The cron now persists
  // the full pause snapshot onto the run row, and the GET endpoint unions
  // that snapshot with the live list — these tests pin that contract down.

  it("GET surfaces an address pruned from saved recipients via the latest run's pausedRecipients snapshot", async () => {
    const levyId = await makeLevy();
    // Schedule no longer has the bounced address (the cron pruned it);
    // saved recipients only have the surviving good address.
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["survivor@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    // Suppression row is still present (admin hasn't lifted it).
    await suppress(testOrgId, "pruned@example.com", { reason: "bounced", bounceType: "permanent", description: "smtp 550 user unknown" });

    // Most recent run has a snapshot capturing the pruned recipient with
    // the metadata the cron observed at send time.
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId,
      organizationId: testOrgId,
      periodEnd: new Date(),
      recipients: ["survivor@example.com"],
      rowCount: 0,
      status: "sent",
      pausedRecipients: [{
        email: "Pruned@Example.com",
        reason: "bounced",
        bounceType: "permanent",
        description: "smtp 550 user unknown",
      }],
    });

    const res = await request(app).get(`${BASE()}/levies/${levyId}/email-schedule`);
    expect(res.status).toBe(200);
    expect(res.body.pausedRecipients).toHaveLength(1);
    const row = res.body.pausedRecipients[0];
    expect(row.email.toLowerCase()).toBe("pruned@example.com");
    expect(row.reason).toBe("bounced");
    expect(row.bounceType).toBe("permanent");
    // Live suppression still exists, so we get a real suppressionId and
    // the unsuppress button can do its job. `fromRunSnapshot` is true
    // because the address is no longer on `schedule.recipients`.
    expect(typeof row.suppressionId).toBe("number");
    expect(row.fromRunSnapshot).toBe(true);
  });

  it("GET still shows snapshot-only paused recipients after the suppression itself is lifted", async () => {
    const levyId = await makeLevy();
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["survivor@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    // Snapshot from the most recent run — but the suppression row has
    // since been removed (e.g. by a previous unsuppress click).
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId,
      organizationId: testOrgId,
      periodEnd: new Date(),
      recipients: ["survivor@example.com"],
      rowCount: 0,
      status: "sent",
      pausedRecipients: [{
        email: "lifted@example.com",
        reason: "spam_complaint",
        bounceType: null,
        description: null,
      }],
    });

    const res = await request(app).get(`${BASE()}/levies/${levyId}/email-schedule`);
    expect(res.status).toBe(200);
    expect(res.body.pausedRecipients).toHaveLength(1);
    const row = res.body.pausedRecipients[0];
    expect(row.email).toBe("lifted@example.com");
    expect(row.reason).toBe("spam_complaint");
    // No live suppression row → no id, frontend hides the unsuppress
    // button (there's nothing to remove).
    expect(row.suppressionId).toBeNull();
    expect(row.fromRunSnapshot).toBe(true);
  });

  it("GET de-duplicates paused recipients across the live list and the snapshot", async () => {
    const levyId = await makeLevy();
    // Recipient is *both* on the saved list AND on the snapshot — must
    // appear once, with live suppression metadata winning.
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["dup@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;
    await suppress(testOrgId, "dup@example.com", { reason: "bounced", bounceType: "permanent" });
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId,
      organizationId: testOrgId,
      periodEnd: new Date(),
      recipients: [],
      rowCount: 0,
      status: "skipped",
      errorMessage: "all paused",
      pausedRecipients: [{
        email: "dup@example.com",
        reason: "stale_snapshot_reason",
        bounceType: "transient",
        description: null,
      }],
    });

    const res = await request(app).get(`${BASE()}/levies/${levyId}/email-schedule`);
    expect(res.status).toBe(200);
    expect(res.body.pausedRecipients).toHaveLength(1);
    const row = res.body.pausedRecipients[0];
    expect(row.email).toBe("dup@example.com");
    // Live suppression metadata wins on conflict (newer than the
    // snapshot, which the cron froze at the moment of the past run).
    expect(row.reason).toBe("bounced");
    expect(row.bounceType).toBe("permanent");
    expect(row.fromRunSnapshot).toBe(false);
    expect(typeof row.suppressionId).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Org-wide combined schedule
// ─────────────────────────────────────────────────────────────────────────
describe("Org-wide combined ledger schedule paused recipients (Task #1763)", () => {
  it("GET + PUT return pausedRecipients; POST /unsuppress restores pruned recipients", async () => {
    // Create the org-wide schedule with two recipients, one of which is
    // suppressed in *another* org (must not match) and one which is
    // genuinely paused on this org.
    await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "monthly",
        deliveryFormat: "combined",
        recipients: ["treasurer@club.example", "secretary@club.example"],
      });
    await suppress(testOrgId, "treasurer@club.example", { reason: "unsubscribed", bounceType: null });
    await suppress(otherOrgId, "secretary@club.example");

    const getRes = await request(app).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.pausedRecipients).toHaveLength(1);
    expect(getRes.body.pausedRecipients[0].email).toBe("treasurer@club.example");
    expect(getRes.body.pausedRecipients[0].reason).toBe("unsubscribed");

    // PUT should echo the same paused list.
    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "monthly",
        deliveryFormat: "combined",
        recipients: ["treasurer@club.example", "secretary@club.example"],
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.pausedRecipients).toHaveLength(1);

    // Now unsuppress: the address is still on the recipients list, so
    // restoredToSchedule should be false.
    const unsupRes = await request(app)
      .post(`${BASE()}/levy-ledger/email-schedule/unsuppress`)
      .send({ email: "treasurer@club.example" });
    expect(unsupRes.status).toBe(200);
    expect(unsupRes.body.removed).toBe(1);
    expect(unsupRes.body.restoredToSchedule).toBe(false);
  });

  it("POST /unsuppress on the org schedule re-adds an address Task #1444 had pruned", async () => {
    await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        deliveryFormat: "combined",
        recipients: ["secretary@club.example"],
      });
    await suppress(testOrgId, "treasurer@club.example", { reason: "spam_complaint" });

    const res = await request(app)
      .post(`${BASE()}/levy-ledger/email-schedule/unsuppress`)
      .send({ email: "treasurer@club.example" });
    expect(res.status).toBe(200);
    expect(res.body.restoredToSchedule).toBe(true);

    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, testOrgId));
    expect(sched.recipients).toContain("treasurer@club.example");
    expect(sched.recipients).toContain("secretary@club.example");
  });

  it("GET surfaces org-wide pruned recipients via the latest run snapshot", async () => {
    // Schedule's saved recipients no longer contain the bounced address
    // because Task #1444's cron pruned it; the run-history snapshot is
    // the only place it survives.
    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        deliveryFormat: "combined",
        recipients: ["committee@club.example"],
      });
    const scheduleId = putRes.body.schedule.id as number;
    await suppress(testOrgId, "captain@club.example", { reason: "bounced", bounceType: "permanent" });

    await db.insert(levyLedgerEmailOrgRunsTable).values({
      scheduleId,
      organizationId: testOrgId,
      periodEnd: new Date(),
      recipients: ["committee@club.example"],
      rowCount: 0,
      levyCount: 0,
      status: "sent",
      pausedRecipients: [{
        email: "captain@club.example",
        reason: "bounced",
        bounceType: "permanent",
        description: null,
      }],
    });

    const getRes = await request(app).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.pausedRecipients).toHaveLength(1);
    const row = getRes.body.pausedRecipients[0];
    expect(row.email).toBe("captain@club.example");
    expect(row.fromRunSnapshot).toBe(true);
    expect(typeof row.suppressionId).toBe("number");
  });
});
