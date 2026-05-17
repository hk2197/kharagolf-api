/**
 * Integration tests: consent enforcement matrix (Task #469).
 *
 * Verifies that withdrawing a member's consent for `gps`, `photo`, `video`,
 * or `ai` blocks the corresponding feature endpoints with HTTP 403 +
 * `code: "CONSENT_REQUIRED"`, and that a granted decision passes the
 * consent gate (the request continues into route logic, which may then
 * succeed or fail for other reasons — but never with CONSENT_REQUIRED).
 *
 * Endpoints under test (per Task #469's enforcement matrix):
 *   GPS    : POST /api/portal/watch/submit-shot
 *            POST /api/portal/shots/manual
 *            POST /api/portal/shots/detect
 *   PHOTO  : POST /api/organizations/:orgId/media/upload-url
 *            POST /api/organizations/:orgId/media (resolved as photo)
 *   VIDEO  : POST /api/swing-videos/upload-url
 *            POST /api/swing-videos
 *            POST /api/portal/highlights (gates on video AND ai)
 *   AI     : GET  /api/portal/caddie/recommend
 *            GET  /api/portal/caddie/feedback/summary
 *
 * Consent helpers live in `artifacts/api-server/src/lib/consent.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";

// Make sure the HMAC secret used by media upload-token signing is stable
// before any route module reads it. Done at import time, not in beforeAll,
// because routes lazily call getHmacSecret() per request and we need a
// known value for the manual signing below.
process.env.PRIVATE_OBJECT_DIR ||= "consent-test-bucket/private";

// The highlights POST endpoint hands work off to the render queue. We do
// not exercise the renderer here (the consent gate fires before queueing),
// but stub the queue so the test never spawns a worker.
vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return { ...actual, enqueueRender: vi.fn(async (_id: number) => {}) };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberConsentsTable,
  tournamentsTable,
  playersTable,
  highlightReelsTable,
  highlightRenderEventsTable,
  mediaTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let tournamentId: number;
let deniedUserId: number;
let grantedUserId: number;
let deniedMemberId: number;
let grantedMemberId: number;
let deniedPlayerId: number;
let grantedPlayerId: number;

let deniedUser: TestUser;
let grantedUser: TestUser;
let deniedApp: ReturnType<typeof createTestApp>;
let grantedApp: ReturnType<typeof createTestApp>;
let unauthApp: ReturnType<typeof createTestApp>;

const CATEGORIES = ["gps", "photo", "video", "ai"] as const;

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `ConsentEnforceOrg_${ts}`,
    slug: `consent-enforce-${ts}`,
    // Enterprise tier so the highlights quota does not trigger before the
    // consent gate on the granted-user path.
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [denied] = await db.insert(appUsersTable).values({
    replitUserId: `consent-denied-${ts}`,
    username: `consent_denied_${ts}`,
    email: `denied_${ts}@test.local`,
    displayName: "Denied User",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  deniedUserId = denied.id;

  const [granted] = await db.insert(appUsersTable).values({
    replitUserId: `consent-granted-${ts}`,
    username: `consent_granted_${ts}`,
    email: `granted_${ts}@test.local`,
    displayName: "Granted User",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  grantedUserId = granted.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: deniedUserId, role: "player" },
    { organizationId: orgId, userId: grantedUserId, role: "player" },
  ]);

  const [dm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: deniedUserId,
    firstName: "Denied",
    lastName: "User",
    email: `denied_${ts}@test.local`,
  }).returning({ id: clubMembersTable.id });
  deniedMemberId = dm.id;

  const [gm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: grantedUserId,
    firstName: "Granted",
    lastName: "User",
    email: `granted_${ts}@test.local`,
  }).returning({ id: clubMembersTable.id });
  grantedMemberId = gm.id;

  // Insert latest consent decisions: denied=false, granted=true for each
  // category in the enforcement matrix.
  await db.insert(memberConsentsTable).values([
    ...CATEGORIES.map(c => ({
      clubMemberId: deniedMemberId, organizationId: orgId,
      consentType: c, granted: false,
    })),
    ...CATEGORIES.map(c => ({
      clubMemberId: grantedMemberId, organizationId: orgId,
      consentType: c, granted: true,
    })),
  ]);

  // A tournament + player rows for both users so canAccessMedia() and the
  // shots routes have an authorised context to evaluate (the consent gate
  // must be the failure mode, not "Forbidden / Not enrolled").
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `Consent Tourney ${ts}`,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [pd] = await db.insert(playersTable).values({
    tournamentId, userId: deniedUserId, firstName: "Denied", lastName: "User",
  }).returning({ id: playersTable.id });
  deniedPlayerId = pd.id;

  const [pg] = await db.insert(playersTable).values({
    tournamentId, userId: grantedUserId, firstName: "Granted", lastName: "User",
  }).returning({ id: playersTable.id });
  grantedPlayerId = pg.id;

  deniedUser = {
    id: deniedUserId, username: `consent_denied_${ts}`,
    role: "player", organizationId: orgId,
  };
  grantedUser = {
    id: grantedUserId, username: `consent_granted_${ts}`,
    role: "player", organizationId: orgId,
  };
  deniedApp = createTestApp(deniedUser);
  grantedApp = createTestApp(grantedUser);
  unauthApp = createTestApp(undefined);
});

afterAll(async () => {
  // Renders/reels created by the granted-user highlights tests
  if (grantedUserId) {
    const reels = await db.select({ id: highlightReelsTable.id })
      .from(highlightReelsTable).where(eq(highlightReelsTable.userId, grantedUserId));
    const reelIds = reels.map(r => r.id);
    if (reelIds.length > 0) {
      await db.delete(highlightRenderEventsTable).where(inArray(highlightRenderEventsTable.reelId, reelIds));
      await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    }
  }
  // Media rows created by the granted-user media POST tests
  if (orgId) {
    await db.delete(mediaTable).where(eq(mediaTable.organizationId, orgId));
  }
  if (deniedPlayerId) await db.delete(playersTable).where(eq(playersTable.id, deniedPlayerId));
  if (grantedPlayerId) await db.delete(playersTable).where(eq(playersTable.id, grantedPlayerId));
  if (tournamentId) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (deniedMemberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, deniedMemberId));
  if (grantedMemberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, grantedMemberId));
  for (const u of [deniedUserId, grantedUserId].filter(Boolean)) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, u));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

/** Assert the response is a CONSENT_REQUIRED block (HTTP 403, structured body).
 *  When `expectedCategory` is provided AND the body includes
 *  `consentRequired.category`, the category MUST match — this proves each
 *  endpoint checks the correct entry in the consent matrix, not just *any*
 *  withdrawn consent. */
