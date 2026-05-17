/**
 * Tests for Task #2219 — extends the Task #1776 in-portal mute
 * confirmation pattern (originally stuck-erasure only) to every
 * sibling controller digest registered in
 * {@link import("../lib/portalDigestMuteRegistry.js").PORTAL_DIGEST_MUTE_REGISTRY}.
 *
 * The registry covers seven slugs (wallet-refund, side-game receipt,
 * per-levy and org-wide ledger CSV, bounced-levy reminders, exhaustion
 * admin, silent alerts) but the behaviour is uniform per the registry,
 * so we cover two representative paths in depth — wallet-refund (`wrf`)
 * and levy-ledger (`lld`) — and a third quick check that two slugs
 * silenced in the same PATCH yield two independent confirmation
 * emails. This mirrors the shape of Task #1776's coverage:
 *
 *   - PATCH transition detection (true→false fires; no-op or false→true
 *     does not).
 *   - Per-(user, slug) rate-limit watermark in
 *     `portal_digest_mute_confirmation_sends` suppresses a re-mute
 *     inside the throttle window and reopens once the window elapses.
 *   - Mailer failure does NOT stamp the watermark — a transient
 *     outage must not poison the next genuine attempt.
 *   - HMAC token round-trip + tampering + 7-day TTL for the new
 *     `pdr1:` revert token (kept distinct from the erasure `emr1:`
 *     token so a leaked sibling-digest link can't be replayed against
 *     the erasure endpoint).
 *   - Public `/api/public/portal-digest-mute-revert` handler flips the
 *     correct prefs column back to true on GET (link click) and on
 *     POST (RFC 8058 one-click), and rejects malformed/unknown-slug
 *     tokens with the 400 confirmation page.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Same `importActual` + spread pattern as the erasure suite — the
// portal router transitively imports many other mailers which we don't
// want to mock away. Only the two sender shapes the new path uses are
// stubbed here so the tests can assert their call args without going
// near the real Postmark adapter (which has no transport configured
// under vitest).
vi.mock("../lib/mailer.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    // Sibling-digest confirmation mailer — what Task #2219 added.
    sendPortalDigestMutedConfirmationEmail: vi.fn(async () => undefined),
    // Erasure mailer mocked too because the same PATCH route can fire
    // both in unrelated tests; we never want a stuck-erasure flag flip
    // to leak a real Postmark call from this suite.
    sendErasureStorageDigestMutedConfirmationEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  portalDigestMuteConfirmationSendsTable,
} from "@workspace/db";
import { eq, inArray, and, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";

import { sendPortalDigestMutedConfirmationEmail } from "../lib/mailer.js";
import {
  signPortalDigestMuteRevertToken,
  verifyPortalDigestMuteRevertToken,
  signErasureDigestMuteRevertToken,
  PORTAL_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS,
} from "../lib/bouncedDigestUnsubscribe.js";
import { PORTAL_DIGEST_MUTE_REGISTRY } from "../lib/portalDigestMuteRegistry.js";
import publicRouter from "../routes/public.js";
import { createTestApp } from "./helpers.js";
import { ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS } from "../routes/portal.js";

const muteConfirmMock = vi.mocked(sendPortalDigestMutedConfirmationEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `PortalDigestMute_${label}_${tag}`,
    slug: `portal-digest-mute-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `portal-digest-mute-${tag}`,
    username: `portal_digest_mute_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeController(
  orgId: number,
  role: "org_admin" | "membership_secretary" | "treasurer",
  email: string,
  displayName: string,
): Promise<number> {
  const userId = await makeUser({ email, displayName });
  await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role });
  return userId;
}

let prevAppBaseUrl: string | undefined;
let prevSessionSecret: string | undefined;
beforeAll(async () => {
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://test.kharagolf.com";
  prevSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-session-secret-portal-digest-mute";

  // The sibling-digest pref columns and the new watermark side table
  // are part of the schema but the test DB is bootstrapped per-suite;
  // this matches the shape of the erasure suite's schema preflight.
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_wallet_refund_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_side_game_receipt_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_levy_ledger_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_levy_ledger_org_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_levy_reminders_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_exhaustion_admin_digest_failed boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_silent_alerts_digest boolean NOT NULL DEFAULT true`);
  // Erasure prefs columns are also referenced by the PATCH handler's
  // pre-update read; missing columns would cascade into a 500 even
  // when the test only mutates a sibling-digest column.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_push boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_mute_confirmation_last_sent_at timestamptz`);
  // The watermark side table the new path writes to.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS portal_digest_mute_confirmation_sends (
      user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      digest_slug text NOT NULL,
      last_sent_at timestamptz NOT NULL,
      CONSTRAINT portal_digest_mute_confirmation_sends_pkey PRIMARY KEY (user_id, digest_slug)
    )
  `);
});

afterAll(async () => {
  if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevAppBaseUrl;
  if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSessionSecret;

  if (createdUserIds.length) {
    await db.delete(portalDigestMuteConfirmationSendsTable)
      .where(inArray(portalDigestMuteConfirmationSendsTable.userId, createdUserIds));
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  muteConfirmMock.mockReset();
  muteConfirmMock.mockResolvedValue(undefined);
});

// =====================================================================
// PATCH /portal/notification-preferences — wallet-refund (`wrf`) path.
// Representative of every sibling that ships through
// `maybeSendPortalDigestMuteConfirmations`. We don't repeat each test
// across all seven slugs because the helper is registry-driven and
// would be testing the registry shape rather than the behaviour;
// instead we cover wallet-refund here in depth, levy-ledger separately
// to prove independent watermarks per slug, and a multi-slug PATCH to
// prove per-slug isolation.
// =====================================================================

describe("Task #2219 — PATCH /portal/notification-preferences mute confirmation (wallet-refund)", () => {
  it("emits a confirmation when notifyWalletRefundDigestFailed transitions true→false", async () => {
    const orgId = await makeOrg("wrf-mute");
    const userId = await makeController(orgId, "org_admin", `wrf-mute-${orgId}@example.com`, "Wallet Muter");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyWalletRefundDigestFailed: true, updatedAt: new Date() },
    });

    const res = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false });
    expect(res.status).toBe(200);
    expect(res.body.notifyWalletRefundDigestFailed).toBe(false);

    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const arg = muteConfirmMock.mock.calls[0][0];
    expect(arg.to).toBe(`wrf-mute-${orgId}@example.com`);
    expect(arg.digest.subject).toBe(PORTAL_DIGEST_MUTE_REGISTRY.wrf.subject);
    expect(arg.digest.headlineHtml).toBe(PORTAL_DIGEST_MUTE_REGISTRY.wrf.headlineHtml);
    // Revert URL must point at the new public handler and carry a
    // token that decodes to (userId, slug='wrf') — that's the contract
    // the public handler uses to know which prefs column to flip.
    expect(arg.revertUrl).toMatch(/\/api\/public\/portal-digest-mute-revert\?token=/);
    const tokenInUrl = new URL(arg.revertUrl).searchParams.get("token") ?? "";
    const decoded = verifyPortalDigestMuteRevertToken(tokenInUrl);
    expect(decoded?.userId).toBe(userId);
    expect(decoded?.slug).toBe("wrf");

    // Watermark stamps in the side table after a successful send.
    const [stamped] = await db.select({
      ts: portalDigestMuteConfirmationSendsTable.lastSentAt,
    })
      .from(portalDigestMuteConfirmationSendsTable)
      .where(and(
        eq(portalDigestMuteConfirmationSendsTable.userId, userId),
        eq(portalDigestMuteConfirmationSendsTable.digestSlug, "wrf"),
      ));
    expect(stamped?.ts).toBeInstanceOf(Date);
  });

  it("does not send a confirmation when the value did not transition true→false", async () => {
    const orgId = await makeOrg("wrf-no-trans");
    const userId = await makeController(orgId, "org_admin", `wrf-nt-${orgId}@example.com`, "No Trans");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    // Already muted before the PATCH.
    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyWalletRefundDigestFailed: false, updatedAt: new Date() },
    });

    // Re-PATCHing the same false value: nothing the controller just
    // decided to silence so no confirmation should fire.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);
    expect(muteConfirmMock).not.toHaveBeenCalled();

    // false→true (re-enable) must also not trigger the mute email.
    muteConfirmMock.mockReset();
    muteConfirmMock.mockResolvedValue(undefined);
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: true })
      .expect(200);
    expect(muteConfirmMock).not.toHaveBeenCalled();
  });

  it("rate-limits a quick toggle off→on→off so a controller is not spammed", async () => {
    const orgId = await makeOrg("wrf-rate");
    const userId = await makeController(orgId, "org_admin", `wrf-rate-${orgId}@example.com`, "Rate Limited");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyWalletRefundDigestFailed: true, updatedAt: new Date() },
    });

    // First mute: confirmation fires + watermark stamps.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    // Re-enable (false→true): no new confirmation.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: true })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    // Re-mute IMMEDIATELY (true→false again): suppressed by the rate
    // limit because the watermark is fresh. The mute itself still
    // applied (we assert the row's flag below).
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    const [pref] = await db.select({
      flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);

    // Backdate the watermark beyond the throttle window and PATCH a
    // fresh re-mute (we re-enable + re-mute) to prove the gate opens
    // again once the window has elapsed.
    const oldEnough = new Date(Date.now() - ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS - 60_000);
    await db.update(portalDigestMuteConfirmationSendsTable)
      .set({ lastSentAt: oldEnough })
      .where(and(
        eq(portalDigestMuteConfirmationSendsTable.userId, userId),
        eq(portalDigestMuteConfirmationSendsTable.digestSlug, "wrf"),
      ));
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: true })
      .expect(200);
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(2);
  });

  it("does not stamp the watermark when the mailer throws so a transient outage doesn't poison the next attempt", async () => {
    const orgId = await makeOrg("wrf-fail");
    const userId = await makeController(orgId, "org_admin", `wrf-fail-${orgId}@example.com`, "Mailer Fails");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyWalletRefundDigestFailed: true, updatedAt: new Date() },
    });

    muteConfirmMock.mockRejectedValueOnce(new Error("postmark down"));

    // PATCH still returns 200 — the toggle is the user's primary
    // intent and a downstream confirmation outage must not surface to
    // the portal UI as a save failure.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);

    const [pref] = await db.select({
      flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);

    const watermark = await db.select()
      .from(portalDigestMuteConfirmationSendsTable)
      .where(and(
        eq(portalDigestMuteConfirmationSendsTable.userId, userId),
        eq(portalDigestMuteConfirmationSendsTable.digestSlug, "wrf"),
      ));
    expect(watermark).toHaveLength(0);
  });
});

// =====================================================================
// Levy-ledger (`lld`) path — proves the registry's per-slug isolation:
// muting wallet-refund must NOT stamp the levy-ledger watermark, and
// vice versa. A bug here (e.g. a shared watermark column or a
// hard-coded slug somewhere in the helper) would let one slug
// silence another's future confirmations.
// =====================================================================

describe("Task #2219 — PATCH /portal/notification-preferences mute confirmation (levy-ledger)", () => {
  it("emits a confirmation when notifyLevyLedgerDigestFailed transitions true→false with the levy-ledger registry copy", async () => {
    const orgId = await makeOrg("lld-mute");
    const userId = await makeController(orgId, "treasurer", `lld-mute-${orgId}@example.com`, "Ledger Muter");
    const app = createTestApp({ id: userId, username: "u", role: "treasurer", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyLevyLedgerDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyLevyLedgerDigestFailed: true, updatedAt: new Date() },
    });

    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerDigestFailed: false })
      .expect(200);

    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const arg = muteConfirmMock.mock.calls[0][0];
    expect(arg.digest.subject).toBe(PORTAL_DIGEST_MUTE_REGISTRY.lld.subject);
    expect(arg.digest.digestNameHtml).toBe(PORTAL_DIGEST_MUTE_REGISTRY.lld.digestNameHtml);
    const decoded = verifyPortalDigestMuteRevertToken(
      new URL(arg.revertUrl).searchParams.get("token") ?? "",
    );
    expect(decoded?.slug).toBe("lld");
  });

  it("muting wallet-refund leaves the levy-ledger watermark untouched (per-slug isolation)", async () => {
    const orgId = await makeOrg("isolation");
    const userId = await makeController(orgId, "org_admin", `iso-${orgId}@example.com`, "Iso Muter");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: true,
      notifyLevyLedgerDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyWalletRefundDigestFailed: true,
        notifyLevyLedgerDigestFailed: true,
        updatedAt: new Date(),
      },
    });

    // Mute wallet-refund only.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false })
      .expect(200);

    const rows = await db.select({
      slug: portalDigestMuteConfirmationSendsTable.digestSlug,
    })
      .from(portalDigestMuteConfirmationSendsTable)
      .where(eq(portalDigestMuteConfirmationSendsTable.userId, userId));
    const slugsStamped = new Set(rows.map(r => r.slug));
    expect(slugsStamped.has("wrf")).toBe(true);
    expect(slugsStamped.has("lld")).toBe(false); // untouched — that's the contract

    // And a subsequent levy-ledger mute still fires (its own watermark
    // is fresh, but wallet-refund's watermark must not gate it).
    muteConfirmMock.mockReset();
    muteConfirmMock.mockResolvedValue(undefined);
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerDigestFailed: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const decoded = verifyPortalDigestMuteRevertToken(
      new URL(muteConfirmMock.mock.calls[0][0].revertUrl).searchParams.get("token") ?? "",
    );
    expect(decoded?.slug).toBe("lld");
  });

  it("emits two independent confirmations when wallet-refund and levy-ledger are muted in the same PATCH", async () => {
    const orgId = await makeOrg("multi");
    const userId = await makeController(orgId, "org_admin", `multi-${orgId}@example.com`, "Multi Muter");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: true,
      notifyLevyLedgerDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyWalletRefundDigestFailed: true,
        notifyLevyLedgerDigestFailed: true,
        updatedAt: new Date(),
      },
    });

    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({
        notifyWalletRefundDigestFailed: false,
        notifyLevyLedgerDigestFailed: false,
      })
      .expect(200);

    // Two independent emails, one per slug — the recipient sees
    // exactly which alert moved and each carries its own revert link
    // back to the correct prefs column.
    expect(muteConfirmMock).toHaveBeenCalledTimes(2);
    const slugs = muteConfirmMock.mock.calls.map(([arg]) =>
      verifyPortalDigestMuteRevertToken(
        new URL(arg.revertUrl).searchParams.get("token") ?? "",
      )?.slug,
    );
    expect(new Set(slugs)).toEqual(new Set(["wrf", "lld"]));
  });
});

// =====================================================================
// HMAC token + 7-day TTL — same guarantees as the erasure `emr1:`
// token but with the new `pdr1:` prefix so a leaked sibling-digest
// link cannot be replayed against the erasure revert endpoint and vice
// versa.
// =====================================================================

describe("Task #2219 — signPortalDigestMuteRevertToken HMAC + TTL", () => {
  it("round-trips the (userId, orgId, slug) payload and rejects tampering / wrong prefix", () => {
    for (const slug of ["wrf", "lld", "sad"]) {
      const tok = signPortalDigestMuteRevertToken(123, 456, slug);
      const parsed = verifyPortalDigestMuteRevertToken(tok);
      expect(parsed?.userId).toBe(123);
      expect(parsed?.orgId).toBe(456);
      expect(parsed?.slug).toBe(slug);
      // Tamper INSIDE the payload (appending is not a real signal —
      // base64url decoding silently drops trailing junk).
      const tampered = tok.slice(0, 6) + (tok[6] === "A" ? "B" : "A") + tok.slice(7);
      expect(verifyPortalDigestMuteRevertToken(tampered)).toBeNull();
    }
    // A token signed with the erasure revert prefix (`emr1:`) must NOT
    // be accepted by the sibling-digest revert verifier — otherwise a
    // leaked erasure link could be replayed against this endpoint to
    // flip an unrelated sibling digest.
    const erasureToken = signErasureDigestMuteRevertToken(123, 456, "b");
    expect(verifyPortalDigestMuteRevertToken(erasureToken)).toBeNull();
  });

  it("rejects tokens older than the 7-day TTL", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const stale = signPortalDigestMuteRevertToken(1, 2, "wrf", eightDaysAgo);
    expect(verifyPortalDigestMuteRevertToken(stale)).toBeNull();
    // Same token with the TTL check disabled still parses — confirms
    // the rejection above was the freshness gate, not a signature
    // failure.
    expect(verifyPortalDigestMuteRevertToken(stale, { ttlSeconds: 0 })?.userId).toBe(1);
    // The exposed TTL constant matches the spec (7 days exactly).
    expect(PORTAL_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("rejects unknown / malformed slugs at sign time and at verify time", () => {
    expect(() => signPortalDigestMuteRevertToken(1, 2, "TOO-LONG-SLUG")).toThrow();
    expect(() => signPortalDigestMuteRevertToken(1, 2, "UPPER")).toThrow();
    expect(() => signPortalDigestMuteRevertToken(1, 2, "")).toThrow();
    // A garbage token (no payload at all) verifies as null.
    expect(verifyPortalDigestMuteRevertToken("not-a-real-token")).toBeNull();
  });
});

// =====================================================================
// /api/public/portal-digest-mute-revert — flips the prefs column
// referenced by the token's slug back to true. Independent of the
// erasure revert endpoint by token prefix.
// =====================================================================

describe("Task #2219 — /api/public/portal-digest-mute-revert handler", () => {
  it("flips notifyWalletRefundDigestFailed back to true on GET (link click)", async () => {
    const orgId = await makeOrg("revert-wrf");
    const userId = await makeUser({ email: `revert-wrf-${orgId}@example.com`, displayName: "Revert WRF" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    // Pre-condition: muted before the click. Other sibling columns
    // stay at their schema default (true) so we can prove the revert
    // handler only touches the slug's column.
    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyWalletRefundDigestFailed: false,
      notifyLevyLedgerDigestFailed: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyWalletRefundDigestFailed: false,
        notifyLevyLedgerDigestFailed: true,
        updatedAt: new Date(),
      },
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signPortalDigestMuteRevertToken(userId, orgId, "wrf");
    const res = await request(app)
      .get(`/api/public/portal-digest-mute-revert?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/re-?enabled/i);

    const [pref] = await db.select({
      wrf: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
      lld: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.wrf).toBe(true);
    expect(pref?.lld).toBe(true); // untouched — that's the contract
  });

  it("flips notifyLevyLedgerDigestFailed back to true on POST (RFC 8058 one-click)", async () => {
    const orgId = await makeOrg("revert-lld");
    const userId = await makeUser({ email: `revert-lld-${orgId}@example.com`, displayName: "Revert LLD" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "treasurer" });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyLevyLedgerDigestFailed: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyLevyLedgerDigestFailed: false, updatedAt: new Date() },
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signPortalDigestMuteRevertToken(userId, orgId, "lld");
    await request(app)
      .post(`/api/public/portal-digest-mute-revert`)
      .type("form")
      .send({ "List-Unsubscribe": "One-Click", token })
      .expect(200);

    const [pref] = await db.select({
      lld: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.lld).toBe(true);
  });

  it("rejects a malformed token with the 400 confirmation page", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const res = await request(app)
      .get(`/api/public/portal-digest-mute-revert?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid revert link/i);
  });

  it("rejects a token with an unknown slug (forged or future slug) with the 400 page", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    // Sign a structurally valid token whose slug isn't in the
    // registry. This simulates a forged link or a token issued before
    // a registry rename.
    const token = signPortalDigestMuteRevertToken(1, 0, "zzz");
    const res = await request(app)
      .get(`/api/public/portal-digest-mute-revert?token=${encodeURIComponent(token)}`)
      .expect(400);
    expect(res.text).toMatch(/invalid revert link/i);
  });
});
