/**
 * Coach Marketplace API
 * Public-facing coach discovery + per-coach profile management.
 *
 * GET    /coaches                       List listed coaches across orgs (filterable)
 * GET    /coaches/:proId                Get a single coach's marketplace profile + lesson types + ratings
 * POST   /pros/:proId/profile           Upsert marketplace profile (coach or org admin)
 * POST   /pros/:proId/list              Toggle listing on/off (coach or org admin)
 * POST   /pros/:proId/revenue-share     Set revenue share % (org admin only)
 *
 * GET    /me/coach-profile              Get my own coach profile (any pro)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  coachPayoutAccountHistoryTable,
  lessonTypesTable,
  swingReviewRequestsTable,
  organizationsTable,
  orgMembershipsTable,
  appUsersTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, and, or, desc, sql, inArray, gte, lte } from "drizzle-orm";
import {
  createRazorpayContact,
  createRazorpayFundAccount,
  validateRazorpayVpa,
  validateRazorpayBankFundAccount,
} from "../lib/razorpay";
import crypto from "crypto";
import { retryStuckCoachPayouts } from "../lib/coachPayouts";
import { notifyCoachPayoutAccountChanged } from "../lib/coachPayoutAccountChangeNotify";
import { reverifyCoachPayoutAccountById, notifyCoachOfAdminReverify } from "../lib/coachReverifyPayouts";
import { recordAdminReverifyHistory } from "../lib/coachPayoutAccountReverifyAudit";
import { logger as baseLogger } from "../lib/logger";

const payoutLogger = baseLogger.child({ module: "coach-marketplace/payout-account" });

// ── Payout-account verification token ──────────────────────────────────
// HMAC-signed payload returned by the verify leg and consumed by the
// confirm leg of POST /me/payout-account. Binds the verified Razorpay
// fund account + the exact account details we'll persist, so a client
// cannot bypass the verification gate or trick the confirm leg into
// saving a different account.
type VerifiedPayoutTokenPayload = {
  proId: number;
  method: "upi" | "bank_account";
  accountHolderName: string;
  verifiedHolderName: string | null;
  fundAccountId: string;
  razorpayContactId: string;
  upiVpa?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  exp: number;
};

const VERIFICATION_TOKEN_TTL_MS = 15 * 60 * 1000;

function getPayoutVerificationSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not configured — cannot sign payout verification tokens.",
    );
  }
  return secret;
}

function signPayoutVerificationToken(payload: VerifiedPayoutTokenPayload): string {
  const secret = getPayoutVerificationSecret();
  const json = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(json).digest("base64url");
  return `${json}.${sig}`;
}

function verifyPayoutVerificationToken(
  token: string,
  expectedProId: number,
): VerifiedPayoutTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [json, sig] = parts;
  let secret: string;
  try { secret = getPayoutVerificationSecret(); } catch { return null; }
  const expected = crypto.createHmac("sha256", secret).update(json).digest("base64url");
  // constant-time compare
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: VerifiedPayoutTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8"));
  } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if (payload.proId !== expectedProId) return null;
  if (payload.method !== "upi" && payload.method !== "bank_account") return null;
  if (!payload.fundAccountId || !payload.razorpayContactId) return null;
  if (payload.method === "upi" && !payload.upiVpa) return null;
  if (payload.method === "bank_account" && (!payload.bankAccountNumber || !payload.bankIfsc)) return null;
  return payload;
}

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number | null }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

async function isOrgAdmin(user: SessionUser, orgId: number): Promise<boolean> {
  if (user.role === "super_admin") return true;
  if (["org_admin", "tournament_director"].includes(user.role ?? "") && user.organizationId === orgId) return true;
  const [mem] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  return !!mem && ["org_admin", "tournament_director"].includes(mem.role);
}

// Task #764 — used both at write time (history insert) and at read time
// (in case we want to re-mask anything in the future). Mirrors the masking
// the web/mobile UIs apply to `payoutVpa` so the audit log never reveals
// the full VPA.
function maskUpiVpa(vpa: string): string {
  const [name, domain] = vpa.split("@");
  if (!name || !domain) return vpa;
  const visible = name.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

async function getProForUser(userId: number) {
  const [pro] = await db.select().from(teachingProsTable)
    .where(eq(teachingProsTable.userId, userId)).limit(1);
  return pro;
}

router.get("/coaches", async (req: Request, res: Response) => {
  const {
    specialism, specialty, language, mode, maxPricePaise, priceMin, priceMax,
    minRating, q, organizationId, region, handicap,
  } = req.query as Record<string, string | undefined>;

  const wheres = [eq(coachMarketplaceProfilesTable.isListed, true), eq(teachingProsTable.isActive, true)];
  if (organizationId) wheres.push(eq(coachMarketplaceProfilesTable.organizationId, parseInt(organizationId)));
  if (mode === "in_person") wheres.push(eq(coachMarketplaceProfilesTable.acceptsInPerson, true));
  if (mode === "async") wheres.push(eq(coachMarketplaceProfilesTable.acceptsAsync, true));
  // Legacy `maxPricePaise` keeps its async-only semantics for any old
  // clients still sending it (it predates the in-person/async toggle).
  if (maxPricePaise) wheres.push(lte(coachMarketplaceProfilesTable.asyncReviewPricePaise, parseInt(maxPricePaise)));
  // Task #1630 — `priceMin`/`priceMax` now follow the mode toggle so the
  // sidebar's price range filters whichever price the coach is actually
  // being booked under:
  //   • mode=in_person → filter on `hourlyRatePaise`
  //   • mode=async     → filter on `asyncReviewPricePaise`
  //   • mode=all       → keep coaches whose offered price (hourly if they
  //                      accept in-person, async if they accept async)
  //                      falls in the bracket; gates each comparison on
  //                      the matching `acceptsInPerson`/`acceptsAsync`
  //                      flag so a coach who only offers one mode isn't
  //                      excluded by an unrelated price column.
  const priceMinPaise = priceMin ? parseInt(priceMin) : null;
  const priceMaxPaise = priceMax ? parseInt(priceMax) : null;
  if (priceMinPaise != null || priceMaxPaise != null) {
    if (mode === "in_person") {
      if (priceMinPaise != null) wheres.push(gte(coachMarketplaceProfilesTable.hourlyRatePaise, priceMinPaise));
      if (priceMaxPaise != null) wheres.push(lte(coachMarketplaceProfilesTable.hourlyRatePaise, priceMaxPaise));
    } else if (mode === "async") {
      if (priceMinPaise != null) wheres.push(gte(coachMarketplaceProfilesTable.asyncReviewPricePaise, priceMinPaise));
      if (priceMaxPaise != null) wheres.push(lte(coachMarketplaceProfilesTable.asyncReviewPricePaise, priceMaxPaise));
    } else {
      const inPersonClauses = [eq(coachMarketplaceProfilesTable.acceptsInPerson, true)];
      if (priceMinPaise != null) inPersonClauses.push(gte(coachMarketplaceProfilesTable.hourlyRatePaise, priceMinPaise));
      if (priceMaxPaise != null) inPersonClauses.push(lte(coachMarketplaceProfilesTable.hourlyRatePaise, priceMaxPaise));
      const asyncClauses = [eq(coachMarketplaceProfilesTable.acceptsAsync, true)];
      if (priceMinPaise != null) asyncClauses.push(gte(coachMarketplaceProfilesTable.asyncReviewPricePaise, priceMinPaise));
      if (priceMaxPaise != null) asyncClauses.push(lte(coachMarketplaceProfilesTable.asyncReviewPricePaise, priceMaxPaise));
      wheres.push(or(and(...inPersonClauses), and(...asyncClauses))!);
    }
  }
  if (minRating) wheres.push(gte(coachMarketplaceProfilesTable.ratingsAvg, String(minRating)));
  if (q) wheres.push(sql`(lower(${teachingProsTable.displayName}) LIKE ${'%' + q.toLowerCase() + '%'})`);
  // `specialty` is the public alias for `specialism` (Wave 2 W2-H).
  const spec = specialism ?? specialty;
  if (spec) wheres.push(sql`${teachingProsTable.specialisms} ? ${spec}`);
  if (language) wheres.push(sql`${coachMarketplaceProfilesTable.languages} ? ${language}`);
  // Region filter — matches against the parent organization's name as a
  // pragmatic stand-in until we add an explicit region column on
  // coach_marketplace_profiles (tracked as a Wave 2 follow-up).
  if (region) wheres.push(sql`lower(${organizationsTable.name}) LIKE ${'%' + region.toLowerCase() + '%'}`);
  // Handicap-skill filter — coaches whose `coachesHandicapMin..Max` window
  // covers the requested handicap. Reads dedicated typed columns
  // (Task #1356); a NULL bound means "no lower / upper bound" and is
  // treated as default-pass so coaches without a range still appear for
  // every handicap.
  if (handicap) {
    const h = parseFloat(handicap);
    if (Number.isFinite(h)) {
      wheres.push(sql`(
        ${coachMarketplaceProfilesTable.coachesHandicapMin} IS NULL
        OR ${coachMarketplaceProfilesTable.coachesHandicapMin} <= ${h}
      ) AND (
        ${coachMarketplaceProfilesTable.coachesHandicapMax} IS NULL
        OR ${coachMarketplaceProfilesTable.coachesHandicapMax} >= ${h}
      )`);
    }
  }

  const rows = await db.select({
    profile: coachMarketplaceProfilesTable,
    pro: teachingProsTable,
    organizationName: organizationsTable.name,
  })
    .from(coachMarketplaceProfilesTable)
    .innerJoin(teachingProsTable, eq(teachingProsTable.id, coachMarketplaceProfilesTable.proId))
    .leftJoin(organizationsTable, eq(organizationsTable.id, coachMarketplaceProfilesTable.organizationId))
    .where(and(...wheres))
    .orderBy(desc(coachMarketplaceProfilesTable.ratingsAvg))
    .limit(100);

  res.json({
    coaches: rows.map(r => ({
      proId: r.pro.id,
      organizationId: r.profile.organizationId,
      organizationName: r.organizationName,
      displayName: r.pro.displayName,
      bio: r.pro.bio,
      photoUrl: r.pro.photoUrl,
      specialisms: r.pro.specialisms ?? [],
      certifications: r.profile.certifications ?? [],
      yearsExperience: r.profile.yearsExperience,
      languages: r.profile.languages ?? ["en"],
      hourlyRatePaise: r.profile.hourlyRatePaise,
      asyncReviewPricePaise: r.profile.asyncReviewPricePaise,
      acceptsInPerson: r.profile.acceptsInPerson,
      acceptsAsync: r.profile.acceptsAsync,
      asyncTurnaroundHours: r.profile.asyncTurnaroundHours,
      // Task #1356 — surface the typed handicap window so the UI can
      // show "Coaches handicaps 10–36" badges next to the listing
      // without poking into JSONB.
      coachesHandicapMin: r.profile.coachesHandicapMin == null ? null : Number(r.profile.coachesHandicapMin),
      coachesHandicapMax: r.profile.coachesHandicapMax == null ? null : Number(r.profile.coachesHandicapMax),
      ratingsAvg: Number(r.profile.ratingsAvg ?? 0),
      ratingsCount: r.profile.ratingsCount,
      introVideoUrl: r.profile.intoVideoUrl,
    })),
  });
});

router.get("/coaches/:proId", async (req: Request, res: Response) => {
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  const [row] = await db.select({
    profile: coachMarketplaceProfilesTable,
    pro: teachingProsTable,
    organizationName: organizationsTable.name,
  })
    .from(teachingProsTable)
    .leftJoin(coachMarketplaceProfilesTable, eq(coachMarketplaceProfilesTable.proId, teachingProsTable.id))
    .leftJoin(organizationsTable, eq(organizationsTable.id, teachingProsTable.organizationId))
    .where(eq(teachingProsTable.id, proId));
  if (!row) { { res.status(404).json({ error: "Coach not found" }); return; } }

  const lessonTypes = await db.select().from(lessonTypesTable)
    .where(and(eq(lessonTypesTable.proId, proId), eq(lessonTypesTable.isActive, true)));

  // Recent reviews from delivered swing reviews with ratings
  const recentReviews = await db.select({
    rating: swingReviewRequestsTable.rating,
    comment: swingReviewRequestsTable.ratingComment,
    ratedAt: swingReviewRequestsTable.ratedAt,
  })
    .from(swingReviewRequestsTable)
    .where(and(
      eq(swingReviewRequestsTable.proId, proId),
      sql`${swingReviewRequestsTable.rating} IS NOT NULL`,
    ))
    .orderBy(desc(swingReviewRequestsTable.ratedAt))
    .limit(20);

  res.json({
    coach: {
      proId: row.pro.id,
      organizationId: row.pro.organizationId,
      organizationName: row.organizationName,
      displayName: row.pro.displayName,
      bio: row.pro.bio,
      photoUrl: row.pro.photoUrl,
      specialisms: row.pro.specialisms ?? [],
      certifications: row.profile?.certifications ?? [],
      yearsExperience: row.profile?.yearsExperience ?? 0,
      languages: row.profile?.languages ?? ["en"],
      hourlyRatePaise: row.profile?.hourlyRatePaise ?? 0,
      asyncReviewPricePaise: row.profile?.asyncReviewPricePaise ?? 0,
      acceptsInPerson: row.profile?.acceptsInPerson ?? false,
      acceptsAsync: row.profile?.acceptsAsync ?? false,
      asyncTurnaroundHours: row.profile?.asyncTurnaroundHours ?? 48,
      // Task #1356 — typed handicap window mirroring `/coaches`.
      coachesHandicapMin: row.profile?.coachesHandicapMin == null ? null : Number(row.profile.coachesHandicapMin),
      coachesHandicapMax: row.profile?.coachesHandicapMax == null ? null : Number(row.profile.coachesHandicapMax),
      ratingsAvg: Number(row.profile?.ratingsAvg ?? 0),
      ratingsCount: row.profile?.ratingsCount ?? 0,
      introVideoUrl: row.profile?.intoVideoUrl ?? null,
    },
    lessonTypes,
    recentReviews,
  });
});

/**
 * GET /admin/coaches?organizationId=:id
 * Org-admin listing of every teaching pro in the org with marketplace status,
 * revenue-share %, lifetime gross and outstanding (delivered+unpaid) balance.
 */
