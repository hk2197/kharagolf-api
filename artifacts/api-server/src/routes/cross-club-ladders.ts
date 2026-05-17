/**
 * Cross-Club Leagues & National Ladders (Task #376)
 *
 * Super-admin / league-organizer manages cross-club ladders that span
 * multiple participating organizations. Members of any participating club
 * may register; standings are recomputed from qualifying rounds posted at
 * any of the participating clubs.
 *
 * Admin (super_admin):
 *   GET    /cross-club-ladders                            List all ladders
 *   POST   /cross-club-ladders                            Create ladder
 *   GET    /cross-club-ladders/:id                        Get full detail
 *   PATCH  /cross-club-ladders/:id                        Update
 *   DELETE /cross-club-ladders/:id                        Delete
 *   POST   /cross-club-ladders/:id/clubs                  Add participating club
 *   DELETE /cross-club-ladders/:id/clubs/:orgId           Remove participating club
 *   POST   /cross-club-ladders/:id/results                Post a qualifying-round result
 *   POST   /cross-club-ladders/:id/recalculate            Recompute standings
 *   POST   /cross-club-ladders/:id/finalize               Promotion/relegation + final standings
 *
 * Player:
 *   POST   /cross-club-ladders/:id/register               Register self for the ladder (eligibility-checked)
 *
 * Public (no auth):
 *   GET    /public/cross-club-ladders                     List public ladders
 *   GET    /public/cross-club-ladders/:slug               Public ladder + standings
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  crossClubLaddersTable,
  crossClubLadderClubsTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
  crossClubLadderResultAuditsTable,
  crossClubLadderEventsTable,
  organizationsTable,
  appUsersTable,
  clubMembersTable,
} from "@workspace/db";
import { and, eq, desc, asc } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push";
import { recomputeStandings } from "../lib/cross-club-ladder-standings";

const adminRouter: IRouter = Router();
const publicRouter: IRouter = Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

function requireSuperAdmin(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { role?: string };
  if (user?.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required." });
    return false;
  }
  return true;
}

function getAuthUserId(req: Request): number | null {
  if (req.isAuthenticated()) {
    const u = req.user as { id?: number };
    return u?.id ?? null;
  }
  const portal = (req as unknown as { portalUser?: { userId?: number } }).portalUser;
  return portal?.userId ?? null;
}

function makeSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "ladder";
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

interface EligibilityCheck {
  ok: boolean;
  reason?: string;
}

function checkEligibility(
  ladder: typeof crossClubLaddersTable.$inferSelect,
  candidate: { handicapIndex: number | null; membershipType: string | null; region: string | null; orgId: number | null },
  participatingOrgIds: Set<number>,
): EligibilityCheck {
  if (candidate.orgId == null || !participatingOrgIds.has(candidate.orgId)) {
    return { ok: false, reason: "Your home club is not a participating club in this ladder." };
  }
  if (ladder.minHandicap != null) {
    if (candidate.handicapIndex == null) return { ok: false, reason: "Handicap index required." };
    if (candidate.handicapIndex < Number(ladder.minHandicap)) {
      return { ok: false, reason: `Handicap below minimum (${ladder.minHandicap}).` };
    }
  }
  if (ladder.maxHandicap != null) {
    if (candidate.handicapIndex == null) return { ok: false, reason: "Handicap index required." };
    if (candidate.handicapIndex > Number(ladder.maxHandicap)) {
      return { ok: false, reason: `Handicap above maximum (${ladder.maxHandicap}).` };
    }
  }
  const allowedTypes = ladder.allowedMembershipTypes ?? [];
  if (allowedTypes.length > 0 && (!candidate.membershipType || !allowedTypes.includes(candidate.membershipType))) {
    return { ok: false, reason: `Membership type not eligible (allowed: ${allowedTypes.join(", ")}).` };
  }
  const allowedRegions = ladder.allowedRegions ?? [];
  if (allowedRegions.length > 0 && (!candidate.region || !allowedRegions.includes(candidate.region))) {
    return { ok: false, reason: `Region not eligible (allowed: ${allowedRegions.join(", ")}).` };
  }
  return { ok: true };
}

// recomputeStandings is implemented in lib/cross-club-ladder-standings.ts so
// the auto-feed hooks (general-play & tournament completion) can re-trigger
// the same computation without a circular import on this routes module.

// ─── ADMIN routes ────────────────────────────────────────────────────────────

adminRouter.get("/cross-club-ladders", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const ladders = await db
    .select()
    .from(crossClubLaddersTable)
    .orderBy(desc(crossClubLaddersTable.createdAt));
  res.json(ladders);
});

adminRouter.post("/cross-club-ladders", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const userId = getAuthUserId(req);
  const b = req.body as Record<string, unknown>;
  if (!b.name || !b.seasonStart || !b.seasonEnd) {
    res.status(400).json({ error: "name, seasonStart, seasonEnd required" });
    return;
  }
  const [row] = await db.insert(crossClubLaddersTable).values({
    name: String(b.name),
    description: (b.description as string | undefined) ?? null,
    scope: (b.scope as "regional" | "national" | undefined) ?? "national",
    format: (b.format as "stroke" | "stableford" | "team_series" | "knockout_cup" | "national_ladder" | undefined) ?? "stableford",
    region: (b.region as string | undefined) ?? null,
    seasonStart: new Date(String(b.seasonStart)),
    seasonEnd: new Date(String(b.seasonEnd)),
    minHandicap: b.minHandicap != null ? String(b.minHandicap) : null,
    maxHandicap: b.maxHandicap != null ? String(b.maxHandicap) : null,
    allowedMembershipTypes: Array.isArray(b.allowedMembershipTypes) ? b.allowedMembershipTypes as string[] : [],
    allowedRegions: Array.isArray(b.allowedRegions) ? b.allowedRegions as string[] : [],
    bestOfRounds: typeof b.bestOfRounds === "number" ? b.bestOfRounds : null,
    minRoundsRequired: typeof b.minRoundsRequired === "number" ? b.minRoundsRequired : 1,
    promotionRelegationEnabled: !!b.promotionRelegationEnabled,
    divisionCount: typeof b.divisionCount === "number" ? b.divisionCount : 1,
    promotePerDivision: typeof b.promotePerDivision === "number" ? b.promotePerDivision : 0,
    relegatePerDivision: typeof b.relegatePerDivision === "number" ? b.relegatePerDivision : 0,
    isPublic: b.isPublic !== false,
    shareSlug: makeSlug(String(b.name)),
    createdBy: userId,
  }).returning();
  res.status(201).json(row);
});

adminRouter.get("/cross-club-ladders/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Not found" }); return; } }
  const clubs = await db
    .select({
      id: crossClubLadderClubsTable.id,
      organizationId: crossClubLadderClubsTable.organizationId,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      joinedAt: crossClubLadderClubsTable.joinedAt,
    })
    .from(crossClubLadderClubsTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, crossClubLadderClubsTable.organizationId))
    .where(eq(crossClubLadderClubsTable.ladderId, id));
  const entries = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(eq(crossClubLadderEntriesTable.ladderId, id))
    .orderBy(asc(crossClubLadderEntriesTable.division), asc(crossClubLadderEntriesTable.position));
  res.json({ ...ladder, clubs, entries });
});

adminRouter.patch("/cross-club-ladders/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [existing] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!existing) { { res.status(404).json({ error: "Not found" }); return; } }
  const b = req.body as Record<string, unknown>;
  const [updated] = await db.update(crossClubLaddersTable).set({
    name: (b.name as string | undefined) ?? existing.name,
    description: b.description !== undefined ? (b.description as string | null) : existing.description,
    scope: (b.scope as "regional" | "national" | undefined) ?? existing.scope,
    format: (b.format as typeof existing.format | undefined) ?? existing.format,
    status: (b.status as typeof existing.status | undefined) ?? existing.status,
    region: b.region !== undefined ? (b.region as string | null) : existing.region,
    seasonStart: b.seasonStart ? new Date(String(b.seasonStart)) : existing.seasonStart,
    seasonEnd: b.seasonEnd ? new Date(String(b.seasonEnd)) : existing.seasonEnd,
    minHandicap: b.minHandicap !== undefined ? (b.minHandicap == null ? null : String(b.minHandicap)) : existing.minHandicap,
    maxHandicap: b.maxHandicap !== undefined ? (b.maxHandicap == null ? null : String(b.maxHandicap)) : existing.maxHandicap,
    allowedMembershipTypes: Array.isArray(b.allowedMembershipTypes) ? b.allowedMembershipTypes as string[] : existing.allowedMembershipTypes,
    allowedRegions: Array.isArray(b.allowedRegions) ? b.allowedRegions as string[] : existing.allowedRegions,
    bestOfRounds: b.bestOfRounds !== undefined ? (typeof b.bestOfRounds === "number" ? b.bestOfRounds : null) : existing.bestOfRounds,
    minRoundsRequired: typeof b.minRoundsRequired === "number" ? b.minRoundsRequired : existing.minRoundsRequired,
    promotionRelegationEnabled: typeof b.promotionRelegationEnabled === "boolean" ? b.promotionRelegationEnabled : existing.promotionRelegationEnabled,
    divisionCount: typeof b.divisionCount === "number" ? b.divisionCount : existing.divisionCount,
    promotePerDivision: typeof b.promotePerDivision === "number" ? b.promotePerDivision : existing.promotePerDivision,
    relegatePerDivision: typeof b.relegatePerDivision === "number" ? b.relegatePerDivision : existing.relegatePerDivision,
    isPublic: typeof b.isPublic === "boolean" ? b.isPublic : existing.isPublic,
    updatedAt: new Date(),
  }).where(eq(crossClubLaddersTable.id, id)).returning();
  res.json(updated);
});

adminRouter.delete("/cross-club-ladders/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  res.json({ success: true });
});

adminRouter.post("/cross-club-ladders/:id/clubs", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const orgId = parseInt(String((req.body as { organizationId?: unknown }).organizationId));
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "organizationId required" }); return; } }
  const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  await db.insert(crossClubLadderClubsTable).values({ ladderId: id, organizationId: orgId }).onConflictDoNothing();
  res.json({ success: true });
});

adminRouter.delete("/cross-club-ladders/:id/clubs/:orgId", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await db.delete(crossClubLadderClubsTable)
    .where(and(eq(crossClubLadderClubsTable.ladderId, id), eq(crossClubLadderClubsTable.organizationId, orgId)));
  res.json({ success: true });
});

// Post a qualifying-round result. Either super-admin or an org_admin/director
// of a participating club may post on behalf of a player.
adminRouter.post("/cross-club-ladders/:id/results", async (req, res) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const b = req.body as Record<string, unknown>;
  const entryId = Number(b.entryId);
  if (!Number.isFinite(entryId)) { { res.status(400).json({ error: "entryId required" }); return; } }

  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Ladder not found" }); return; } }
  const [entry] = await db.select().from(crossClubLadderEntriesTable).where(eq(crossClubLadderEntriesTable.id, entryId));
  if (!entry || entry.ladderId !== id) { { res.status(404).json({ error: "Entry not found" }); return; } }

  const user = req.user as { id?: number; role?: string; organizationId?: number };
  const isSuper = user.role === "super_admin";
  const orgId = b.organizationId != null ? Number(b.organizationId) : (user.organizationId ?? null);

  if (!isSuper) {
    if (!orgId) { { res.status(400).json({ error: "organizationId required" }); return; } }
    const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
    if (!isOrgAdmin || user.organizationId !== orgId) {
      res.status(403).json({ error: "Not allowed to post results for this club." });
      return;
    }
    const [club] = await db.select().from(crossClubLadderClubsTable)
      .where(and(eq(crossClubLadderClubsTable.ladderId, id), eq(crossClubLadderClubsTable.organizationId, orgId)));
    if (!club) { { res.status(403).json({ error: "Your club is not a participating club." }); return; } }
  }

  const stableford = b.stablefordPoints != null ? Number(b.stablefordPoints) : null;
  const gross = b.grossScore != null ? Number(b.grossScore) : null;
  const net = b.netScore != null ? Number(b.netScore) : null;
  // Points awarded depends on format: stableford → use stableford pts, stroke → 100-net (lower is better)
  let pointsAwarded = 0;
  if (ladder.format === "stableford" || ladder.format === "national_ladder") {
    pointsAwarded = stableford ?? 0;
  } else if (ladder.format === "stroke") {
    pointsAwarded = net != null ? Math.max(0, 100 - net) : (gross != null ? Math.max(0, 100 - gross) : 0);
  } else {
    pointsAwarded = stableford ?? (net != null ? Math.max(0, 100 - net) : 0);
  }

  const [result] = await db.insert(crossClubLadderResultsTable).values({
    ladderId: id,
    entryId,
    organizationId: orgId,
    generalPlayRoundId: b.generalPlayRoundId != null ? Number(b.generalPlayRoundId) : null,
    tournamentId: b.tournamentId != null ? Number(b.tournamentId) : null,
    roundDate: b.roundDate ? new Date(String(b.roundDate)) : new Date(),
    grossScore: gross,
    netScore: net,
    stablefordPoints: stableford,
    pointsAwarded,
    notes: (b.notes as string | undefined) ?? null,
  }).returning();

  await recomputeStandings(id);

  // Push: qualifying-round confirmation to player
  if (entry.userId) {
    // Task #1240 — fire-and-forget; result discarded by surrounding
    // try/catch, classifier intentionally not consulted.
    try {
      await sendPushToUsers(
        [entry.userId],
        "Round counted toward ladder",
        `${ladder.name}: ${pointsAwarded} pts awarded.`,
        { ladderId: id, slug: ladder.shareSlug },
      );
    } catch { /* non-fatal */ }

    // Task #2008 — branded `interclub.qualified` dispatch (email + digest) so
    // the qualifier gets a polished cross-club confirmation on top of the
    // bespoke push above. Cross-club ladders are the inter-club surface in
    // this product, so the qualifying-round confirmation IS the qualification
    // signal for the player.
    const { notifyInterclubQualified } = await import("../lib/brandedNotifications.js");
    void notifyInterclubQualified({
      userIds: [entry.userId],
      eventId: id,
      eventName: ladder.name,
    });
  }

  res.status(201).json(result);
});

