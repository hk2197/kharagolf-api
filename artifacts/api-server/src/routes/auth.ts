import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { usersTable, appUsersTable, organizationsTable, orgMembershipsTable } from "@workspace/db";
import { MEMBER_ADMIN_MEMBERSHIP_ROLES } from "@workspace/member-admin-roles";
import { and, inArray } from "drizzle-orm";
import {
  clearSession,
  getOidcConfig,
  getSessionId,
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL,
  ISSUER_URL,
  type SessionData,
} from "../lib/auth";
import { eq, sql } from "drizzle-orm";
import type { AuthUserRole } from "@workspace/api-zod";

/**
 * Map a Drizzle `org_role` enum value (which includes membership_secretary
 * and treasurer that the public AuthUser API does not yet model) onto an
 * AuthUserRole the wire schema accepts. Unknown values fall back to "player".
 */
const ORG_ROLE_TO_AUTH_ROLE: Record<string, AuthUserRole> = {
  super_admin: "super_admin",
  org_admin: "org_admin",
  membership_secretary: "org_admin",
  treasurer: "org_admin",
  tournament_director: "tournament_director",
  committee_member: "committee_member",
  competition_secretary: "competition_secretary",
  volunteer: "volunteer",
  player: "player",
  spectator: "spectator",
  pro_shop: "pro_shop",
};
function toAuthRole(role: string): AuthUserRole {
  return ORG_ROLE_TO_AUTH_ROLE[role] ?? "player";
}

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

// Exported under a test-only alias for the auto-erasure regression test
// (see src/tests/account-erasure-cron.test.ts). Not part of the public API.
export { upsertUser as upsertUserForTest };

async function upsertUser(claims: Record<string, unknown>) {
  const replitId = claims.sub as string;
  const email = (claims.email as string) || null;
  const firstName = (claims.first_name as string) || null;
  const lastName = (claims.last_name as string) || null;
  const profileImageUrl = (claims.profile_image_url || claims.picture) as string | null;
  const username = (claims.username as string) || (claims.name as string) || replitId;
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || username;

  // Task #467 — refuse to re-hydrate an erased account.
  // The auto-erasure cron worker stamps `app_users.erased_at` and scrubs PII
  // after the 30-day cancellation grace window. Without this guard the OAuth
  // upsert below would happily write `email` / `displayName` / `profileImage`
  // back from the new login claims, resurrecting the very PII we just erased.
  const [existing] = await db
    .select({ erasedAt: appUsersTable.erasedAt })
    .from(appUsersTable)
    .where(eq(appUsersTable.replitUserId, replitId));
  if (existing?.erasedAt) {
    const err = new Error("Account has been erased and cannot be reactivated.") as Error & { code?: string; statusCode?: number };
    err.code = "ACCOUNT_ERASED";
    err.statusCode = 403;
    throw err;
  }

  // Upsert into base OIDC users table
  await db
    .insert(usersTable)
    .values({ id: replitId, email, firstName, lastName, profileImageUrl })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { email, firstName, lastName, profileImageUrl, updatedAt: new Date() },
    });

  // Count existing app users to decide role (first user becomes org_admin)
  const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)` }).from(appUsersTable);
  const isFirstUser = Number(cnt) === 0;
  const autoRole = isFirstUser ? "org_admin" : "player";

  // Find the first organization to auto-assign users (include defaultLanguage for new user language init)
  let [firstOrg] = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name, defaultLanguage: organizationsTable.defaultLanguage })
    .from(organizationsTable)
    .limit(1);

  // If no organization exists at all, auto-create one for the first admin
  if (!firstOrg) {
    const orgName = displayName ? `${displayName}'s Golf Club` : "My Golf Club";
    const [newOrg] = await db
      .insert(organizationsTable)
      .values({ name: orgName, slug: `org-${replitId.slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "")}` })
      .returning({ id: organizationsTable.id, name: organizationsTable.name, defaultLanguage: organizationsTable.defaultLanguage });
    firstOrg = newOrg;
  }

  const autoOrgId = firstOrg.id;
  const orgDefaultLanguage = firstOrg.defaultLanguage ?? "en";

  const [appUser] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: replitId,
      username,
      email,
      displayName: displayName || null,
      profileImage: profileImageUrl,
      role: autoRole,
      organizationId: autoOrgId,
      // New OAuth users inherit the org's default language
      preferredLanguage: orgDefaultLanguage,
    })
    .onConflictDoUpdate({
      target: appUsersTable.replitUserId,
      set: {
        username,
        email,
        displayName: displayName || null,
        profileImage: profileImageUrl,
        // only set organizationId if currently null
        organizationId: sql`COALESCE(app_users.organization_id, ${autoOrgId})`,
        // preserve existing users' language preference — do not override on re-login
        updatedAt: new Date(),
      },
    })
    .returning();

  return appUser;
}

