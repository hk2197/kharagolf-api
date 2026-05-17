import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  membershipTiersTable, clubMembersTable, memberSubscriptionsTable,
  orgMembershipsTable, organizationsTable, appUsersTable,
} from "@workspace/db";
import { eq, and, desc, asc, count, or, lt, inArray } from "drizzle-orm";
import { getRazorpayClient } from "../lib/razorpay";
import { sendBroadcast } from "../lib/comms";
import { sendMemberInviteEmail } from "../lib/mailer";
import { resolveOrgBranding } from "../lib/clubTheming";

function getOrigin(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

const router: IRouter = Router({ mergeParams: true });

/** Returns true only for org_admin / tournament_director / super_admin. */
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number((user as any).organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

/** Returns true for any authenticated member of the org (for read-only PII access). */
async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string };
  if (user.role === "super_admin") return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (!m) { res.status(403).json({ error: "Organization membership required" }); return false; }
  return true;
}

// ─── MEMBERSHIP TIERS ────────────────────────────────────────────────────────

// GET /organizations/:orgId/membership-tiers
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const tiers = await db.select().from(membershipTiersTable)
    .where(eq(membershipTiersTable.organizationId, orgId))
    .orderBy(asc(membershipTiersTable.annualFee));

  const tiersWithCounts = await Promise.all(tiers.map(async (tier) => {
    const [cnt] = await db.select({ count: count() }).from(clubMembersTable)
      .where(and(eq(clubMembersTable.tierId, tier.id), eq(clubMembersTable.organizationId, orgId)));
    return { ...tier, memberCount: Number(cnt?.count ?? 0) };
  }));

  res.json(tiersWithCounts);
});

// POST /organizations/:orgId/membership-tiers
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, annualFee, currency, gracePeriodDays } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  // Normalize annualFee: treat empty string, null, undefined all as "0"
  const normalizedFee = (annualFee && String(annualFee).trim() !== "") ? String(annualFee).trim() : "0";

  let razorpayPlanId: string | undefined;
  try {
    const rz = getRazorpayClient();
    const plan = await (rz.plans as unknown as { create(opts: Record<string, unknown>): Promise<{ id: string }> }).create({
      period: "yearly",
      interval: 1,
      item: {
        name,
        amount: Math.round(parseFloat(normalizedFee) * 100),
        currency: currency ?? "INR",
        description: description ?? name,
      },
    });
    razorpayPlanId = plan.id;
  } catch {
    // Non-fatal: plan can be linked manually later
  }

  try {
    const [tier] = await db.insert(membershipTiersTable).values({
      organizationId: orgId,
      name,
      description,
      annualFee: normalizedFee,
      currency: currency ?? "INR",
      gracePeriodDays: gracePeriodDays ?? 14,
      razorpayPlanId,
    }).returning();

    res.status(201).json(tier);
  } catch (err) {
    req.log?.error({ err, orgId, tierName: name }, "[memberships] DB insert failed for membership tier");
    res.status(500).json({ error: "Failed to save the membership tier. Please try again." });
  }
});

// PUT /organizations/:orgId/membership-tiers/:tierId
router.put("/:tierId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tierId = parseInt(String((req.params as Record<string, string>).tierId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, annualFee, currency, gracePeriodDays, isActive } = req.body;
  const [tier] = await db.update(membershipTiersTable)
    .set({ name, description, annualFee, currency, gracePeriodDays, isActive, updatedAt: new Date() })
    .where(and(eq(membershipTiersTable.id, tierId), eq(membershipTiersTable.organizationId, orgId)))
    .returning();
  if (!tier) { { res.status(404).json({ error: "Tier not found" }); return; } }
  res.json(tier);
});