// Bulk-post qualifying-round results in a single request. Designed for the
// admin CSV importer: validates each row, inserts all valid rows in one
// transaction, recomputes standings ONCE at the end, and batches push
// notifications (one per player) instead of one per row.
//
// Body: { rows: BulkRow[] }  where BulkRow mirrors the single-result payload,
// optionally with `rowNumber` echoed back in the response for client mapping.
// Returns: { successCount, errorCount, results: [{ rowNumber, status, ... }] }
adminRouter.post("/cross-club-ladders/:id/results/bulk", async (req, res) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const body = req.body as { rows?: unknown };
  const rawRows = Array.isArray(body) ? body : (Array.isArray(body?.rows) ? body.rows : null);
  if (!rawRows) { { res.status(400).json({ error: "rows array required" }); return; } }
  if (rawRows.length === 0) {
    res.json({ successCount: 0, errorCount: 0, results: [] });
    return;
  }
  if (rawRows.length > 1000) {
    res.status(400).json({ error: "Too many rows (max 1000 per request)." });
    return;
  }

  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Ladder not found" }); return; } }

  const user = req.user as { id?: number; role?: string; organizationId?: number };
  const isSuper = user.role === "super_admin";
  const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
  if (!isSuper && (!isOrgAdmin || !user.organizationId)) {
    res.status(403).json({ error: "Not allowed to post results for this ladder." });
    return;
  }

  // Pre-load entries and participating clubs once so per-row validation is O(1).
  const entries = await db.select().from(crossClubLadderEntriesTable)
    .where(eq(crossClubLadderEntriesTable.ladderId, id));
  const entriesById = new Map(entries.map(e => [e.id, e]));
  const clubs = await db.select().from(crossClubLadderClubsTable)
    .where(eq(crossClubLadderClubsTable.ladderId, id));
  const participatingOrgIds = new Set(clubs.map(c => c.organizationId));

  if (!isSuper && !participatingOrgIds.has(user.organizationId!)) {
    res.status(403).json({ error: "Your club is not a participating club." });
    return;
  }

  type RowOut = {
    rowNumber: number;
    status: "success" | "error";
    message?: string;
    resultId?: number;
  };
  const results: RowOut[] = [];
  const toInsert: { values: typeof crossClubLadderResultsTable.$inferInsert; userId: number | null }[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i] as Record<string, unknown>;
    const rowNumber = typeof r?.rowNumber === "number" ? r.rowNumber : i + 1;
    const fail = (message: string) => results.push({ rowNumber, status: "error", message });

    if (!r || typeof r !== "object") { fail("Invalid row"); continue; }
    const entryId = Number(r.entryId);
    if (!Number.isFinite(entryId)) { fail("entryId required"); continue; }
    const entry = entriesById.get(entryId);
    if (!entry) { fail("Entry not found in this ladder"); continue; }

    const orgId = r.organizationId != null ? Number(r.organizationId) : (isSuper ? null : (user.organizationId ?? null));
    if (orgId != null && !participatingOrgIds.has(orgId)) {
      fail("organizationId is not a participating club"); continue;
    }
    if (!isSuper) {
      if (!orgId) { fail("organizationId required"); continue; }
      if (orgId !== user.organizationId) { fail("Not allowed to post for this club"); continue; }
    }

    const stableford = r.stablefordPoints != null && r.stablefordPoints !== "" ? Number(r.stablefordPoints) : null;
    const gross = r.grossScore != null && r.grossScore !== "" ? Number(r.grossScore) : null;
    const net = r.netScore != null && r.netScore !== "" ? Number(r.netScore) : null;
    if (stableford != null && Number.isNaN(stableford)) { fail("Invalid stablefordPoints"); continue; }
    if (gross != null && Number.isNaN(gross)) { fail("Invalid grossScore"); continue; }
    if (net != null && Number.isNaN(net)) { fail("Invalid netScore"); continue; }

    const pointsAwarded = computePointsAwarded(ladder.format, stableford, net, gross);

    let roundDate: Date;
    if (r.roundDate) {
      const d = new Date(String(r.roundDate));
      if (Number.isNaN(d.getTime())) { fail("Invalid roundDate"); continue; }
      roundDate = d;
    } else {
      roundDate = new Date();
    }

    toInsert.push({
      userId: entry.userId,
      values: {
        ladderId: id,
        entryId,
        organizationId: orgId,
        generalPlayRoundId: r.generalPlayRoundId != null ? Number(r.generalPlayRoundId) : null,
        tournamentId: r.tournamentId != null ? Number(r.tournamentId) : null,
        roundDate,
        grossScore: gross,
        netScore: net,
        stablefordPoints: stableford,
        pointsAwarded,
        notes: (r.notes as string | undefined) ?? null,
      },
    });
    // Reserve the success slot now so output order matches input order.
    results.push({ rowNumber, status: "success" });
  }

  if (toInsert.length > 0) {
    try {
      const inserted = await db.transaction(async (tx) => {
        return tx.insert(crossClubLadderResultsTable)
          .values(toInsert.map(t => t.values))
          .returning({ id: crossClubLadderResultsTable.id });
      });
      // Map inserted IDs back to results in insertion order. Since we appended
      // a "success" placeholder for each insert in order, walk both lists.
      let k = 0;
      for (let i = 0; i < results.length && k < inserted.length; i++) {
        if (results[i].status === "success" && results[i].resultId == null) {
          results[i].resultId = inserted[k].id;
          results[i].message = "Posted";
          k++;
        }
      }
    } catch (err) {
      // If the bulk insert fails the whole batch is rolled back. Mark all
      // pending success rows as errored so the client sees consistent state.
      const message = (err as Error).message || "Bulk insert failed";
      for (const r of results) {
        if (r.status === "success" && r.resultId == null) {
          r.status = "error";
          r.message = message;
        }
      }
      res.status(500).json({
        error: "Bulk insert failed; no rows were saved.",
        successCount: 0,
        errorCount: results.filter(r => r.status === "error").length,
        results,
      });
      return;
    }

    // Recompute standings ONCE for the whole batch.
    await recomputeStandings(id);

    // Batch push notifications: one notification per player that received >= 1
    // result in this import.
    const userIdToCount = new Map<number, number>();
    for (const t of toInsert) {
      if (t.userId) userIdToCount.set(t.userId, (userIdToCount.get(t.userId) ?? 0) + 1);
    }
    if (userIdToCount.size > 0) {
      try {
        const userIds = Array.from(userIdToCount.keys());
        // Single push per user; the message reflects how many rounds were
        // counted in this batch instead of firing one per row.
        // Task #1240 — fire-and-forget; per-recipient PushDeliveryResult
        // is discarded, classifier intentionally not consulted.
        await Promise.all(
          userIds.map(uid =>
            sendPushToUsers(
              [uid],
              "Rounds counted toward ladder",
              `${ladder.name}: ${userIdToCount.get(uid)} round(s) posted.`,
              { ladderId: id, slug: ladder.shareSlug },
            ).catch(() => { /* non-fatal */ }),
          ),
        );
      } catch { /* non-fatal */ }
    }
  }

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;
  res.status(201).json({ successCount, errorCount, results });
});

