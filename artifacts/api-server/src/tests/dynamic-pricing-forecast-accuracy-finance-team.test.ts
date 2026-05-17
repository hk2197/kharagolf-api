/**
 * Tests for the forecast-accuracy finance team picker endpoint — Task #1471.
 *
 * Right now the forecast accuracy schedule (Task #1254) accepts free-text
 * email addresses with no link to user accounts. This endpoint surfaces
 * org members tagged with finance-related roles (currently `treasurer`)
 * so admins can add recipients by name without remembering whose inbox
 * each address is. Raw email entry still works for external accountants.
 *
 * Expectations:
 *   - Org members with `treasurer` role appear in the picker (with
 *     displayName, email, and role label).
 *   - Members without an email on file are excluded from the picker
 *     (the schedule can't email a missing address) but surfaced in a
 *     separate `missingEmail` list so admins can see who's silently
 *     unavailable and click through to fix the underlying member record
 *     (Task #1805).
 *   - Erased users are filtered out (account no longer usable for sign-in
 *     or notifications).
 *   - Members without a finance-related role (eg. `org_admin`,
 *     `tournament_director`) are NOT returned — only the finance team is
 *     intended to be name-pickable here.
 *   - Non-admins get 403 (consistent with the rest of the schedule UI).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let treasurerWithEmailId: number;
let treasurerNoEmailId: number;
let treasurerErasedId: number;
let nonFinanceUserId: number;
let nonAdminUserId: number;
let admin: TestUser;
let nonAdmin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ForecastFinanceTeamTest_${stamp}`,
    slug: `forecast-finance-team-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminUser] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-admin-${stamp}`,
    username: `forecast_finance_admin_${stamp}`,
    email: `forecast_finance_admin_${stamp}@example.com`,
    displayName: "Forecast Finance Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminUser.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: adminUserId, role: "org_admin",
  });

  const [t1] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-t1-${stamp}`,
    username: `forecast_finance_t1_${stamp}`,
    email: `treasurer.alice_${stamp}@example.com`,
    displayName: "Alice Treasurer",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  treasurerWithEmailId = t1.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: treasurerWithEmailId, role: "treasurer",
  });

  const [t2] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-t2-${stamp}`,
    username: `forecast_finance_t2_${stamp}`,
    email: null,
    displayName: "Bob NoEmail",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  treasurerNoEmailId = t2.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: treasurerNoEmailId, role: "treasurer",
  });

  const [t3] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-t3-${stamp}`,
    username: `forecast_finance_t3_${stamp}`,
    email: `treasurer.charlie_${stamp}@example.com`,
    displayName: "Charlie Erased",
    role: "player",
    organizationId: orgId,
    erasedAt: new Date(),
  }).returning({ id: appUsersTable.id });
  treasurerErasedId = t3.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: treasurerErasedId, role: "treasurer",
  });

  const [tournamentDirector] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-td-${stamp}`,
    username: `forecast_finance_td_${stamp}`,
    email: `td_${stamp}@example.com`,
    displayName: "Tournament Director",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonFinanceUserId = tournamentDirector.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: nonFinanceUserId, role: "tournament_director",
  });

  const [na] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-finance-na-${stamp}`,
    username: `forecast_finance_na_${stamp}`,
    email: `na_${stamp}@example.com`,
    displayName: "Non Admin",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = na.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: nonAdminUserId, role: "player",
  });

  admin = {
    id: adminUserId,
    username: `forecast_finance_admin_${stamp}`,
    displayName: "Forecast Finance Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  nonAdmin = {
    id: nonAdminUserId,
    username: `forecast_finance_na_${stamp}`,
    displayName: "Non Admin",
    role: "player",
    organizationId: orgId,
  };
  app = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);
});

afterAll(async () => {
  if (orgId) await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  const userIds = [adminUserId, treasurerWithEmailId, treasurerNoEmailId, treasurerErasedId, nonFinanceUserId, nonAdminUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule/finance-team-members", () => {
  it("returns treasurers with email; excludes no-email, erased, and non-finance roles", async () => {
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`);
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{ userId: number; displayName: string | null; email: string; role: string }>;
    expect(Array.isArray(members)).toBe(true);

    const ids = members.map(m => m.userId);
    expect(ids).toContain(treasurerWithEmailId);
    // Excluded from picker: no email, erased, non-finance role, plain admin
    expect(ids).not.toContain(treasurerNoEmailId);
    expect(ids).not.toContain(treasurerErasedId);
    expect(ids).not.toContain(nonFinanceUserId);
    expect(ids).not.toContain(adminUserId);

    const alice = members.find(m => m.userId === treasurerWithEmailId);
    expect(alice).toBeDefined();
    expect(alice?.role).toBe("treasurer");
    expect(alice?.displayName).toBe("Alice Treasurer");
    expect(alice?.email).toContain("@example.com");
  });

  it("surfaces treasurers with no email in `missingEmail` so admins can fix the member record (Task #1805)", async () => {
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`);
    expect(res.status).toBe(200);
    const missing = res.body.missingEmail as Array<{
      userId: number; displayName: string | null; username: string | null; role: string;
    }>;
    expect(Array.isArray(missing)).toBe(true);
    expect(typeof res.body.missingEmailCount).toBe("number");
    expect(res.body.missingEmailCount).toBe(missing.length);

    const missingIds = missing.map(m => m.userId);
    // Bob has the treasurer role but no email — must appear so admins
    // can see he's silently excluded from the picker.
    expect(missingIds).toContain(treasurerNoEmailId);

    // Erased users and non-finance members should NOT show up here either:
    // we don't want the hint to nag admins to "fix" deactivated accounts
    // or unrelated non-finance roles.
    expect(missingIds).not.toContain(treasurerErasedId);
    expect(missingIds).not.toContain(nonFinanceUserId);
    expect(missingIds).not.toContain(adminUserId);
    // And users who already have email shouldn't appear in the missing list.
    expect(missingIds).not.toContain(treasurerWithEmailId);

    const bob = missing.find(m => m.userId === treasurerNoEmailId);
    expect(bob).toBeDefined();
    expect(bob?.role).toBe("treasurer");
    expect(bob?.displayName).toBe("Bob NoEmail");
    // Username is exposed so the UI has a fallback search term when
    // displayName is null.
    expect(typeof bob?.username).toBe("string");
    expect(bob?.username?.length ?? 0).toBeGreaterThan(0);
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`);
    expect(res.status).toBe(403);
  });

  it("always returns a non-empty email field for each picker entry", async () => {
    // The picker only renders selectable members when their email is set;
    // a regression that started returning null/empty emails would silently
    // break "select by name" because there'd be nothing to add to the
    // recipients textarea. Guard the response shape.
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`);
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{ email: string }>;
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(typeof m.email).toBe("string");
      expect(m.email.length).toBeGreaterThan(0);
    }
  });
});