router.get("/admin/coaches", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const orgId = parseInt(String(req.query.organizationId ?? user.organizationId ?? "0"));
  if (!orgId) { { res.status(400).json({ error: "organizationId required" }); return; } }
  if (!(await isOrgAdmin(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const pros = await db.select({
    pro: teachingProsTable,
    profile: coachMarketplaceProfilesTable,
  })
    .from(teachingProsTable)
    .leftJoin(coachMarketplaceProfilesTable, eq(coachMarketplaceProfilesTable.proId, teachingProsTable.id))
    .where(eq(teachingProsTable.organizationId, orgId))
    .orderBy(desc(teachingProsTable.isActive), teachingProsTable.displayName);

  const proIds = pros.map(p => p.pro.id);
  const stats = proIds.length === 0 ? [] : await db.select({
    proId: swingReviewRequestsTable.proId,
    lifetimeGrossPaise: sql<number>`COALESCE(SUM(CASE WHEN ${swingReviewRequestsTable.status} = 'delivered' THEN ${swingReviewRequestsTable.pricePaise} ELSE 0 END),0)::int`,
    deliveredCount: sql<number>`COUNT(*) FILTER (WHERE ${swingReviewRequestsTable.status} = 'delivered')::int`,
    outstandingGrossPaise: sql<number>`COALESCE(SUM(CASE WHEN ${swingReviewRequestsTable.status} = 'delivered' AND ${swingReviewRequestsTable.payoutId} IS NULL THEN ${swingReviewRequestsTable.pricePaise} ELSE 0 END),0)::int`,
    outstandingCount: sql<number>`COUNT(*) FILTER (WHERE ${swingReviewRequestsTable.status} = 'delivered' AND ${swingReviewRequestsTable.payoutId} IS NULL)::int`,
  })
    .from(swingReviewRequestsTable)
    .where(inArray(swingReviewRequestsTable.proId, proIds))
    .groupBy(swingReviewRequestsTable.proId);

  const statsByPro = new Map<number, typeof stats[number]>();
  for (const s of stats) statsByPro.set(s.proId, s);

  res.json({
    coaches: pros.map(p => {
      const s = statsByPro.get(p.pro.id);
      const sharePct = Number(p.profile?.revenueSharePct ?? 70);
      const lifetimeGross = s?.lifetimeGrossPaise ?? 0;
      const outstandingGross = s?.outstandingGrossPaise ?? 0;
      return {
        proId: p.pro.id,
        displayName: p.pro.displayName,
        isActive: p.pro.isActive,
        userId: p.pro.userId,
        isListed: p.profile?.isListed ?? false,
        revenueSharePct: sharePct,
        lifetimeGrossPaise: lifetimeGross,
        lifetimeNetPayoutPaise: Math.round(lifetimeGross * sharePct / 100),
        deliveredCount: s?.deliveredCount ?? 0,
        outstandingGrossPaise: outstandingGross,
        outstandingNetPayoutPaise: Math.round(outstandingGross * sharePct / 100),
        outstandingCount: s?.outstandingCount ?? 0,
        // Task #1221 — surface the saved payout-verification state inline so
        // admins can see who needs attention without opening each coach.
        payoutMethod: p.profile?.payoutMethod ?? null,
        payoutVerificationStatus: p.profile?.payoutVerificationStatus ?? null,
        payoutVerifiedAt: p.profile?.payoutVerifiedAt ?? null,
        payoutVerificationFailureReason: p.profile?.payoutVerificationFailureReason ?? null,
      };
    }),
  });
});

router.get("/me/coach-profile", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.json({ pro: null, profile: null }); return; } }
  const [profile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, pro.id));
  res.json({ pro, profile: profile ?? null });
});