// List posted results for a single entry (admin history view).
// Allowed: super_admin, OR an org_admin/tournament_director whose home
// organization is a participating club of this ladder.
adminRouter.get("/cross-club-ladders/:id/entries/:entryId/results", async (req, res) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const entryId = parseInt(String((req.params as Record<string, string>).entryId));
  const user = req.user as { role?: string; organizationId?: number };
  if (user.role !== "super_admin") {
    const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
    if (!isOrgAdmin || !user.organizationId) {
      res.status(403).json({ error: "Admin access required." });
      return;
    }
    const [club] = await db.select().from(crossClubLadderClubsTable)
      .where(and(
        eq(crossClubLadderClubsTable.ladderId, id),
        eq(crossClubLadderClubsTable.organizationId, user.organizationId),
      ));
    if (!club) {
      res.status(403).json({ error: "Your club is not a participating club." });
      return;
    }
  }
  // Verify the entry actually belongs to this ladder before returning rows
  const [entry] = await db.select().from(crossClubLadderEntriesTable)
    .where(and(eq(crossClubLadderEntriesTable.id, entryId), eq(crossClubLadderEntriesTable.ladderId, id)));
  if (!entry) { { res.status(404).json({ error: "Entry not found" }); return; } }
  const rows = await db
    .select()
    .from(crossClubLadderResultsTable)
    .where(and(eq(crossClubLadderResultsTable.ladderId, id), eq(crossClubLadderResultsTable.entryId, entryId)))
    .orderBy(desc(crossClubLadderResultsTable.roundDate), desc(crossClubLadderResultsTable.id));

  // Decorate each row with its most recent audit (edit count + last actor/time)
  // so the manage panel can render an inline "edited by …" note without N+1.
  const resultIds = rows.map(r => r.id);
  type AuditSummary = { count: number; last: typeof crossClubLadderResultAuditsTable.$inferSelect | null };
  const auditByResult = new Map<number, AuditSummary>();
  if (resultIds.length > 0) {
    const audits = await db
      .select()
      .from(crossClubLadderResultAuditsTable)
      .where(and(
        eq(crossClubLadderResultAuditsTable.ladderId, id),
        eq(crossClubLadderResultAuditsTable.entryId, entryId),
      ))
      .orderBy(desc(crossClubLadderResultAuditsTable.createdAt));
    for (const a of audits) {
      const existing = auditByResult.get(a.resultId) ?? { count: 0, last: null };
      existing.count += 1;
      if (!existing.last) existing.last = a;
      auditByResult.set(a.resultId, existing);
    }
  }
  const decorated = rows.map(r => {
    const summary = auditByResult.get(r.id);
    return {
      ...r,
      auditCount: summary?.count ?? 0,
      lastAudit: summary?.last
        ? {
            action: summary.last.action,
            actorName: summary.last.actorName,
            actorRole: summary.last.actorRole,
            createdAt: summary.last.createdAt,
          }
        : null,
    };
  });
  res.json(decorated);
});

