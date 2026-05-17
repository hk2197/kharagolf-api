/**
 * Task #1975 — When `recheckLegacyVideoDurations` auto-flags one or more
 * rows as `object_missing` / `permanently_unverifiable` in a single
 * pass, every org admin of the affected org gets a single digest email
 * listing the rows. Mirrors the email coverage in
 * `marketing-image-recheck-cron.test.ts` (Task #1249).
 *
 * Coverage:
 *   1. A pass that flags one row sends a digest email to each org
 *      admin (direct + via org_memberships, deduped by user id), with
 *      the row's object path, uploader, and reason carried through.
 *   2. A pass that flags two rows in the same org rolls them into ONE
 *      digest per admin — admins are not spammed with one email per
 *      row.
 *   3. A failed pass under the auto-retry cap does NOT email anyone.
 *   4. The dedup column (`durationFlagNotifiedAt`) is stamped so a
 *      subsequent pass that re-encounters the same row (e.g. via a
 *      manual recheck → re-flag round trip) does not re-email about
 *      it.
 *
 * Test isolation pattern (mirrors marketing-image-recheck-cron.test.ts):
 * the cron iterates `media` globally, so other suites' rows would
 * otherwise leak into our assertions. The beforeEach below pre-flags
 * every other NULL-duration video as already-unverifiable for the
 * duration of this test, exactly as `legacy-video-recheck-cron.test.ts`
 * does, so our mock + email assertions only fire for rows we own.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-legacy-video-recheck-email";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const { sendLegacyVideoUnverifiableDigestEmailMock } = vi.hoisted(() => ({
  sendLegacyVideoUnverifiableDigestEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
}));

// Stub the probe lib (lazy-loaded by the cron) so we control success /
// failure without ffprobe + object storage in the container.
const probeMock = vi.hoisted(() => vi.fn<(p: string) => Promise<number | null>>());
vi.mock("../lib/mediaDurationProbe", () => ({
  probeMediaDurationSeconds: probeMock,
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendLegacyVideoUnverifiableDigestEmail: sendLegacyVideoUnverifiableDigestEmailMock,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  mediaTable,
  orgMembershipsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  recheckLegacyVideoDurations,
  _setLegacyVideoRecheckTuningForTest,
} from "../lib/cron.js";
import { uid } from "./helpers.js";

let orgId: number;
let adminA: { id: number; username: string };
let adminB: { id: number; username: string };
const createdUserIds: number[] = [];
const createdMembershipUserIds: number[] = [];
const mediaIds: number[] = [];

async function makeUser(orgIdArg: number, role: OrgRole): Promise<{ id: number; username: string }> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role,
    organizationId: orgIdArg,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `legacy-vid-email-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `LegacyVidEmail_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // Two admins so the dedup logic + per-recipient email loop both get
  // exercised. Admin A is org_admin via app_users.role; Admin B is
  // org_admin via org_memberships only — both should be reached.
  adminA = await makeUser(orgId, "org_admin");
  adminB = await makeUser(orgId, "player");
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: adminB.id,
    role: "org_admin",
  });
  createdMembershipUserIds.push(adminB.id);
});

afterAll(async () => {
  if (mediaIds.length) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
  if (createdMembershipUserIds.length) {
    await db.delete(orgMembershipsTable).where(
      inArray(orgMembershipsTable.userId, createdMembershipUserIds),
    );
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendLegacyVideoUnverifiableDigestEmailMock.mockClear();
  // autoRetryCap=1 → a single failed probe trips the give-up branch.
  _setLegacyVideoRecheckTuningForTest({ autoRetryCap: 1, perRowMs: 1, batchSize: 50 });
  probeMock.mockReset();

  // Flag every other NULL-duration video so the cron only ever calls
  // our probe mock for rows we explicitly seed in this org. Mirrors
  // the row-scoping the sibling cron test uses for the same DB.
  await db
    .update(mediaTable)
    .set({ durationUnverifiableReason: "permanently_unverifiable" })
    .where(and(
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      isNull(mediaTable.durationUnverifiableReason),
      ne(mediaTable.organizationId, orgId),
    ));
});

afterEach(async () => {
  _setLegacyVideoRecheckTuningForTest(null);
  if (mediaIds.length) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
});

async function seedRow(values: Partial<typeof mediaTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    approved: true,
    uploaderName: "Tester",
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

async function readNotifiedAt(id: number): Promise<Date | null> {
  const [r] = await db
    .select({ notifiedAt: mediaTable.durationFlagNotifiedAt })
    .from(mediaTable)
    .where(eq(mediaTable.id, id))
    .limit(1);
  return r?.notifiedAt ?? null;
}

describe("Task #1975 — recheckLegacyVideoDurations digest email", () => {
  it("emails each org admin a digest with the row's object path, uploader, and reason", async () => {
    const objectPath = `/objects/test/${Math.random().toString(36).slice(2)}.mp4`;
    const id = await seedRow({ objectPath, uploaderName: "Aoki" });
    probeMock.mockResolvedValueOnce(null); // probe fails → row crosses cap (cap=1)

    await recheckLegacyVideoDurations();

    // Two admins (A direct, B via membership) → two emails.
    const ourCalls = sendLegacyVideoUnverifiableDigestEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(ourCalls).toHaveLength(2);
    const emailedTo = ourCalls.map(c => (c[0] as { to: string }).to);
    expect(emailedTo).toContain(`${adminA.username}@example.com`);
    expect(emailedTo).toContain(`${adminB.username}@example.com`);

    // Each email's row payload carries the object path, uploader, and
    // the cron's reason (`permanently_unverifiable` since this was a
    // probe-returns-null failure, not a missing-object exception).
    for (const call of ourCalls) {
      const args = call[0] as {
        rows: Array<{
          mediaId: number;
          objectPath: string;
          uploaderName: string | null;
          reason: string;
        }>;
      };
      expect(args.rows).toHaveLength(1);
      expect(args.rows[0]!.mediaId).toBe(id);
      expect(args.rows[0]!.objectPath).toBe(objectPath);
      expect(args.rows[0]!.uploaderName).toBe("Aoki");
      expect(args.rows[0]!.reason).toBe("permanently_unverifiable");
    }

    // Dedup column stamped so a re-encounter doesn't re-email.
    expect(await readNotifiedAt(id)).not.toBeNull();
  });

  it("rolls multiple rows from the same org into a single digest per admin", async () => {
    const id1 = await seedRow({ uploaderName: "Player One" });
    const id2 = await seedRow({ uploaderName: "Player Two" });
    // Both rows fail their first probe → both cross the cap=1 in this pass.
    probeMock.mockResolvedValue(null);

    await recheckLegacyVideoDurations();

    const ourCalls = sendLegacyVideoUnverifiableDigestEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    // Two admins × ONE digest each (not one digest per row).
    expect(ourCalls).toHaveLength(2);
    for (const call of ourCalls) {
      const args = call[0] as {
        rows: Array<{ mediaId: number; uploaderName: string | null }>;
      };
      expect(args.rows).toHaveLength(2);
      const ids = args.rows.map(r => r.mediaId).sort();
      expect(ids).toEqual([id1, id2].sort());
      const uploaders = args.rows.map(r => r.uploaderName).sort();
      expect(uploaders).toEqual(["Player One", "Player Two"]);
    }
  });

  it("does not email anyone when a failing probe stays under the auto-retry cap", async () => {
    // Bump cap so a single failure DOES NOT cross it.
    _setLegacyVideoRecheckTuningForTest({ autoRetryCap: 5, perRowMs: 1, batchSize: 50 });
    await seedRow();
    probeMock.mockResolvedValueOnce(null);

    await recheckLegacyVideoDurations();

    const ourCalls = sendLegacyVideoUnverifiableDigestEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(ourCalls).toHaveLength(0);
  });

  it("does not re-email about a row that was already included in a previous digest", async () => {
    const id = await seedRow();
    probeMock.mockResolvedValueOnce(null);
    await recheckLegacyVideoDurations();

    // First pass: digest sent + dedup column stamped.
    const firstPassCalls = sendLegacyVideoUnverifiableDigestEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(firstPassCalls).toHaveLength(2);
    const stampedAt = await readNotifiedAt(id);
    expect(stampedAt).not.toBeNull();
    sendLegacyVideoUnverifiableDigestEmailMock.mockClear();

    // Now simulate a manual recheck → re-flag race: clear the
    // unverifiable reason so the cron picks the row back up, then
    // run another pass that fails it again. The dedup column is
    // already stamped, so even though the row is freshly flagged
    // we should NOT re-email anyone about it.
    await db.update(mediaTable).set({
      durationUnverifiableReason: null,
      durationAutoRecheckCount: 0,
      durationLastCheckedAt: null,
    }).where(eq(mediaTable.id, id));
    probeMock.mockResolvedValueOnce(null);
    await recheckLegacyVideoDurations();

    const secondPassCalls = sendLegacyVideoUnverifiableDigestEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(secondPassCalls).toHaveLength(0);

    // Dedup column unchanged.
    const stampedAtAfter = await readNotifiedAt(id);
    expect(stampedAtAfter?.getTime()).toBe(stampedAt?.getTime());
  });
});