/**
 * Task #764 — Payout-account change history.
 *
 * GET /me/payout-account/history
 *   Returns the most recent N (default 20) audit rows for the calling
 *   coach's own profile. 200 with `{ history: [] }` if the caller is not a
 *   registered coach yet (so the workspace UI never has to special-case 404).
 *
 * GET /admin/coaches/:proId/payout-account/history
 *   Org-admin (or super-admin) version. Authorised via `isOrgAdmin` against
 *   the coach's own organization.
 */
// Task #1427 — accepted values for the optional change-type filter on
// the payout-account history endpoints. Mirrors `coachPayoutAccountHistoryTable.changeKind`.
const PAYOUT_HISTORY_CHANGE_KINDS = ["created", "updated", "admin_reverify"] as const;
type PayoutHistoryChangeKind = typeof PAYOUT_HISTORY_CHANGE_KINDS[number];

function parseChangeKindFilter(raw: unknown): PayoutHistoryChangeKind | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "all") return null;
  return (PAYOUT_HISTORY_CHANGE_KINDS as readonly string[]).includes(trimmed)
    ? (trimmed as PayoutHistoryChangeKind)
    : null;
}

async function loadPayoutAccountHistory(proId: number, limit = 20, changeKind: PayoutHistoryChangeKind | null = null) {
  const whereClause = changeKind
    ? and(
      eq(coachPayoutAccountHistoryTable.proId, proId),
      eq(coachPayoutAccountHistoryTable.changeKind, changeKind),
    )
    : eq(coachPayoutAccountHistoryTable.proId, proId);
  const rows = await db.select({
    history: coachPayoutAccountHistoryTable,
    changedByName: appUsersTable.displayName,
    changedByUsername: appUsersTable.username,
  })
    .from(coachPayoutAccountHistoryTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, coachPayoutAccountHistoryTable.changedByUserId))
    .where(whereClause)
    .orderBy(desc(coachPayoutAccountHistoryTable.createdAt))
    .limit(limit);
  return rows.map(r => ({
    id: r.history.id,
    changeKind: r.history.changeKind,
    method: r.history.method,
    accountHolderName: r.history.accountHolderName,
    upiVpaMasked: r.history.upiVpaMasked,
    bankAccountLast4: r.history.bankAccountLast4,
    bankIfsc: r.history.bankIfsc,
    payoutAccountId: r.history.payoutAccountId,
    changedByUserId: r.history.changedByUserId,
    changedByRole: r.history.changedByRole,
    changedByName: r.changedByName ?? r.changedByUsername ?? null,
    // Task #1222 — surface the verification outcome/reason on
    // `admin_reverify` rows so the workspace + admin UI can show what
    // an admin re-check actually concluded.
    verificationOutcome: r.history.verificationOutcome,
    verificationReason: r.history.verificationReason,
    ipAddress: r.history.ipAddress,
    userAgent: r.history.userAgent,
    createdAt: r.history.createdAt,
  }));
}