// Authorization helper for editing/deleting an existing result.
// Allowed: super_admin, OR an org_admin/tournament_director of the result's
// originating organization (the club it was posted at).
async function authorizeResultMutation(
  req: Request,
  res: Response,
  ladderId: number,
  resultId: number,
): Promise<{ result: typeof crossClubLadderResultsTable.$inferSelect } | null> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Auth required" }); return null; }
  const [result] = await db.select().from(crossClubLadderResultsTable)
    .where(and(eq(crossClubLadderResultsTable.id, resultId), eq(crossClubLadderResultsTable.ladderId, ladderId)));
  if (!result) { res.status(404).json({ error: "Result not found" }); return null; }
  const user = req.user as { role?: string; organizationId?: number };
  if (user.role === "super_admin") return { result };
  const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
  if (!isOrgAdmin || result.organizationId == null || user.organizationId !== result.organizationId) {
    res.status(403).json({ error: "Not allowed to modify this result." });
    return null;
  }
  return { result };
}

function computePointsAwarded(
  format: typeof crossClubLaddersTable.$inferSelect["format"],
  stableford: number | null,
  net: number | null,
  gross: number | null,
): number {
  if (format === "stableford" || format === "national_ladder") {
    return stableford ?? 0;
  }
  if (format === "stroke") {
    return net != null ? Math.max(0, 100 - net) : (gross != null ? Math.max(0, 100 - gross) : 0);
  }
  return stableford ?? (net != null ? Math.max(0, 100 - net) : 0);
}

