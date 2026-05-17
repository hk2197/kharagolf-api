/**
 * Server unit test (Task #2013) — POST /coach-marketplace/pros/:proId/profile
 * must reject inverted handicap windows (Min > Max) with a 400 and a helpful
 * message. Without the guard a coach who fat-fingers Min=20/Max=5 would
 * silently save that, after which the marketplace `?handicap=` filter
 * (which requires both bounds to match) would never include them at any
 * handicap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-coach-handicap-range";

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachUserId: number;
let proId: number;
let coach: TestUser;
let appAsCoach: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T2013_Org_${stamp}`,
    slug: `t2013-org-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t2013-coach-${stamp}`,
    username: `t2013_coach_${stamp}`,
    email: `t2013_coach_${stamp}@example.com`,
    displayName: "T2013 Coach",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachUserId = u.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachUserId, role: "player",
  });

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachUserId, displayName: "T2013 Coach",
  }).returning({ id: teachingProsTable.id });
  proId = pro.id;

  coach = {
    id: coachUserId, username: `t2013_coach_${stamp}`,
    displayName: "T2013 Coach", role: "player", organizationId: orgId,
  };
  appAsCoach = createTestApp(coach);
});

afterAll(async () => {
  if (proId) {
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  }
  if (coachUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, coachUserId));
  }
  if (orgId) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId]));
  }
});

const URL = () => `/api/coach-marketplace/pros/${proId}/profile`;

async function readSavedRange(): Promise<{ min: string | null; max: string | null }> {
  const [row] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId));
  return {
    min: row?.coachesHandicapMin ?? null,
    max: row?.coachesHandicapMax ?? null,
  };
}

describe("POST /coach-marketplace/pros/:proId/profile — Task #2013 handicap range guard", () => {
  it("accepts a non-inverted range (Min <= Max) and persists both bounds", async () => {
    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 5,
      coachesHandicapMax: 25,
    });
    expect(res.status, res.text).toBe(200);
    const saved = await readSavedRange();
    expect(Number(saved.min)).toBe(5);
    expect(Number(saved.max)).toBe(25);
  });

  it("accepts equal bounds (Min == Max)", async () => {
    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 10,
      coachesHandicapMax: 10,
    });
    expect(res.status, res.text).toBe(200);
    const saved = await readSavedRange();
    expect(Number(saved.min)).toBe(10);
    expect(Number(saved.max)).toBe(10);
  });

  it("accepts one-sided ranges (blank min or blank max)", async () => {
    let res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: null,
      coachesHandicapMax: 18,
    });
    expect(res.status, res.text).toBe(200);
    let saved = await readSavedRange();
    expect(saved.min).toBeNull();
    expect(Number(saved.max)).toBe(18);

    res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 0,
      coachesHandicapMax: null,
    });
    expect(res.status, res.text).toBe(200);
    saved = await readSavedRange();
    expect(Number(saved.min)).toBe(0);
    expect(saved.max).toBeNull();
  });

  it("rejects an inverted range (Min > Max) with 400 + helpful message", async () => {
    // Establish a known good baseline so we can assert no overwrite.
    await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 0,
      coachesHandicapMax: 18,
    });

    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 20,
      coachesHandicapMax: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Min handicap must be less than or equal to Max handicap/i);

    // Crucially: the failed write must not partially overwrite either bound.
    const saved = await readSavedRange();
    expect(Number(saved.min)).toBe(0);
    expect(Number(saved.max)).toBe(18);
  });

  it("rejects a partial update that inverts against the existing other side", async () => {
    // Seed a known range. After this row min=5, max=10.
    await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 5,
      coachesHandicapMax: 10,
    });

    // Patch only the min, raising it above the saved max → must reject.
    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 15,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Min handicap must be less than or equal to Max handicap/i);

    const saved = await readSavedRange();
    expect(Number(saved.min)).toBe(5);
    expect(Number(saved.max)).toBe(10);
  });

  it("accepts string-encoded numbers in either bound", async () => {
    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: "2.5",
      coachesHandicapMax: "12.5",
    });
    expect(res.status, res.text).toBe(200);
    const saved = await readSavedRange();
    expect(Number(saved.min)).toBe(2.5);
    expect(Number(saved.max)).toBe(12.5);
  });

  it("rejects string-encoded inverted bounds with 400", async () => {
    await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: 0,
      coachesHandicapMax: 18,
    });

    const res = await request(appAsCoach).post(URL()).send({
      coachesHandicapMin: "20",
      coachesHandicapMax: "5",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Min handicap must be less than or equal to Max handicap/i);
  });
});
