/**
 * Wave 3 (Task #938) — load-bearing endpoints.
 *
 *   POST /api/portal/2fa/totp/setup                — provision TOTP secret
 *   POST /api/portal/2fa/totp/verify               — confirm TOTP code
 *   GET  /api/portal/sessions                      — list active sessions
 *   DELETE /api/portal/sessions/:id                — revoke a session
 *   POST /api/portal/follows/:userId               — follow a user
 *   DELETE /api/portal/follows/:userId             — unfollow a user
 *   GET  /api/portal/my-upcoming                   — unified upcoming view
 *   GET  /api/portal/me/social-links               — list linked providers (Task #1225)
 *   POST /api/portal/me/social-links/:provider     — link a provider while logged in (Task #1225)
 *   DELETE /api/portal/me/social-links/:provider   — unlink a provider (Task #1225)
 *   GET  /api/organizations/:orgId/theming             — get club theme
 *   PUT  /api/organizations/:orgId/theming             — set club theme (admin)
 *   POST /api/organizations/:orgId/theming/upload-url  — presigned URL for logo/favicon (admin)
 *   POST /api/organizations/:orgId/theming/images      — register uploaded logo/favicon (admin)
 *   GET  /api/organizations/:orgId/benchmarks          — peer-club percentile
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "crypto";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  db,
  userTotpSecretsTable,
  userActiveSessionsTable,
  userFollowsTable,
  userInboxNotificationsTable,
  appUsersTable,
  appUserSocialLinksTable,
  clubThemingTable,
  teeBookingsTable,
  courseTeeSlotTable,
  lessonBookingsTable,
  rangeBookingTable,
  fbOrdersTable,
  rentalBookingsTable,
  walletTopupRequestsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { requireOrgAdmin } from "../lib/permissions";
import { generateBase32Secret, otpauthUrl, verifyTotp } from "../lib/totp.js";
import { encrypt, decrypt, isEncrypted, encryptionAvailable } from "../lib/crypto.js";
import { getClubTheme, invalidateClubThemeCache } from "../lib/clubTheming.js";
import { verifyGoogleIdToken, verifyAppleIdentityToken, recordSocialLink } from "./social-auth.js";
import { ObjectStorageService } from "../lib/objectStorage";
import { sendSocialLinkAddedSecurityEmail, sendSocialLinkRemovedSecurityEmail } from "../lib/mailer.js";
import { dispatchNotification } from "../lib/notifyDispatch.js";
import { logger } from "../lib/logger.js";

/**
 * TOTP secret at-rest protection.
 *
 * Secrets are AES-256-GCM encrypted via lib/crypto.ts (keyed by
 * ENCRYPTION_SECRET). The setup endpoint fails CLOSED with a 503 if
 * ENCRYPTION_SECRET is missing — matching lib/crypto.ts's no-insecure-
 * fallback posture. Reads transparently decrypt; legacy plaintext rows
 * (pre-encryption) are detected via the `enc:v1:` prefix and returned
 * as-is so a one-time backfill can re-encrypt them in place.
 */
function sealTotpSecret(plaintext: string): string {
  return encrypt(plaintext); // throws if ENCRYPTION_SECRET unset
}
function openTotpSecret(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored;
}
function requireEncryption(res: Response): boolean {
  if (encryptionAvailable()) return true;
  res.status(503).json({
    error: "encryption_unavailable",
    detail:
      "ENCRYPTION_SECRET is not configured on the server; refusing to " +
      "store TOTP secrets in plaintext. Set ENCRYPTION_SECRET and retry.",
  });
  return false;
}

const router: IRouter = Router();