router.get("/me/payout-account/history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.json({ history: [] }); return; } }
  // Task #1720 — coaches reviewing their own audit trail can also
  // narrow by change kind (e.g. just `admin_reverify` rows that
  // explain the most recent state change). Mirrors the filter the
  // org-admin endpoint accepts.
  const changeKind = parseChangeKindFilter(req.query.changeKind);
  const history = await loadPayoutAccountHistory(pro.id, 20, changeKind);
  res.json({ history });
});

/**
 * Task #1701 — Coach-scoped notification dispatch trail.
 *
 * GET /me/payout-account/notification-history
 *   Returns the per-channel `notification_audit_log` rows that
 *   `notifyCoachPayoutAccountChanged` (Task #1406) writes when this coach's
 *   payout account is created or updated.
 *
 * Filtered to the authenticated coach's own `userId` and the
 * `coach.payout.account.changed.coach` key — a coach can only see their own
 * dispatch trail (no cross-coach leakage). The admin-facing notification
 * audit page (`/notification-audit`) remains the way to see every key /
 * every recipient; this endpoint is the coach's read-only slice.
 *
 * Each row carries the leg's `status` (sent / failed / skipped /
 * opted_out / no_address) and a `reason` (e.g. `push_opted_out`,
 * `no_email_on_file`) so the workspace UI can show why a leg didn't
 * land. The `payload.historyId` lets the UI group rows by the
 * underlying `coach_payout_account_history` row that triggered the
 * fan-out.
 *
 * 200 with `{ entries: [] }` if the caller is not a registered coach yet
 * (so the workspace UI doesn't have to special-case 404).
 */
const COACH_PAYOUT_NOTIFY_KEY = "coach.payout.account.changed.coach";

router.get("/me/payout-account/notification-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.json({ entries: [] }); return; } }
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? "200")) || 200));
  const rows = await db.select({
    id: notificationAuditLogTable.id,
    channel: notificationAuditLogTable.channel,
    status: notificationAuditLogTable.status,
    reason: notificationAuditLogTable.reason,
    payload: notificationAuditLogTable.payload,
    createdAt: notificationAuditLogTable.createdAt,
  })
    .from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, user.id),
      eq(notificationAuditLogTable.notificationKey, COACH_PAYOUT_NOTIFY_KEY),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt))
    .limit(limit);
  res.json({
    entries: rows.map(r => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      reason: r.reason,
      historyId: typeof r.payload?.historyId === "number" ? r.payload.historyId as number : null,
      createdAt: r.createdAt,
    })),
  });
});

