/**
 * Task #1617 — Confirm web and mobile per-notification choices stay in
 * sync end-to-end.
 *
 * Task #1352 wired the mobile notification settings screen to the same
 * `/api/portal/notification-key-prefs` endpoint the web portal uses, so a
 * member who picks "Daily summary" for a key on their phone should see
 * "Daily summary" on the web (and vice versa). The existing component
 * tests on each side stub `fetch` and only assert the request shape they
 * themselves send — neither side has visibility into whether the OTHER
 * client can read what was written. A regression in the endpoint, the
 * schema, or the response shape could quietly break sync without either
 * component test failing.
 *
 * This test removes the fetch stub and exercises the REAL API server +
 * the REAL test database. It plays back the exact request shapes each
 * client sends today (web: PortalCommPrefs.tsx ~lines 145-170; mobile:
 * communications.tsx ~lines 151-173) and asserts that the response shape
 * each client consumes (NotificationKeyPrefsResponse from the same files)
 * still carries the override across the boundary.
 *
 * Each leg of the round-trip is wrapped in its own `it(...)` (or its own
 * description-prefixed assertion) so that when sync breaks, the failing
 * test name pinpoints which step regressed:
 *
 *   • "web→DB"   — web client PATCH did not persist to user_notification_key_prefs
 *   • "DB→mobile" — mobile client GET did not surface the persisted override
 *   • "mobile→DB" — mobile client PATCH did not persist
 *   • "DB→web"   — web client GET did not surface the persisted override
 *
 * If either client ever changes the body shape it sends or the response
 * shape it reads, the helpers below — which are documented to mirror the
 * source files exactly — must be updated. That update step is itself the
 * regression check.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  userNotificationPrefsTable,
  userNotificationKeyPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { createTestApp, uid, type TestUser } from "./helpers.js";

// Two digestable keys seeded in notificationRegistry.ts. Picking two
// distinct keys lets us prove the override is keyed by notificationKey
// (not just "any saved row"), which is part of what could regress.
const KEY_FROM_WEB = "highlight.ready";
const KEY_FROM_MOBILE = "social.follow.new";

interface KeyPrefRow {
  key: string;
  category: string;
  description: string;
  override: "realtime" | "digest" | null;
  effectiveMode: "realtime" | "digest";
}
interface KeyPrefsResponse {
  digestMode: boolean;
  keys: KeyPrefRow[];
}

/**
 * Mirrors the web client (`artifacts/kharagolf-web/src/pages/portal/PortalCommPrefs.tsx`,
 * `saveKeyPref` ~lines 160-165): PATCH /api/portal/notification-key-prefs
 * with a JSON body of `{ key, deliveryMode }` and `Content-Type: application/json`.
 */
async function webClientPatchKeyPref(
  app: Express,
  key: string,
  deliveryMode: "realtime" | "digest" | null,
) {
  return request(app)
    .patch("/api/portal/notification-key-prefs")
    .set("Content-Type", "application/json")
    .send({ key, deliveryMode });
}

/**
 * Mirrors the web client load (`PortalCommPrefs.tsx` ~line 114):
 * GET /api/portal/notification-key-prefs and parse as
 * NotificationKeyPrefsResponse.
 */
async function webClientGetKeyPrefs(app: Express): Promise<KeyPrefsResponse> {
  const res = await request(app).get("/api/portal/notification-key-prefs");
  expect(res.status, "web GET /portal/notification-key-prefs status").toBe(200);
  return res.body as KeyPrefsResponse;
}

/**
 * Mirrors the mobile client (`artifacts/kharagolf-mobile/app/my-360/communications.tsx`,
 * `saveKeyPref` ~lines 163-166, via `authedFetch` in `_shared.ts` ~lines 14-32):
 * PATCH /api/portal/notification-key-prefs with a JSON body of
 * `{ key, deliveryMode }`, `Content-Type: application/json`, and
 * `Authorization: Bearer <token>`.
 */
async function mobileClientPatchKeyPref(
  app: Express,
  token: string,
  key: string,
  deliveryMode: "realtime" | "digest" | null,
) {
  return request(app)
    .patch("/api/portal/notification-key-prefs")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send({ key, deliveryMode });
}

