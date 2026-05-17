import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, appUsersTable, organizationsTable, tournamentsTable, clubMembersTable, orgMembershipsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { createSession, SESSION_COOKIE, SESSION_TTL, type SessionData, getSessionId, deleteSession } from "../lib/auth";
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from "../lib/mailer";
import { track } from "../lib/analytics";

const router: IRouter = Router();

function getOrigin(req: Request): string {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/$/, "");
  }
  // Fallback: derive from request headers (reliable behind Replit / reverse proxy)
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
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

// Shared handler for player registration (used by both /auth/player-register and /auth/register)
async function handlePlayerRegister(req: Request, res: Response): Promise<void> {
  const { firstName, lastName, email, password, memberNumber, organizationId: orgIdStr } = req.body;
  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ error: "firstName, lastName, email and password are required" });
    return;
  }
  const registrationOrgId = orgIdStr ? parseInt(String(orgIdStr)) : undefined;
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  // Check if email already registered
  const [existing] = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(eq(appUsersTable.email, email.toLowerCase().trim()));

  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localId = `ep_${crypto.randomUUID()}`;
  const displayName = `${firstName} ${lastName}`;

  // Check for member number match:
  //   - If registrationOrgId provided: scope lookup to that org only (safe; direct org context)
  //   - Email match → auto-link after user creation (also sets organizationId on user)
  //   - Email mismatch + unique global/org-scoped record → set pendingMemberLink for admin review
  //   - Email mismatch + multiple records with no email match → do nothing (can't safely scope)
  let matchedMember: typeof clubMembersTable.$inferSelect | undefined;
  let pendingFlagMember: typeof clubMembersTable.$inferSelect | undefined;
  if (memberNumber?.trim()) {
    const normalEmail = email.toLowerCase().trim();
    const conditions = registrationOrgId && !isNaN(registrationOrgId)
      ? and(eq(clubMembersTable.memberNumber, memberNumber.trim()), eq(clubMembersTable.organizationId, registrationOrgId))
      : eq(clubMembersTable.memberNumber, memberNumber.trim());
    const rows = await db.select()
      .from(clubMembersTable)
      .where(conditions)
      .limit(20);
    const exactEmailMatch = rows.find(m => m.email?.toLowerCase().trim() === normalEmail);
    if (exactEmailMatch) {
      matchedMember = exactEmailMatch;
    } else if (rows.length === 1) {
      // Uniquely identified but email differs — flag for admin review
      pendingFlagMember = rows[0];
    }
    // Multiple matches with no email match: cannot safely identify org, do nothing.
  }

  // Only pre-assign organizationId on the new user if we have an exact email match
  const matchedOrgIdForUser = matchedMember?.organizationId;

  // Fetch org's default language if we know which org this registration is for
  const effectiveOrgId = matchedOrgIdForUser ?? (registrationOrgId && !isNaN(registrationOrgId) ? registrationOrgId : undefined);
  let orgDefaultLanguage = "en";
  if (effectiveOrgId) {
    const [org] = await db.select({ defaultLanguage: organizationsTable.defaultLanguage }).from(organizationsTable).where(eq(organizationsTable.id, effectiveOrgId));
    if (org?.defaultLanguage) orgDefaultLanguage = org.defaultLanguage;
  }

  const [newUser] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: localId,
      username: email.toLowerCase().trim(),
      email: email.toLowerCase().trim(),
      displayName,
      role: "player",
      passwordHash,
      emailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpiry: verificationExpiry,
      organizationId: matchedOrgIdForUser ?? undefined,
      preferredLanguage: orgDefaultLanguage as "en",
    })
    .returning();

  // Member number matching post-creation actions
  if (matchedMember && !matchedMember.userId) {
    // Email matches → auto-link portal account to club membership
    await db.update(clubMembersTable).set({
      userId: newUser.id,
      inviteToken: null,
      inviteTokenExpiry: null,
      pendingMemberLink: false,
      updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, matchedMember.id));
    try {
      await db.insert(orgMembershipsTable).values({
        organizationId: matchedMember.organizationId,
        userId: newUser.id,
        role: "player",
      });
    } catch { /* ignore duplicate */ }
  } else if (pendingFlagMember && !pendingFlagMember.userId) {
    // Unique match but email differs → flag for admin review; do NOT set org on user
    await db.update(clubMembersTable).set({
      pendingMemberLink: true,
      updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, pendingFlagMember.id));
  }

  const baseUrl = getOrigin(req);
  let emailDelivered = true;
  try {
    await sendVerificationEmail(newUser.email!, displayName, verificationToken, baseUrl);
  } catch (err) {
    emailDelivered = false;
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log?.error({ err, userId: newUser.id, email: newUser.email, errMsg }, "[AUTH] Failed to send verification email — check GMAIL_USER and GMAIL_APP_PASSWORD secrets");
  }

  res.status(201).json({
    message: emailDelivered
      ? "Registration successful. Please check your email to verify your account."
      : "Registration successful, but we couldn't send the verification email right now. Please use the 'Resend verification email' option on the sign-in page.",
    userId: newUser.id,
    emailDelivered,
  });
}

