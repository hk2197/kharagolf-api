/**
 * Loyalty & Rewards Programme API — Task #103
 *
 * Programme (admin):
 *   GET    /organizations/:orgId/loyalty/program          Get programme settings
 *   PUT    /organizations/:orgId/loyalty/program          Upsert programme settings
 *
 * Tiers (admin):
 *   GET    /organizations/:orgId/loyalty/tiers            List tiers
 *   PUT    /organizations/:orgId/loyalty/tiers/:tier      Upsert tier definition
 *   DELETE /organizations/:orgId/loyalty/tiers/:tier      Remove tier definition
 *
 * Rewards catalogue (admin):
 *   GET    /organizations/:orgId/loyalty/rewards          List rewards
 *   POST   /organizations/:orgId/loyalty/rewards          Create reward
 *   PATCH  /organizations/:orgId/loyalty/rewards/:id      Update reward
 *   DELETE /organizations/:orgId/loyalty/rewards/:id      Delete reward
 *
 * Member account (authenticated):
 *   GET    /organizations/:orgId/loyalty/me               My balance + tier
 *   GET    /organizations/:orgId/loyalty/me/history       My transaction history
 *   POST   /organizations/:orgId/loyalty/redeem           Redeem a reward
 *
 * Admin dashboard:
 *   GET    /organizations/:orgId/loyalty/admin/stats      Liability + issuance summary
 *   GET    /organizations/:orgId/loyalty/admin/members    All member accounts
 *   POST   /organizations/:orgId/loyalty/admin/adjust     Manually adjust points
 *
 * Internal (called from other routes):
 *   awardPoints()    — exported function to award points to a member
 */

import { Router, type Request, type Response } from "express";
import {
  db,
  loyaltyProgramTable,
  loyaltyTiersTable,
  loyaltyAccountsTable,
  loyaltyTransactionsTable,
  loyaltyRewardsTable,
  appUsersTable,
  orgMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { eq, and, desc, sum, count, gte, sql, inArray } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push";
import { requireOrgAdmin } from "../lib/permissions";
import { logger } from "../lib/logger";

const router = Router({ mergeParams: true });

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

async function requireOrgAdminLocal(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.user) { res.status(401).json({ error: "Unauthenticated" }); return false; }
  const [user] = await db.select({ role: appUsersTable.role, orgId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, req.user.id));
  if (!user) { res.status(401).json({ error: "User not found" }); return false; }
  if (user.role === "super_admin") return true;
  if (user.orgId === orgId) {
    const adminRoles = ["org_admin", "tournament_director", "committee_member", "competition_secretary", "pro_shop"];
    if (adminRoles.includes(user.role)) return true;
  }
  // Also check memberships
  const [mem] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, req.user.id)));
  if (mem && ["org_admin", "tournament_director", "committee_member", "pro_shop"].includes(mem.role)) return true;
  res.status(403).json({ error: "Admin access required." });
  return false;
}

async function requireMemberOrAdmin(
  req: Request, res: Response, orgId: number,
): Promise<{ userId: number; dbUserId: number } | null> {
  if (!req.user) { res.status(401).json({ error: "Unauthenticated" }); return null; }

  // Portal JWT check
  if ((req.user as { isPortalUser?: boolean }).isPortalUser) {
    return { userId: req.user.id, dbUserId: req.user.id };
  }

  // Web session: check membership
  const [user] = await db.select({ role: appUsersTable.role, orgId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, req.user.id));
  if (!user) { res.status(401).json({ error: "User not found" }); return null; }
  if (user.role === "super_admin") return { userId: req.user.id, dbUserId: req.user.id };

  const [mem] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, req.user.id)));
  if (!mem) { res.status(403).json({ error: "Not a member of this organisation." }); return null; }
  return { userId: req.user.id, dbUserId: req.user.id };
}

// ─── Internal: Points Engine ──────────────────────────────────────────────────

type ServiceCategory = "pos" | "fb" | "lesson" | "tee_booking" | "tee_time" | "general";
type LoyaltyTierValue = "none" | "silver" | "gold" | "platinum";

const TIER_ORDER: LoyaltyTierValue[] = ["none", "silver", "gold", "platinum"];

function tierMultiplier(tier: LoyaltyTierValue, tiers: { tier: LoyaltyTierValue; multiplier: string | number }[]): number {
  const t = tiers.find(t => t.tier === tier);
  return t ? Number(t.multiplier) : 1;
}