router.get("/admin/coaches/:proId/payout-account/history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }
  if (!(await isOrgAdmin(user, pro.organizationId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const limit = Math.max(1, Math.min(10000, parseInt(String(req.query.limit ?? "1000")) || 1000));
  // Task #1427 — optional change-type filter so admin reviewers can
  // narrow the dialog (and per-coach CSV export) to e.g.
  // `admin_reverify` rows for compliance/incident triage.
  const changeKind = parseChangeKindFilter(req.query.changeKind);
  const history = await loadPayoutAccountHistory(proId, limit, changeKind);
  res.json({ history });
});

/**
 * GET /admin/payout-account/history?organizationId=:id
 * Org-admin export endpoint: returns audit-trail rows for *every* teaching
 * pro in the org. Used by the admin UI's "Export history (CSV)" control to
 * produce a periodic compliance/finance audit feed.
 */
router.get("/admin/payout-account/history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const orgId = parseInt(String(req.query.organizationId ?? user.organizationId ?? "0"));
  if (!orgId) { { res.status(400).json({ error: "organizationId required" }); return; } }
  if (!(await isOrgAdmin(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const limit = Math.max(1, Math.min(50000, parseInt(String(req.query.limit ?? "10000")) || 10000));
  // Task #1427 — optional change-type filter mirroring the per-coach
  // dialog. Lets compliance reviewers download just the
  // `admin_reverify` audit rows in a single CSV.
  const changeKind = parseChangeKindFilter(req.query.changeKind);
  const whereClause = changeKind
    ? and(
      eq(teachingProsTable.organizationId, orgId),
      eq(coachPayoutAccountHistoryTable.changeKind, changeKind),
    )
    : eq(teachingProsTable.organizationId, orgId);

  const rows = await db.select({
    history: coachPayoutAccountHistoryTable,
    proName: teachingProsTable.displayName,
    changedByName: appUsersTable.displayName,
    changedByUsername: appUsersTable.username,
  })
    .from(coachPayoutAccountHistoryTable)
    .innerJoin(teachingProsTable, eq(teachingProsTable.id, coachPayoutAccountHistoryTable.proId))
    .leftJoin(appUsersTable, eq(appUsersTable.id, coachPayoutAccountHistoryTable.changedByUserId))
    .where(whereClause)
    .orderBy(desc(coachPayoutAccountHistoryTable.createdAt))
    .limit(limit);

  res.json({
    history: rows.map(r => ({
      id: r.history.id,
      proId: r.history.proId,
      proName: r.proName,
      changeKind: r.history.changeKind,
      method: r.history.method,
      accountHolderName: r.history.accountHolderName,
      upiVpaMasked: r.history.upiVpaMasked,
      bankAccountLast4: r.history.bankAccountLast4,
      bankIfsc: r.history.bankIfsc,
      payoutAccountId: r.history.payoutAccountId,
      changedByUserId: r.history.changedByUserId,
      changedByRole: r.history.changedByRole,
      changedByName: r.changedByName ?? r.changedByUsername ?? null,
      verificationOutcome: r.history.verificationOutcome,
      verificationReason: r.history.verificationReason,
      ipAddress: r.history.ipAddress,
      userAgent: r.history.userAgent,
      createdAt: r.history.createdAt,
    })),
  });
});

/**
 * POST /admin/coaches/:proId/payout-account/reverify  (Task #1062)
 * Org-admin (or super-admin) trigger that re-runs the same VPA /
 * bank-fund-account validation the daily cron uses against a single
 * coach's saved payout account. Returns the resulting outcome
 * (`verified` / `needs_attention` / `skipped` / `error`) so the admin
 * UI can show inline feedback instead of waiting for the nightly batch.
 */
router.post("/admin/coaches/:proId/payout-account/reverify", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }
  if (!(await isOrgAdmin(user, pro.organizationId))) { { res.status(403).json({ error: "Forbidden" }); return; } }

  // Snapshot the saved payout account *before* re-running the validation so
  // the audit row carries the same masked details (UPI/last4/IFSC) as the
  // coach- and admin-initiated change rows. We refuse the re-verify call
  // if there's nothing to validate (mirrors `reverifyCoachPayoutAccountById`).
  const [profileBefore] = await db.select()
    .from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId));
  if (!profileBefore || !profileBefore.payoutAccountId || !profileBefore.payoutMethod) {
    res.status(400).json({ error: "Coach has no saved payout account to re-verify" });
    return;
  }

  const result = await reverifyCoachPayoutAccountById(proId);
  if (!result) {
    // Should be unreachable thanks to the guard above, but keep the same
    // friendly response shape if `reverifyCoachPayoutAccountById` ever
    // returns null for some other reason.
    res.status(400).json({ error: "Coach has no saved payout account to re-verify" });
    return;
  }

  // Task #1222 — Record the admin-triggered re-verification in the audit
  // trail. This closes the compliance gap where the nightly cron and
  // coach-initiated saves are recorded but admin-on-behalf re-checks were
  // not, making "who triggered the re-check that flipped this coach to
  // needs_attention?" unanswerable.
  //
  // Persistence is *mandatory*: the response only signals success once
  // the audit row is committed. If the insert fails, log the original
  // outcome (so the admin's action is still recoverable from logs) and
  // return 500 so the admin retries — `reverifyOne` is idempotent
  // (re-running it converges on the same verification status), so a
  // retry will produce a single audit row once persistence succeeds
  // rather than leaving an unaudited state change.
  const ipAddress = req.ip
    ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? null;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
  // Captured once and reused for both the audit row and the coach
  // courtesy email below so the "re-verified on" date in the email
  // matches the timestamp persisted to the audit log within the
  // same request.
  const reverifiedAt = new Date();
  try {
    await recordAdminReverifyHistory({
      proId,
      organizationId: pro.organizationId,
      adminUserId: user.id,
      profileBefore,
      outcome: result.outcome,
      reason: result.reason ?? null,
      ipAddress,
      userAgent,
    });
  } catch (auditErr) {
    payoutLogger.error(
      { err: auditErr, proId, adminUserId: user.id, outcome: result.outcome, reason: result.reason },
      "[coach-marketplace] failed to record admin re-verify audit row — failing the request to preserve the audit guarantee",
    );
    res.status(500).json({ error: "Failed to record audit entry; please retry" });
    return;
  }

  payoutLogger.info(
    { proId, adminUserId: user.id, outcome: result.outcome },
    "[coach-marketplace] Admin-triggered payout-account re-verification",
  );

  // Task #1428 — Email the coach a courtesy notice that an admin has
  // manually re-verified their payout account. Fires for both `verified`
  // and `needs_attention` outcomes (skips `skipped`/`error` which mean
  // we never actually re-checked the account against the bank). The
  // helper honours the coach's `billing` comm-prefs opt-out so members
  // who silenced transactional payout messages won't get this either.
  // Best-effort: any failure is logged inside the helper; we never fail
  // the admin's request because the courtesy notice didn't land.
  if (result.outcome === "verified" || result.outcome === "needs_attention") {
    await notifyCoachOfAdminReverify({
      profile: profileBefore,
      outcome: result.outcome,
      reason: result.reason ?? null,
      reverifiedAt,
    });
  }

  res.json({
    outcome: result.outcome,
    method: result.method,
    reason: result.reason ?? null,
  });
});

