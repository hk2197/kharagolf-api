/**
 * Integration tests: Social sign-in (Google + Apple) — Task #1226
 *
 * Covers POST /api/auth/google and POST /api/auth/apple in
 * routes/social-auth.ts. The Google verifier (OAuth2Client.verifyIdToken)
 * and the Apple JWKS / jwtVerify path are stubbed so no live network is
 * required. The DB is real so we can prove an app_users row, a sessions
 * row, and a user_active_sessions row are all written on a successful
 * sign-in.
 *
 * Scenarios pinned down here:
 *   - missing-token       → 400
 *   - misconfigured server → 503 (no GOOGLE_CLIENT_IDS / APPLE_CLIENT_IDS)
 *   - valid token, new email → app_users + sessions + user_active_sessions
 *   - valid token, existing email → links to existing row, no duplicate
 *   - erased account → 403
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const hoisted = vi.hoisted(() => ({
  googleVerifyIdToken: vi.fn(),
  joseJwtVerify: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = hoisted.googleVerifyIdToken;
  },
}));

vi.mock("jose", () => ({
  // The real implementation makes a network call to fetch Apple's keys.
  // The test never invokes the JWKS resolver because jwtVerify is fully
  // stubbed below, so an empty object is enough.
  createRemoteJWKSet: () => ({}),
  jwtVerify: hoisted.joseJwtVerify,
}));

vi.mock("../lib/mailer", () => ({
  sendWelcomeEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/analytics", () => ({
  track: vi.fn(async () => undefined),
}));

// Imported AFTER mocks so the router picks them up.
const { default: socialAuthRouter } = await import("../routes/social-auth");
const {
  db,
  appUsersTable,
  appUserSocialLinksTable,
  sessionsTable,
  userActiveSessionsTable,
} = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", socialAuthRouter);
  return app;
}

const app = buildApp();
const ts = Date.now();
const createdUserIds = new Set<number>();
const createdSids = new Set<string>();

async function trackUser(id: number) {
  createdUserIds.add(id);
}

beforeAll(() => {
  process.env.GOOGLE_CLIENT_IDS = "test-google-client-id.apps.googleusercontent.com";
  process.env.APPLE_CLIENT_IDS = "com.kharagolf.test";
});

afterEach(() => {
  hoisted.googleVerifyIdToken.mockReset();
  hoisted.joseJwtVerify.mockReset();
});

afterAll(async () => {
  // user_active_sessions and app_user_social_links cascade from app_users;
  // sessions are independent.
  if (createdSids.size > 0) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.sid, [...createdSids]));
  }
  if (createdUserIds.size > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, [...createdUserIds]));
  }
});

// ── Missing token ────────────────────────────────────────────────────────────

describe("Social auth — missing token", () => {
  it("POST /api/auth/google returns 400 when idToken is missing", async () => {
    const res = await request(app).post("/api/auth/google").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idToken/i);
    expect(hoisted.googleVerifyIdToken).not.toHaveBeenCalled();
  });

  it("POST /api/auth/apple returns 400 when identityToken is missing", async () => {
    const res = await request(app).post("/api/auth/apple").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/identityToken/i);
    expect(hoisted.joseJwtVerify).not.toHaveBeenCalled();
  });
});

// ── Misconfigured server ────────────────────────────────────────────────────

describe("Social auth — server not configured", () => {
  it("POST /api/auth/google returns 503 when no GOOGLE_CLIENT_IDS is set", async () => {
    const savedIds = process.env.GOOGLE_CLIENT_IDS;
    const savedId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const res = await request(app)
        .post("/api/auth/google")
        .send({ idToken: "anything" });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
      expect(hoisted.googleVerifyIdToken).not.toHaveBeenCalled();
    } finally {
      if (savedIds) process.env.GOOGLE_CLIENT_IDS = savedIds;
      if (savedId) process.env.GOOGLE_CLIENT_ID = savedId;
    }
  });

  it("POST /api/auth/apple returns 503 when no APPLE_CLIENT_IDS is set", async () => {
    const savedIds = process.env.APPLE_CLIENT_IDS;
    const savedSvc = process.env.APPLE_SERVICES_ID;
    delete process.env.APPLE_CLIENT_IDS;
    delete process.env.APPLE_SERVICES_ID;
    try {
      const res = await request(app)
        .post("/api/auth/apple")
        .send({ identityToken: "anything" });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
      expect(hoisted.joseJwtVerify).not.toHaveBeenCalled();
    } finally {
      if (savedIds) process.env.APPLE_CLIENT_IDS = savedIds;
      if (savedSvc) process.env.APPLE_SERVICES_ID = savedSvc;
    }
  });
});

// ── Valid token: new account ────────────────────────────────────────────────

describe("Social auth — valid token creates app_users + sessions + user_active_sessions", () => {
  it("Google: creates a brand-new player and writes all three rows", async () => {
    const email = `social-google-new-${ts}@example.com`;
    const sub = `google-sub-new-${ts}`;
    hoisted.googleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email,
        email_verified: true,
        name: "Google New Player",
        picture: "https://example.com/g.png",
        sub,
      }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake.google.token" });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);

    // The web path should set the sid cookie; we read it back so we can
    // verify the matching sessions + user_active_sessions rows exist.
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find((c) => c.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    const sid = sidCookie!.split(";")[0].slice("sid=".length);
    createdSids.add(sid);

    const [user] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(user).toBeDefined();
    expect(user.replitUserId).toBe(`google_${sub}`);
    expect(user.emailVerified).toBe(true);
    await trackUser(user.id);

    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sid, sid));
    expect(session).toBeDefined();

    const [activeSession] = await db
      .select()
      .from(userActiveSessionsTable)
      .where(eq(userActiveSessionsTable.sessionToken, sid));
    expect(activeSession).toBeDefined();
    expect(activeSession.userId).toBe(user.id);
  });

  it("Apple: mobile client receives token in body and rows are written", async () => {
    const email = `social-apple-new-${ts}@example.com`;
    const sub = `apple-sub-new-${ts}`;
    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub, email, email_verified: true },
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .set("x-client-type", "mobile")
      .send({
        identityToken: "fake.apple.token",
        fullName: { givenName: "Apple", familyName: "Player" },
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.email).toBe(email);

    const sid = res.body.token as string;
    createdSids.add(sid);

    const [user] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(user).toBeDefined();
    expect(user.replitUserId).toBe(`apple_${sub}`);
    await trackUser(user.id);

    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sid, sid));
    expect(session).toBeDefined();

    const [activeSession] = await db
      .select()
      .from(userActiveSessionsTable)
      .where(eq(userActiveSessionsTable.sessionToken, sid));
    expect(activeSession).toBeDefined();
    expect(activeSession.userId).toBe(user.id);
  });
});

// ── Valid token: existing email → link, do not duplicate ────────────────────

describe("Social auth — links an existing email account", () => {
  it("Google: signs in by email and backfills replit_user_id when it was a local placeholder", async () => {
    const email = `social-google-link-${ts}@example.com`;
    const placeholderReplitId = `ep_link_${ts}_${Math.random().toString(36).slice(2, 8)}`;

    const [pre] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: placeholderReplitId,
        username: `link_${ts}`,
        email,
        displayName: "Existing Player",
        role: "player",
        emailVerified: false,
      })
      .returning();
    await trackUser(pre.id);

    const sub = `google-sub-link-${ts}`;
    hoisted.googleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email,
        email_verified: true,
        name: "Google Link Player",
        sub,
      }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake.google.token" });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(pre.id);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find((c: string) => c?.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    const sid = sidCookie!.split(";")[0].slice("sid=".length);
    createdSids.add(sid);

    // Exactly one row should exist for this email — no duplicate created.
    const rows = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pre.id);
    expect(rows[0].replitUserId).toBe(`google_${sub}`); // backfilled
    expect(rows[0].emailVerified).toBe(true); // promoted to verified
  });

  it("Apple: signs in by email and backfills replit_user_id when it was a local placeholder", async () => {
    const email = `social-apple-link-${ts}@example.com`;
    const placeholderReplitId = `ep_apple_link_${ts}_${Math.random().toString(36).slice(2, 8)}`;

    const [pre] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: placeholderReplitId,
        username: `apple_link_${ts}`,
        email,
        displayName: "Existing Apple Player",
        role: "player",
        emailVerified: false,
      })
      .returning();
    await trackUser(pre.id);

    const sub = `apple-sub-link-${ts}`;
    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub, email, email_verified: true },
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "fake.apple.token" });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(pre.id);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find((c: string) => c?.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    const sid = sidCookie!.split(";")[0].slice("sid=".length);
    createdSids.add(sid);

    // Exactly one row should exist for this email — no duplicate created.
    const rows = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pre.id);
    expect(rows[0].replitUserId).toBe(`apple_${sub}`); // backfilled
    expect(rows[0].emailVerified).toBe(true); // promoted to verified
  });
});

// ── Social-config discovery endpoint ────────────────────────────────────────

describe("Social auth — GET /api/auth/social-config discovery", () => {
  it("returns { google: true, apple: true } when both env vars are set", async () => {
    // beforeAll sets both GOOGLE_CLIENT_IDS and APPLE_CLIENT_IDS, so this
    // is the happy path the player web/mobile clients see in production
    // when the server is fully configured.
    const res = await request(app).get("/api/auth/social-config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: true, apple: true });
  });

  it("returns { google: false, apple: false } when neither env var is set", async () => {
    const savedGoogleIds = process.env.GOOGLE_CLIENT_IDS;
    const savedGoogleId = process.env.GOOGLE_CLIENT_ID;
    const savedAppleIds = process.env.APPLE_CLIENT_IDS;
    const savedAppleSvc = process.env.APPLE_SERVICES_ID;
    delete process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.APPLE_CLIENT_IDS;
    delete process.env.APPLE_SERVICES_ID;
    try {
      const res = await request(app).get("/api/auth/social-config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ google: false, apple: false });
    } finally {
      if (savedGoogleIds) process.env.GOOGLE_CLIENT_IDS = savedGoogleIds;
      if (savedGoogleId) process.env.GOOGLE_CLIENT_ID = savedGoogleId;
      if (savedAppleIds) process.env.APPLE_CLIENT_IDS = savedAppleIds;
      if (savedAppleSvc) process.env.APPLE_SERVICES_ID = savedAppleSvc;
    }
  });
});

// ── Apple repeat sign-in (no email claim) ───────────────────────────────────

describe("Social auth — Apple repeat sign-in without email claim", () => {
  it("a second Apple sign-in with the same sub but no email reuses the existing user", async () => {
    const email = `social-apple-repeat-${ts}@example.com`;
    const sub = `apple-sub-repeat-${ts}`;

    // First sign-in: Apple returns the email (as it does on the very
    // first authorization). This creates the row with replit_user_id =
    // `apple_${sub}` so the subsequent lookup-by-sub path can find it.
    hoisted.joseJwtVerify.mockResolvedValueOnce({
      payload: { sub, email, email_verified: true },
    });
    const first = await request(app)
      .post("/api/auth/apple")
      .send({
        identityToken: "fake.apple.token.first",
        fullName: { givenName: "Apple", familyName: "Repeat" },
      });
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe(email);

    const firstCookies = first.headers["set-cookie"];
    const firstCookieList = Array.isArray(firstCookies)
      ? firstCookies
      : [firstCookies];
    const firstSidCookie = firstCookieList.find((c: string) =>
      c?.startsWith("sid="),
    );
    const firstSid = firstSidCookie!.split(";")[0].slice("sid=".length);
    createdSids.add(firstSid);

    const [created] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(created).toBeDefined();
    await trackUser(created.id);

    // Second sign-in: Apple omits the email claim (the documented
    // behaviour for every sign-in after the first). The route must still
    // resolve the existing row via the provider-subject lookup and start
    // a new session for the same user — no duplicate row created.
    hoisted.joseJwtVerify.mockResolvedValueOnce({
      payload: { sub, email_verified: true },
    });
    const second = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "fake.apple.token.second" });

    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(created.id);
    expect(second.body.user.email).toBe(email);

    const secondCookies = second.headers["set-cookie"];
    expect(secondCookies).toBeDefined();
    const secondCookieList = Array.isArray(secondCookies)
      ? secondCookies
      : [secondCookies];
    const secondSidCookie = secondCookieList.find((c: string) =>
      c?.startsWith("sid="),
    );
    expect(secondSidCookie).toBeDefined();
    const secondSid = secondSidCookie!.split(";")[0].slice("sid=".length);
    expect(secondSid).not.toBe(firstSid); // a fresh session was created
    createdSids.add(secondSid);

    // Still exactly one app_users row for this email — no duplicate
    // created by the second (email-less) sign-in.
    const rows = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);

    // The new session is recorded both in `sessions` and in
    // `user_active_sessions` so it shows up in the portal Sessions UI.
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sid, secondSid));
    expect(session).toBeDefined();

    const [activeSession] = await db
      .select()
      .from(userActiveSessionsTable)
      .where(eq(userActiveSessionsTable.sessionToken, secondSid));
    expect(activeSession).toBeDefined();
    expect(activeSession.userId).toBe(created.id);
  });

  it("a first-ever Apple sign-in with no email returns 400 email_required", async () => {
    // Brand-new Apple subject the server has never seen, and Apple did
    // not return an email claim. There's no link row, no legacy
    // replit_user_id row, and no email to fall back to — the route must
    // surface the friendly 400 telling the user to retry and choose
    // "Share My Email".
    const sub = `apple-sub-firsttime-no-email-${ts}`;
    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub, email_verified: true },
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "fake.apple.token" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/share my email/i);
    expect(res.headers["set-cookie"]).toBeUndefined();

    // Nothing was inserted — no app_users row was created for this sub.
    const [bySub] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.replitUserId, `apple_${sub}`));
    expect(bySub).toBeUndefined();
  });
});

// ── Erased account is refused ───────────────────────────────────────────────

describe("Social auth — erased accounts are refused", () => {
  it("Google: returns 403 when the matching email belongs to an erased account", async () => {
    const email = `social-google-erased-${ts}@example.com`;
    const [pre] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_erased_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `erased_${ts}`,
        email,
        role: "player",
        emailVerified: true,
        erasedAt: new Date(),
      })
      .returning();
    await trackUser(pre.id);

    hoisted.googleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email,
        email_verified: true,
        name: "Erased Player",
        sub: `google-sub-erased-${ts}`,
      }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake.google.token" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deleted/i);

    // No new row created and no session cookie set.
    const rows = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email));
    expect(rows).toHaveLength(1);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("Apple: returns 403 when the provider subject already maps to an erased account", async () => {
    const sub = `apple-sub-erased-${ts}`;
    const [pre] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `apple_${sub}`,
        username: `erased_apple_${ts}`,
        email: `social-apple-erased-${ts}@example.com`,
        role: "player",
        emailVerified: true,
        erasedAt: new Date(),
      })
      .returning();
    await trackUser(pre.id);

    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub, email_verified: true },
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "fake.apple.token" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deleted/i);
  });
});

// Cross-account collision guard. The unique index on
// (provider, provider_sub) makes the collision physically impossible for the
// social sign-in route (step 1 of findOrCreateSocialUser always resolves to
// the link's owner), but the helper `recordSocialLink` is also called from
// wave3.ts where the userId comes from the session and a real mismatch can
// occur. We pin both layers: the route safely returns user A when given a
// token whose sub is A's but whose email is B's; the helper throws
// `provider_already_linked` and leaves A's row untouched. The route's 409
// catch branch on the social sign-in route is unreachable from real input
// (helper preconditions never trip there) and is exercised at the route
// level by portal-social-links.test.ts which uses the same helper.

describe("Social auth — cross-account collision guard", () => {
  it("Google route resolves via the link table when the token sub belongs to user A but the email belongs to user B", async () => {
    const subX = `google-collision-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `gcollision-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const emailB = `gcollision-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_gcol_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `gcol_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailA,
        displayName: "Owner A",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "google",
      providerSub: subX,
    });

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_gcol_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `gcol_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailB,
        displayName: "Conflicting B",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    hoisted.googleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: emailB,
        email_verified: true,
        name: "Conflicting B",
        sub: subX,
      }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake.google.token" });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userA.id);
    expect(res.body.user.email).toBe(emailA);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find((c: string) => c?.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    createdSids.add(sidCookie!.split(";")[0].slice("sid=".length));

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });

  it("Apple route resolves via the link table when the token sub belongs to user A but the email belongs to user B", async () => {
    const subX = `apple-collision-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `acollision-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const emailB = `acollision-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_acol_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `acol_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailA,
        displayName: "Apple Owner A",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "apple",
      providerSub: subX,
    });

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_acol_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `acol_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailB,
        displayName: "Apple Conflicting B",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub: subX, email: emailB, email_verified: true },
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({
        identityToken: "fake.apple.token",
        fullName: { givenName: "Apple", familyName: "Conflicting" },
      });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userA.id);
    expect(res.body.user.email).toBe(emailA);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find((c: string) => c?.startsWith("sid="));
    expect(sidCookie).toBeDefined();
    createdSids.add(sidCookie!.split(";")[0].slice("sid=".length));

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "apple"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });

  it("Google helper throws provider_already_linked and leaves A's link row unchanged when B tries to claim A's sub", async () => {
    const { recordSocialLink } = await import("../routes/social-auth");
    const subX = `google-helper-collision-${ts}-${Math.random().toString(36).slice(2, 8)}`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_ghelp_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `ghelp_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: `ghelp-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: "Helper Owner",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "google",
      providerSub: subX,
    });

    const [linkBefore] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_ghelp_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `ghelp_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: `ghelp-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: "Helper Thief",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    await expect(
      recordSocialLink({
        userId: userB.id,
        provider: "google",
        providerSub: subX,
      }),
    ).rejects.toThrow("provider_already_linked");

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);
    expect(linkAfter.providerSub).toBe(subX);
    expect(linkAfter.linkedAt.getTime()).toBe(linkBefore.linkedAt.getTime());
    expect(linkAfter.lastUsedAt.getTime()).toBe(linkBefore.lastUsedAt.getTime());

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });

  it("Apple helper throws provider_already_linked and leaves A's link row unchanged when B tries to claim A's sub", async () => {
    const { recordSocialLink } = await import("../routes/social-auth");
    const subX = `apple-helper-collision-${ts}-${Math.random().toString(36).slice(2, 8)}`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_ahelp_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `ahelp_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: `ahelp-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: "Apple Helper Owner",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "apple",
      providerSub: subX,
    });

    const [linkBefore] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "apple"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_ahelp_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `ahelp_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: `ahelp-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        displayName: "Apple Helper Thief",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    await expect(
      recordSocialLink({
        userId: userB.id,
        provider: "apple",
        providerSub: subX,
      }),
    ).rejects.toThrow("provider_already_linked");

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "apple"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);
    expect(linkAfter.providerSub).toBe(subX);
    expect(linkAfter.linkedAt.getTime()).toBe(linkBefore.linkedAt.getTime());
    expect(linkAfter.lastUsedAt.getTime()).toBe(linkBefore.lastUsedAt.getTime());

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });

  it("Google route returns 409 with the friendly cross-account message when recordSocialLink throws provider_already_linked, leaving A's link row intact", async () => {
    const socialAuthMod = await import("../routes/social-auth");
    const subX = `google-route-409-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `groute409-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const emailB = `groute409-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_groute409_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `groute409_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailA,
        displayName: "Route 409 Owner",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "google",
      providerSub: subX,
    });
    const [linkBefore] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_groute409_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `groute409_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailB,
        displayName: "Route 409 Thief",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    hoisted.googleVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: emailB,
        email_verified: true,
        name: "Route 409 Thief",
        sub: `unrelated-${subX}`,
      }),
    });
    const recordSpy = vi
      .spyOn(socialAuthMod._internals, "recordSocialLink")
      .mockRejectedValue(new Error("provider_already_linked"));

    try {
      const res = await request(app)
        .post("/api/auth/google")
        .send({ idToken: "fake.google.token" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        "This Google account is already linked to a different KHARAGOLF account.",
      );
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.user).toBeUndefined();
      expect(res.body.token).toBeUndefined();
    } finally {
      recordSpy.mockRestore();
    }

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);
    expect(linkAfter.providerSub).toBe(subX);
    expect(linkAfter.linkedAt.getTime()).toBe(linkBefore.linkedAt.getTime());
    expect(linkAfter.lastUsedAt.getTime()).toBe(linkBefore.lastUsedAt.getTime());

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });

  it("Apple route returns 409 with the friendly cross-account message when recordSocialLink throws provider_already_linked, leaving A's link row intact", async () => {
    const socialAuthMod = await import("../routes/social-auth");
    const subX = `apple-route-409-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `aroute409-a-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const emailB = `aroute409-b-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const [userA] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_aroute409_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `aroute409_a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailA,
        displayName: "Apple Route 409 Owner",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userA.id);

    await db.insert(appUserSocialLinksTable).values({
      userId: userA.id,
      provider: "apple",
      providerSub: subX,
    });
    const [linkBefore] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "apple"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));

    const [userB] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: `ep_aroute409_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        username: `aroute409_b_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        email: emailB,
        displayName: "Apple Route 409 Thief",
        role: "player",
        emailVerified: true,
      })
      .returning();
    await trackUser(userB.id);

    hoisted.joseJwtVerify.mockResolvedValue({
      payload: { sub: `unrelated-${subX}`, email: emailB, email_verified: true },
    });
    const recordSpy = vi
      .spyOn(socialAuthMod._internals, "recordSocialLink")
      .mockRejectedValue(new Error("provider_already_linked"));

    try {
      const res = await request(app)
        .post("/api/auth/apple")
        .send({
          identityToken: "fake.apple.token",
          fullName: { givenName: "Route", familyName: "409" },
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        "This Apple ID is already linked to a different KHARAGOLF account.",
      );
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.user).toBeUndefined();
      expect(res.body.token).toBeUndefined();
    } finally {
      recordSpy.mockRestore();
    }

    const [linkAfter] = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "apple"),
        eq(appUserSocialLinksTable.providerSub, subX),
      ));
    expect(linkAfter.userId).toBe(userA.id);
    expect(linkAfter.providerSub).toBe(subX);
    expect(linkAfter.linkedAt.getTime()).toBe(linkBefore.linkedAt.getTime());
    expect(linkAfter.lastUsedAt.getTime()).toBe(linkBefore.lastUsedAt.getTime());

    const bLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, userB.id));
    expect(bLinks).toHaveLength(0);
  });
});