function diffResultFields(
  before: typeof crossClubLadderResultsTable.$inferSelect,
  after: typeof crossClubLadderResultsTable.$inferSelect,
): Record<string, { from: unknown; to: unknown }> {
  const fields: Array<keyof typeof before> = [
    "roundDate", "grossScore", "netScore", "stablefordPoints", "pointsAwarded", "notes",
  ];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    const a = before[f];
    const b = after[f];
    const av = a instanceof Date ? a.toISOString() : a;
    const bv = b instanceof Date ? b.toISOString() : b;
    if (av !== bv) changes[f as string] = { from: av, to: bv };
  }
  return changes;
}

async function getActorMeta(req: Request): Promise<{
  userId: number | null;
  name: string | null;
  role: string | null;
}> {
  const userId = getAuthUserId(req);
  const u = req.user as { id?: number; role?: string; displayName?: string; username?: string } | undefined;
  let name = u?.displayName || u?.username || null;
  const role = u?.role ?? null;
  if (userId && !name) {
    const [row] = await db.select({
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(appUsersTable).where(eq(appUsersTable.id, userId));
    name = row?.displayName || row?.username || null;
  }
  return { userId: userId ?? null, name, role };
}

adminRouter.patch("/cross-club-ladders/:id/results/:resultId", async (req, res) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const resultId = parseInt(String((req.params as Record<string, string>).resultId));
  const auth = await authorizeResultMutation(req, res, id, resultId);
  if (!auth) return;
  const { result } = auth;
  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Ladder not found" }); return; } }

  const b = req.body as Record<string, unknown>;
  const stableford = b.stablefordPoints !== undefined
    ? (b.stablefordPoints == null || b.stablefordPoints === "" ? null : Number(b.stablefordPoints))
    : result.stablefordPoints;
  const gross = b.grossScore !== undefined
    ? (b.grossScore == null || b.grossScore === "" ? null : Number(b.grossScore))
    : result.grossScore;
  const net = b.netScore !== undefined
    ? (b.netScore == null || b.netScore === "" ? null : Number(b.netScore))
    : result.netScore;
  const pointsAwarded = computePointsAwarded(ladder.format, stableford, net, gross);

  const [updated] = await db.update(crossClubLadderResultsTable).set({
    roundDate: b.roundDate ? new Date(String(b.roundDate)) : result.roundDate,
    grossScore: gross,
    netScore: net,
    stablefordPoints: stableford,
    pointsAwarded,
    notes: b.notes !== undefined ? ((b.notes as string | null) ?? null) : result.notes,
  }).where(eq(crossClubLadderResultsTable.id, resultId)).returning();

  const fieldChanges = diffResultFields(result, updated);
  // Always record an audit row for every PATCH (even no-op edits) so the
  // log shows who acted and when, per task acceptance criteria.
  const actor = await getActorMeta(req);
  await db.insert(crossClubLadderResultAuditsTable).values({
    ladderId: id,
    resultId,
    entryId: result.entryId,
    action: "update",
    actorUserId: actor.userId,
    actorName: actor.name,
    actorRole: actor.role,
    fieldChanges,
    snapshot: null,
  });

  if (Object.keys(fieldChanges).length > 0) {
    // Optional player notification when their points changed.
    if (fieldChanges.pointsAwarded) {
      const [entry] = await db.select().from(crossClubLadderEntriesTable)
        .where(eq(crossClubLadderEntriesTable.id, result.entryId));
      if (entry?.userId) {
        // Task #1240 — fire-and-forget; result discarded by surrounding
        // try/catch, classifier intentionally not consulted.
        try {
          await sendPushToUsers(
            [entry.userId],
            "Ladder result updated",
            `${ladder.name}: points changed from ${result.pointsAwarded} to ${updated.pointsAwarded}.`,
            { ladderId: id, slug: ladder.shareSlug },
          );
        } catch { /* non-fatal */ }
      }
    }
  }

  await recomputeStandings(id);
  res.json(updated);
});

adminRouter.delete("/cross-club-ladders/:id/results/:resultId", async (req, res) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const resultId = parseInt(String((req.params as Record<string, string>).resultId));
  const auth = await authorizeResultMutation(req, res, id, resultId);
  if (!auth) return;
  const { result } = auth;

  const actor = await getActorMeta(req);
  await db.insert(crossClubLadderResultAuditsTable).values({
    ladderId: id,
    resultId,
    entryId: result.entryId,
    action: "delete",
    actorUserId: actor.userId,
    actorName: actor.name,
    actorRole: actor.role,
    fieldChanges: null,
    snapshot: {
      organizationId: result.organizationId,
      generalPlayRoundId: result.generalPlayRoundId,
      tournamentId: result.tournamentId,
      roundDate: result.roundDate instanceof Date ? result.roundDate.toISOString() : result.roundDate,
      grossScore: result.grossScore,
      netScore: result.netScore,
      stablefordPoints: result.stablefordPoints,
      pointsAwarded: result.pointsAwarded,
      notes: result.notes,
    },
  });

  await db.delete(crossClubLadderResultsTable).where(eq(crossClubLadderResultsTable.id, resultId));
  await recomputeStandings(id);

  // Optional player notification: their posted result was removed.
  if (result.pointsAwarded > 0) {
    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, result.entryId));
    const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
    if (entry?.userId && ladder) {
      // Task #1240 — fire-and-forget; result discarded by surrounding
      // try/catch, classifier intentionally not consulted.
      try {
        await sendPushToUsers(
          [entry.userId],
          "Ladder result removed",
          `${ladder.name}: a posted result (${result.pointsAwarded} pts) was removed by an admin.`,
          { ladderId: id, slug: ladder.shareSlug },
        );
      } catch { /* non-fatal */ }
    }
  }

  res.json({ success: true });
});