// ─── Theming upload helpers (Task #1229) ───────────────────────────────────
const storage = new ObjectStorageService();
const ALLOWED_THEMING_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
]);
const MAX_THEMING_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
function getThemingUploadHmacSecret(): string {
  const secret = process.env["PRIVATE_OBJECT_DIR"];
  if (!secret) throw new Error("PRIVATE_OBJECT_DIR env var is required for theming upload token signing");
  return secret;
}
function signThemingUploadPath(objectPath: string, orgId: number): string {
  return createHmac("sha256", getThemingUploadHmacSecret())
    .update(`theming:${orgId}:${objectPath}`).digest("hex");
}
function verifyThemingUploadToken(objectPath: string, orgId: number, token: string): boolean {
  try { return signThemingUploadPath(objectPath, orgId) === token; } catch { return false; }
}
function publicThemingObjectUrl(objectPath: string, req?: Request): string {
  // Prefer explicit public-base env vars; fall back to the request's origin so
  // that mobile clients always receive an absolute URL even when env vars are
  // unset (relative URLs would render fine in a browser but break on mobile).
  let apiBase = (
    process.env.API_PUBLIC_URL
    ?? process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
  if (!apiBase && req) {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = (req.headers["x-forwarded-host"] as string | undefined)
      ?? (req.headers["host"] as string | undefined)
      ?? "localhost";
    apiBase = `${proto}://${host}`;
  }
  return `${apiBase}/api/storage${objectPath}`;
}

function requireAuth(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}
function uid(req: Request): number {
  return Number((req.user as { id?: number } | undefined)?.id ?? 0);
}

// ─── W3-A: TOTP 2FA ────────────────────────────────────────────────────────
router.post("/portal/2fa/totp/setup", async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireEncryption(res)) return;
  const userId = uid(req);
  // If 2FA is already confirmed, require a current valid code from the
  // existing device before letting the caller rotate the secret. This
  // prevents a session-hijack attacker from silently disabling the victim's
  // 2FA by just provisioning a fresh secret.
  const [existing] = await db.select().from(userTotpSecretsTable)
    .where(eq(userTotpSecretsTable.userId, userId)).limit(1);
  if (existing?.confirmedAt) {
    const currentCode = String((req.body as { currentCode?: string } | undefined)?.currentCode ?? "").trim();
    if (!verifyTotp(openTotpSecret(existing.secretEnc), currentCode)) {
      res.status(403).json({ error: "current_code_required" });
      return;
    }
  }
  const secret = generateBase32Secret();
  const sealed = sealTotpSecret(secret);
  await db.insert(userTotpSecretsTable)
    .values({ userId, secretEnc: sealed })
    .onConflictDoUpdate({
      target: userTotpSecretsTable.userId,
      set: { secretEnc: sealed, confirmedAt: null },
    });
  const [user] = await db.select({ email: appUsersTable.email, username: appUsersTable.username })
    .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
  const account = user?.email || user?.username || `user-${userId}`;
  res.json({ secret, otpauthUrl: otpauthUrl({ issuer: "KHARAGOLF", account, secret }) });
});

router.post("/portal/2fa/totp/verify", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const code = String((req.body as { code?: string } | undefined)?.code ?? "").trim();
  const [row] = await db.select().from(userTotpSecretsTable)
    .where(eq(userTotpSecretsTable.userId, userId)).limit(1);
  if (!row) { { res.status(404).json({ error: "no_secret" }); return; } }
  if (!verifyTotp(openTotpSecret(row.secretEnc), code)) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  await db.update(userTotpSecretsTable)
    .set({ confirmedAt: new Date(), lastUsedAt: new Date() })
    .where(eq(userTotpSecretsTable.userId, userId));
  res.json({ ok: true, confirmed: true });
});

// ─── W3-A: Active sessions ─────────────────────────────────────────────────
router.get("/portal/sessions", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const rows = await db.select({
    id: userActiveSessionsTable.id,
    deviceLabel: userActiveSessionsTable.deviceLabel,
    ip: userActiveSessionsTable.ip,
    userAgent: userActiveSessionsTable.userAgent,
    lastSeenAt: userActiveSessionsTable.lastSeenAt,
    createdAt: userActiveSessionsTable.createdAt,
    revokedAt: userActiveSessionsTable.revokedAt,
  }).from(userActiveSessionsTable)
    .where(eq(userActiveSessionsTable.userId, userId))
    .orderBy(desc(userActiveSessionsTable.lastSeenAt))
    .limit(50);
  res.json({ sessions: rows });
});

router.delete("/portal/sessions/:id", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "bad_id" }); return; } }
  const updated = await db.update(userActiveSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(userActiveSessionsTable.id, id), eq(userActiveSessionsTable.userId, userId)))
    .returning({ id: userActiveSessionsTable.id });
  if (updated.length === 0) { { res.status(404).json({ error: "not_found" }); return; } }
  res.json({ ok: true });
});

