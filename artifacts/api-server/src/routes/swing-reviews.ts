/**
 * Async Swing-Review Workflow API
 *
 * Member flow:
 *   POST   /requests                            Create review request + Razorpay order (escrow)
 *   POST   /requests/:id/payment/verify         Verify payment (moves to "paid" + escrow_held=true)
 *   GET    /my-requests                         My review requests
 *   GET    /requests/:id                        Get request detail (with annotation)
 *   POST   /requests/:id/rate                   Rate after delivery (1-5 stars + comment)
 *   POST   /requests/:id/refund                 Member-initiated refund (only if expired/not delivered)
 *
 * Coach flow:
 *   GET    /coach/queue                         My queue (auth=coach user)
 *   POST   /requests/:id/start                  Move to in_review
 *   POST   /requests/:id/deliver                Submit annotation (drawings/voice/text) + mark delivered + queue payout
 *   GET    /coach/earnings                      Coach earnings & payouts
 *   GET    /coach/payouts/:id/requests          Swing-review requests rolled up into one of the coach's payouts
 *   POST   /coach/payouts/:id/retry-notification Coach-side "Try again" — resets push/SMS attempts on their own payout (Task #1543)
 *
 * Admin flow:
 *   GET    /admin/payouts                       List all payouts (org admin) + per-payout push/SMS notification status
 *   POST   /admin/payouts/:id/mark-paid         Mark payout paid + ref
 *   POST   /admin/payouts/:id/resend-notification  Reset push/SMS attempts so the cron re-fires the payout-paid notification (Task #1129)
 *   POST   /admin/payouts/run                   Aggregate delivered+unpaid into a new payout per coach
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  teachingProsTable,
  swingVideosTable,
  swingReviewRequestsTable,
  swingAnnotationsTable,
  coachMarketplaceProfilesTable,
  coachDrawingPresetsTable,
  coachPayoutsTable,
  coachPayoutNotificationsTable,
  coachPayoutNotificationAttemptsTable,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  clubMembersTable,
  memberCommPrefsTable,
  deviceTokensTable,
} from "@workspace/db";
import { eq, and, desc, sql, isNull, inArray } from "drizzle-orm";
import {
  COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS,
  COACH_PAYOUT_REPEAT_RETRY_ADMIN_THRESHOLD,
} from "@workspace/coach-payout-labels";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { disburseCoachPayout } from "../lib/coachPayouts";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { verifySwingUpload } from "../lib/swingUploadToken";
import { sendCoachPayoutPaidEmail, classifyMailerError, type EmailBranding } from "../lib/mailer";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms";
import { classifyPushDelivery } from "../lib/push";
import { maskPhoneForCoach, buildPushDeviceLabel } from "../lib/coachPayoutNotifyTargets";
import {
  COACH_PAYOUT_MAX_EMAIL_ATTEMPTS,
  computeCoachPayoutNextEmailRetryAt,
  notifyAdminsOfCoachPayoutRetryExhaustion,
  notifyAdminsOfRepeatedCoachPayoutRetries,
} from "../lib/coachPayoutNotify";
import crypto from "crypto";

const router: IRouter = Router({ mergeParams: true });
const storage = new ObjectStorageService();

interface SessionUser { id: number; role?: string; organizationId?: number | null; displayName?: string; email?: string }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

async function isOrgAdmin(user: SessionUser, orgId: number): Promise<boolean> {
  if (user.role === "super_admin") return true;
  if (["org_admin", "tournament_director"].includes(user.role ?? "") && user.organizationId === orgId) return true;
  const [mem] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  return !!mem && ["org_admin", "tournament_director"].includes(mem.role);
}

async function getProForUser(userId: number) {
  const [pro] = await db.select().from(teachingProsTable)
    .where(eq(teachingProsTable.userId, userId)).limit(1);
  return pro;
}

/* ─── Member: create review request ──────────────────────── */
router.post("/requests", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const { proId, swingVideoId, memberPrompt } = req.body as Record<string, unknown>;
  const proIdN = parseInt(String(proId));
  const videoId = parseInt(String(swingVideoId));
  if (!proIdN || !videoId) { { res.status(400).json({ error: "proId and swingVideoId required" }); return; } }

  const [video] = await db.select().from(swingVideosTable).where(eq(swingVideosTable.id, videoId));
  if (!video || video.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, proIdN));
  if (!pro || !pro.isActive) { { res.status(404).json({ error: "Coach unavailable" }); return; } }

  const [profile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proIdN));
  if (!profile || !profile.isListed || !profile.acceptsAsync) {
    res.status(400).json({ error: "Coach is not accepting async reviews" }); return;
  }
  const price = profile.asyncReviewPricePaise;
  if (price <= 0) { { res.status(400).json({ error: "Coach has not set a review price" }); return; } }

  const dueAt = new Date(Date.now() + profile.asyncTurnaroundHours * 3600 * 1000);
  const [request] = await db.insert(swingReviewRequestsTable).values({
    organizationId: pro.organizationId,
    proId: proIdN,
    userId: user.id,
    swingVideoId: videoId,
    memberPrompt: typeof memberPrompt === "string" ? memberPrompt : null,
    pricePaise: price,
    status: "pending_payment",
    dueAt,
  }).returning();

  try {
    const rzp = getRazorpayClient();
    const keyId = getRazorpayKeyId();
    const order = await rzp.orders.create({
      amount: price, currency: "INR", receipt: `swing-review-${request.id}`,
      notes: { reviewRequestId: String(request.id), proId: String(proIdN) },
    });
    await db.update(swingReviewRequestsTable)
      .set({ razorpayOrderId: order.id, updatedAt: new Date() })
      .where(eq(swingReviewRequestsTable.id, request.id));
    res.json({
      request: { ...request, razorpayOrderId: order.id },
      razorpayOrder: { orderId: order.id, amount: price, currency: "INR", keyId },
    });
  } catch (e) {
    logger.error({ e }, "[swing-reviews] Razorpay order failed");
    await db.delete(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.id, request.id));
    res.status(500).json({ error: "Payment gateway error" });
  }
});

router.post("/requests/:id/payment/verify", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [request] = await db.select().from(swingReviewRequestsTable)
    .where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  if (request.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as Record<string, string>;
  if (!request.razorpayOrderId || request.razorpayOrderId !== razorpayOrderId) {
    res.status(400).json({ error: "Order ID mismatch" }); return;
  }
  if (request.status !== "pending_payment") {
    res.json({ success: true, alreadyConfirmed: true }); return;
  }
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) { { res.status(500).json({ error: "Payment verification not configured" }); return; } }
  const expected = crypto.createHmac("sha256", secret).update(razorpayOrderId + "|" + razorpayPaymentId).digest("hex");
  if (expected !== razorpaySignature) { { res.status(400).json({ error: "Invalid signature" }); return; } }

  await db.update(swingReviewRequestsTable).set({
    status: "paid", razorpayPaymentId, escrowHeld: true, updatedAt: new Date(),
  }).where(eq(swingReviewRequestsTable.id, id));
  res.json({ success: true });
});