// Full audit feed for an entry — includes audits for results that have
// since been deleted, so admins can see who removed a result and recover
// the snapshot. Same auth as the entry results list.
adminRouter.get("/cross-club-ladders/:id/entries/:entryId/audits", async (req, res) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const entryId = parseInt(String((req.params as Record<string, string>).entryId));
  const user = req.user as { role?: string; organizationId?: number };
  if (user.role !== "super_admin") {
    const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
    if (!isOrgAdmin || !user.organizationId) {
      res.status(403).json({ error: "Admin access required." });
      return;
    }
    const [club] = await db.select().from(crossClubLadderClubsTable)
      .where(and(
        eq(crossClubLadderClubsTable.ladderId, id),
        eq(crossClubLadderClubsTable.organizationId, user.organizationId),
      ));
    if (!club) { { res.status(403).json({ error: "Not a participating club." }); return; } }
  }
  const [entry] = await db.select().from(crossClubLadderEntriesTable)
    .where(and(eq(crossClubLadderEntriesTable.id, entryId), eq(crossClubLadderEntriesTable.ladderId, id)));
  if (!entry) { { res.status(404).json({ error: "Entry not found" }); return; } }
  const audits = await db
    .select()
    .from(crossClubLadderResultAuditsTable)
    .where(and(
      eq(crossClubLadderResultAuditsTable.ladderId, id),
      eq(crossClubLadderResultAuditsTable.entryId, entryId),
    ))
    .orderBy(desc(crossClubLadderResultAuditsTable.createdAt));
  // Tag each audit with whether the underlying result still exists, so the
  // UI can highlight tombstones for fully deleted results.
  const liveIds = new Set(
    (await db
      .select({ id: crossClubLadderResultsTable.id })
      .from(crossClubLadderResultsTable)
      .where(and(
        eq(crossClubLadderResultsTable.ladderId, id),
        eq(crossClubLadderResultsTable.entryId, entryId),
      ))
    ).map(r => r.id),
  );
  res.json(audits.map(a => ({ ...a, resultStillExists: liveIds.has(a.resultId) })));
});

