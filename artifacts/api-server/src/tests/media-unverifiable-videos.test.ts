/**
 * Test: Task #1154 — admin-facing list and re-upload nudge for legacy
 * videos whose duration we couldn't measure.
 *
 * Covers:
 *   • GET  /api/organizations/:orgId/media/unverifiable-videos
 *       - admin-only (403 for players, 401 unauthenticated)
 *       - filters to org + mediaType=video + durationSeconds IS NULL
 *       - returns total `count` even when paginated to ITEMS_LIMIT
 *
 *   • POST /api/organizations/:orgId/media/:mediaId/request-reupload
 *       - admin-only
 *       - emails the uploader when they have an email on file
 *       - returns reason="no_email" / "uploader_unknown" when there's
 *         no one to notify (admin should fall back to delete)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Stub out nodemailer so the test doesn't try to talk to an SMTP server.
const sendMailMock = vi.hoisted(() => vi.fn(async () => ({ accepted: ["x"] })));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: sendMailMock,
      verify: async () => true,
    }),
  },
  createTransport: () => ({
    sendMail: sendMailMock,
    verify: async () => true,
  }),
}));

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
let uploaderWithEmail: number;
let uploaderNoEmail: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [o] = await db.insert(organizationsTable).values({
    name: `UnverifVideosOrg_${ts}`,
    slug: `unverif-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [o2] = await db.insert(organizationsTable).values({
    name: `OtherOrg_${ts}`,
    slug: `other-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = o2.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `unverif-admin-${ts}`,
    username: `admin_${ts}`,
    email: `admin_${ts}@test.local`,
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `unverif-player-${ts}`,
    username: `player_${ts}`,
    email: `player_${ts}@test.local`,
    displayName: "Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerId = player.id;

  const [uEmail] = await db.insert(appUsersTable).values({
    replitUserId: `unverif-up-email-${ts}`,
    username: `up_email_${ts}`,
    email: `up_email_${ts}@test.local`,
    displayName: "Up With Email",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  uploaderWithEmail = uEmail.id;

  const [uNoEmail] = await db.insert(appUsersTable).values({
    replitUserId: `unverif-up-noemail-${ts}`,
    username: `up_noemail_${ts}`,
    email: null,
    displayName: "Up No Email",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  uploaderNoEmail = uNoEmail.id;
});

afterAll(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  for (const u of [adminId, playerId, uploaderWithEmail, uploaderNoEmail].filter(Boolean)) {
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
  sendMailMock.mockClear();
});

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert> = {}) {
  // Default to a row the background cron has already given up on
  // (Task #1584) so it shows up on the admin unverifiable list. Tests
  // that need an "in-flight" auto-retry row override
  // durationUnverifiableReason to null explicitly.
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    durationUnverifiableReason: "permanently_unverifiable",
    approved: true,
    uploadedByUserId: uploaderWithEmail,
    uploaderName: "Up With Email",
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

describe("GET /api/organizations/:orgId/media/unverifiable-videos", () => {
  it("requires admin role", async () => {
    const appAnon = createTestApp();
    expect((await request(appAnon).get(`/api/organizations/${orgId}/media/unverifiable-videos`)).status).toBe(403);

    const appPlayer = createTestApp(asPlayer());
    expect((await request(appPlayer).get(`/api/organizations/${orgId}/media/unverifiable-videos`)).status).toBe(403);
  });

  it("returns only video rows in this org with NULL durationSeconds", async () => {
    const target = await seedMedia({ caption: "broken" });
    await seedMedia({ caption: "ok", durationSeconds: 12 }); // measured — excluded
    await seedMedia({ caption: "image", mediaType: "image" }); // image — excluded
    await seedMedia({ caption: "cross-org", organizationId: otherOrgId }); // other org — excluded

    const res = await request(createTestApp(asAdmin()))
      .get(`/api/organizations/${orgId}/media/unverifiable-videos`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(target);
    expect(res.body.items[0].caption).toBe("broken");
    expect(res.body.truncated).toBe(false);
  });

  // Task #1972: the admin Video Cleanup page disables a row's "Re-check"
  // button while the row is inside the per-row re-check cooldown. We
  // surface the cooldown window on the list response so the UI can
  // render the countdown without hard-coding the 60s constant.
  it("surfaces the per-row re-check cooldown so the UI doesn't hard-code it", async () => {
    await seedMedia();
    const res = await request(createTestApp(asAdmin()))
      .get(`/api/organizations/${orgId}/media/unverifiable-videos`);
    expect(res.status).toBe(200);
    expect(typeof res.body.cooldownSeconds).toBe("number");
    expect(res.body.cooldownSeconds).toBeGreaterThan(0);
  });

  // Task #1990: the admin Video Cleanup table needs to show admins which
  // uploaders are still inside the per-uploader 24h re-upload nudge
  // cooldown so they can deselect those rows before clicking. The GET
  // response surfaces the per-uploader MAX(last_reupload_request_at) on
  // every row owned by that uploader, and the cooldown window itself, so
  // the table doesn't have to hard-code the policy.
  it("surfaces uploaderLastNudgedAt (max per uploader) and reuploadCooldownHours", async () => {
    const justNudged = new Date(Date.now() - 30 * 60 * 1000); // 30m ago
    const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5d ago
    // Two rows for the same nudged uploader — one with the recent stamp
    // and a sibling without — so we can confirm the response shares the
    // uploader's max across both rows (not just the row that was nudged
    // directly).
    const recentId = await seedMedia({
      uploadedByUserId: uploaderWithEmail,
      lastReuploadRequestAt: justNudged,
    });
    const siblingId = await seedMedia({
      uploadedByUserId: uploaderWithEmail,
      lastReuploadRequestAt: null,
    });
    // Older nudge for the same uploader — the response must report the
    // most recent stamp, not just any stamp on file.
    await seedMedia({ uploadedByUserId: uploaderWithEmail, lastReuploadRequestAt: longAgo });
    // A row for an uploader who's never been nudged — must come back as
    // null so the UI doesn't gray out an unrelated button.
    const cleanId = await seedMedia({ uploadedByUserId: uploaderNoEmail });
    // A row with no uploader on file — must also come back as null.
    const orphanId = await seedMedia({ uploadedByUserId: null });

    const res = await request(createTestApp(asAdmin()))
      .get(`/api/organizations/${orgId}/media/unverifiable-videos`);
    expect(res.status).toBe(200);
    expect(typeof res.body.reuploadCooldownHours).toBe("number");
    expect(res.body.reuploadCooldownHours).toBeGreaterThan(0);

    const byId = new Map<number, { uploaderLastNudgedAt: string | null }>(
      res.body.items.map((r: { id: number; uploaderLastNudgedAt: string | null }) => [r.id, r]),
    );
    // Both rows owned by the nudged uploader should expose the same
    // (most recent) timestamp, even though only one row carries the
    // stamp on the row itself.
    const recent = byId.get(recentId)!;
    const sibling = byId.get(siblingId)!;
    expect(recent.uploaderLastNudgedAt).not.toBeNull();
    expect(sibling.uploaderLastNudgedAt).toBe(recent.uploaderLastNudgedAt);
    expect(new Date(recent.uploaderLastNudgedAt!).getTime())
      .toBeCloseTo(justNudged.getTime(), -3); // ms-level rounding tolerance

    // Untouched uploader + orphan row must remain null so the UI doesn't
    // accidentally lump them in with the cooldown.
    expect(byId.get(cleanId)!.uploaderLastNudgedAt).toBeNull();
    expect(byId.get(orphanId)!.uploaderLastNudgedAt).toBeNull();
  });

  // Task #1598: the admin Video Cleanup page lets admins filter rows by the
  // uploader's email, so the GET response must surface that email (joined
  // from the uploader account). NULL when the uploader has no email on file
  // or has been deleted.
  it("includes uploaderEmail joined from the uploader account", async () => {
    await seedMedia({ uploadedByUserId: uploaderWithEmail });
    await seedMedia({ uploadedByUserId: uploaderNoEmail });
    await seedMedia({ uploadedByUserId: null });

    const res = await request(createTestApp(asAdmin()))
      .get(`/api/organizations/${orgId}/media/unverifiable-videos`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);

    // Exactly one row should carry the with-email uploader's address;
    // the other two (no_email + unknown uploader) must be NULL.
    const withEmail = res.body.items.filter(
      (r: { uploaderEmail: string | null }) => typeof r.uploaderEmail === "string",
    );
    const withoutEmail = res.body.items.filter(
      (r: { uploaderEmail: string | null }) => r.uploaderEmail === null,
    );
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0].uploaderEmail).toMatch(/up_email_.*@test\.local/);
    expect(withoutEmail).toHaveLength(2);
  });
});

describe("POST /api/organizations/:orgId/media/:mediaId/request-reupload", () => {
  it("requires admin role", async () => {
    const id = await seedMedia();
    const res = await request(createTestApp(asPlayer()))
      .post(`/api/organizations/${orgId}/media/${id}/request-reupload`);
    expect(res.status).toBe(403);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("emails the uploader when an address is on file", async () => {
    const id = await seedMedia({ caption: "trim me" });
    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/request-reupload`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: true });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const callArgs = sendMailMock.mock.calls[0] as unknown as Array<{ to: string; subject: string; html: string }>;
    const call = callArgs[0];
    expect(call.to).toMatch(/up_email_.*@test\.local/);
    expect(call.subject).toContain("re-upload");
  });

  it("reports reason=no_email when the uploader has no address", async () => {
    const id = await seedMedia({ uploadedByUserId: uploaderNoEmail });
    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/request-reupload`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: false, reason: "no_email" });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("rejects rows that are not unverifiable videos (image, or already-measured video)", async () => {
    const imageId = await seedMedia({ mediaType: "image", durationSeconds: null });
    const measuredId = await seedMedia({ mediaType: "video", durationSeconds: 12 });

    for (const id of [imageId, measuredId]) {
      const res = await request(createTestApp(asAdmin()))
        .post(`/api/organizations/${orgId}/media/${id}/request-reupload`);
      expect(res.status).toBe(409);
    }
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("reports reason=uploader_unknown when the uploader id is null", async () => {
    const id = await seedMedia({ uploadedByUserId: null });
    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${id}/request-reupload`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, emailed: false, reason: "uploader_unknown" });
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
