import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  appUsersTable,
  orgMembershipsTable,
  playersTable,
  tournamentsTable,
  shopOrdersTable,
  shopProductsTable,
  clubMembersTable,
  memberSubscriptionsTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql, desc } from "drizzle-orm";
import { sendPasswordResetEmail } from "../lib/mailer";

const router: IRouter = Router({ mergeParams: true });

function getOrigin(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

/** Returns the orgId for authenticated admin/director callers, or null (and sends 401/403). */
async function getCallerOrgId(req: Request, res: Response): Promise<number | null> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  const user = req.user;

  if (user.role === "super_admin") {
    if (!user.organizationId) {
      res.status(403).json({ error: "Super admin has no organization." });
      return null;
    }
    return user.organizationId;
  }

  if (
    (user.role === "org_admin" || user.role === "tournament_director") &&
    user.organizationId
  ) {
    return user.organizationId;
  }

  const [membership] = await db
    .select({ role: orgMembershipsTable.role, orgId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.userId, user.id));

  if (!membership || !["org_admin", "tournament_director"].includes(membership.role)) {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }
  return membership.orgId;
}

/** Verifies target user is a member of the admin's org. Sends 404 and returns false on failure. */
async function assertOwnedOrgUser(userId: number, orgId: number, res: Response): Promise<boolean> {
  const [row] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));

  if (!row) {
    res.status(404).json({ error: "User not found in your organization." });
    return false;
  }
  return true;
}