// ─── W3-F: Social graph ────────────────────────────────────────────────────
router.post("/portal/follows/:userId", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const followerId = uid(req);
  const followeeId = Number((req.params as Record<string, string>).userId);
  if (!Number.isFinite(followeeId) || followeeId === followerId) {
    res.status(400).json({ error: "bad_target" }); return;
  }
  const [target] = await db.select({ id: appUsersTable.id }).from(appUsersTable)
    .where(eq(appUsersTable.id, followeeId)).limit(1);
  if (!target) { { res.status(404).json({ error: "user_not_found" }); return; } }
  // Task #1739 — only notify on a *new* follow. `onConflictDoNothing()`
  // returns the inserted rows when something was inserted, and an empty
  // array when the (followerId, followeeId) pair already existed. Without
  // this guard a "follow" tap that's already a follow would re-dispatch
  // the "started following you" push every time, spamming the followee.
  const inserted = await db.insert(userFollowsTable)
    .values({ followerId, followeeId })
    .onConflictDoNothing()
    .returning({ followerId: userFollowsTable.followerId });
  if (inserted.length > 0) {
    // Look up the follower's display name so the push body reads as
    // "Alice started following you" rather than "Someone started…".
    const [follower] = await db.select({
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(appUsersTable).where(eq(appUsersTable.id, followerId)).limit(1);
    const followerName = follower?.displayName?.trim()
      || follower?.username?.trim()
      || "Someone";
    // The followee's notification preferences (preferPush, digestMode,
    // and the per-key delivery override registered for `social.follow.new`
    // via the `/portal/notification-key-prefs` API) are honoured by
    // `dispatchNotification`. Task #2160 — the mobile push-tap router
    // reads `followerId` from the data payload and deep-links straight
    // to the follower's public profile (via the /member/[userId]
    // resolver), falling back to /my-follows when the id is missing or
    // unusable. The `url` field is kept as a safety-net mirror for any
    // older client/web inbox that still routes by `data.url`.
    const title = "New follower";
    const body = `${followerName} started following you`;
    dispatchNotification("social.follow.new", [followeeId], {
      title,
      body,
      data: {
        type: "social_follow_new",
        followerId,
        followerName,
        url: "/my-follows",
      },
    }).catch((err: unknown) => {
      logger.warn({ followerId, followeeId, err }, "[follows] notify dispatch failed");
    });
    // Task #2159 — Persist the same notification to the generic in-app
    // inbox so web users (who may have no push registration on their
    // browser) see "Alice started following you" in the header bell /
    // /notifications page like mobile users do. Independent of the
    // push/email/digest channels above: those are delivery surfaces,
    // the inbox is a permanent record. `deepLink` is `/my-follows` —
    // the web app currently has no per-user public profile route, and
    // `/my-follows` is the same target the mobile push tap routes to,
    // matching the task description's "click-through to the follower's
    // profile or /my-follows".
    db.insert(userInboxNotificationsTable).values({
      userId: followeeId,
      notificationKey: "social.follow.new",
      title,
      body,
      payload: {
        followerId,
        followerName,
        deepLink: "/my-follows",
      },
    }).catch((err: unknown) => {
      logger.warn({ followerId, followeeId, err }, "[follows] inbox insert failed");
    });
  }
  res.json({ ok: true });
});

router.delete("/portal/follows/:userId", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const followerId = uid(req);
  const followeeId = Number((req.params as Record<string, string>).userId);
  if (!Number.isFinite(followeeId)) { { res.status(400).json({ error: "bad_target" }); return; } }
  await db.delete(userFollowsTable)
    .where(and(eq(userFollowsTable.followerId, followerId), eq(userFollowsTable.followeeId, followeeId)));
  res.json({ ok: true });
});

// ─── Task #1225: linked social providers ───────────────────────────────────
//
// Apple/Google sign-in records a row in `app_user_social_links` on every
// successful login (see routes/social-auth.ts). The portal account screen
// reads the list here and may delete one — provided the player still has
// another way to sign in (a password set, another linked provider, or a
// real Replit OAuth identity), so unlink can never lock anyone out.

const SOCIAL_LINK_PROVIDERS = ["apple", "google"] as const;
type SocialLinkProvider = (typeof SOCIAL_LINK_PROVIDERS)[number];

