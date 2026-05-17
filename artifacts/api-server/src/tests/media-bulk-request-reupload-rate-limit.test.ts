/**
 * Test: Task #1597 — Protect uploaders from accidental email blasts on
 * bulk re-upload.
 *
 * Covers the new POST .../media/unverifiable-videos/bulk-request-reupload
 * behaviour:
 *
 *   • per-uploader de-duplication within a single call: selecting many
 *     videos that all belong to the same uploader collapses to ONE
 *     email listing every clip, and `uploadersEmailedCount` reflects
 *     the actual number of emails sent (not the row count).
 *   • per-uploader rate limit across calls: a follow-up bulk call (or
 *     a per-row click) within the cooldown window returns the affected
 *     rows as `skipped` with `reason: "rate_limited"` and a
 *     `retryAfterSeconds` so the UI can surface a friendly countdown
 *     instead of sending another email.
 *   • the per-row endpoint shares the same cooldown so an admin can't
 *     bypass the bulk protection by clicking individual rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

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
let adminId: number;
let uploaderA: number;
let uploaderB: number;
let uploaderNoEmail: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [o] = await db.insert(organizationsTable).values({
    name: `BulkReupOrg_${ts}`,
    slug: `bulkreup-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `bulkreup-admin-${ts}`,
    username: `admin_${ts}`,
    email: `admin_${ts}@test.local`,
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `bulkreup-up-a-${ts}`,
    username: `up_a_${ts}`,
    email: `up_a_${ts}@test.local`,
    displayName: "Uploader A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  uploaderA = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `bulkreup-up-b-${ts}`,
    username: `up_b_${ts}`,
    email: `up_b_${ts}@test.local`,
    displayName: "Uploader B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  uploaderB = b.id;

  const [n] = await db.insert(appUsersTable).values({
    replitUserId: `bulkreup-up-noemail-${ts}`,
    username: `up_noemail_${ts}`,
    email: null,
    displayName: "No Email",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  uploaderNoEmail = n.id;
});

afterAll(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  for (const u of [adminId, uploaderA, uploaderB, uploaderNoEmail].filter(Boolean)) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  if (mediaIds.length > 0) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
  sendMailMock.mockClear();
});

async function seedMedia(uploaderId: number | null, opts: { caption?: string | null; lastReuploadRequestAt?: Date | null } = {}) {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    durationUnverifiableReason: "permanently_unverifiable",
    approved: true,
    uploadedByUserId: uploaderId,
    uploaderName: uploaderId ? `Uploader ${uploaderId}` : null,
    caption: opts.caption ?? null,
    lastReuploadRequestAt: opts.lastReuploadRequestAt ?? null,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

function asAdmin(): TestUser {
  return { id: adminId, username: "admin", role: "org_admin", organizationId: orgId };
}

describe("POST /api/organizations/:orgId/media/unverifiable-videos/bulk-request-reupload (Task #1597)", () => {
  it("collapses multiple videos for the same uploader into ONE email per call", async () => {
    // Three videos for A, two for B → 5 selected ids, 2 emails sent.
    const a1 = await seedMedia(uploaderA, { caption: "first" });
    const a2 = await seedMedia(uploaderA, { caption: "second" });
    const a3 = await seedMedia(uploaderA, { caption: null });
    const b1 = await seedMedia(uploaderB, { caption: "b-first" });
    const b2 = await seedMedia(uploaderB, { caption: "b-second" });

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`)
      .send({ mediaIds: [a1, a2, a3, b1, b2] });

    expect(res.status).toBe(200);
    expect(res.body.uploadersEmailedCount).toBe(2);
    expect(res.body.emailedCount).toBe(5); // every selected row covered
    expect(res.body.skippedCount).toBe(0);
    expect(res.body.errorCount).toBe(0);
    expect(sendMailMock).toHaveBeenCalledTimes(2);

    // Each uploader receives exactly one email; the multi-clip body lists
    // every selected video (we just check that A's email mentions the 3
    // captions and B's email mentions both of theirs).
    const callsByRecipient = new Map<string, { subject: string; body: string }>();
    for (const c of sendMailMock.mock.calls) {
      const arg = (c as unknown as Array<{ to: string; subject: string; html: string; text?: string }>)[0];
      callsByRecipient.set(arg.to, { subject: arg.subject, body: arg.html ?? arg.text ?? "" });
    }
    expect(callsByRecipient.size).toBe(2);
    const aEmail = Array.from(callsByRecipient.entries()).find(([to]) => to.includes("up_a_"));
    const bEmail = Array.from(callsByRecipient.entries()).find(([to]) => to.includes("up_b_"));
    expect(aEmail).toBeDefined();
    expect(bEmail).toBeDefined();
    expect(aEmail![1].body).toContain("first");
    expect(aEmail![1].body).toContain("second");
    expect(aEmail![1].subject).toMatch(/3 videos/);
    expect(bEmail![1].subject).toMatch(/2 videos/);

    // All five rows now have a lastReuploadRequestAt stamp so the
    // cooldown applies to a follow-up call.
    const stamped = await db
      .select({ id: mediaTable.id, lastReuploadRequestAt: mediaTable.lastReuploadRequestAt })
      .from(mediaTable)
      .where(inArray(mediaTable.id, [a1, a2, a3, b1, b2]));
    for (const row of stamped) {
      expect(row.lastReuploadRequestAt).not.toBeNull();
    }
  });

  it("rate-limits a second call for the same uploader and reports reason='rate_limited' with retryAfterSeconds", async () => {
    const a1 = await seedMedia(uploaderA, { caption: "first" });
    const a2 = await seedMedia(uploaderA, { caption: "second" });

    // First call sends one email and stamps both rows.
    const first = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`)
      .send({ mediaIds: [a1, a2] });
    expect(first.status).toBe(200);
    expect(first.body.uploadersEmailedCount).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    // Even selecting a brand-new video for A in a follow-up click should
    // be skipped: it's the same uploader inside the cooldown window.
    sendMailMock.mockClear();
    const a3 = await seedMedia(uploaderA, { caption: "third" });

    const second = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`)
      .send({ mediaIds: [a3] });
    expect(second.status).toBe(200);
    expect(second.body.uploadersEmailedCount).toBe(0);
    expect(second.body.emailedCount).toBe(0);
    expect(second.body.skippedCount).toBe(1);
    expect(second.body.skipped[0]).toMatchObject({
      mediaId: a3,
      reason: "rate_limited",
    });
    expect(second.body.skipped[0].retryAfterSeconds).toBeGreaterThan(0);
    expect(second.body.cooldownHours).toBeGreaterThan(0);
    expect(sendMailMock).not.toHaveBeenCalled();

    // The skipped row's stamp stays NULL — only emailed rows are bumped,
    // so once the cooldown lapses the cleanup workflow can still nudge
    // about it.
    const [skippedRow] = await db
      .select({ lastReuploadRequestAt: mediaTable.lastReuploadRequestAt })
      .from(mediaTable)
      .where(eq(mediaTable.id, a3));
    expect(skippedRow.lastReuploadRequestAt).toBeNull();
  });

  it("mixes rate_limited, no_email, uploader_unknown, and emailed in a single response", async () => {
    // A is freshly inside the cooldown.
    const aOld = await seedMedia(uploaderA, { lastReuploadRequestAt: new Date() });
    const aNew = await seedMedia(uploaderA, { caption: "fresh-A" });
    // B is new — should get one email covering both videos.
    const b1 = await seedMedia(uploaderB, { caption: "b-1" });
    const b2 = await seedMedia(uploaderB, { caption: "b-2" });
    // No email on file → skipped/no_email.
    const noEmail = await seedMedia(uploaderNoEmail);
    // Unknown uploader → skipped/uploader_unknown.
    const unknown = await seedMedia(null);

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`)
      .send({ mediaIds: [aOld, aNew, b1, b2, noEmail, unknown] });

    expect(res.status).toBe(200);
    expect(res.body.uploadersEmailedCount).toBe(1); // only B
    expect(res.body.emailedCount).toBe(2); // b1 + b2
    expect(res.body.emailed).toEqual(expect.arrayContaining([{ id: b1 }, { id: b2 }]));
    expect(res.body.skippedCount).toBe(4); // aOld + aNew (rate_limited) + noEmail + unknown

    const reasonsById = new Map(
      (res.body.skipped as Array<{ mediaId: number; reason: string }>).map((s) => [s.mediaId, s.reason]),
    );
    expect(reasonsById.get(aOld)).toBe("rate_limited");
    expect(reasonsById.get(aNew)).toBe("rate_limited");
    expect(reasonsById.get(noEmail)).toBe("no_email");
    expect(reasonsById.get(unknown)).toBe("uploader_unknown");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("per-row endpoint shares the same per-uploader cooldown and reports reason='rate_limited'", async () => {
    // Pre-stamp one of A's other rows as if a recent bulk nudge ran.
    await seedMedia(uploaderA, { lastReuploadRequestAt: new Date() });
    const target = await seedMedia(uploaderA, { caption: "fresh" });

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/${target}/request-reupload`);

    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(false);
    expect(res.body.reason).toBe("rate_limited");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("once an uploader's cooldown has lapsed, the row can be nudged again", async () => {
    // Stamp an earlier row well outside the cooldown window (48h ago).
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await seedMedia(uploaderA, { lastReuploadRequestAt: longAgo });
    const target = await seedMedia(uploaderA, { caption: "ready" });

    const res = await request(createTestApp(asAdmin()))
      .post(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`)
      .send({ mediaIds: [target] });

    expect(res.status).toBe(200);
    expect(res.body.uploadersEmailedCount).toBe(1);
    expect(res.body.emailedCount).toBe(1);
    expect(res.body.skippedCount).toBe(0);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
