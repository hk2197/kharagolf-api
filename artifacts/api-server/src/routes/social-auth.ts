/**
 * Social sign-in (Apple + Google) for the player portal.
 *
 *   POST /api/auth/google   { idToken }                    → web / iOS / Android
 *   POST /api/auth/apple    { identityToken, fullName? }   → web / iOS
 *
 * Both endpoints verify the ID token against the provider's public keys,
 * upsert the matching app_users row (matched by verified email), create a
 * SessionData row, and start a row in user_active_sessions so the existing
 * "Active sessions" UI in wave3.ts shows social logins immediately.
 *
 * Web clients receive a Set-Cookie (sid). Mobile clients (x-client-type:
 * mobile) receive `{ token, user }` so the existing context/auth.tsx login
 * path can persist the bearer token in SecureStore.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  db,
  appUsersTable,
  userActiveSessionsTable,
  appUserSocialLinksTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";
import { sendWelcomeEmail } from "../lib/mailer";
import { track } from "../lib/analytics";

const router: IRouter = Router();

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

/**
 * Comma-separated list of accepted Google OAuth client IDs (web + iOS +
 * Android each have their own). The verifier accepts any of them as the
 * `aud` claim.
 */
function googleAudiences(): string[] {
  const v = process.env.GOOGLE_CLIENT_IDS ?? process.env.GOOGLE_CLIENT_ID ?? "";
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Comma-separated list of accepted Apple `aud` values:
 *   - the Services ID (web "Sign in with Apple")
 *   - the iOS bundle identifier (native Sign in with Apple)
 */
function appleAudiences(): string[] {
  const v = process.env.APPLE_CLIENT_IDS ?? process.env.APPLE_SERVICES_ID ?? "";
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const googleClient = new OAuth2Client();
const appleJwks = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

export async function verifyGoogleIdToken(idToken: string): Promise<{
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sub: string;
}> {
  const auds = googleAudiences();
  if (auds.length === 0) {
    throw new Error("google_not_configured");
  }
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: auds,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("missing_email");
  return {
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
    sub: payload.sub,
  };
}

export async function verifyAppleIdentityToken(identityToken: string): Promise<{
  email?: string;
  emailVerified: boolean;
  sub: string;
}> {
  const auds = appleAudiences();
  if (auds.length === 0) {
    throw new Error("apple_not_configured");
  }
  const { payload } = await jwtVerify(identityToken, appleJwks, {
    issuer: "https://appleid.apple.com",
    audience: auds,
  });
  const sub = String(payload.sub ?? "");
  if (!sub) throw new Error("missing_sub");
  const emailVerifiedRaw = (payload as Record<string, unknown>).email_verified;
  const emailVerified =
    emailVerifiedRaw === true || emailVerifiedRaw === "true";
  return {
    email:
      typeof payload.email === "string" ? payload.email : undefined,
    emailVerified,
    sub,
  };
}

function deviceLabel(req: Request): string | null {
  const ua = req.headers["user-agent"];
  if (typeof ua === "string" && ua.length > 0) return ua.slice(0, 200);
  return null;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip ?? null;
}

/**
 * Stable per-provider identifier we store in `app_users.replit_user_id`. We
 * reuse that column (rather than adding new ones) for parity with the
 * existing Replit OAuth path, which writes its own `${issuer}_${sub}`-style
 * id there.
 */
function providerLocalId(provider: "google" | "apple", sub: string): string {
  return `${provider}_${sub.slice(0, 64)}`;
}

/**
 * Resolve an app_user for a social sign-in. Lookup order:
 *   1. by an explicit row in `app_user_social_links` (Task #1225) — the
 *      authoritative provider→user mapping that survives unlink/relink and
 *      auto-link-by-email.
 *   2. by provider subject baked into `replit_user_id` (legacy path) —
 *      retained so accounts created before #1225's link table still resolve
 *      on repeat sign-in.
 *   3. by verified email — links the social identity to a previously-
 *      created password account so the player isn't forced to make a
 *      duplicate.
 * If none match and no email was provided we have no safe way to create a
 * row, so we surface `email_required` for the route to convert into a
 * friendly 400.
 *
 * Apple/Google attest the email so on first creation we mark
 * `email_verified=true` and skip the verify-by-mail step.
 */
async function findOrCreateSocialUser(args: {
  email?: string;
  displayName?: string;
  profileImage?: string;
  providerSub: string;
  provider: "google" | "apple";
}): Promise<typeof appUsersTable.$inferSelect> {
  const localId = providerLocalId(args.provider, args.providerSub);

  // 1) Authoritative: existing link row in app_user_social_links. This is
  //    the path that keeps working after a player unlinks-then-relinks the
  //    same provider, since the legacy replit_user_id column may have been
  //    rewritten to a different provider's id in the meantime.
  const [byLink] = await db
    .select({ user: appUsersTable })
    .from(appUserSocialLinksTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, appUserSocialLinksTable.userId))
    .where(and(
      eq(appUserSocialLinksTable.provider, args.provider),
      eq(appUserSocialLinksTable.providerSub, args.providerSub),
    ));
  if (byLink) {
    if (byLink.user.erasedAt) throw new Error("account_erased");
    return byLink.user;
  }

  // 2) Legacy: provider subject baked into replit_user_id. Covers accounts
  //    created before the link table existed (and any future row whose link
  //    record was deleted out-of-band).
  const [bySub] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.replitUserId, localId));
  if (bySub) {
    if (bySub.erasedAt) throw new Error("account_erased");
    return bySub;
  }

  const normalEmail = args.email?.toLowerCase().trim();

  // 3) Fall back to linking by verified email.
  if (normalEmail) {
    const [byEmail] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, normalEmail));
    if (byEmail) {
      if (byEmail.erasedAt) throw new Error("account_erased");
      // Backfill the provider-subject link so future sign-ins (including
      // Apple-without-email) find this row directly.
      const updates: Partial<typeof appUsersTable.$inferInsert> = {
        updatedAt: new Date(),
      };
      // Only overwrite replitUserId when it still looks like a local
      // placeholder ("ep_…" from password registration). Never clobber a
      // genuine Replit OAuth id or a different provider's link.
      if (byEmail.replitUserId.startsWith("ep_")) {
        updates.replitUserId = localId;
      }
      if (!byEmail.emailVerified) updates.emailVerified = true;
      if (Object.keys(updates).length > 1) {
        await db.update(appUsersTable).set(updates).where(eq(appUsersTable.id, byEmail.id));
        if (updates.emailVerified) byEmail.emailVerified = true;
      }
      return byEmail;
    }
  }

  // 4) Create a brand-new account. Requires an email; without one we
  //    cannot satisfy NOT NULL columns or send the welcome email.
  if (!normalEmail) {
    throw new Error("email_required");
  }

  const username = normalEmail.split("@")[0] || `user_${crypto.randomUUID().slice(0, 8)}`;
  const displayName = args.displayName ?? username;

  const [created] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: localId,
      username,
      email: normalEmail,
      displayName,
      profileImage: args.profileImage ?? null,
      role: "player",
      emailVerified: true,
    })
    .returning();

  // Best-effort welcome email; never block sign-in if mail is down.
  try {
    await sendWelcomeEmail(normalEmail, displayName);
  } catch {
    /* ignore */
  }

  return created;
}

