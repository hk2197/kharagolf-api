/**
 * Test: Highlight renderer — per-clip ordering, captions, and video clips
 * (Task #543).
 *
 * Exercises `executeRender` end-to-end with real ffmpeg, but with object
 * storage stubbed so we don't need a live bucket. Verifies:
 *
 *   1. opts.clips ordering wins over auto-pick (legacy includedMediaIds and
 *      "most recent" auto-pick are both ignored when clips is present).
 *   2. A per-clip caption is actually composited into the final MP4 — proven
 *      by extracting a frame from the captioned vs. non-captioned versions
 *      of the same render and asserting the pixels differ at the caption
 *      strip location.
 *   3. The video-clip code path produces a valid MP4 (proper ffmpeg
 *      ftyp box, ffprobe-readable duration > 0).
 *   4. Foreign mediaIds (cross-org / not owned + not in the round) are
 *      silently dropped before ffmpeg is asked to read them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { Readable } from "stream";

// ── Stub the storage service before importing the renderer ───────────────────
//
// `executeRender` does:
//   const storage = new ObjectStorageService();
//   await storage.getObjectEntityFile(objectPath)   // → File w/ createReadStream
//   await storage.saveRawBuffer(key, buf, mime)     // → "/objects/<key>"
//
// Our stub serves one of two in-memory buffers (image or mp4) keyed by the
// objectPath suffix and captures every saveRawBuffer call so the test can
// inspect the rendered MP4.
const fixtureDir = mkdtempSync(path.join(tmpdir(), "hl-fixture-"));
const fixturePngPath = path.join(fixtureDir, "img.png");
const fixtureMp4Path = path.join(fixtureDir, "vid.mp4");
let fixturePng: Buffer;
let fixtureMp4: Buffer;

const storageState = vi.hoisted(() => ({
  // map: objectPath → Buffer to stream back when fetched
  store: new Map<string, Buffer>(),
  // captured saves so the test can read the final MP4 back out
  saved: new Map<string, Buffer>(),
  fetchOrder: [] as string[],
}));

vi.mock("../lib/objectStorage.js", () => {
  return {
    ObjectStorageService: class {
      async getObjectEntityFile(objectPath: string) {
        storageState.fetchOrder.push(objectPath);
        const buf = storageState.store.get(objectPath);
        if (!buf) throw new Error(`stub: no fixture registered for ${objectPath}`);
        return {
          createReadStream() {
            return Readable.from(buf);
          },
        } as unknown as import("@google-cloud/storage").File;
      }
      async saveRawBuffer(relativePath: string, buffer: Buffer, _ct: string) {
        const objectPath = `/objects/${relativePath}`;
        storageState.saved.set(objectPath, buffer);
        return objectPath;
      }
    },
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  mediaTable,
  highlightReelsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { executeRender } from "../lib/highlightRender.js";

let orgId: number;
let otherOrgId: number;
let userId: number;
let otherUserId: number;
let tournamentId: number;

const mediaIds: number[] = [];
const reelIds: number[] = [];

function makeFixtureBuffers() {
  // Tiny solid-color PNG and MP4 generated via the same ffmpeg the renderer
  // uses. Keeping them small (320×240) makes the per-test render time well
  // under the vitest 30s timeout while still producing a real MP4.
  const png = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "color=c=red:size=320x240:d=1",
    "-frames:v", "1",
    fixturePngPath,
  ]);
  if (png.status !== 0) throw new Error(`ffmpeg PNG fixture failed: ${png.stderr.toString()}`);

  const mp4 = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "color=c=blue:size=320x240:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    fixtureMp4Path,
  ]);
  if (mp4.status !== 0) throw new Error(`ffmpeg MP4 fixture failed: ${mp4.stderr.toString()}`);

  fixturePng = readFileSync(fixturePngPath);
  fixtureMp4 = readFileSync(fixtureMp4Path);
}

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert>): Promise<number> {
  const objectPath = values.objectPath ?? `/objects/test/${Math.random().toString(36).slice(2)}.bin`;
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    uploadedByUserId: userId,
    objectPath,
    mediaType: "image",
    approved: true,
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id, objectPath: mediaTable.objectPath, mediaType: mediaTable.mediaType });
  mediaIds.push(row.id);
  storageState.store.set(
    row.objectPath,
    row.mediaType === "video" ? fixtureMp4 : fixturePng,
  );
  return row.id;
}

async function makeReel(opts: {
  options: Record<string, unknown>;
  templateId?: string;
  tournamentId?: number | null;
}): Promise<number> {
  const [r] = await db.insert(highlightReelsTable).values({
    organizationId: orgId,
    userId,
    tournamentId: opts.tournamentId ?? null,
    templateId: opts.templateId ?? "minimalist", // shortest perPhotoSeconds → fastest render
    title: "Render Test",
    options: opts.options,
    summary: {},
    status: "rendering",
    attempts: 1,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  makeFixtureBuffers();

  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [oA] = await db.insert(organizationsTable).values({
    name: `RenderClipsOrgA_${ts}`, slug: `render-clips-a-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = oA.id;
  const [oB] = await db.insert(organizationsTable).values({
    name: `RenderClipsOrgB_${ts}`, slug: `render-clips-b-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = oB.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `render-clips-${ts}`, username: `rc_${ts}`,
    email: `rc_${ts}@test.local`, displayName: "Render Tester",
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `render-clips-other-${ts}`, username: `rco_${ts}`,
    email: `rco_${ts}@test.local`, displayName: "Other Tester",
    role: "player", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = u2.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `Render Clips Tournament ${ts}`,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;
}, 60_000);

afterAll(async () => {
  if (reelIds.length > 0) await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  // Renderer registers media rows for the rendered MP4 + thumbnail; clean
  // those up too so we don't leak rows.
  if (orgId) await db.delete(mediaTable).where(eq(mediaTable.organizationId, orgId));
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  if (tournamentId) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  for (const u of [userId, otherUserId].filter(Boolean)) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  for (const o of [orgId, otherOrgId].filter(Boolean)) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, o));
  }
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ffprobeDuration(file: string): number {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr.toString()}`);
  return parseFloat(r.stdout.toString().trim());
}

function isMp4(buf: Buffer): boolean {
  // ISO Base Media File Format: bytes 4..8 should be "ftyp".
  return buf.length > 12 && buf.toString("ascii", 4, 8) === "ftyp";
}

function extractFrameAt(file: string, timeSec: number, outPng: string): void {
  const r = spawnSync("ffmpeg", [
    "-y", "-ss", String(timeSec), "-i", file,
    "-frames:v", "1", outPng,
  ]);
  if (r.status !== 0 || !existsSync(outPng) || statSync(outPng).size === 0) {
    throw new Error(`ffmpeg frame extract failed: ${r.stderr.toString()}`);
  }
}

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

describe("highlight renderer — opts.clips ordering & filtering", () => {
  it("uses opts.clips order verbatim, ignoring includedMediaIds and auto-pick", async () => {
    storageState.fetchOrder.length = 0;
    const a = await seedMedia({ caption: "A" });
    const b = await seedMedia({ caption: "B" });
    const c = await seedMedia({ caption: "C" });

    // includedMediaIds asks for (a,b) — must be IGNORED because clips is set.
    // clips orders the player media as c → a → b.
    const reelId = await makeReel({
      options: {
        includedMediaIds: [a, b],
        clips: [{ mediaId: c }, { mediaId: a }, { mediaId: b }],
      },
    });

    await executeRender(reelId);

    // The renderer should have downloaded exactly the 3 player clips, in
    // clips-array order. (No other downloads happen — intro/outro come from
    // SVG → PNG locally.)
    const idsByPath = new Map(
      (await db.select().from(mediaTable).where(inArray(mediaTable.id, [a, b, c])))
        .map(m => [m.objectPath, m.id]),
    );
    const fetchedMediaIds = storageState.fetchOrder
      .map(p => idsByPath.get(p))
      .filter((x): x is number => typeof x === "number");
    expect(fetchedMediaIds).toEqual([c, a, b]);

    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, reelId));
    expect(row.status).toBe("ready");
    expect(row.outputObjectPath).toBeTruthy();
  }, 60_000);

  it("silently drops mediaIds that don't belong to the caller or the round", async () => {
    storageState.fetchOrder.length = 0;
    const mine = await seedMedia({ caption: "mine" });
    // Foreign: another user, another org, no tournament shared with reel.
    const foreign = await seedMedia({
      caption: "foreign",
      organizationId: otherOrgId,
      uploadedByUserId: otherUserId,
    });

    const reelId = await makeReel({
      options: { clips: [{ mediaId: foreign }, { mediaId: mine }] },
    });
    await executeRender(reelId);

    const idsByPath = new Map(
      (await db.select().from(mediaTable).where(inArray(mediaTable.id, [mine, foreign])))
        .map(m => [m.objectPath, m.id]),
    );
    const fetchedMediaIds = storageState.fetchOrder
      .map(p => idsByPath.get(p))
      .filter((x): x is number => typeof x === "number");
    // Foreign clip must be dropped before any storage fetch happens.
    expect(fetchedMediaIds).toEqual([mine]);
  }, 60_000);
});

describe("highlight renderer — per-clip captions render into the MP4", () => {
  it("a captioned clip differs in pixels from the same uncaptioned clip", async () => {
    const tmpOut = mkdtempSync(path.join(tmpdir(), "hl-capt-"));
    try {
      const m = await seedMedia({ caption: "shot" });

      const captionText = "Hello world from caption test 12345";
      const captionedReel = await makeReel({
        options: { clips: [{ mediaId: m, caption: captionText }] },
      });
      const plainReel = await makeReel({ options: { clips: [{ mediaId: m }] } });

      await executeRender(captionedReel);
      await executeRender(plainReel);

      const [capRow] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, captionedReel));
      const [plainRow] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, plainReel));
      const capBuf = storageState.saved.get(capRow.outputObjectPath!);
      const plainBuf = storageState.saved.get(plainRow.outputObjectPath!);
      expect(capBuf && plainBuf).toBeTruthy();
      expect(isMp4(capBuf!)).toBe(true);
      expect(isMp4(plainBuf!)).toBe(true);

      // Buffers must differ — proves the caption pipeline did SOMETHING.
      expect(md5(capBuf!)).not.toBe(md5(plainBuf!));

      // And, more rigorously, a frame extracted from the *player clip*
      // section (i.e. after the intro card) must differ between the two
      // versions. The Minimalist template uses introSeconds=2 + per-clip 2s,
      // so sampling at t=2.5s lands inside the captioned clip.
      const capMp4 = path.join(tmpOut, "cap.mp4");
      const plainMp4 = path.join(tmpOut, "plain.mp4");
      writeFileSync(capMp4, capBuf!);
      writeFileSync(plainMp4, plainBuf!);
      const capFrame = path.join(tmpOut, "cap.png");
      const plainFrame = path.join(tmpOut, "plain.png");
      extractFrameAt(capMp4, 2.5, capFrame);
      extractFrameAt(plainMp4, 2.5, plainFrame);
      const capFrameBuf = readFileSync(capFrame);
      const plainFrameBuf = readFileSync(plainFrame);
      expect(md5(capFrameBuf)).not.toBe(md5(plainFrameBuf));
    } finally {
      try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 90_000);
});

describe("highlight renderer — per-clip trim window (Task #1574)", () => {
  it("ROUND-TRIP: opts.clips[i].durationSec actually trims the rendered output", async () => {
    // The fixture MP4 is 2.0s of solid blue. Render it once with the
    // template's default per-photo duration (no trim) and once with an
    // explicit 1.0s trim window — the second render must be ~1s shorter
    // overall, proving the renderer honored the persisted window rather
    // than falling back to the template default.
    const tmpOut = mkdtempSync(path.join(tmpdir(), "hl-trim-"));
    try {
      // Measured-duration video — required for the API to honor a trim
      // window per Task #1574 (legacy clips with duration=NULL still get
      // the trim stripped — see highlight-trim-no-default-legacy-clip).
      const v = await seedMedia({ caption: "swing", mediaType: "video", durationSeconds: 2 });

      const noTrim = await makeReel({ options: { clips: [{ mediaId: v }] } });
      const trimmed = await makeReel({
        options: { clips: [{ mediaId: v, startSec: 0, durationSec: 1 }] },
      });

      await executeRender(noTrim);
      await executeRender(trimmed);

      const [noRow] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, noTrim));
      const [trRow] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, trimmed));
      expect(noRow.status).toBe("ready");
      expect(trRow.status).toBe("ready");

      const noBuf = storageState.saved.get(noRow.outputObjectPath!);
      const trBuf = storageState.saved.get(trRow.outputObjectPath!);
      expect(noBuf && trBuf).toBeTruthy();

      const noFile = path.join(tmpOut, "no.mp4");
      const trFile = path.join(tmpOut, "tr.mp4");
      writeFileSync(noFile, noBuf!);
      writeFileSync(trFile, trBuf!);
      const noDur = ffprobeDuration(noFile);
      const trDur = ffprobeDuration(trFile);

      // Minimalist template: intro 2s + clip + outro 2s.
      //   no-trim → clip uses template's perPhotoSeconds (2s) → ~6s total
      //   trimmed → clip is 1s                                 → ~5s total
      // Allow a small tolerance for ffmpeg encoder overhead/headers.
      expect(trDur).toBeGreaterThan(4);
      expect(trDur).toBeLessThan(5.5);
      expect(noDur - trDur).toBeGreaterThan(0.5);

      // Persisted rounded-duration column should reflect the trimmed length.
      expect(trRow.durationSeconds).toBe(5);
      expect(noRow.durationSeconds).toBe(6);
    } finally {
      try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120_000);
});

describe("highlight renderer — video clip path", () => {
  it("renders a video clip into a valid, ffprobe-readable MP4", async () => {
    const tmpOut = mkdtempSync(path.join(tmpdir(), "hl-vid-"));
    try {
      const v = await seedMedia({ caption: "swing", mediaType: "video" });
      const reelId = await makeReel({
        options: { clips: [{ mediaId: v, caption: "Swing!" }] },
      });
      await executeRender(reelId);

      const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, reelId));
      expect(row.status).toBe("ready");
      expect(row.outputObjectPath).toBeTruthy();

      const buf = storageState.saved.get(row.outputObjectPath!);
      expect(buf).toBeTruthy();
      expect(isMp4(buf!)).toBe(true);

      const outFile = path.join(tmpOut, "out.mp4");
      writeFileSync(outFile, buf!);
      const dur = ffprobeDuration(outFile);
      // Minimalist template: 2 (intro) + 2 (video) + 2 (outro) = 6s, ±1s slack.
      expect(dur).toBeGreaterThan(5);
      expect(dur).toBeLessThan(8);

      // durationSeconds column should match the rounded sum.
      expect(row.durationSeconds).toBe(6);
    } finally {
      try { rmSync(tmpOut, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 90_000);
});