async function authorizeProManagement(req: Request, res: Response, proId: number, requireAdmin = false): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = getUser(req)!;
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { res.status(404).json({ error: "Pro not found" }); return false; }
  const admin = await isOrgAdmin(user, pro.organizationId);
  if (requireAdmin && !admin) { res.status(403).json({ error: "Forbidden" }); return false; }
  if (!admin && pro.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

/* ─── Coach: register/update payout account ─────────────────────────────
 * Body: { method: "upi", upiVpa, accountHolderName, contact?, email? }
 *  or:  { method: "bank_account", bankAccountNumber, bankIfsc, accountHolderName, contact?, email? }
 *
 * Creates (or reuses) a Razorpay contact + a fund_account on RazorpayX,
 * and stores the resulting `razorpay_contact_id` + `payout_account_id`
 * (= fund_account id) on the coach's marketplace profile so the payouts
 * job can disburse to it automatically.
 */
router.post("/me/payout-account", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.status(403).json({ error: "Not a registered coach" }); return; } }

  const body = req.body as Record<string, unknown>;
  const method = String(body.method ?? "").toLowerCase();
  if (method !== "upi" && method !== "bank_account") {
    res.status(400).json({ error: "method must be 'upi' or 'bank_account'" }); return;
  }
  const isConfirm = body.confirm === true;

  // ── Confirm-leg short-circuit ──────────────────────────────────────
  // Confirm requires only { method, confirm: true, verificationToken }.
  // All persisted values come from the signed token, never from the
  // request body, so we don't accept (or trust) account-detail fields
  // here.
  const [existingProfile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, pro.id));

  if (isConfirm) {
    const providedToken = typeof body.verificationToken === "string" ? body.verificationToken : "";
    const verified = verifyPayoutVerificationToken(providedToken, pro.id);
    if (!verified) {
      res.status(400).json({ error: "Verification expired or invalid — please verify the account again." });
      return;
    }
    if (verified.method !== method) {
      res.status(400).json({ error: "Verification method does not match — please verify again." });
      return;
    }
    try {
      const update: Record<string, unknown> = {
        payoutMethod: verified.method,
        payoutAccountHolderName: verified.accountHolderName,
        payoutVpa: verified.method === "upi" ? verified.upiVpa ?? null : null,
        payoutBankAccountNumber: verified.method === "bank_account" ? verified.bankAccountNumber ?? null : null,
        payoutBankIfsc: verified.method === "bank_account" ? verified.bankIfsc ?? null : null,
        razorpayContactId: verified.razorpayContactId,
        payoutAccountId: verified.fundAccountId,
        // Task #913 — every successful save counts as a fresh verification.
        // Resets the periodic re-verify clock and clears any prior
        // needs-attention flag/banner from a previous failed re-validation.
        payoutVerifiedAt: new Date(),
        payoutVerificationStatus: "verified",
        payoutVerificationFailureReason: null,
        updatedAt: new Date(),
      };

      // Task #764 — persist the payout-account change *and* its audit-trail
      // row in a single transaction so the two cannot diverge. If the
      // history insert fails, we roll back the profile update too rather
      // than silently losing the audit record.
      const ipAddress = (req.ip
        ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? null) as string | null;
      const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

      const { row, historyId } = await db.transaction(async (tx) => {
        let saved;
        if (existingProfile) {
          [saved] = await tx.update(coachMarketplaceProfilesTable).set(update)
            .where(eq(coachMarketplaceProfilesTable.proId, pro.id)).returning();
        } else {
          [saved] = await tx.insert(coachMarketplaceProfilesTable).values({
            proId: pro.id, organizationId: pro.organizationId, ...update,
          }).returning();
        }
        const [hist] = await tx.insert(coachPayoutAccountHistoryTable).values({
          proId: pro.id,
          organizationId: pro.organizationId,
          changedByUserId: user.id,
          changedByRole: "coach",
          changeKind: existingProfile ? "updated" : "created",
          method: verified.method,
          accountHolderName: verified.accountHolderName,
          upiVpaMasked: verified.method === "upi" && verified.upiVpa ? maskUpiVpa(verified.upiVpa) : null,
          bankAccountLast4: verified.method === "bank_account" && verified.bankAccountNumber
            ? verified.bankAccountNumber.slice(-4) : null,
          bankIfsc: verified.method === "bank_account" ? verified.bankIfsc ?? null : null,
          razorpayContactId: verified.razorpayContactId,
          payoutAccountId: verified.fundAccountId,
          ipAddress,
          userAgent,
        }).returning({ id: coachPayoutAccountHistoryTable.id });
        return { row: saved, historyId: hist?.id };
      });

      // Task #915 — fire-and-forget security alert to the coach so they
      // hear about the change immediately and can spot unauthorised
      // edits. Email delivery never blocks the API response and never
      // unwinds the just-committed save.
      if (historyId) {
        void notifyCoachPayoutAccountChanged(historyId).catch((notifyErr) => {
          payoutLogger.warn(
            { err: notifyErr, proId: pro.id, historyId },
            "[coach-marketplace] payout-account change notify failed",
          );
        });
      }

      let retried: Awaited<ReturnType<typeof retryStuckCoachPayouts>> = [];
      try {
        retried = await retryStuckCoachPayouts(
          pro.id,
          row,
          existingProfile ? "payout_account_updated" : "payout_account_registered",
        );
      } catch (retryErr) {
        payoutLogger.error(
          { err: retryErr, proId: pro.id },
          "[coach-marketplace] Auto-retry of stuck payouts failed",
        );
      }

      res.json({
        profile: row,
        payoutAccount: {
          method: verified.method,
          razorpayContactId: verified.razorpayContactId,
          razorpayFundAccountId: verified.fundAccountId,
          accountHolderName: verified.accountHolderName,
          verifiedHolderName: verified.verifiedHolderName,
          upiVpa: verified.method === "upi" ? verified.upiVpa : undefined,
          bankAccountLast4: verified.method === "bank_account" ? verified.bankAccountNumber?.slice(-4) : undefined,
          bankIfsc: verified.method === "bank_account" ? verified.bankIfsc : undefined,
        },
        retriedPayouts: retried,
        retriedSummary: {
          attempted: retried.length,
          processing: retried.filter(r => r.status === "processing").length,
          pending: retried.filter(r => r.status === "pending").length,
          failed: retried.filter(r => r.status === "failed").length,
        },
      });
      return;
    } catch (err) {
      payoutLogger.error({ err, proId: pro.id }, "[coach-marketplace] Failed to persist verified payout account");
      const message = err instanceof Error ? err.message : "Failed to save payout account";
      res.status(502).json({ error: message });
      return;
    }
  }

  // ── Verify-leg input validation ────────────────────────────────────
  const accountHolderName = typeof body.accountHolderName === "string" ? body.accountHolderName.trim() : "";
  if (!accountHolderName) { { res.status(400).json({ error: "accountHolderName required" }); return; } }

  const contact = typeof body.contact === "string" ? body.contact.trim() : undefined;
  const email = typeof body.email === "string" ? body.email.trim() : undefined;

  let upiVpa: string | undefined;
  let bankAccountNumber: string | undefined;
  let bankIfsc: string | undefined;

  if (method === "upi") {
    upiVpa = typeof body.upiVpa === "string" ? body.upiVpa.trim() : "";
    if (!upiVpa || !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiVpa)) {
      res.status(400).json({ error: "Valid upiVpa required (e.g. name@bank)" }); return;
    }
  } else {
    bankAccountNumber = typeof body.bankAccountNumber === "string" ? body.bankAccountNumber.replace(/\s+/g, "") : "";
    bankIfsc = typeof body.bankIfsc === "string" ? body.bankIfsc.toUpperCase().trim() : "";
    if (!bankAccountNumber || !/^\d{6,20}$/.test(bankAccountNumber)) {
      res.status(400).json({ error: "Valid bankAccountNumber required" }); return;
    }
    if (!bankIfsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc)) {
      res.status(400).json({ error: "Valid bankIfsc required" }); return;
    }
  }

  // ── Verify leg ─────────────────────────────────────────────────────
  // Reuse existing Razorpay contact if we already created one for this coach
  let razorpayContactId = existingProfile?.razorpayContactId ?? null;
  try {
    if (!razorpayContactId) {
      const created = await createRazorpayContact({
        name: accountHolderName,
        email,
        contact,
        type: "vendor",
        reference_id: `coach_${pro.id}`,
        notes: { proId: String(pro.id), organizationId: String(pro.organizationId) },
      });
      razorpayContactId = created.id;
    }

    const fundAccount = method === "upi"
      ? await createRazorpayFundAccount({
          contact_id: razorpayContactId,
          account_type: "vpa",
          vpa: { address: upiVpa! },
        })
      : await createRazorpayFundAccount({
          contact_id: razorpayContactId,
          account_type: "bank_account",
          bank_account: {
            name: accountHolderName,
            ifsc: bankIfsc!,
            account_number: bankAccountNumber!,
          },
        });

    let verifiedHolderName: string | null = null;
    try {
      if (method === "upi") {
        const v = await validateRazorpayVpa(upiVpa!);
        if (!v.success) {
          res.status(422).json({
            error: "We couldn't verify this UPI ID with the bank. Double-check the VPA and try again.",
            verification: { status: "failed", method },
          });
          return;
        }
        verifiedHolderName = v.customer_name?.trim() || null;
      } else {
        const v = await validateRazorpayBankFundAccount(fundAccount.id);
        if (v.status === "failed" || v.results?.account_status === "invalid") {
          res.status(422).json({
            error: v.error?.description
              ?? "We couldn't verify this bank account with a ₹1 test deposit. Double-check the account number and IFSC.",
            verification: { status: "failed", method },
          });
          return;
        }
        if (v.status !== "completed") {
          res.status(422).json({
            error: "Bank verification is taking longer than expected. Please try again in a minute.",
            verification: { status: "pending", method },
          });
          return;
        }
        verifiedHolderName = v.results?.registered_name?.trim() || null;
      }
    } catch (verifyErr) {
      payoutLogger.error({ err: verifyErr, proId: pro.id }, "[coach-marketplace] Fund-account verification call failed");
      res.status(422).json({
        error: "We couldn't verify this account right now. Double-check your details and try again in a moment.",
        verification: { status: "failed", method },
      });
      return;
    }

    const tokenPayload: VerifiedPayoutTokenPayload = {
      proId: pro.id,
      method,
      accountHolderName,
      verifiedHolderName,
      fundAccountId: fundAccount.id,
      razorpayContactId,
      ...(method === "upi"
        ? { upiVpa: upiVpa! }
        : { bankAccountNumber: bankAccountNumber!, bankIfsc: bankIfsc! }),
      exp: Date.now() + VERIFICATION_TOKEN_TTL_MS,
    };
    const verificationToken = signPayoutVerificationToken(tokenPayload);

    res.json({
      verification: {
        status: "verified",
        method,
        verifiedHolderName,
        fundAccountId: fundAccount.id,
        razorpayContactId,
        accountHolderName,
        upiVpa: method === "upi" ? upiVpa : undefined,
        bankAccountLast4: method === "bank_account" ? bankAccountNumber!.slice(-4) : undefined,
        bankIfsc: method === "bank_account" ? bankIfsc : undefined,
        verificationToken,
        expiresAt: tokenPayload.exp,
      },
    });
    return;
  } catch (err) {
    payoutLogger.error({ err, proId: pro.id }, "[coach-marketplace] Failed to verify payout account");
    const message = err instanceof Error ? err.message : "Failed to verify payout account";
    res.status(502).json({ error: message });
  }
});