/**
 * Task #1225 — record/refresh the (user, provider) link in
 * `app_user_social_links` after a successful social sign-in. The unique
 * index on (provider, provider_sub) guarantees a given Apple ID / Google
 * account maps to at most one user; if a different user already owns this
 * subject we surface `provider_already_linked` so the route can return a
 * clean 409 instead of leaking the unique-constraint error.
 *
 * Best-effort by design — we never block sign-in if the link write fails;
 * the legacy `replit_user_id`-baked subject still resolves the row on the
 * next attempt and we can heal forward later.
 */
export async function recordSocialLink(args: {
  userId: number;
  provider: "google" | "apple";
  providerSub: string;
}): Promise<void> {
  const now = new Date();
  // Defend against the cross-user collision case before we let drizzle's
  // ON CONFLICT path silently update someone else's row's lastUsedAt.
  const [existingForSub] = await db
    .select({ userId: appUserSocialLinksTable.userId })
    .from(appUserSocialLinksTable)
    .where(and(
      eq(appUserSocialLinksTable.provider, args.provider),
      eq(appUserSocialLinksTable.providerSub, args.providerSub),
    ));
  if (existingForSub && existingForSub.userId !== args.userId) {
    throw new Error("provider_already_linked");
  }
  await db
    .insert(appUserSocialLinksTable)
    .values({
      userId: args.userId,
      provider: args.provider,
      providerSub: args.providerSub,
      linkedAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: [appUserSocialLinksTable.userId, appUserSocialLinksTable.provider],
      set: {
        providerSub: args.providerSub,
        lastUsedAt: now,
      },
    });
}