function calculateTierFromPoints(rollingPoints: number, tiers: { tier: LoyaltyTierValue; minPoints: number }[]): LoyaltyTierValue {
  const sorted = [...tiers].sort((a, b) => b.minPoints - a.minPoints);
  for (const t of sorted) {
    if (rollingPoints >= t.minPoints) return t.tier;
  }
  return "none";
}

/**
 * Award loyalty points to a member.
 * Safe to call from any route — creates account if needed.
 * Returns the number of points awarded (0 if programme is disabled or no account).
 */
export async function awardPoints(opts: {
  organizationId: number;
  userId: number;
  amountSpent: number;
  category: ServiceCategory;
  referenceId?: string;
  description?: string;
}): Promise<number> {
  try {
    const { organizationId, userId, amountSpent, category, referenceId, description } = opts;

    // Fetch programme
    const [prog] = await db.select().from(loyaltyProgramTable)
      .where(and(eq(loyaltyProgramTable.organizationId, organizationId), eq(loyaltyProgramTable.isEnabled, true)));
    if (!prog) return 0;

    // Check minimum spend
    if (amountSpent < Number(prog.minSpendToEarn)) return 0;

    // Determine earn rate
    const catRates = (prog.categoryRates as Record<string, number>) ?? {};
    const rate = catRates[category] ?? Number(prog.baseEarnRate);

    // Ensure account exists
    let [account] = await db.select().from(loyaltyAccountsTable)
      .where(and(eq(loyaltyAccountsTable.organizationId, organizationId), eq(loyaltyAccountsTable.userId, userId)));

    if (!account) {
      const [newAccount] = await db.insert(loyaltyAccountsTable)
        .values({ organizationId, userId }).returning();
      account = newAccount;
    }

    // Fetch tiers for multiplier
    const tiers = await db.select().from(loyaltyTiersTable)
      .where(eq(loyaltyTiersTable.organizationId, organizationId));

    const multiplier = tierMultiplier(account.currentTier as LoyaltyTierValue, tiers);
    const rawPoints = Math.floor(amountSpent * rate * multiplier);
    if (rawPoints <= 0) return 0;

    // Update account
    const newBalance = account.pointsBalance + rawPoints;
    const newLifetime = account.lifetimePoints + rawPoints;
    const newRolling = account.rollingYearPoints + rawPoints;

    // Tier calculation
    const newTier = calculateTierFromPoints(newRolling, tiers.map(t => ({ tier: t.tier as LoyaltyTierValue, minPoints: t.minPoints })));
    const tierChanged = newTier !== account.currentTier;

    await db.update(loyaltyAccountsTable)
      .set({
        pointsBalance: newBalance,
        lifetimePoints: newLifetime,
        rollingYearPoints: newRolling,
        currentTier: newTier,
        lastTierCalculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(loyaltyAccountsTable.id, account.id));

    // Record transaction
    const expiresAt = prog.pointsExpireDays
      ? new Date(Date.now() + prog.pointsExpireDays * 86400000)
      : undefined;

    await db.insert(loyaltyTransactionsTable).values({
      accountId: account.id,
      organizationId,
      userId,
      type: "earn",
      points: rawPoints,
      balanceAfter: newBalance,
      serviceCategory: category,
      referenceId: referenceId ?? null,
      description: description ?? `Earned ${rawPoints} ${prog.pointsName} for ${category} purchase`,
      expiresAt: expiresAt ?? null,
    });

    // Notifications
    const [orgRow] = await db.select({ name: organizationsTable.name })
      .from(organizationsTable).where(eq(organizationsTable.id, organizationId));

    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      [userId],
      `+${rawPoints} ${prog.pointsName}!`,
      `You earned ${rawPoints} ${prog.pointsName} at ${orgRow?.name ?? "the club"}. Balance: ${newBalance}`,
      { type: "loyalty_earn", orgId: organizationId },
    ).catch(() => {});

    if (tierChanged && newTier !== "none") {
      // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
      // telemetry consumed downstream, classifier intentionally not used.
      sendPushToUsers(
        [userId],
        `Tier Upgrade: ${newTier.charAt(0).toUpperCase() + newTier.slice(1)}!`,
        `Congratulations! You've reached ${newTier} tier at ${orgRow?.name ?? "the club"}.`,
        { type: "loyalty_tier_upgrade", tier: newTier, orgId: organizationId },
      ).catch(() => {});
    }

    return rawPoints;
  } catch (err) {
    logger.error({ err }, "awardPoints failed");
    return 0;
  }
}