router.post("/pros/:proId/profile", async (req: Request, res: Response) => {
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  if (!(await authorizeProManagement(req, res, proId))) return;
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }

  const body = req.body as Record<string, unknown>;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (Array.isArray(body.certifications)) update.certifications = body.certifications;
  if (typeof body.yearsExperience === "number") update.yearsExperience = body.yearsExperience;
  if (Array.isArray(body.languages)) update.languages = body.languages;
  if (typeof body.hourlyRatePaise === "number") update.hourlyRatePaise = body.hourlyRatePaise;
  if (typeof body.asyncReviewPricePaise === "number") update.asyncReviewPricePaise = body.asyncReviewPricePaise;
  if (typeof body.acceptsInPerson === "boolean") update.acceptsInPerson = body.acceptsInPerson;
  if (typeof body.acceptsAsync === "boolean") update.acceptsAsync = body.acceptsAsync;
  if (typeof body.asyncTurnaroundHours === "number") update.asyncTurnaroundHours = body.asyncTurnaroundHours;
  if (typeof body.payoutAccountId === "string") update.payoutAccountId = body.payoutAccountId;
  if (typeof body.introVideoUrl === "string") update.intoVideoUrl = body.introVideoUrl;
  // Task #1356 — Accept the typed handicap-window from the coach
  // onboarding/profile form. Numeric values are stored as `numeric(4,1)`
  // strings on the wire (Drizzle convention for the `numeric` type), and
  // an explicit `null` clears the bound. Anything else is silently
  // ignored (matches the rest of this endpoint's "skip unknown shapes"
  // behaviour).
  for (const key of ["coachesHandicapMin", "coachesHandicapMax"] as const) {
    if (key in body) {
      const v = body[key];
      if (v === null) {
        update[key] = null;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        update[key] = String(v);
      } else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        update[key] = String(Number(v));
      }
    }
  }

  const [existing] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId));

  // Task #2013 — Reject inverted handicap windows (Min > Max). Without
  // this guard a coach could silently save Min=20/Max=5, after which the
  // marketplace `?handicap=` filter (which requires both bounds to match)
  // would never include them at any handicap. We validate against the
  // *merged* state so a partial update that only changes one side is
  // still checked against the other side already on the row.
  const finalMin = ("coachesHandicapMin" in update)
    ? (update.coachesHandicapMin as string | null)
    : (existing?.coachesHandicapMin ?? null);
  const finalMax = ("coachesHandicapMax" in update)
    ? (update.coachesHandicapMax as string | null)
    : (existing?.coachesHandicapMax ?? null);
  if (finalMin != null && finalMax != null) {
    const minN = Number(finalMin);
    const maxN = Number(finalMax);
    if (Number.isFinite(minN) && Number.isFinite(maxN) && minN > maxN) {
      res.status(400).json({
        error: "Min handicap must be less than or equal to Max handicap.",
      });
      return;
    }
  }
  let row;
  if (existing) {
    [row] = await db.update(coachMarketplaceProfilesTable).set(update)
      .where(eq(coachMarketplaceProfilesTable.proId, proId)).returning();
  } else {
    [row] = await db.insert(coachMarketplaceProfilesTable).values({
      proId, organizationId: pro.organizationId, ...update,
    }).returning();
  }
  res.json({ profile: row });
});