/** Verifies target is an org member AND a portal (ep_*) account. For write actions only. */
async function assertOwnedPortalAccount(
  userId: number,
  orgId: number,
  res: Response,
): Promise<boolean> {
  const [row] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(
      and(
        eq(orgMembershipsTable.userId, userId),
        eq(orgMembershipsTable.organizationId, orgId),
        sql`LEFT(${appUsersTable.replitUserId}, 3) = 'ep_'`,
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Portal player account not found in your organization." });
    return false;
  }
  return true;
}

// GET /admin/players — org-scoped member list with search, verified filter, pagination
router.get("/admin/players", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const search = (req.query.search as string) ?? "";
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1") || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50") || 50));
  const offset = (page - 1) * limit;
  const verifiedFilter = req.query.verified as string | undefined;

  // Resolve membership via org_memberships (not app_users.organizationId)
  const baseWhere = and(eq(orgMembershipsTable.organizationId, orgId));

  const extras: ReturnType<typeof eq>[] = [];
  if (verifiedFilter === "verified") extras.push(eq(appUsersTable.emailVerified, true));
  if (verifiedFilter === "unverified") extras.push(eq(appUsersTable.emailVerified, false));

  const searchExtra = search
    ? or(
        ilike(appUsersTable.displayName, `%${search}%`),
        ilike(appUsersTable.email, `%${search}%`),
        ilike(appUsersTable.username, `%${search}%`),
      )!
    : null;

  const fullWhere = searchExtra
    ? and(baseWhere, searchExtra, ...extras)!
    : and(baseWhere, ...extras)!;

  // Total for pagination (filtered) + full-dataset verified/unverified totals (no search filter)
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(fullWhere);

  // Verified/unverified totals always computed against the full org dataset (no search filter)
  const [{ verifiedTotal, unverifiedTotal }] = await db
    .select({
      verifiedTotal: sql<number>`count(*) filter (where ${appUsersTable.emailVerified} = true)`,
      unverifiedTotal: sql<number>`count(*) filter (where ${appUsersTable.emailVerified} = false)`,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(eq(orgMembershipsTable.organizationId, orgId)));

  const rows = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
      role: appUsersTable.role,
      emailVerified: appUsersTable.emailVerified,
      organizationId: appUsersTable.organizationId,
      isPortalAccount: sql<boolean>`LEFT(${appUsersTable.replitUserId}, 3) = 'ep_'`,
      memberRole: orgMembershipsTable.role,
      joinedAt: orgMembershipsTable.joinedAt,
      createdAt: appUsersTable.createdAt,
      updatedAt: appUsersTable.updatedAt,
      profileImage: appUsersTable.profileImage,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(fullWhere)
    .orderBy(sql`${appUsersTable.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

  res.json({
    players: rows,
    total: Number(total),
    verifiedTotal: Number(verifiedTotal),
    unverifiedTotal: Number(unverifiedTotal),
    page,
    limit,
    pages: Math.ceil(Number(total) / limit),
  });
});

// GET /admin/players/:userId — full detail (profile, registrations, orders, memberships, activity)
router.get("/admin/players/:userId", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedOrgUser(userId, orgId, res)) return;

  const [user] = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
      role: appUsersTable.role,
      emailVerified: appUsersTable.emailVerified,
      organizationId: appUsersTable.organizationId,
      isPortalAccount: sql<boolean>`LEFT(${appUsersTable.replitUserId}, 3) = 'ep_'`,
      createdAt: appUsersTable.createdAt,
      updatedAt: appUsersTable.updatedAt,
      hasPassword: sql<boolean>`(${appUsersTable.passwordHash} IS NOT NULL)`,
      profileImage: appUsersTable.profileImage,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));

  if (!user) { { res.status(404).json({ error: "Player not found" }); return; } }

  // Tournament registrations — match by userId OR email (same as existing portal flows)
  const userEmail = user.email ?? "";
  const registrations = await db
    .select({
      playerId: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      phone: playersTable.phone,
      handicapIndex: playersTable.handicapIndex,
      paymentStatus: playersTable.paymentStatus,
      checkedIn: playersTable.checkedIn,
      registeredAt: playersTable.registeredAt,
      tournamentId: tournamentsTable.id,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
      tournamentDate: tournamentsTable.startDate,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(tournamentsTable.organizationId, orgId),
        or(
          eq(playersTable.userId, userId),
          userEmail ? eq(playersTable.email, userEmail) : sql`false`,
        )!,
      ),
    )
    .orderBy(sql`${tournamentsTable.startDate} DESC`);

  // Shop orders scoped to this org
  const shopOrders = await db
    .select({
      id: shopOrdersTable.id,
      productName: shopProductsTable.name,
      quantity: shopOrdersTable.quantity,
      totalAmount: shopOrdersTable.totalAmount,
      currency: shopOrdersTable.currency,
      status: shopOrdersTable.status,
      createdAt: shopOrdersTable.createdAt,
    })
    .from(shopOrdersTable)
    .innerJoin(shopProductsTable, eq(shopOrdersTable.productId, shopProductsTable.id))
    .where(and(eq(shopOrdersTable.userId, userId), eq(shopOrdersTable.organizationId, orgId)))
    .orderBy(sql`${shopOrdersTable.createdAt} DESC`)
    .limit(20);

  // Club membership records scoped to this org
  const clubMemberships = await db
    .select({
      clubMemberId: clubMembersTable.id,
      memberNumber: clubMembersTable.memberNumber,
      subscriptionStatus: clubMembersTable.subscriptionStatus,
      joinDate: clubMembersTable.joinDate,
      renewalDate: clubMembersTable.renewalDate,
      subscriptionId: memberSubscriptionsTable.id,
      subscriptionPlanStatus: memberSubscriptionsTable.status,
      lastPaymentAt: memberSubscriptionsTable.lastPaymentAt,
      nextBillingDate: memberSubscriptionsTable.nextBillingDate,
    })
    .from(clubMembersTable)
    .leftJoin(memberSubscriptionsTable, eq(memberSubscriptionsTable.clubMemberId, clubMembersTable.id))
    .where(and(eq(clubMembersTable.userId, userId), eq(clubMembersTable.organizationId, orgId)))
    .orderBy(sql`${clubMembersTable.joinDate} DESC`)
    .limit(10);

  // Unified recent-activity timeline (newest first, capped at 10)
  const recentActivity: Array<{ type: string; description: string; timestamp: string }> = [];
  for (const r of registrations.slice(0, 5)) {
    recentActivity.push({
      type: "tournament_registration",
      description: `Registered for "${r.tournamentName}"${
        r.paymentStatus === "paid" ? " (payment confirmed)" :
        r.paymentStatus === "pending" ? " (payment pending)" : ""
      }`,
      timestamp: (r.registeredAt instanceof Date ? r.registeredAt.toISOString() : String(r.registeredAt)),
    });
  }
  for (const o of shopOrders.slice(0, 5)) {
    recentActivity.push({
      type: "shop_order",
      description: `Ordered ${o.quantity}× "${o.productName}" — ${o.currency} ${Number(o.totalAmount).toFixed(2)} (${o.status})`,
      timestamp: (o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt)),
    });
  }
  recentActivity.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const paymentSummary = {
    tournamentsRegistered: registrations.length,
    tournamentsPaid: registrations.filter(r => r.paymentStatus === "paid").length,
    tournamentsPending: registrations.filter(r => r.paymentStatus === "pending").length,
    shopOrderCount: shopOrders.length,
    shopTotalSpend: shopOrders
      .filter(o => o.status !== "refunded" && o.status !== "cancelled")
      .reduce((sum, o) => sum + Number(o.totalAmount), 0),
    shopTotalRefunded: shopOrders
      .filter(o => o.status === "refunded")
      .reduce((sum, o) => sum + Number(o.totalAmount), 0),
  };

  // Most recent GHIN number from any player record linked to this user
  const [latestPlayer] = await db
    .select({ ghinNumber: playersTable.ghinNumber })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(tournamentsTable.organizationId, orgId),
        or(
          eq(playersTable.userId, userId),
          userEmail ? eq(playersTable.email, userEmail) : sql`false`,
        )!,
        sql`${playersTable.ghinNumber} IS NOT NULL`,
      ),
    )
    .orderBy(desc(tournamentsTable.startDate))
    .limit(1);

  res.json({
    ...user,
    ghinNumber: latestPlayer?.ghinNumber ?? null,
    registrations,
    shopOrders,
    clubMemberships,
    recentActivity: recentActivity.slice(0, 10),
    paymentSummary,
  });
});

// DELETE /admin/players/:userId/avatar — admin removes a player's profile photo
router.delete("/admin/players/:userId/avatar", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedOrgUser(userId, orgId, res)) return;

  await db.update(appUsersTable).set({ profileImage: null, updatedAt: new Date() }).where(eq(appUsersTable.id, userId));
  res.json({ profileImage: null });
});

// PATCH /admin/players/:userId — edit display name and/or email
router.patch("/admin/players/:userId", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedOrgUser(userId, orgId, res)) return;

  const { displayName, email } = req.body;
  if (displayName === undefined && email === undefined) {
    res.status(400).json({ error: "At least one of displayName or email is required" });
    return;
  }

  const updateData: { displayName?: string | null; email?: string; username?: string; updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (displayName !== undefined) {
    updateData.displayName = displayName ? String(displayName).trim() || null : null;
  }

  if (email !== undefined) {
    const normalized = String(email).toLowerCase().trim();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      res.status(400).json({ error: "A valid email address is required" });
      return;
    }
    const [conflict] = await db
      .select({ id: appUsersTable.id })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.email, normalized), sql`${appUsersTable.id} != ${userId}`));
    if (conflict) {
      res.status(409).json({ error: "This email is already in use by another account" });
      return;
    }
    updateData.email = normalized;
    // Only sync username for portal accounts (ep_*); Replit OAuth accounts use their Replit username
    const [acct] = await db
      .select({ replitUserId: appUsersTable.replitUserId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId));
    if (acct?.replitUserId?.startsWith("ep_")) {
      updateData.username = normalized;
    }
  }

  const [updated] = await db
    .update(appUsersTable)
    .set(updateData)
    .where(eq(appUsersTable.id, userId))
    .returning({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      username: appUsersTable.username,
      role: appUsersTable.role,
      emailVerified: appUsersTable.emailVerified,
    });

  if (!updated) { { res.status(404).json({ error: "Player not found" }); return; } }
  res.json(updated);
});

// PATCH /admin/players/:userId/ghin — set/clear GHIN number on all player records for this user
router.patch("/admin/players/:userId/ghin", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedOrgUser(userId, orgId, res)) return;

  const { ghinNumber } = req.body;
  const normalized = ghinNumber ? String(ghinNumber).trim() || null : null;

  // Update all player records in this org linked to this user
  const [user] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user) { { res.status(404).json({ error: "Player not found" }); return; } }

  const userEmail = user.email ?? "";
  const playerIds = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(tournamentsTable.organizationId, orgId),
        or(
          eq(playersTable.userId, userId),
          userEmail ? eq(playersTable.email, userEmail) : sql`false`,
        )!,
      ),
    );

  if (playerIds.length > 0) {
    for (const { id } of playerIds) {
      await db.update(playersTable).set({ ghinNumber: normalized }).where(eq(playersTable.id, id));
    }
  }

  res.json({ ghinNumber: normalized, updatedCount: playerIds.length });
});

// POST /admin/players/:userId/send-password-reset — portal accounts only
router.post("/admin/players/:userId/send-password-reset", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedPortalAccount(userId, orgId, res)) return;

  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user || !user.email) {
    res.status(404).json({ error: "Player not found or has no email" });
    return;
  }
  if (!user.passwordHash) {
    res.status(400).json({ error: "This account does not use password authentication" });
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpiry = new Date(Date.now() + 60 * 60 * 1000);

  await db
    .update(appUsersTable)
    .set({ passwordResetToken: resetToken, passwordResetExpiry: resetExpiry, updatedAt: new Date() })
    .where(eq(appUsersTable.id, userId));

  const baseUrl = getOrigin(req);
  try {
    await sendPasswordResetEmail(user.email, user.displayName ?? user.username, resetToken, baseUrl);
    res.json({ message: `Password reset email sent to ${user.email}` });
  } catch (err) {
    req.log.error({ err, userId }, "Failed to send admin-initiated password reset email");
    res.status(500).json({ error: "Failed to send password reset email. Check email configuration." });
  }
});

// POST /admin/players/:userId/force-verify — portal accounts only
router.post("/admin/players/:userId/force-verify", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedPortalAccount(userId, orgId, res)) return;

  const [updated] = await db
    .update(appUsersTable)
    .set({ emailVerified: true, emailVerificationToken: null, emailVerificationExpiry: null, updatedAt: new Date() })
    .where(eq(appUsersTable.id, userId))
    .returning({ id: appUsersTable.id, emailVerified: appUsersTable.emailVerified });

  if (!updated) { { res.status(404).json({ error: "Player not found" }); return; } }
  res.json({ message: "Email marked as verified", emailVerified: true });
});

// POST /admin/players/:userId/set-password — portal accounts only; bcrypt-hashed
router.post("/admin/players/:userId/set-password", async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(userId)) { { res.status(400).json({ error: "Invalid user ID" }); return; } }

  if (!await assertOwnedPortalAccount(userId, orgId, res)) return;

  const { password } = req.body;
  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "password is required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db
    .update(appUsersTable)
    .set({ passwordHash, passwordResetToken: null, passwordResetExpiry: null, updatedAt: new Date() })
    .where(eq(appUsersTable.id, userId));

  res.json({ message: "Password updated successfully" });
});

export default router;