function isSocialLinkProvider(v: string): v is SocialLinkProvider {
  return (SOCIAL_LINK_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Best-effort heuristic: does this `replit_user_id` look like a genuine
 * Replit OAuth identity (rather than an auto-generated placeholder)?
 *
 * Account-creation and unlink paths stamp recognisable prefixes:
 *   - `ep_…`        — local email/password registration
 *   - `google_…`    — Google sign-in created the row (provider id baked in)
 *   - `apple_…`     — Apple sign-in created the row (provider id baked in)
 *   - `unlinked_…`  — written by the unlink endpoint below to neutralise
 *                     a legacy `<provider>_<sub>` stamp so a subsequent
 *                     sign-in cannot resurrect the link via the legacy
 *                     fallback path in routes/social-auth.ts.
 *
 * Genuine Replit OIDC subjects don't carry any of these prefixes, so an
 * id that fails every prefix check is treated as a real Replit OAuth
 * identity (i.e. an additional way to sign in, so unlinking a social
 * provider is safe even with no password set).
 *
 * IMPORTANT — keep `unlinked_` in this list. Without it, the lockout
 * guard would mistake the placeholder we just wrote for a real OAuth id
 * and let the player chain-unlink themselves out of every remaining
 * sign-in method. There's a regression test pinning that two-step flow
 * in `tests/portal-social-links.test.ts`.
 */
function hasReplitOauthIdentity(replitUserId: string): boolean {
  return !replitUserId.startsWith("ep_")
    && !replitUserId.startsWith("google_")
    && !replitUserId.startsWith("apple_")
    && !replitUserId.startsWith("unlinked_");
}

/**
 * Legacy compatibility — pre-migration social sign-ins only ever stamped
 * `<provider>_<sub>` into `app_users.replit_user_id`; they never created an
 * `app_user_social_links` row. We must surface that legacy linkage in the
 * portal so a player can unlink a stale Apple/Google account WITHOUT first
 * having to sign in via that provider again to backfill the row (which
 * they may not be able to do — that's the whole reason they want to
 * unlink). Returns `null` when the column doesn't look like a legacy
 * provider stamp.
 */
function legacyProviderFromReplitId(replitUserId: string): SocialLinkProvider | null {
  if (replitUserId.startsWith("apple_")) return "apple";
  if (replitUserId.startsWith("google_")) return "google";
  return null;
}

/**
 * Merge real `app_user_social_links` rows with the synthetic legacy link
 * derived from `replit_user_id`. We never duplicate: a real link row for
 * the same provider always wins over the legacy synthetic one.
 */
function mergeLinks(
  rows: Array<{ provider: SocialLinkProvider; linkedAt: Date; lastUsedAt: Date }>,
  replitUserId: string,
): Array<{ provider: SocialLinkProvider; linkedAt: string; lastUsedAt: string; legacy: boolean }> {
  const out = rows.map(r => ({
    provider: r.provider,
    linkedAt: r.linkedAt.toISOString(),
    lastUsedAt: r.lastUsedAt.toISOString(),
    legacy: false,
  }));
  const legacyProvider = legacyProviderFromReplitId(replitUserId);
  if (legacyProvider && !out.some(l => l.provider === legacyProvider)) {
    // No real row → surface the legacy stamp so the UI lists it and the
    // unlink button can target it. Dates are unknown for legacy links;
    // use the epoch so the UI can render "—" or "before tracking began".
    out.push({
      provider: legacyProvider,
      linkedAt: new Date(0).toISOString(),
      lastUsedAt: new Date(0).toISOString(),
      legacy: true,
    });
  }
  return out;
}

router.get("/portal/me/social-links", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const [user] = await db.select({
    passwordHash: appUsersTable.passwordHash,
    replitUserId: appUsersTable.replitUserId,
  }).from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
  if (!user) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const rows = await db.select({
    provider: appUserSocialLinksTable.provider,
    linkedAt: appUserSocialLinksTable.linkedAt,
    lastUsedAt: appUserSocialLinksTable.lastUsedAt,
  }).from(appUserSocialLinksTable)
    .where(eq(appUserSocialLinksTable.userId, userId))
    .orderBy(appUserSocialLinksTable.linkedAt);

  res.json({
    hasPassword: Boolean(user.passwordHash),
    hasReplitOauth: hasReplitOauthIdentity(user.replitUserId),
    links: mergeLinks(rows, user.replitUserId),
  });
});

router.post("/portal/me/social-links/:provider", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const provider = String((req.params as Record<string, string>).provider ?? "").toLowerCase();
  if (!isSocialLinkProvider(provider)) {
    // Task #1735: every error from this route ships a `detail` alongside
    // the stable `error` code so the UI never has to invent fallback copy.
    res.status(400).json({
      error: "unknown_provider",
      detail: "Only Apple and Google can be linked to a KHARAGOLF account.",
    });
    return;
  }

  // Verify the provider-issued token presented by the logged-in player and
  // pin the link to THIS user — never to whoever the token's email maps
  // to. That prevents an attacker from attaching their own session to a
  // victim's Apple/Google account by replaying its idToken.
  //
  // Error contract (Task #1735): every failure responds with a stable
  // `error` code (and a human-readable `detail`) so the web/mobile portal
  // Privacy screens can map the code to actionable copy instead of falling
  // back to a generic "Could not link". Codes:
  //   token_required           400  client never delivered the token field
  //   token_invalid            401  provider rejected the token (expired, audience mismatch, ...)
  //   email_not_verified       401  Google says the email isn't verified yet
  //   provider_not_configured  503  server is missing the Google/Apple client IDs
  //   provider_already_linked  409  this provider sub is already attached to a different KHARAGOLF user
  //   unknown_provider         400  :provider is not "google" or "apple"
  const body = (req.body ?? {}) as { idToken?: unknown; identityToken?: unknown };
  const providerLabel = provider === "apple" ? "Apple" : "Google";
  const tokenField = provider === "apple" ? "identityToken" : "idToken";
  let providerSub: string;
  try {
    if (provider === "google") {
      const idToken = body.idToken;
      if (typeof idToken !== "string" || !idToken) {
        res.status(400).json({
          error: "token_required",
          detail: `Google did not return an ${tokenField}. Please try linking again.`,
        });
        return;
      }
      const claims = await verifyGoogleIdToken(idToken);
      if (!claims.emailVerified) {
        res.status(401).json({
          error: "email_not_verified",
          detail: "Your Google email isn't verified yet. Verify it with Google, then try linking again.",
        });
        return;
      }
      providerSub = claims.sub;
    } else {
      const identityToken = body.identityToken;
      if (typeof identityToken !== "string" || !identityToken) {
        res.status(400).json({
          error: "token_required",
          detail: `Apple did not return an ${tokenField}. Try again and choose "Share My Email" when prompted.`,
        });
        return;
      }
      const claims = await verifyAppleIdentityToken(identityToken);
      providerSub = claims.sub;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "verify_failed";
    if (msg === "google_not_configured" || msg === "apple_not_configured") {
      res.status(503).json({
        error: "provider_not_configured",
        detail: `${providerLabel} sign-in isn't set up on this server. Please contact KHARAGOLF support.`,
      });
      return;
    }
    req.log?.warn({ err }, `${provider} link token verification failed`);
    res.status(401).json({
      error: "token_invalid",
      detail: `We couldn't verify your ${providerLabel} sign-in. The token may have expired — please try again.`,
    });
    return;
  }

  try {
    await recordSocialLink({ userId, provider, providerSub });
  } catch (err) {
    if (err instanceof Error && err.message === "provider_already_linked") {
      res.status(409).json({
        error: "provider_already_linked",
        detail: `This ${provider === "apple" ? "Apple ID" : "Google account"} is already linked to a different KHARAGOLF account.`,
      });
      return;
    }
    throw err;
  }

  // Task #1736 — out-of-band security alert. If a session was hijacked, the
  // attacker can silently attach their own Apple/Google to the victim's
  // profile here; the heads-up email gives the genuine owner a chance to
  // notice and unlink before the attacker uses it to sign in later. Best
  // effort — never let a mailer hiccup turn the link into a 500.
  //
  // Task #2150 — gate the email on the new per-event opt-out
  // `notify_social_link_added` (default true) so a power user who
  // links/unlinks providers frequently can mute just this notice
  // without flipping the umbrella `privacy` comm-prefs category.
  // Schema default is true, so a missing prefs row reads as
  // "opted-in" and the alert still ships unless the player has
  // explicitly turned it off. We bypass the broader `privacy`
  // category opt-out on purpose (Task #1736) because a hijacker
  // could otherwise pre-mute the alert by flipping the umbrella
  // category before attaching their own provider; this single-purpose
  // flag isn't surfaced anywhere else, so silencing it requires the
  // genuine owner's intent.
  try {
    const [user] = await db.select({
      email: appUsersTable.email,
      emailVerified: appUsersTable.emailVerified,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
    const [prefs] = await db.select({
      notifySocialLinkAdded: userNotificationPrefsTable.notifySocialLinkAdded,
    }).from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId))
      .limit(1);
    const optedIn = prefs?.notifySocialLinkAdded ?? true;
    if (user?.email && user.emailVerified && optedIn) {
      const ipAddress = (req.ip
        ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? null) || null;
      const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
      // SECURITY: never derive the privacy-page link from request headers
      // (x-forwarded-host / Host can be spoofed by a hijacker calling
      // through a controlled proxy, which would land the alert recipient
      // on attacker-controlled HTML). Use a server-side trusted origin
      // chain only — APP_BASE_URL → REPLIT_DEV_DOMAIN (dev) → the canonical
      // production host as the last-resort constant.
      const baseUrl = (
        process.env.APP_BASE_URL
        ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
      ).replace(/\/$/, "") || "https://kharagolf.com";
      await sendSocialLinkAddedSecurityEmail({
        to: user.email,
        recipientName: user.displayName || user.username || "there",
        provider,
        linkedAt: new Date(),
        ipAddress,
        userAgent,
        privacyUrl: `${baseUrl}/portal/privacy`,
      });
    }
  } catch (err) {
    req.log?.warn({ err, userId, provider }, "social-link security email failed to send");
  }

  res.json({ ok: true });
});

router.delete("/portal/me/social-links/:provider", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const provider = String((req.params as Record<string, string>).provider ?? "").toLowerCase();
  if (!isSocialLinkProvider(provider)) {
    res.status(400).json({
      error: "unknown_provider",
      detail: "Only Apple and Google can be unlinked from a KHARAGOLF account.",
    });
    return;
  }

  const [user] = await db.select({
    passwordHash: appUsersTable.passwordHash,
    replitUserId: appUsersTable.replitUserId,
    email: appUsersTable.email,
    emailVerified: appUsersTable.emailVerified,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
  }).from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
  if (!user) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const allLinks = await db.select({
    provider: appUserSocialLinksTable.provider,
  }).from(appUserSocialLinksTable)
    .where(eq(appUserSocialLinksTable.userId, userId));
  const targetRow = allLinks.find((l) => l.provider === provider);
  // Legacy fallback: even with no row, if `replit_user_id` is the
  // `<provider>_<sub>` stamp from this provider then the link DOES exist
  // (just untracked). Allow unlink in that case so legacy users aren't
  // stuck.
  const isLegacyLink = !targetRow && user.replitUserId.startsWith(`${provider}_`);
  if (!targetRow && !isLegacyLink) {
    res.status(404).json({ error: "not_linked" });
    return;
  }

  // Lock-out guard: refuse to remove the player's only remaining sign-in
  // method. They must keep at least one of: password, Replit OAuth, or
  // another social provider link (real row OR legacy stamp).
  const hasPassword = Boolean(user.passwordHash);
  const hasReplitOauth = hasReplitOauthIdentity(user.replitUserId);
  const otherProviders = new Set(
    allLinks.filter((l) => l.provider !== provider).map((l) => l.provider),
  );
  // The synthetic legacy link counts as an "other" sign-in method when
  // it's for a DIFFERENT provider than the one being unlinked AND it's
  // not already represented by a real row. Without this, GET surfaces
  // it (so the UI thinks the player has two ways in) but DELETE refuses
  // — a contradiction the reviewer caught.
  const legacyProvider = legacyProviderFromReplitId(user.replitUserId);
  if (legacyProvider && legacyProvider !== provider) {
    otherProviders.add(legacyProvider);
  }
  if (!hasPassword && !hasReplitOauth && otherProviders.size === 0) {
    res.status(409).json({
      error: "last_login_method",
      detail:
        "This is your only way to sign in. Set a password or link another provider before removing this one.",
    });
    return;
  }

  if (targetRow) {
    await db.delete(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.userId, userId),
        eq(appUserSocialLinksTable.provider, provider),
      ));
  }

  // If the user's `replit_user_id` is still the legacy "<provider>_<sub>"
  // baked from this very provider, repeat sign-ins from that provider would
  // re-resolve the row even after the link row is gone. Rewrite it to a
  // local placeholder so the unlink genuinely takes effect on the next
  // sign-in (the existing email-fallback path will refuse to re-link unless
  // the email still matches, which is the desired behaviour).
  if (user.replitUserId.startsWith(`${provider}_`)) {
    await db.update(appUsersTable)
      .set({
        replitUserId: `unlinked_${provider}_${userId}_${Date.now()}`,
        updatedAt: new Date(),
      })
      .where(eq(appUsersTable.id, userId));
  }

  // Task #2149 — symmetric security alert: an attacker inside the session
  // can silently *unlink* the genuine owner's Apple/Google to cut off the
  // recovery path. The heads-up email lets the real owner notice and
  // re-link before they're locked out. Best effort — never let a mailer
  // hiccup turn a successful unlink into a 500.
  try {
    if (user.email && user.emailVerified) {
      const ipAddress = (req.ip
        ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? null) || null;
      const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
      // SECURITY: derive the privacy-page link from a server-side trusted
      // origin only. See the matching note on the link path above — a
      // hijacker controlling a proxy could spoof Host / X-Forwarded-Host
      // and land the alert recipient on attacker-controlled HTML.
      const baseUrl = (
        process.env.APP_BASE_URL
        ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
      ).replace(/\/$/, "") || "https://kharagolf.com";
      await sendSocialLinkRemovedSecurityEmail({
        to: user.email,
        recipientName: user.displayName || user.username || "there",
        provider,
        unlinkedAt: new Date(),
        ipAddress,
        userAgent,
        privacyUrl: `${baseUrl}/portal/privacy`,
      });
    }
  } catch (err) {
    req.log?.warn({ err, userId, provider }, "social-link removal security email failed to send");
  }

  res.json({ ok: true });
});