router.get("/my-requests", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const rows = await db.select({
    request: swingReviewRequestsTable,
    proName: teachingProsTable.displayName,
    proPhoto: teachingProsTable.photoUrl,
    videoUrl: swingVideosTable.videoUrl,
    videoThumb: swingVideosTable.thumbnailUrl,
    videoFps: swingVideosTable.fps,
  })
    .from(swingReviewRequestsTable)
    .innerJoin(teachingProsTable, eq(teachingProsTable.id, swingReviewRequestsTable.proId))
    .innerJoin(swingVideosTable, eq(swingVideosTable.id, swingReviewRequestsTable.swingVideoId))
    .where(eq(swingReviewRequestsTable.userId, user.id))
    .orderBy(desc(swingReviewRequestsTable.createdAt))
    .limit(100);
  res.json({ requests: rows });
});

router.get("/requests/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [request] = await db.select().from(swingReviewRequestsTable)
    .where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  const pro = (await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, request.proId)))[0];
  const isOwner = request.userId === user.id;
  const isCoach = !!pro && pro.userId === user.id;
  const admin = await isOrgAdmin(user, request.organizationId);
  if (!isOwner && !isCoach && !admin) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const [video] = await db.select().from(swingVideosTable).where(eq(swingVideosTable.id, request.swingVideoId));
  let annotation = null;
  if (request.annotationId) {
    [annotation] = await db.select().from(swingAnnotationsTable).where(eq(swingAnnotationsTable.id, request.annotationId));
  }
  // Task #1861 — surface the caller's relationship to this review so the
  // mobile / web viewers can hide the member-only rating prompt when a
  // coach (or admin) is the one viewing their own delivered work. The
  // POST /rate endpoint already rejects non-owners, but the form should
  // never have been visible to them in the first place.
  const viewerRole: "owner" | "coach" | "admin" =
    isOwner ? "owner" : isCoach ? "coach" : "admin";
  res.json({
    request,
    video,
    annotation,
    pro: pro ? { id: pro.id, displayName: pro.displayName, photoUrl: pro.photoUrl } : null,
    viewerRole,
  });
});

router.post("/requests/:id/rate", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { rating, comment } = req.body as { rating?: number; comment?: string };
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) { { res.status(400).json({ error: "Rating must be 1-5" }); return; } }
  const [request] = await db.select().from(swingReviewRequestsTable)
    .where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  if (request.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (request.status !== "delivered") { { res.status(400).json({ error: "Can only rate delivered reviews" }); return; } }
  if (request.rating != null) { { res.status(400).json({ error: "Already rated" }); return; } }

  await db.update(swingReviewRequestsTable).set({
    rating: r, ratingComment: typeof comment === "string" ? comment : null,
    ratedAt: new Date(), updatedAt: new Date(),
  }).where(eq(swingReviewRequestsTable.id, id));

  // Recompute coach aggregate rating
  const [agg] = await db.select({
    avg: sql<string>`COALESCE(AVG(${swingReviewRequestsTable.rating}), 0)::numeric(3,2)`,
    cnt: sql<number>`COUNT(${swingReviewRequestsTable.rating})::int`,
  }).from(swingReviewRequestsTable)
    .where(and(eq(swingReviewRequestsTable.proId, request.proId), sql`${swingReviewRequestsTable.rating} IS NOT NULL`));
  await db.update(coachMarketplaceProfilesTable)
    .set({ ratingsAvg: String(agg?.avg ?? 0), ratingsCount: agg?.cnt ?? 0, updatedAt: new Date() })
    .where(eq(coachMarketplaceProfilesTable.proId, request.proId));
  res.json({ success: true });
});

router.post("/requests/:id/refund", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [request] = await db.select().from(swingReviewRequestsTable)
    .where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  const admin = await isOrgAdmin(user, request.organizationId);
  if (!admin && request.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (!["paid", "in_review", "expired"].includes(request.status)) {
    res.status(400).json({ error: `Cannot refund in status ${request.status}` }); return;
  }
  // For member-initiated refund (non-admin), only allow if past due date and not delivered
  if (!admin && request.dueAt && request.dueAt > new Date()) {
    res.status(400).json({ error: "Refund only available if coach has missed the turnaround time" }); return;
  }
  await db.update(swingReviewRequestsTable).set({
    status: "refunded", refundedAt: new Date(), escrowHeld: false, updatedAt: new Date(),
  }).where(eq(swingReviewRequestsTable.id, id));
  // Note: actual Razorpay refund call should be made here; we record the state.
  res.json({ success: true, note: "Refund recorded; finance will process settlement." });
});

/* ─── Coach: queue + delivery ──────────────────────────────────── */
router.get("/coach/queue", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.status(403).json({ error: "Not a registered coach" }); return; } }
  const rows = await db.select({
    request: swingReviewRequestsTable,
    videoUrl: swingVideosTable.videoUrl,
    videoThumb: swingVideosTable.thumbnailUrl,
    videoFps: swingVideosTable.fps,
  })
    .from(swingReviewRequestsTable)
    .innerJoin(swingVideosTable, eq(swingVideosTable.id, swingReviewRequestsTable.swingVideoId))
    .where(and(
      eq(swingReviewRequestsTable.proId, pro.id),
      inArray(swingReviewRequestsTable.status, ["paid", "in_review"]),
    ))
    .orderBy(swingReviewRequestsTable.dueAt);
  res.json({ pro, queue: rows });
});

/* ─── Coach: drawing presets (Task #2131) ──────────────────────────
 * Persistent named library of callout patterns the coach can save once
 * and re-use on any swing review. Builds on the in-memory clipboard
 * (Task #1712): the GET handler returns a coach's full library; POST
 * saves a new preset; PATCH renames; DELETE removes. The drawings
 * payload mirrors the same shape array the deliver endpoint accepts,
 * so the client paste path can drop a preset onto a review using the
 * same offset-preserving math the clipboard already uses.
 *
 * Scoping: all four routes derive `pro_id` from the signed-in user via
 * `getProForUser`; no caller-supplied proId is honoured so a coach
 * can never read or mutate another coach's library.
 */

// Drawings array bounds. Generous enough to fit any realistic callout
// pack (a "tempo bars" preset is ~5-8 shapes; an "impact angle pack"
// ~3) without letting a malicious client wedge a 10MB blob into a
// jsonb column.
const DRAWING_PRESETS_NAME_MAX = 80;
const DRAWING_PRESETS_MAX_SHAPES = 200;
const DRAWING_PRESETS_PER_COACH_CAP = 50;

function normalizePresetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > DRAWING_PRESETS_NAME_MAX) return null;
  return trimmed;
}

function normalizePresetDrawings(raw: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > DRAWING_PRESETS_MAX_SHAPES) return null;
  // Preserve verbatim — the same `drawings` blob format the deliver
  // endpoint accepts. We don't validate per-shape kind/coords here; the
  // client owns the shape schema (Shape union in coach-workspace.tsx /
  // DrawShape in mobile coach.tsx), and the deliver endpoint applies
  // no schema either, so introducing a stricter check here would
  // silently reject real coach payloads first.
  return raw.map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}));
}

router.get("/coach/drawing-presets", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return; }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { res.status(403).json({ error: "Not a registered coach" }); return; }
  const rows = await db.select().from(coachDrawingPresetsTable)
    .where(eq(coachDrawingPresetsTable.proId, pro.id))
    .orderBy(desc(coachDrawingPresetsTable.updatedAt));
  res.json({ presets: rows });
});