/**
 * Mirrors the mobile client load (`communications.tsx` ~line 82, via
 * `authedFetch`): GET /api/portal/notification-key-prefs with
 * `Authorization: Bearer <token>` and parse as NotificationKeyPrefsResponse.
 */
async function mobileClientGetKeyPrefs(
  app: Express,
  token: string,
): Promise<KeyPrefsResponse> {
  const res = await request(app)
    .get("/api/portal/notification-key-prefs")
    .set("Authorization", `Bearer ${token}`);
  expect(res.status, "mobile GET /portal/notification-key-prefs status").toBe(200);
  return res.body as KeyPrefsResponse;
}

let orgId: number;
let userId: number;
let testUser: TestUser;
let app: Express;

beforeAll(async () => {
  const tag = uid("t1617");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1617 ${tag}`, slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    email: `${tag}@example.test`,
    displayName: "Round-Trip User",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
  testUser = { id: userId, username: `${tag}_user`, role: "player" };

  await hydrateRegistry();

  // The test app injects the same user into every request, mimicking
  // both an authenticated session cookie (web) and a Bearer token whose
  // resolved user matches (mobile). This is fine because the goal is
  // to exercise the round-trip through the route handler + DB, not to
  // re-test auth itself.
  app = createTestApp(testUser);
});

afterAll(async () => {
  await db.delete(userNotificationKeyPrefsTable).where(eq(userNotificationKeyPrefsTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Clean per-key overrides + global notification prefs between tests so
  // each round-trip starts from a known empty baseline.
  await db.delete(userNotificationKeyPrefsTable).where(eq(userNotificationKeyPrefsTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

describe("Task #1617 — per-notification choices round-trip web ↔ mobile through real API + DB", () => {
  it("web→DB→mobile: a 'digest' override saved from the web is visible on the mobile screen", async () => {
    // 1) WEB: save the override exactly the way PortalCommPrefs.saveKeyPref does.
    const webPatch = await webClientPatchKeyPref(app, KEY_FROM_WEB, "digest");
    expect(webPatch.status, "web→DB: PATCH from web client should succeed").toBe(200);
    expect(webPatch.body, "web→DB: response shape PortalCommPrefs depends on")
      .toEqual({ key: KEY_FROM_WEB, override: "digest" });

    // 2) DB: confirm the override actually landed in user_notification_key_prefs.
    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, KEY_FROM_WEB),
      ));
    expect(rows, "web→DB: user_notification_key_prefs row").toHaveLength(1);
    expect(rows[0].deliveryMode, "web→DB: persisted deliveryMode").toBe("digest");

    // 3) DB→MOBILE: load via the mobile client's GET path and assert the
    // override surfaces in the response shape `communications.tsx` reads.
    const mobileResp = await mobileClientGetKeyPrefs(app, "mobile-token");
    const onMobile = mobileResp.keys.find(k => k.key === KEY_FROM_WEB);
    expect(onMobile, `DB→mobile: ${KEY_FROM_WEB} should appear in mobile's GET response`).toBeDefined();
    expect(onMobile!.override, "DB→mobile: override the mobile screen will paint as 'Daily summary'").toBe("digest");
    expect(onMobile!.effectiveMode, "DB→mobile: effective mode the mobile segment uses").toBe("digest");
  });

  it("mobile→DB→web: a 'realtime' override saved from the mobile is visible on the web portal", async () => {
    // Seed the global digestMode to true so a value of "realtime" is a
    // genuine override (not just matching the global default). This proves
    // the override field — not just the effective mode — round-trips.
    await db.insert(userNotificationPrefsTable).values({ userId, digestMode: true });

    // 1) MOBILE: save the override exactly the way communications.saveKeyPref does.
    const mobilePatch = await mobileClientPatchKeyPref(app, "mobile-token", KEY_FROM_MOBILE, "realtime");
    expect(mobilePatch.status, "mobile→DB: PATCH from mobile client should succeed").toBe(200);
    expect(mobilePatch.body, "mobile→DB: response shape communications.tsx depends on")
      .toEqual({ key: KEY_FROM_MOBILE, override: "realtime" });

    // 2) DB: confirm persistence.
    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, KEY_FROM_MOBILE),
      ));
    expect(rows, "mobile→DB: user_notification_key_prefs row").toHaveLength(1);
    expect(rows[0].deliveryMode, "mobile→DB: persisted deliveryMode").toBe("realtime");

    // 3) DB→WEB: load via the web client's GET path and assert the
    // override surfaces in the response shape PortalCommPrefs reads.
    const webResp = await webClientGetKeyPrefs(app);
    expect(webResp.digestMode, "DB→web: global digestMode echo").toBe(true);
    const onWeb = webResp.keys.find(k => k.key === KEY_FROM_MOBILE);
    expect(onWeb, `DB→web: ${KEY_FROM_MOBILE} should appear in web's GET response`).toBeDefined();
    expect(onWeb!.override, "DB→web: override the web toggle will paint as 'Real-time'").toBe("realtime");
    expect(onWeb!.effectiveMode, "DB→web: effective mode the web toggle uses").toBe("realtime");
  });

  it("web saves, mobile changes, web reloads: the mobile change overwrites and is visible to the web", async () => {
    // Full bi-directional round-trip in one flow: web sets digest →
    // mobile flips to realtime → web reloads and sees realtime. This is
    // the realistic "member edits on phone, then opens laptop" path.
    const webPatch = await webClientPatchKeyPref(app, KEY_FROM_WEB, "digest");
    expect(webPatch.status, "step 1 (web→DB): web PATCH should succeed").toBe(200);

    const mobilePatch = await mobileClientPatchKeyPref(app, "mobile-token", KEY_FROM_WEB, "realtime");
    expect(mobilePatch.status, "step 2 (mobile→DB): mobile PATCH should succeed").toBe(200);
    expect(mobilePatch.body.override, "step 2 (mobile→DB): mobile sees its own write").toBe("realtime");

    // Only one row should remain — the upsert must replace, not append.
    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, KEY_FROM_WEB),
      ));
    expect(rows, "step 2 (mobile→DB): upsert should leave exactly one row").toHaveLength(1);
    expect(rows[0].deliveryMode, "step 2 (mobile→DB): latest write wins").toBe("realtime");

    const webResp = await webClientGetKeyPrefs(app);
    const onWeb = webResp.keys.find(k => k.key === KEY_FROM_WEB);
    expect(onWeb, `step 3 (DB→web): ${KEY_FROM_WEB} appears on web reload`).toBeDefined();
    expect(onWeb!.override, "step 3 (DB→web): web reload reflects the mobile change").toBe("realtime");
    expect(onWeb!.effectiveMode, "step 3 (DB→web): effective mode reflects the mobile change").toBe("realtime");
  });

  it("clearing an override on one client (deliveryMode=null) is reflected on the other", async () => {
    // Web sets a digest override, mobile clears it (the per-key reset
    // path the UI exposes via "Real-time" buttons today only sends
    // explicit modes, but the API also accepts null to fully clear —
    // both clients depend on this for the upcoming "clear single
    // override" feature, so we round-trip it now).
    const webPatch = await webClientPatchKeyPref(app, KEY_FROM_WEB, "digest");
    expect(webPatch.status, "setup (web→DB): seed override").toBe(200);

    const mobileClear = await mobileClientPatchKeyPref(app, "mobile-token", KEY_FROM_WEB, null);
    expect(mobileClear.status, "mobile→DB: PATCH null should succeed").toBe(200);
    expect(mobileClear.body, "mobile→DB: response shape for clear").toEqual({ key: KEY_FROM_WEB, override: null });

    const rows = await db.select().from(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, KEY_FROM_WEB),
      ));
    expect(rows, "mobile→DB: row should be deleted by null clear").toHaveLength(0);

    const webResp = await webClientGetKeyPrefs(app);
    const onWeb = webResp.keys.find(k => k.key === KEY_FROM_WEB);
    expect(onWeb, `DB→web: ${KEY_FROM_WEB} still appears in registry after clear`).toBeDefined();
    expect(onWeb!.override, "DB→web: web sees null override after the mobile clear").toBeNull();
    // With no override and global digestMode unset (default false), the
    // effective mode should fall back to "realtime".
    expect(onWeb!.effectiveMode, "DB→web: effective mode falls back to global digestMode").toBe("realtime");
  });
});