// ─── W3-J: Unified "my upcoming" ───────────────────────────────────────────
type UpcomingKind = "tee" | "lesson" | "range" | "fb" | "rental" | "wallet_topup";
interface UpcomingItem {
  kind: UpcomingKind;
  id: number;
  organizationId: number | null;
  startsAt: Date;
}

// How far back to surface auto-refunded wallet top-ups in the unified
// upcoming list. Matches the cron's lookback window in
// routes/side-games-v2.ts (`refundOrphanedWalletTopups`) so the home
// widget shows every refund the cron could still have produced, plus a
// little headroom for slow notify retries.
const WALLET_TOPUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

router.get("/portal/my-upcoming", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = uid(req);
  const now = new Date();
  // Range bookings (slot_date) and rental bookings (rental_date) are stored at
  // midnight of the booking day. Comparing against `now` would exclude rows
  // for "today" once the clock is past midnight, so we widen the cutoff to
  // start-of-today for those two readers. Tee times and lessons keep precise
  // `now` semantics because they're stored with hour/minute granularity.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // Wallet top-ups don't have a future startsAt — surface every request
  // the member has in flight (awaiting verification, awaiting refund) plus
  // any that recently auto-refunded so they see "refund issued" before
  // tabbing over to /wallet-topup-refunds. The reader keys off the new
  // `wallet_topup_requests` table written by /wallet/topup-order →
  // creditWalletTopupFromPayment / refundOrphanedWalletTopups (Task #1423,
  // building on the Task #769 / #1072 reconciliation flow). `credited`
  // rows are excluded — once the wallet balance is updated there's nothing
  // for the member to act on.
  const walletTopupCutoff = new Date(now.getTime() - WALLET_TOPUP_LOOKBACK_MS);

  // Each reader returns at most 20 rows scoped to the current user, filtering
  // out cancelled/completed entries so the home widget surfaces only items the
  // member can still act on.
  const [teeRows, lessonRows, rangeRows, fbRows, rentalRows, walletTopupRows] = await Promise.all([
    db.select({
      id: teeBookingsTable.id,
      startsAt: courseTeeSlotTable.slotDate,
      organizationId: teeBookingsTable.organizationId,
    }).from(teeBookingsTable)
      .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
      .where(and(
        eq(teeBookingsTable.leadUserId, userId),
        gte(courseTeeSlotTable.slotDate, now),
        inArray(teeBookingsTable.status, ["pending", "confirmed"]),
      ))
      .orderBy(courseTeeSlotTable.slotDate)
      .limit(20),
    db.select({
      id: lessonBookingsTable.id,
      startsAt: lessonBookingsTable.scheduledAt,
      organizationId: lessonBookingsTable.organizationId,
    }).from(lessonBookingsTable)
      .where(and(
        eq(lessonBookingsTable.userId, userId),
        gte(lessonBookingsTable.scheduledAt, now),
        inArray(lessonBookingsTable.status, ["pending", "confirmed"]),
      ))
      .orderBy(lessonBookingsTable.scheduledAt)
      .limit(20),
    db.select({
      id: rangeBookingTable.id,
      startsAt: rangeBookingTable.slotDate,
      organizationId: rangeBookingTable.organizationId,
    }).from(rangeBookingTable)
      .where(and(
        eq(rangeBookingTable.userId, userId),
        gte(rangeBookingTable.slotDate, startOfToday),
        eq(rangeBookingTable.status, "confirmed"),
      ))
      .orderBy(rangeBookingTable.slotDate)
      .limit(20),
    // F&B orders don't have a future "starts at" — show in-flight orders the
    // member placed (received / preparing / ready), keyed off createdAt. Capped
    // at 5 so a backlog of takeaway orders can't crowd out future bookings in
    // the merged list.
    db.select({
      id: fbOrdersTable.id,
      startsAt: fbOrdersTable.createdAt,
      organizationId: fbOrdersTable.organizationId,
    }).from(fbOrdersTable)
      .where(and(
        eq(fbOrdersTable.userId, userId),
        inArray(fbOrdersTable.status, ["received", "preparing", "ready"]),
      ))
      .orderBy(desc(fbOrdersTable.createdAt))
      .limit(5),
    // Rentals: include reservations the user has booked that are still active
    // (reserved / checked_out). Future rentalDate (date-only, hence start-of-
    // today) or anything currently checked out.
    db.select({
      id: rentalBookingsTable.id,
      startsAt: rentalBookingsTable.rentalDate,
      organizationId: rentalBookingsTable.organizationId,
    }).from(rentalBookingsTable)
      .where(and(
        eq(rentalBookingsTable.bookedByUserId, userId),
        inArray(rentalBookingsTable.status, ["reserved", "checked_out"]),
        or(
          gte(rentalBookingsTable.rentalDate, startOfToday),
          eq(rentalBookingsTable.status, "checked_out"),
        ),
      ))
      .orderBy(rentalBookingsTable.rentalDate)
      .limit(20),
    // Wallet top-up requests for this member that are still in flight
    // (`pending_verification`, `refund_pending`) or recently completed
    // their refund (`refunded`). `credited` is intentionally excluded —
    // once the wallet balance reflects the top-up there's nothing for
    // the member to act on. Capped at 10 to bound widget noise.
    db.select({
      id: walletTopupRequestsTable.id,
      startsAt: walletTopupRequestsTable.createdAt,
      organizationId: walletTopupRequestsTable.organizationId,
    }).from(walletTopupRequestsTable)
      .where(and(
        eq(walletTopupRequestsTable.userId, userId),
        inArray(walletTopupRequestsTable.status, [
          "pending_verification",
          "refund_pending",
          "refunded",
        ]),
        gte(walletTopupRequestsTable.createdAt, walletTopupCutoff),
      ))
      .orderBy(desc(walletTopupRequestsTable.createdAt))
      .limit(10),
  ]);

  // Scheduled categories are merged together and sorted ascending so the next
  // upcoming thing comes first. F&B (in-flight, in-the-past createdAt) and
  // wallet top-up refunds (already happened, but the member needs to know) are
  // kept separate and pinned ahead of scheduled rows — both are time-sensitive
  // — without polluting the ascending-by-startsAt sort or evicting future
  // bookings.
  const scheduled: UpcomingItem[] = [
    ...teeRows.map((r) => ({ kind: "tee" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt })),
    ...lessonRows.map((r) => ({ kind: "lesson" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt })),
    ...rangeRows.map((r) => ({ kind: "range" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt })),
    ...rentalRows.map((r) => ({ kind: "rental" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt })),
  ];
  scheduled.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const fbItems: UpcomingItem[] = fbRows.map((r) => ({
    kind: "fb" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt,
  }));
  const walletTopupItems: UpcomingItem[] = walletTopupRows.map((r) => ({
    kind: "wallet_topup" as const, id: r.id, organizationId: r.organizationId, startsAt: r.startsAt,
  }));
  res.json({ items: [...walletTopupItems, ...fbItems, ...scheduled].slice(0, 20) });
});

