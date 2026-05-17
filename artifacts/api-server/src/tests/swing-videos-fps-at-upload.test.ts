/**
 * Test: Task #910 — capture each swing video's frame rate at upload time.
 *
 * Verifies that POST /api/swing-videos populates `swing_videos.fps`
 * automatically, without waiting for a coach to open the review in their
 * browser:
 *
 *   1. When the client supplies a valid fps, the value is honoured verbatim
 *      and no probe runs.
 *   2. When the client omits fps, the route probes the uploaded object via
 *      ffprobe and persists the detected rate.
 *   3. When the probe cannot determine the rate, the route still inserts
 *      the row with a NULL fps (legacy fallback path).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Readable } from "stream";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.PRIVATE_OBJECT_DIR ||= "swing-fps-test-bucket/private";
process.env.SWING_UPLOAD_TOKEN_SECRET ||= "swing-fps-test-secret";

// Stub object storage so `probeVideoFps` can fetch our in-memory MP4 fixtures
// and the swing-videos POST handler's normalize step is a no-op.
const storageState = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
}));
vi.mock("../lib/objectStorage.js", () => {
  return {
    ObjectStorageService: class {
      normalizeObjectEntityPath(p: string) { return p; }
      async getObjectEntityFile(objectPath: string) {
        const buf = storageState.store.get(objectPath);
        if (!buf) throw new Error(`stub: no fixture registered for ${objectPath}`);
        return {
          createReadStream() { return Readable.from(buf); },
        } as unknown as import("@google-cloud/storage").File;
      }
    },
  };
});

import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberConsentsTable,
  swingVideosTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { signSwingUpload } from "../lib/swingUploadToken.js";
import { waitForPendingFpsProbes } from "../lib/swingFpsProbeQueue.js";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const fixtureDir = mkdtempSync(path.join(tmpdir(), "swing-fps-fixture-"));

function makeMp4(fps: number): Buffer {
  const out = path.join(fixtureDir, `vid_${fps}.mp4`);
  const r = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", `color=c=blue:size=160x120:d=1:r=${fps}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    out,
  ]);
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr.toString()}`);
  return readFileSync(out);
}

let orgId: number;
let userId: number;
let memberId: number;
let user: TestUser;
let app: ReturnType<typeof createTestApp>;
const insertedSwingIds: number[] = [];

beforeAll(async () => {
  const ts = uid("swingfps");
  const [org] = await db.insert(organizationsTable).values({
    name: `SwingFpsOrg_${ts}`, slug: `swing-fps-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `swing-fps-${ts}`, username: `sf_${ts}`,
    email: `sf_${ts}@test.local`, displayName: "Swing FPS Tester",
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId, userId,
    firstName: "Swing", lastName: "Tester",
    email: `sf_${ts}@test.local`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  // Grant the video consent so the route's consent gate lets us through.
  await db.insert(memberConsentsTable).values({
    clubMemberId: memberId, organizationId: orgId,
    consentType: "video", granted: true,
  });

  user = { id: userId, username: `sf_${ts}`, role: "player", organizationId: orgId };
  app = createTestApp(user);
}, 30_000);

afterAll(async () => {
  if (insertedSwingIds.length > 0) {
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, insertedSwingIds));
  }
  if (memberId) await db.delete(memberConsentsTable).where(eq(memberConsentsTable.clubMemberId, memberId));
  if (memberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function postSwingVideo(body: Record<string, unknown>) {
  return request(app).post("/api/swing-videos").send(body);
}

function makeUpload(objectPath: string) {
  const exp = Date.now() + 60_000;
  const token = signSwingUpload(objectPath, userId, exp);
  return { videoUrl: objectPath, videoUploadToken: token, videoUploadTokenExp: exp };
}

describe("Task #910 — swing video fps captured at upload time", () => {
  it("honours a client-supplied fps without probing", async () => {
    const objectPath = `/objects/uploads/swing-fps-client-${uid("c")}`;
    // Intentionally do NOT register a fixture for this path: if the route
    // probed it, ffprobe would fail and fps would be null.
    const res = await postSwingVideo({
      ...makeUpload(objectPath),
      fps: 120,
    });
    expect(res.status).toBe(200);
    expect(res.body.swingVideo).toBeTruthy();
    expect(Number(res.body.swingVideo.fps)).toBe(120);
    insertedSwingIds.push(res.body.swingVideo.id);
  });

  it("probes a real uploaded object with ffprobe out-of-band and persists the detected fps", async () => {
    const mp4 = makeMp4(60);
    const objectPath = `/objects/uploads/swing-fps-probe-${uid("p")}`;
    storageState.store.set(objectPath, mp4);

    const res = await postSwingVideo(makeUpload(objectPath));
    expect(res.status).toBe(200);
    expect(res.body.swingVideo).toBeTruthy();
    // Task #1057 — the probe is now scheduled after the response returns,
    // so the row is initially inserted with fps=NULL. The detected rate
    // arrives once the background probe finishes.
    expect(res.body.swingVideo.fps).toBeNull();
    insertedSwingIds.push(res.body.swingVideo.id);

    await waitForPendingFpsProbes();
    const [updated] = await db.select().from(swingVideosTable)
      .where(eq(swingVideosTable.id, res.body.swingVideo.id));
    // ffmpeg's libx264 mux can report a slightly different avg_frame_rate
    // than the requested rate (e.g. 60 vs 59.94) on some builds, so accept
    // a small tolerance against the requested 60.
    const fps = Number(updated.fps);
    expect(fps).toBeGreaterThan(0);
    expect(Math.abs(fps - 60)).toBeLessThan(1);
  }, 60_000);

  it("leaves the row with NULL fps when the background probe cannot determine the rate", async () => {
    const objectPath = `/objects/uploads/swing-fps-unverifiable-${uid("u")}`;
    storageState.store.set(objectPath, Buffer.from("not a video"));

    const res = await postSwingVideo(makeUpload(objectPath));
    expect(res.status).toBe(200);
    expect(res.body.swingVideo).toBeTruthy();
    expect(res.body.swingVideo.fps).toBeNull();
    insertedSwingIds.push(res.body.swingVideo.id);

    await waitForPendingFpsProbes();
    const [updated] = await db.select().from(swingVideosTable)
      .where(eq(swingVideosTable.id, res.body.swingVideo.id));
    expect(updated.fps).toBeNull();
  }, 120_000);
});
