/**
 * Task #2006 — Confirm web and mobile per-CATEGORY communication choices
 * stay in sync end-to-end.
 *
 * The per-category channel grid (Email/SMS/Push/WhatsApp/In-app for
 * Billing, Tournaments, etc.) is wired into BOTH the web portal and the
 * mobile app, hitting the same `/api/portal/my-comm-prefs` endpoint. A
 * change made on one client must be visible on the other after a reload.
 * Today both clients have component tests that stub `fetch` and only
 * assert the request shape they themselves send — so a regression in the
 * endpoint or the response shape could quietly break sync without either
 * component test failing. Task #1617 closed this same gap for the
 * per-NOTIFICATION (real-time vs digest) screen; this test mirrors that
 * coverage for the per-category channel grid.
 *
 * This test removes the fetch stub on each side and exercises the REAL
 * API server + the REAL test database. It plays back the exact request
 * shapes each client sends today (web: PortalCommPrefs.tsx ~lines
 * 328-362; mobile: communications.tsx ~lines 201-225) and asserts that
 * the response shape each client consumes (CommPrefRow on web, CommPref
 * on mobile — both identical to memberCommPrefsTable) still carries the
 * change across the boundary.
 *
 * Each leg of the round-trip is wrapped in its own `it(...)` (or its own
 * description-prefixed assertion) so that when sync breaks, the failing
 * test name pinpoints which step regressed:
 *
 *   • "web→DB"   — web client PUT did not persist to member_comm_prefs
 *   • "DB→mobile" — mobile client GET did not surface the persisted change
 *   • "mobile→DB" — mobile client PUT did not persist
 *   • "DB→web"   — web client GET did not surface the persisted change
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
  clubMembersTable,
  memberCommPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers.js";

// Two distinct categories from the shared CATEGORIES list (web:
// PortalCommPrefs.tsx ~line 99; mobile: communications.tsx ~line 31)
// and from the API's allow-list (portal.ts ~line 10365). Picking two
// proves the row is keyed by `category` (not just "any saved row"),
// which is part of what could regress.
const CATEGORY_FROM_WEB = "billing";
const CATEGORY_FROM_MOBILE = "tournaments";

// Mirrors `CommPrefRow` (web: PortalCommPrefs.tsx ~lines 79-87) and
// `CommPref` (mobile: communications.tsx ~lines 9-13) — both clients
// read the same row shape from `/portal/my-comm-prefs`.
interface CommPrefRow {
  id: number;
  category: string;
  emailEnabled: boolean | null;
  smsEnabled: boolean | null;
  pushEnabled: boolean | null;
  whatsappEnabled: boolean | null;
  inAppEnabled: boolean | null;
}

/**
 * Mirrors the web client (`PortalCommPrefs.tsx` `saveCommPref`
 * ~lines 328-362): PUT /api/portal/my-comm-prefs with a JSON body of
 * `{ category, emailEnabled, smsEnabled, pushEnabled, whatsappEnabled,
 * inAppEnabled }` and `Content-Type: application/json`. The web client
 * always sends the entire 5-channel row (current values + the toggled
 * channel) so the server's upsert never has to merge fields.
 */
async function webClientPutCommPref(
  app: Express,
  body: {
    category: string;
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    whatsappEnabled: boolean;
    inAppEnabled: boolean;
  },
) {
  return request(app)
    .put("/api/portal/my-comm-prefs")
    .set("Content-Type", "application/json")
    .send(body);
}

/**
 * Mirrors the web client load (`PortalCommPrefs.tsx` ~line 156):
 * GET /api/portal/my-comm-prefs and parse as CommPrefRow[].
 */
async function webClientGetCommPrefs(app: Express): Promise<CommPrefRow[]> {
  const res = await request(app).get("/api/portal/my-comm-prefs");
  expect(res.status, "web GET /portal/my-comm-prefs status").toBe(200);
  expect(Array.isArray(res.body), "web GET /portal/my-comm-prefs body is array").toBe(true);
  return res.body as CommPrefRow[];
}

