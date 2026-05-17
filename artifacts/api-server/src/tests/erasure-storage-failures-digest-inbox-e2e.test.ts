/**
 * Task #1451 — End-to-end coverage for the daily controller stuck-erasure
 * digest's in-app inbox row.
 *
 * The companion suite (`erasure-storage-failures-digest.test.ts`,
 * Task #1241) mocks `dispatchNotification` and only proves the cron
 * *requests* a dispatch with the right key/payload. That leaves a gap:
 * we never assert the dispatch actually lands in the user-facing
 * notification feed for each controller, including the push-only
 * controllers who have no email on file.
 *
 * This suite closes the gap by:
 *   1. Running `sendErasureStorageFailuresDigest` against the real,
 *      hydrated `dispatchNotification` (push delivery and the mailer
 *      are mocked out so the suite never hits Expo or SMTP — but the
 *      registry → user-prefs → audit log path is untouched).
 *   2. Authenticating as the org admin and calling the user-facing API
 *      `GET /api/admin/notification-audit` (the endpoint the controller
 *      portal renders the dispatch trail / inbox feed from). The test
 *      asserts an inbox entry surfaces for every controller of the
 *      stuck org — the org_admin, the membership_secretary, the
 *      treasurer, AND the push-only controller with no email on file —
 *      so a regression in the API serialization / scoping / mapping
 *      path would be caught, not just a regression in the DB write.
 *   3. Asserting the entry's `payload` carries the deep-link the
 *      mobile/web client opens on tap, exactly
 *      `/privacy?panel=erasure-storage-failures` (and the absolute
 *      `url` companion).
 *
 * Mirrors the real-dispatcher hydration pattern from
 * `notification-dispatch-and-digest.test.ts` and
 * `side-game-receipt-digest-failure.test.ts`, and the auth+API
 * roundtrip pattern from `routes/__tests__/admin-notification-audit.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendErasureStorageFailuresDigestEmail: vi.fn(async () => undefined),
    sendNotificationEmail: vi.fn(async () => undefined),
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

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

import { sendErasureStorageFailuresDigest } from "../lib/cron.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";
import { createTestApp, type TestUser } from "./helpers.js";

const DISPATCH_KEY = "privacy.erasure.storage_failures.controller_digest";
const EXPECTED_DEEP_LINK = "/privacy?panel=erasure-storage-failures";
const TEST_BASE_URL = "https://test.kharagolf.com";
const EXPECTED_URL = `${TEST_BASE_URL}${EXPECTED_DEEP_LINK}`;

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `ErasureDigestE2E_${label}_${tag}`,
    slug: `erasure-digest-e2e-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string; organizationId?: number | null; role?: "player" | "org_admin" }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `erasure-digest-e2e-${tag}`,
    username: `erasure_digest_e2e_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
    organizationId: opts.organizationId ?? null,
    role: opts.role ?? "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function addOrgMembership(orgId: number, userId: number, role: "org_admin" | "membership_secretary" | "treasurer") {
  await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role });
}

async function makeMember(orgId: number, firstName = "Stuck"): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId, firstName, lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function recordStuckErasure(orgId: number, memberId: number, failed: number, when: Date = new Date()) {
  await db.insert(memberAuditLogTable).values({
    organizationId: orgId, clubMemberId: memberId,
    entity: "club_member", entityId: memberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron)",
    createdAt: when,
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 4242,
      mediaTablesPurged: { media: 1 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: failed,
      objectStorageFilesFailedPaths: Array.from({ length: failed }, (_, i) => `/objects/${memberId}-${i}`),
      objectStorageDisabled: false,
    },
  });
}

interface AuditEntry {
  id: number;
  notificationKey: string;
  userId: number | null;
  channel: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
}

let prevAppBaseUrl: string | undefined;
beforeAll(async () => {
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = TEST_BASE_URL;
  // Mirror the schema-tolerance pattern from the sibling erasure tests so
  // this suite passes on freshly-cloned local DBs.
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
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS erasure_storage_digest_last_sent_on text`);

  // The real dispatcher reads the registry — make sure the seed list (which
  // contains our key) is loaded into both memory and the DB row used by
  // `loadSpec`.
  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevAppBaseUrl;

  if (createdUserIds.length) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  _clearSpecCacheForTests();
});

describe("Task #1451 — sendErasureStorageFailuresDigest in-app inbox row e2e", () => {
  it("surfaces an inbox entry carrying the privacy-panel deep-link via /api/admin/notification-audit for every controller — including the push-only one with no email on file", async () => {
    const orgId = await makeOrg("inbox");
    const memberId = await makeMember(orgId, "InboxStuck");
    await recordStuckErasure(orgId, memberId, 2);

    // Org admin — discovered by the cron via `appUsers.role='org_admin'` and
    // ALSO the user we authenticate as below to call the inbox API. Their
    // `organizationId` scopes the admin endpoint's tenant boundary.
    const adminId = await makeUser({
      email: `e2e-admin-${orgId}@example.com`,
      displayName: "E2E Admin",
      organizationId: orgId,
      role: "org_admin",
    });

    // Three more controllers — discovered by the cron via `org_memberships`.
    // We set their `appUsers.organizationId` too so the org-admin's
    // /admin/notification-audit tenant scope (which filters on
    // `appUsers.organizationId === adminOrg`) finds their rows.
    const secretaryId = await makeUser({
      email: `e2e-ms-${orgId}@example.com`,
      displayName: "E2E MS",
      organizationId: orgId,
    });
    await addOrgMembership(orgId, secretaryId, "membership_secretary");

    const treasurerId = await makeUser({
      email: `e2e-tr-${orgId}@example.com`,
      displayName: "E2E Treasurer",
      organizationId: orgId,
    });
    await addOrgMembership(orgId, treasurerId, "treasurer");

    // Push-only controller — no email on file. Must still appear in the
    // inbox feed: the dispatch reaches them via the push channel and the
    // audit row lands regardless of `email IS NULL`.
    const pushOnlyId = await makeUser({
      email: null,
      displayName: "E2E PushOnly Treasurer",
      organizationId: orgId,
    });
    await addOrgMembership(orgId, pushOnlyId, "treasurer");

    // Seed the non-controller user BEFORE running the cron so that the
    // negative assertion below truly proves recipient filtering at
    // dispatch time — not just that a later-created user has no rows.
    const outsiderId = await makeUser({
      email: `e2e-outsider-${orgId}@example.com`,
      displayName: "E2E Outsider",
      organizationId: orgId,
    });

    // Run the real cron + real dispatcher. push.js + mailer.js are mocked
    // (see top-of-file vi.mock) so no Expo/SMTP traffic; everything else —
    // registry assert, prefs lookup, audit insert — is the production path.
    await sendErasureStorageFailuresDigest();

    // Auth as the org_admin and ask the user-facing inbox API for every
    // entry under our key. This is the same endpoint the controller
    // portal calls; a regression in serialisation / tenant scoping /
    // userId mapping would surface here, not just at the DB layer.
    const adminTestUser: TestUser = {
      id: adminId,
      username: `admin-${orgId}`,
      role: "org_admin",
      organizationId: orgId,
    };
    const app = createTestApp(adminTestUser);
    const res = await request(app)
      .get(`/api/admin/notification-audit?key=${encodeURIComponent(DISPATCH_KEY)}&limit=200`);

    expect(res.status).toBe(200);
    const entries = res.body.entries as AuditEntry[];
    expect(Array.isArray(entries)).toBe(true);

    const allControllerIds = [adminId, secretaryId, treasurerId, pushOnlyId];
    for (const uidVal of allControllerIds) {
      const forUser = entries.filter(e => e.userId === uidVal);
      expect(forUser.length, `controller ${uidVal} should have at least one inbox entry in the API response`).toBeGreaterThan(0);

      // Each entry's `payload` is exactly the dispatch payload's `data`
      // block, which is what the mobile/web inbox renderers read to wire
      // up the on-tap deep-link.
      const payload = (forUser[0].payload ?? {}) as Record<string, unknown>;
      expect(payload.deepLink, `controller ${uidVal} deepLink`).toBe(EXPECTED_DEEP_LINK);
      expect(payload.url, `controller ${uidVal} absolute url`).toBe(EXPECTED_URL);
      expect(payload.type).toBe("privacy_erasure_storage_failures_digest");
      expect(payload.organizationId).toBe(orgId);
      expect(payload.count).toBe(1);
      expect(payload.totalFailedFiles).toBe(2);

      // Every entry carries the dispatch key — guards against a future
      // refactor that drops the key from the response shape.
      expect(forUser[0].notificationKey).toBe(DISPATCH_KEY);
    }

    // Sanity: the non-controller user in the same org (seeded BEFORE the
    // cron ran) must NOT have received an inbox entry. This proves the
    // dispatcher actually filtered to controllers — without this check
    // the positive assertions above would be vacuously true if the
    // dispatcher accidentally fanned out to every org member.
    expect(entries.filter(e => e.userId === outsiderId), `outsider ${outsiderId} must not appear in feed entries`).toHaveLength(0);
    const outsiderRefetch = await request(app)
      .get(`/api/admin/notification-audit?key=${encodeURIComponent(DISPATCH_KEY)}&userId=${outsiderId}&limit=10`);
    expect(outsiderRefetch.status).toBe(200);
    expect((outsiderRefetch.body.entries as AuditEntry[]).filter(e => e.userId === outsiderId)).toHaveLength(0);
  });
});
