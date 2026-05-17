/**
 * Integration tests: Task #921 — org-wide warning for stuck erasure cleanups.
 *
 * The account-erasure cron writes per-member audit rows. Task #776 already
 * surfaces failures on the per-member 360 page, but controllers don't
 * routinely open every deleted member, so this endpoint aggregates the
 * `objectStorageFilesFailed > 0` cases across the org.
 *
 *   1. GET /erasures/storage-failures returns one item per stuck member, with
 *      the most-recent erasure's failed counter and a member-deleted flag.
 *   2. Members whose latest erasure has zero failures are excluded — even if
 *      an older row had failures (controller already retried successfully).
 *   3. Manual hard-deletes (no `autoErasure` / `mediaTablesPurged` metadata)
 *      are excluded.
 *   4. POST /:memberId/erasure-history/retry-storage writes a follow-up audit
 *      row with the retry outcome, which then drops the member from the
 *      stuck list.
 *   5. Non-admin callers get 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
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
let stuckMemberId: number;
let cleanMemberId: number;
let manualDeleteMemberId: number;
let adminUserId: number;
let nonAdminUserId: number;
let admin: TestUser;
let nonAdmin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ErasureFailures_${ts}`,
    slug: `test-erasure-failures-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [stuckMember] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId, firstName: "Stuck", lastName: "Member",
    email: "stuck@example.test",
  }).returning({ id: clubMembersTable.id });
  stuckMemberId = stuckMember.id;

  const [cleanMember] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId, firstName: "Resolved", lastName: "Member",
    email: "resolved@example.test",
  }).returning({ id: clubMembersTable.id });
  cleanMemberId = cleanMember.id;

  const [manualMember] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId, firstName: "Manual", lastName: "Member",
    email: "manual@example.test",
  }).returning({ id: clubMembersTable.id });
  manualDeleteMemberId = manualMember.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `esf-admin-${ts}`, username: `esf_admin_${ts}`,
    role: "org_admin", organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId, userId: adminUserId, role: "org_admin",
  });

  const [nonAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `esf-player-${ts}`, username: `esf_player_${ts}`, role: "player",
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminRow.id;

  admin = { id: adminUserId, username: `esf_admin_${ts}`, role: "org_admin", organizationId: testOrgId };
  nonAdmin = { id: nonAdminUserId, username: `esf_player_${ts}`, role: "player" };
  app = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);

  // Stuck member: latest erasure left 2 failed paths.
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: stuckMemberId,
    entity: "club_member", entityId: stuckMemberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron)",
    createdAt: new Date(Date.now() - 60_000),
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 7,
      mediaTablesPurged: { media: 1 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 2,
      objectStorageFilesFailedPaths: ["/objects/abc", "/objects/def"],
      objectStorageDisabled: false,
    },
  });

  // Resolved member: older row had a failure, but the most-recent retry row
  // succeeded — must not appear in the stuck list.
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: cleanMemberId,
    entity: "club_member", entityId: cleanMemberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron) — first attempt",
    createdAt: new Date(Date.now() - 120_000),
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 8,
      mediaTablesPurged: { media: 2 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesFailed: 3,
      objectStorageFilesFailedPaths: ["/x", "/y", "/z"],
      objectStorageDisabled: false,
    },
  });
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: cleanMemberId,
    entity: "club_member", entityId: cleanMemberId, action: "delete",
    actorName: "controller", reason: "retry",
    createdAt: new Date(),
    metadata: {
      source: "controller_retry", autoErasure: true, dataRequestId: 8,
      mediaTablesPurged: {},
      objectStorageFilesDeleted: 3,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 0,
      objectStorageFilesFailedPaths: [],
      objectStorageDisabled: false,
    },
  });

  // Manual delete (no autoErasure / mediaTablesPurged) — must be ignored.
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId, clubMemberId: manualDeleteMemberId,
    entity: "club_member", entityId: manualDeleteMemberId, action: "delete",
    actorName: "admin", reason: "manual delete",
    metadata: { source: "manual" },
  });
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const baseUrl = () => `/api/organizations/${testOrgId}/members-360`;

describe("GET /erasures/storage-failures", () => {
  it("lists only members whose latest erasure still has failed storage files", async () => {
    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.totalFailedFiles).toBe(2);
    expect(res.body.items).toHaveLength(1);
    const it0 = res.body.items[0];
    expect(it0.clubMemberId).toBe(stuckMemberId);
    expect(it0.objectStorageFilesFailed).toBe(2);
    expect(it0.dataRequestId).toBe(7);
    expect(it0.memberFirstName).toBe("Stuck");
    expect(it0.memberDeleted).toBe(false);
    // Task #1459 — fresh failure with no cron retries yet: chain count is
    // zero and the exhausted flag is false (cron will pick it up next pass).
    expect(it0.autoRetryAttempts).toBe(0);
    expect(it0.autoRetryExhausted).toBe(false);
    // No exhausted members in the seed data → banner count is zero.
    expect(res.body.autoRetryExhaustedCount).toBe(0);
    // Cap surfaced to the UI so badge labels can render "n/<cap>" without
    // hard-coding the denominator.
    expect(res.body.autoRetryMaxAttempts).toBe(5);
    // The resolved + manual-delete members must not appear.
    expect(res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === cleanMemberId)).toBeUndefined();
    expect(res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === manualDeleteMemberId)).toBeUndefined();
    // Task #973: the response must also surface the retry queue counters
    // so the admin UI can show how many orphan paths the worker is still
    // chasing and how many have hit the exhausted threshold.
    expect(res.body.pendingStorageDeletions).toBeDefined();
    expect(typeof res.body.pendingStorageDeletions.total).toBe("number");
    expect(typeof res.body.pendingStorageDeletions.exhausted).toBe("number");
    expect(res.body.pendingStorageDeletions.total).toBeGreaterThanOrEqual(0);
    expect(res.body.pendingStorageDeletions.exhausted).toBeGreaterThanOrEqual(0);
    expect(res.body.pendingStorageDeletions.exhausted).toBeLessThanOrEqual(res.body.pendingStorageDeletions.total);
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status).toBe(403);
  });
});

// Task #1459 — the dashboard widget needs to distinguish "auto-retry
// still in progress" from "auto-retry has given up — needs your action".
// The aggregator walks the audit chain newest-first counting consecutive
// `cron_retry` rows (skipping the transparent `cron_capped_notification`
// markers) and exposes the count + a derived `autoRetryExhausted` flag
// per item, plus a panel-level tally for the banner.
describe("GET /erasures/storage-failures — auto-retry chain status", () => {
  it("flags a member as auto-retry exhausted after 5 cron_retry rows uninterrupted by a controller_retry", async () => {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "Capped", lastName: "Member",
      email: `capped-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    // Original failed erasure, then 5 consecutive cron_retry rows, all
    // with the failure still > 0 — exactly the chain shape the cron
    // would have written before giving up.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system", reason: "auto-erasure (cron)",
      createdAt: new Date(ts - 6 * 60_000),
      metadata: {
        source: "cron", autoErasure: true, dataRequestId: 99,
        mediaTablesPurged: { media: 1 },
        objectStorageFilesFailed: 2,
        objectStorageFilesFailedPaths: ["/objects/p1", "/objects/p2"],
      },
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(memberAuditLogTable).values({
        organizationId: testOrgId, clubMemberId: m.id,
        entity: "club_member", entityId: m.id, action: "delete",
        actorName: "system (cron auto-retry)", reason: "retry",
        createdAt: new Date(ts - (5 - i) * 60_000),
        metadata: {
          source: "cron_retry", autoErasure: true, dataRequestId: 99,
          objectStorageFilesFailed: 2,
          objectStorageFilesFailedPaths: ["/objects/p1", "/objects/p2"],
        },
      });
    }
    // The cron also writes a transparent notification marker after it
    // gives up; the aggregator must skip past it without counting it as
    // a retry attempt and without breaking the chain.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system (cron auto-retry)", reason: "auto-retry cap reached — controllers notified",
      createdAt: new Date(ts),
      metadata: {
        source: "cron_capped_notification", autoErasure: true,
        attempts: 5,
        objectStorageFilesFailed: 2,
        objectStorageFilesFailedPaths: ["/objects/p1", "/objects/p2"],
      },
    });

    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === m.id);
    expect(item).toBeTruthy();
    expect(item.autoRetryAttempts).toBe(5);
    expect(item.autoRetryExhausted).toBe(true);
    expect(res.body.autoRetryExhaustedCount).toBeGreaterThanOrEqual(1);

    // Cleanup so subsequent tests see a clean slate for this member.
    await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.clubMemberId, m.id));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });

  it("resets the chain to in-progress the moment a controller manual retry runs", async () => {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "Reset", lastName: "Member",
      email: `reset-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    // Original + 5 cron retries (would be exhausted) + a controller retry
    // that still failed + 1 fresh cron retry. Walking back from newest:
    // cron_retry (1) → controller_retry breaks → attempts = 1, NOT exhausted.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system", reason: "auto-erasure (cron)",
      createdAt: new Date(ts - 8 * 60_000),
      metadata: {
        source: "cron", autoErasure: true, dataRequestId: 100,
        mediaTablesPurged: { media: 1 },
        objectStorageFilesFailed: 1,
        objectStorageFilesFailedPaths: ["/objects/q1"],
      },
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(memberAuditLogTable).values({
        organizationId: testOrgId, clubMemberId: m.id,
        entity: "club_member", entityId: m.id, action: "delete",
        actorName: "system (cron auto-retry)", reason: "retry",
        createdAt: new Date(ts - (7 - i) * 60_000),
        metadata: {
          source: "cron_retry", autoErasure: true, dataRequestId: 100,
          objectStorageFilesFailed: 1,
          objectStorageFilesFailedPaths: ["/objects/q1"],
        },
      });
    }
    // Controller manually re-ran cleanup; storage was still flaky so it
    // failed again. This row breaks the chain.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "controller", reason: "retry",
      createdAt: new Date(ts - 60_000),
      metadata: {
        source: "controller_retry", autoErasure: true, dataRequestId: 100,
        objectStorageFilesFailed: 1,
        objectStorageFilesFailedPaths: ["/objects/q1"],
      },
    });
    // Cron picked it up again on its next pass.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system (cron auto-retry)", reason: "retry",
      createdAt: new Date(ts),
      metadata: {
        source: "cron_retry", autoErasure: true, dataRequestId: 100,
        objectStorageFilesFailed: 1,
        objectStorageFilesFailedPaths: ["/objects/q1"],
      },
    });

    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === m.id);
    expect(item).toBeTruthy();
    expect(item.autoRetryAttempts).toBe(1);
    expect(item.autoRetryExhausted).toBe(false);

    await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.clubMemberId, m.id));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });
});

// Task #1795 — when a controller acknowledges a stuck cleanup the row
// stays on the dashboard (the orphan files haven't moved) but the
// aggregator must surface the reviewer + free-text note + a per-item
// `acknowledged` flag so the UI can render the badge and offer a
// hide-acknowledged toggle. The aggregate also exposes an
// `acknowledgedCount` so the toggle can show "N hidden" without
// re-iterating items client-side.
describe("GET /erasures/storage-failures — controller acknowledgement", () => {
  it("surfaces acknowledged rows with reviewer name, note and acknowledgedAt while keeping them on the list", async () => {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "Acked", lastName: "Member",
      email: `acked-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    // Original failed erasure first.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system", reason: "auto-erasure (cron)",
      createdAt: new Date(ts - 120_000),
      metadata: {
        source: "cron", autoErasure: true, dataRequestId: 555,
        mediaTablesPurged: { media: 1 },
        objectStorageFilesFailed: 4,
        objectStorageFilesFailedPaths: ["/o/a", "/o/b", "/o/c", "/o/d"],
      },
    });
    // Controller acknowledges (Task #1460): newer row tagged
    // controller_acknowledgement carrying forward the failed-paths counter
    // and stamping the actor name + note.
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorUserId: adminUserId, actorName: "Alice Controller",
      reason: "auto-erasure storage cleanup acknowledged by controller — legal hold",
      createdAt: new Date(ts),
      metadata: {
        source: "controller_acknowledgement", autoErasure: true, dataRequestId: 555,
        mediaTablesPurged: {},
        objectStorageFilesDeleted: 0,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 4,
        objectStorageFilesFailedPaths: ["/o/a", "/o/b", "/o/c", "/o/d"],
        objectStorageDisabled: false,
        acknowledgedAuditId: 999_999,
        acknowledgementNote: "files retained on legal hold per ticket #1234",
      },
    });

    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === m.id);
    expect(item).toBeTruthy();
    // Carried-forward count keeps the row on the list — that's the whole
    // reason we need a visual cue rather than just dropping it.
    expect(item.objectStorageFilesFailed).toBe(4);
    expect(item.acknowledged).toBe(true);
    expect(item.acknowledgedBy).toBe("Alice Controller");
    expect(typeof item.acknowledgedAt).toBe("string");
    expect(new Date(item.acknowledgedAt).toString()).not.toBe("Invalid Date");
    expect(item.acknowledgementNote).toBe("files retained on legal hold per ticket #1234");
    // Acknowledgement breaks the cron walk-back chain (same as
    // controller_retry), so the auto-retry attempt count resets.
    expect(item.autoRetryAttempts).toBe(0);
    expect(item.autoRetryExhausted).toBe(false);
    // Aggregate-level tally for the "hide acknowledged" toggle hint.
    expect(typeof res.body.acknowledgedCount).toBe("number");
    expect(res.body.acknowledgedCount).toBeGreaterThanOrEqual(1);

    await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.clubMemberId, m.id));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });

  it("leaves non-acknowledged items with acknowledged=false and acknowledgement fields null", async () => {
    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((x: { clubMemberId: number }) => x.clubMemberId === stuckMemberId);
    expect(item).toBeTruthy();
    expect(item.acknowledged).toBe(false);
    expect(item.acknowledgedAt).toBeNull();
    expect(item.acknowledgedBy).toBeNull();
    expect(item.acknowledgementNote).toBeNull();
  });
});

// Task #1450 — controller dashboard badge polls a lightweight summary so
// the home screen shows the live backlog without paying the cost of the
// full drill-down list. The summary must agree exactly with the full
// endpoint's count + queue totals (otherwise the badge would silently
// drift from the panel it deep-links into).
describe("GET /erasures/storage-failures/summary", () => {
  it("returns count, totalFailedFiles and pendingStorageDeletions matching the full endpoint", async () => {
    const [full, summary] = await Promise.all([
      request(app).get(`${baseUrl()}/erasures/storage-failures`),
      request(app).get(`${baseUrl()}/erasures/storage-failures/summary`),
    ]);
    expect(summary.status, summary.text).toBe(200);
    expect(full.status, full.text).toBe(200);
    expect(summary.body.count).toBe(full.body.count);
    expect(summary.body.totalFailedFiles).toBe(full.body.totalFailedFiles);
    expect(summary.body.pendingStorageDeletions.total).toBe(full.body.pendingStorageDeletions.total);
    expect(summary.body.pendingStorageDeletions.exhausted).toBe(full.body.pendingStorageDeletions.exhausted);
    // Task #1779 — `autoRetryExhaustedCount` powers the home dashboard's
    // "needs your action" sub-pill. The badge would silently drift from
    // the panel banner if the summary computed this differently from the
    // full aggregator, so the parity contract has to cover it explicitly.
    expect(summary.body.autoRetryExhaustedCount).toBe(full.body.autoRetryExhaustedCount);
    // The badge surface must NOT carry the heavy items array — it would
    // defeat the point of the lightweight endpoint and risk leaking
    // member names into a payload that ships on every dashboard load.
    expect(summary.body.items).toBeUndefined();
    // Sanity-check the values we expect from the seed data so we catch
    // regressions in the aggregator itself, not just the parity contract.
    expect(summary.body.count).toBe(1);
    expect(summary.body.totalFailedFiles).toBe(2);
    // Seed data has a fresh failure with no cron retries → no member is
    // exhausted yet. The dedicated chain-exhaustion test below seeds an
    // additional member and asserts the count moves to >= 1.
    expect(summary.body.autoRetryExhaustedCount).toBe(0);
  });

  // Task #1779 — when a member's chain IS exhausted, the summary's
  // sub-count must move in lockstep with the full endpoint's banner
  // count. Mirrors the chain-exhausted scenario already covered for
  // the full endpoint above.
  it("counts auto-retry-exhausted members in autoRetryExhaustedCount, matching the full endpoint", async () => {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "SummaryCapped", lastName: "Member",
      email: `summary-capped-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system", reason: "auto-erasure (cron)",
      createdAt: new Date(ts - 6 * 60_000),
      metadata: {
        source: "cron", autoErasure: true, dataRequestId: 1779,
        mediaTablesPurged: { media: 1 },
        objectStorageFilesFailed: 3,
        objectStorageFilesFailedPaths: ["/objects/r1", "/objects/r2", "/objects/r3"],
      },
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(memberAuditLogTable).values({
        organizationId: testOrgId, clubMemberId: m.id,
        entity: "club_member", entityId: m.id, action: "delete",
        actorName: "system (cron auto-retry)", reason: "retry",
        createdAt: new Date(ts - (5 - i) * 60_000),
        metadata: {
          source: "cron_retry", autoErasure: true, dataRequestId: 1779,
          objectStorageFilesFailed: 3,
          objectStorageFilesFailedPaths: ["/objects/r1", "/objects/r2", "/objects/r3"],
        },
      });
    }

    const [full, summary] = await Promise.all([
      request(app).get(`${baseUrl()}/erasures/storage-failures`),
      request(app).get(`${baseUrl()}/erasures/storage-failures/summary`),
    ]);
    expect(summary.status, summary.text).toBe(200);
    expect(full.status, full.text).toBe(200);
    expect(summary.body.autoRetryExhaustedCount).toBeGreaterThanOrEqual(1);
    expect(summary.body.autoRetryExhaustedCount).toBe(full.body.autoRetryExhaustedCount);
    expect(summary.body.count).toBe(full.body.count);

    await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.clubMemberId, m.id));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).get(`${baseUrl()}/erasures/storage-failures/summary`);
    expect(res.status).toBe(403);
  });
});

describe("POST /:memberId/erasure-history/retry-storage", () => {
  it("writes a follow-up audit row recording the retry outcome and drops the member from the stuck list", async () => {
    const res = await request(app).post(`${baseUrl()}/${stuckMemberId}/erasure-history/retry-storage`);
    expect(res.status, res.text).toBe(200);
    // We attempted both paths from the prior failure metadata.
    expect(res.body.attempted).toBe(2);
    expect(res.body.retryAuditId).toBeGreaterThan(0);
    expect(res.body.sourceAuditId).toBeGreaterThan(0);
    // The combined deleted+missing+failed counters always equal `attempted`
    // — the per-counter split depends on whether object storage is configured
    // in the test env, so we lock the invariant rather than the split.
    expect(res.body.deleted + res.body.missing + res.body.failed).toBe(res.body.attempted);
    // After the retry row lands, the org-wide warning surface must reflect
    // the new state of the member: if the retry cleared everything, drop
    // them from the list; if the retry still failed, the count is preserved.
    const after = await request(app).get(`${baseUrl()}/erasures/storage-failures`);
    expect(after.status).toBe(200);
    const stillStuck = after.body.items.find(
      (x: { clubMemberId: number }) => x.clubMemberId === stuckMemberId,
    );
    if (res.body.failed > 0) {
      expect(stillStuck).toBeTruthy();
      expect(stillStuck.objectStorageFilesFailed).toBe(res.body.failed);
    } else {
      expect(stillStuck).toBeUndefined();
    }
  });

  it("404s when the member has no prior erasure on file", async () => {
    // cleanMember already retried successfully — but a *different* member with
    // zero erasure history would 404. We simulate this by deleting all rows
    // for cleanMember inside this scope.
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "Untouched", lastName: "Member",
      email: `untouched-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    const res = await request(app).post(`${baseUrl()}/${m.id}/erasure-history/retry-storage`);
    expect(res.status).toBe(404);
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).post(`${baseUrl()}/${stuckMemberId}/erasure-history/retry-storage`);
    expect(res.status).toBe(403);
  });
});

// ─── Task #1460 — controller acknowledgement endpoint ──────────────────────
// Companion to /retry-storage: lets a controller silence the cap alert
// without running another purge attempt (e.g. files held under legal hold).
// Writes an audit row tagged `controller_acknowledgement` that the cron
// walk-back treats as a chain break — resetting the per-member retry budget
// and re-arming the cap-reached page-out — but does NOT touch object
// storage. The optional free-text note is persisted in the row's metadata.
describe("POST /:memberId/erasure-history/acknowledge", () => {
  // Each test creates its own member so they don't trample each other's
  // audit rows (the helper appends a new row per call).
  async function newStuckMember(label: string) {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: label, lastName: "AckMember",
      email: `${label.toLowerCase()}-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    await db.insert(memberAuditLogTable).values({
      organizationId: testOrgId, clubMemberId: m.id,
      entity: "club_member", entityId: m.id, action: "delete",
      actorName: "system", reason: "auto-erasure (cron)",
      createdAt: new Date(Date.now() - 60_000),
      metadata: {
        source: "cron", autoErasure: true, dataRequestId: 99,
        mediaTablesPurged: { media: 1 },
        objectStorageFilesDeleted: 0,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 2,
        objectStorageFilesFailedPaths: ["/objects/abc", "/objects/def"],
        objectStorageDisabled: false,
      },
    });
    return m.id;
  }

  it("writes a controller_acknowledgement audit row carrying forward the failed-paths metadata and the controller's note", async () => {
    const id = await newStuckMember("Ack1");
    const res = await request(app)
      .post(`${baseUrl()}/${id}/erasure-history/acknowledge`)
      .send({ note: "files retained on legal hold per ticket #1234" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.acknowledgementAuditId).toBeGreaterThan(0);
    expect(res.body.sourceAuditId).toBeGreaterThan(0);
    expect(res.body.filesFailed).toBe(2);

    // Verify the persisted audit row carries the right metadata so the
    // dashboard / cron continue to surface the same failure footprint.
    const history = await request(app).get(`${baseUrl()}/${id}/erasure-history`);
    expect(history.status).toBe(200);
    const entries = history.body.entries as Array<{
      source: string;
      objectStorageFilesFailed: number;
      acknowledgementNote?: string;
    }>;
    // Most-recent entry is the acknowledgement.
    expect(entries[0].source).toBe("controller_acknowledgement");
    expect(entries[0].objectStorageFilesFailed).toBe(2);
  });

  it("accepts requests with no note body", async () => {
    const id = await newStuckMember("Ack2");
    const res = await request(app)
      .post(`${baseUrl()}/${id}/erasure-history/acknowledge`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.acknowledgementAuditId).toBeGreaterThan(0);
  });

  it("rejects notes longer than 1000 characters with 400", async () => {
    const id = await newStuckMember("Ack3");
    const res = await request(app)
      .post(`${baseUrl()}/${id}/erasure-history/acknowledge`)
      .send({ note: "x".repeat(1001) });
    expect(res.status).toBe(400);
  });

  it("404s when the member has no prior erasure on file", async () => {
    const ts = Date.now();
    const [m] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId, firstName: "NoErasure", lastName: "Ack",
      email: `noerasure-ack-${ts}@example.test`,
    }).returning({ id: clubMembersTable.id });
    const res = await request(app)
      .post(`${baseUrl()}/${m.id}/erasure-history/acknowledge`)
      .send({ note: "n/a" });
    expect(res.status).toBe(404);
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, m.id));
  });

  it("rejects non-admin callers with 403", async () => {
    const id = await newStuckMember("Ack4");
    const res = await request(nonAdminApp)
      .post(`${baseUrl()}/${id}/erasure-history/acknowledge`)
      .send({ note: "n/a" });
    expect(res.status).toBe(403);
  });
});