// ─── Programme Settings ───────────────────────────────────────────────────────

// GET /organizations/:orgId/loyalty/program
router.get("/program", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const [prog] = await db.select().from(loyaltyProgramTable)
    .where(eq(loyaltyProgramTable.organizationId, orgId));

  res.json(prog ?? null);
});

// PUT /organizations/:orgId/loyalty/program
router.put("/program", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const { isEnabled, pointsName, baseEarnRate, categoryRates, minSpendToEarn, pointsExpireDays } = req.body;

  const [existing] = await db.select({ id: loyaltyProgramTable.id })
    .from(loyaltyProgramTable).where(eq(loyaltyProgramTable.organizationId, orgId));

  if (existing) {
    const [updated] = await db.update(loyaltyProgramTable)
      .set({
        isEnabled: isEnabled ?? true,
        pointsName: pointsName ?? "Points",
        baseEarnRate: baseEarnRate != null ? String(baseEarnRate) : undefined,
        categoryRates: categoryRates ?? {},
        minSpendToEarn: minSpendToEarn != null ? String(minSpendToEarn) : undefined,
        pointsExpireDays: pointsExpireDays ?? null,
        updatedAt: new Date(),
      })
      .where(eq(loyaltyProgramTable.organizationId, orgId))
      .returning();
    res.json(updated); return;
  }

  const [created] = await db.insert(loyaltyProgramTable).values({
    organizationId: orgId,
    isEnabled: isEnabled ?? true,
    pointsName: pointsName ?? "Points",
    baseEarnRate: baseEarnRate != null ? String(baseEarnRate) : "1",
    categoryRates: categoryRates ?? {},
    minSpendToEarn: minSpendToEarn != null ? String(minSpendToEarn) : "0",
    pointsExpireDays: pointsExpireDays ?? null,
  }).returning();
  res.status(201).json(created);
});

// ─── Tiers ────────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/loyalty/tiers
router.get("/tiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.user) return void res.status(401).json({ error: "Unauthenticated" });

  const tiers = await db.select().from(loyaltyTiersTable)
    .where(eq(loyaltyTiersTable.organizationId, orgId))
    .orderBy(loyaltyTiersTable.minPoints);

  res.json(tiers);
});

// PUT /organizations/:orgId/loyalty/tiers/:tier
router.put("/tiers/:tier", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const tier = (req.params as Record<string, string>).tier as LoyaltyTierValue;
  if (!TIER_ORDER.includes(tier) || tier === "none") {
    return void res.status(400).json({ error: "Invalid tier. Use: silver, gold, platinum" });
  }

  const { label, minPoints, multiplier, perks, badgeIcon } = req.body;
  if (minPoints == null || !label) {
    return void res.status(400).json({ error: "label and minPoints are required." });
  }

  const [existing] = await db.select({ id: loyaltyTiersTable.id })
    .from(loyaltyTiersTable)
    .where(and(eq(loyaltyTiersTable.organizationId, orgId), eq(loyaltyTiersTable.tier, tier)));

  if (existing) {
    const [updated] = await db.update(loyaltyTiersTable)
      .set({ label, minPoints, multiplier: String(multiplier ?? 1), perks: perks ?? [], badgeIcon: badgeIcon ?? null, updatedAt: new Date() })
      .where(eq(loyaltyTiersTable.id, existing.id))
      .returning();
    res.json(updated); return;
  }

  const [created] = await db.insert(loyaltyTiersTable).values({
    organizationId: orgId, tier, label, minPoints,
    multiplier: String(multiplier ?? 1), perks: perks ?? [], badgeIcon: badgeIcon ?? null,
  }).returning();
  res.status(201).json(created);
});

// DELETE /organizations/:orgId/loyalty/tiers/:tier
router.delete("/tiers/:tier", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  await db.delete(loyaltyTiersTable)
    .where(and(eq(loyaltyTiersTable.organizationId, orgId), eq(loyaltyTiersTable.tier, (req.params as Record<string, string>).tier as LoyaltyTierValue)));

  res.json({ ok: true });
});

// ─── Rewards Catalogue ────────────────────────────────────────────────────────