// POST /api/auth/player-register — original endpoint
router.post("/auth/player-register", handlePlayerRegister);

// POST /api/auth/register — spec-mandated alias (backward compatible)
router.post("/auth/register", handlePlayerRegister);

// POST /api/auth/claim-account — activate account via admin invite link
// Body: { inviteToken, password, firstName?, lastName? }
// firstName/lastName override the member's stored names if provided (non-empty)
router.post("/auth/claim-account", async (req: Request, res: Response) => {
  const { inviteToken, password, firstName: claimFirstName, lastName: claimLastName } = req.body;
  if (!inviteToken || !password) {
    res.status(400).json({ error: "inviteToken and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const [member] = await db.select().from(clubMembersTable)
    .where(eq(clubMembersTable.inviteToken, inviteToken));
  if (!member) {
    res.status(400).json({ error: "Invalid or expired invite link" });
    return;
  }
  if (member.inviteTokenExpiry && new Date(member.inviteTokenExpiry) < new Date()) {
    res.status(400).json({ error: "This invite link has expired. Please contact your club admin for a new one." });
    return;
  }
  if (!member.email) {
    res.status(400).json({ error: "No email address on record for this member. Contact your club admin." });
    return;
  }

  let userId: number;
  const normalEmail = member.email.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  const [existingUser] = await db.select({ id: appUsersTable.id, role: appUsersTable.role })
    .from(appUsersTable).where(eq(appUsersTable.email, normalEmail));

  if (existingUser) {
    // Existing user: treat invite claim as email verification + password update
    userId = existingUser.id;
    await db.update(appUsersTable).set({
      passwordHash,
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiry: null,
      organizationId: member.organizationId,
      updatedAt: new Date(),
    }).where(eq(appUsersTable.id, userId));
    try {
      await db.insert(orgMembershipsTable).values({
        organizationId: member.organizationId,
        userId,
        role: "player",
      });
    } catch { /* ignore duplicate */ }
  } else {
    const localId = `ep_${crypto.randomUUID()}`;
    const resolvedFirst = claimFirstName?.trim() || member.firstName;
    const resolvedLast = claimLastName?.trim() || member.lastName;
    const displayName = `${resolvedFirst} ${resolvedLast}`;
    // Use org's default language for new user
    const [orgForLang] = await db.select({ defaultLanguage: organizationsTable.defaultLanguage }).from(organizationsTable).where(eq(organizationsTable.id, member.organizationId));
    const [newUser] = await db.insert(appUsersTable).values({
      replitUserId: localId,
      username: member.email.toLowerCase(),
      email: member.email.toLowerCase(),
      displayName,
      role: "player",
      passwordHash,
      emailVerified: true,
      organizationId: member.organizationId,
      preferredLanguage: orgForLang?.defaultLanguage ?? "en",
    }).returning({ id: appUsersTable.id });
    userId = newUser.id;
    try {
      await db.insert(orgMembershipsTable).values({
        organizationId: member.organizationId,
        userId,
        role: "player",
      });
    } catch { /* ignore duplicate */ }
  }

  await db.update(clubMembersTable).set({
    userId,
    inviteToken: null,
    inviteTokenExpiry: null,
    pendingMemberLink: false,
    updatedAt: new Date(),
  }).where(eq(clubMembersTable.id, member.id));

  const [fullUser] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
  const sessionData: SessionData = {
    user: {
      id: fullUser.id,
      replitId: fullUser.replitUserId,
      username: fullUser.username,
      email: fullUser.email ?? undefined,
      displayName: fullUser.displayName ?? undefined,
      profileImage: fullUser.profileImage ?? undefined,
      role: fullUser.role as never,
      organizationId: fullUser.organizationId ?? undefined,
      createdAt: fullUser.createdAt.toISOString(),
    },
    access_token: `local_${fullUser.id}`,
  };
  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);
  res.json({ ok: true, user: { ...sessionData.user, preferredLanguage: fullUser.preferredLanguage ?? "en", isLocalAuth: true } });
});

// POST /api/auth/player-login
router.post("/auth/player-login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.email, email.toLowerCase().trim()));

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ error: "Please verify your email address before logging in. Check your inbox for a verification link." });
    return;
  }

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
    access_token: `local_${user.id}`,
  };

  const sid = await createSession(sessionData);

  const userWithLang = { ...sessionData.user, preferredLanguage: user.preferredLanguage ?? "en", isLocalAuth: true };

  // Wave 0 / Task #935 — analytics smoke test (1/5: player_login)
  void track("player_login", {
    method: "password",
    isLocalAuth: true,
    clientType: req.headers["x-client-type"] ?? "web",
  }, {
    organizationId: user.organizationId ?? null,
    userId: user.id,
    surface: req.headers["x-client-type"] === "mobile" ? "mobile" : "web",
  });

  // Support both cookie (web) and Bearer token (mobile) responses
  const wantToken = req.headers["x-client-type"] === "mobile";
  if (wantToken) {
    res.json({ token: sid, user: userWithLang });
  } else {
    setSessionCookie(res, sid);
    res.json({ user: userWithLang });
  }
});