router.post("/coach/drawing-presets", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return; }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { res.status(403).json({ error: "Not a registered coach" }); return; }
  const { name, drawings } = req.body as Record<string, unknown>;
  const cleanName = normalizePresetName(name);
  if (!cleanName) {
    res.status(400).json({ error: `name is required and must be 1-${DRAWING_PRESETS_NAME_MAX} characters` });
    return;
  }
  const cleanDrawings = normalizePresetDrawings(drawings);
  if (!cleanDrawings) {
    res.status(400).json({ error: `drawings must be an array of at most ${DRAWING_PRESETS_MAX_SHAPES} shapes` });
    return;
  }
  if (cleanDrawings.length === 0) {
    res.status(400).json({ error: "Cannot save an empty preset — draw something first" });
    return;
  }
  // Per-coach cap so a runaway client (or a coach who never deletes)
  // can't grow the picker to thousands of rows. 50 is generous: real
  // libraries top out at "setup checkpoints", "impact pack",
  // "tempo bars" + a handful of fault-specific packs.
  const [{ count }] = await db.select({
    count: sql<number>`COUNT(*)::int`,
  }).from(coachDrawingPresetsTable).where(eq(coachDrawingPresetsTable.proId, pro.id));
  if ((count ?? 0) >= DRAWING_PRESETS_PER_COACH_CAP) {
    res.status(400).json({ error: `Preset library is full (${DRAWING_PRESETS_PER_COACH_CAP} max). Delete an old preset first.` });
    return;
  }
  const [preset] = await db.insert(coachDrawingPresetsTable).values({
    proId: pro.id,
    name: cleanName,
    drawings: cleanDrawings,
  }).returning();
  res.json({ success: true, preset });
});

router.patch("/coach/drawing-presets/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return; }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const pro = await getProForUser(user.id);
  if (!pro) { res.status(403).json({ error: "Not a registered coach" }); return; }
  const [existing] = await db.select().from(coachDrawingPresetsTable)
    .where(eq(coachDrawingPresetsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  // Coaches can only mutate their own library — the route is scoped to
  // the signed-in coach, so a stray id from another coach 404s rather
  // than 403 to avoid leaking the existence of someone else's preset.
  if (existing.proId !== pro.id) { res.status(404).json({ error: "Not found" }); return; }
  const { name } = req.body as Record<string, unknown>;
  const cleanName = normalizePresetName(name);
  if (!cleanName) {
    res.status(400).json({ error: `name is required and must be 1-${DRAWING_PRESETS_NAME_MAX} characters` });
    return;
  }
  const [preset] = await db.update(coachDrawingPresetsTable)
    .set({ name: cleanName, updatedAt: new Date() })
    .where(eq(coachDrawingPresetsTable.id, id))
    .returning();
  res.json({ success: true, preset });
});

router.delete("/coach/drawing-presets/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return; }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const pro = await getProForUser(user.id);
  if (!pro) { res.status(403).json({ error: "Not a registered coach" }); return; }
  const [existing] = await db.select().from(coachDrawingPresetsTable)
    .where(eq(coachDrawingPresetsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.proId !== pro.id) { res.status(404).json({ error: "Not found" }); return; }
  await db.delete(coachDrawingPresetsTable).where(eq(coachDrawingPresetsTable.id, id));
  res.json({ success: true });
});

// Task #761 — let the assigned coach persist the source video's true frame
// rate (detected client-side via requestVideoFrameCallback) so subsequent
// viewers can step exactly one frame at a time.
router.post("/requests/:id/swing-video-fps", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const { fps } = req.body as Record<string, unknown>;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0 || fps > 1000) {
    res.status(400).json({ error: "fps must be a positive number" }); return;
  }
  const [request] = await db.select().from(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, request.proId));
  if (!pro || pro.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  await db.update(swingVideosTable).set({ fps: String(fps) })
    .where(eq(swingVideosTable.id, request.swingVideoId));
  res.json({ success: true, fps });
});

router.post("/requests/:id/start", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [request] = await db.select().from(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, request.proId));
  if (!pro || pro.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (request.status !== "paid") { { res.status(400).json({ error: `Cannot start in status ${request.status}` }); return; } }
  await db.update(swingReviewRequestsTable).set({ status: "in_review", updatedAt: new Date() })
    .where(eq(swingReviewRequestsTable.id, id));
  res.json({ success: true });
});

router.post("/requests/:id/deliver", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [request] = await db.select().from(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.id, id));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }
  const [pro] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, request.proId));
  if (!pro || pro.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (!["paid", "in_review"].includes(request.status)) {
    res.status(400).json({ error: `Cannot deliver in status ${request.status}` }); return;
  }
  const { drawings, voiceOverUrl, voiceOverUploadToken, voiceOverUploadTokenExp, voiceOverDurationSeconds, textNotes } = req.body as Record<string, unknown>;
  let normalizedVoice: string | null = null;
  if (voiceOverUrl) {
    normalizedVoice = storage.normalizeObjectEntityPath(voiceOverUrl as string);
    if (!verifySwingUpload(normalizedVoice, user.id, voiceOverUploadToken, voiceOverUploadTokenExp)) {
      res.status(403).json({ error: "Invalid or expired upload token for voice-over" }); return;
    }
  }
  const [annotation] = await db.insert(swingAnnotationsTable).values({
    swingVideoId: request.swingVideoId,
    reviewRequestId: request.id,
    authorUserId: user.id,
    proId: pro.id,
    drawings: Array.isArray(drawings) ? drawings as Array<Record<string, unknown>> : [],
    voiceOverUrl: normalizedVoice,
    voiceOverDurationSeconds: typeof voiceOverDurationSeconds === "number" ? String(voiceOverDurationSeconds) : null,
    textNotes: typeof textNotes === "string" ? textNotes : null,
  }).returning();
  await db.update(swingReviewRequestsTable).set({
    status: "delivered", deliveredAt: new Date(), annotationId: annotation.id,
    escrowHeld: false, updatedAt: new Date(),
  }).where(eq(swingReviewRequestsTable.id, id));
  res.json({ success: true, annotation });
});

router.get("/coach/earnings", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const pro = await getProForUser(user.id);
  if (!pro) { { res.status(403).json({ error: "Not a registered coach" }); return; } }
  const [profile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, pro.id));
  const sharePct = Number(profile?.revenueSharePct ?? 70);

  const delivered = await db.select({
    total: sql<number>`COALESCE(SUM(${swingReviewRequestsTable.pricePaise}),0)::int`,
    count: sql<number>`COUNT(*)::int`,
  }).from(swingReviewRequestsTable)
    .where(and(
      eq(swingReviewRequestsTable.proId, pro.id),
      eq(swingReviewRequestsTable.status, "delivered"),
    ));
  const unpaidGross = await db.select({
    total: sql<number>`COALESCE(SUM(${swingReviewRequestsTable.pricePaise}),0)::int`,
    count: sql<number>`COUNT(*)::int`,
  }).from(swingReviewRequestsTable)
    .where(and(
      eq(swingReviewRequestsTable.proId, pro.id),
      eq(swingReviewRequestsTable.status, "delivered"),
      isNull(swingReviewRequestsTable.payoutId),
    ));
  // Task #1306 — surface the same per-payout push/SMS delivery state we
  // expose to admins (Task #1129) so coaches can see when their own
  // payout-paid notification didn't reach them. The attempts row is only
  // inserted once mark-paid fires, so a pending payout legitimately has
  // no notification row yet — left-join.
  const payoutRows = await db.select({
    payout: coachPayoutsTable,
    notification: coachPayoutNotificationAttemptsTable,
  })
    .from(coachPayoutsTable)
    .leftJoin(
      coachPayoutNotificationAttemptsTable,
      eq(coachPayoutNotificationAttemptsTable.payoutId, coachPayoutsTable.id),
    )
    .where(eq(coachPayoutsTable.proId, pro.id))
    .orderBy(desc(coachPayoutsTable.createdAt))
    .limit(50);
  // Flatten the join into the historical { ...payout, notification } shape
  // so existing fields on `payouts[i]` (id, status, periodStart, …) keep
  // working for both web and mobile consumers.
  const payouts = payoutRows.map(r => ({ ...r.payout, notification: r.notification ?? null }));

  const grossDelivered = delivered[0]?.total ?? 0;
  const grossUnpaid = unpaidGross[0]?.total ?? 0;
  res.json({
    pro,
    sharePct,
    summary: {
      deliveredCount: delivered[0]?.count ?? 0,
      unpaidCount: unpaidGross[0]?.count ?? 0,
      grossDeliveredPaise: grossDelivered,
      pendingPayoutPaise: Math.round(grossUnpaid * sharePct / 100),
      lifetimeEarningsPaise: Math.round(grossDelivered * sharePct / 100),
    },
    payouts,
  });
});

