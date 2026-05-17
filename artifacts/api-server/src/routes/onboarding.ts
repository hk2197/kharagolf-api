import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { organizationsTable, appUsersTable, orgMembershipsTable, tournamentsTable } from "@workspace/db";
import { eq, sql, desc, and } from "drizzle-orm";
import { TIER_DISPLAY, isTierDowngrade, type SubscriptionTier } from "../lib/subscriptionTiers";
import bcrypt from "bcryptjs";
import Razorpay from "razorpay";
import crypto from "node:crypto";
import { createSession, SESSION_COOKIE, SESSION_TTL, type SessionData } from "../lib/auth";
import { notifyOrgAdminsOfPlanCancellation, notifyOrgAdminsOfPlanPastDue } from "../lib/orgPlanCancelledNotify";
import { notifySuperAdminsOfPlanMigration } from "../lib/planMigrationDigest";
import { logger as baseLogger } from "../lib/logger";

const onboardingLogger = baseLogger.child({ module: "onboarding" });

const router: IRouter = Router();

let _razorpay: Razorpay | null = null;
function getRazorpay(): Razorpay {
  if (_razorpay) return _razorpay;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error(
      "Razorpay is not configured: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set",
    );
  }
  _razorpay = new Razorpay({ key_id, key_secret });
  return _razorpay;
}

// GET /onboarding/plans — public: return all subscription tier plans
router.get("/onboarding/plans", (_req: Request, res: Response) => {
  const plans = (Object.entries(TIER_DISPLAY) as [SubscriptionTier, typeof TIER_DISPLAY[SubscriptionTier]][]).map(([tier, info]) => ({
    tier,
    ...info,
  }));
  res.json(plans);
});

// POST /onboarding/check-slug — public: check if a slug is available
router.post("/onboarding/check-slug", async (req: Request, res: Response) => {
  const { slug } = req.body;
  if (!slug || typeof slug !== "string") {
    res.status(400).json({ error: "slug is required" });
    return;
  }
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [existing] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, safeSlug));
  res.json({ slug: safeSlug, available: !existing });
});

/**
 * POST /onboarding/register — public self-registration.
 *
 * Security note: self-registered clubs always start on the FREE tier regardless
 * of what the client sends for `subscriptionTier`.  Paid tiers are activated
 * only after a Razorpay Subscription is created and its first payment confirmed.
 * The response echoes the intent as `requestedTier`; the caller should show
 * "Start on Free — upgrade after sign-in" messaging when the requested tier
 * differs from the activated tier.
 */