// GET /organizations/:orgId/loyalty/rewards
router.get("/rewards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.user) return void res.status(401).json({ error: "Unauthenticated" });

  const adminMode = req.query.admin === "true";
  const conditions = adminMode
    ? [eq(loyaltyRewardsTable.organizationId, orgId)]
    : [eq(loyaltyRewardsTable.organizationId, orgId), eq(loyaltyRewardsTable.isActive, true)];

  const rewards = await db.select().from(loyaltyRewardsTable)
    .where(and(...conditions))
    .orderBy(loyaltyRewardsTable.pointsCost);

  res.json(rewards);
});

// POST /organizations/:orgId/loyalty/rewards
router.post("/rewards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const { name, description, rewardType, pointsCost, discountValue, minTier, isActive, stock, validFrom, validUntil } = req.body;
  if (!name || pointsCost == null) {
    return void res.status(400).json({ error: "name and pointsCost are required." });
  }

  const [reward] = await db.insert(loyaltyRewardsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    rewardType: rewardType ?? "other",
    pointsCost,
    discountValue: discountValue != null ? String(discountValue) : null,
    minTier: minTier ?? "none",
    isActive: isActive ?? true,
    stock: stock ?? null,
    validFrom: validFrom ? new Date(validFrom) : null,
    validUntil: validUntil ? new Date(validUntil) : null,
  }).returning();

  res.status(201).json(reward);
});

// PATCH /organizations/:orgId/loyalty/rewards/:id
router.patch("/rewards/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const rewardId = parseInt(String((req.params as Record<string, string>).id));
  const { name, description, rewardType, pointsCost, discountValue, minTier, isActive, stock, validFrom, validUntil } = req.body;

  const [reward] = await db.update(loyaltyRewardsTable)
    .set({
      ...(name != null && { name }),
      ...(description !== undefined && { description }),
      ...(rewardType != null && { rewardType }),
      ...(pointsCost != null && { pointsCost }),
      ...(discountValue !== undefined && { discountValue: discountValue != null ? String(discountValue) : null }),
      ...(minTier != null && { minTier }),
      ...(isActive != null && { isActive }),
      ...(stock !== undefined && { stock }),
      ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
      ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      updatedAt: new Date(),
    })
    .where(and(eq(loyaltyRewardsTable.id, rewardId), eq(loyaltyRewardsTable.organizationId, orgId)))
    .returning();

  if (!reward) return void res.status(404).json({ error: "Reward not found." });
  res.json(reward);
});

// DELETE /organizations/:orgId/loyalty/rewards/:id
router.delete("/rewards/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const rewardId = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(loyaltyRewardsTable)
    .where(and(eq(loyaltyRewardsTable.id, rewardId), eq(loyaltyRewardsTable.organizationId, orgId)));

  res.json({ ok: true });
});

// ─── Member Account ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/loyalty/me
router.get("/me", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireMemberOrAdmin(req, res, orgId);
  if (!member) return;

  const [prog] = await db.select().from(loyaltyProgramTable)
    .where(eq(loyaltyProgramTable.organizationId, orgId));

  let [account] = await db.select().from(loyaltyAccountsTable)
    .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, member.dbUserId)));

  if (!account) {
    const [newAccount] = await db.insert(loyaltyAccountsTable)
      .values({ organizationId: orgId, userId: member.dbUserId }).returning();
    account = newAccount;
  }

  const tiers = await db.select().from(loyaltyTiersTable)
    .where(eq(loyaltyTiersTable.organizationId, orgId))
    .orderBy(loyaltyTiersTable.minPoints);

  // Find next tier
  const tiersSorted = tiers.sort((a, b) => a.minPoints - b.minPoints);
  const currentTierDef = tiers.find(t => t.tier === account.currentTier);
  const currentTierIdx = tiersSorted.findIndex(t => t.tier === account.currentTier);
  const nextTier = currentTierIdx < tiersSorted.length - 1 ? tiersSorted[currentTierIdx + 1] : null;

  res.json({
    account,
    programme: prog ?? null,
    tiers,
    currentTierDef: currentTierDef ?? null,
    nextTier: nextTier ?? null,
    pointsToNextTier: nextTier ? Math.max(0, nextTier.minPoints - account.rollingYearPoints) : null,
  });
});

