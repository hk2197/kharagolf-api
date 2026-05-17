/**
 * Tee Sheet Rules Engine API
 * All routes scoped under /organizations/:orgId/tee-rules
 *
 * Schedule Templates:
 *   GET    /templates                    List all templates
 *   POST   /templates                    Create template
 *   PATCH  /templates/:id               Update template
 *   DELETE /templates/:id               Delete template
 *   POST   /templates/preview            Dry-run preview (returns what slots would be generated)
 *   POST   /templates/regenerate         Safe re-generation for a date range
 *
 * Block Rules:
 *   GET    /block-rules                  List
 *   POST   /block-rules                  Create
 *   PATCH  /block-rules/:id             Update
 *   DELETE /block-rules/:id             Delete
 *
 * Player Count Rules:
 *   GET    /player-count-rules           List
 *   POST   /player-count-rules           Create
 *   PATCH  /player-count-rules/:id       Update
 *   DELETE /player-count-rules/:id       Delete
 *
 * Booking Windows:
 *   GET    /booking-windows              List
 *   PUT    /booking-windows              Upsert (one per tier per org)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  teeScheduleTemplatesTable,
  teeBlockRulesTable,
  teePlayerCountRulesTable,
  teeBookingWindowsTable,
  coursesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { materializeTeeSheet, safeRegenerate } from "../lib/teeMaterializer";

const router: IRouter = Router({ mergeParams: true });

/** Verifies that a courseId belongs to the given org. Returns false and sends 403 if not. */
async function requireCourseOwnership(res: Response, orgId: number, courseId: number | null | undefined): Promise<boolean> {
  if (courseId == null) return true;
  const [course] = await db
    .select({ id: coursesTable.id })
    .from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)));
  if (!course) {
    res.status(403).json({ error: "Course does not belong to this organisation" });
    return false;
  }
  return true;
}

// ─── SCHEDULE TEMPLATES ──────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-rules/templates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const templates = await db
    .select()
    .from(teeScheduleTemplatesTable)
    .where(eq(teeScheduleTemplatesTable.organizationId, orgId))
    .orderBy(teeScheduleTemplatesTable.createdAt);
  res.json(templates);
});

router.post("/organizations/:orgId/tee-rules/templates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    courseId, name, daysOfWeek, validFrom, validUntil,
    firstTeeTime, lastTeeTime, intervalMinutes, capacity, startType, isActive,
  } = req.body;
  if (!courseId || !name) { { res.status(400).json({ error: "courseId and name are required" }); return; } }
  if (!await requireCourseOwnership(res, orgId, courseId)) return;
  const [tmpl] = await db
    .insert(teeScheduleTemplatesTable)
    .values({
      organizationId: orgId,
      courseId,
      name,
      daysOfWeek: daysOfWeek ?? [0,1,2,3,4,5,6],
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      firstTeeTime: firstTeeTime ?? "06:00",
      lastTeeTime: lastTeeTime ?? "18:00",
      intervalMinutes: intervalMinutes ?? 10,
      capacity: capacity ?? 4,
      startType: startType ?? "normal",
      isActive: isActive !== false,
    })
    .returning();
  res.status(201).json(tmpl);
});

router.patch("/organizations/:orgId/tee-rules/templates/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    name, daysOfWeek, validFrom, validUntil,
    firstTeeTime, lastTeeTime, intervalMinutes, capacity, startType, isActive,
  } = req.body;
  const [tmpl] = await db
    .update(teeScheduleTemplatesTable)
    .set({
      ...(name !== undefined && { name }),
      ...(daysOfWeek !== undefined && { daysOfWeek }),
      ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
      ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      ...(firstTeeTime !== undefined && { firstTeeTime }),
      ...(lastTeeTime !== undefined && { lastTeeTime }),
      ...(intervalMinutes !== undefined && { intervalMinutes }),
      ...(capacity !== undefined && { capacity }),
      ...(startType !== undefined && { startType }),
      ...(isActive !== undefined && { isActive }),
      updatedAt: new Date(),
    })
    .where(and(eq(teeScheduleTemplatesTable.id, id), eq(teeScheduleTemplatesTable.organizationId, orgId)))
    .returning();
  if (!tmpl) { { res.status(404).json({ error: "Template not found" }); return; } }
  res.json(tmpl);
});