router.post("/onboarding/register", async (req: Request, res: Response) => {
  const {
    clubName, slug, description, location, logoUrl, primaryColor,
    contactEmail, contactPhone, website,
    adminFirstName, adminLastName, adminEmail, adminPassword,
    subscriptionTier,
  } = req.body;

  if (!clubName || !slug || !adminEmail || !adminPassword) {
    res.status(400).json({ error: "clubName, slug, adminEmail, and adminPassword are required" });
    return;
  }

  if (typeof adminPassword !== "string" || adminPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const validTiers: SubscriptionTier[] = ["free", "starter", "pro", "enterprise"];
  const requestedTier: SubscriptionTier = validTiers.includes(subscriptionTier) ? subscriptionTier : "free";

  // Self-registration always starts on free regardless of requested tier.
  const activatedTier: SubscriptionTier = "free";

  const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const [existingOrg] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, safeSlug));
  if (existingOrg) {
    res.status(409).json({ error: "This club URL is already taken. Please choose another." });
    return;
  }

  const [existingUser] = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(eq(appUsersTable.email, adminEmail));
  if (existingUser) {
    res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: clubName,
      slug: safeSlug,
      description: description ?? null,
      logoUrl: logoUrl ?? null,
      primaryColor: primaryColor ?? "#1e4d2b",
      contactEmail: contactEmail ?? adminEmail,
      contactPhone: contactPhone ?? null,
      address: location ?? null,
      website: website ?? null,
      subscriptionTier: activatedTier,
      subscriptionStatus: "free",
      pendingSubscriptionTier: requestedTier !== "free" ? requestedTier : null,
      isActive: true,
    })
    .returning();

  const username = adminEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const displayName = [adminFirstName, adminLastName].filter(Boolean).join(" ") || username;
  const replitId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const [adminUser] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: replitId,
      username,
      email: adminEmail,
      displayName,
      role: "org_admin",
      organizationId: org.id,
      passwordHash,
      // Self-registered org admins are immediately verified — they chose the password
      // themselves and are creating their own club, so no email verification loop needed.
      emailVerified: true,
    })
    .returning();

  await db.insert(orgMembershipsTable).values({
    organizationId: org.id,
    userId: adminUser.id,
    role: "org_admin",
  });

  // Auto-login: create a session so the newly registered admin is immediately
  // authenticated. This allows the frontend to call /onboarding/subscribe in the
  // same wizard step without requiring a separate sign-in flow.
  const sessionData: SessionData = {
    user: {
      id: adminUser.id,
      replitId: adminUser.replitUserId,
      username: adminUser.username,
      email: adminUser.email ?? undefined,
      displayName: adminUser.displayName ?? undefined,
      profileImage: adminUser.profileImage ?? undefined,
      role: adminUser.role as never,
      organizationId: adminUser.organizationId ?? undefined,
      createdAt: adminUser.createdAt.toISOString(),
    },
    access_token: `local_${adminUser.id}`,
  };
  const sid = await createSession(sessionData);
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });

  res.status(201).json({
    organizationId: org.id,
    organizationSlug: org.slug,
    organizationName: org.name,
    userId: adminUser.id,
    activatedTier: org.subscriptionTier,
    requestedTier,
    upgradeRequired: requestedTier !== "free",
    message: requestedTier !== "free"
      ? `Club registered on the Free plan. Complete the upgrade to ${TIER_DISPLAY[requestedTier].label} to unlock premium features.`
      : "Club registered successfully. Sign in to access your dashboard.",
  });
});

// GET /onboarding/clubs — public: list all active clubs for the directory
router.get("/onboarding/clubs", async (_req: Request, res: Response) => {
  const clubs = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      description: organizationsTable.description,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      subscriptionTier: organizationsTable.subscriptionTier,
      contactEmail: organizationsTable.contactEmail,
      website: organizationsTable.website,
      address: organizationsTable.address,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.isActive, true))
    .orderBy(organizationsTable.name);
  res.json(clubs);
});

// GET /onboarding/clubs/:slug — public: get club public profile by slug
router.get("/onboarding/clubs/:slug", async (req: Request, res: Response) => {
  const { slug } = (req.params as Record<string, string>);
  const [org] = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      description: organizationsTable.description,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      contactEmail: organizationsTable.contactEmail,
      website: organizationsTable.website,
      address: organizationsTable.address,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.slug, slug), eq(organizationsTable.isActive, true)));

  if (!org) {
    res.status(404).json({ error: "Club not found" });
    return;
  }

  const [memberCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.organizationId, org.id));

  const recentTournaments = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      status: tournamentsTable.status,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
    })
    .from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.organizationId, org.id),
      sql`${tournamentsTable.status} = 'completed'`,
    ))
    .orderBy(desc(tournamentsTable.startDate))
    .limit(5);

  res.json({
    ...org,
    memberCount: Number(memberCount?.count ?? 0),
    recentTournaments,
  });
});

/**
 * POST /onboarding/subscribe — create a Razorpay Subscription for an org plan upgrade.
 *
 * Flow:
 *  1. Create (or look up) a Razorpay Plan for the target tier.
 *  2. Create a Razorpay Subscription referencing that plan.
 *  3. Store the subscription ID in `razorpaySubscriptionId`.
 *  4. Return subscription ID + short_url to the client for checkout.
 *
 * Requires the org admin to be authenticated.
 *
 * Environment variables used:
 *   RAZORPAY_PLAN_ID_STARTER, RAZORPAY_PLAN_ID_PRO, RAZORPAY_PLAN_ID_ENTERPRISE
 *   — optional pre-created plan IDs. If not set, plans are created on-the-fly.
 */
