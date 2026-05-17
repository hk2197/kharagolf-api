/**
 * Test: Task #1327 — admin "Re-check" action that re-runs the duration
 * probe on legacy unverifiable videos before bothering uploaders.
 *
 * Covers:
 *   • POST /api/organizations/:orgId/media/:mediaId/recheck-duration
 *       - admin-only (403 for players)
 *       - probe success → writes durationSeconds, clears
 *         durationLastCheckedAt, returns recovered: true
 *       - probe failure → stamps durationLastCheckedAt so the row stays
 *         in the unverifiable list with a "last attempted" timestamp,
 *         returns recovered: false + reason
 *       - object missing → distinct reason="object_missing"
 *       - rejects rows that aren't unverifiable videos (image, or
 *         already-measured video) with a 409
 *
 *   • POST /api/organizations/:orgId/media/recheck-all-durations
 *       - admin-only
 *       - iterates every unverifiable video in the org and reports
 *         aggregate counts (recovered / stillFailing / objectMissing)
 *       - rows from other orgs are not touched
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Stub the shared probe lib so we control success / failure / missing
// without needing real ffprobe + object storage in the test container.
const probeMock = vi.hoisted(() => vi.fn<(p: string) => Promise<number | null>>());
vi.mock("../lib/mediaDurationProbe", () => ({
  probeMediaDurationSeconds: probeMock,
}));

// The route distinguishes "object missing" via the ObjectNotFoundError
// type, so we re-export a real instance from the storage module — the
// route imports it from there too, so `instanceof` lines up.
import { ObjectNotFoundError } from "../lib/objectStorage";

import {
  db,
  organizationsTable,
  appUsersTable,
  mediaTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgId: number;
let otherOrgId: number;
let adminId: number;
let playerId: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [o] = await db.insert(organizationsTable).values({
    name: `RecheckDurOrg_${ts}`,
    slug: `recheck-dur-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [o2] = await db.insert(organizationsTable).values({
    name: `OtherOrg_${ts}`,
    slug: `other-rd-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = o2.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `recheck-dur-admin-${ts}`,
    username: `admin_rd_${ts}`,
    email: `admin_rd_${ts}@test.local`,
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `recheck-dur-player-${ts}`,
    username: `player_rd_${ts}`,
    email: `player_rd_${ts}@test.local`,
    displayName: "Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerId = player.id;
});

afterAll(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  for (const u of [adminId, playerId].filter(Boolean)) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(async () => {
  if (mediaIds.length > 0) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
  probeMock.mockReset();
});

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert> = {}) {
  // Default to a row the background cron has already given up on
  // (Task #1584). The single-row recheck endpoint allows any legacy
  // NULL-duration video, so the flag doesn't gate it; but the
  // recheck-all-durations endpoint only sweeps flagged rows, so the
  // bulk-sweep test below relies on this default.
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    durationUnverifiableReason: "permanently_unverifiable",
    approved: true,
    uploaderName: "Tester",
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

function asAdmin(): TestUser {
  return { id: adminId, username: "admin", role: "org_admin", organizationId: orgId };
}
function asPlayer(): TestUser {
  return { id: playerId, username: "player", role: "player", organizationId: orgId };
}

describe("POST /api/organizations/:orgId/media/:mediaId/recheck-duration", () => {
  it("requires admin role", async () => {
    const id = await seedMedia();
    const res = await request(createTestApp(asPlayer()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);
    expect(res.status).toBe(403);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("recovers duration on success and clears the row", async () => {
    const id = await seedMedia();
    probeMock.mockResolvedValueOnce(8);

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recovered: true, durationSeconds: 8 });

    const [updated] = await db
      .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, id));
    expect(updated.d).toBe(8);
    expect(updated.t).toBeNull();
  });

  it("stamps last-checked-at when probe still fails (unverifiable)", async () => {
    const id = await seedMedia();
    probeMock.mockResolvedValueOnce(null);

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recovered: false, reason: "unverifiable" });

    const [updated] = await db
      .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, id));
    expect(updated.d).toBeNull();
    expect(updated.t).not.toBeNull();
  });

  it("reports object_missing when storage cannot find the file", async () => {
    const id = await seedMedia();
    probeMock.mockRejectedValueOnce(new ObjectNotFoundError());

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(false);
    expect(res.body.reason).toBe("object_missing");

    // Even an object_missing failure stamps the timestamp so the row
    // doesn't look untried in the admin list.
    const [updated] = await db
      .select({ t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, id));
    expect(updated.t).not.toBeNull();
  });

  it("rejects rows that aren't unverifiable videos", async () => {
    const imageId = await seedMedia({ mediaType: "image", durationSeconds: null });
    const measuredId = await seedMedia({ mediaType: "video", durationSeconds: 12 });

    for (const id of [imageId, measuredId]) {
      const res = await request(createTestApp(asAdmin()))
        .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);
      expect(res.status).toBe(409);
    }
    expect(probeMock).not.toHaveBeenCalled();
  });

  // Task #1583 — cooldown: a re-probe within the cooldown window must be
  // refused so a fast-clicking admin can't hammer object storage.
  it("returns 429 when re-checked within the cooldown window", async () => {
    // Stamp the row as freshly checked (5s ago, well inside the 60s window).
    const id = await seedMedia({
      durationLastCheckedAt: new Date(Date.now() - 5_000),
    });

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);

    expect(res.status).toBe(429);
    expect(res.body.reason).toBe("rate_limited");
    expect(typeof res.body.retryAfterSeconds).toBe("number");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(res.headers["retry-after"]).toBeTruthy();

    // Critically, the probe was NOT called — that's the whole point of
    // the cooldown.
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("allows re-check after the cooldown window has elapsed", async () => {
    // Stamp the row well outside the 60s cooldown window.
    const id = await seedMedia({
      durationLastCheckedAt: new Date(Date.now() - 5 * 60_000),
    });
    probeMock.mockResolvedValueOnce(7);

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recovered: true, durationSeconds: 7 });
    expect(probeMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/organizations/:orgId/media/recheck-all-durations", () => {
  it("requires admin role", async () => {
    const res = await request(createTestApp(asPlayer()))
      .post(`/api/organizations/${orgId}/media/recheck-all-durations`);
    expect(res.status).toBe(403);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("aggregates outcomes across the org and skips other orgs", async () => {
    const a = await seedMedia({ caption: "a" });
    const b = await seedMedia({ caption: "b" });
    const c = await seedMedia({ caption: "c" });
    // Other org row — must NOT be touched.
    const otherId = await seedMedia({ caption: "other", organizationId: otherOrgId });
    // Non-video and already-measured rows in the same org — also skipped.
    await seedMedia({ caption: "image", mediaType: "image" });
    await seedMedia({ caption: "ok", durationSeconds: 9 });

    // Outcomes in row id order are: recover(8), unverifiable, missing.
    // The route iterates by createdAt desc, so map by call order via
    // a stateful mock that looks the row up.
    const recovered = new Set<string>();
    const unverif = new Set<string>();
    const missing = new Set<string>();
    probeMock.mockImplementation(async (objectPath: string) => {
      const [row] = await db
        .select({ id: mediaTable.id, c: mediaTable.caption })
        .from(mediaTable)
        .where(eq(mediaTable.objectPath, objectPath));
      if (!row) return null;
      if (row.c === "a") { recovered.add(row.c); return 8; }
      if (row.c === "b") { unverif.add(row.c); return null; }
      if (row.c === "c") { missing.add(row.c); throw new ObjectNotFoundError(); }
      return null;
    });

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/recheck-all-durations`);
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(3);
    expect(res.body.recovered).toBe(1);
    expect(res.body.stillFailing).toBe(2);
    expect(res.body.objectMissing).toBe(1);

    expect(recovered.has("a")).toBe(true);
    expect(unverif.has("b")).toBe(true);
    expect(missing.has("c")).toBe(true);

    // Sanity: the other-org row is untouched (still NULL duration, no
    // last-checked timestamp).
    const [other] = await db
      .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, otherId));
    expect(other.d).toBeNull();
    expect(other.t).toBeNull();

    // The recovered row dropped its NULL duration; the other two were
    // stamped with a last-checked timestamp.
    const [aRow] = await db.select({ d: mediaTable.durationSeconds })
      .from(mediaTable).where(eq(mediaTable.id, a));
    expect(aRow.d).toBe(8);
    for (const id of [b, c]) {
      const [r] = await db.select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
        .from(mediaTable).where(eq(mediaTable.id, id));
      expect(r.d).toBeNull();
      expect(r.t).not.toBeNull();
    }
  });

  // Task #1583 — "Re-check all" must honour the per-row cooldown so a
  // quick second click can't reset the protection that the per-row 429
  // provides. Rows touched within the cooldown are skipped (and counted).
  it("skips rows that are still in the cooldown window", async () => {
    // a: outside cooldown — should be re-probed.
    const a = await seedMedia({
      caption: "outside",
      durationLastCheckedAt: new Date(Date.now() - 10 * 60_000),
    });
    // b: inside cooldown (5s ago) — must be skipped.
    const b = await seedMedia({
      caption: "inside",
      durationLastCheckedAt: new Date(Date.now() - 5_000),
    });
    // c: never tried — should also be re-probed.
    const c = await seedMedia({ caption: "never" });

    probeMock.mockResolvedValue(8);

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/recheck-all-durations`);

    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(2); // a + c
    expect(res.body.recovered).toBe(2);
    expect(res.body.skippedCooldown).toBe(1);
    expect(res.body.cooldownSeconds).toBeGreaterThan(0);

    // The cooldowned row b was NOT touched: still NULL duration, same
    // (untouched) last-checked timestamp.
    const [bRow] = await db
      .select({ d: mediaTable.durationSeconds, t: mediaTable.durationLastCheckedAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, b));
    expect(bRow.d).toBeNull();
    expect(bRow.t).not.toBeNull();
    // Sanity: probe was called exactly twice (for a and c, not b).
    expect(probeMock).toHaveBeenCalledTimes(2);

    // a and c recovered.
    const [aRow] = await db.select({ d: mediaTable.durationSeconds })
      .from(mediaTable).where(eq(mediaTable.id, a));
    const [cRow] = await db.select({ d: mediaTable.durationSeconds })
      .from(mediaTable).where(eq(mediaTable.id, c));
    expect(aRow.d).toBe(8);
    expect(cRow.d).toBe(8);
  });
});

describe("GET /api/organizations/:orgId/media/unverifiable-videos", () => {
  it("includes durationLastCheckedAt in each row", async () => {
    const id = await seedMedia({ caption: "needs check" });
    probeMock.mockResolvedValueOnce(null);
    // Re-check the row first so durationLastCheckedAt is populated.
    await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/recheck-duration`);

    const res = await request(createTestApp(asAdmin()))
      .get(`/api/organizations/${orgId}/media/unverifiable-videos`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((r: { id: number }) => r.id === id);
    expect(row).toBeTruthy();
    expect(row.durationLastCheckedAt).toBeTruthy();
  });
});