// Audit history for a single posted result. Same auth as edit/delete:
// super_admin OR org_admin/tournament_director of the result's originating org.
adminRouter.get("/cross-club-ladders/:id/results/:resultId/audits", async (req, res) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const resultId = parseInt(String((req.params as Record<string, string>).resultId));
  // Audit rows survive the underlying result, so authorize via the most recent
  // audit row when the result is gone (delete audits still need to be viewable).
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Auth required" }); return; } }
  const [result] = await db.select().from(crossClubLadderResultsTable)
    .where(and(eq(crossClubLadderResultsTable.id, resultId), eq(crossClubLadderResultsTable.ladderId, id)));
  const user = req.user as { role?: string; organizationId?: number };
  if (user.role !== "super_admin") {
    const isOrgAdmin = user.role === "org_admin" || user.role === "tournament_director";
    if (!isOrgAdmin || !user.organizationId) {
      res.status(403).json({ error: "Admin access required." });
      return;
    }
    // Either the live result must belong to the admin's org, or (for deletes)
    // the admin's org must be a participating club of the ladder.
    if (result && result.organizationId !== user.organizationId) {
      res.status(403).json({ error: "Not allowed to view this audit." });
      return;
    }
    if (!result) {
      const [club] = await db.select().from(crossClubLadderClubsTable)
        .where(and(
          eq(crossClubLadderClubsTable.ladderId, id),
          eq(crossClubLadderClubsTable.organizationId, user.organizationId),
        ));
      if (!club) { { res.status(403).json({ error: "Not a participating club." }); return; } }
    }
  }
  const rows = await db
    .select()
    .from(crossClubLadderResultAuditsTable)
    .where(and(
      eq(crossClubLadderResultAuditsTable.ladderId, id),
      eq(crossClubLadderResultAuditsTable.resultId, resultId),
    ))
    .orderBy(desc(crossClubLadderResultAuditsTable.createdAt));
  res.json(rows);
});

adminRouter.post("/cross-club-ladders/:id/recalculate", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  await recomputeStandings(id);
  res.json({ success: true });
});

adminRouter.post("/cross-club-ladders/:id/finalize", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Not found" }); return; } }

  await recomputeStandings(id);

  const fresh = await db.select().from(crossClubLadderEntriesTable).where(eq(crossClubLadderEntriesTable.ladderId, id));
  const byDiv = new Map<number, typeof fresh>();
  for (const e of fresh) {
    const arr = byDiv.get(e.division) ?? [];
    arr.push(e);
    byDiv.set(e.division, arr);
  }

  const userIdsToNotify: number[] = [];
  const eventRows: typeof crossClubLadderEventsTable.$inferInsert[] = [];
  const promoteN = ladder.promotePerDivision;
  const relegateN = ladder.relegatePerDivision;

  for (const [div, list] of byDiv) {
    list.sort((a, b) => (a.position ?? 99999) - (b.position ?? 99999));
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const finalPos = e.position ?? i + 1;
      let promoted = false;
      let relegated = false;
      if (ladder.promotionRelegationEnabled) {
        if (div > 1 && promoteN > 0 && i < promoteN) {
          promoted = true;
          await db.update(crossClubLadderEntriesTable).set({ division: div - 1 }).where(eq(crossClubLadderEntriesTable.id, e.id));
          eventRows.push({ ladderId: id, entryId: e.id, eventType: "promoted", fromDivision: div, toDivision: div - 1, finalPosition: finalPos, message: `Promoted from Div ${div} to Div ${div - 1}` });
        } else if (div < ladder.divisionCount && relegateN > 0 && i >= list.length - relegateN) {
          relegated = true;
          await db.update(crossClubLadderEntriesTable).set({ division: div + 1 }).where(eq(crossClubLadderEntriesTable.id, e.id));
          eventRows.push({ ladderId: id, entryId: e.id, eventType: "relegated", fromDivision: div, toDivision: div + 1, finalPosition: finalPos, message: `Relegated from Div ${div} to Div ${div + 1}` });
        }
      }
      eventRows.push({
        ladderId: id, entryId: e.id, eventType: "final_standing",
        fromDivision: div, toDivision: promoted ? div - 1 : relegated ? div + 1 : div,
        finalPosition: finalPos,
        message: `Finished position ${finalPos} in Division ${div}`,
      });
      if (e.userId) userIdsToNotify.push(e.userId);
    }
  }

  if (eventRows.length > 0) await db.insert(crossClubLadderEventsTable).values(eventRows);
  await db.update(crossClubLaddersTable)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(crossClubLaddersTable.id, id));

  if (userIdsToNotify.length > 0) {
    // Task #1240 — fire-and-forget; result discarded by surrounding
    // try/catch, classifier intentionally not consulted.
    try {
      await sendPushToUsers(
        userIdsToNotify,
        `${ladder.name} — Final standings`,
        `The season has concluded. Tap to see your final position.`,
        { ladderId: id, slug: ladder.shareSlug, type: "ladder_final" },
      );
    } catch { /* non-fatal */ }
  }

  res.json({ success: true, notified: userIdsToNotify.length, events: eventRows.length });
});

// Player self-registration with eligibility check
adminRouter.post("/cross-club-ladders/:id/register", async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));

  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  if (!ladder) { { res.status(404).json({ error: "Ladder not found" }); return; } }
  if (ladder.status !== "open" && ladder.status !== "active" && ladder.status !== "draft") {
    res.status(400).json({ error: "Registration closed." });
    return;
  }

  const clubs = await db.select({ organizationId: crossClubLadderClubsTable.organizationId })
    .from(crossClubLadderClubsTable)
    .where(eq(crossClubLadderClubsTable.ladderId, id));
  const partOrgIds = new Set<number>(clubs.map(c => c.organizationId));

  // Find candidate's home club via their first matching club_members row in a participating org
  const memberships = await db.select().from(clubMembersTable).where(eq(clubMembersTable.userId, userId));
  const inPart = memberships.find(m => partOrgIds.has(m.organizationId));
  if (!inPart) {
    res.status(403).json({ error: "You must belong to a participating club to register." });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const candidate = {
    handicapIndex: inPart.handicapIndex != null ? Number(inPart.handicapIndex) : null,
    membershipType: (b.membershipType as string | undefined) ?? null,
    region: (b.region as string | undefined) ?? null,
    orgId: inPart.organizationId,
  };
  const elig = checkEligibility(ladder, candidate, partOrgIds);
  if (!elig.ok) { { res.status(403).json({ error: elig.reason }); return; } }

  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
  const playerName = `${inPart.firstName} ${inPart.lastName}`.trim() || (user?.email ?? "Player");

  const [entry] = await db.insert(crossClubLadderEntriesTable).values({
    ladderId: id,
    userId,
    homeOrganizationId: inPart.organizationId,
    playerName,
    playerEmail: inPart.email ?? user?.email ?? null,
    handicapAtRegistration: inPart.handicapIndex,
    membershipType: candidate.membershipType,
    region: candidate.region,
    division: ladder.divisionCount, // start in lowest division
  }).onConflictDoUpdate({
    target: [crossClubLadderEntriesTable.ladderId, crossClubLadderEntriesTable.userId],
    set: { updatedAt: new Date() },
  }).returning();

  res.status(201).json(entry);
});

