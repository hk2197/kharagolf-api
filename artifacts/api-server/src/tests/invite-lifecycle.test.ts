/**
 * Integration tests: Invite token lifecycle
 *
 * Tests the full lifecycle of an invitation token:
 *   pending → validate → accept / revoke / expire
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Test data is created in
 * beforeAll and deleted in afterAll to keep the DB clean.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  organizationsTable,
  invitationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// App with no authenticated user (public endpoints don't need one)
const app = createTestApp();

// ── Test fixtures ──────────────────────────────────────────────────────────

let testOrgId: number;
const insertedInviteIds: number[] = [];

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function insertInvite(overrides: Partial<{
  token: string;
  status: string;
  expiresAt: Date;
}> = {}) {
  const [inv] = await db.insert(invitationsTable).values({
    organizationId: testOrgId,
    token: overrides.token ?? makeToken(),
    recipientEmail: `test_${Date.now()}@example.com`,
    channels: [],
    status: overrides.status ?? "pending",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }).returning();
  insertedInviteIds.push(inv.id);
  return inv;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create a dedicated test organization
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_InviteLifecycle_${Date.now()}`,
    slug: `test-invite-lc-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  // Remove all test invites then the org
  if (insertedInviteIds.length > 0) {
    await db.delete(invitationsTable).where(
      eq(invitationsTable.organizationId, testOrgId)
    );
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Invite token lifecycle", () => {
  it("returns 404 for an unknown token", async () => {
    const res = await request(app).get("/api/public/invite/totally-unknown-token-xyz-999");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns full invite data for a valid pending token", async () => {
    const inv = await insertInvite();

    const res = await request(app).get(`/api/public/invite/${inv.token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(inv.id);
    expect(res.body.status).toBe("pending");
    expect(res.body.organizationId).toBe(testOrgId);
    // Should include org name + event metadata even when no tournament
    expect(res.body).toHaveProperty("orgName");
    expect(res.body).toHaveProperty("eventName");
    expect(res.body).toHaveProperty("eventType");
  });

  it("returns 410 and marks as expired when token is past its expiry", async () => {
    const pastDate = new Date(Date.now() - 1000); // 1 second in the past
    const inv = await insertInvite({ expiresAt: pastDate });

    const res = await request(app).get(`/api/public/invite/${inv.token}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);

    // Verify the status was updated in DB
    const [updated] = await db.select({ status: invitationsTable.status })
      .from(invitationsTable).where(eq(invitationsTable.id, inv.id));
    expect(updated.status).toBe("expired");
  });

  it("returns 200 with alreadyAccepted:true for an accepted invite (idempotent)", async () => {
    const inv = await insertInvite({ status: "accepted" });

    const res = await request(app).get(`/api/public/invite/${inv.token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.alreadyAccepted).toBe(true);
  });

  it("returns 410 for a revoked invite", async () => {
    const inv = await insertInvite({ status: "revoked" });

    const res = await request(app).get(`/api/public/invite/${inv.token}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it("returns 401 when creating an invite without authentication", async () => {
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/invitations`)
      .send({
        recipientEmail: "player@example.com",
        tournamentId: 1,
      });
    // No user injected → requireAdmin returns 401
    expect(res.status).toBe(401);
  });

  it("returns 403 when a player role tries to create an invite", async () => {
    const playerApp = createTestApp({
      id: 9999,
      username: "player",
      role: "player",
      organizationId: testOrgId,
    });

    const res = await request(playerApp)
      .post(`/api/organizations/${testOrgId}/invitations`)
      .send({
        recipientEmail: "player@example.com",
        tournamentId: 1,
      });
    expect(res.status).toBe(403);
  });

  it("returns 403 when an admin from a different org tries to create an invite", async () => {
    const otherOrgApp = createTestApp({
      id: 9998,
      username: "admin_other",
      role: "org_admin",
      organizationId: testOrgId + 9999, // different org
    });

    const res = await request(otherOrgApp)
      .post(`/api/organizations/${testOrgId}/invitations`)
      .send({
        recipientEmail: "player@example.com",
        tournamentId: 1,
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/org mismatch/i);
  });

  it("returns 400 when creating an invite with no contact method", async () => {
    const adminApp = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/invitations`)
      .send({ tournamentId: 1 }); // no email or phone
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email|phone/i);
  });

  it("returns 400 when creating an invite with no event (no tournamentId or leagueId)", async () => {
    const adminApp = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/invitations`)
      .send({ recipientEmail: "x@example.com" }); // no event
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tournament|league/i);
  });
});