router.post("/pros/:proId/list", async (req: Request, res: Response) => {
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  if (!(await authorizeProManagement(req, res, proId))) return;
  const { isListed } = req.body as { isListed?: boolean };
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }
  const [existing] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId));
  let row;
  if (existing) {
    [row] = await db.update(coachMarketplaceProfilesTable)
      .set({ isListed: !!isListed, updatedAt: new Date() })
      .where(eq(coachMarketplaceProfilesTable.proId, proId))
      .returning();
  } else {
    [row] = await db.insert(coachMarketplaceProfilesTable).values({
      proId, organizationId: pro.organizationId, isListed: !!isListed,
    }).returning();
  }
  res.json({ profile: row });
});

router.post("/pros/:proId/revenue-share", async (req: Request, res: Response) => {
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!proId) { { res.status(400).json({ error: "Invalid proId" }); return; } }
  if (!(await authorizeProManagement(req, res, proId, /*requireAdmin*/ true))) return;
  const { revenueSharePct } = req.body as { revenueSharePct?: number };
  const pct = Number(revenueSharePct);
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    res.status(400).json({ error: "revenueSharePct must be between 0 and 100" }); return;
  }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proId));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }
  const [existing] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId));
  let row;
  if (existing) {
    [row] = await db.update(coachMarketplaceProfilesTable)
      .set({ revenueSharePct: String(pct), updatedAt: new Date() })
      .where(eq(coachMarketplaceProfilesTable.proId, proId))
      .returning();
  } else {
    [row] = await db.insert(coachMarketplaceProfilesTable).values({
      proId, organizationId: pro.organizationId, revenueSharePct: String(pct),
    }).returning();
  }
  res.json({ profile: row });
});

export default router;