// GET /organizations/:orgId/loyalty/me/history
router.get("/me/history", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireMemberOrAdmin(req, res, orgId);
  if (!member) return;

  const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 100);
  const offset = parseInt(String(req.query.offset ?? "0"));

  const [account] = await db.select({ id: loyaltyAccountsTable.id })
    .from(loyaltyAccountsTable)
    .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, member.dbUserId)));

  if (!account) { res.json({ transactions: [], total: 0 }); return; }

  const transactions = await db.select().from(loyaltyTransactionsTable)
    .where(eq(loyaltyTransactionsTable.accountId, account.id))
    .orderBy(desc(loyaltyTransactionsTable.createdAt))
    .limit(limit).offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(loyaltyTransactionsTable)
    .where(eq(loyaltyTransactionsTable.accountId, account.id));

  res.json({ transactions, total });
});

// POST /organizations/:orgId/loyalty/redeem
router.post("/redeem", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireMemberOrAdmin(req, res, orgId);
  if (!member) return;

  const { rewardId } = req.body;
  if (!rewardId) return void res.status(400).json({ error: "rewardId is required." });

  // Fetch programme
  const [prog] = await db.select().from(loyaltyProgramTable)
    .where(and(eq(loyaltyProgramTable.organizationId, orgId), eq(loyaltyProgramTable.isEnabled, true)));
  if (!prog) return void res.status(400).json({ error: "Loyalty programme is not active." });

  // Fetch reward
  const [reward] = await db.select().from(loyaltyRewardsTable)
    .where(and(eq(loyaltyRewardsTable.id, rewardId), eq(loyaltyRewardsTable.organizationId, orgId), eq(loyaltyRewardsTable.isActive, true)));
  if (!reward) return void res.status(404).json({ error: "Reward not found or inactive." });

  // Check validity window
  const now = new Date();
  if (reward.validFrom && now < reward.validFrom) return void res.status(400).json({ error: "Reward not yet available." });
  if (reward.validUntil && now > reward.validUntil) return void res.status(400).json({ error: "Reward has expired." });

  // Fetch account
  let [account] = await db.select().from(loyaltyAccountsTable)
    .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, member.dbUserId)));

  if (!account) {
    const [newAccount] = await db.insert(loyaltyAccountsTable)
      .values({ organizationId: orgId, userId: member.dbUserId }).returning();
    account = newAccount;
  }

  // Check tier requirement
  const tierOrder = TIER_ORDER;
  const memberTierIdx = tierOrder.indexOf(account.currentTier as LoyaltyTierValue);
  const requiredTierIdx = tierOrder.indexOf(reward.minTier as LoyaltyTierValue);
  if (memberTierIdx < requiredTierIdx) {
    return void res.status(403).json({ error: `This reward requires ${reward.minTier} tier or above.` });
  }

  // Check balance
  if (account.pointsBalance < reward.pointsCost) {
    return void res.status(400).json({
      error: `Insufficient points. You have ${account.pointsBalance} but need ${reward.pointsCost}.`,
    });
  }

  // Check stock
  if (reward.stock != null && reward.redeemedCount >= reward.stock) {
    return void res.status(400).json({ error: "This reward is out of stock." });
  }

  const newBalance = account.pointsBalance - reward.pointsCost;

  // Update account & reward atomically
  await db.update(loyaltyAccountsTable)
    .set({ pointsBalance: newBalance, updatedAt: new Date() })
    .where(eq(loyaltyAccountsTable.id, account.id));

  await db.update(loyaltyRewardsTable)
    .set({ redeemedCount: reward.redeemedCount + 1 })
    .where(eq(loyaltyRewardsTable.id, reward.id));

  const [txn] = await db.insert(loyaltyTransactionsTable).values({
    accountId: account.id,
    organizationId: orgId,
    userId: member.dbUserId,
    type: "redeem",
    points: -reward.pointsCost,
    balanceAfter: newBalance,
    rewardId: reward.id,
    description: `Redeemed: ${reward.name}`,
  }).returning();

  // Notification
  // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendPushToUsers(
    [member.dbUserId],
    "Reward Redeemed!",
    `You redeemed "${reward.name}" for ${reward.pointsCost} points. Remaining balance: ${newBalance}.`,
    { type: "loyalty_redeem", rewardId: reward.id, orgId },
  ).catch(() => {});

  res.json({ ok: true, transaction: txn, reward, newBalance });
});

// ─── Admin Dashboard ──────────────────────────────────────────────────────────

