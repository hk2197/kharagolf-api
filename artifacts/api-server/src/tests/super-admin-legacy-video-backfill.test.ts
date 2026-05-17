/**
 * Test: Task #1962 — Super-admin one-shot legacy video duration backfill.
 *
 * Covers the two endpoints the dashboard panel calls:
 *   • GET  /api/super-admin/legacy-videos/un-measured-count
 *   • POST /api/super-admin/legacy-videos/probe
 *
 * Specifically:
 *   - both endpoints require super_admin role (org_admin → 403)
 *   - the count returns the number of legacy video rows that have never
 *     been measured AND never been attempted (durationSeconds NULL,
 *     durationLastCheckedAt NULL), across all orgs
 *   - the sweep walks a small batch, writes durationSeconds on success,
 *     stamps durationLastCheckedAt on every kind of failure (including
 *     ObjectNotFoundError) so the same row isn't tried twice
 *   - non-video rows and already-measured rows are left alone
 *   - the count shrinks after a sweep so the dashboard's "X still
 *     un-measured" tile reflects progress
 *   - the response surfaces remaining > 0 when the backlog is bigger
 *     than the per-call cap, so the dashboard can prompt for another
 *     click
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Stub the shared probe lib so tests don't need real ffprobe + object
// storage. We control success / failure / missing per-row by inspecting
// the objectPath the route passes in.
const probeMock = vi.hoisted(() => vi.fn<(p: string) => Promise<number | null>>());
vi.mock("../lib/mediaDurationProbe", () => ({
  probeMediaDurationSeconds: probeMock,
}));

import { ObjectNotFoundError } from "../lib/objectStorage";
import {
  db,
  organizationsTable,
  appUsersTable,
  mediaTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";
import { LEGACY_BACKFILL_BATCH_SIZE } from "../lib/legacyVideoBackfill";

let orgAId: number;
let orgBId: number;
let superAdminId: number;
let orgAdminId: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [a] = await db.insert(organizationsTable).values({
    name: `LegacyBackfillOrgA_${ts}`,
    slug: `lvbf-a-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgAId = a.id;

  const [b] = await db.insert(organizationsTable).values({
    name: `LegacyBackfillOrgB_${ts}`,
    slug: `lvbf-b-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgBId = b.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `lvbf-su-${ts}`,
    username: `su_lvbf_${ts}`,
    email: `su_lvbf_${ts}@test.local`,
    displayName: "Super Admin",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [oa] = await db.insert(appUsersTable).values({
    replitUserId: `lvbf-oa-${ts}`,
    username: `oa_lvbf_${ts}`,
    email: `oa_lvbf_${ts}@test.local`,
    displayName: "Org Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  orgAdminId = oa.id;
});

afterAll(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  for (const u of [superAdminId, orgAdminId].filter(Boolean)) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  if (mediaIds.length > 0) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
  probeMock.mockReset();
});

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert> = {}) {
  // Default = a legacy video that's never been measured and never been
  // attempted — exactly the candidate set for this sweep.
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgAId,
    objectPath: `/objects/legacy/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    durationLastCheckedAt: null,
    approved: true,
    uploaderName: "Tester",
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

function asSuperAdmin(): TestUser {
  return { id: superAdminId, username: "su", role: "super_admin" };
}
function asOrgAdmin(): TestUser {
  return { id: orgAdminId, username: "oa", role: "org_admin", organizationId: orgAId };
}

describe("GET /api/super-admin/legacy-videos/un-measured-count", () => {
  it("requires super_admin role", async () => {
    const res = await request(createTestApp(asOrgAdmin()))
      .get(`/api/super-admin/legacy-videos/un-measured-count`);
    expect(res.status).toBe(403);
  });

  it("returns the count of un-measured + un-tried legacy videos across orgs", async () => {
    // Three legacy candidates across two orgs.
    await seedMedia({ caption: "a1" });
    await seedMedia({ caption: "a2", organizationId: orgBId });
    await seedMedia({ caption: "a3" });
    // Already measured — should not count.
    await seedMedia({ caption: "measured", durationSeconds: 12 });
    // Already attempted (and failed) — should not count toward the
    // candidate set; the sweep won't try it again either.
    await seedMedia({ caption: "tried", durationLastCheckedAt: new Date() });
    // Non-video — should not count.
    await seedMedia({ caption: "img", mediaType: "image" });

    const res = await request(createTestApp(asSuperAdmin()))
      .get(`/api/super-admin/legacy-videos/un-measured-count`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.batchSize).toBe(LEGACY_BACKFILL_BATCH_SIZE);
  });
});

describe("POST /api/super-admin/legacy-videos/probe", () => {
  it("requires super_admin role", async () => {
    const res = await request(createTestApp(asOrgAdmin()))
      .post(`/api/super-admin/legacy-videos/probe`);
    expect(res.status).toBe(403);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("processes a small batch: recovers, stamps failures, reports remaining=0", async () => {
    const a = await seedMedia({ caption: "ok" });
    const b = await seedMedia({ caption: "unverif" });
    const c = await seedMedia({ caption: "missing", organizationId: orgBId });
    // Already-measured + already-tried + non-video — must not be touched.
    const measuredId = await seedMedia({ caption: "measured", durationSeconds: 9 });
    const triedId = await seedMedia({
      caption: "tried",
      durationLastCheckedAt: new Date("2024-01-01T00:00:00Z"),
    });
    const imageId = await seedMedia({ caption: "img", mediaType: "image" });

    probeMock.mockImplementation(async (objectPath: string) => {
      const [row] = await db
        .select({ caption: mediaTable.caption })
        .from(mediaTable)
        .where(eq(mediaTable.objectPath, objectPath));
      if (row?.caption === "ok") return 8;
      if (row?.caption === "unverif") return null;
      if (row?.caption === "missing") throw new ObjectNotFoundError();
      throw new Error(`unexpected probe call for ${objectPath}`);
    });

    const res = await request(createTestApp(asSuperAdmin()))
      .post(`/api/super-admin/legacy-videos/probe`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      attempted: 3,
      recovered: 1,
      stillFailing: 2,
      objectMissing: 1,
      remaining: 0,
      batchSize: LEGACY_BACKFILL_BATCH_SIZE,
    });

    // Recovered row got its duration written and stamp cleared.
    const [aRow] = await db
      .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, a));
    expect(aRow.d).toBe(8);
    expect(aRow.t).toBeNull();

    // Both failure modes (probe returned null + ObjectNotFoundError)
    // stamp `durationLastCheckedAt` so the row drops out of the
    // candidate set and we don't keep retrying forever.
    for (const id of [b, c]) {
      const [r] = await db
        .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
        .from(mediaTable)
        .where(eq(mediaTable.id, id));
      expect(r.d).toBeNull();
      expect(r.t).not.toBeNull();
    }

    // The "don't touch" rows are unchanged.
    const [m] = await db.select({ d: mediaTable.durationSeconds }).from(mediaTable).where(eq(mediaTable.id, measuredId));
    expect(m.d).toBe(9);
    const [t] = await db.select({ t: mediaTable.durationLastCheckedAt }).from(mediaTable).where(eq(mediaTable.id, triedId));
    expect(t.t?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    const [img] = await db.select({ kind: mediaTable.mediaType }).from(mediaTable).where(eq(mediaTable.id, imageId));
    expect(img.kind).toBe("image");

    // Probe was called exactly once per candidate (not the skipped rows).
    expect(probeMock).toHaveBeenCalledTimes(3);
  });

  it("re-running drops the count to zero — failures aren't re-probed", async () => {
    await seedMedia({ caption: "fail1" });
    await seedMedia({ caption: "fail2" });
    probeMock.mockResolvedValue(null);

    const first = await request(createTestApp(asSuperAdmin()))
      .post(`/api/super-admin/legacy-videos/probe`);
    expect(first.body.attempted).toBe(2);
    expect(first.body.stillFailing).toBe(2);
    expect(first.body.remaining).toBe(0);

    // The count endpoint now reports zero, even though both rows are
    // still NULL — they have a stamp, so they're "tried" not "untried".
    const countRes = await request(createTestApp(asSuperAdmin()))
      .get(`/api/super-admin/legacy-videos/un-measured-count`);
    expect(countRes.body.count).toBe(0);

    // A second sweep does nothing (no candidates) — the probe isn't
    // called again on the previously-stamped failures.
    probeMock.mockClear();
    const second = await request(createTestApp(asSuperAdmin()))
      .post(`/api/super-admin/legacy-videos/probe`);
    expect(second.body.attempted).toBe(0);
    expect(second.body.remaining).toBe(0);
    expect(probeMock).not.toHaveBeenCalled();
  });
});