/**
 * Mirrors the mobile client (`communications.tsx` `toggle`
 * ~lines 201-225, via `authedFetch` in `_shared.ts` ~lines 14-32):
 * PUT /api/portal/my-comm-prefs with a JSON body of the same 5-channel
 * row, `Content-Type: application/json`, and
 * `Authorization: Bearer <token>`. The mobile client appends the
 * `actingMemberId` query string only when the family-context selector
 * has a value; for the self-edit path tested here it is omitted, exactly
 * matching `actingQs({ actingMemberId: null })` which returns "".
 */
async function mobileClientPutCommPref(
  app: Express,
  token: string,
  body: {
    category: string;
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    whatsappEnabled: boolean;
    inAppEnabled: boolean;
  },
) {
  return request(app)
    .put("/api/portal/my-comm-prefs")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

/**
 * Mirrors the mobile client load (`communications.tsx` ~line 98, via
 * `authedFetch`): GET /api/portal/my-comm-prefs with
 * `Authorization: Bearer <token>` and parse as CommPref[].
 */
async function mobileClientGetCommPrefs(
  app: Express,
  token: string,
): Promise<CommPrefRow[]> {
  const res = await request(app)
    .get("/api/portal/my-comm-prefs")
    .set("Authorization", `Bearer ${token}`);
  expect(res.status, "mobile GET /portal/my-comm-prefs status").toBe(200);
  expect(Array.isArray(res.body), "mobile GET /portal/my-comm-prefs body is array").toBe(true);
  return res.body as CommPrefRow[];
}

let orgId: number;
let userId: number;
let memberId: number;
let testUser: TestUser;
let app: Express;

beforeAll(async () => {
  const tag = uid("t2006");
  const [org] = await db.insert(organizationsTable).values({
    name: `T2006 ${tag}`, slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    email: `${tag}@example.test`,
    displayName: "Round-Trip Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
  testUser = { id: userId, username: `${tag}_user`, role: "player", organizationId: orgId };

  // The portal /my-comm-prefs handlers go through `resolveMemberContext`
  // which requires a club_members row linked to the app_users row, so
  // seed one. Without this, every request would 404 with "No club
  // membership found" and the round-trip would never reach the table.
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Round",
    lastName: "Trip",
    email: `${tag}-m@example.test`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  // The test app injects the same user into every request, mimicking
  // both an authenticated session cookie (web) and a Bearer token whose
  // resolved user matches (mobile). This is fine because the goal is
  // to exercise the round-trip through the route handler + DB, not to
  // re-test auth itself.
  app = createTestApp(testUser);
});

afterAll(async () => {
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, memberId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Clean per-category prefs between tests so each round-trip starts
  // from a known empty baseline (= API returns []).
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, memberId));
});

describe("Task #2006 — per-category comm prefs round-trip web ↔ mobile through real API + DB", () => {
  it("web→DB→mobile: a WhatsApp opt-in saved from the web is visible on the mobile screen", async () => {
    // 1) WEB: save the row exactly the way PortalCommPrefs.saveCommPref does —
    //    user toggled WhatsApp ON for the billing category. With no
    //    existing row, the web client's `commPrefFor` fallback defaults
    //    (PortalCommPrefs.tsx ~lines 314-326) paint email=true, sms=false,
    //    push=true, whatsapp=false, inApp=true, and `saveCommPref` sends
    //    those current values plus the toggled WhatsApp=true.
    const webPut = await webClientPutCommPref(app, {
      category: CATEGORY_FROM_WEB,
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: true,
      whatsappEnabled: true,
      inAppEnabled: true,
    });
    expect(webPut.status, "web→DB: PUT from web client should succeed").toBe(200);
    expect(webPut.body, "web→DB: response shape PortalCommPrefs depends on")
      .toMatchObject({
        category: CATEGORY_FROM_WEB,
        emailEnabled: true,
        smsEnabled: false,
        pushEnabled: true,
        whatsappEnabled: true,
        inAppEnabled: true,
      });

    // 2) DB: confirm the change actually landed in member_comm_prefs.
    const rows = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, memberId),
      eq(memberCommPrefsTable.category, CATEGORY_FROM_WEB),
    ));
    expect(rows, "web→DB: member_comm_prefs row").toHaveLength(1);
    expect(rows[0].whatsappEnabled, "web→DB: persisted whatsappEnabled").toBe(true);

    // 3) DB→MOBILE: load via the mobile client's GET path and assert
    // the change surfaces in the response shape `communications.tsx`
    // reads. The mobile screen renders the toggle from this exact field.
    const mobileRows = await mobileClientGetCommPrefs(app, "mobile-token");
    const onMobile = mobileRows.find(r => r.category === CATEGORY_FROM_WEB);
    expect(onMobile, `DB→mobile: ${CATEGORY_FROM_WEB} should appear in mobile's GET response`).toBeDefined();
    expect(onMobile!.whatsappEnabled, "DB→mobile: WhatsApp the mobile screen will paint as ON").toBe(true);
    expect(onMobile!.emailEnabled, "DB→mobile: Email the mobile screen will paint (carried from web defaults)").toBe(true);
    expect(onMobile!.smsEnabled, "DB→mobile: SMS the mobile screen will paint (carried from web defaults)").toBe(false);
  });

  it("mobile→DB→web: an SMS opt-in saved from the mobile is visible on the web portal", async () => {
    // 1) MOBILE: save the row exactly the way communications.toggle does —
    //    user toggled SMS ON for the tournaments category, current row
    //    values are all defaults (no row exists yet, so mobile's prefFor
    //    fallback paints email/push/inApp as true). We use the SAME body
    //    shape the mobile client sends so a regression in either side's
    //    expected payload would fail.
    const mobilePut = await mobileClientPutCommPref(app, "mobile-token", {
      category: CATEGORY_FROM_MOBILE,
      emailEnabled: true,
      smsEnabled: true,
      pushEnabled: true,
      whatsappEnabled: false,
      inAppEnabled: true,
    });
    expect(mobilePut.status, "mobile→DB: PUT from mobile client should succeed").toBe(200);
    expect(mobilePut.body, "mobile→DB: response shape communications.tsx depends on")
      .toMatchObject({
        category: CATEGORY_FROM_MOBILE,
        emailEnabled: true,
        smsEnabled: true,
        pushEnabled: true,
        whatsappEnabled: false,
        inAppEnabled: true,
      });

    // 2) DB: confirm persistence.
    const rows = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, memberId),
      eq(memberCommPrefsTable.category, CATEGORY_FROM_MOBILE),
    ));
    expect(rows, "mobile→DB: member_comm_prefs row").toHaveLength(1);
    expect(rows[0].smsEnabled, "mobile→DB: persisted smsEnabled").toBe(true);

    // 3) DB→WEB: load via the web client's GET path and assert the change
    // surfaces in the response shape PortalCommPrefs reads. The web
    // toggle's on/off state is driven by `Boolean(p[ch.field])` over
    // these exact fields.
    const webRows = await webClientGetCommPrefs(app);
    const onWeb = webRows.find(r => r.category === CATEGORY_FROM_MOBILE);
    expect(onWeb, `DB→web: ${CATEGORY_FROM_MOBILE} should appear in web's GET response`).toBeDefined();
    expect(onWeb!.smsEnabled, "DB→web: SMS the web toggle will paint as ON").toBe(true);
    expect(onWeb!.pushEnabled, "DB→web: Push the web toggle will paint").toBe(true);
  });

  it("web saves, mobile changes, web reloads: the mobile change overwrites and is visible to the web", async () => {
    // Full bi-directional round-trip in one flow, on the same category:
    // web turns Push OFF → mobile turns Push back ON → web reloads and
    // sees Push ON. This is the realistic "member edits on phone, then
    // opens laptop" path.
    const webPut = await webClientPutCommPref(app, {
      category: CATEGORY_FROM_WEB,
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: false,
      whatsappEnabled: false,
      inAppEnabled: true,
    });
    expect(webPut.status, "step 1 (web→DB): web PUT should succeed").toBe(200);
    expect(webPut.body.pushEnabled, "step 1 (web→DB): web sees its own write").toBe(false);

    // Mobile picks up the persisted row via load() (we simulate that by
    // sending the same body shape mobile would compute after toggling
    // pushEnabled back to true on top of the just-loaded row).
    const mobilePut = await mobileClientPutCommPref(app, "mobile-token", {
      category: CATEGORY_FROM_WEB,
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: true,
      whatsappEnabled: false,
      inAppEnabled: true,
    });
    expect(mobilePut.status, "step 2 (mobile→DB): mobile PUT should succeed").toBe(200);
    expect(mobilePut.body.pushEnabled, "step 2 (mobile→DB): mobile sees its own write").toBe(true);

    // Only one row should remain — the upsert must replace, not append.
    const rows = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, memberId),
      eq(memberCommPrefsTable.category, CATEGORY_FROM_WEB),
    ));
    expect(rows, "step 2 (mobile→DB): upsert should leave exactly one row").toHaveLength(1);
    expect(rows[0].pushEnabled, "step 2 (mobile→DB): latest write wins").toBe(true);

    const webRows = await webClientGetCommPrefs(app);
    const onWeb = webRows.find(r => r.category === CATEGORY_FROM_WEB);
    expect(onWeb, `step 3 (DB→web): ${CATEGORY_FROM_WEB} appears on web reload`).toBeDefined();
    expect(onWeb!.pushEnabled, "step 3 (DB→web): web reload reflects the mobile change").toBe(true);
    expect(onWeb!.emailEnabled, "step 3 (DB→web): non-toggled channels survive the round-trip").toBe(true);
  });

  it("changes are scoped to the right category — toggling one does not leak into another", async () => {
    // Web opts out of Email for billing; mobile opts out of Email for
    // tournaments. After both writes, each client should see ONLY its
    // own category change (no cross-talk between rows). This is what
    // protects against a regression where the upsert WHERE clause drops
    // the category filter.
    const webPut = await webClientPutCommPref(app, {
      category: CATEGORY_FROM_WEB,
      emailEnabled: false,
      smsEnabled: false,
      pushEnabled: true,
      whatsappEnabled: false,
      inAppEnabled: true,
    });
    expect(webPut.status, "setup (web→DB): seed billing row").toBe(200);

    const mobilePut = await mobileClientPutCommPref(app, "mobile-token", {
      category: CATEGORY_FROM_MOBILE,
      emailEnabled: false,
      smsEnabled: false,
      pushEnabled: true,
      whatsappEnabled: false,
      inAppEnabled: true,
    });
    expect(mobilePut.status, "setup (mobile→DB): seed tournaments row").toBe(200);

    // Two distinct rows, each carrying its own category — proves the
    // upsert is keyed by (clubMemberId, category) and not just clubMemberId.
    const all = await db.select().from(memberCommPrefsTable)
      .where(eq(memberCommPrefsTable.clubMemberId, memberId));
    expect(all, "DB: one row per category, no cross-contamination").toHaveLength(2);

    // From the WEB client's reload, both categories show up with the
    // expected emailEnabled=false and the rows are addressable by category.
    const webRows = await webClientGetCommPrefs(app);
    const billingOnWeb = webRows.find(r => r.category === CATEGORY_FROM_WEB);
    const tournamentsOnWeb = webRows.find(r => r.category === CATEGORY_FROM_MOBILE);
    expect(billingOnWeb, "DB→web: billing row visible").toBeDefined();
    expect(tournamentsOnWeb, "DB→web: tournaments row visible").toBeDefined();
    expect(billingOnWeb!.emailEnabled, "DB→web: billing email reflects web change").toBe(false);
    expect(tournamentsOnWeb!.emailEnabled, "DB→web: tournaments email reflects mobile change").toBe(false);

    // From the MOBILE client's reload, the same two rows are addressable
    // and each carries the correct category-scoped change.
    const mobileRows = await mobileClientGetCommPrefs(app, "mobile-token");
    const billingOnMobile = mobileRows.find(r => r.category === CATEGORY_FROM_WEB);
    const tournamentsOnMobile = mobileRows.find(r => r.category === CATEGORY_FROM_MOBILE);
    expect(billingOnMobile, "DB→mobile: billing row visible").toBeDefined();
    expect(tournamentsOnMobile, "DB→mobile: tournaments row visible").toBeDefined();
    expect(billingOnMobile!.emailEnabled, "DB→mobile: billing email reflects web change").toBe(false);
    expect(tournamentsOnMobile!.emailEnabled, "DB→mobile: tournaments email reflects mobile change").toBe(false);
  });
});