// DELETE /organizations/:orgId/membership-tiers/:tierId
router.delete("/:tierId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tierId = parseInt(String((req.params as Record<string, string>).tierId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(membershipTiersTable)
    .where(and(eq(membershipTiersTable.id, tierId), eq(membershipTiersTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── CLUB MEMBERS ────────────────────────────────────────────────────────────

// GET /organizations/:orgId/club-members  (requires org admin access)
router.get("/members", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const members = await db
    .select({
      id: clubMembersTable.id,
      userId: clubMembersTable.userId,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
      handicapIndex: clubMembersTable.handicapIndex,
      whsGhinNumber: clubMembersTable.whsGhinNumber,
      joinDate: clubMembersTable.joinDate,
      renewalDate: clubMembersTable.renewalDate,
      subscriptionStatus: clubMembersTable.subscriptionStatus,
      showInDirectory: clubMembersTable.showInDirectory,
      tierId: clubMembersTable.tierId,
      tierName: membershipTiersTable.name,
      tierAnnualFee: membershipTiersTable.annualFee,
      inviteToken: clubMembersTable.inviteToken,
      inviteTokenExpiry: clubMembersTable.inviteTokenExpiry,
      pendingMemberLink: clubMembersTable.pendingMemberLink,
    })
    .from(clubMembersTable)
    .leftJoin(membershipTiersTable, eq(clubMembersTable.tierId, membershipTiersTable.id))
    .where(eq(clubMembersTable.organizationId, orgId))
    .orderBy(asc(clubMembersTable.lastName), asc(clubMembersTable.firstName));

  res.json(members);
});

// POST /organizations/:orgId/club-members
router.post("/members", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { tierId, firstName, lastName, email, phone, dateOfBirth, handicapIndex, whsGhinNumber, showInDirectory } = req.body;
  if (!firstName || !lastName) { { res.status(400).json({ error: "firstName and lastName are required" }); return; } }

  const [cnt] = await db.select({ count: count() }).from(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  const memberNumber = `MBR-${String(Number(cnt?.count ?? 0) + 1).padStart(4, "0")}`;

  const renewalDate = new Date();
  renewalDate.setFullYear(renewalDate.getFullYear() + 1);

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    tierId: tierId ?? null,
    memberNumber,
    firstName,
    lastName,
    email,
    phone,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    handicapIndex,
    whsGhinNumber,
    renewalDate,
    showInDirectory: showInDirectory ?? true,
  }).returning();

  res.status(201).json(member);
});

// PUT /organizations/:orgId/club-members/:memberId
router.put("/members/:memberId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { tierId, firstName, lastName, email, phone, handicapIndex, whsGhinNumber, renewalDate, showInDirectory, subscriptionStatus } = req.body;
  const [member] = await db.update(clubMembersTable)
    .set({ tierId, firstName, lastName, email, phone, handicapIndex, whsGhinNumber,
      renewalDate: renewalDate ? new Date(renewalDate) : undefined, showInDirectory, subscriptionStatus, updatedAt: new Date() })
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)))
    .returning();
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  res.json(member);
});

// DELETE /organizations/:orgId/club-members/:memberId
router.delete("/members/:memberId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(clubMembersTable).where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/club-members/:memberId/send-invite
router.post("/:memberId/send-invite", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (!member.email) { { res.status(400).json({ error: "Member has no email address on record" }); return; } }
  if (member.userId) { { res.status(409).json({ error: "Member already has a portal account linked" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.update(clubMembersTable).set({
    inviteToken: token,
    inviteTokenExpiry: expiry,
    updatedAt: new Date(),
  }).where(eq(clubMembersTable.id, memberId));

  const baseUrl = getOrigin(req);
  try {
    await sendMemberInviteEmail(member.email, member.firstName, org?.name ?? "Your Golf Club", token, baseUrl);
  } catch (err) {
    const link = `${baseUrl}/portal?action=claim&token=${token}`;
    res.json({ ok: true, sent: false, emailError: true, link });
    return;
  }

  res.json({ ok: true, sent: true });
});

// GET /organizations/:orgId/club-members/:memberId/invite-link
router.get("/:memberId/invite-link", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select({
    inviteToken: clubMembersTable.inviteToken,
    inviteTokenExpiry: clubMembersTable.inviteTokenExpiry,
  }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (!member.inviteToken) { { res.status(400).json({ error: "No invite has been generated for this member yet" }); return; } }

  const baseUrl = getOrigin(req);
  const link = `${baseUrl}/portal?action=claim&token=${member.inviteToken}`;
  res.json({ link, expiry: member.inviteTokenExpiry });
});

// PATCH /organizations/:orgId/club-members/:memberId/dismiss-pending-link
router.patch("/:memberId/dismiss-pending-link", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.update(clubMembersTable).set({ pendingMemberLink: false, updatedAt: new Date() })
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));

  res.json({ ok: true });
});

// POST /organizations/:orgId/club-members/bulk-renew-reminder
router.post("/members/bulk-renew-reminder", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const daysThreshold = 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + daysThreshold);

  const dueMembers = await db.select().from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, orgId),
      lt(clubMembersTable.renewalDate, cutoffDate),
    ));

  const recipients = dueMembers
    .filter((m) => m.email)
    .map((m) => ({
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email!,
    }));

  if (recipients.length > 0) {
    await sendBroadcast(
      recipients,
      {
        channels: ["email"],
        subject: `${org.name} — Membership Renewal Reminder`,
        body: `Your ${org.name} membership is due for renewal within ${daysThreshold} days. Please contact the club to renew. Thank you for being a valued member!`,
        eventName: org.name,
        // Task #1566 — tag bulk renewal-reminder emails with the
        // originating club so the Postmark bounce webhook (Task #981) can
        // attribute hard bounces back to this org instantly.
        organizationId: orgId,
      },
    );
  }

  res.json({ sent: recipients.length });
});