router.delete("/organizations/:orgId/tee-rules/templates/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db
    .delete(teeScheduleTemplatesTable)
    .where(and(eq(teeScheduleTemplatesTable.id, id), eq(teeScheduleTemplatesTable.organizationId, orgId)));
  res.json({ success: true });
});

/** POST /templates/preview — dry-run: what slots would be generated for a date range */
router.post("/organizations/:orgId/tee-rules/templates/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, fromDate, toDate } = req.body;
  if (!courseId || !fromDate || !toDate) { { res.status(400).json({ error: "courseId, fromDate, toDate required" }); return; } }
  if (!await requireCourseOwnership(res, orgId, courseId)) return;

  const results: { date: string; slots: { time: string; startingHole: number; startType: string; capacity: number }[] }[] = [];
  const cur = new Date(fromDate + "T00:00:00");
  const end = new Date(toDate + "T00:00:00");
  const maxDays = 31;
  let days = 0;

  while (cur <= end && days < maxDays) {
    const result = await materializeTeeSheet(orgId, courseId, new Date(cur), true);
    results.push({ date: cur.toISOString().split("T")[0], slots: result.slots });
    cur.setDate(cur.getDate() + 1);
    days++;
  }
  res.json({ preview: results, daysPreviewied: results.length });
});

/** POST /templates/regenerate — safe re-generation for a date range */
router.post("/organizations/:orgId/tee-rules/templates/regenerate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, fromDate, toDate } = req.body;
  if (!courseId || !fromDate || !toDate) { { res.status(400).json({ error: "courseId, fromDate, toDate required" }); return; } }
  if (!await requireCourseOwnership(res, orgId, courseId)) return;
  const result = await safeRegenerate(orgId, courseId, new Date(fromDate + "T00:00:00"), new Date(toDate + "T23:59:59"));
  res.json(result);
});

// ─── BLOCK RULES ─────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-rules/block-rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rules = await db
    .select()
    .from(teeBlockRulesTable)
    .where(eq(teeBlockRulesTable.organizationId, orgId))
    .orderBy(teeBlockRulesTable.createdAt);
  res.json(rules);
});

router.post("/organizations/:orgId/tee-rules/block-rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, name, blockDate, startTime, endTime, reason, recurrence, recurrenceDayOfWeek, recurrenceDayOfMonth, isActive } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  if (!await requireCourseOwnership(res, orgId, courseId)) return;
  const [rule] = await db
    .insert(teeBlockRulesTable)
    .values({
      organizationId: orgId,
      courseId: courseId ?? null,
      name,
      blockDate: blockDate ? new Date(blockDate) : null,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      reason: reason ?? "other",
      recurrence: recurrence ?? "one_off",
      recurrenceDayOfWeek: recurrenceDayOfWeek ?? null,
      recurrenceDayOfMonth: recurrenceDayOfMonth ?? null,
      isActive: isActive !== false,
    })
    .returning();
  res.status(201).json(rule);
});

router.patch("/organizations/:orgId/tee-rules/block-rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, blockDate, startTime, endTime, reason, recurrence, recurrenceDayOfWeek, recurrenceDayOfMonth, isActive, courseId } = req.body;
  if (courseId !== undefined && !await requireCourseOwnership(res, orgId, courseId)) return;
  const [rule] = await db
    .update(teeBlockRulesTable)
    .set({
      ...(name !== undefined && { name }),
      ...(blockDate !== undefined && { blockDate: blockDate ? new Date(blockDate) : null }),
      ...(startTime !== undefined && { startTime }),
      ...(endTime !== undefined && { endTime }),
      ...(reason !== undefined && { reason }),
      ...(recurrence !== undefined && { recurrence }),
      ...(recurrenceDayOfWeek !== undefined && { recurrenceDayOfWeek }),
      ...(recurrenceDayOfMonth !== undefined && { recurrenceDayOfMonth }),
      ...(isActive !== undefined && { isActive }),
      ...(courseId !== undefined && { courseId }),
      updatedAt: new Date(),
    })
    .where(and(eq(teeBlockRulesTable.id, id), eq(teeBlockRulesTable.organizationId, orgId)))
    .returning();
  if (!rule) { { res.status(404).json({ error: "Block rule not found" }); return; } }
  res.json(rule);
});