router.post("/onboarding/subscribe", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const user = req.user as { organizationId?: number; role?: string; email?: string; displayName?: string };
  if (!user.organizationId || (user.role !== "org_admin" && user.role !== "super_admin")) {
    res.status(403).json({ error: "Only org admins can manage subscriptions." });
    return;
  }

  const { targetTier } = req.body as { targetTier?: string };
  const validPaidTiers: SubscriptionTier[] = ["starter", "pro", "enterprise"];
  if (!targetTier || !validPaidTiers.includes(targetTier as SubscriptionTier)) {
    res.status(400).json({ error: "targetTier must be one of: starter, pro, enterprise" });
    return;
  }

  const tier = targetTier as SubscriptionTier;
  const tierInfo = TIER_DISPLAY[tier];

  // Resolve plan ID — prefer pre-created plan from env, otherwise create on-the-fly
  const envPlanIdKey = `RAZORPAY_PLAN_ID_${tier.toUpperCase()}` as keyof NodeJS.ProcessEnv;
  let planId = process.env[envPlanIdKey];

  if (!planId) {
    try {
      const plan = await getRazorpay().plans.create({
        period: "monthly",
        interval: 1,
        item: {
          name: `KHARAGOLF ${tierInfo.label} Plan`,
          amount: tierInfo.priceMonthly * 100,
          currency: "INR",
          description: tierInfo.description,
        },
        notes: {
          tier,
          source: "kharagolf_saas",
        },
      });
      planId = plan.id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Failed to create billing plan: ${msg}` });
      return;
    }
  }

  // Store intent before creating subscription (idempotent on retry)
  await db
    .update(organizationsTable)
    .set({ pendingSubscriptionTier: tier, updatedAt: new Date() })
    .where(eq(organizationsTable.id, user.organizationId));

  try {
    const subscription = await getRazorpay().subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 months; set 0 for infinite
      quantity: 1,
      customer_notify: 1,
      notes: {
        organizationId: String(user.organizationId),
        targetTier: tier,
        type: "org_subscription",
      },
    });

    // Persist the subscription ID so we can track it via webhook
    await db
      .update(organizationsTable)
      .set({ razorpaySubscriptionId: subscription.id, updatedAt: new Date() })
      .where(eq(organizationsTable.id, user.organizationId));

    res.json({
      subscriptionId: subscription.id,
      shortUrl: subscription.short_url,
      keyId: process.env.RAZORPAY_KEY_ID ?? "",
      tier,
      tierLabel: tierInfo.label,
      priceMonthly: tierInfo.priceMonthly,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Payment gateway error: ${msg}` });
  }
});

/**
 * POST /onboarding/subscribe/verify — verify Razorpay subscription payment and activate tier.
 *
 * Called client-side after the Razorpay Subscription checkout succeeds.
 * Expected body: { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature }
 * Signature: HMAC-SHA256(subscriptionId + '|' + paymentId, key_secret)
 */
router.post("/onboarding/subscribe/verify", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const user = req.user as { organizationId?: number; role?: string };
  if (!user.organizationId || (user.role !== "org_admin" && user.role !== "super_admin")) {
    res.status(403).json({ error: "Only org admins can verify subscriptions." });
    return;
  }

  const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature } = req.body as {
    razorpaySubscriptionId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
  };

  if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "razorpaySubscriptionId, razorpayPaymentId, and razorpaySignature are required" });
    return;
  }

  // Verify HMAC-SHA256(subscriptionId + '|' + paymentId, key_secret)
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "")
    .update(`${razorpaySubscriptionId}|${razorpayPaymentId}`)
    .digest("hex");

  if (expectedSig !== razorpaySignature) {
    res.status(400).json({ error: "Invalid payment signature." });
    return;
  }

  // Validate that the subscription ID matches what we stored for this org
  const [org] = await db
    .select({
      pendingSubscriptionTier: organizationsTable.pendingSubscriptionTier,
      razorpaySubscriptionId: organizationsTable.razorpaySubscriptionId,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, user.organizationId));

  if (!org?.pendingSubscriptionTier) {
    res.status(400).json({ error: "No pending subscription tier found. Please start a new subscription." });
    return;
  }

  if (org.razorpaySubscriptionId && org.razorpaySubscriptionId !== razorpaySubscriptionId) {
    res.status(400).json({ error: "Subscription ID mismatch. Please restart the subscription flow." });
    return;
  }

  const newTier = org.pendingSubscriptionTier as SubscriptionTier;

  const [updated] = await db
    .update(organizationsTable)
    .set({
      subscriptionTier: newTier,
      subscriptionStatus: "active",
      pendingSubscriptionTier: null,
      razorpaySubscriptionId,
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, user.organizationId))
    .returning();

  res.json({
    ok: true,
    activatedTier: updated.subscriptionTier,
    subscriptionStatus: updated.subscriptionStatus,
    message: `Your plan has been upgraded to ${TIER_DISPLAY[newTier].label}.`,
  });
});