function expectConsentBlocked(
  res: { status: number; body: unknown },
  expectedCategory?: typeof CATEGORIES[number] | Array<typeof CATEGORIES[number]>,
) {
  expect(res.status).toBe(403);
  const body = res.body as { code?: string; consentRequired?: { category?: string } };
  expect(body.code).toBe("CONSENT_REQUIRED");
  const cat = body.consentRequired?.category as typeof CATEGORIES[number] | undefined;
  if (cat) expect(CATEGORIES).toContain(cat);
  if (expectedCategory && cat) {
    if (Array.isArray(expectedCategory)) expect(expectedCategory).toContain(cat);
    else expect(cat).toBe(expectedCategory);
  }
}

/** Assert the response was NOT blocked by the consent gate. The route is
 *  still allowed to fail for other reasons (400 missing field, 500 storage,
 *  etc.) — we only care that the consent middleware did not short-circuit. */
function expectNotConsentBlocked(res: { status: number; body: unknown }) {
  const body = res.body as { code?: string };
  if (res.status === 403) {
    expect(body.code).not.toBe("CONSENT_REQUIRED");
  }
}

// ─── GPS ──────────────────────────────────────────────────────────────────────

describe("Consent gate — GPS endpoints", () => {
  const url = "/api/portal/watch/submit-shot";

  it("POST /portal/watch/submit-shot blocks when GPS consent is withdrawn", async () => {
    const res = await request(deniedApp).post(url).send({
      tournamentId, holeNumber: 1, shotNumber: 1,
      latitude: 17.4, longitude: 78.4,
    });
    expectConsentBlocked(res, "gps");
  });

  it("POST /portal/watch/submit-shot lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post(url).send({
      tournamentId, holeNumber: 1, shotNumber: 1,
      latitude: 17.4, longitude: 78.4,
    });
    expectNotConsentBlocked(res);
  });

  it("POST /portal/shots/manual blocks when GPS consent is withdrawn", async () => {
    const res = await request(deniedApp).post("/api/portal/shots/manual").send({
      tournamentId, holeNumber: 1, shotNumber: 1,
    });
    expectConsentBlocked(res, "gps");
  });

  it("POST /portal/shots/manual lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post("/api/portal/shots/manual").send({
      tournamentId, holeNumber: 1, shotNumber: 1,
    });
    expectNotConsentBlocked(res);
  });

  it("POST /portal/shots/detect blocks when GPS consent is withdrawn", async () => {
    const res = await request(deniedApp).post("/api/portal/shots/detect").send({
      tournamentId, gps: [], motion: [],
    });
    expectConsentBlocked(res, "gps");
  });

  it("POST /portal/shots/detect lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post("/api/portal/shots/detect").send({
      tournamentId, gps: [], motion: [],
    });
    expectNotConsentBlocked(res);
  });
});

