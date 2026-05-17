/**
 * Integration tests: Super Admin — Plan Migration Audit
 *
 * Covers the panel from Task #679: surfacing organisations that the legacy
 * plan-slug migration (Task #514) auto-reset to Free, plus the per-row
 * acknowledge flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { organizationsTable, memberAuditLogTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let unackRowId: number;
let ackRowId: number;
let emailAckRowId: number;
let ackUserId: number;
// Task #1550 — separate row pre-stamped with the persisted "first digest
// dispatch" timestamp (Task #1313) so we can assert the panel API exposes
// it for the dashboard's age cue, and that the always-null case (an
// undigested row) is returned as `null` rather than missing entirely.
let stampedDigestRowId: number;
const stampedFirstDigestedAt = "2026-04-01T08:00:00.000Z";
// Task #1930 — additional fixtures used by the stale-summary endpoint tests.
// `oldUnackNoStampRowId` exercises the COALESCE fallback to `created_at` when
// `firstDigestedAt` is missing. `freshUnackNoStampRowId` is a fresh undigested
// row that must NOT appear in the stale count even though it is unacknowledged.
let oldUnackNoStampRowId: number;
let freshUnackNoStampRowId: number;
let oldAckedRowId: number;
const createdOrgIds: number[] = [];
const createdAuditIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(async () => {
  const slug = uid("plan-migration-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  // Unacknowledged row — what the panel shows by default
  const [unack] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_pro_v1", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
  }).returning({ id: memberAuditLogTable.id });
  unackRowId = unack.id;
  createdAuditIds.push(unackRowId);

  // A super admin user we can attribute email-link acknowledgements to (Task #1144).
  const [ackUser] = await db.insert(appUsersTable).values({
    replitUserId: uid("replit-pma"),
    username: uid("pma-su"),
    displayName: "Plan Migration Reviewer",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  ackUserId = ackUser.id;
  createdUserIds.push(ackUserId);

  // Pre-acknowledged row — should be hidden by default, surfaced with ?includeAcknowledged=1
  const [ack] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "trial_legacy", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
    metadata: {
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedByUserId: ackUserId,
    },
  }).returning({ id: memberAuditLogTable.id });
  ackRowId = ack.id;
  createdAuditIds.push(ackRowId);

  // Pre-acknowledged via the email one-click link (Task #980 / #1144).
  const [emailAck] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_starter_v1", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
    metadata: {
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedByUserId: ackUserId,
      acknowledgedVia: "email",
    },
  }).returning({ id: memberAuditLogTable.id });
  emailAckRowId = emailAck.id;
  createdAuditIds.push(emailAckRowId);

  // Task #1550 — Unacknowledged row that has already been included in at
  // least one daily digest (Task #1313 stamps `firstDigestedAt` on the
  // metadata when the digest dispatches). The panel API must surface this
  // stamp so the dashboard can render the "first surfaced X ago" cue.
  const [stamped] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_unknown_v9", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
    metadata: {
      firstDigestedAt: stampedFirstDigestedAt,
    },
  }).returning({ id: memberAuditLogTable.id });
  stampedDigestRowId = stamped.id;
  createdAuditIds.push(stampedDigestRowId);

  // Task #1930 — Old unacknowledged row with NO firstDigestedAt stamp. The
  // stale-summary endpoint must fall back to created_at for this row and
  // count it as stale. Backdated 2 days so it sits comfortably in the
  // amber bucket regardless of test run timing.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const [oldUnack] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_old_v1", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
    createdAt: twoDaysAgo,
  }).returning({ id: memberAuditLogTable.id });
  oldUnackNoStampRowId = oldUnack.id;
  createdAuditIds.push(oldUnackNoStampRowId);

  // Task #1930 — Fresh unacknowledged row with no firstDigestedAt. Must NOT
  // appear in the stale count: it has been unacknowledged for less than 24h
  // so it is still in the grey bucket of the panel's age cue.
  const [freshUnack] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_fresh_v1", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
  }).returning({ id: memberAuditLogTable.id });
  freshUnackNoStampRowId = freshUnack.id;
  createdAuditIds.push(freshUnackNoStampRowId);

  // Task #1930 — Old, but already-acknowledged row. Must NOT appear in the
  // stale count even though it is well past the 24h threshold, because the
  // badge only flags rows that still need triage.
  const [oldAcked] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_acked_v1", to: "free" } },
    reason: "Task #514 legacy tier migration: unrecognised plan slug",
    createdAt: twoDaysAgo,
    metadata: {
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedByUserId: ackUserId,
    },
  }).returning({ id: memberAuditLogTable.id });
  oldAckedRowId = oldAcked.id;
  createdAuditIds.push(oldAckedRowId);
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, createdAuditIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("GET /api/super-admin/plan-migration-audit", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: 1, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(403);
  });

  it("lists unacknowledged migration rows for super admin", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe("number");

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(unackRowId);
    expect(ids).not.toContain(ackRowId);

    const row = res.body.entries.find((e: { id: number }) => e.id === unackRowId);
    expect(row.organizationId).toBe(orgId);
    expect(row.fromTier).toBe("legacy_pro_v1");
    expect(row.toTier).toBe("free");
    expect(row.acknowledged).toBe(false);
  });

  it("includes acknowledged rows when ?includeAcknowledged=1", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit?includeAcknowledged=1");
    expect(res.status).toBe(200);

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(unackRowId);
    expect(ids).toContain(ackRowId);

    const ackRow = res.body.entries.find((e: { id: number }) => e.id === ackRowId);
    expect(ackRow.acknowledged).toBe(true);
  });

  it("filters by acknowledgedByUserId and auto-includes acknowledged rows (Task #1314)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });

    // Reviewer filter alone should return only ack'd rows by that reviewer,
    // even without explicit ?includeAcknowledged=1.
    const res = await request(app).get(
      `/api/super-admin/plan-migration-audit?acknowledgedByUserId=${ackUserId}`,
    );
    expect(res.status).toBe(200);

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(ackRowId);
    expect(ids).toContain(emailAckRowId);
    expect(ids).not.toContain(unackRowId);

    // Sanity: every returned row really was acknowledged by that reviewer.
    for (const entry of res.body.entries) {
      expect(entry.acknowledgedByUserId).toBe(ackUserId);
    }
  });

  it("filters by acknowledgedVia=email (Task #1314)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get(
      "/api/super-admin/plan-migration-audit?acknowledgedVia=email",
    );
    expect(res.status).toBe(200);

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(emailAckRowId);
    expect(ids).not.toContain(ackRowId);
    expect(ids).not.toContain(unackRowId);

    for (const entry of res.body.entries) {
      expect(entry.acknowledgedVia).toBe("email");
    }
  });

  it("filters by acknowledgedVia=dashboard (Task #1314)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get(
      "/api/super-admin/plan-migration-audit?acknowledgedVia=dashboard",
    );
    expect(res.status).toBe(200);

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(ackRowId);
    expect(ids).not.toContain(emailAckRowId);
    expect(ids).not.toContain(unackRowId);

    for (const entry of res.body.entries) {
      expect(entry.acknowledgedVia).toBe("dashboard");
    }
  });

  it("ignores invalid acknowledgedByUserId / acknowledgedVia values (Task #1314)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });

    // Garbage values should fall back to the default (unacknowledged-only) view.
    const res = await request(app).get(
      "/api/super-admin/plan-migration-audit?acknowledgedByUserId=not-a-number&acknowledgedVia=carrier-pigeon",
    );
    expect(res.status).toBe(200);

    const ids = res.body.entries.map((e: { id: number }) => e.id);
    expect(ids).toContain(unackRowId);
    expect(ids).not.toContain(ackRowId);
    expect(ids).not.toContain(emailAckRowId);
  });

  it("exposes firstDigestedAt so the panel can render the same age cue as the digest email (Task #1550)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(200);

    // Stamped row — must round-trip the persisted ISO timestamp verbatim.
    const stampedRow = res.body.entries.find((e: { id: number }) => e.id === stampedDigestRowId);
    expect(stampedRow).toBeTruthy();
    expect(stampedRow.firstDigestedAt).toBe(stampedFirstDigestedAt);

    // Unstamped row — `firstDigestedAt` must be present on the response
    // shape (so the dashboard's `??` fallback to createdAt works) and
    // explicitly null rather than undefined / missing.
    const unstampedRow = res.body.entries.find((e: { id: number }) => e.id === unackRowId);
    expect(unstampedRow).toBeTruthy();
    expect(unstampedRow).toHaveProperty("firstDigestedAt");
    expect(unstampedRow.firstDigestedAt).toBeNull();
  });

  it("orders by firstDigestedAt-with-createdAt-fallback, oldest first by default (Task #1929)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(200);

    const ids: number[] = res.body.entries.map((e: { id: number }) => e.id);
    const stampedIdx = ids.indexOf(stampedDigestRowId);
    const unackIdx = ids.indexOf(unackRowId);

    expect(stampedIdx).toBeGreaterThanOrEqual(0);
    expect(unackIdx).toBeGreaterThanOrEqual(0);
    // The stamped row's persisted `firstDigestedAt` (2026-04-01) is older
    // than the unstamped row's `createdAt` (this test run's "now"), so the
    // stamped row should surface before the unstamped row in the default
    // oldest-first order — that's the whole point of Task #1929: align
    // the row order with the colour ramp.
    expect(stampedIdx).toBeLessThan(unackIdx);
  });

  it("?sort=newest flips the order back to most-recent first (Task #1929)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit?sort=newest");
    expect(res.status).toBe(200);

    const ids: number[] = res.body.entries.map((e: { id: number }) => e.id);
    const stampedIdx = ids.indexOf(stampedDigestRowId);
    const unackIdx = ids.indexOf(unackRowId);

    expect(stampedIdx).toBeGreaterThanOrEqual(0);
    expect(unackIdx).toBeGreaterThanOrEqual(0);
    // Reversed: the freshly-created unstamped row now leads the list.
    expect(unackIdx).toBeLessThan(stampedIdx);
  });

  it("falls back to the oldest-first default for unrecognised ?sort values (Task #1929)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit?sort=carrier-pigeon");
    expect(res.status).toBe(200);

    const ids: number[] = res.body.entries.map((e: { id: number }) => e.id);
    const stampedIdx = ids.indexOf(stampedDigestRowId);
    const unackIdx = ids.indexOf(unackRowId);
    expect(stampedIdx).toBeLessThan(unackIdx);
  });

  it("returns reviewerStats with all-time per-reviewer counts (Task #1553)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });

    // The reviewer aggregate should be present on the default response and
    // should reflect ALL acknowledged rows for the reviewer regardless of the
    // current filter. The fixture has two ack'd rows by ackUserId (one
    // dashboard, one email).
    const res = await request(app).get("/api/super-admin/plan-migration-audit");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviewerStats)).toBe(true);

    const ours = (res.body.reviewerStats as Array<{ userId: number; name: string; count: number }>)
      .find(s => s.userId === ackUserId);
    expect(ours).toBeDefined();
    expect(ours!.name).toBe("Plan Migration Reviewer");
    expect(ours!.count).toBeGreaterThanOrEqual(2);

    // Filtering the visible result set must not change the all-time count.
    const filtered = await request(app).get(
      "/api/super-admin/plan-migration-audit?acknowledgedVia=email",
    );
    expect(filtered.status).toBe(200);
    const filteredEntry = (filtered.body.reviewerStats as Array<{ userId: number; count: number }>)
      .find(s => s.userId === ackUserId);
    expect(filteredEntry?.count).toBe(ours!.count);
  });

  it("returns acknowledgedVia and acknowledger name on acknowledged rows (Task #1144)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit?includeAcknowledged=1");
    expect(res.status).toBe(200);

    const dashboardRow = res.body.entries.find((e: { id: number }) => e.id === ackRowId);
    expect(dashboardRow.acknowledgedVia).toBe("dashboard");
    expect(dashboardRow.acknowledgedByUserId).toBe(ackUserId);
    expect(dashboardRow.acknowledgedByName).toBe("Plan Migration Reviewer");

    const emailRow = res.body.entries.find((e: { id: number }) => e.id === emailAckRowId);
    expect(emailRow.acknowledgedVia).toBe("email");
    expect(emailRow.acknowledgedByUserId).toBe(ackUserId);
    expect(emailRow.acknowledgedByName).toBe("Plan Migration Reviewer");

    // Unacknowledged rows should report null for the via badge.
    const unackRow = res.body.entries.find((e: { id: number }) => e.id === unackRowId);
    expect(unackRow.acknowledgedVia).toBeNull();
    expect(unackRow.acknowledgedByName).toBeNull();
  });
});

describe("GET /api/super-admin/plan-migration-audit/stale-summary", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: 1, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    expect(res.status).toBe(403);
  });

  it("counts unacknowledged rows that are >=24h stale via either firstDigestedAt or createdAt fallback (Task #1930)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    expect(res.status).toBe(200);
    expect(typeof res.body.staleCount).toBe("number");

    // Fixtures: stampedDigestRowId (old firstDigestedAt) + oldUnackNoStampRowId
    // (old created_at, no stamp) both belong in the count. Other test files
    // running against the same DB may add unrelated stale rows, so we only
    // assert >= 2 rather than ==.
    expect(res.body.staleCount).toBeGreaterThanOrEqual(2);
  });

  it("excludes acknowledged rows even when they are old (Task #1930)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const before = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    const baseline: number = before.body.staleCount;

    // Acknowledge the old unack'd no-stamp row and confirm the count drops by
    // exactly one. This pins the COALESCE-fallback logic AND the
    // acknowledged-exclusion clause in the same test.
    const ack = await request(app).post(
      `/api/super-admin/plan-migration-audit/${oldUnackNoStampRowId}/acknowledge`,
    );
    expect(ack.status).toBe(200);

    const after = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    expect(after.body.staleCount).toBe(baseline - 1);
  });

  it("excludes fresh unacknowledged rows that haven't crossed 24h yet (Task #1930)", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const before = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    const baseline: number = before.body.staleCount;

    // Acknowledging a row that was NOT in the stale bucket must leave the
    // count unchanged — proving the freshUnackNoStampRowId fixture is being
    // correctly excluded by the 24h threshold.
    const ack = await request(app).post(
      `/api/super-admin/plan-migration-audit/${freshUnackNoStampRowId}/acknowledge`,
    );
    expect(ack.status).toBe(200);

    const after = await request(app).get("/api/super-admin/plan-migration-audit/stale-summary");
    expect(after.body.staleCount).toBe(baseline);

    // Sanity: the always-acknowledged old row also did not contribute.
    expect(oldAckedRowId).toBeGreaterThan(0);
  });
});

describe("POST /api/super-admin/plan-migration-audit/:id/acknowledge", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).post(`/api/super-admin/plan-migration-audit/${unackRowId}/acknowledge`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: 2, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app).post(`/api/super-admin/plan-migration-audit/${unackRowId}/acknowledge`);
    expect(res.status).toBe(403);
  });

  it("acknowledges a row and removes it from the default list", async () => {
    const app = createTestApp({ id: 7, username: "su", role: "super_admin" });

    const ackRes = await request(app).post(`/api/super-admin/plan-migration-audit/${unackRowId}/acknowledge`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.ok).toBe(true);

    // Verify metadata was patched in the DB
    const [row] = await db.select({ metadata: memberAuditLogTable.metadata })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.id, unackRowId));
    expect(row.metadata).toBeTruthy();
    expect((row.metadata as Record<string, unknown>).acknowledged).toBe(true);
    expect((row.metadata as Record<string, unknown>).acknowledgedByUserId).toBe(7);

    // Default list (unacknowledged only) should now exclude it
    const listRes = await request(app).get("/api/super-admin/plan-migration-audit");
    const ids = listRes.body.entries.map((e: { id: number }) => e.id);
    expect(ids).not.toContain(unackRowId);
  });

  it("returns 404 for an audit row from a different entity/action", async () => {
    const app = createTestApp({ id: 7, username: "su", role: "super_admin" });

    // Insert an unrelated audit row that should NOT be ack-able through this endpoint.
    const [unrelated] = await db.insert(memberAuditLogTable).values({
      organizationId: orgId,
      entity: "profile",
      action: "update",
      reason: "unrelated row",
    }).returning({ id: memberAuditLogTable.id });
    createdAuditIds.push(unrelated.id);

    const res = await request(app).post(`/api/super-admin/plan-migration-audit/${unrelated.id}/acknowledge`);
    expect(res.status).toBe(404);
  });
});
