import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  roundSubmissionsTable, playersTable, tournamentsTable, coursesTable,
  holeDetailsTable, scoresTable, scorecardCorrectionsTable, roundSubmissionsExtTable,
} from "@workspace/db";
import { eq, and, asc, count, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { addMarkerLiveClient, removeMarkerLiveClient } from "../lib/realtime";
import { sendTransactionalPush } from "../lib/comms";
import { notifyWatchHoleVerified } from "./ws-watch";
import { notifyManualEntryRound } from "../lib/manualEntryNotify";

const router: IRouter = Router();

// GET /api/marker-live/:token
// Fully public — the token IS the credential. No session required.
// Returns round/player/submission details for the marker live view page.
router.get("/:token", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);
  if (!token || token.length < 20) { { res.status(400).json({ error: "Invalid token" }); return; } }

  const [submission] = await db
    .select({
      id: roundSubmissionsTable.id,
      playerId: roundSubmissionsTable.playerId,
      tournamentId: roundSubmissionsTable.tournamentId,
      round: roundSubmissionsTable.round,
      status: roundSubmissionsTable.status,
      totalStrokes: roundSubmissionsTable.totalStrokes,
      markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt,
    })
    .from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.markerShareToken, token));

  if (!submission) { { res.status(404).json({ error: "Invalid or expired link" }); return; } }

  if (submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "This link has expired" }); return;
  }

  if (["countersigned", "disputed"].includes(submission.status)) {
    res.status(410).json({ error: "This round has been finalised — the live view link is no longer active" }); return;
  }

  const [[playerRow], [tournamentRow]] = await Promise.all([
    db.select({ firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(playersTable).where(eq(playersTable.id, submission.playerId)),
    db.select({ name: tournamentsTable.name, courseId: tournamentsTable.courseId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId)),
  ]);

  let courseName: string | null = null;
  let holePars: { holeNumber: number; par: number }[] = [];
  if (tournamentRow?.courseId) {
    const [courseRow] = await db.select({ name: coursesTable.name })
      .from(coursesTable).where(eq(coursesTable.id, tournamentRow.courseId));
    courseName = courseRow?.name ?? null;

    const courseHoles = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournamentRow.courseId))
      .orderBy(asc(holeDetailsTable.holeNumber));
    holePars = courseHoles;
  }

  const [scores, corrections] = await Promise.all([
    db.select({ holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
      .from(scoresTable)
      .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)))
      .orderBy(asc(scoresTable.holeNumber)),
    db.select()
      .from(scorecardCorrectionsTable)
      .where(eq(scorecardCorrectionsTable.submissionId, submission.id))
      .orderBy(asc(scorecardCorrectionsTable.holeNumber)),
  ]);

  const totalHoles = holePars.length || 18;
  const roundComplete = scores.length >= totalHoles;

  res.json({
    submissionId: submission.id,
    playerId: submission.playerId,
    playerName: playerRow ? `${playerRow.firstName} ${playerRow.lastName}` : "Unknown",
    tournamentId: submission.tournamentId,
    tournamentName: tournamentRow?.name ?? "Tournament",
    courseName,
    round: submission.round,
    status: submission.status,
    totalStrokes: submission.totalStrokes,
    holePars,
    scores,
    corrections,
    roundComplete,
    token,
  });
});