// ─── PHOTO ────────────────────────────────────────────────────────────────────

describe("Consent gate — photo endpoints", () => {
  it("POST /organizations/:orgId/media/upload-url blocks when photo consent is withdrawn", async () => {
    const res = await request(deniedApp)
      .post(`/api/organizations/${orgId}/media/upload-url`)
      .send({ tournamentId, contentType: "image/jpeg" });
    expectConsentBlocked(res, "photo");
  });

  it("POST /organizations/:orgId/media/upload-url lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp)
      .post(`/api/organizations/${orgId}/media/upload-url`)
      .send({ tournamentId, contentType: "image/jpeg" });
    expectNotConsentBlocked(res);
  });

  it("POST /organizations/:orgId/media blocks when photo consent is withdrawn", async () => {
    // Re-derive the same HMAC the route's signUploadPath() uses so the token
    // check passes and the request reaches the consent gate.
    const objectPath = `/objects/uploads/consent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uploadToken = createHmac("sha256", process.env.PRIVATE_OBJECT_DIR!)
      .update(objectPath).digest("hex");
    const res = await request(deniedApp)
      .post(`/api/organizations/${orgId}/media`)
      .send({ tournamentId, objectPath, uploadToken });
    expectConsentBlocked(res, "photo");
  });

  it("POST /organizations/:orgId/media lets a granted user past the consent gate", async () => {
    const objectPath = `/objects/uploads/consent-test-granted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uploadToken = createHmac("sha256", process.env.PRIVATE_OBJECT_DIR!)
      .update(objectPath).digest("hex");
    const res = await request(grantedApp)
      .post(`/api/organizations/${orgId}/media`)
      .send({ tournamentId, objectPath, uploadToken });
    expectNotConsentBlocked(res);
  });
});

// ─── VIDEO ────────────────────────────────────────────────────────────────────