// ─── RAZORPAY SUBSCRIPTIONS ──────────────────────────────────────────────────

// POST /organizations/:orgId/club-members/:memberId/subscribe
router.post("/members/:memberId/subscribe", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  if (!member.tierId) { { res.status(400).json({ error: "Member must have a tier to subscribe" }); return; } }

  const [tier] = await db.select().from(membershipTiersTable).where(eq(membershipTiersTable.id, member.tierId));
  if (!tier?.razorpayPlanId) { { res.status(400).json({ error: "Membership tier does not have a Razorpay plan linked" }); return; } }

  try {
    const rz = getRazorpayClient();
    const sub = await (rz.subscriptions as unknown as {
      create(opts: Record<string, unknown>): Promise<{ id: string; charge_at: number; plan_id: string }>;
    }).create({
      plan_id: tier.razorpayPlanId,
      total_count: 12,
      quantity: 1,
      customer_notify: 1,
      notes: { clubMemberId: memberId, orgId },
    });

    await db.insert(memberSubscriptionsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      tierId: tier.id,
      razorpaySubscriptionId: sub.id,
      razorpayPlanId: tier.razorpayPlanId,
      status: "active",
      nextBillingDate: new Date(sub.charge_at * 1000),
    });

    await db.update(clubMembersTable)
      .set({ subscriptionStatus: "active", updatedAt: new Date() })
      .where(eq(clubMembersTable.id, memberId));

    res.json({ subscriptionId: sub.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create subscription";
    res.status(502).json({ error: msg });
  }
});

// POST /organizations/:orgId/club-members/:memberId/cancel-subscription
router.post("/members/:memberId/cancel-subscription", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [sub] = await db.select().from(memberSubscriptionsTable)
    .where(and(eq(memberSubscriptionsTable.clubMemberId, memberId), eq(memberSubscriptionsTable.organizationId, orgId)))
    .orderBy(desc(memberSubscriptionsTable.createdAt));

  if (sub?.razorpaySubscriptionId) {
    try {
      const rz = getRazorpayClient();
      await (rz.subscriptions as unknown as {
        cancel(id: string, opts: Record<string, unknown>): Promise<void>;
      }).cancel(sub.razorpaySubscriptionId, { cancel_at_cycle_end: 0 });
    } catch {
      // Proceed even if RZ call fails
    }
  }

  if (sub) {
    await db.update(memberSubscriptionsTable)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(memberSubscriptionsTable.id, sub.id));
  }

  await db.update(clubMembersTable)
    .set({ subscriptionStatus: "cancelled", updatedAt: new Date() })
    .where(eq(clubMembersTable.id, memberId));

  res.json({ ok: true });
});

// GET /organizations/:orgId/club-members/:memberId/subscriptions
router.get("/members/:memberId/subscriptions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const subs = await db.select().from(memberSubscriptionsTable)
    .where(and(eq(memberSubscriptionsTable.clubMemberId, memberId), eq(memberSubscriptionsTable.organizationId, orgId)))
    .orderBy(desc(memberSubscriptionsTable.createdAt));

  res.json(subs);
});