// ─── W3-L: Per-club theming ────────────────────────────────────────────────
router.get("/organizations/:orgId/theming", async (req, res) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "bad_org" }); return; } }
  const theme = await getClubTheme(orgId);
  res.json({ theme });
});

/**
 * Task #1229 — Theming logo/favicon upload flow (admin only).
 *
 *   1. POST /theming/upload-url  → presigned PUT URL + objectPath + token
 *   2. PUT  <uploadURL>           → upload bytes directly to GCS
 *   3. POST /theming/images       → validate + mark public + return URL
 *
 * The returned URL is suitable to pass back to PUT /theming as logoUrl
 * or faviconUrl.
 */
router.post("/organizations/:orgId/theming/upload-url", async (req, res) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "bad_org" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const body = (req.body ?? {}) as { contentType?: string; size?: number };
  if (body.contentType && !ALLOWED_THEMING_IMAGE_TYPES.has(body.contentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP, SVG, ICO" });
    return;
  }
  if (typeof body.size === "number" && body.size > MAX_THEMING_IMAGE_BYTES) {
    res.status(400).json({ error: "Image too large. Maximum size is 5 MB." });
    return;
  }
  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    const uploadToken = signThemingUploadPath(objectPath, orgId);
    res.json({ uploadURL, objectPath, uploadToken });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.post("/organizations/:orgId/theming/images", async (req, res) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "bad_org" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const { objectPath, uploadToken } = (req.body ?? {}) as { objectPath?: string; uploadToken?: string };
  if (!objectPath || typeof objectPath !== "string") {
    res.status(400).json({ error: "objectPath required" }); return;
  }
  if (!uploadToken || !verifyThemingUploadToken(objectPath, orgId, uploadToken)) {
    res.status(403).json({ error: "Invalid or missing upload token" }); return;
  }
  let storedContentType = "";
  try {
    const objFile = await storage.getObjectEntityFile(objectPath);
    const [meta] = await objFile.getMetadata();
    storedContentType = ((meta.contentType as string) || "").trim().toLowerCase();
    const storedSize = meta.size ? Number(meta.size) : 0;
    if (storedSize > MAX_THEMING_IMAGE_BYTES) {
      res.status(400).json({ error: "Image exceeds the 5 MB maximum size" }); return;
    }
  } catch {
    res.status(404).json({ error: "Uploaded object not found" }); return;
  }
  if (storedContentType && !ALLOWED_THEMING_IMAGE_TYPES.has(storedContentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP, SVG, ICO" });
    return;
  }
  try {
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: `org:${orgId}`,
      visibility: "public",
    });
  } catch {
    res.status(500).json({ error: "Failed to mark image as public" }); return;
  }
  res.status(201).json({ url: publicThemingObjectUrl(objectPath, req), objectPath });
});