async function startSocialSession(
  req: Request,
  res: Response,
  user: typeof appUsersTable.$inferSelect,
  provider: "google" | "apple",
): Promise<void> {
  const sessionData: SessionData = {
    user: {
      id: user.id,
      replitId: user.replitUserId,
      username: user.username,
      email: user.email ?? undefined,
      displayName: user.displayName ?? undefined,
      profileImage: user.profileImage ?? undefined,
      role: user.role as never,
      organizationId: user.organizationId ?? undefined,
      createdAt: user.createdAt.toISOString(),
    },
    access_token: `social_${provider}_${user.id}`,
  };

  const sid = await createSession(sessionData);

  // Wave 3 W3-A: record the active session row so it appears in the
  // /portal/sessions UI and can be remotely revoked.
  try {
    await db.insert(userActiveSessionsTable).values({
      userId: user.id,
      sessionToken: sid,
      deviceLabel: deviceLabel(req),
      ip: clientIp(req),
      userAgent: deviceLabel(req),
    });
  } catch (err) {
    req.log?.warn({ err }, "failed to record user_active_sessions row");
  }

  void track(
    "player_login",
    {
      method: provider,
      isLocalAuth: false,
      clientType: req.headers["x-client-type"] ?? "web",
    },
    {
      organizationId: user.organizationId ?? null,
      userId: user.id,
      surface: req.headers["x-client-type"] === "mobile" ? "mobile" : "web",
    },
  );

  const userWithLang = {
    ...sessionData.user,
    preferredLanguage: user.preferredLanguage ?? "en",
    isLocalAuth: true,
  };

  if (req.headers["x-client-type"] === "mobile") {
    res.json({ token: sid, user: userWithLang });
  } else {
    setSessionCookie(res, sid);
    res.json({ user: userWithLang });
  }
}

// POST /api/auth/google { idToken }
router.post("/auth/google", async (req: Request, res: Response) => {
  const idToken = (req.body as { idToken?: unknown } | undefined)?.idToken;
  if (typeof idToken !== "string" || idToken.length === 0) {
    res.status(400).json({ error: "idToken is required" });
    return;
  }
  try {
    const claims = await verifyGoogleIdToken(idToken);
    if (!claims.emailVerified) {
      res.status(401).json({ error: "Google email is not verified" });
      return;
    }
    const user = await findOrCreateSocialUser({
      email: claims.email,
      displayName: claims.name,
      profileImage: claims.picture,
      providerSub: claims.sub,
      provider: "google",
    });
    try {
      await _internals.recordSocialLink({ userId: user.id, provider: "google", providerSub: claims.sub });
    } catch (err) {
      // Defensive: a real cross-account collision is unreachable here
      // because findOrCreateSocialUser step 1 resolved by provider sub
      // first. Kept and tested via the _internals seam for safety.
      if (err instanceof Error && err.message === "provider_already_linked") {
        res.status(409).json({
          error:
            "This Google account is already linked to a different KHARAGOLF account.",
        });
        return;
      }
      // Don't block sign-in on a non-fatal link write failure.
      req.log?.warn({ err }, "failed to record google social link");
    }
    await startSocialSession(req, res, user, "google");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "google_signin_failed";
    if (msg === "google_not_configured") {
      res
        .status(503)
        .json({ error: "Google sign-in is not configured on this server" });
      return;
    }
    if (msg === "account_erased") {
      res.status(403).json({ error: "This account has been deleted." });
      return;
    }
    if (msg === "email_required") {
      res.status(400).json({ error: "Google did not return an email for this sign-in." });
      return;
    }
    req.log?.warn({ err }, "google sign-in failed");
    res.status(401).json({ error: "Could not verify Google sign-in" });
  }
});