// GET /api/marker-live/:token/stream
// Fully public SSE stream — token is the credential.
// Streams hole_score_entered events plus a score_snapshot on connect.
router.get("/:token/stream", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);
  if (!token || token.length < 20) { { res.status(400).json({ error: "Invalid token" }); return; } }

  const [submission] = await db
    .select({
      id: roundSubmissionsTable.id,
      playerId: roundSubmissionsTable.playerId,
      round: roundSubmissionsTable.round,
      status: roundSubmissionsTable.status,
      markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt,
    })
    .from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.markerShareToken, token));

  if (!submission) { { res.status(404).json({ error: "Invalid or expired token" }); return; } }
  if (submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Token expired" }); return;
  }
  if (["countersigned", "disputed"].includes(submission.status)) {
    res.status(410).json({ error: "Round finalised — stream closed" }); return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const scores = await db.select({ holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)))
    .orderBy(asc(scoresTable.holeNumber));

  if (scores.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "score_snapshot", data: scores })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: "connected", submissionId: submission.id })}\n\n`);

  addMarkerLiveClient(token, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeMarkerLiveClient(token, res);
  });
});

// POST /api/marker-live/:token/countersign
// Fully public — the token is the credential. Marker countersigns via the live view page.
// Validates that all holes are scored before allowing countersign.
router.post("/:token/countersign", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);
  if (!token || token.length < 20) { { res.status(400).json({ error: "Invalid token" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.markerShareToken, token));

  if (!submission) { { res.status(404).json({ error: "Invalid token or submission not found" }); return; } }
  if (submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Token expired" }); return;
  }
  if (submission.status !== "submitted") {
    res.status(400).json({
      error: submission.status === "pending"
        ? "Player must sign the scorecard first before the marker can countersign."
        : `Submission already ${submission.status}`,
    }); return;
  }

  // Enforce all holes scored before countersign
  const [tournamentRow] = await db.select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId));
  if (tournamentRow?.courseId) {
    const [{ totalHoles }] = await db.select({ totalHoles: count() })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournamentRow.courseId));
    const [{ scoredHoles }] = await db.select({ scoredHoles: count() })
      .from(scoresTable)
      .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));
    if (totalHoles > 0 && scoredHoles < totalHoles) {
      res.status(400).json({ error: `Not all holes are scored yet (${scoredHoles}/${totalHoles}). Complete the round before countersigning.` }); return;
    }
  }

  const now = new Date();
  await db.update(roundSubmissionsTable)
    .set({ status: "countersigned", reviewedAt: now, markerCode: null, markerShareToken: null })
    .where(eq(roundSubmissionsTable.id, submission.id));
  await db.update(scoresTable)
    .set({ isVerified: true, updatedAt: now })
    .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

  // Task #870 — alert TDs when this round closed mostly hand-entered.
  // Independent of whether the player has a linked app account.
  notifyManualEntryRound(submission.id).catch(() => {});

  const [existingExt] = await db.select().from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submission.id));
  if (existingExt) {
    await db.update(roundSubmissionsExtTable).set({ countersignedAt: now }).where(eq(roundSubmissionsExtTable.submissionId, submission.id));
  } else {
    await db.insert(roundSubmissionsExtTable).values({ submissionId: submission.id, countersignedAt: now });
  }

  const [playerRow] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (playerRow?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([playerRow.userId], "✅ Scorecard Counter-Signed", `Your round ${submission.round} scorecard has been counter-signed by your marker.`, { type: "score_approved", submissionId: submission.id }).catch(() => {});
    // Task #484 — paired watch buzz + clear awaiting indicator instantly.
    notifyWatchHoleVerified(playerRow.userId, { round: submission.round, submissionId: submission.id });
  }

  res.json({ success: true, message: "Scorecard counter-signed. Scores are now verified." });
});

// POST /api/marker-live/generate-token
// Authenticated player generates a share token for their current round.
// Unlike the portal/ version, this endpoint is NOT under the mobileApp or whsScoring gate.
router.post("/generate-token", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const user = req.user!;
  const { tournamentId, round = 1, submissionId } = req.body as { tournamentId?: number; round?: number; submissionId?: number };

  let submission: typeof roundSubmissionsTable.$inferSelect | undefined;

  if (submissionId) {
    const [found] = await db.select().from(roundSubmissionsTable)
      .where(eq(roundSubmissionsTable.id, submissionId));
    submission = found;
    if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

    // Verify ownership
    const [player] = await db.select({ userId: playersTable.userId, email: playersTable.email })
      .from(playersTable).where(eq(playersTable.id, submission.playerId));
    const userEmail = user.email ?? "";
    const isOwner =
      (player?.userId != null && player.userId === user.id) ||
      (player?.email != null && userEmail !== "" && player.email.toLowerCase() === userEmail.toLowerCase());
    if (!isOwner) { { res.status(403).json({ error: "Forbidden" }); return; } }
  } else if (tournamentId) {
    // Find player and submission from tournamentId+round
    const userEmail = user.email ?? "";
    const [player] = await db.select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${user.id})`
      ));
    if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

    let [found] = await db.select().from(roundSubmissionsTable)
      .where(and(eq(roundSubmissionsTable.playerId, player.id), eq(roundSubmissionsTable.round, round)));

    if (!found) {
      const [created] = await db.insert(roundSubmissionsTable)
        .values({ tournamentId, playerId: player.id, round, status: "pending" })
        .returning();
      found = created;
    }
    submission = found;
  } else {
    res.status(400).json({ error: "tournamentId or submissionId required" }); return;
  }

  if (!submission) { { res.status(500).json({ error: "Unable to resolve submission" }); return; } }
  if (["countersigned", "disputed"].includes(submission.status)) {
    res.status(409).json({ error: `Round is already ${submission.status}` }); return;
  }

  const now = new Date();
  if (submission.markerShareToken && submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt > now) {
    const shareUrl = `https://app.kharagolf.com/portal/marker-live/${submission.markerShareToken}`;
    res.json({ token: submission.markerShareToken, shareUrl }); return;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await db.update(roundSubmissionsTable)
    .set({ markerShareToken: token, markerShareTokenExpiresAt: expiresAt })
    .where(eq(roundSubmissionsTable.id, submission.id));

  const shareUrl = `https://app.kharagolf.com/portal/marker-live/${token}`;
  res.json({ token, shareUrl });
});

export default router;
