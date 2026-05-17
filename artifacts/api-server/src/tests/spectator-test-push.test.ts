/**
 * Task #1084 — auto-test the spectator "Send test notification" endpoint
 * (added in Task #803, with a `lang` body override added in Task #941).
 *
 * Coverage:
 *   - Requires authentication (401 when anonymous).
 *   - With a supported `lang` override the previewed copy comes back in that
 *     language regardless of the user's stored `preferredLanguage`.
 *   - With no `lang` override the previewed copy falls back to the user's
 *     `preferredLanguage`.
 *   - With an unsupported `lang` override (e.g. "xx") it falls back to the
 *     user's `preferredLanguage`.
 *   - Users without a registered device token get a 200 + `delivered: false`
 *     + `reason: "no_device_token"` and still receive a localised preview.
 *   - Two rapid calls trip the per-user 30 s cooldown → 429 with a
 *     `retryAfterSeconds` value.
 *
 * Task #1463 — also locks in the `classification` field returned by the
 * route (Task #1240) so a future change cannot silently revert this admin
 * debug endpoint to the old "always success" reporting:
 *   - A successful delivery comes back with `classification: "sent"` and
 *     `delivered: true`.
 *   - A delivery where Expo rejects every ticket comes back with
 *     `classification: "failed"` and `delivered: false`.
 *   - A delivery where the recipient has only invalid (non-Expo) tokens
 *     registered comes back with `classification: "no_address"` and
 *     `delivered: false` instead of being booked as a real failure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  // Typed signature mirrors `sendPushToUsers` in `../lib/push.ts` so that
  // `mock.calls[0]` keeps its tuple shape — without this the `[, , , data]`
  // destructure below would type as the empty tuple.
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
}));

// Keep the real `classifyPushDelivery` in scope: the route under test imports
// both `sendPushToUsers` and `classifyPushDelivery` from `../lib/push`, so a
// mock that only stubs `sendPushToUsers` would leave `classifyPushDelivery`
// undefined and the route would throw 500 instead of returning the
// classification we want to assert on.
vi.mock("../lib/push.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/push.js")>("../lib/push.js");
  return {
    ...actual,
    sendPushToUsers: sendPushToUsersMock,
  };
});

import { db } from "@workspace/db";
import { appUsersTable, deviceTokensTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import { _resetSpectatorTestPushRateLimit } from "../routes/portal.js";

const createdUserIds: number[] = [];
const createdTokenIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-spectator-test-push";
});

beforeEach(() => {
  _resetSpectatorTestPushRateLimit();
  sendPushToUsersMock.mockClear();
});

async function makeUser(label: string, lang: string, displayName = "Alex Birdie"): Promise<TestUser> {
  const tag = uid(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName,
    role: "player",
    preferredLanguage: lang as "en",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName, role: "player" };
}

async function giveDeviceToken(userId: number) {
  const [row] = await db.insert(deviceTokensTable).values({
    userId,
    token: `ExponentPushToken[spec-${uid("tok")}]`,
    platform: "expo",
  }).returning({ id: deviceTokensTable.id });
  createdTokenIds.push(row.id);
}

afterAll(async () => {
  if (createdTokenIds.length) {
    await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.id, createdTokenIds));
  }
  if (createdUserIds.length) {
    await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("POST /api/portal/spectator-test-push", () => {
  it("requires authentication", async () => {
    await request(createTestApp())
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(401);
  });

  it("uses the `lang` override when supported, regardless of preferredLanguage", async () => {
    const me = await makeUser("override_supported", "fr", "Jin Hole");
    await giveDeviceToken(me.id);

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie", lang: "ja" })
      .expect(200);

    expect(res.body.language).toBe("ja");
    expect(res.body.preview.title).toBe("🐦 バーディー");
    expect(res.body.preview.body).toContain("7番ホール");
    // Task #1463 — a successful fan-out is reported as classification:"sent"
    // and delivered:true. Locks in the Task #1240 admin-debug behaviour so a
    // future change cannot silently revert to the old "always success"
    // reporting that hid genuine delivery problems.
    expect(res.body.classification).toBe("sent");
    expect(res.body.delivered).toBe(true);
    // Push fan-out used the override language as the data envelope `lang`.
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [, , , data] = sendPushToUsersMock.mock.calls[0]!;
    expect((data as { lang: string }).lang).toBe("ja");
  });

  it("falls back to preferredLanguage when `lang` is omitted", async () => {
    const me = await makeUser("no_override", "fr", "Jin Hole");
    await giveDeviceToken(me.id);

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(200);

    expect(res.body.language).toBe("fr");
    expect(res.body.preview.body).toContain("trou 7");
  });

  it("falls back to preferredLanguage when `lang` is unsupported", async () => {
    const me = await makeUser("bad_override", "fr", "Jin Hole");
    await giveDeviceToken(me.id);

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie", lang: "xx-not-real" })
      .expect(200);

    expect(res.body.language).toBe("fr");
    expect(res.body.preview.body).toContain("trou 7");
  });

  it("falls back to English when an English-preferring user passes an unsupported `lang`", async () => {
    const me = await makeUser("english_default", "en", "Jin Hole");
    await giveDeviceToken(me.id);

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie", lang: "xx-not-real" })
      .expect(200);

    expect(res.body.language).toBe("en");
    expect(res.body.preview.title).toBe("🐦 Birdie");
  });

  it("returns delivered:false + classification:'no_address' + reason:'no_device_token' when the user has no devices", async () => {
    const me = await makeUser("no_device", "ja");

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(200);

    // Task #1463 — the no-device early-return branch must surface the
    // same `classification` taxonomy as the post-fan-out branches so
    // admin tooling can rely on a single field for "did this actually
    // get delivered?". Pre-Task #1463 this branch was the only one
    // that omitted `classification`, which forced callers to special-
    // case it and risked future drift.
    expect(res.body).toMatchObject({
      delivered: false,
      classification: "no_address",
      reason: "no_device_token",
      language: "ja",
    });
    expect(res.body.preview.title).toBe("🐦 バーディー");
    // No push fan-out attempted when there's no token.
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  // Task #1463 — Task #1240 added a real `classification` to this admin
  // debug endpoint so a delivery problem (no usable Expo address, or Expo
  // ticket-level error) is no longer reported as "all good". These two
  // tests pin the failed / no_address branches; without them, a future
  // refactor of `classifyPushDelivery` or the route's response shape could
  // silently reintroduce the old misclassification (Task #1070 surface).
  it("reports classification:'failed' when the push provider rejects every ticket", async () => {
    const me = await makeUser("push_failed", "en");
    await giveDeviceToken(me.id);
    sendPushToUsersMock.mockResolvedValueOnce({
      attempted: 1, sent: 0, failed: 1, invalid: 0,
    });

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(200);

    expect(res.body.classification).toBe("failed");
    expect(res.body.delivered).toBe(false);
    expect(res.body.failed).toBe(1);
    expect(res.body.sent).toBe(0);
  });

  it("reports classification:'no_address' when the user has only invalid (non-Expo) tokens", async () => {
    const me = await makeUser("push_noaddr", "en");
    await giveDeviceToken(me.id);
    // Mirrors what `sendPushToUsers` returns when every registered token
    // is non-Expo / unusable: nothing was attempted on the wire so the
    // classifier maps this to "no_address" rather than "failed".
    sendPushToUsersMock.mockResolvedValueOnce({
      attempted: 1, sent: 0, failed: 0, invalid: 1,
    });

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(200);

    expect(res.body.classification).toBe("no_address");
    expect(res.body.delivered).toBe(false);
    expect(res.body.invalid).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.sent).toBe(0);
  });

  it("rate-limits the second rapid call with a 429 + retryAfterSeconds", async () => {
    const me = await makeUser("rate_limited", "en");
    await giveDeviceToken(me.id);

    await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(200);

    const res = await request(createTestApp(me))
      .post("/api/portal/spectator-test-push")
      .send({ eventType: "birdie" })
      .expect(429);

    expect(typeof res.body.retryAfterSeconds).toBe("number");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