describe("Consent gate — video endpoints", () => {
  it("POST /swing-videos/upload-url blocks when video consent is withdrawn", async () => {
    const res = await request(deniedApp).post("/api/swing-videos/upload-url").send({});
    expectConsentBlocked(res, "video");
  });

  it("POST /swing-videos/upload-url lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post("/api/swing-videos/upload-url").send({});
    expectNotConsentBlocked(res);
  });

  it("POST /swing-videos blocks when video consent is withdrawn", async () => {
    const res = await request(deniedApp).post("/api/swing-videos").send({
      videoUrl: "/objects/uploads/fake",
      videoUploadToken: "x",
      videoUploadTokenExp: 0,
    });
    expectConsentBlocked(res, "video");
  });

  it("POST /swing-videos lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post("/api/swing-videos").send({
      videoUrl: "/objects/uploads/fake",
      videoUploadToken: "x",
      videoUploadTokenExp: 0,
    });
    expectNotConsentBlocked(res);
  });
});

// ─── HIGHLIGHTS (video + ai) ──────────────────────────────────────────────────

describe("Consent gate — POST /portal/highlights", () => {
  it("blocks when video or ai consent is withdrawn", async () => {
    // Denied user has BOTH video and ai withdrawn — the route checks video
    // first, so the response identifies the video category. Either way the
    // contract is the same: 403 + CONSENT_REQUIRED.
    const res = await request(deniedApp).post("/api/portal/highlights").send({
      templateId: "classic", title: "Test reel",
    });
    // Highlights gates on video AND ai; the route reports whichever fires
    // first. Either is acceptable evidence the route consults the matrix.
    expectConsentBlocked(res, ["video", "ai"]);
  });

  it("lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).post("/api/portal/highlights").send({
      templateId: "classic", title: "Test reel",
    });
    expectNotConsentBlocked(res);
  });
});

// ─── AI ───────────────────────────────────────────────────────────────────────

describe("Consent gate — AI caddie endpoints", () => {
  it("GET /portal/caddie/recommend blocks when AI consent is withdrawn", async () => {
    const res = await request(deniedApp).get("/api/portal/caddie/recommend?distanceYards=150");
    expectConsentBlocked(res, "ai");
  });

  it("GET /portal/caddie/recommend lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).get("/api/portal/caddie/recommend?distanceYards=150");
    expectNotConsentBlocked(res);
  });

  it("GET /portal/caddie/feedback/summary blocks when AI consent is withdrawn", async () => {
    const res = await request(deniedApp).get("/api/portal/caddie/feedback/summary");
    expectConsentBlocked(res, "ai");
  });

  it("GET /portal/caddie/feedback/summary lets a granted user past the consent gate", async () => {
    const res = await request(grantedApp).get("/api/portal/caddie/feedback/summary");
    expectNotConsentBlocked(res);
  });
});

// ─── PER-CATEGORY ISOLATION ───────────────────────────────────────────────────
//
// The tests above use a single user with ALL four consents withdrawn. That
// proves "deny works" but does not prove that each endpoint consults the
// CORRECT entry in the matrix. A bug where /api/swing-videos checked `gps`
// instead of `video` would still pass those tests.
//
// The block below builds four isolated members, each missing exactly one
// consent, and asserts that:
//   - the representative endpoint for the withdrawn category is blocked, AND
//   - a representative endpoint for a *different* category passes the gate.
//
// That pair of assertions per category proves the routing of category →
// endpoint works as documented.

