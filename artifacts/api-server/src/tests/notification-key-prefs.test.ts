/**
 * Task #1170 — Per-notification-key delivery preference.
 *
 * Verifies:
 *   - The per-key override stored in `user_notification_key_prefs` flips
 *     dispatch from queued-to-digest into immediate send (and vice
 *     versa), overriding the global `digestMode` flag.
 *   - The override is only honored for digestable keys; non-digestable
 *     keys always send immediately regardless of any saved row.
 *   - The portal GET endpoint returns every digestable key with the
 *     user's override + effective mode.
 *   - The portal PATCH endpoint upserts a valid override, deletes when
 *     `deliveryMode = null`, and rejects unknown / non-digestable keys.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  userNotificationPrefsTable,
  userNotificationKeyPrefsTable,
  notificationDigestQueueTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import {
  dispatchNotification,
  _clearSpecCacheForTests,
} from "../lib/notifyDispatch.js";
import { createTestApp, uid } from "./helpers.js";

const pushMock = vi.mocked(sendPushToUsers);

let orgId: number;
let userId: number;

beforeAll(async () => {
  const tag = uid("t1170");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1170 ${tag}`, slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    email: `${tag}@example.test`,
    displayName: "Per-Key User",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  await db.delete(notificationDigestQueueTable).where(eq(notificationDigestQueueTable.userId, userId));
  await db.delete(userNotificationKeyPrefsTable).where(eq(userNotificationKeyPrefsTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  pushMock.mockClear();
  await db.delete(notificationDigestQueueTable).where(eq(notificationDigestQueueTable.userId, userId));
  await db.delete(userNotificationKeyPrefsTable).where(eq(userNotificationKeyPrefsTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  _clearSpecCacheForTests();
});

describe("Task #1170 — per-key delivery override at dispatch time", () => {
  it("forces digest queueing for a key the user marked 'digest', even when global digestMode is off", async () => {
    // Global digestMode default is false → without an override, this
    // dispatch would send immediately.
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "highlight.ready", deliveryMode: "digest",
    });

    const sendEmail = vi.fn(async () => true);
    await dispatchNotification(
      "highlight.ready",
      [userId],
      { title: "Reel ready", body: "Your reel is ready.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(pushMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();

    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userId));
    expect(queued).toHaveLength(1);
    expect(queued[0].notificationKey).toBe("highlight.ready");
  });

  it("forces immediate send for a key the user marked 'realtime', even when global digestMode is on", async () => {
    // Global digestMode = true → without an override, this dispatch
    // would queue. The per-key 'realtime' override must win.
    await db.insert(userNotificationPrefsTable).values({ userId, digestMode: true });
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "highlight.ready", deliveryMode: "realtime",
    });

    const sendEmail = vi.fn(async () => true);
    await dispatchNotification(
      "highlight.ready",
      [userId],
      { title: "Reel ready", body: "Your reel is ready.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userId));
    expect(queued).toHaveLength(0);
  });

  it("only consults overrides for the dispatched key — a 'digest' override on key A does not affect key B", async () => {
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "social.follow.new", deliveryMode: "digest",
    });

    const sendEmail = vi.fn(async () => true);
    // Dispatch a *different* digestable key. With no override on
    // highlight.ready and global digestMode off, it should send live.
    await dispatchNotification(
      "highlight.ready",
      [userId],
      { title: "Reel", body: "Body.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userId));
    expect(queued).toHaveLength(0);
  });

  it("ignores any override for non-digestable keys (always send immediately)", async () => {
    // booking.confirmed is non-digestable in SEED_TYPES. Even if we
    // somehow planted a 'digest' row for it, the dispatcher must send
    // immediately — non-digestable keys never enter the queue.
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "booking.confirmed", deliveryMode: "digest",
    });

    const sendEmail = vi.fn(async () => true);
    await dispatchNotification(
      "booking.confirmed",
      [userId],
      { title: "Booked", body: "Confirmed.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userId));
    expect(queued).toHaveLength(0);
  });
});

describe("Task #1170 — portal GET/PATCH /portal/notification-key-prefs", () => {
  it("GET returns every digestable key with override + effectiveMode reflecting the global digestMode flag", async () => {
    await db.insert(userNotificationPrefsTable).values({ userId, digestMode: true });
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "highlight.ready", deliveryMode: "realtime",
    });

    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app).get("/api/portal/notification-key-prefs");
    expect(res.status).toBe(200);
    expect(res.body.digestMode).toBe(true);
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys.length).toBeGreaterThan(0);

    // Every returned key must be digestable (the endpoint filters them).
    // Sanity: no non-digestable key like "booking.confirmed" should appear.
    const keyNames = new Set<string>(res.body.keys.map((k: { key: string }) => k.key));
    expect(keyNames.has("booking.confirmed")).toBe(false);
    expect(keyNames.has("highlight.ready")).toBe(true);

    const highlight = res.body.keys.find((k: { key: string }) => k.key === "highlight.ready");
    expect(highlight.override).toBe("realtime");
    expect(highlight.effectiveMode).toBe("realtime");

    // A key with no saved override must inherit the global digestMode.
    const followNew = res.body.keys.find((k: { key: string }) => k.key === "social.follow.new");
    expect(followNew.override).toBeNull();
    expect(followNew.effectiveMode).toBe("digest");
  });

  it("PATCH upserts a valid override and round-trips through GET", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const patch = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "social.follow.new", deliveryMode: "digest" });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ key: "social.follow.new", override: "digest" });

    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(eq(userNotificationKeyPrefsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryMode).toBe("digest");

    // Subsequent PATCH with a different value updates in place (upsert).
    const patch2 = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "social.follow.new", deliveryMode: "realtime" });
    expect(patch2.status).toBe(200);

    const rows2 = await db.select().from(userNotificationKeyPrefsTable)
      .where(eq(userNotificationKeyPrefsTable.userId, userId));
    expect(rows2).toHaveLength(1);
    expect(rows2[0].deliveryMode).toBe("realtime");
  });

  it("PATCH with deliveryMode=null clears the override and falls back to global digestMode", async () => {
    await db.insert(userNotificationKeyPrefsTable).values({
      userId, notificationKey: "highlight.ready", deliveryMode: "digest",
    });

    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "highlight.ready", deliveryMode: null });
    expect(res.status).toBe(200);
    expect(res.body.override).toBeNull();

    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, "highlight.ready"),
      ));
    expect(rows).toHaveLength(0);
  });

  it("PATCH rejects unknown notification keys with 404", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "does.not.exist", deliveryMode: "digest" });
    expect(res.status).toBe(404);
  });

  it("PATCH rejects non-digestable keys with 400", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "booking.confirmed", deliveryMode: "digest" });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects invalid deliveryMode values with 400", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/notification-key-prefs")
      .send({ key: "highlight.ready", deliveryMode: "weekly" });
    expect(res.status).toBe(400);
  });
});

describe("Task #1353 — DELETE /portal/notification-key-prefs (reset all overrides)", () => {
  it("clears every per-key override for the signed-in user and reports the count", async () => {
    await db.insert(userNotificationKeyPrefsTable).values([
      { userId, notificationKey: "highlight.ready", deliveryMode: "digest" },
      { userId, notificationKey: "social.follow.new", deliveryMode: "realtime" },
    ]);

    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app).delete("/api/portal/notification-key-prefs");
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);

    const remaining = await db.select().from(userNotificationKeyPrefsTable)
      .where(eq(userNotificationKeyPrefsTable.userId, userId));
    expect(remaining).toHaveLength(0);
  });

  it("is a no-op when the user has no overrides (returns cleared=0)", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player" });
    const res = await request(app).delete("/api/portal/notification-key-prefs");
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(0);
  });

  it("only deletes the signed-in user's rows (does not touch other users' overrides)", async () => {
    // Spin up a second user with their own override and verify the
    // DELETE for `userId` leaves the other user's row alone.
    const tag = uid("t1353-other");
    const [other] = await db.insert(appUsersTable).values({
      replitUserId: `${tag}-user`,
      username: `${tag}_user`,
      email: `${tag}@example.test`,
      displayName: "Other User",
      role: "player",
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });

    try {
      await db.insert(userNotificationKeyPrefsTable).values([
        { userId, notificationKey: "highlight.ready", deliveryMode: "digest" },
        { userId: other.id, notificationKey: "highlight.ready", deliveryMode: "digest" },
      ]);

      const app = createTestApp({ id: userId, username: "u", role: "player" });
      const res = await request(app).delete("/api/portal/notification-key-prefs");
      expect(res.status).toBe(200);
      expect(res.body.cleared).toBe(1);

      const otherRows = await db.select().from(userNotificationKeyPrefsTable)
        .where(eq(userNotificationKeyPrefsTable.userId, other.id));
      expect(otherRows).toHaveLength(1);
    } finally {
      await db.delete(userNotificationKeyPrefsTable).where(eq(userNotificationKeyPrefsTable.userId, other.id));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, other.id));
    }
  });
});

