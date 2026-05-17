/**
 * Test: POST /portal/highlights never silently applies a 30s trim window
 * for legacy video clips with no measured `durationSeconds` (Task #1323).
 *
 * Background: Task #1155 added unit coverage that the highlight editor's UI
 * hides the trim slider and shows a warning when the selected video media
 * row has `durationSeconds = NULL` (legacy uploads from before Task #703
 * started measuring duration on upload). However, the *server-side* trim
 * payload (`options.clips[i].startSec` / `durationSec`) had no end-to-end
 * coverage. A regression in `POST /portal/highlights` (or in the shared
 * `authorizeClips` helper that strips/normalises clip fields before they
 * are persisted) could quietly start emitting reels with a fabricated
 * 30-second window, which the renderer would then dutifully feed to ffmpeg
 * even though the source video might be only a couple of seconds long.
 *
 * This test exercises the live PostgreSQL test DB (alongside the existing
 * `highlight-engagement-types.test.ts`) and asserts the only acceptable
 * server behaviours when a clip references a legacy media row:
 *
 *   1. The persisted `options.clips[i]` has NO `durationSec` field (and
 *      no `startSec` field) — the trim window is dropped, not defaulted.
 *      In particular, no clip is allowed to silently end up with a 30s
 *      window when the uploader-supplied window was either absent or
 *      explicitly set to 30s on a legacy clip.
 *   2. Equivalently, the request may fail outright (e.g. 4xx) — also
 *      acceptable per the task spec.
 *
 * The render queue side effect is stubbed out — these tests do not
 * exercise ffmpeg. See `highlight-render-clips.test.ts` for renderer
 * coverage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return {
    ...actual,
    enqueueRender: vi.fn(async (_id: number) => {}),
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  mediaTable,
  highlightReelsTable,
  highlightRenderEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgId: number;
let userId: number;

const mediaIds: number[] = [];
const reelIds: number[] = [];

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert>): Promise<number> {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    approved: true,
    uploadedByUserId: userId,
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [o] = await db.insert(organizationsTable).values({
    name: `HiTrimNoDefaultOrg_${ts}`,
    slug: `hi-trim-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `hi-trim-${ts}`,
    username: `hi_trim_${ts}`,
    email: `trim_${ts}@test.local`,
    displayName: "Trim Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId, role: "player" },
  ]);
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightRenderEventsTable).where(inArray(highlightRenderEventsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  if (userId) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, userId));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightRenderEventsTable).where(inArray(highlightRenderEventsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
  if (mediaIds.length > 0) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
});

function asUser(id: number, organizationId: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId };
}

type StoredClip = { mediaId: number; caption?: string; startSec?: number; durationSec?: number };

function getStoredClips(options: unknown): StoredClip[] {
  const opts = (options ?? {}) as { clips?: StoredClip[] };
  return Array.isArray(opts.clips) ? opts.clips : [];
}

describe("Task #1323 — POST /portal/highlights never silently applies a 30s trim window for legacy clips", () => {
  it("drops a client-supplied 30s trim window when the referenced video has durationSeconds=NULL", async () => {
    // Legacy video upload — `durationSeconds` was not measured at upload
    // time (pre-Task-#703 row), so the editor cannot honour any trim
    // window. The mobile client should have suppressed startSec/durationSec
    // entirely (Task #1155), but if a stale or buggy client posts the
    // values anyway, the server must not accept them.
    const legacyVid = await seedMedia({
      caption: "legacy upload",
      mediaType: "video",
      durationSeconds: null,
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Legacy clip with bogus 30s trim",
      templateId: "classic",
      options: {
        clips: [{ mediaId: legacyVid, startSec: 0, durationSec: 30 }],
      },
    });

    // The task spec allows either "ignore the trim window" or "fail the
    // request". Assert one of the two — but never the silent-30s path,
    // and never a server crash (5xx must not count as "rejected" here).
    expect(res.status).toBeLessThan(500);
    if (res.status >= 400) {
      // Acceptable: server rejected the request with a client error.
      // Nothing to verify beyond the status code.
      return;
    }
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, res.body.id));
    const stored = getStoredClips(row.options);
    expect(stored).toHaveLength(1);
    expect(stored[0].mediaId).toBe(legacyVid);

    // The crux of the regression test: no 30s window may be persisted for
    // a legacy clip. We accept the server either dropping the trim fields
    // entirely or normalising them to undefined / null.
    expect(stored[0].durationSec ?? null).not.toBe(30);
    expect(stored[0].durationSec ?? null).toBeNull();
    expect(stored[0].startSec ?? null).toBeNull();
  });

  it("does not invent a 30s window when the client omits trim fields on a legacy clip", async () => {
    const legacyVid = await seedMedia({
      caption: "legacy upload",
      mediaType: "video",
      durationSeconds: null,
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Legacy clip without trim fields",
      templateId: "classic",
      options: {
        clips: [{ mediaId: legacyVid }],
      },
    });

    expect(res.status).toBeLessThan(500);
    if (res.status >= 400) return;
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, res.body.id));
    const stored = getStoredClips(row.options);
    expect(stored).toHaveLength(1);
    expect(stored[0].mediaId).toBe(legacyVid);
    // The server must not back-fill a default window for a legacy clip.
    expect(stored[0].durationSec ?? null).toBeNull();
    expect(stored[0].startSec ?? null).toBeNull();
  });

  it("ROUND-TRIP: a measured-duration clip preserves the editor's startSec/durationSec on POST and PATCH (Task #1574)", async () => {
    // The flip-side of the legacy guard. When the media row HAS a known
    // `durationSeconds`, the editor's per-clip trim slider must round-
    // trip end-to-end: the server has to persist the window, otherwise
    // the renderer falls back to the template's per-photo duration and
    // the slider becomes a silent no-op.
    const measuredVid = await seedMedia({
      caption: "measured upload",
      mediaType: "video",
      durationSeconds: 12,
    });

    const app = createTestApp(asUser(userId, orgId));

    // POST round-trip ─────────────────────────────────────────────────
    const created = await request(app).post("/api/portal/highlights").send({
      title: "Measured clip with trim",
      templateId: "classic",
      options: {
        clips: [{ mediaId: measuredVid, startSec: 1.5, durationSec: 4 }],
      },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);
    const [createdRow] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, created.body.id));
    const createdClips = getStoredClips(createdRow.options);
    expect(createdClips).toHaveLength(1);
    expect(createdClips[0].mediaId).toBe(measuredVid);
    expect(createdClips[0].startSec).toBe(1.5);
    expect(createdClips[0].durationSec).toBe(4);

    // PATCH round-trip — different window must overwrite cleanly ──────
    const patched = await request(app).patch(`/api/portal/highlights/${created.body.id}`).send({
      options: {
        clips: [{ mediaId: measuredVid, startSec: 3, durationSec: 2 }],
      },
    });
    expect(patched.status).toBe(200);
    const [patchedRow] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, created.body.id));
    const patchedClips = getStoredClips(patchedRow.options);
    expect(patchedClips).toHaveLength(1);
    expect(patchedClips[0].mediaId).toBe(measuredVid);
    expect(patchedClips[0].startSec).toBe(3);
    expect(patchedClips[0].durationSec).toBe(2);
  });

  it("ROUND-TRIP: clamps a trim window that overruns the measured source duration (Task #1574)", async () => {
    // If the editor sends a window that extends beyond the source, the
    // server should keep the start and clamp `durationSec` to the
    // remaining headroom — the renderer will already do its own clamp,
    // but persisting the clamped value avoids confusing the editor on
    // the next read.
    const shortVid = await seedMedia({
      caption: "short measured upload",
      mediaType: "video",
      durationSeconds: 5,
    });

    const app = createTestApp(asUser(userId, orgId));
    const created = await request(app).post("/api/portal/highlights").send({
      title: "Overrun trim",
      templateId: "classic",
      options: {
        clips: [{ mediaId: shortVid, startSec: 2, durationSec: 30 }],
      },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);
    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, created.body.id));
    const stored = getStoredClips(row.options);
    expect(stored).toHaveLength(1);
    expect(stored[0].startSec).toBe(2);
    // sourceDur=5, start=2 → max remaining = 3
    expect(stored[0].durationSec).toBe(3);
  });

  it("Task #1961 — POST surfaces trimClampedMediaIds when a window is shortened to fit the source", async () => {
    // Same overrun as the existing source-clamp test: source=5s, the
    // user picks start=2s + duration=30s, the server stores
    // start=2s + duration=3s. With Task #1961 the response must also
    // tell the editor *which* clip was clamped so it can show a
    // one-line "Trimmed to fit the source video" notice next to that
    // clip — without this signal the editor silently re-fetches the
    // shorter window and the player has no idea their pick was
    // shortened. We assert the array contains exactly this clip and
    // nothing else (so a sibling "no-notice" clip can't leak into it).
    const shortVid = await seedMedia({
      caption: "short measured upload",
      mediaType: "video",
      durationSeconds: 5,
    });
    const niceVid = await seedMedia({
      caption: "well-fitting upload",
      mediaType: "video",
      durationSeconds: 30,
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Mixed clamp + clean",
      templateId: "classic",
      options: {
        clips: [
          { mediaId: shortVid, startSec: 2, durationSec: 30 },
          { mediaId: niceVid, startSec: 1, durationSec: 4 },
        ],
      },
    });
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    expect(Array.isArray(res.body.trimClampedMediaIds)).toBe(true);
    // Only the overrunning clip is flagged — the well-fitting sibling
    // must NOT be in the list (no notice should fire when the persisted
    // window matches what the user picked).
    expect(res.body.trimClampedMediaIds).toEqual([shortVid]);
  });

  it("Task #1961 — POST returns an empty trimClampedMediaIds when nothing was shortened", async () => {
    // Sister to the test above: a clip that fits inside its source has
    // nothing to flag, so the editor should NOT show the "Trimmed to
    // fit" notice. Asserting an empty array (not just "missing") makes
    // sure the client can rely on the field always being present.
    const niceVid = await seedMedia({
      caption: "well-fitting upload",
      mediaType: "video",
      durationSeconds: 30,
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "All clean",
      templateId: "classic",
      options: {
        clips: [{ mediaId: niceVid, startSec: 1, durationSec: 4 }],
      },
    });
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    expect(res.body.trimClampedMediaIds).toEqual([]);
  });

  it("Task #1961 — does NOT flag legacy (unmeasured) clips as clamped", async () => {
    // Legacy clips have `durationSeconds=NULL`, so the server can't
    // know whether the user's window overruns the source — it just
    // drops the trim fields (per Task #1323). Treating that drop as
    // "clamped" would cry wolf in the editor, so the response must
    // leave trimClampedMediaIds empty even though the persisted clip
    // has no startSec/durationSec.
    const legacyVid = await seedMedia({
      caption: "legacy upload",
      mediaType: "video",
      durationSeconds: null,
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Legacy with bogus 30s",
      templateId: "classic",
      options: {
        clips: [{ mediaId: legacyVid, startSec: 0, durationSec: 30 }],
      },
    });
    expect(res.status).toBeLessThan(500);
    if (res.status >= 400) return;
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    expect(res.body.trimClampedMediaIds).toEqual([]);
  });

  it("Task #1961 — PATCH also surfaces trimClampedMediaIds when re-render shortens a window", async () => {
    // Mirror of the POST coverage — PATCH re-runs `authorizeClips`, so
    // a refactor that breaks the response wiring on either path must
    // be caught.
    const shortVid = await seedMedia({
      caption: "short measured upload",
      mediaType: "video",
      durationSeconds: 5,
    });

    const app = createTestApp(asUser(userId, orgId));
    const created = await request(app).post("/api/portal/highlights").send({
      title: "Initial fit",
      templateId: "classic",
      options: { clips: [{ mediaId: shortVid, startSec: 0, durationSec: 2 }] },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);
    // First save fit cleanly — no notice.
    expect(created.body.trimClampedMediaIds).toEqual([]);

    const patched = await request(app).patch(`/api/portal/highlights/${created.body.id}`).send({
      options: {
        clips: [{ mediaId: shortVid, startSec: 2, durationSec: 30 }],
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.trimClampedMediaIds).toEqual([shortVid]);
  });

  it("PATCH /portal/highlights/:id also refuses to persist a 30s window for a legacy clip", async () => {
    // Same regression surface as POST — PATCH re-runs `authorizeClips`
    // and a buggy version of that helper could leak the trim fields
    // through. Cover the PATCH path too so a future refactor can't
    // regress one and not the other.
    const legacyVid = await seedMedia({
      caption: "legacy upload",
      mediaType: "video",
      durationSeconds: null,
    });

    const app = createTestApp(asUser(userId, orgId));
    const created = await request(app).post("/api/portal/highlights").send({
      title: "Will be edited",
      options: { clips: [{ mediaId: legacyVid }] },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);

    const patched = await request(app).patch(`/api/portal/highlights/${created.body.id}`).send({
      options: {
        clips: [{ mediaId: legacyVid, startSec: 2, durationSec: 30 }],
      },
    });
    expect(patched.status).toBeLessThan(500);
    if (patched.status >= 400) return;
    expect(patched.status).toBe(200);

    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, created.body.id));
    const stored = getStoredClips(row.options);
    expect(stored).toHaveLength(1);
    expect(stored[0].mediaId).toBe(legacyVid);
    expect(stored[0].durationSec ?? null).not.toBe(30);
    expect(stored[0].durationSec ?? null).toBeNull();
    expect(stored[0].startSec ?? null).toBeNull();
  });
});