describe("Consent gate — per-category isolation matrix", () => {
  // representative endpoint per category
  const probe: Record<typeof CATEGORIES[number], (app: ReturnType<typeof createTestApp>) => Promise<{ status: number; body: unknown }>> = {
    gps:   (app) => request(app).post("/api/portal/shots/manual").send({ tournamentId, holeNumber: 1, shotNumber: 1 }),
    photo: (app) => request(app).post(`/api/organizations/${orgId}/media/upload-url`).send({ tournamentId, contentType: "image/jpeg" }),
    video: (app) => request(app).post("/api/swing-videos/upload-url").send({}),
    ai:    (app) => request(app).get("/api/portal/caddie/recommend?distanceYards=150"),
  };

  // Per-category isolated user IDs, populated in the nested beforeAll.
  const isoUserIds: Record<string, number> = {};
  const isoMemberIds: Record<string, number> = {};
  const isoPlayerIds: Record<string, number> = {};
  const isoApps: Record<string, ReturnType<typeof createTestApp>> = {};

  beforeAll(async () => {
    for (const withdrawn of CATEGORIES) {
      const ts = `${Date.now()}_${withdrawn}_${Math.random().toString(36).slice(2, 6)}`;
      const [u] = await db.insert(appUsersTable).values({
        replitUserId: `consent-iso-${withdrawn}-${ts}`,
        username: `consent_iso_${withdrawn}_${ts}`,
        email: `iso_${withdrawn}_${ts}@test.local`,
        displayName: `Iso ${withdrawn}`,
        role: "player",
        organizationId: orgId,
      }).returning({ id: appUsersTable.id });
      isoUserIds[withdrawn] = u.id;

      await db.insert(orgMembershipsTable).values({
        organizationId: orgId, userId: u.id, role: "player",
      });

      const [m] = await db.insert(clubMembersTable).values({
        organizationId: orgId, userId: u.id,
        firstName: "Iso", lastName: withdrawn,
        email: `iso_${withdrawn}_${ts}@test.local`,
      }).returning({ id: clubMembersTable.id });
      isoMemberIds[withdrawn] = m.id;

      // 3 categories granted, 1 withdrawn — isolates the matrix entry under test.
      await db.insert(memberConsentsTable).values(CATEGORIES.map(c => ({
        clubMemberId: m.id, organizationId: orgId,
        consentType: c, granted: c !== withdrawn,
      })));

      const [p] = await db.insert(playersTable).values({
        tournamentId, userId: u.id, firstName: "Iso", lastName: withdrawn,
      }).returning({ id: playersTable.id });
      isoPlayerIds[withdrawn] = p.id;

      isoApps[withdrawn] = createTestApp({
        id: u.id, username: `consent_iso_${withdrawn}_${ts}`,
        role: "player", organizationId: orgId,
      });
    }
  });

  afterAll(async () => {
    for (const withdrawn of CATEGORIES) {
      const pid = isoPlayerIds[withdrawn];
      const mid = isoMemberIds[withdrawn];
      const uid = isoUserIds[withdrawn];
      if (pid) await db.delete(playersTable).where(eq(playersTable.id, pid));
      if (mid) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, mid));
      if (uid) {
        await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, uid));
        await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
      }
    }
  });

  for (const withdrawn of CATEGORIES) {
    it(`withdrawing only ${withdrawn} blocks the ${withdrawn} endpoint`, async () => {
      const res = await probe[withdrawn](isoApps[withdrawn]);
      expectConsentBlocked(res, withdrawn);
    });

    // Pick a different category to prove the user isn't blocked everywhere
    const other = CATEGORIES.find(c => c !== withdrawn)!;
    it(`withdrawing only ${withdrawn} does NOT block the ${other} endpoint`, async () => {
      const res = await probe[other](isoApps[withdrawn]);
      expectNotConsentBlocked(res);
    });
  }
});

// ─── AUTH SANITY ──────────────────────────────────────────────────────────────

describe("Consent gate — unauthenticated requests still reach the auth check", () => {
  it("returns 401 (not 403/CONSENT_REQUIRED) when the caller is not signed in", async () => {
    const endpoints: Array<[string, "get" | "post"]> = [
      ["/api/portal/shots/manual", "post"],
      ["/api/portal/shots/detect", "post"],
      ["/api/swing-videos/upload-url", "post"],
      ["/api/swing-videos", "post"],
      ["/api/portal/highlights", "post"],
      ["/api/portal/caddie/recommend?distanceYards=150", "get"],
      ["/api/portal/caddie/feedback/summary", "get"],
      [`/api/organizations/${orgId}/media/upload-url`, "post"],
      [`/api/organizations/${orgId}/media`, "post"],
    ];
    for (const [path, method] of endpoints) {
      const r = method === "get"
        ? await request(unauthApp).get(path)
        : await request(unauthApp).post(path).send({});
      expect(r.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