// GET /organizations/:orgId/club-members/members/:memberId/card
// Admin endpoint: generate and download a PNG membership card for any member.
router.get("/members/:memberId/card", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(orgId) || isNaN(memberId)) { { res.status(400).json({ error: "Invalid IDs" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    handicapIndex: clubMembersTable.handicapIndex,
    subscriptionStatus: clubMembersTable.subscriptionStatus,
    renewalDate: clubMembersTable.renewalDate,
    organizationId: clubMembersTable.organizationId,
    tierName: membershipTiersTable.name,
  })
  .from(clubMembersTable)
  .leftJoin(membershipTiersTable, eq(membershipTiersTable.id, clubMembersTable.tierId))
  .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));

  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  // Task #1438 — when the club has saved a custom theme via the
  // club-theming UI, use that logo / primary colour for the membership
  // card. Falls back to the legacy `organizations.*` columns and then
  // to the KHARAGOLF defaults below.
  const branded = await resolveOrgBranding(orgId, org);

  const { Resvg } = await import("@resvg/resvg-js");

  const W = 856; const H = 540;

  let logoDataUri = "";
  if (branded.logoUrl) {
    try {
      const logoRes = await fetch(branded.logoUrl);
      if (logoRes.ok) {
        const buf = await logoRes.arrayBuffer();
        const ct = logoRes.headers.get("content-type") ?? "image/png";
        logoDataUri = `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
      }
    } catch { /* omit logo on fetch failure */ }
  }

  const accentColor = branded.primaryColor ?? "#22c55e";
  const accentColorSafe = /^#[0-9a-fA-F]{3,6}$/.test(accentColor) ? accentColor : "#22c55e";
  const orgName = (org?.name ?? "KHARAGOLF").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const memberName = `${member.firstName} ${member.lastName}`.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const tierLabel = (member.tierName ?? "Member").toUpperCase();
  const memberNo = member.memberNumber ? `Member #${member.memberNumber}` : "";
  const statusColor = member.subscriptionStatus === "active" ? "#22c55e" : member.subscriptionStatus === "past_due" ? "#f59e0b" : "#6b7280";
  const statusLabel = (member.subscriptionStatus ?? "").replace(/_/g, " ").toUpperCase();
  const renewalStr = member.renewalDate
    ? `Valid until ${new Date(member.renewalDate).toLocaleDateString("en-IN", { year: "numeric", month: "short" })}`
    : "";
  const issueStr = `Issued ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "short" })}`;
  const hcpStr = member.handicapIndex != null ? `HCP ${Number(member.handicapIndex).toFixed(1)}` : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#0a1628"/>
        <stop offset="100%" stop-color="#111827"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)" rx="18"/>
    <rect x="0" y="0" width="16" height="${H}" fill="${accentColorSafe}" rx="18"/>
    <rect x="0" y="18" width="16" height="${H - 36}" fill="${accentColorSafe}"/>
    <circle cx="${W - 90}" cy="110" r="180" fill="${accentColorSafe}" fill-opacity="0.06"/>
    ${logoDataUri ? `<image href="${logoDataUri}" x="${W - 156}" y="24" width="120" height="52" preserveAspectRatio="xMidYMid meet"/>` : ""}
    <text x="46" y="74" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="bold" fill="${accentColorSafe}">${orgName}</text>
    ${!logoDataUri ? `<text x="${W - 30}" y="56" font-family="Arial,Helvetica,sans-serif" font-size="22" fill="${accentColorSafe}" text-anchor="end">${tierLabel}</text>` : `<text x="${W - 30}" y="${H / 2 - 20}" font-family="Arial,Helvetica,sans-serif" font-size="22" fill="${accentColorSafe}" text-anchor="end">${tierLabel}</text>`}
    <text x="46" y="230" font-family="Arial,Helvetica,sans-serif" font-size="62" font-weight="bold" fill="#ffffff">${memberName}</text>
    ${memberNo ? `<text x="46" y="296" font-family="Arial,Helvetica,sans-serif" font-size="28" fill="#9ca3af">${memberNo}</text>` : ""}
    ${hcpStr ? `<text x="${W - 30}" y="${H - 56}" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="bold" fill="${accentColorSafe}" text-anchor="end">${hcpStr}</text>` : ""}
    <rect x="44" y="320" width="${statusLabel.length * 14 + 24}" height="36" fill="${statusColor}" fill-opacity="0.15" rx="8"/>
    <text x="56" y="344" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="bold" fill="${statusColor}">${statusLabel}</text>
    ${renewalStr ? `<text x="46" y="${H - 56}" font-family="Arial,Helvetica,sans-serif" font-size="24" fill="#6b7280">${renewalStr}</text>` : ""}
    <text x="${W - 30}" y="${H - 28}" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="#374151" text-anchor="end">${issueStr}</text>
  </svg>`;

  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="membership-card-${member.firstName}-${member.lastName}.png"`);
  res.send(pngBuffer);
});

export default router;