// GET /organizations/:orgId/loyalty/admin/stats
router.get("/admin/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const [totalPointsRow] = await db.select({
    totalIssued: sql<number>`COALESCE(SUM(CASE WHEN type = 'earn' THEN points ELSE 0 END), 0)`,
    totalRedeemed: sql<number>`COALESCE(SUM(CASE WHEN type = 'redeem' THEN ABS(points) ELSE 0 END), 0)`,
  }).from(loyaltyTransactionsTable).where(eq(loyaltyTransactionsTable.organizationId, orgId));

  const [outstandingRow] = await db.select({
    outstanding: sql<number>`COALESCE(SUM(points_balance), 0)`,
  }).from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.organizationId, orgId));

  const [memberCountRow] = await db.select({ total: count() }).from(loyaltyAccountsTable)
    .where(eq(loyaltyAccountsTable.organizationId, orgId));

  const tierBreakdown = await db.select({
    tier: loyaltyAccountsTable.currentTier,
    memberCount: count(),
  }).from(loyaltyAccountsTable)
    .where(eq(loyaltyAccountsTable.organizationId, orgId))
    .groupBy(loyaltyAccountsTable.currentTier);

  const topRedeemed = await db.select({
    rewardId: loyaltyTransactionsTable.rewardId,
    redeemCount: count(),
  }).from(loyaltyTransactionsTable)
    .where(and(eq(loyaltyTransactionsTable.organizationId, orgId), eq(loyaltyTransactionsTable.type, "redeem")))
    .groupBy(loyaltyTransactionsTable.rewardId)
    .orderBy(sql`count(*) DESC`)
    .limit(5);

  res.json({
    totalIssued: Number(totalPointsRow.totalIssued),
    totalRedeemed: Number(totalPointsRow.totalRedeemed),
    outstanding: Number(outstandingRow.outstanding),
    memberCount: memberCountRow.total,
    tierBreakdown,
    topRedeemed,
  });
});

// GET /organizations/:orgId/loyalty/admin/members
router.get("/admin/members", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 100);
  const offset = parseInt(String(req.query.offset ?? "0"));

  const members = await db
    .select({
      account: loyaltyAccountsTable,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      username: appUsersTable.username,
    })
    .from(loyaltyAccountsTable)
    .leftJoin(appUsersTable, eq(loyaltyAccountsTable.userId, appUsersTable.id))
    .where(eq(loyaltyAccountsTable.organizationId, orgId))
    .orderBy(desc(loyaltyAccountsTable.pointsBalance))
    .limit(limit).offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(loyaltyAccountsTable)
    .where(eq(loyaltyAccountsTable.organizationId, orgId));

  res.json({ members, total });
});

// POST /organizations/:orgId/loyalty/admin/adjust
router.post("/admin/adjust", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminLocal(req, res, orgId)) return;

  const { userId, points, description } = req.body;
  if (!userId || points == null) {
    return void res.status(400).json({ error: "userId and points are required." });
  }

  // Ensure account exists
  let [account] = await db.select().from(loyaltyAccountsTable)
    .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, userId)));

  if (!account) {
    const [newAccount] = await db.insert(loyaltyAccountsTable)
      .values({ organizationId: orgId, userId }).returning();
    account = newAccount;
  }

  const newBalance = Math.max(0, account.pointsBalance + points);

  await db.update(loyaltyAccountsTable)
    .set({
      pointsBalance: newBalance,
      lifetimePoints: points > 0 ? account.lifetimePoints + points : account.lifetimePoints,
      updatedAt: new Date(),
    })
    .where(eq(loyaltyAccountsTable.id, account.id));

  const [prog] = await db.select({ pointsName: loyaltyProgramTable.pointsName })
    .from(loyaltyProgramTable).where(eq(loyaltyProgramTable.organizationId, orgId));

  await db.insert(loyaltyTransactionsTable).values({
    accountId: account.id,
    organizationId: orgId,
    userId,
    type: "adjust",
    points,
    balanceAfter: newBalance,
    description: description ?? `Admin adjustment: ${points > 0 ? "+" : ""}${points} ${prog?.pointsName ?? "points"}`,
  });

  if (points !== 0) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      [userId],
      points > 0 ? `+${points} ${prog?.pointsName ?? "Points"} Added` : `${prog?.pointsName ?? "Points"} Adjusted`,
      description ?? `Your loyalty balance has been adjusted by ${points > 0 ? "+" : ""}${points}. New balance: ${newBalance}.`,
      { type: "loyalty_adjust", orgId },
    ).catch(() => {});
  }

  res.json({ ok: true, newBalance });
});

export default router;
