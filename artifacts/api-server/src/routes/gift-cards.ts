import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  giftCardsTable, giftCardRedemptionsTable,
  storeCreditAccountsTable, storeCreditTransactionsTable,
  orgMembershipsTable, clubMembersTable,
} from "@workspace/db";
import { eq, and, desc, ilike, or, sum, count, gte, lte } from "drizzle-orm";
import crypto from "crypto";
import nodemailer from "nodemailer";

const router: IRouter = Router({ mergeParams: true });

// ─── AUTH HELPERS ──────────────────────────────────────────────────────────────

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director" || user.role === "pro_shop") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
    ));
  if (!m || !["org_admin", "tournament_director", "pro_shop"].includes(m.role)) {
    res.status(403).json({ error: "Admin or pro shop access required" });
    return false;
  }
  return true;
}

// ─── CODE GENERATION ──────────────────────────────────────────────────────────

function generateGiftCardCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `GC-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

// ─── EMAIL HELPER ─────────────────────────────────────────────────────────────

async function sendGiftCardEmail(card: {
  code: string;
  recipientName: string | null;
  recipientEmail: string | null;
  purchaserName: string | null;
  message: string | null;
  initialBalancePaise: number;
  currency: string;
  expiresAt: Date | null;
}) {
  if (!card.recipientEmail) return;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: parseInt(process.env.SMTP_PORT ?? "587"),
    secure: false,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  const amount = (card.initialBalancePaise / 100).toFixed(2);
  const symbol = card.currency === "INR" ? "₹" : card.currency;
  const expiry = card.expiresAt ? card.expiresAt.toLocaleDateString("en-IN") : "No expiry";

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "noreply@kharagolf.com",
    to: card.recipientEmail,
    subject: `Your KharaGolf Gift Card — ${symbol}${amount}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;padding:32px;border-radius:12px;">
        <h2 style="color:#1e4d2b;margin-top:0;">🎁 You've received a Gift Card!</h2>
        ${card.purchaserName ? `<p>From <strong>${card.purchaserName}</strong></p>` : ""}
        ${card.message ? `<blockquote style="border-left:3px solid #1e4d2b;padding-left:16px;color:#555;">${card.message}</blockquote>` : ""}
        <div style="background:#1e4d2b;color:#fff;border-radius:8px;padding:24px;text-align:center;margin:24px 0;">
          <p style="margin:0 0 8px;font-size:14px;opacity:0.8;">Your Gift Card Code</p>
          <p style="margin:0;font-size:28px;font-weight:bold;letter-spacing:4px;">${card.code}</p>
          <p style="margin:16px 0 0;font-size:20px;">${symbol}${amount}</p>
        </div>
        <p style="color:#666;font-size:14px;">Valid until: ${expiry}</p>
        <p style="color:#666;font-size:14px;">Present this code at the Pro Shop or use it when booking online.</p>
      </div>
    `,
  }).catch((e) => { console.warn("[gift-card-email] SMTP send failed:", e.message); });
}

// ─── GIFT CARD ROUTES ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/gift-cards
// Admin: list all gift cards with filters
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, q, page: pageStr, limit: limitStr } = req.query;
  const page = Math.max(1, parseInt(String(pageStr ?? "1")));
  const limit = Math.min(100, Math.max(1, parseInt(String(limitStr ?? "50"))));
  const offset = (page - 1) * limit;

  const conditions: ReturnType<typeof eq>[] = [eq(giftCardsTable.organizationId, orgId)];
  if (status && typeof status === "string" && ["active", "redeemed", "expired", "cancelled"].includes(status)) {
    conditions.push(eq(giftCardsTable.status, status as "active" | "redeemed" | "expired" | "cancelled"));
  }
  if (q && typeof q === "string" && q.trim()) {
    const term = `%${q.trim()}%`;
    conditions.push(
      or(
        ilike(giftCardsTable.code, term),
        ilike(giftCardsTable.recipientName, term),
        ilike(giftCardsTable.recipientEmail, term),
        ilike(giftCardsTable.purchaserName, term),
      ) as ReturnType<typeof eq>
    );
  }

  const [cards, [{ total }]] = await Promise.all([
    db.select().from(giftCardsTable)
      .where(and(...conditions))
      .orderBy(desc(giftCardsTable.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(giftCardsTable).where(and(...conditions)),
  ]);

  res.json({ cards, total, page, limit });
});

// POST /organizations/:orgId/gift-cards
// Admin: issue a new gift card (manual issuance)
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = req.user as { id: number };

  const {
    type = "digital",
    amountRupees,
    recipientName,
    recipientEmail,
    recipientPhone,
    purchaserName,
    message,
    linkedMemberId,
    expiryDays,
  } = req.body;

  if (!amountRupees || isNaN(parseFloat(amountRupees)) || parseFloat(amountRupees) <= 0) {
    res.status(400).json({ error: "A positive amount is required." });
    return;
  }

  const initialBalancePaise = Math.round(parseFloat(amountRupees) * 100);
  let code: string;
  let attempts = 0;

  do {
    code = generateGiftCardCode();
    const [existing] = await db.select({ id: giftCardsTable.id }).from(giftCardsTable)
      .where(and(eq(giftCardsTable.organizationId, orgId), eq(giftCardsTable.code, code)));
    if (!existing) break;
    attempts++;
  } while (attempts < 5);

  const expiresAt = expiryDays && parseInt(expiryDays) > 0
    ? new Date(Date.now() + parseInt(expiryDays) * 24 * 60 * 60 * 1000)
    : null;

  const [card] = await db.insert(giftCardsTable).values({
    organizationId: orgId,
    code,
    type: type as "physical" | "digital",
    status: "active",
    initialBalancePaise,
    currentBalancePaise: initialBalancePaise,
    recipientName: recipientName ?? null,
    recipientEmail: recipientEmail ?? null,
    recipientPhone: recipientPhone ?? null,
    purchaserName: purchaserName ?? null,
    message: message ?? null,
    issuedByUserId: user.id,
    linkedMemberId: linkedMemberId ?? null,
    expiresAt,
  }).returning();

  if (card.type === "digital" && card.recipientEmail) {
    await sendGiftCardEmail(card);
    await db.update(giftCardsTable)
      .set({ emailSentAt: new Date() })
      .where(eq(giftCardsTable.id, card.id));
  }

  res.status(201).json(card);
});

// GET /organizations/:orgId/gift-cards/lookup?code=
// Validate & check balance of a gift card (used at POS and checkout)
router.get("/lookup", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const { code } = req.query;
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Gift card code is required." });
    return;
  }

  const [card] = await db.select().from(giftCardsTable)
    .where(and(
      eq(giftCardsTable.organizationId, orgId),
      eq(giftCardsTable.code, code.trim().toUpperCase()),
    ));

  if (!card) {
    res.status(404).json({ error: "Gift card not found." });
    return;
  }

  if (card.status === "expired" || (card.expiresAt && new Date() > card.expiresAt)) {
    if (card.status !== "expired") {
      await db.update(giftCardsTable).set({ status: "expired" }).where(eq(giftCardsTable.id, card.id));
    }
    res.json({ valid: false, reason: "expired", card });
    return;
  }

  if (card.status === "cancelled") {
    res.json({ valid: false, reason: "cancelled", card });
    return;
  }

  if (card.currentBalancePaise <= 0) {
    res.json({ valid: false, reason: "zero_balance", card });
    return;
  }

  res.json({ valid: true, card });
});

// POST /organizations/:orgId/gift-cards/:cardId/redeem
// Redeem a gift card (partial or full)
router.post("/:cardId/redeem", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cardId = parseInt(String((req.params as Record<string, string>).cardId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = req.user as { id: number };

  const { amountRupees, posTransactionId, shopOrderId, notes } = req.body;

  if (!amountRupees || isNaN(parseFloat(amountRupees)) || parseFloat(amountRupees) <= 0) {
    res.status(400).json({ error: "A positive amount is required." });
    return;
  }

  const amountPaise = Math.round(parseFloat(amountRupees) * 100);

  const [card] = await db.select().from(giftCardsTable)
    .where(and(eq(giftCardsTable.id, cardId), eq(giftCardsTable.organizationId, orgId)));

  if (!card) { { res.status(404).json({ error: "Gift card not found." }); return; } }
  if (card.status !== "active") { { res.status(400).json({ error: `Gift card is ${card.status}.` }); return; } }
  if (card.expiresAt && new Date() > card.expiresAt) {
    await db.update(giftCardsTable).set({ status: "expired" }).where(eq(giftCardsTable.id, cardId));
    res.status(400).json({ error: "Gift card has expired." });
    return;
  }
  if (card.currentBalancePaise <= 0) {
    res.status(400).json({ error: "Gift card has no remaining balance." });
    return;
  }

  const redeemAmount = Math.min(amountPaise, card.currentBalancePaise);
  const newBalance = card.currentBalancePaise - redeemAmount;

  await db.update(giftCardsTable).set({
    currentBalancePaise: newBalance,
    status: newBalance === 0 ? "redeemed" : "active",
    redeemedAt: newBalance === 0 ? new Date() : undefined,
    updatedAt: new Date(),
  }).where(eq(giftCardsTable.id, cardId));

  const [redemption] = await db.insert(giftCardRedemptionsTable).values({
    giftCardId: cardId,
    organizationId: orgId,
    amountPaise: redeemAmount,
    balanceBeforePaise: card.currentBalancePaise,
    balanceAfterPaise: newBalance,
    redeemedByUserId: user.id,
    posTransactionId: posTransactionId ?? null,
    shopOrderId: shopOrderId ?? null,
    notes: notes ?? null,
  }).returning();

  res.json({ redemption, amountRedeemedPaise: redeemAmount, remainingBalancePaise: newBalance });
});

// GET /organizations/:orgId/gift-cards/:cardId/redemptions
// Transaction history for a specific gift card
router.get("/:cardId/redemptions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cardId = parseInt(String((req.params as Record<string, string>).cardId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [card] = await db.select({ id: giftCardsTable.id }).from(giftCardsTable)
    .where(and(eq(giftCardsTable.id, cardId), eq(giftCardsTable.organizationId, orgId)));
  if (!card) { { res.status(404).json({ error: "Gift card not found." }); return; } }

  const redemptions = await db.select().from(giftCardRedemptionsTable)
    .where(eq(giftCardRedemptionsTable.giftCardId, cardId))
    .orderBy(desc(giftCardRedemptionsTable.createdAt));

  res.json(redemptions);
});

// PATCH /organizations/:orgId/gift-cards/:cardId/cancel
// Admin: cancel a gift card
router.patch("/:cardId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cardId = parseInt(String((req.params as Record<string, string>).cardId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [card] = await db.select().from(giftCardsTable)
    .where(and(eq(giftCardsTable.id, cardId), eq(giftCardsTable.organizationId, orgId)));
  if (!card) { { res.status(404).json({ error: "Gift card not found." }); return; } }
  if (card.status !== "active") { { res.status(400).json({ error: `Cannot cancel a ${card.status} gift card.` }); return; } }

  const [updated] = await db.update(giftCardsTable)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(giftCardsTable.id, cardId))
    .returning();

  res.json(updated);
});

// POST /organizations/:orgId/gift-cards/:cardId/resend-email
// Admin: resend digital gift card email
router.post("/:cardId/resend-email", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cardId = parseInt(String((req.params as Record<string, string>).cardId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [card] = await db.select().from(giftCardsTable)
    .where(and(eq(giftCardsTable.id, cardId), eq(giftCardsTable.organizationId, orgId)));
  if (!card) { { res.status(404).json({ error: "Gift card not found." }); return; } }
  if (!card.recipientEmail) { { res.status(400).json({ error: "No recipient email on record." }); return; } }

  await sendGiftCardEmail(card);
  await db.update(giftCardsTable).set({ emailSentAt: new Date() }).where(eq(giftCardsTable.id, cardId));

  res.json({ ok: true });
});

// GET /organizations/:orgId/gift-cards/stats
// Summary statistics for admin dashboard
router.get("/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [totals] = await db.select({
    totalIssued: count(),
    totalBalancePaise: sum(giftCardsTable.currentBalancePaise),
  }).from(giftCardsTable)
    .where(and(eq(giftCardsTable.organizationId, orgId), eq(giftCardsTable.status, "active")));

  const [redeemed] = await db.select({ count: count() }).from(giftCardsTable)
    .where(and(eq(giftCardsTable.organizationId, orgId), eq(giftCardsTable.status, "redeemed")));

  res.json({
    activeCount: Number(totals?.totalIssued ?? 0),
    activeTotalBalancePaise: Number(totals?.totalBalancePaise ?? 0),
    redeemedCount: Number(redeemed?.count ?? 0),
  });
});

// ─── STORE CREDIT ROUTES ──────────────────────────────────────────────────────

// GET /organizations/:orgId/store-credit/members/:memberId
// Get or create a store credit account for a member
router.get("/store-credit/members/:memberId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select({ id: clubMembersTable.id, firstName: clubMembersTable.firstName, lastName: clubMembersTable.lastName })
    .from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Member not found." }); return; } }

  let [account] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.organizationId, orgId), eq(storeCreditAccountsTable.memberId, memberId)));

  if (!account) {
    [account] = await db.insert(storeCreditAccountsTable)
      .values({ organizationId: orgId, memberId, balancePaise: 0 })
      .returning();
  }

  const history = await db.select().from(storeCreditTransactionsTable)
    .where(eq(storeCreditTransactionsTable.accountId, account.id))
    .orderBy(desc(storeCreditTransactionsTable.createdAt))
    .limit(50);

  res.json({ account, member, history });
});

// POST /organizations/:orgId/store-credit/members/:memberId/issue
// Admin: issue store credit to a member (refund, promotion, etc.)
router.post("/store-credit/members/:memberId/issue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = req.user as { id: number };

  const { amountRupees, reason } = req.body;

  if (!amountRupees || isNaN(parseFloat(amountRupees)) || parseFloat(amountRupees) <= 0) {
    res.status(400).json({ error: "A positive amount is required." });
    return;
  }

  const [member] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Member not found." }); return; } }

  const amountPaise = Math.round(parseFloat(amountRupees) * 100);

  let [account] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.organizationId, orgId), eq(storeCreditAccountsTable.memberId, memberId)));

  if (!account) {
    [account] = await db.insert(storeCreditAccountsTable)
      .values({ organizationId: orgId, memberId, balancePaise: 0 })
      .returning();
  }

  const newBalance = account.balancePaise + amountPaise;

  await db.update(storeCreditAccountsTable)
    .set({ balancePaise: newBalance, updatedAt: new Date() })
    .where(eq(storeCreditAccountsTable.id, account.id));

  const [tx] = await db.insert(storeCreditTransactionsTable).values({
    accountId: account.id,
    organizationId: orgId,
    type: "issue",
    amountPaise,
    balanceBeforePaise: account.balancePaise,
    balanceAfterPaise: newBalance,
    performedByUserId: user.id,
    reason: reason ?? null,
  }).returning();

  res.status(201).json({ transaction: tx, newBalancePaise: newBalance });
});

// POST /organizations/:orgId/store-credit/members/:memberId/redeem
// Redeem store credit at checkout / POS
router.post("/store-credit/members/:memberId/redeem", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = req.user as { id: number };

  const { amountRupees, posTransactionId, shopOrderId, reason } = req.body;

  if (!amountRupees || isNaN(parseFloat(amountRupees)) || parseFloat(amountRupees) <= 0) {
    res.status(400).json({ error: "A positive amount is required." });
    return;
  }

  const amountPaise = Math.round(parseFloat(amountRupees) * 100);

  let [account] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.organizationId, orgId), eq(storeCreditAccountsTable.memberId, memberId)));

  if (!account || account.balancePaise <= 0) {
    res.status(400).json({ error: "Insufficient store credit balance." });
    return;
  }

  const redeemAmount = Math.min(amountPaise, account.balancePaise);
  const newBalance = account.balancePaise - redeemAmount;

  await db.update(storeCreditAccountsTable)
    .set({ balancePaise: newBalance, updatedAt: new Date() })
    .where(eq(storeCreditAccountsTable.id, account.id));

  const [tx] = await db.insert(storeCreditTransactionsTable).values({
    accountId: account.id,
    organizationId: orgId,
    type: "redeem",
    amountPaise: redeemAmount,
    balanceBeforePaise: account.balancePaise,
    balanceAfterPaise: newBalance,
    performedByUserId: user.id,
    posTransactionId: posTransactionId ?? null,
    shopOrderId: shopOrderId ?? null,
    reason: reason ?? null,
  }).returning();

  res.json({ transaction: tx, amountRedeemedPaise: redeemAmount, remainingBalancePaise: newBalance });
});

// POST /organizations/:orgId/store-credit/members/:memberId/adjust
// Admin: manual adjustment (positive or negative)
router.post("/store-credit/members/:memberId/adjust", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = req.user as { id: number };

  const { amountRupees, reason } = req.body;

  if (amountRupees === undefined || isNaN(parseFloat(amountRupees))) {
    res.status(400).json({ error: "An amount is required (positive to add, negative to deduct)." });
    return;
  }

  const amountPaise = Math.round(parseFloat(amountRupees) * 100);

  let [account] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.organizationId, orgId), eq(storeCreditAccountsTable.memberId, memberId)));

  if (!account) {
    [account] = await db.insert(storeCreditAccountsTable)
      .values({ organizationId: orgId, memberId, balancePaise: 0 })
      .returning();
  }

  const newBalance = Math.max(0, account.balancePaise + amountPaise);

  await db.update(storeCreditAccountsTable)
    .set({ balancePaise: newBalance, updatedAt: new Date() })
    .where(eq(storeCreditAccountsTable.id, account.id));

  const [tx] = await db.insert(storeCreditTransactionsTable).values({
    accountId: account.id,
    organizationId: orgId,
    type: "adjustment",
    amountPaise,
    balanceBeforePaise: account.balancePaise,
    balanceAfterPaise: newBalance,
    performedByUserId: user.id,
    reason: reason ?? null,
  }).returning();

  res.json({ transaction: tx, newBalancePaise: newBalance });
});

// GET /organizations/:orgId/store-credit
// List all store credit accounts for the org
router.get("/store-credit", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const accounts = await db.select({
    id: storeCreditAccountsTable.id,
    memberId: storeCreditAccountsTable.memberId,
    balancePaise: storeCreditAccountsTable.balancePaise,
    currency: storeCreditAccountsTable.currency,
    updatedAt: storeCreditAccountsTable.updatedAt,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberEmail: clubMembersTable.email,
    memberNumber: clubMembersTable.memberNumber,
  })
    .from(storeCreditAccountsTable)
    .leftJoin(clubMembersTable, eq(storeCreditAccountsTable.memberId, clubMembersTable.id))
    .where(eq(storeCreditAccountsTable.organizationId, orgId))
    .orderBy(desc(storeCreditAccountsTable.updatedAt));

  res.json(accounts);
});

export default router;