// POST /api/auth/player-logout
router.post("/auth/player-logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// POST /api/auth/verify-email
router.post("/auth/verify-email", async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "Token is required" });
    return;
  }

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(and(
      eq(appUsersTable.emailVerificationToken, token),
    ));

  if (!user) {
    res.status(400).json({ error: "Invalid or expired verification token" });
    return;
  }

  if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
    res.status(400).json({ error: "Verification link has expired. Please request a new one." });
    return;
  }

  await db
    .update(appUsersTable)
    .set({
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiry: null,
      updatedAt: new Date(),
    })
    .where(eq(appUsersTable.id, user.id));

  try {
    await sendWelcomeEmail(user.email!, user.displayName ?? user.username);
  } catch (err) {
    req.log?.error({ err }, "Failed to send welcome email");
  }

  res.json({ message: "Email verified successfully. You can now log in." });
});

// POST /api/auth/resend-verification
router.post("/auth/resend-verification", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.email, email.toLowerCase().trim()));

  if (!user || !user.passwordHash) {
    // Don't reveal if email exists
    res.json({ message: "If that email is registered, a verification link has been sent." });
    return;
  }

  if (user.emailVerified) {
    res.status(400).json({ error: "Email is already verified" });
    return;
  }

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .update(appUsersTable)
    .set({ emailVerificationToken: verificationToken, emailVerificationExpiry: verificationExpiry, updatedAt: new Date() })
    .where(eq(appUsersTable.id, user.id));

  const baseUrl = getOrigin(req);
  try {
    await sendVerificationEmail(user.email!, user.displayName ?? user.username, verificationToken, baseUrl);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log?.error({ userId: user.id, email: user.email, errMsg }, "Failed to resend verification email");
  }

  res.json({ message: "If that email is registered, a verification link has been sent." });
});

// POST /api/auth/forgot-password
router.post("/auth/forgot-password", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.email, email.toLowerCase().trim()));

  // Always return success to prevent enumeration
  const msg = { message: "If that email is registered, a password reset link has been sent." };

  if (!user || !user.passwordHash) {
    res.json(msg);
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db
    .update(appUsersTable)
    .set({ passwordResetToken: resetToken, passwordResetExpiry: resetExpiry, updatedAt: new Date() })
    .where(eq(appUsersTable.id, user.id));

  const baseUrl = getOrigin(req);
  try {
    await sendPasswordResetEmail(user.email!, user.displayName ?? user.username, resetToken, baseUrl);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log?.error({ err, userId: user.id, email: user.email, errMsg }, "[AUTH] Failed to send password reset email — check GMAIL_USER and GMAIL_APP_PASSWORD secrets");
  }

  res.json(msg);
});