/* ─── Coach: payout breakdown ──────────────────────────────────── */
// Task #1286 — return the swing-review requests rolled up into a single
// coach payout so the mobile workspace can show a tap-to-expand detail
// sheet (member name, delivered date, gross price, coach share). Only
// the coach who owns the payout can read it; per-request share is
// computed using the same revenueSharePct already used by /coach/earnings.
router.get("/coach/payouts/:id/requests", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid id" }); return; } }
  const pro = await getProForUser(user.id);
  if (!pro) { { res.status(403).json({ error: "Not a registered coach" }); return; } }
  const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  if (!payout) { { res.status(404).json({ error: "Not found" }); return; } }
  if (payout.proId !== pro.id) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [profile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, pro.id));
  const sharePct = Number(profile?.revenueSharePct ?? 70);

  const rows = await db.select({
    id: swingReviewRequestsTable.id,
    pricePaise: swingReviewRequestsTable.pricePaise,
    deliveredAt: swingReviewRequestsTable.deliveredAt,
    memberDisplayName: appUsersTable.displayName,
    memberUsername: appUsersTable.username,
  })
    .from(swingReviewRequestsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, swingReviewRequestsTable.userId))
    .where(eq(swingReviewRequestsTable.payoutId, id))
    .orderBy(desc(swingReviewRequestsTable.deliveredAt));

  const requests = rows.map(r => ({
    id: r.id,
    memberName: r.memberDisplayName ?? r.memberUsername ?? "Member",
    deliveredAt: r.deliveredAt,
    pricePaise: r.pricePaise,
    coachSharePaise: Math.round((r.pricePaise * sharePct) / 100),
  }));
  res.json({ payout, sharePct, requests });
});

/**
 * Task #1543 — Coach-side "Try again" for a missed payout-paid
 * notification. Mirrors the admin Resend (Task #1129) but with two key
 * differences:
 *   1. Ownership: the payout must belong to the calling coach
 *      (`payout.proId === pro.id`), not their org admin.
 *   2. Per-payout cooldown: the coach can only press it once per
 *      `COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS` window (sourced from
 *      the shared `@workspace/coach-payout-labels` package so the web
 *      and mobile clients gate the "Try again" button against the
 *      exact same value) so a frustrated coach can't wedge the retry
 *      cron into a tight loop. The cooldown is stored on the attempts
 *      row in `coachRetryRequestedAt`, NOT touched by the admin path
 *      on purpose — admin overrides bypass it.
 *
 * The actual reset semantics (which channels, what gets zeroed) are
 * identical to the admin path — only `failed` and `skipped` channels
 * are re-armed; `sent` / `no_user` / `no_address` / `opted_out` are
 * left alone for the same reasons.
 */
router.post("/coach/payouts/:id/retry-notification", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid id" }); return; } }
  const pro = await getProForUser(user.id);
  if (!pro) { { res.status(403).json({ error: "Not a registered coach" }); return; } }
  const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  if (!payout) { { res.status(404).json({ error: "Not found" }); return; } }
  if (payout.proId !== pro.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const [attempt] = await db.select().from(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.payoutId, id));
  if (!attempt) {
    res.status(400).json({ error: "No notification attempt to retry yet — your payout hasn't been marked paid." });
    return;
  }
  // Per-payout cooldown — independent of any admin-side resend so a
  // recent admin Resend doesn't lock the coach out.
  if (attempt.coachRetryRequestedAt) {
    const elapsed = Date.now() - attempt.coachRetryRequestedAt.getTime();
    if (elapsed < COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({
        error: "Please wait a few minutes before trying again.",
        retryAfterSec,
      });
      return;
    }
  }
  const RESETTABLE = new Set(["failed", "skipped"]);
  // Task #1914 — increment the running coach-retry counter so the admin
  // alert helper can detect a "stuck on the same payout" pattern. The
  // counter is incremented on every accepted coach press (regardless of
  // which channel was actually re-armed), because what we're trying to
  // detect is the *coach's* frustration, not the cron's behaviour.
  const nextCoachRetryCount = (attempt.coachRetryCount ?? 0) + 1;
  const updates: Record<string, unknown> = {
    coachRetryRequestedAt: new Date(),
    coachRetryCount: nextCoachRetryCount,
  };
  let resetPush = false, resetSms = false;
  if (RESETTABLE.has(attempt.pushStatus ?? "")) {
    updates.pushStatus = "failed";
    updates.pushAttempts = 0;
    updates.lastPushError = null;
    updates.lastPushRetryAt = null;
    updates.pushRetryExhaustedAt = null;
    resetPush = true;
  }
  if (RESETTABLE.has(attempt.smsStatus ?? "")) {
    updates.smsStatus = "failed";
    updates.smsAttempts = 0;
    updates.lastSmsError = null;
    updates.lastSmsRetryAt = null;
    updates.smsRetryExhaustedAt = null;
    resetSms = true;
  }
  if (!resetPush && !resetSms) {
    res.status(400).json({ error: "Nothing to resend — both channels delivered or have no deliverable address." });
    return;
  }
  await db.update(coachPayoutNotificationAttemptsTable).set(updates)
    .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
  logger.info(
    {
      payoutId: id,
      attemptId: attempt.id,
      resetPush,
      resetSms,
      coachRetryCount: nextCoachRetryCount,
      by: user.id,
      source: "coach",
    },
    "[swing-reviews] Coach payout notification reset for retry (coach self-serve)",
  );
  // Task #1914 — once the coach has hit "Try again" enough times on
  // this stuck payout, page org admins exactly once so someone with
  // the access to fix the underlying contact problem (bad phone,
  // expired push token, etc.) gets pulled in. Best-effort: any failure
  // here is swallowed and logged — the coach's retry has already been
  // accepted and the cron will pick the row up as normal.
  if (
    nextCoachRetryCount >= COACH_PAYOUT_REPEAT_RETRY_ADMIN_THRESHOLD &&
    !attempt.coachRetryAdminNotifiedAt
  ) {
    try {
      const [refreshed] = await db.select()
        .from(coachPayoutNotificationAttemptsTable)
        .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id))
        .limit(1);
      if (refreshed) {
        await notifyAdminsOfRepeatedCoachPayoutRetries({
          attempt: refreshed,
          coachUserId: user.id,
          logContext: { payoutId: id, attemptId: attempt.id, source: "coach-retry-route" },
        });
      }
    } catch (err) {
      logger.warn(
        {
          payoutId: id,
          attemptId: attempt.id,
          errMsg: err instanceof Error ? err.message : String(err),
        },
        "[swing-reviews] Repeated coach-retry admin alert dispatch failed",
      );
    }
  }
  res.json({
    success: true,
    resetPush,
    resetSms,
    coachRetryCount: nextCoachRetryCount,
  });
});