/**
 * POST /onboarding/subscribe/webhook — Razorpay webhook for subscription lifecycle events.
 *
 * Signature verification uses raw request bytes (req.rawBody) — NOT JSON.stringify(req.body),
 * which would produce a different byte sequence after Express JSON parsing re-serialises.
 * The rawBody Buffer is attached to req by the express.json({ verify }) callback in app.ts.
 *
 * Handles:
 *   subscription.charged     → first / recurring payment captured → activate tier
 *   subscription.halted      → too many failed retries → mark past_due
 *   subscription.cancelled   → cancelled → downgrade to free
 *   payment.failed           → single payment failure → mark past_due
 *
 * Mounted before auth middleware in routes/index.ts.
 */
router.post("/onboarding/subscribe/webhook", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  const signature = req.headers["x-razorpay-signature"] as string;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!rawBody) {
    res.status(400).json({ error: "Missing raw request body" });
    return;
  }

  const expectedSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  if (signature !== expectedSig) {
    res.status(400).json({ error: "Invalid webhook signature" });
    return;
  }

  const event = req.body as {
    event?: string;
    payload?: {
      payment?: { entity?: Record<string, unknown> };
      subscription?: { entity?: Record<string, unknown> };
    };
  };
  const eventType = event.event;

  if (!eventType) {
    res.json({ ok: true });
    return;
  }

  // Extract org context from subscription or payment notes
  const subEntity = event.payload?.subscription?.entity;
  const payEntity = event.payload?.payment?.entity;
  const notes = ((subEntity?.notes ?? payEntity?.notes) ?? {}) as Record<string, string>;
  const orgId = notes.organizationId ? parseInt(notes.organizationId) : null;
  const targetTier = notes.targetTier as SubscriptionTier | undefined;
  const subscriptionId = (subEntity?.id ?? payEntity?.subscription_id ?? null) as string | null;

  if (!orgId || isNaN(orgId)) {
    res.json({ ok: true }); // Not an org subscription event
    return;
  }

  const validPaidTiers: SubscriptionTier[] = ["starter", "pro", "enterprise"];

  if (eventType === "subscription.charged" && targetTier && validPaidTiers.includes(targetTier)) {
    // Capture the prior tier before the update so we can detect mid-tier
    // downgrades (Task #1905) — e.g. enterprise → starter — and fire the
    // realtime super-admin alert below. Same-tier renewals and upgrades
    // stay silent.
    const [chargeOrgRow] = await db
      .select({ subscriptionTier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    const fromTier = (chargeOrgRow?.subscriptionTier ?? null) as string | null;

    // Recurring or first charge — activate tier
    await db
      .update(organizationsTable)
      .set({
        subscriptionTier: targetTier,
        subscriptionStatus: "active",
        pendingSubscriptionTier: null,
        ...(subscriptionId ? { razorpaySubscriptionId: subscriptionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizationsTable.id, orgId));

    // Task #1905 — Mirror the Stripe `customer.subscription.updated`
    // downgrade-alert path. Razorpay reports tier changes via
    // `subscription.charged` with the new `notes.targetTier`, so a
    // paying club moving from enterprise down to starter would
    // otherwise land in the silent "applied" path above.
    if (isTierDowngrade(fromTier, targetTier)) {
      try {
        await notifySuperAdminsOfPlanMigration({
          organizationId: orgId,
          fromTier,
          toTier: targetTier,
          reason: `Razorpay plan downgraded ${fromTier} → ${targetTier}`,
          // Task #1906 — paid-plan tier downgrade is paid-plan churn,
          // so reuse the "cancelled" subject + push title rather than
          // the generic "auto-reset to Free" wording.
          triggerReason: "cancelled",
          req,
        });
      } catch (notifyErr) {
        onboardingLogger.warn(
          { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), organizationId: orgId },
          "[onboarding/razorpay] paid-tier downgrade realtime notify failed",
        );
      }
    }
  }

  if (eventType === "subscription.halted" || eventType === "payment.failed") {
    // Capture the current paid tier so the past-due email (Task #1907)
    // can name the plan that's at risk. Read before the UPDATE because
    // the UPDATE doesn't change the tier — the tier only flips to free
    // on the later `subscription.cancelled` event — but reading first
    // keeps the helper-call shape symmetrical with the cancellation
    // branch below.
    const [orgRow] = await db
      .select({ subscriptionTier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    const currentTier = (orgRow?.subscriptionTier ?? null) as string | null;

    await db
      .update(organizationsTable)
      .set({ subscriptionStatus: "past_due", updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId));

    // Task #1907 — until now this branch silently flipped the org to
    // past_due with no email, so a club whose card simply expired had
    // no warning before being locked out of paid features. Send the
    // branded past-due notice so the org admin(s) can update their
    // payment method before the next retry. Only fire when the
    // pre-update read found a real org — this mirrors the not-found
    // guard the cancellation branch inherits from `orgRow`. Never
    // throws; failures are logged inside the helper.
    if (orgRow) {
      // Razorpay attaches the failure description to the payment entity
      // (`payment.entity.error_description`). Subscription-level events
      // (`subscription.halted`) don't always have a payment payload —
      // the helper falls back to a generic line in that case.
      const failureReasonRaw = payEntity?.error_description as
        | string
        | null
        | undefined;
      const failureReason =
        typeof failureReasonRaw === "string" && failureReasonRaw.trim().length > 0
          ? failureReasonRaw.trim()
          : null;

      await notifyOrgAdminsOfPlanPastDue({
        orgId,
        source: "razorpay",
        currentTier,
        failureReason,
      });
    }
  }

  if (eventType === "subscription.cancelled") {
    // Capture the prior tier before the downgrade so we can:
    //   - name the cancelled plan in the org-admin confirmation email
    //     (Task #1540), and
    //   - decide whether to fire the super-admin churn alert (Task #1539,
    //     paid-tier orgs only — free→free deletions stay silent).
    const [orgRow] = await db
      .select({ subscriptionTier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    const fromTier = (orgRow?.subscriptionTier ?? null) as string | null;

    await db
      .update(organizationsTable)
      .set({
        subscriptionTier: "free",
        subscriptionStatus: "cancelled",
        razorpaySubscriptionId: null,
        pendingSubscriptionTier: null,
        updatedAt: new Date(),
      })
      .where(eq(organizationsTable.id, orgId));

    // Task #1540 — confirm the cancellation by email so a club admin
    // who cancelled by mistake (or was billed by Razorpay directly) has
    // an audit trail in their inbox. Never throws; failures are logged
    // inside the helper.
    await notifyOrgAdminsOfPlanCancellation({
      orgId,
      source: "razorpay",
      previousTier: fromTier,
    });

    // Task #1539 — mirror the Stripe `customer.subscription.deleted`
    // branch in routes/webhooks.ts: when a *paid* tier is cancelled,
    // immediately fan out an email + push to super admins so genuine
    // churn surfaces in real time (rather than waiting for the hourly
    // plan-migration digest). Stays silent for orgs that were already
    // on Free.
    const wasPaid = fromTier === "starter" || fromTier === "pro" || fromTier === "enterprise";
    if (wasPaid) {
      try {
        await notifySuperAdminsOfPlanMigration({
          organizationId: orgId,
          fromTier,
          toTier: "free",
          reason: "Razorpay subscription cancelled — auto-reset to Free",
          // Task #1906 — paid-plan churn from Razorpay; mirrors the
          // Stripe `customer.subscription.deleted` branch in
          // routes/webhooks.ts so both providers trigger the same
          // "Club cancelled paid plan" subject + push title.
          triggerReason: "cancelled",
          req,
        });
      } catch (notifyErr) {
        onboardingLogger.warn(
          { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), organizationId: orgId },
          "[onboarding/razorpay] subscription-cancelled realtime notify failed",
        );
      }
    }
  }

  res.json({ ok: true });
});

export default router;
