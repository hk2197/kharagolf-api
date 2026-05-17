/**
 * General Play Rounds API
 *
 * POST   /api/portal/general-play              Create a new casual round (draft)
 * GET    /api/portal/general-play              List player's general play rounds
 * GET    /api/portal/general-play/:id          Get single round detail with holes
 * PATCH  /api/portal/general-play/:id/hole     Save a hole score
 * POST   /api/portal/general-play/:id/submit   Submit round for marker countersign
 * POST   /api/portal/general-play/:id/confirm  Marker confirms round
 * POST   /api/portal/general-play/:id/dispute  Marker disputes round
 * GET    /api/portal/general-play/pending-marker  Rounds awaiting marker action
 * GET    /organizations/:orgId/general-play    Admin: list all org general play rounds
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  generalPlayRoundsTable,
  generalPlayHoleScoresTable,
  generalPlayMarkersTable,
  holePinPositionsTable,
  coursesTable,
  holeDetailsTable,
  whsPccEntriesTable,
  appUsersTable,
  orgMembershipsTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  courseTeeSlotTable,
} from "@workspace/db";
import { eq, and, desc, or, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { calculateAGS, calculateGrossScore, isPlayerEstablished } from "../lib/ags";
import { computePlayingHandicap } from "../lib/handicap";
import { postScoreAndRecalculate, getPccForCourseDate } from "../lib/whs-recalc";
import { sendPushToUsers } from "../lib/push";
import {
  notifyMarkerShareRequested,
  notifyPostRoundResults,
} from "../lib/brandedNotifications";
import { logger } from "../lib/logger";
import { creditGeneralPlayRoundToLadders } from "../lib/cross-club-ladder-feed";

const router: IRouter = Router({ mergeParams: true });

function getPortalUserId(req: Request): number | null {
  const userId = (req as unknown as { portalUser?: { userId?: number } }).portalUser?.userId
    ?? (req as unknown as { user?: { id?: number } }).user?.id;
  return userId ? Number(userId) : null;
}

// ─── POST /api/portal/general-play — create draft round ───────────────────

router.post("/portal/general-play", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { courseId, organizationId, teeBoxName, holesPlayed = 18, teeBookingId, playedAt, markerName, markerEmail } = req.body;
  if (!courseId || !organizationId) { { res.status(400).json({ error: "courseId and organizationId are required" }); return; } }

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  // Validate teeBookingId BEFORE inserting — it must belong to the same org, the
  // caller must be the lead booker or a confirmed player, and the slot date must
  // match the round date within ±1 day.  Invalid IDs are silently nulled out so
  // the round still succeeds but no cross-context linkage is stored.
  let validatedTeeBookingId: number | null = null;
  let eligibleBookingPlayers: Array<{
    userId: number | null;
    displayName: string | null;
    username: string | null;
    email: string | null;
  }> = [];

  if (teeBookingId) {
    try {
      const [booking] = await db
        .select({
          id: teeBookingsTable.id,
          leadUserId: teeBookingsTable.leadUserId,
          slotDate: courseTeeSlotTable.slotDate,
        })
        .from(teeBookingsTable)
        .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
        .where(and(
          eq(teeBookingsTable.id, teeBookingId),
          eq(teeBookingsTable.organizationId, organizationId),  // same org
          eq(teeBookingsTable.status, "confirmed"),              // only valid (confirmed) bookings
        ));

      if (booking) {
        const roundDate = new Date(playedAt ?? new Date());
        const slotDate = new Date(booking.slotDate);
        const diffDays = Math.abs(roundDate.getTime() - slotDate.getTime()) / (1000 * 60 * 60 * 24);
        const isDateEligible = diffDays <= 1;

        const isLeadBooker = booking.leadUserId === userId;
        const [callerInBooking] = !isLeadBooker ? await db
          .select({ id: teeBookingPlayersTable.id })
          .from(teeBookingPlayersTable)
          .where(and(
            eq(teeBookingPlayersTable.bookingId, teeBookingId),
            eq(teeBookingPlayersTable.userId, userId),
            eq(teeBookingPlayersTable.confirmationStatus, "confirmed"),
          )) : [{ id: -1 }];

        if (isDateEligible && (isLeadBooker || callerInBooking)) {
          validatedTeeBookingId = teeBookingId;
          // Pre-fetch confirmed players for marker auto-population after insert
          eligibleBookingPlayers = await db
            .select({
              userId: teeBookingPlayersTable.userId,
              displayName: appUsersTable.displayName,
              username: appUsersTable.username,
              email: appUsersTable.email,
            })
            .from(teeBookingPlayersTable)
            .leftJoin(appUsersTable, eq(appUsersTable.id, teeBookingPlayersTable.userId))
            .where(and(
              eq(teeBookingPlayersTable.bookingId, teeBookingId),
              eq(teeBookingPlayersTable.confirmationStatus, "confirmed"),
            ));
        }
      }
    } catch (err) {
      console.error("[GeneralPlay] teeBookingId validation failed — nulling:", err);
    }
  }

  const [round] = await db.insert(generalPlayRoundsTable).values({
    userId,
    organizationId,
    courseId,
    teeBoxName: teeBoxName ?? null,
    courseRating: course.rating ? String(course.rating) : null,
    slopeRating: course.slope ?? null,
    holesPlayed,
    teeBookingId: validatedTeeBookingId,  // only persisted after validation
    playedAt: playedAt ? new Date(playedAt) : new Date(),
  }).returning();

  // Auto-populate all confirmed booking group members (excluding the round creator) as markers.
  // Full group composition is stored via the markers table so any group member can countersign.
  // The confirm/dispute endpoints authorize by matching markerUserId = requesting user.
  let bookingMarkersAdded = false;
  if (validatedTeeBookingId && round && eligibleBookingPlayers.length > 0) {
    try {
      const groupMarkers = eligibleBookingPlayers.filter(bp => bp.userId !== null && bp.userId !== userId);
      for (const bp of groupMarkers) {
        if (bp.userId !== null) {
          await db.insert(generalPlayMarkersTable).values({
            roundId: round.id,
            markerUserId: bp.userId,
            markerName: bp.displayName ?? bp.username ?? `User #${bp.userId}`,
            markerEmail: bp.email ?? null,
            confirmationStatus: "pending" as const,
          });
        }
      }
      if (groupMarkers.length > 0) {
        bookingMarkersAdded = true;
        console.info(`[GeneralPlay] Stored ${groupMarkers.length} group member(s) as markers from booking #${validatedTeeBookingId}`);
      }
    } catch (err) {
      console.error("[GeneralPlay] Failed to auto-populate group markers from booking:", err);
    }
  }

  // Pre-assign manual marker if provided and no booking markers were added
  if (!bookingMarkersAdded && markerName && round) {
    try {
      await db.insert(generalPlayMarkersTable).values({
        roundId: round.id,
        markerUserId: null,
        markerName,
        markerEmail: markerEmail ?? null,
        confirmationStatus: "pending" as const,
      });
    } catch (err) {
      console.error("[GeneralPlay] Failed to pre-assign marker:", err);
    }
  }

  res.status(201).json(round);
});

// ─── GET /api/portal/general-play — list player rounds ─────────────────────

router.get("/portal/general-play", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const orgId = req.query.organizationId ? Number(req.query.organizationId) : undefined;

  const conditions = [eq(generalPlayRoundsTable.userId, userId)];
  if (orgId) conditions.push(eq(generalPlayRoundsTable.organizationId, orgId));

  const rounds = await db
    .select({
      round: generalPlayRoundsTable,
      courseName: coursesTable.name,
    })
    .from(generalPlayRoundsTable)
    .leftJoin(coursesTable, eq(generalPlayRoundsTable.courseId, coursesTable.id))
    .where(and(...conditions))
    .orderBy(desc(generalPlayRoundsTable.playedAt))
    .limit(50);

  res.json(rounds);
});

// ─── GET /api/portal/general-play/:id — round detail ───────────────────────

router.get("/portal/general-play/:id", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const id = parseInt(String((req.params as Record<string, string>).id));

  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, id));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }

  // Allow the round owner AND any assigned marker to read the round detail
  if (round.userId !== userId) {
    const [markerRecord] = await db.select({ id: generalPlayMarkersTable.id })
      .from(generalPlayMarkersTable)
      .where(and(eq(generalPlayMarkersTable.roundId, id), eq(generalPlayMarkersTable.markerUserId, userId)));
    if (!markerRecord) { { res.status(403).json({ error: "Forbidden" }); return; } }
  }

  const holes = await db.select().from(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, id));
  const markers = await db.select().from(generalPlayMarkersTable).where(eq(generalPlayMarkersTable.roundId, id));
  const courseHoles = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, round.courseId)).orderBy(holeDetailsTable.holeNumber);

  const [courseInfo] = await db.select({ rating: coursesTable.rating, slope: coursesTable.slope, par: coursesTable.par })
    .from(coursesTable)
    .where(eq(coursesTable.id, round.courseId));

  res.json({
    round,
    holes,
    markers,
    courseHoles,
    courseRating: courseInfo?.rating ? Number(courseInfo.rating) : null,
    courseSlope: courseInfo?.slope ?? null,
    coursePar: courseInfo?.par ?? null,
  });
});

// ─── PATCH /api/portal/general-play/:id/hole — save hole score ─────────────

router.patch("/portal/general-play/:id/hole", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const roundId = parseInt(String((req.params as Record<string, string>).id));
  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (round.status !== "draft" && round.status !== "in_progress") {
    res.status(400).json({ error: "Cannot edit a submitted or completed round" }); return;
  }

  const { holeNumber, strokes, par, strokeIndex, putts, fairwayHit, gir, sandSave, upAndDown, penalties, penaltyReason } = req.body;
  if (!holeNumber || strokes == null) { { res.status(400).json({ error: "holeNumber and strokes required" }); return; } }

  const holeValues = {
    roundId,
    holeNumber,
    strokes,
    par: par ?? null,
    strokeIndex: strokeIndex ?? null,
    putts: putts ?? null,
    fairwayHit: fairwayHit ?? null,
    gir: gir ?? null,
    sandSave: sandSave ?? null,
    upAndDown: upAndDown ?? null,
    penalties: penalties ?? null,
    penaltyReason: penaltyReason ?? null,
  };

  const [hole] = await db.insert(generalPlayHoleScoresTable).values(holeValues).onConflictDoUpdate({
    target: [generalPlayHoleScoresTable.roundId, generalPlayHoleScoresTable.holeNumber],
    set: {
      strokes,
      par: par ?? null,
      strokeIndex: strokeIndex ?? null,
      putts: putts ?? null,
      fairwayHit: fairwayHit ?? null,
      gir: gir ?? null,
      sandSave: sandSave ?? null,
      upAndDown: upAndDown ?? null,
      penalties: penalties ?? null,
      penaltyReason: penaltyReason ?? null,
    },
  }).returning();

  if (round.status === "draft") {
    await db.update(generalPlayRoundsTable).set({ status: "in_progress", updatedAt: new Date() }).where(eq(generalPlayRoundsTable.id, roundId));
  }

  res.json(hole);
});

// ─── POST /api/portal/general-play/:id/submit — submit for marker ──────────

router.post("/portal/general-play/:id/submit", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const roundId = parseInt(String((req.params as Record<string, string>).id));
  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (round.status !== "in_progress" && round.status !== "draft") {
    res.status(400).json({ error: "Round cannot be submitted in its current status" }); return;
  }

  const { markerUserId, markerName, markerEmail, markerGhinNumber } = req.body;

  // Validate marker ≠ player
  if (markerUserId && markerUserId === userId) {
    res.status(400).json({ error: "You cannot be your own marker" }); return;
  }

  // Check if a marker was already auto-populated from a tee booking
  const [existingMarker] = await db.select({
    id: generalPlayMarkersTable.id,
    markerName: generalPlayMarkersTable.markerName,
    markerUserId: generalPlayMarkersTable.markerUserId,
  }).from(generalPlayMarkersTable).where(eq(generalPlayMarkersTable.roundId, roundId));

  // markerName is required only when no booking-derived marker exists
  if (!existingMarker && !markerName) {
    res.status(400).json({ error: "markerName is required" }); return;
  }

  // Calculate AGS and differential preview
  const holes = await db.select().from(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, roundId));
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, round.courseId));

  const deadline = new Date();
  deadline.setHours(deadline.getHours() + 48);

  await db.update(generalPlayRoundsTable).set({
    status: "pending_marker",
    submittedAt: new Date(),
    markerDeadlineAt: deadline,
    updatedAt: new Date(),
  }).where(eq(generalPlayRoundsTable.id, roundId));

  // Upsert: if a marker was already auto-populated from a tee booking, update it;
  // otherwise insert a new one. This prevents duplicate marker rows.
  if (existingMarker) {
    // Only update fields explicitly sent by the client — preserve auto-populated identity
    // (e.g., markerUserId) if the client omitted them (expected when booking-prefilled)
    const markerUpdates: Partial<typeof generalPlayMarkersTable.$inferInsert> = {
      confirmationStatus: "pending",
    };
    if (markerUserId !== undefined) markerUpdates.markerUserId = markerUserId ?? null;
    if (markerName) markerUpdates.markerName = markerName;
    if (markerEmail !== undefined) markerUpdates.markerEmail = markerEmail ?? null;
    if (markerGhinNumber !== undefined) markerUpdates.markerGhinNumber = markerGhinNumber ?? null;
    await db.update(generalPlayMarkersTable)
      .set(markerUpdates)
      .where(eq(generalPlayMarkersTable.id, existingMarker.id));
  } else {
    await db.insert(generalPlayMarkersTable).values({
      roundId,
      markerUserId: markerUserId ?? null,
      markerName: markerName!,
      markerEmail: markerEmail ?? null,
      markerGhinNumber: markerGhinNumber ?? null,
    });
  }

  const allMarkers = await db
    .select({ markerUserId: generalPlayMarkersTable.markerUserId })
    .from(generalPlayMarkersTable)
    .where(and(
      eq(generalPlayMarkersTable.roundId, roundId),
      sql`${generalPlayMarkersTable.markerUserId} IS NOT NULL`,
    ));
  const markerUserIds = [...new Set(allMarkers.map(m => m.markerUserId!).filter(id => id !== userId))];
  if (markerUserIds.length > 0) {
    const [player] = await db.select({ displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId));
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      markerUserIds,
      "Scorecard to countersign",
      `${player?.displayName ?? "A player"} has submitted their scorecard. Please review and confirm.`,
      { type: "general_play_marker", roundId },
    ).catch(() => {});

    // Task #2008 — branded `marker.share.requested` dispatch (email + digest)
    // sent to designated marker user(s) on top of the bespoke push above.
    void notifyMarkerShareRequested({
      userIds: markerUserIds,
      roundId,
      playerName: player?.displayName ?? undefined,
    });
  }

  res.json({ success: true, message: "Round submitted for marker countersign", deadline });
});

// ─── POST /api/portal/general-play/:id/confirm — marker confirms ────────────

router.post("/portal/general-play/:id/confirm", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const roundId = parseInt(String((req.params as Record<string, string>).id));
  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }
  if (round.status !== "pending_marker") { { res.status(400).json({ error: "Round is not awaiting marker confirmation" }); return; } }

  if (round.userId === userId) {
    res.status(403).json({ error: "You cannot countersign your own round" }); return;
  }

  // Strict identity check: caller must match the marker record by userId.
  // Rounds with a null-userId marker (manually-entered) require admin override — not open to any user.
  const [marker] = await db.select().from(generalPlayMarkersTable).where(and(
    eq(generalPlayMarkersTable.roundId, roundId),
    eq(generalPlayMarkersTable.markerUserId, userId),
  ));
  if (!marker) {
    res.status(403).json({ error: "Only the designated marker may countersign this round" }); return;
  }

  // Calculate AGS and score differential
  const holes = await db.select().from(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, roundId)).orderBy(generalPlayHoleScoresTable.holeNumber);
  const courseHoles = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, round.courseId)).orderBy(holeDetailsTable.holeNumber);

  const holeScores = courseHoles.map(ch => {
    const played = holes.find(h => h.holeNumber === ch.holeNumber);
    return { holeNumber: ch.holeNumber, par: ch.par, strokeIndex: ch.handicap, strokes: played?.strokes ?? null };
  });

  const grossScore = calculateGrossScore(holeScores.filter(h => h.strokes !== null));
  const pcc = round.pccUsed ? Number(round.pccUsed) : 0;

  // WHS Gap 6: postScoreAndRecalculate is called here ONLY because the designated
  // marker (a different player) has explicitly countersigned the round.
  // It is NOT called on the player's own submission (POST /general-play) — that route
  // leaves status as "pending_marker" and never triggers handicap recalculation.
  const recalcResult = await postScoreAndRecalculate({
    userId: round.userId,
    organizationId: round.organizationId,
    courseId: round.courseId,
    sourceType: "general_play",
    sourceGeneralPlayId: roundId,
    holesPlayed: round.holesPlayed,
    grossScore,
    adjustedGrossScore: grossScore,
    courseRating: round.courseRating ? Number(round.courseRating) : 72,
    slopeRating: round.slopeRating ?? 113,
    pcc,
    markerName: marker.markerName,
    markerGhinNumber: marker.markerGhinNumber ?? null,
    playedAt: round.playedAt,
  });

  await db.update(generalPlayRoundsTable).set({
    status: "confirmed",
    grossScore,
    scoreDifferential: String(recalcResult.finalDifferential),
    confirmedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(generalPlayRoundsTable.id, roundId));

  await db.update(generalPlayMarkersTable).set({
    confirmationStatus: "confirmed",
    respondedAt: new Date(),
  }).where(eq(generalPlayMarkersTable.id, marker.id));

  // Notify player
  // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendPushToUsers(
    [round.userId],
    "Round confirmed ✅",
    `Your general play round has been confirmed. Score differential: ${recalcResult.finalDifferential}. New H.I.: ${recalcResult.newHandicapIndex ?? "calculating..."}`,
    { type: "general_play_confirmed", roundId },
  ).catch(() => {});

  // Task #2008 — branded `post.round.results` dispatch (email + digest) so the
  // player gets a polished post-round summary on top of the bespoke push above.
  void notifyPostRoundResults({
    userIds: [round.userId],
    roundId,
    grossScore,
  });

  // Auto-feed: credit any matching cross-club ladder entries (Task #462).
  setImmediate(() => {
    creditGeneralPlayRoundToLadders(roundId).catch((err) => {
      logger.error({ err, roundId }, "[ladder-feed] general-play credit failed");
    });
  });

  res.json({ success: true, finalDifferential: recalcResult.finalDifferential, newHandicapIndex: recalcResult.newHandicapIndex });
});

// ─── POST /api/portal/general-play/:id/dispute — marker disputes ────────────

router.post("/portal/general-play/:id/dispute", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const roundId = parseInt(String((req.params as Record<string, string>).id));
  const { note } = req.body;
  if (!note) { { res.status(400).json({ error: "A dispute note is required" }); return; } }

  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.status !== "pending_marker") { { res.status(400).json({ error: "Round cannot be disputed in its current status" }); return; } }

  if (round.userId === userId) { { res.status(403).json({ error: "You cannot dispute your own round" }); return; } }

  // Strict identity check: caller must match the marker record by userId.
  // Rounds with a null-userId marker (manually-entered) require admin override — not open to any user.
  const [markerRow] = await db.select().from(generalPlayMarkersTable).where(and(
    eq(generalPlayMarkersTable.roundId, roundId),
    eq(generalPlayMarkersTable.markerUserId, userId),
  ));
  if (!markerRow) { { res.status(403).json({ error: "Only the designated marker may dispute this round" }); return; } }

  await db.update(generalPlayRoundsTable).set({ status: "disputed", updatedAt: new Date() }).where(eq(generalPlayRoundsTable.id, roundId));
  await db.update(generalPlayMarkersTable).set({
    confirmationStatus: "disputed",
    disputeNote: note,
    respondedAt: new Date(),
  }).where(eq(generalPlayMarkersTable.id, markerRow.id));

  // Notify player
  // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendPushToUsers(
    [round.userId],
    "Round disputed ⚠️",
    `Your general play round has been disputed by your marker. Reason: ${note}`,
    { type: "general_play_disputed", roundId },
  ).catch(() => {});

  res.json({ success: true });
});

// ─── GET /api/portal/general-play/pending-marker — marker inbox ─────────────

router.get("/portal/general-play/pending-marker", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const markers = await db
    .select({
      markerId: generalPlayMarkersTable.id,
      roundId: generalPlayMarkersTable.roundId,
      markerName: generalPlayMarkersTable.markerName,
      round: generalPlayRoundsTable,
      courseName: coursesTable.name,
    })
    .from(generalPlayMarkersTable)
    .innerJoin(generalPlayRoundsTable, eq(generalPlayMarkersTable.roundId, generalPlayRoundsTable.id))
    .leftJoin(coursesTable, eq(generalPlayRoundsTable.courseId, coursesTable.id))
    .where(and(
      eq(generalPlayMarkersTable.markerUserId, userId),
      eq(generalPlayMarkersTable.confirmationStatus, "pending"),
      eq(generalPlayRoundsTable.status, "pending_marker"),
    ));

  res.json(markers);
});

// ─── GET /organizations/:orgId/general-play — admin view ────────────────────

router.get("/organizations/:orgId/general-play", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const statusFilter = req.query.status ? String(req.query.status) : null;
  const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit)), 200) : 100;

  // Use a correlated subquery for marker data to avoid row duplication when
  // a round has multiple marker records (e.g. re-submission after dispute).
  const rounds = await db
    .select({
      round: generalPlayRoundsTable,
      courseName: coursesTable.name,
      userName: appUsersTable.displayName,
      markerName: sql<string | null>`(
        SELECT gpm.marker_name FROM general_play_markers gpm
        WHERE gpm.round_id = ${generalPlayRoundsTable.id}
        ORDER BY gpm.id DESC LIMIT 1
      )`.as("marker_name"),
      markerStatus: sql<string | null>`(
        SELECT gpm.confirmation_status FROM general_play_markers gpm
        WHERE gpm.round_id = ${generalPlayRoundsTable.id}
        ORDER BY gpm.id DESC LIMIT 1
      )`.as("marker_status"),
      disputeNote: sql<string | null>`(
        SELECT gpm.dispute_note FROM general_play_markers gpm
        WHERE gpm.round_id = ${generalPlayRoundsTable.id}
        ORDER BY gpm.id DESC LIMIT 1
      )`.as("dispute_note"),
    })
    .from(generalPlayRoundsTable)
    .leftJoin(coursesTable, eq(generalPlayRoundsTable.courseId, coursesTable.id))
    .leftJoin(appUsersTable, eq(generalPlayRoundsTable.userId, appUsersTable.id))
    .where(and(
      eq(generalPlayRoundsTable.organizationId, orgId),
      statusFilter ? sql`${generalPlayRoundsTable.status} = ${statusFilter}` : undefined,
    ))
    .orderBy(desc(generalPlayRoundsTable.playedAt))
    .limit(limit)
    .offset(offset);

  res.json(rounds);
});

// ─── PATCH /organizations/:orgId/general-play/:id/flag — admin flag/unflag ──

router.patch("/organizations/:orgId/general-play/:id/flag", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const roundId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [round] = await db.select().from(generalPlayRoundsTable).where(and(
    eq(generalPlayRoundsTable.id, roundId),
    eq(generalPlayRoundsTable.organizationId, orgId),
  ));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }

  const { flagged, adminNote } = req.body;

  // Toggle flag: if flagging a confirmed round, move it back to unverified
  if (flagged && round.status === "confirmed") {
    await db.update(generalPlayRoundsTable).set({
      status: "unverified",
      unverifiedAt: new Date(),
      notes: adminNote ? `[Admin flag] ${adminNote}` : round.notes,
      updatedAt: new Date(),
    }).where(eq(generalPlayRoundsTable.id, roundId));
  } else if (!flagged && round.status === "unverified") {
    // Unflagging — admin clears the flag, round stays unverified (manual review needed to confirm)
    await db.update(generalPlayRoundsTable).set({
      notes: adminNote ? `[Admin unflag] ${adminNote}` : round.notes,
      updatedAt: new Date(),
    }).where(eq(generalPlayRoundsTable.id, roundId));
  }

  res.json({ success: true });
});

// ─── DELETE /organizations/:orgId/general-play/:id — admin remove ────────────

router.delete("/organizations/:orgId/general-play/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const roundId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [round] = await db.select().from(generalPlayRoundsTable).where(and(
    eq(generalPlayRoundsTable.id, roundId),
    eq(generalPlayRoundsTable.organizationId, orgId),
  ));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }

  // Cannot delete a confirmed round that has already been posted to handicap
  if (round.status === "confirmed" && round.scoreDifferential) {
    res.status(409).json({ error: "Cannot delete a confirmed round that has been posted to the handicap record. Use the flag action instead." });
    return;
  }

  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));

  res.json({ success: true });
});

// ─── POST /organizations/:orgId/general-play/:id/admin-confirm — admin override ──

router.post("/organizations/:orgId/general-play/:id/admin-confirm", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const roundId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [round] = await db.select().from(generalPlayRoundsTable).where(and(
    eq(generalPlayRoundsTable.id, roundId),
    eq(generalPlayRoundsTable.organizationId, orgId),
  ));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }
  if (!["pending_marker", "disputed", "unverified"].includes(round.status)) {
    res.status(400).json({ error: "Round cannot be admin-confirmed in its current status" }); return;
  }

  // Compute gross score from hole scores
  const holes = await db.select().from(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, roundId));
  const grossScore = holes.reduce((sum, h) => sum + h.strokes, 0);
  if (grossScore === 0) { { res.status(400).json({ error: "No hole scores found — cannot confirm" }); return; } }

  const pcc = await getPccForCourseDate(round.courseId, round.playedAt);

  // WHS Gap 6: postScoreAndRecalculate is called here ONLY because an org admin
  // (requireOrgAdmin guard above) is explicitly overriding/confirming the round.
  // The player's own submission route never triggers handicap recalculation.
  const recalcResult = await postScoreAndRecalculate({
    userId: round.userId,
    organizationId: round.organizationId,
    courseId: round.courseId,
    sourceType: "general_play",
    sourceGeneralPlayId: round.id,
    holesPlayed: round.holesPlayed,
    grossScore,
    adjustedGrossScore: grossScore,
    courseRating: round.courseRating ? Number(round.courseRating) : 72,
    slopeRating: round.slopeRating ?? 113,
    pcc,
    markerName: "[Admin confirmed]",
    markerGhinNumber: null,
    playedAt: round.playedAt,
  });

  await db.update(generalPlayRoundsTable).set({
    status: "confirmed",
    grossScore,
    scoreDifferential: String(recalcResult.finalDifferential),
    confirmedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(generalPlayRoundsTable.id, roundId));

  res.json({ success: true, finalDifferential: recalcResult.finalDifferential, newHandicapIndex: recalcResult.newHandicapIndex });
});

// ─── GET /api/portal/general-play/:id/pin-positions — get pin positions ───────
router.get("/portal/general-play/:id/pin-positions", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const roundId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(roundId)) { { res.status(400).json({ error: "Invalid round ID" }); return; } }

  const [round] = await db.select({ userId: generalPlayRoundsTable.userId })
    .from(generalPlayRoundsTable)
    .where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.userId !== userId) { { res.status(404).json({ error: "Round not found" }); return; } }

  const positions = await db.select()
    .from(holePinPositionsTable)
    .where(eq(holePinPositionsTable.generalPlayRoundId, roundId));

  res.json(positions.map(p => ({
    holeNumber: p.holeNumber,
    latOffset: p.latOffset,
    lngOffset: p.lngOffset,
    updatedAt: p.updatedAt,
  })));
});

// ─── PATCH /api/portal/general-play/:id/hole/:holeNumber/pin — set pin ────────
router.patch("/portal/general-play/:id/hole/:holeNumber/pin", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const roundId = parseInt(String((req.params as Record<string, string>).id));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  if (isNaN(roundId) || isNaN(holeNumber)) { { res.status(400).json({ error: "Invalid IDs" }); return; } }

  const { latOffset, lngOffset } = req.body;
  if (latOffset === undefined || lngOffset === undefined) {
    res.status(400).json({ error: "latOffset and lngOffset are required" }); return;
  }

  const [round] = await db.select({ userId: generalPlayRoundsTable.userId })
    .from(generalPlayRoundsTable)
    .where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.userId !== userId) { { res.status(404).json({ error: "Round not found" }); return; } }

  // Atomic upsert — avoids race-condition duplicates under concurrent saves
  await db.insert(holePinPositionsTable)
    .values({
      generalPlayRoundId: roundId,
      holeNumber,
      latOffset: String(latOffset),
      lngOffset: String(lngOffset),
    })
    .onConflictDoUpdate({
      target: [holePinPositionsTable.generalPlayRoundId, holePinPositionsTable.holeNumber],
      set: { latOffset: String(latOffset), lngOffset: String(lngOffset), updatedAt: new Date() },
    });

  res.json({ holeNumber, latOffset, lngOffset });
});

export default router;
