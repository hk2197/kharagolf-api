/**
 * Integration tests: Task #1225 — portal social-link list & unlink.
 *
 * Pins the `/api/portal/me/social-links` GET + DELETE behaviour:
 *   1. GET returns each (user, provider) row plus the lockout-safety
 *      flags `hasPassword` and `hasReplitOauth` so the UI can disable
 *      "Unlink" when removing the row would orphan the account.
 *   2. DELETE happily removes the link when the player has another way
 *      to sign in (a password set, or a different linked provider, or
 *      an OAuth identity that isn't the auto-stamped placeholder).
 *   3. DELETE refuses with 409 `last_login_method` when removing the
 *      row would leave the player with no way back in.
 *   4. DELETE 400s on unknown providers and 404s when the link is
 *      already absent.
 *   5. DELETE rewrites the legacy `<provider>_<sub>` `replit_user_id`
 *      stamp so the next sign-in cannot resurrect the link via the
 *      legacy fallback path in routes/social-auth.ts.
 *   6. GET surfaces a synthetic legacy link when the user has no row
 *      but their `replit_user_id` is a `<provider>_<sub>` stamp, AND
 *      DELETE handles that legacy-only case so pre-migration users
 *      can unlink without first having to sign in via the provider
 *      to backfill a row.
 *   7. POST links a provider while logged in and refuses to steal
 *      links already attached to a different user with 409.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db, appUsersTable, appUserSocialLinksTable, userNotificationPrefsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// Stub the provider-token verifiers so POST tests can exercise the
// happy-path + duplicate-link paths without speaking to Google/Apple.
// `recordSocialLink` is intentionally NOT mocked — we want the real
// uniqueness check to fire so the 409 path is genuine.
vi.mock("../routes/social-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/social-auth.js")>();
  return {
    ...actual,
    verifyGoogleIdToken: vi.fn(),
    verifyAppleIdentityToken: vi.fn(),
  };
});
// Task #1736 — stub the security-alert mailer so we can assert it's
// triggered on a successful link AND skipped on the failure / 409 paths
// without needing a real outbound provider.
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendSocialLinkAddedSecurityEmail: vi.fn(async () => undefined),
    // Task #2149 — same shape, mirror flow on the DELETE side.
    sendSocialLinkRemovedSecurityEmail: vi.fn(async () => undefined),
  };
});
const socialAuth = await import("../routes/social-auth.js");
const verifyGoogleIdTokenMock = vi.mocked(socialAuth.verifyGoogleIdToken);
const verifyAppleIdentityTokenMock = vi.mocked(socialAuth.verifyAppleIdentityToken);
const mailer = await import("../lib/mailer.js");
const sendSocialLinkAddedSecurityEmailMock = vi.mocked(mailer.sendSocialLinkAddedSecurityEmail);
const sendSocialLinkRemovedSecurityEmailMock = vi.mocked(mailer.sendSocialLinkRemovedSecurityEmail);

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

describe("Task #1225 — portal social links", () => {
  let userWithPasswordId: number;
  let userOnlyAppleId: number;
  let userBothProvidersId: number;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    // Task #2150 — defensively ensure the per-event opt-out column
    // exists before any POST hits the route, since the route now
    // SELECTs `notify_social_link_added` from `user_notification_prefs`
    // to gate the security email. Mirrors the pattern in
    // `portal-notification-prefs-admin-payout-reverify-audit.test.ts`
    // so this file does not depend on the test runner having already
    // applied the numbered migration `0153_notify_social_link_added.sql`.
    await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_social_link_added boolean NOT NULL DEFAULT true`);

    // User A: password set + Google + Apple linked. Safe to unlink either.
    const [a] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_a`,
      username: `t1225_a_${stamp}`,
      email: `t1225_a_${stamp}@example.com`,
      displayName: "Player A",
      role: "player",
      passwordHash: "x".repeat(60), // marker only; route only checks truthiness
      emailVerified: true,
    }).returning();
    userWithPasswordId = a.id;
    createdUserIds.push(a.id);

    // User B: NO password, single Apple link, replit_user_id is the legacy
    // `apple_<sub>` stamp. Unlinking would lock them out → expect 409.
    const [b] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_b_sub`,
      username: `t1225_b_${stamp}`,
      email: `t1225_b_${stamp}@example.com`,
      displayName: "Player B",
      role: "player",
      emailVerified: true,
    }).returning();
    userOnlyAppleId = b.id;
    createdUserIds.push(b.id);

    // User C: NO password, both Apple + Google linked, legacy stamp from
    // Apple. Unlinking Apple is safe (Google remains) AND should clear the
    // legacy `apple_…` stamp so the unlink genuinely sticks.
    const [c] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_c_sub`,
      username: `t1225_c_${stamp}`,
      email: `t1225_c_${stamp}@example.com`,
      displayName: "Player C",
      role: "player",
      emailVerified: true,
    }).returning();
    userBothProvidersId = c.id;
    createdUserIds.push(c.id);

    await db.insert(appUserSocialLinksTable).values([
      { userId: a.id, provider: "google", providerSub: `g_${stamp}_a` },
      { userId: a.id, provider: "apple",  providerSub: `a_${stamp}_a` },
      { userId: b.id, provider: "apple",  providerSub: `a_${stamp}_b` },
      { userId: c.id, provider: "apple",  providerSub: `a_${stamp}_c` },
      { userId: c.id, provider: "google", providerSub: `g_${stamp}_c` },
    ]);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(appUserSocialLinksTable).where(inArray(appUserSocialLinksTable.userId, createdUserIds));
      await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
    }
  });

  beforeEach(() => {
    sendSocialLinkAddedSecurityEmailMock.mockClear();
    sendSocialLinkRemovedSecurityEmailMock.mockClear();
  });

  it("GET lists linked providers with lockout-safety flags", async () => {
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).get("/api/portal/me/social-links");
    expect(r.status).toBe(200);
    expect(r.body.hasPassword).toBe(true);
    // `ep_…` is a local-registration placeholder, not a real Replit OAuth id.
    expect(r.body.hasReplitOauth).toBe(false);
    const providers = r.body.links.map((l: { provider: string }) => l.provider).sort();
    expect(providers).toEqual(["apple", "google"]);
  });

  it("GET reports `hasReplitOauth=false` when replit_user_id is a `<provider>_…` placeholder", async () => {
    const app = createTestApp({ id: userOnlyAppleId, username: "b", role: "player" });
    const r = await request(app).get("/api/portal/me/social-links");
    expect(r.status).toBe(200);
    expect(r.body.hasPassword).toBe(false);
    expect(r.body.hasReplitOauth).toBe(false);
    expect(r.body.links).toHaveLength(1);
    expect(r.body.links[0].provider).toBe("apple");
  });

  it("DELETE refuses (409 last_login_method) when removing the only sign-in method", async () => {
    const app = createTestApp({ id: userOnlyAppleId, username: "b", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("last_login_method");
    // Row must remain.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, userOnlyAppleId));
    expect(rows).toHaveLength(1);
    // Task #2149 — no security email when the unlink was refused. The
    // account state didn't change, so sending one would be a false alarm.
    expect(sendSocialLinkRemovedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("DELETE removes the link when the user has a password fallback", async () => {
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app)
      .delete("/api/portal/me/social-links/google")
      .set("user-agent", "vitest-google-unlink/1.0");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, userWithPasswordId));
    expect(rows.map(r => r.provider)).toEqual(["apple"]);

    // Task #2149 — security email is queued on success.
    expect(sendSocialLinkRemovedSecurityEmailMock).toHaveBeenCalledTimes(1);
    const args = sendSocialLinkRemovedSecurityEmailMock.mock.calls[0][0];
    expect(args.to).toBe(`t1225_a_${stamp}@example.com`);
    expect(args.provider).toBe("google");
    expect(args.recipientName).toBe("Player A");
    expect(args.userAgent).toBe("vitest-google-unlink/1.0");
    expect(args.unlinkedAt).toBeInstanceOf(Date);
    expect(args.privacyUrl).toMatch(/\/portal\/privacy$/);
  });

  it("DELETE removes the link AND clears legacy `<provider>_<sub>` stamp when another provider remains", async () => {
    const app = createTestApp({ id: userBothProvidersId, username: "c", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(200);

    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, userBothProvidersId));
    expect(rows.map(r => r.provider)).toEqual(["google"]);

    // The legacy `apple_…` `replit_user_id` should have been rewritten so a
    // future Apple sign-in cannot find this user via the legacy fallback.
    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, userBothProvidersId));
    expect(reloaded.replitUserId.startsWith("apple_")).toBe(false);
    expect(reloaded.replitUserId).toMatch(/^unlinked_apple_/);
  });

  it("DELETE 400s on unknown provider", async () => {
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/facebook");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown_provider");
    // Task #2149 — no email on the early-out unknown-provider 400.
    expect(sendSocialLinkRemovedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("DELETE 404s when the link is already absent", async () => {
    // Player A's Google link was removed in the test above; deleting it
    // again should yield 404 not_linked.
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/google");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_linked");
    // Task #2149 — no email on the not_linked 404. Nothing was actually
    // removed, so the alert would be misleading.
    expect(sendSocialLinkRemovedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: two-step unlink cannot lock the user out (the rewritten `unlinked_…` stamp must NOT count as Replit OAuth)", async () => {
    // Fresh user with NO password and BOTH providers linked, plus the
    // legacy `apple_<sub>` stamp — exactly the at-risk profile the
    // lockout guard exists to protect. Step 1: unlink Apple (safe,
    // Google remains; the `apple_…` stamp is rewritten to
    // `unlinked_apple_…`). Step 2: unlink Google (must FAIL with 409
    // because the player would otherwise have no remaining way in).
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_2step_sub`,
      username: `t1225_2step_${stamp}`,
      email: `t1225_2step_${stamp}@example.com`,
      displayName: "Two-Step",
      role: "player",
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "apple",  providerSub: `a_${stamp}_2step` },
      { userId: u.id, provider: "google", providerSub: `g_${stamp}_2step` },
    ]);

    const app = createTestApp({ id: u.id, username: "t", role: "player" });

    // Step 1 — Apple unlink succeeds (Google still around as fallback).
    const r1 = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r1.status).toBe(200);

    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, u.id));
    expect(reloaded.replitUserId).toMatch(/^unlinked_apple_/);

    // Step 2 — Google unlink MUST be refused. Before the heuristic was
    // hardened, the rewritten `unlinked_apple_…` was misread as a real
    // Replit OAuth id and this DELETE incorrectly returned 200, leaving
    // the player with zero login methods.
    const r2 = await request(app).delete("/api/portal/me/social-links/google");
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("last_login_method");

    // And the row must still exist.
    const remaining = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(remaining.map(r => r.provider)).toEqual(["google"]);
  });

  it("LEGACY: GET surfaces a synthetic link when there is no row but `replit_user_id` is a `<provider>_…` stamp", async () => {
    // Pre-migration user: only the legacy stamp, no row in
    // app_user_social_links. Plus a password so they aren't lockout-blocked.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `google_${stamp}_legacy_only_sub`,
      username: `t1225_legonly_${stamp}`,
      email: `t1225_legonly_${stamp}@example.com`,
      displayName: "Legacy Only",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    const app = createTestApp({ id: u.id, username: "lo", role: "player" });
    const r = await request(app).get("/api/portal/me/social-links");
    expect(r.status).toBe(200);
    expect(r.body.links).toHaveLength(1);
    expect(r.body.links[0].provider).toBe("google");
    expect(r.body.links[0].legacy).toBe(true);
  });

  it("LEGACY: DELETE removes a legacy-only link (no row) by rewriting `replit_user_id`", async () => {
    // Pre-migration user with the apple stamp + a password fallback.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_legacy_unlink_sub`,
      username: `t1225_legunlink_${stamp}`,
      email: `t1225_legunlink_${stamp}@example.com`,
      displayName: "Legacy Unlink",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    const app = createTestApp({ id: u.id, username: "lu", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(200);

    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, u.id));
    expect(reloaded.replitUserId).toMatch(/^unlinked_apple_/);

    // And subsequent GET no longer lists it.
    const r2 = await request(app).get("/api/portal/me/social-links");
    expect(r2.status).toBe(200);
    expect(r2.body.links).toHaveLength(0);
  });

  it("LEGACY: DELETE refuses to unlink a legacy-only link if it's the only sign-in method", async () => {
    // No password, no other link, just the legacy stamp → must 409.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_legacy_lock_sub`,
      username: `t1225_leglock_${stamp}`,
      email: `t1225_leglock_${stamp}@example.com`,
      displayName: "Legacy Lock",
      role: "player",
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    const app = createTestApp({ id: u.id, username: "ll", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("last_login_method");

    // The stamp must still be intact (no rewrite if we refused).
    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, u.id));
    expect(reloaded.replitUserId).toBe(`apple_${stamp}_legacy_lock_sub`);
  });

  it("MIXED LEGACY+ROW: unlinking the tracked provider succeeds when the legacy stamp is for a DIFFERENT provider", async () => {
    // Reviewer's repro: replit_user_id = `apple_<sub>` (legacy Apple), one
    // real row for Google, no password. GET surfaces both Apple+Google,
    // so DELETE on Google MUST succeed (the legacy Apple stamp is still a
    // valid way back in). Before the fix this returned 409 because the
    // lockout guard ignored the synthetic legacy fallback.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_mixed_sub`,
      username: `t1225_mixed_${stamp}`,
      email: `t1225_mixed_${stamp}@example.com`,
      displayName: "Mixed",
      role: "player",
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "google", providerSub: `g_${stamp}_mixed` },
    ]);

    const app = createTestApp({ id: u.id, username: "mx", role: "player" });

    // Sanity: GET surfaces both.
    const rGet = await request(app).get("/api/portal/me/social-links");
    expect(rGet.status).toBe(200);
    expect(rGet.body.links.map((l: { provider: string }) => l.provider).sort()).toEqual(["apple", "google"]);

    // Unlink Google → succeeds because legacy Apple stamp remains.
    const r = await request(app).delete("/api/portal/me/social-links/google");
    expect(r.status).toBe(200);

    // Apple legacy stamp should NOT be touched (we unlinked Google).
    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, u.id));
    expect(reloaded.replitUserId).toBe(`apple_${stamp}_mixed_sub`);

    // The Google row is gone.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("MIXED LEGACY+ROW: mirror — legacy Google stamp + tracked Apple row, unlinking Apple succeeds", async () => {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `google_${stamp}_mixed2_sub`,
      username: `t1225_mixed2_${stamp}`,
      email: `t1225_mixed2_${stamp}@example.com`,
      displayName: "Mixed 2",
      role: "player",
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "apple", providerSub: `a_${stamp}_mixed2` },
    ]);

    const app = createTestApp({ id: u.id, username: "mx2", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(200);

    const [reloaded] = await db.select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable).where(eq(appUsersTable.id, u.id));
    expect(reloaded.replitUserId).toBe(`google_${stamp}_mixed2_sub`);
  });

  it("POST links Google for a logged-in user (happy path)", async () => {
    // Fresh user with no Google link yet.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_post_g`,
      username: `t1225_post_g_${stamp}`,
      email: `t1225_post_g_${stamp}@example.com`,
      displayName: "Post G",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_post_g_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_post_sub`,
    });

    const app = createTestApp({ id: u.id, username: "pg", role: "player" });
    const r = await request(app)
      .post("/api/portal/me/social-links/google")
      .set("user-agent", "vitest-google-link/1.0")
      .send({ idToken: "stub" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("google");
    expect(rows[0].providerSub).toBe(`g_${stamp}_post_sub`);

    // Task #1736 — security email is queued on success.
    expect(sendSocialLinkAddedSecurityEmailMock).toHaveBeenCalledTimes(1);
    const args = sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0];
    expect(args.to).toBe(`t1225_post_g_${stamp}@example.com`);
    expect(args.provider).toBe("google");
    expect(args.recipientName).toBe("Post G");
    expect(args.userAgent).toBe("vitest-google-link/1.0");
    expect(args.linkedAt).toBeInstanceOf(Date);
    expect(args.privacyUrl).toMatch(/\/portal\/privacy$/);
  });

  it("POST links Apple for a logged-in user (happy path)", async () => {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_post_a`,
      username: `t1225_post_a_${stamp}`,
      email: `t1225_post_a_${stamp}@example.com`,
      displayName: "Post A",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyAppleIdentityTokenMock.mockResolvedValueOnce({
      email: `t1225_post_a_${stamp}@example.com`,
      emailVerified: true,
      sub: `a_${stamp}_post_sub`,
    });

    const app = createTestApp({ id: u.id, username: "pa", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/apple").send({ identityToken: "stub" });
    expect(r.status).toBe(200);

    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows.map(r => r.provider)).toEqual(["apple"]);

    // Task #1736 — security email is queued on success.
    expect(sendSocialLinkAddedSecurityEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0].provider).toBe("apple");
    expect(sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0].to).toBe(`t1225_post_a_${stamp}@example.com`);
  });

  // Task #2150 — per-event opt-out for the security heads-up email.
  // The schema column `notify_social_link_added` defaults to true so
  // the existing happy-path tests above (which never write a prefs
  // row) already cover the "no row → still ships" interpretation.
  // These two cases pin the new gate explicitly:
  //   1. when the column is `false`, the route MUST NOT call the
  //      mailer even though every other side-effect (link insert,
  //      audit, response) still happens;
  //   2. when the column is explicitly `true`, behaviour matches
  //      the default (mailer fires once with the same payload).
  // The defensive `ADD COLUMN IF NOT EXISTS` mirrors the pattern in
  // `portal-notification-prefs-admin-payout-reverify-audit.test.ts`
  // so this file does not depend on the test runner having already
  // applied the numbered migration `0153_notify_social_link_added.sql`.
  it("POST skips the security email when notifySocialLinkAdded=false (opt-out)", async () => {
    await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_social_link_added boolean NOT NULL DEFAULT true`);

    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_post_optout`,
      username: `t1225_post_optout_${stamp}`,
      email: `t1225_post_optout_${stamp}@example.com`,
      displayName: "Post OptOut",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    // Player has explicitly muted just this notice via the
    // PortalCommPrefs toggle. Channel + umbrella `privacy` category
    // are intentionally left untouched so the test pins the
    // per-event gate, not the broader opt-out paths.
    await db.insert(userNotificationPrefsTable).values({
      userId: u.id,
      notifySocialLinkAdded: false,
    });

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_post_optout_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_post_optout_sub`,
    });

    const app = createTestApp({ id: u.id, username: "po", role: "player" });
    const r = await request(app)
      .post("/api/portal/me/social-links/google")
      .send({ idToken: "stub" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Link itself MUST still persist — opting out of the alert does
    // not opt the user out of the linking flow.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("google");

    // …but the security email is suppressed.
    expect(sendSocialLinkAddedSecurityEmailMock).not.toHaveBeenCalled();

    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, u.id));
  });

  it("POST sends the security email when notifySocialLinkAdded=true (opt-in)", async () => {
    await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_social_link_added boolean NOT NULL DEFAULT true`);

    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_post_optin`,
      username: `t1225_post_optin_${stamp}`,
      email: `t1225_post_optin_${stamp}@example.com`,
      displayName: "Post OptIn",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    // Player has an explicit prefs row with the new flag set true —
    // distinct from "no row at all" so the test catches a future
    // regression where the gate accidentally inverts the boolean.
    await db.insert(userNotificationPrefsTable).values({
      userId: u.id,
      notifySocialLinkAdded: true,
    });

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_post_optin_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_post_optin_sub`,
    });

    const app = createTestApp({ id: u.id, username: "pi", role: "player" });
    const r = await request(app)
      .post("/api/portal/me/social-links/google")
      .send({ idToken: "stub" });
    expect(r.status).toBe(200);

    expect(sendSocialLinkAddedSecurityEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0].provider).toBe("google");
    expect(sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0].to).toBe(`t1225_post_optin_${stamp}@example.com`);

    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, u.id));
  });

  it("POST builds the privacy URL from APP_BASE_URL, never from request headers", async () => {
    // Task #1736 — security regression: a hijacker calling through a
    // proxy they control could spoof Host / X-Forwarded-Host headers,
    // and if we built the emailed Privacy link off those, the alert
    // would point at attacker-controlled HTML. Pin the trusted-origin
    // chain (APP_BASE_URL → REPLIT_DEV_DOMAIN → kharagolf.com fallback).
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_url_origin`,
      username: `t1225_urlorigin_${stamp}`,
      email: `t1225_urlorigin_${stamp}@example.com`,
      displayName: "URL Origin",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_urlorigin_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_url_origin_sub`,
    });

    const prevAppBaseUrl = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://trusted.example/";
    try {
      const app = createTestApp({ id: u.id, username: "uo", role: "player" });
      const r = await request(app)
        .post("/api/portal/me/social-links/google")
        .set("host", "evil.example")
        .set("x-forwarded-host", "evil.example")
        .set("x-forwarded-proto", "http")
        .send({ idToken: "stub" });
      expect(r.status).toBe(200);

      expect(sendSocialLinkAddedSecurityEmailMock).toHaveBeenCalledTimes(1);
      const args = sendSocialLinkAddedSecurityEmailMock.mock.calls[0][0];
      expect(args.privacyUrl).toBe("https://trusted.example/portal/privacy");
      // Belt-and-braces: the spoofed host must not appear anywhere in
      // the emailed URL.
      expect(args.privacyUrl).not.toMatch(/evil\.example/);
    } finally {
      if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevAppBaseUrl;
    }
  });

  it("POST 409 provider_already_linked when the provider sub belongs to another user", async () => {
    // Pre-seed a Google link on user A with a known sub.
    const [a] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_steal_a`,
      username: `t1225_steal_a_${stamp}`,
      email: `t1225_steal_a_${stamp}@example.com`,
      displayName: "Owner",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(a.id);
    const stolenSub = `g_${stamp}_stolen_sub`;
    await db.insert(appUserSocialLinksTable).values([
      { userId: a.id, provider: "google", providerSub: stolenSub },
    ]);

    // User B tries to claim the same Google sub. Must fail with 409.
    const [b] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_steal_b`,
      username: `t1225_steal_b_${stamp}`,
      email: `t1225_steal_b_${stamp}@example.com`,
      displayName: "Thief",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(b.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_steal_b_${stamp}@example.com`,
      emailVerified: true,
      sub: stolenSub,
    });

    const app = createTestApp({ id: b.id, username: "th", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("provider_already_linked");

    // The original owner's row is intact.
    const ownerRows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, a.id));
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0].providerSub).toBe(stolenSub);
    // And no row was written for the thief.
    const thiefRows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, b.id));
    expect(thiefRows).toHaveLength(0);

    // Task #1736 — no security email when the link wasn't actually
    // attached. Sending one would falsely tell the owner their account
    // was just linked to a NEW thief device, which it wasn't.
    expect(sendSocialLinkAddedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("POST 401 when Google email is not verified", async () => {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_unverified`,
      username: `t1225_unverif_${stamp}`,
      email: `t1225_unverif_${stamp}@example.com`,
      displayName: "Unverified",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: "x@example.com",
      emailVerified: false,
      sub: `g_${stamp}_unverified_sub`,
    });

    const app = createTestApp({ id: u.id, username: "uv", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(401);

    // Task #1736 — no security email when token verification rejected
    // the link. The user's account state didn't change.
    expect(sendSocialLinkAddedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("POST 401 + skips email when the provider token cannot be verified", async () => {
    // Task #1736 — verifier throws (e.g. expired/forged token). Route must
    // 401 AND must NOT queue a security email — nothing was linked.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_verify_fail`,
      username: `t1225_vfail_${stamp}`,
      email: `t1225_vfail_${stamp}@example.com`,
      displayName: "Verify Fail",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyAppleIdentityTokenMock.mockRejectedValueOnce(new Error("token_expired"));

    const app = createTestApp({ id: u.id, username: "vf", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/apple").send({ identityToken: "bogus" });
    expect(r.status).toBe(401);
    expect(sendSocialLinkAddedSecurityEmailMock).not.toHaveBeenCalled();

    // And no link row was written.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("POST skips the security email when the user's email is not verified", async () => {
    // Task #1736 — we only deliver to addresses we trust the user can
    // actually read. An unverified address could belong to anyone (incl.
    // the attacker who just signed up); leaking the security alert there
    // would be worse than skipping it.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_unverif_email`,
      username: `t1225_unverif_email_${stamp}`,
      email: `t1225_unverif_email_${stamp}@example.com`,
      displayName: "Unverified Email",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: false,
    }).returning();
    createdUserIds.push(u.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_unverif_email_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_unverif_email_sub`,
    });

    const app = createTestApp({ id: u.id, username: "ue", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(200);

    // Link still happens.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows.map(r => r.provider)).toEqual(["google"]);

    // But no email was sent — the verified-address gate held.
    expect(sendSocialLinkAddedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("POST does not fail the request if the security email throws", async () => {
    // Task #1736 — a transient mailer outage must not turn a successful
    // link into a 500. The caller is the legitimate owner here, so we'd
    // rather succeed-and-log than fail the action.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_mailer_fail`,
      username: `t1225_mfail_${stamp}`,
      email: `t1225_mfail_${stamp}@example.com`,
      displayName: "Mail Fail",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: `t1225_mfail_${stamp}@example.com`,
      emailVerified: true,
      sub: `g_${stamp}_mailer_fail_sub`,
    });
    sendSocialLinkAddedSecurityEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    const app = createTestApp({ id: u.id, username: "mf", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // The link is still recorded even though the alert send failed.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows.map(r => r.provider)).toEqual(["google"]);
    expect(sendSocialLinkAddedSecurityEmailMock).toHaveBeenCalledTimes(1);
  });

  it("POST 400s when the body is missing the provider token", async () => {
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r1 = await request(app).post("/api/portal/me/social-links/google").send({});
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("token_required");
    expect(r1.body.detail).toMatch(/idToken/);
    const r2 = await request(app).post("/api/portal/me/social-links/apple").send({});
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe("token_required");
    expect(r2.body.detail).toMatch(/identityToken/);
  });

  // Task #1735 — surface a stable error code for every link failure mode so
  // the portal Privacy screens can show actionable copy instead of "Could
  // not link".
  it("POST 401 token_invalid when the provider rejects the token", async () => {
    verifyGoogleIdTokenMock.mockRejectedValueOnce(new Error("token_expired"));
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("token_invalid");
    expect(typeof r.body.detail).toBe("string");
  });

  it("POST 401 email_not_verified when Google email isn't verified", async () => {
    verifyGoogleIdTokenMock.mockResolvedValueOnce({
      email: "x@example.com",
      emailVerified: false,
      sub: `g_${stamp}_unverified_code`,
    });
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("email_not_verified");
  });

  it("POST 503 provider_not_configured when the verifier reports the server is missing client IDs", async () => {
    verifyAppleIdentityTokenMock.mockRejectedValueOnce(new Error("apple_not_configured"));
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/apple").send({ identityToken: "stub" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("provider_not_configured");

    verifyGoogleIdTokenMock.mockRejectedValueOnce(new Error("google_not_configured"));
    const r2 = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "stub" });
    expect(r2.status).toBe(503);
    expect(r2.body.error).toBe("provider_not_configured");
  });

  it("POST 400s on unknown provider", async () => {
    const app = createTestApp({ id: userWithPasswordId, username: "a", role: "player" });
    const r = await request(app).post("/api/portal/me/social-links/facebook").send({ idToken: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown_provider");
  });

  it("POST requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).post("/api/portal/me/social-links/google").send({ idToken: "x" });
    expect(r.status).toBe(401);
  });

  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get("/api/portal/me/social-links");
    expect(r.status).toBe(401);
  });

  // ── Task #2149 — heads-up email when an Apple/Google link is REMOVED ──
  // Mirrors the link-side coverage in Task #1736: success queues, the
  // 404/409 paths skip, an unverified address suppresses, and a mailer
  // outage doesn't fail the unlink.

  it("DELETE queues the security email when removing a legacy-only link", async () => {
    // Pre-migration user: legacy `apple_<sub>` stamp, no row, password
    // fallback (so the unlink is allowed). The email should still fire
    // because the user just lost their Apple sign-in.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `apple_${stamp}_t2149_legacy_sub`,
      username: `t2149_legacy_${stamp}`,
      email: `t2149_legacy_${stamp}@example.com`,
      displayName: "Legacy Unlink 2149",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);

    const app = createTestApp({ id: u.id, username: "lu2", role: "player" });
    const r = await request(app)
      .delete("/api/portal/me/social-links/apple")
      .set("user-agent", "vitest-apple-unlink/1.0");
    expect(r.status).toBe(200);

    expect(sendSocialLinkRemovedSecurityEmailMock).toHaveBeenCalledTimes(1);
    const args = sendSocialLinkRemovedSecurityEmailMock.mock.calls[0][0];
    expect(args.provider).toBe("apple");
    expect(args.to).toBe(`t2149_legacy_${stamp}@example.com`);
    expect(args.recipientName).toBe("Legacy Unlink 2149");
    expect(args.userAgent).toBe("vitest-apple-unlink/1.0");
    expect(args.unlinkedAt).toBeInstanceOf(Date);
    expect(args.privacyUrl).toMatch(/\/portal\/privacy$/);
  });

  it("DELETE skips the security email when the user's email is not verified", async () => {
    // We only deliver to addresses we trust the user can read. Mirror of
    // the POST-side guard so an attacker who controls an unverified
    // address can't get the alert routed to them either.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_t2149_unverif_email`,
      username: `t2149_unverif_${stamp}`,
      email: `t2149_unverif_${stamp}@example.com`,
      displayName: "Unverified Unlink",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: false,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "google", providerSub: `g_${stamp}_t2149_unverif` },
    ]);

    const app = createTestApp({ id: u.id, username: "uvu", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/google");
    expect(r.status).toBe(200);

    // The unlink itself succeeded.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(0);

    // But no email was sent — the verified-address gate held.
    expect(sendSocialLinkRemovedSecurityEmailMock).not.toHaveBeenCalled();
  });

  it("DELETE does not fail the request if the security email throws", async () => {
    // A transient mailer outage must not turn a successful unlink into
    // a 500. The caller is the legitimate owner here, so we'd rather
    // succeed-and-log than fail the action.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_t2149_mailer_fail`,
      username: `t2149_mfail_${stamp}`,
      email: `t2149_mfail_${stamp}@example.com`,
      displayName: "Mail Fail Unlink",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "apple", providerSub: `a_${stamp}_t2149_mailer_fail` },
    ]);
    sendSocialLinkRemovedSecurityEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    const app = createTestApp({ id: u.id, username: "mfu", role: "player" });
    const r = await request(app).delete("/api/portal/me/social-links/apple");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // The unlink is still recorded even though the alert send failed.
    const rows = await db.select().from(appUserSocialLinksTable).where(eq(appUserSocialLinksTable.userId, u.id));
    expect(rows).toHaveLength(0);
    expect(sendSocialLinkRemovedSecurityEmailMock).toHaveBeenCalledTimes(1);
  });

  it("DELETE builds the privacy URL from APP_BASE_URL, never from request headers", async () => {
    // Same security regression as the link-side test: a hijacker calling
    // through a proxy they control could spoof Host / X-Forwarded-Host,
    // and if we built the emailed Privacy link off those, the alert
    // would point at attacker-controlled HTML.
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `ep_${stamp}_t2149_url_origin`,
      username: `t2149_urlorigin_${stamp}`,
      email: `t2149_urlorigin_${stamp}@example.com`,
      displayName: "URL Origin Unlink",
      role: "player",
      passwordHash: "x".repeat(60),
      emailVerified: true,
    }).returning();
    createdUserIds.push(u.id);
    await db.insert(appUserSocialLinksTable).values([
      { userId: u.id, provider: "google", providerSub: `g_${stamp}_t2149_url_origin` },
    ]);

    const prevAppBaseUrl = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://trusted.example/";
    try {
      const app = createTestApp({ id: u.id, username: "uou", role: "player" });
      const r = await request(app)
        .delete("/api/portal/me/social-links/google")
        .set("host", "evil.example")
        .set("x-forwarded-host", "evil.example")
        .set("x-forwarded-proto", "http");
      expect(r.status).toBe(200);

      expect(sendSocialLinkRemovedSecurityEmailMock).toHaveBeenCalledTimes(1);
      const args = sendSocialLinkRemovedSecurityEmailMock.mock.calls[0][0];
      expect(args.privacyUrl).toBe("https://trusted.example/portal/privacy");
      expect(args.privacyUrl).not.toMatch(/evil\.example/);
    } finally {
      if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevAppBaseUrl;
    }
  });
});