// POST /api/auth/admin-setup — bootstrap first admin account (only works when no org_admin exists)
router.post("/auth/admin-setup", async (req: Request, res: Response) => {
  const { firstName, lastName, email, password, organizationName } = req.body;
  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ error: "firstName, lastName, email and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const passwordHash = await bcrypt.hash(password, 12);
  const localId = `ep_${crypto.randomUUID()}`;
  const displayName = `${firstName} ${lastName}`;

  let newAdmin: typeof appUsersTable.$inferSelect;

  try {
    newAdmin = await db.transaction(async (tx) => {
      // Serialize concurrent setup attempts with a session-level advisory lock
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1734829361)`);

      // Re-check for existing admin inside the transaction
      const [existingAdmin] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(inArray(appUsersTable.role, ["org_admin", "super_admin"]))
        .limit(1);

      if (existingAdmin) {
        throw Object.assign(new Error("ADMIN_EXISTS"), { code: 409 });
      }

      // Block duplicate email
      const [existingEmail] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(eq(appUsersTable.email, normalizedEmail));

      if (existingEmail) {
        throw Object.assign(new Error("EMAIL_EXISTS"), { code: 409 });
      }

      // Find or create organization
      let [org] = await tx
        .select({ id: organizationsTable.id })
        .from(organizationsTable)
        .limit(1);

      if (!org) {
        const orgName = organizationName?.trim() || `${firstName}'s Golf Club`;
        const safeSlug = `org-${crypto.randomBytes(4).toString("hex")}`;
        const [newOrg] = await tx
          .insert(organizationsTable)
          .values({ name: orgName, slug: safeSlug })
          .returning();
        org = newOrg;
      }

      const [created] = await tx
        .insert(appUsersTable)
        .values({
          replitUserId: localId,
          username: normalizedEmail,
          email: normalizedEmail,
          displayName,
          role: "org_admin",
          passwordHash,
          emailVerified: true,
          organizationId: org.id,
        })
        .returning();

      return created;
    });
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    if (e?.code === 409 && e?.message === "ADMIN_EXISTS") {
      res.status(409).json({ error: "An administrator account already exists. Please log in instead." });
      return;
    }
    if (e?.code === 409 && e?.message === "EMAIL_EXISTS") {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    throw err;
  }

  // Auto-login: create a session so the admin is logged in immediately
  const sessionData: SessionData = {
    user: {
      id: newAdmin.id,
      replitId: newAdmin.replitUserId,
      username: newAdmin.username,
      email: newAdmin.email ?? undefined,
      displayName: newAdmin.displayName ?? undefined,
      role: newAdmin.role as never,
      organizationId: newAdmin.organizationId ?? undefined,
      createdAt: newAdmin.createdAt.toISOString(),
    },
    access_token: `local_${newAdmin.id}`,
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.status(201).json({
    message: "Admin account created successfully. You are now logged in.",
    user: sessionData.user,
  });
});

// POST /api/auth/admin-setup-check — returns whether setup is still available (no admin exists)
router.get("/auth/admin-setup-check", async (_req: Request, res: Response) => {
  const [existingAdmin] = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(inArray(appUsersTable.role, ["org_admin", "super_admin"]))
    .limit(1);

  res.json({ setupAvailable: !existingAdmin });
});

// POST /api/auth/reset-password
router.post("/auth/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) {
    res.status(400).json({ error: "Token and new password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.passwordResetToken, token));

  if (!user) {
    res.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  if (user.passwordResetExpiry && user.passwordResetExpiry < new Date()) {
    res.status(400).json({ error: "Reset link has expired. Please request a new one." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db
    .update(appUsersTable)
    .set({ passwordHash, passwordResetToken: null, passwordResetExpiry: null, updatedAt: new Date() })
    .where(eq(appUsersTable.id, user.id));

  res.json({ message: "Password reset successful. You can now log in with your new password." });
});

export default router;