router.delete("/organizations/:orgId/tee-rules/block-rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db
    .delete(teeBlockRulesTable)
    .where(and(eq(teeBlockRulesTable.id, id), eq(teeBlockRulesTable.organizationId, orgId)));
  res.json({ success: true });
});

// ─── PLAYER COUNT RULES ───────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-rules/player-count-rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rules = await db
    .select()
    .from(teePlayerCountRulesTable)
    .where(eq(teePlayerCountRulesTable.organizationId, orgId))
    .orderBy(teePlayerCountRulesTable.createdAt);
  res.json(rules);
});

router.post("/organizations/:orgId/tee-rules/player-count-rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, name, minPlayers, maxPlayers, daysOfWeek, startTime, endTime, membershipTier, isActive } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  if (!await requireCourseOwnership(res, orgId, courseId)) return;
  const [rule] = await db
    .insert(teePlayerCountRulesTable)
    .values({
      organizationId: orgId,
      courseId: courseId ?? null,
      name,
      minPlayers: minPlayers ?? 1,
      maxPlayers: maxPlayers ?? 4,
      daysOfWeek: daysOfWeek ?? null,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      membershipTier: membershipTier ?? null,
      isActive: isActive !== false,
    })
    .returning();
  res.status(201).json(rule);
});

router.patch("/organizations/:orgId/tee-rules/player-count-rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, minPlayers, maxPlayers, daysOfWeek, startTime, endTime, membershipTier, isActive, courseId } = req.body;
  if (courseId !== undefined && !await requireCourseOwnership(res, orgId, courseId)) return;
  const [rule] = await db
    .update(teePlayerCountRulesTable)
    .set({
      ...(name !== undefined && { name }),
      ...(minPlayers !== undefined && { minPlayers }),
      ...(maxPlayers !== undefined && { maxPlayers }),
      ...(daysOfWeek !== undefined && { daysOfWeek }),
      ...(startTime !== undefined && { startTime }),
      ...(endTime !== undefined && { endTime }),
      ...(membershipTier !== undefined && { membershipTier }),
      ...(isActive !== undefined && { isActive }),
      ...(courseId !== undefined && { courseId }),
      updatedAt: new Date(),
    })
    .where(and(eq(teePlayerCountRulesTable.id, id), eq(teePlayerCountRulesTable.organizationId, orgId)))
    .returning();
  if (!rule) { { res.status(404).json({ error: "Player count rule not found" }); return; } }
  res.json(rule);
});

router.delete("/organizations/:orgId/tee-rules/player-count-rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db
    .delete(teePlayerCountRulesTable)
    .where(and(eq(teePlayerCountRulesTable.id, id), eq(teePlayerCountRulesTable.organizationId, orgId)));
  res.json({ success: true });
});

// ─── BOOKING WINDOWS ─────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-rules/booking-windows", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const windows = await db
    .select()
    .from(teeBookingWindowsTable)
    .where(eq(teeBookingWindowsTable.organizationId, orgId))
    .orderBy(teeBookingWindowsTable.membershipTier);
  res.json(windows);
});

router.put("/organizations/:orgId/tee-rules/booking-windows", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { membershipTier, daysAhead } = req.body;
  if (!membershipTier || daysAhead == null) { { res.status(400).json({ error: "membershipTier and daysAhead required" }); return; } }
  const validTiers = ["full_member", "social_member", "guest", "public"] as const;
  if (!validTiers.includes(membershipTier)) { { res.status(400).json({ error: "Invalid membershipTier" }); return; } }
  const [win] = await db
    .insert(teeBookingWindowsTable)
    .values({ organizationId: orgId, membershipTier, daysAhead })
    .onConflictDoUpdate({
      target: [teeBookingWindowsTable.organizationId, teeBookingWindowsTable.membershipTier],
      set: { daysAhead, updatedAt: new Date() },
    })
    .returning();
  res.json(win);
});

export default router;