// POST /api/auth/apple { identityToken, fullName?: { givenName, familyName } }
router.post("/auth/apple", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    identityToken?: unknown;
    fullName?: { givenName?: string; familyName?: string };
  };
  const identityToken = body.identityToken;
  if (typeof identityToken !== "string" || identityToken.length === 0) {
    res.status(400).json({ error: "identityToken is required" });
    return;
  }
  try {
    const claims = await verifyAppleIdentityToken(identityToken);
    // NOTE: Apple omits the email claim on every sign-in *after* the
    // first. That's fine for repeat sign-ins because findOrCreateSocialUser
    // can locate the row by provider subject (`replit_user_id`). We only
    // require an email — and a verified one — when we'd otherwise have to
    // create a brand-new account.
    const email = claims.email;
    if (email && !claims.emailVerified) {
      res.status(401).json({ error: "Apple email is not verified" });
      return;
    }
    const fullName = body.fullName;
    const displayName =
      fullName?.givenName || fullName?.familyName
        ? `${fullName?.givenName ?? ""} ${fullName?.familyName ?? ""}`.trim()
        : undefined;
    const user = await findOrCreateSocialUser({
      email,
      displayName,
      providerSub: claims.sub,
      provider: "apple",
    });
    try {
      await _internals.recordSocialLink({ userId: user.id, provider: "apple", providerSub: claims.sub });
    } catch (err) {
      // Defensive: a real cross-account collision is unreachable here
      // because findOrCreateSocialUser step 1 resolved by provider sub
      // first. Kept and tested via the _internals seam for safety.
      if (err instanceof Error && err.message === "provider_already_linked") {
        res.status(409).json({
          error:
            "This Apple ID is already linked to a different KHARAGOLF account.",
        });
        return;
      }
      // Don't block sign-in on a non-fatal link write failure.
      req.log?.warn({ err }, "failed to record apple social link");
    }
    await startSocialSession(req, res, user, "apple");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "apple_signin_failed";
    if (msg === "apple_not_configured") {
      res
        .status(503)
        .json({ error: "Apple sign-in is not configured on this server" });
      return;
    }
    if (msg === "account_erased") {
      res.status(403).json({ error: "This account has been deleted." });
      return;
    }
    if (msg === "email_required") {
      // First-ever Apple sign-in for an unknown subject — we genuinely
      // need the email to create the account. The user must retry and
      // choose "Share My Email" in the Apple sheet.
      res.status(400).json({
        error:
          "Apple did not return an email for this sign-in. Please retry and choose 'Share My Email'.",
      });
      return;
    }
    req.log?.warn({ err }, "apple sign-in failed");
    res.status(401).json({ error: "Could not verify Apple sign-in" });
  }
});

// GET /api/auth/social-config — lightweight discovery so clients can hide
// the buttons when the server has no provider credentials configured.
router.get("/auth/social-config", (_req: Request, res: Response) => {
  res.json({
    google: googleAudiences().length > 0,
    apple: appleAudiences().length > 0,
  });
});

// Indirection seam so tests can stub `recordSocialLink` to exercise the
// route's 409 catch branch without depending on internal step ordering or
// mailer side effects. Production routes call through `_internals` so a
// `vi.spyOn(_internals, "recordSocialLink")` in tests is honored.
export const _internals = { recordSocialLink };

export default router;