// GET /auth/me  — always live-reads from DB so org/role changes take effect immediately
router.get("/auth/me", async (req: Request, res: Response) => {
  // Prevent browser/proxy caching so org/role changes are always reflected immediately
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [freshUser] = await db
    .select()
    .from(appUsersTable)
    .where(sql`${appUsersTable.id} = ${req.user.id}`);

  if (!freshUser) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  // Heal users with no org — assign or create one on-the-fly
  if (!freshUser.organizationId) {
    let [existingOrg] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .limit(1);

    if (!existingOrg) {
      const orgName = freshUser.displayName ? `${freshUser.displayName}'s Golf Club` : "My Golf Club";
      const safeSlug = `org-${freshUser.replitUserId.slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const [newOrg] = await db
        .insert(organizationsTable)
        .values({ name: orgName, slug: safeSlug })
        .returning();
      existingOrg = newOrg;
    }

    await db
      .update(appUsersTable)
      .set({ organizationId: existingOrg.id, role: "org_admin", updatedAt: new Date() })
      .where(sql`${appUsersTable.id} = ${freshUser.id}`);

    freshUser.organizationId = existingOrg.id;
    freshUser.role = "org_admin";
  }

  let organizationName: string | undefined;
  if (freshUser.organizationId) {
    const [org] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(sql`${organizationsTable.id} = ${freshUser.organizationId}`);
    organizationName = org?.name;
  }

  // Task #2210 — list every org id where this user has a membership-derived
  // member-admin role (org_admin / membership_secretary / treasurer in
  // org_memberships). The web dashboard's stuck-erasure / privacy /
  // stalled-export widgets used to be hard-gated to global org_admin /
  // super_admin and silently excluded treasurers and membership
  // secretaries the server would happily authorise. Surfacing the list on
  // /auth/me lets the shared `isMemberAdmin` helper open those widgets to
  // every role the server already accepts, with no extra request.
  const memberAdminMemberships = await db
    .select({ organizationId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(
      and(
        eq(orgMembershipsTable.userId, freshUser.id),
        inArray(orgMembershipsTable.role, MEMBER_ADMIN_MEMBERSHIP_ROLES),
      ),
    );
  const memberAdminOrgIds = Array.from(
    new Set(memberAdminMemberships.map((m) => m.organizationId)),
  ).sort((a, b) => a - b);

  res.json({
    id: freshUser.id,
    replitId: freshUser.replitUserId,
    username: freshUser.username,
    email: freshUser.email ?? undefined,
    displayName: freshUser.displayName ?? undefined,
    profileImage: freshUser.profileImage ?? undefined,
    role: freshUser.role,
    organizationId: freshUser.organizationId ?? undefined,
    organizationName,
    memberAdminOrgIds,
    createdAt: freshUser.createdAt.toISOString(),
    preferredLanguage: freshUser.preferredLanguage ?? "en",
  });
});

// PATCH /auth/me/language — update admin user's preferred language
router.patch("/auth/me/language", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const supported = ["en", "hi", "ar", "es", "fr", "de", "pt", "ja", "ko", "zh", "th", "ms", "id", "vi", "fil", "sw", "af", "am", "ha", "zu", "yo"];
  const { language } = req.body;
  if (!language || !supported.includes(language)) {
    res.status(400).json({ error: "Invalid language. Supported: en, hi, ar, es, fr, de, pt, ja, ko, zh, th, ms, id, vi, fil, sw, af, am, ha, zu, yo" });
    return;
  }
  await db.update(appUsersTable)
    .set({ preferredLanguage: language as "en", updatedAt: new Date() })
    .where(sql`${appUsersTable.id} = ${req.user!.id}`);
  res.json({ preferredLanguage: language });
});

// GET /login
router.get("/login", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;
  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", returnTo);

  res.redirect(redirectTo.href);
});

// GET /callback
router.get("/callback", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    res.redirect("/api/login");
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);

  res.clearCookie("code_verifier", { path: "/" });
  res.clearCookie("nonce", { path: "/" });
  res.clearCookie("state", { path: "/" });
  res.clearCookie("return_to", { path: "/" });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }

  let appUser;
  try {
    appUser = await upsertUser(claims as unknown as Record<string, unknown>);
  } catch (e) {
    if ((e as { code?: string }).code === "ACCOUNT_ERASED") {
      res.redirect("/login?error=account_erased");
      return;
    }
    throw e;
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: {
      id: appUser.id,
      replitId: appUser.replitUserId,
      username: appUser.username,
      email: appUser.email ?? undefined,
      displayName: appUser.displayName ?? undefined,
      profileImage: appUser.profileImage ?? undefined,
      role: toAuthRole(appUser.role),
      organizationId: appUser.organizationId ?? undefined,
      createdAt: appUser.createdAt.toISOString(),
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : (claims.exp as number),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  // Role-aware redirect: if returnTo is root or unset, send users to the right landing page
  let destination = returnTo;
  if (!destination || destination === "/" || destination === "/login") {
    const role = appUser.role;
    if (role === "player" || role === "spectator") {
      destination = "/portal";
    } else {
      destination = "/";
    }
  }
  res.redirect(destination);
});

// GET /logout
router.get("/logout", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);

  const sid = getSessionId(req);
  await clearSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: origin,
  });

  res.redirect(endSessionUrl.href);
});

// POST /mobile-auth/token-exchange
router.post("/mobile-auth/token-exchange", async (req: Request, res: Response) => {
  const { code, code_verifier, redirect_uri, state, nonce } = req.body;
  if (!code || !code_verifier || !redirect_uri || !state) {
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("iss", ISSUER_URL);

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: code_verifier,
      expectedNonce: nonce ?? undefined,
      expectedState: state,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      res.status(401).json({ error: "No claims in ID token" });
      return;
    }

    let appUser;
    try {
      appUser = await upsertUser(claims as unknown as Record<string, unknown>);
    } catch (e) {
      if ((e as { code?: string }).code === "ACCOUNT_ERASED") {
        res.status(403).json({ error: "ACCOUNT_ERASED", message: "Account has been erased and cannot be reactivated." });
        return;
      }
      throw e;
    }
    const now = Math.floor(Date.now() / 1000);
    const sessionData: SessionData = {
      user: {
        id: appUser.id,
        replitId: appUser.replitUserId,
        username: appUser.username,
        email: appUser.email ?? undefined,
        displayName: appUser.displayName ?? undefined,
        profileImage: appUser.profileImage ?? undefined,
        role: toAuthRole(appUser.role),
        organizationId: appUser.organizationId ?? undefined,
        createdAt: appUser.createdAt.toISOString(),
      },
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : (claims.exp as number),
    };

    const sid = await createSession(sessionData);
    res.json({ token: sid });
  } catch (err) {
    req.log.error({ err }, "Mobile token exchange error");
    res.status(500).json({ error: "Token exchange failed" });
  }
});

// POST /mobile-auth/logout
router.post("/mobile-auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.json({ success: true });
});

export default router;