/* ─── Admin: payouts ───────────────────────────────────────────── */
router.get("/admin/payouts", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const orgId = parseInt(String(req.query.organizationId ?? user.organizationId ?? "0"));
  if (!orgId) { { res.status(400).json({ error: "organizationId required" }); return; } }
  if (!(await isOrgAdmin(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  // Task #1129: surface per-payout push/SMS delivery so admins can see which
  // payouts went unnotified after the retry cron exhausted (or skipped) the
  // channels. The attempts row is only inserted once mark-paid fires, so a
  // pending payout legitimately has no notification row yet — left-join.
  const rows = await db.select({
    payout: coachPayoutsTable,
    proName: teachingProsTable.displayName,
    notification: coachPayoutNotificationAttemptsTable,
  })
    .from(coachPayoutsTable)
    .innerJoin(teachingProsTable, eq(teachingProsTable.id, coachPayoutsTable.proId))
    .leftJoin(
      coachPayoutNotificationAttemptsTable,
      eq(coachPayoutNotificationAttemptsTable.payoutId, coachPayoutsTable.id),
    )
    .where(eq(coachPayoutsTable.organizationId, orgId))
    .orderBy(desc(coachPayoutsTable.createdAt));
  res.json({ payouts: rows });
});

/**
 * Task #1129 — Reset the push/SMS attempts row for a single payout so the
 * coach-payout retry cron picks it up again. Useful when an admin has fixed
 * the underlying problem (e.g. configured the SMS provider, asked the coach
 * to install the app, lifted a token block) and wants to retry without
 * waiting for / bypassing the 5-attempt cap.
 *
 * Only channels that are in a re-attemptable state are reset:
 *   - `failed` (incl. cap-exhausted, where `pushRetryExhaustedAt` is stamped)
 *   - `skipped` (provider was unconfigured at first send)
 *
 * Channels in `sent`, `no_user`, `no_address`, `opted_out` are left alone:
 *   - `sent` already delivered
 *   - the others have no recipient / explicit opt-out and resending won't
 *     change that without an out-of-band fix.
 */
router.post("/admin/payouts/:id/resend-notification", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid id" }); return; } }
  const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  if (!payout) { { res.status(404).json({ error: "Not found" }); return; } }
  if (!(await isOrgAdmin(user, payout.organizationId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const [attempt] = await db.select().from(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.payoutId, id));
  if (!attempt) {
    res.status(400).json({ error: "No notification attempt to resend yet — mark the payout paid first." });
    return;
  }
  const RESETTABLE = new Set(["failed", "skipped"]);
  // Task #1914 — an admin Resend means someone with the access to fix the
  // underlying contact problem has acknowledged this stuck payout, so we
  // clear the coach-retry streak counter and the admin-alert dedup marker.
  // That way, if the coach gets stuck *again* on the same payout after the
  // admin's fix didn't take, the next round of repeated coach retries can
  // re-trigger the alert instead of being silently swallowed by a stale
  // `coachRetryAdminNotifiedAt` from the prior incident.
  const updates: Record<string, unknown> = {
    coachRetryCount: 0,
    coachRetryAdminNotifiedAt: null,
  };
  let resetPush = false, resetSms = false;
  if (RESETTABLE.has(attempt.pushStatus ?? "")) {
    updates.pushStatus = "failed";
    updates.pushAttempts = 0;
    updates.lastPushError = null;
    updates.lastPushRetryAt = null;
    updates.pushRetryExhaustedAt = null;
    resetPush = true;
  }
  if (RESETTABLE.has(attempt.smsStatus ?? "")) {
    updates.smsStatus = "failed";
    updates.smsAttempts = 0;
    updates.lastSmsError = null;
    updates.lastSmsRetryAt = null;
    updates.smsRetryExhaustedAt = null;
    resetSms = true;
  }
  if (!resetPush && !resetSms) {
    res.status(400).json({ error: "Nothing to resend — both channels delivered or have no deliverable address." });
    return;
  }
  await db.update(coachPayoutNotificationAttemptsTable).set(updates)
    .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
  logger.info(
    { payoutId: id, attemptId: attempt.id, resetPush, resetSms, by: user.id },
    "[swing-reviews] Coach payout notification reset for retry",
  );
  res.json({ success: true, resetPush, resetSms });
});

/**
 * Aggregate all delivered + unpaid review requests into one payout per coach,
 * then immediately push each net payout to the coach's RazorpayX fund account.
 * Coaches without a registered payout account end up in `pending` so an admin
 * can chase them. Successful API calls flip the row to `processing` and the
 * Razorpay payout id is stored as `payoutReference`; the final `paid`/`failed`
 * transition is driven by the `/api/webhooks/razorpay-payout` webhook.
 */
router.post("/admin/payouts/run", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const orgId = parseInt(String(req.body.organizationId ?? user.organizationId ?? "0"));
  if (!orgId) { { res.status(400).json({ error: "organizationId required" }); return; } }
  if (!(await isOrgAdmin(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 3600 * 1000);

  // Find all delivered+unpaid requests in this org
  const eligible = await db.select({
    id: swingReviewRequestsTable.id,
    proId: swingReviewRequestsTable.proId,
    pricePaise: swingReviewRequestsTable.pricePaise,
  })
    .from(swingReviewRequestsTable)
    .where(and(
      eq(swingReviewRequestsTable.organizationId, orgId),
      eq(swingReviewRequestsTable.status, "delivered"),
      isNull(swingReviewRequestsTable.payoutId),
    ));
  if (eligible.length === 0) { { res.json({ payouts: [], message: "No eligible requests" }); return; } }

  const byPro = new Map<number, { ids: number[]; gross: number }>();
  for (const r of eligible) {
    const cur = byPro.get(r.proId) ?? { ids: [], gross: 0 };
    cur.ids.push(r.id); cur.gross += r.pricePaise;
    byPro.set(r.proId, cur);
  }

  const results: Array<{
    payoutId: number;
    proId: number;
    netPayoutPaise: number;
    status: string;
    razorpayPayoutId?: string;
    error?: string;
  }> = [];

  for (const [proId, data] of byPro) {
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    const sharePct = Number(profile?.revenueSharePct ?? 70);
    const net = Math.round(data.gross * sharePct / 100);
    const fee = data.gross - net;

    const [payout] = await db.insert(coachPayoutsTable).values({
      proId, organizationId: orgId, periodStart, periodEnd,
      grossPaise: data.gross, netPayoutPaise: net, platformFeePaise: fee,
      status: "pending",
    }).returning();
    await db.update(swingReviewRequestsTable)
      .set({ payoutId: payout.id, updatedAt: new Date() })
      .where(inArray(swingReviewRequestsTable.id, data.ids));

    const disburse = await disburseCoachPayout(payout.id, profile, net);
    results.push({
      payoutId: payout.id,
      proId,
      netPayoutPaise: net,
      status: disburse.status,
      razorpayPayoutId: disburse.razorpayPayoutId,
      error: disburse.error,
    });
  }
  res.json({
    count: results.length,
    payouts: results,
    summary: {
      processing: results.filter(r => r.status === "processing").length,
      pending: results.filter(r => r.status === "pending").length,
      failed: results.filter(r => r.status === "failed").length,
    },
  });
});

/**
 * Retry a previously-failed (or never-attempted) payout. Useful when a coach
 * has just registered their payout account or when the platform's RazorpayX
 * balance was topped up after an `amount_exceeds_balance` failure.
 */
router.post("/admin/payouts/:id/retry", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  if (!payout) { { res.status(404).json({ error: "Not found" }); return; } }
  if (!(await isOrgAdmin(user, payout.organizationId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (!["pending", "failed"].includes(payout.status)) {
    res.status(400).json({ error: `Cannot retry payout in status ${payout.status}` }); return;
  }
  const [profile] = await db.select().from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, payout.proId));
  const result = await disburseCoachPayout(payout.id, profile, payout.netPayoutPaise);
  res.json(result);
});

router.post("/admin/payouts/:id/mark-paid", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  if (!payout) { { res.status(404).json({ error: "Not found" }); return; } }
  if (!(await isOrgAdmin(user, payout.organizationId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const { reference, notes } = req.body as Record<string, string>;
  const ref = typeof reference === "string" ? reference.trim() : "";
  if (!ref) { { res.status(400).json({ error: "reference required" }); return; } }

  // Idempotency: if this payout has already been marked paid AND the coach
  // notification already fired, return success without resending.
  if (payout.status === "paid" && payout.paidNotifiedAt) {
    res.json({ success: true, alreadyNotified: true });
    return;
  }

  const noteValue = typeof notes === "string" ? notes : payout.notes;
  await db.update(coachPayoutsTable).set({
    status: "paid",
    paidAt: payout.paidAt ?? new Date(),
    payoutReference: ref,
    notes: noteValue,
  }).where(eq(coachPayoutsTable.id, id));

  await notifyCoachPayoutPaid({
    payoutId: id,
    proId: payout.proId,
    organizationId: payout.organizationId,
    netPayoutPaise: payout.netPayoutPaise,
    reference: ref,
    notes: noteValue ?? null,
  });

  res.json({ success: true });
});

/**
 * Load the coach's `billing` communication preferences. We look the coach up
 * via their club_members row in the payout's organization (coaches usually
 * have one) so the notification respects the same per-channel toggles as
 * other transactional notices like levy receipts. When no row exists we
 * default email/push/sms to ON so coaches don't silently miss payout
 * confirmations until they explicitly opt in.
 */
async function loadCoachPayoutPrefs(
  organizationId: number,
  coachUserId: number | null,
): Promise<{ email: boolean; push: boolean; sms: boolean; whatsapp: boolean; memberPhone: string | null }> {
  // Email/push/SMS default ON to match prior behaviour, but WhatsApp defaults
  // OFF to match the schema default for the WhatsApp channel — coaches must
  // explicitly opt in before transactional WhatsApp messages fire.
  const defaults = { email: true, push: true, sms: true, whatsapp: false, memberPhone: null as string | null };
  if (!coachUserId) return defaults;
  try {
    const [member] = await db.select({
      id: clubMembersTable.id,
      phone: clubMembersTable.phone,
    })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    if (!member) return defaults;
    const [row] = await db.select({
      emailEnabled: memberCommPrefsTable.emailEnabled,
      smsEnabled: memberCommPrefsTable.smsEnabled,
      pushEnabled: memberCommPrefsTable.pushEnabled,
      whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
    })
      .from(memberCommPrefsTable)
      .where(and(
        eq(memberCommPrefsTable.clubMemberId, member.id),
        eq(memberCommPrefsTable.category, "billing"),
      )).limit(1);
    if (!row) return { ...defaults, memberPhone: member.phone ?? null };
    return {
      email: Boolean(row.emailEnabled),
      push: Boolean(row.pushEnabled),
      sms: Boolean(row.smsEnabled),
      whatsapp: Boolean(row.whatsappEnabled),
      memberPhone: member.phone ?? null,
    };
  } catch (err) {
    logger.warn({ err, organizationId, coachUserId }, "[swing-reviews] Failed to load coach payout comm prefs; defaulting to ON");
    return defaults;
  }
}

/**
 * Send a coach the email + in-app + push + SMS notification confirming their
 * payout was marked paid by an org admin. Best-effort: failures are logged
 * but never surface to the admin (they've already done their part) and a
 * failure on one channel never blocks the others. The `paidNotifiedAt`
 * timestamp is stamped after every channel has been attempted, so any
 * future mark-paid retry is a no-op.
 *
 * Per-channel `billing` comm prefs are honoured (default ON when no row
 * exists). Push payload includes a deep link into the coach workspace
 * earnings tab.
 */
async function notifyCoachPayoutPaid(opts: {
  payoutId: number;
  proId: number;
  organizationId: number;
  netPayoutPaise: number;
  reference: string;
  notes: string | null;
}): Promise<void> {
  try {
    const [pro] = await db.select({
      displayName: teachingProsTable.displayName,
      proEmail: teachingProsTable.email,
      proPhone: teachingProsTable.phone,
      userId: teachingProsTable.userId,
    }).from(teachingProsTable).where(eq(teachingProsTable.id, opts.proId)).limit(1);

    let userEmail: string | null = null;
    let userDisplayName: string | null = null;
    let coachUserId: number | null = pro?.userId ?? null;
    if (coachUserId) {
      const [u] = await db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
      }).from(appUsersTable).where(eq(appUsersTable.id, coachUserId)).limit(1);
      userEmail = u?.email ?? null;
      userDisplayName = u?.displayName ?? null;
    }
    const recipientEmail = userEmail ?? pro?.proEmail ?? null;
    const recipientName = userDisplayName ?? pro?.displayName ?? "Coach";

    const prefs = await loadCoachPayoutPrefs(opts.organizationId, coachUserId);
    // Prefer the teaching-pro phone but fall back to the coach's club_members
    // phone so SMS still fires when the on-file number lives on the member
    // profile rather than the pro record.
    const recipientPhone = pro?.proPhone ?? prefs.memberPhone ?? null;

    let branding: EmailBranding = { orgName: "KHARAGOLF" };
    // Task #1099 — load defaultLanguage so the coach payout-paid email
    // renders in the club's configured language (EN fallback).
    let orgLang: string | null = null;
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
        defaultLanguage: organizationsTable.defaultLanguage,
      }).from(organizationsTable).where(eq(organizationsTable.id, opts.organizationId)).limit(1);
      // Task #1319 — propagate `orgId` so the coach payout-paid email
      // carries `metadata.orgId` and the Postmark bounce webhook
      // (Task #981) attributes any hard bounce back to this club without
      // scanning campaigns / memberships.
      branding = {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
        orgId: opts.organizationId,
      };
      orgLang = org?.defaultLanguage ?? null;
    } catch (err) {
      logger.warn({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to load org branding for payout email");
    }

    const amountStr = `₹${(opts.netPayoutPaise / 100).toLocaleString("en-IN")}`;
    const pushTitle = `Payout sent — ${amountStr}`;
    const pushBody = `${branding.orgName ?? "Your club"} marked your swing-review payout paid. Reference: ${opts.reference}.`;

    // Per-channel outcome tracking for the retry attempts row recorded at the
    // end of this function (Task #967). Mirrors the levy-receipt receipt
    // attempts shape so the bounded retry cron can re-attempt failed
    // push/SMS deliveries on a fixed schedule.
    //
    // Task #1544 — also snapshot the masked target (phone / device label)
    // we attempted, so the coach earnings UI can surface *which* contact
    // details we tried when a channel missed. `null` = nothing meaningful
    // to record (no recipient at all, or channel skipped entirely).
    let pushOutcome: {
      status: string; error: string | null; attempted: boolean; targetLabel: string | null;
    } = { status: "skipped", error: null, attempted: false, targetLabel: null };
    let smsOutcome: {
      status: string; error: string | null; attempted: boolean; targetMasked: string | null;
    } = { status: "skipped", error: null, attempted: false, targetMasked: null };
    // Task #1847 — track the email channel the same way we track push/SMS so
    // the retry cron has the bookkeeping it needs to re-attempt failed
    // sends. `attempted` separates "we actually called the SMTP provider"
    // from soft-skips (opted_out / no_address) so the attempts count
    // doesn't get inflated by no-ops. `hardBounce` carries the Task #1279
    // signal that the destination is permanently dead, which the persist
    // block below uses to short-circuit straight to exhausted.
    let emailOutcome: {
      status: string;
      error: string | null;
      attempted: boolean;
      hardBounce: boolean;
      recipient: string | null;
    } = { status: "skipped", error: null, attempted: false, hardBounce: false, recipient: null };

    // In-app notification (only when we know which app user owns this coach).
    if (coachUserId) {
      try {
        await db.insert(coachPayoutNotificationsTable).values({
          coachUserId,
          payoutId: opts.payoutId,
          organizationId: opts.organizationId,
          title: pushTitle,
          body: pushBody,
          amountPaise: opts.netPayoutPaise,
          reference: opts.reference,
          notes: opts.notes,
        }).onConflictDoNothing({ target: coachPayoutNotificationsTable.payoutId });
      } catch (err) {
        logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to insert coach in-app notification");
      }
    }

    // ── Email ────────────────────────────────────────────────────────────
    if (!prefs.email) {
      logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach opted out of billing email — payout-paid email skipped");
      emailOutcome = { status: "opted_out", error: null, attempted: false, hardBounce: false, recipient: null };
    } else if (recipientEmail) {
      try {
        await sendCoachPayoutPaidEmail({
          to: recipientEmail,
          coachName: recipientName,
          amountPaise: opts.netPayoutPaise,
          reference: opts.reference,
          notes: opts.notes,
          branding,
          lang: orgLang,
        });
        logger.info({ payoutId: opts.payoutId, to: recipientEmail }, "[swing-reviews] Coach payout-paid email sent");
        emailOutcome = { status: "sent", error: null, attempted: true, hardBounce: false, recipient: recipientEmail };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const errClass = classifyMailerError(err);
        if (errClass === "provider_unconfigured") {
          // Provider not configured in this env — terminal `skipped` so
          // the retry cron never re-selects this row. Mirrors the SMS
          // branch above.
          logger.info({ payoutId: opts.payoutId }, "[swing-reviews] SMTP provider not configured — payout-paid email skipped");
          emailOutcome = { status: "skipped", error: "provider_not_configured", attempted: false, hardBounce: false, recipient: recipientEmail };
        } else {
          logger.error({ err, payoutId: opts.payoutId, errClass }, "[swing-reviews] Failed to send coach payout-paid email");
          emailOutcome = {
            status: "failed",
            error: reason,
            attempted: true,
            hardBounce: errClass === "hard_bounce",
            recipient: recipientEmail,
          };
        }
      }
    } else {
      logger.warn({ payoutId: opts.payoutId, proId: opts.proId }, "[swing-reviews] No email on file for coach — payout-paid email skipped");
      emailOutcome = { status: "no_address", error: null, attempted: false, hardBounce: false, recipient: null };
    }

    // ── Push ─────────────────────────────────────────────────────────────
    if (!prefs.push) {
      logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach opted out of billing push — payout-paid push skipped");
      pushOutcome = { status: "opted_out", error: null, attempted: false, targetLabel: null };
    } else if (coachUserId) {
      // Task #1544 — capture the device label *before* the push call so the
      // attempts row can show the coach which devices we tried (e.g. "1
      // expo device"). Failures here are non-fatal — the column stays
      // null and the cell renders without a target hint.
      let pushTargetLabel: string | null = null;
      try {
        const devices = await db.select({ platform: deviceTokensTable.platform })
          .from(deviceTokensTable)
          .where(eq(deviceTokensTable.userId, coachUserId));
        pushTargetLabel = buildPushDeviceLabel(devices);
      } catch (err) {
        logger.warn({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to derive push device label for coach payout-paid notify");
      }
      try {
        const push = await sendTransactionalPush(
          [coachUserId],
          pushTitle,
          pushBody,
          {
            type: "coach_payout_paid",
            payoutId: opts.payoutId,
            organizationId: opts.organizationId,
            amountPaise: opts.netPayoutPaise,
            reference: opts.reference,
            // Deep link into the coach workspace earnings tab.
            deepLink: "/coach/earnings",
          },
        );
        // Task #1240 — route through the shared classifier (originally added in
        // Task #1070) so a coach with no Expo tokens registered is reported as
        // "no_address" rather than a delivery failure. The previous inline
        // mapping miscategorised the (attempted=N, sent=0, failed=0, invalid=0)
        // case — a recipient with zero device_tokens rows — as a failure.
        const cls = classifyPushDelivery(push);
        if (cls === "sent") {
          pushOutcome = { status: "sent", error: null, attempted: true, targetLabel: pushTargetLabel };
        } else if (cls === "no_address") {
          // No registered devices — `pushTargetLabel` is null too, which
          // matches reality: there's nothing to mask / show.
          pushOutcome = { status: "no_address", error: null, attempted: false, targetLabel: null };
        } else {
          pushOutcome = { status: "failed", error: "push_delivery_failed", attempted: true, targetLabel: pushTargetLabel };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        pushOutcome = { status: "failed", error: reason, attempted: true, targetLabel: pushTargetLabel };
        logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to send coach payout-paid push");
      }
    } else {
      logger.warn({ payoutId: opts.payoutId, proId: opts.proId }, "[swing-reviews] No app user linked to coach — payout-paid push skipped");
      pushOutcome = { status: "no_user", error: null, attempted: false, targetLabel: null };
    }

    // ── SMS ──────────────────────────────────────────────────────────────
    // Task #1544 — derive the masked phone once so we can record it on the
    // attempts row regardless of whether the upstream send succeeds, fails,
    // or the provider is unconfigured.
    const smsTargetMasked = recipientPhone ? maskPhoneForCoach(recipientPhone) : null;
    if (!prefs.sms) {
      logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach opted out of billing SMS — payout-paid SMS skipped");
      smsOutcome = { status: "opted_out", error: null, attempted: false, targetMasked: null };
    } else if (recipientPhone) {
      try {
        const smsBody = `${pushTitle}\n${pushBody}`.slice(0, 320);
        await sendTransactionalSms(recipientPhone, smsBody);
        logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach payout-paid SMS sent");
        smsOutcome = { status: "sent", error: null, attempted: true, targetMasked: smsTargetMasked };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/SMS_PROVIDER not configured/i.test(reason)) {
          logger.info({ payoutId: opts.payoutId }, "[swing-reviews] SMS provider not configured — payout-paid SMS skipped");
          // Provider unconfigured is environmental — record as terminal
          // `skipped` so the retry cron never re-selects this row.
          smsOutcome = { status: "skipped", error: "provider_not_configured", attempted: false, targetMasked: smsTargetMasked };
        } else {
          logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to send coach payout-paid SMS");
          smsOutcome = { status: "failed", error: reason, attempted: true, targetMasked: smsTargetMasked };
        }
      }
    } else {
      logger.warn({ payoutId: opts.payoutId, proId: opts.proId }, "[swing-reviews] No phone on file for coach — payout-paid SMS skipped");
      smsOutcome = { status: "no_address", error: null, attempted: false, targetMasked: null };
    }

    // Persist a per-payout attempts row so the retry cron (Task #967) can
    // re-attempt failed push/SMS deliveries on a bounded schedule. Best
    // effort: a failure to insert this row never alters the admin-facing
    // outcome of the mark-paid request. The unique index on payout_id
    // makes this insert idempotent across retried mark-paid calls.
    try {
      const now = new Date();
      // Task #1847 — when the very first email send hit a hard SMTP
      // bounce, stamp the row exhausted immediately so the cron never
      // re-fires it; the admin alert is dispatched below from the
      // re-loaded row to avoid contention with the conditional
      // `notifiedAt` stamp.
      const emailExhaustedNow = emailOutcome.status === "failed" && emailOutcome.hardBounce;
      const persistedEmailAttempts = emailExhaustedNow
        ? COACH_PAYOUT_MAX_EMAIL_ATTEMPTS
        : (emailOutcome.attempted ? 1 : 0);
      const nextEmailRetryAt = emailOutcome.status === "failed" && !emailExhaustedNow
        ? computeCoachPayoutNextEmailRetryAt(1, now)
        : null;
      const inserted = await db.insert(coachPayoutNotificationAttemptsTable).values({
        payoutId: opts.payoutId,
        proId: opts.proId,
        organizationId: opts.organizationId,
        coachUserId,
        amountPaise: opts.netPayoutPaise,
        reference: opts.reference,
        notes: opts.notes ?? null,
        orgName: branding.orgName ?? null,
        pushStatus: pushOutcome.status,
        pushAttempts: pushOutcome.attempted ? 1 : 0,
        lastPushAt: pushOutcome.attempted ? now : null,
        lastPushError: pushOutcome.error,
        // Task #1544 — masked snapshot of the contact details we tried.
        pushTargetLabel: pushOutcome.targetLabel,
        smsStatus: smsOutcome.status,
        smsAttempts: smsOutcome.attempted ? 1 : 0,
        lastSmsAt: smsOutcome.attempted ? now : null,
        lastSmsError: smsOutcome.error,
        smsTargetMasked: smsOutcome.targetMasked,
        // Task #1847 — email channel bookkeeping.
        emailStatus: emailOutcome.status,
        emailAttempts: persistedEmailAttempts,
        lastEmailAt: emailOutcome.attempted ? now : null,
        lastEmailError: emailOutcome.error,
        nextEmailRetryAt,
        emailRetryExhaustedAt: emailExhaustedNow ? now : null,
        emailRecipient: emailOutcome.recipient,
      }).onConflictDoNothing({ target: coachPayoutNotificationAttemptsTable.payoutId })
        .returning({ id: coachPayoutNotificationAttemptsTable.id });

      // Task #1279 — if the very first email send hit a hard bounce,
      // page org admins immediately. Best-effort: a failure here never
      // derails the payout flow that already settled.
      if (emailExhaustedNow && inserted.length > 0) {
        try {
          const [stamped] = await db.select()
            .from(coachPayoutNotificationAttemptsTable)
            .where(eq(coachPayoutNotificationAttemptsTable.id, inserted[0].id))
            .limit(1);
          if (stamped) {
            await notifyAdminsOfCoachPayoutRetryExhaustion({
              attempt: stamped,
              channel: "email",
              reason: "hard_bounce",
              logContext: { payoutId: opts.payoutId, proId: opts.proId, organizationId: opts.organizationId },
            });
          }
        } catch (err) {
          logger.warn(
            { err, payoutId: opts.payoutId },
            "[swing-reviews] Admin email exhaustion alert (initial hard bounce) failed",
          );
        }
      }
    } catch (err) {
      logger.warn({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to record coach payout notification attempts row");
    }

    // ── WhatsApp ─────────────────────────────────────────────────────────
    // Default OFF: only fires when the coach has explicitly opted in via the
    // `billing` category `whatsappEnabled` pref. Provider-not-configured
    // environments degrade to a logged skip rather than a hard failure.
    if (!prefs.whatsapp) {
      logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach has not opted in to billing WhatsApp — payout-paid WhatsApp skipped");
    } else if (recipientPhone) {
      try {
        const waBody = `${pushTitle}\n${pushBody}`.slice(0, 1024);
        await sendTransactionalWhatsapp(recipientPhone, waBody);
        logger.info({ payoutId: opts.payoutId }, "[swing-reviews] Coach payout-paid WhatsApp sent");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(reason)) {
          logger.info({ payoutId: opts.payoutId }, "[swing-reviews] WhatsApp provider not configured — payout-paid WhatsApp skipped");
        } else {
          logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to send coach payout-paid WhatsApp");
        }
      }
    } else {
      logger.warn({ payoutId: opts.payoutId, proId: opts.proId }, "[swing-reviews] No phone on file for coach — payout-paid WhatsApp skipped");
    }
  } catch (err) {
    logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Unexpected failure during payout-paid notify");
  } finally {
    // Always stamp paidNotifiedAt so a retried mark-paid never duplicates the
    // attempt — even if the email failed, we don't want to re-spam the coach.
    try {
      await db.update(coachPayoutsTable)
        .set({ paidNotifiedAt: new Date() })
        .where(eq(coachPayoutsTable.id, opts.payoutId));
    } catch (err) {
      logger.error({ err, payoutId: opts.payoutId }, "[swing-reviews] Failed to stamp paidNotifiedAt");
    }
  }
}

/**
 * GET /coach/notifications — recent payout-paid notifications for the current
 * coach, surfaced in the coach workspace.
 */
router.get("/coach/notifications", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const rows = await db.select().from(coachPayoutNotificationsTable)
    .where(eq(coachPayoutNotificationsTable.coachUserId, user.id))
    .orderBy(desc(coachPayoutNotificationsTable.createdAt))
    .limit(20);
  res.json({ notifications: rows });
});

/**
 * POST /coach/notifications/:id/read — mark a single payout notification as
 * read so it stops badging the workspace inbox.
 */
router.post("/coach/notifications/:id/read", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid id" }); return; } }
  await db.update(coachPayoutNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(coachPayoutNotificationsTable.id, id),
      eq(coachPayoutNotificationsTable.coachUserId, user.id),
      isNull(coachPayoutNotificationsTable.readAt),
    ));
  res.json({ success: true });
});

export default router;