// Player's own qualifying-round history for a ladder.
// Returns the signed-in user's entry plus every result row posted against it
// so the player can see counted vs uncounted rounds, dates, points, and the
// club where each round was posted.
adminRouter.get("/cross-club-ladders/:id/my-results", async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Auth required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid ladder id" }); return; } }

  const [entry] = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(and(
      eq(crossClubLadderEntriesTable.ladderId, id),
      eq(crossClubLadderEntriesTable.userId, userId),
    ));
  if (!entry) {
    res.json({ entry: null, results: [] });
    return;
  }

  const rows = await db
    .select({
      id: crossClubLadderResultsTable.id,
      roundDate: crossClubLadderResultsTable.roundDate,
      organizationId: crossClubLadderResultsTable.organizationId,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      grossScore: crossClubLadderResultsTable.grossScore,
      netScore: crossClubLadderResultsTable.netScore,
      stablefordPoints: crossClubLadderResultsTable.stablefordPoints,
      pointsAwarded: crossClubLadderResultsTable.pointsAwarded,
      countedTowardTotal: crossClubLadderResultsTable.countedTowardTotal,
      generalPlayRoundId: crossClubLadderResultsTable.generalPlayRoundId,
      tournamentId: crossClubLadderResultsTable.tournamentId,
      notes: crossClubLadderResultsTable.notes,
    })
    .from(crossClubLadderResultsTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, crossClubLadderResultsTable.organizationId))
    .where(and(
      eq(crossClubLadderResultsTable.ladderId, id),
      eq(crossClubLadderResultsTable.entryId, entry.id),
    ))
    .orderBy(desc(crossClubLadderResultsTable.roundDate), desc(crossClubLadderResultsTable.id));

  res.json({
    entry: {
      id: entry.id,
      division: entry.division,
      totalPoints: entry.totalPoints,
      roundsCounted: entry.roundsCounted,
      position: entry.position,
    },
    results: rows,
  });
});

// ─── PUBLIC routes ───────────────────────────────────────────────────────────

publicRouter.get("/cross-club-ladders", async (_req, res) => {
  const rows = await db
    .select({
      id: crossClubLaddersTable.id,
      name: crossClubLaddersTable.name,
      description: crossClubLaddersTable.description,
      scope: crossClubLaddersTable.scope,
      format: crossClubLaddersTable.format,
      status: crossClubLaddersTable.status,
      region: crossClubLaddersTable.region,
      seasonStart: crossClubLaddersTable.seasonStart,
      seasonEnd: crossClubLaddersTable.seasonEnd,
      shareSlug: crossClubLaddersTable.shareSlug,
    })
    .from(crossClubLaddersTable)
    .where(eq(crossClubLaddersTable.isPublic, true))
    .orderBy(desc(crossClubLaddersTable.seasonStart));
  res.json(rows);
});

publicRouter.get("/cross-club-ladders/:slug", async (req, res) => {
  const slug = (req.params as Record<string, string>).slug;
  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.shareSlug, slug));
  if (!ladder || !ladder.isPublic) { { res.status(404).json({ error: "Not found" }); return; } }

  const clubs = await db
    .select({
      organizationId: crossClubLadderClubsTable.organizationId,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
    })
    .from(crossClubLadderClubsTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, crossClubLadderClubsTable.organizationId))
    .where(eq(crossClubLadderClubsTable.ladderId, ladder.id));

  const standings = await db
    .select({
      id: crossClubLadderEntriesTable.id,
      playerName: crossClubLadderEntriesTable.playerName,
      homeOrganizationId: crossClubLadderEntriesTable.homeOrganizationId,
      division: crossClubLadderEntriesTable.division,
      totalPoints: crossClubLadderEntriesTable.totalPoints,
      roundsCounted: crossClubLadderEntriesTable.roundsCounted,
      position: crossClubLadderEntriesTable.position,
      previousPosition: crossClubLadderEntriesTable.previousPosition,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
    })
    .from(crossClubLadderEntriesTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, crossClubLadderEntriesTable.homeOrganizationId))
    .where(eq(crossClubLadderEntriesTable.ladderId, ladder.id))
    .orderBy(asc(crossClubLadderEntriesTable.division), asc(crossClubLadderEntriesTable.position));

  const recent = await db
    .select({
      id: crossClubLadderResultsTable.id,
      entryId: crossClubLadderResultsTable.entryId,
      organizationId: crossClubLadderResultsTable.organizationId,
      roundDate: crossClubLadderResultsTable.roundDate,
      pointsAwarded: crossClubLadderResultsTable.pointsAwarded,
      countedTowardTotal: crossClubLadderResultsTable.countedTowardTotal,
    })
    .from(crossClubLadderResultsTable)
    .where(eq(crossClubLadderResultsTable.ladderId, ladder.id))
    .orderBy(desc(crossClubLadderResultsTable.roundDate))
    .limit(20);

  res.json({ ...ladder, clubs, standings, recentResults: recent });
});

export { publicRouter as publicCrossClubLaddersRouter };
export default adminRouter;