router.put("/organizations/:orgId/theming", async (req, res) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "bad_org" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const body = (req.body ?? {}) as Partial<{
    primaryColor: string; accentColor: string; fontFamily: string;
    logoUrl: string | null; faviconUrl: string | null;
  }>;
  await db.insert(clubThemingTable).values({
    organizationId: orgId,
    primaryColor: body.primaryColor ?? null,
    accentColor: body.accentColor ?? null,
    fontFamily: body.fontFamily ?? null,
    logoUrl: body.logoUrl ?? null,
    faviconUrl: body.faviconUrl ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: clubThemingTable.organizationId,
    set: {
      primaryColor: body.primaryColor ?? null,
      accentColor: body.accentColor ?? null,
      fontFamily: body.fontFamily ?? null,
      logoUrl: body.logoUrl ?? null,
      faviconUrl: body.faviconUrl ?? null,
      updatedAt: new Date(),
    },
  });
  invalidateClubThemeCache(orgId);
  const theme = await getClubTheme(orgId);
  res.json({ theme });
});

// ─── W3-L: Peer-club benchmarks (skeleton) ─────────────────────────────────
// Returns the response *shape* with placeholder percentile data sourced from
// org-scoped aggregates already available. Subsequent tasks compute the real
// peer cohort.
router.get("/organizations/:orgId/benchmarks", async (req, res) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "bad_org" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM tee_bookings WHERE organization_id = ${orgId}) AS tee_bookings_total,
      (SELECT count(*) FROM organizations) AS peer_cohort_size
  `);
  const r = result as unknown as { rows?: Array<{ tee_bookings_total: string; peer_cohort_size: string }> };
  const row = r.rows?.[0];
  res.json({
    organizationId: orgId,
    metrics: [
      { key: "tee_bookings_total", value: Number(row?.tee_bookings_total ?? 0), percentile: null },
    ],
    peerCohortSize: Number(row?.peer_cohort_size ?? 0),
    note: "Percentile computation deferred to follow-up; shape is stable.",
  });
});

export default router;
