/**
 * Junior Golf Programs API
 * Scoped to: /organizations/:orgId/junior
 *
 * Junior Profiles:
 * GET    /profiles                              List junior profiles for org
 * POST   /profiles                             Create a junior profile
 * GET    /profiles/:profileId                  Get a single profile with guardians & progress
 * PUT    /profiles/:profileId                  Update a junior profile
 * DELETE /profiles/:profileId                  Deactivate a junior profile
 *
 * Guardians:
 * POST   /profiles/:profileId/guardians        Add a guardian link
 * DELETE /profiles/:profileId/guardians/:id   Remove a guardian link
 *
 * Development Pathways:
 * GET    /pathways                             List pathways (org-level)
 * POST   /pathways                             Create a pathway
 * PUT    /pathways/:pathwayId                  Update a pathway
 * DELETE /pathways/:pathwayId                  Delete a pathway
 * POST   /pathways/:pathwayId/levels           Add a level to a pathway
 * PUT    /pathways/:pathwayId/levels/:levelId  Update a level
 * DELETE /pathways/:pathwayId/levels/:levelId  Delete a level
 *
 * Progress:
 * POST   /profiles/:profileId/progress        Enroll in a pathway or advance level
 *
 * Programs:
 * GET    /programs                             List programs
 * POST   /programs                             Create a program
 * GET    /programs/:programId                  Get program with sessions + participants
 * PUT    /programs/:programId                  Update a program
 * DELETE /programs/:programId                  Delete a program
 * POST   /programs/:programId/participants     Enrol a junior
 * DELETE /programs/:programId/participants/:id Remove a participant
 *
 * Sessions:
 * POST   /programs/:programId/sessions            Add a session
 * PUT    /programs/:programId/sessions/:sessionId Update a session
 * DELETE /programs/:programId/sessions/:sessionId Delete a session
 * POST   /programs/:programId/sessions/:sessionId/attendance  Mark attendance
 * GET    /programs/:programId/sessions/:sessionId/attendance  Get attendance
 *
 * Awards:
 * GET    /awards                               List awards (org-wide)
 * POST   /awards                              Create an award
 * DELETE /awards/:awardId                     Delete an award
 *
 * Leaderboard:
 * GET    /leaderboard                          Age-group filtered leaderboard
 *
 * Portal (player/parent):
 * GET    /portal/my-juniors                   Juniors linked to the authenticated user
 * GET    /portal/leaderboard                  Leaderboard accessible to portal users
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  juniorProfilesTable,
  guardianLinksTable,
  developmentPathwaysTable,
  pathwayLevelsTable,
  juniorPathwayProgressTable,
  juniorProgramsTable,
  programParticipantsTable,
  programSessionsTable,
  programAttendanceTable,
  juniorAwardsTable,
  playersTable,
  tournamentsTable,
  scoresTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, sql, count, min, avg } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

const VALID_AGE_CATEGORIES = ["under_8","under_10","under_12","under_14","under_16","under_18"] as const;
type AgeCategory = typeof VALID_AGE_CATEGORIES[number];

const VALID_PATHWAY_LEVELS = ["beginner","intermediate","advanced","elite"] as const;
type PathwayLevel = typeof VALID_PATHWAY_LEVELS[number];

const VALID_AWARD_TYPES = ["monthly_winner","most_improved","best_attendance","spirit_award","custom"] as const;

function isValidAgeCategory(v: unknown): v is AgeCategory {
  return VALID_AGE_CATEGORIES.includes(v as AgeCategory);
}
function isValidPathwayLevel(v: unknown): v is PathwayLevel {
  return VALID_PATHWAY_LEVELS.includes(v as PathwayLevel);
}
function isValidAwardType(v: unknown): v is typeof VALID_AWARD_TYPES[number] {
  return VALID_AWARD_TYPES.includes(v as typeof VALID_AWARD_TYPES[number]);
}

function getAuthUser(req: Request) {
  return req.user as { id: number; role?: string; organizationId?: number } | undefined;
}

/** Resolve the org-scoped program owning a session. Returns null if session doesn't belong to org. */
async function getOrgSession(sessionId: number, programId: number, orgId: number) {
  const [row] = await db
    .select({ sessionId: programSessionsTable.id, programId: juniorProgramsTable.id })
    .from(programSessionsTable)
    .innerJoin(juniorProgramsTable, and(
      eq(programSessionsTable.programId, juniorProgramsTable.id),
      eq(juniorProgramsTable.organizationId, orgId),
    ))
    .where(and(eq(programSessionsTable.id, sessionId), eq(programSessionsTable.programId, programId)));
  return row ?? null;
}

// ─── JUNIOR PROFILES ─────────────────────────────────────────────────────────

// GET /junior/profiles
router.get("/profiles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { ageCategory, pathwayLevel, activeOnly = "true" } = req.query as Record<string, string>;

  const conditions = [eq(juniorProfilesTable.organizationId, orgId)];
  if (activeOnly === "true") conditions.push(eq(juniorProfilesTable.isActive, true));
  if (ageCategory) {
    if (!isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
    conditions.push(eq(juniorProfilesTable.ageCategory, ageCategory as never));
  }
  if (pathwayLevel) {
    if (!isValidPathwayLevel(pathwayLevel)) { { res.status(400).json({ error: "Invalid pathwayLevel" }); return; } }
    conditions.push(eq(juniorProfilesTable.pathwayLevel, pathwayLevel));
  }

  const profiles = await db
    .select({
      id: juniorProfilesTable.id,
      firstName: juniorProfilesTable.firstName,
      lastName: juniorProfilesTable.lastName,
      dateOfBirth: juniorProfilesTable.dateOfBirth,
      ageCategory: juniorProfilesTable.ageCategory,
      pathwayLevel: juniorProfilesTable.pathwayLevel,
      handicapIndex: juniorProfilesTable.handicapIndex,
      preferredTeeBox: juniorProfilesTable.preferredTeeBox,
      notes: juniorProfilesTable.notes,
      isActive: juniorProfilesTable.isActive,
      userId: juniorProfilesTable.userId,
      createdAt: juniorProfilesTable.createdAt,
    })
    .from(juniorProfilesTable)
    .where(and(...conditions))
    .orderBy(asc(juniorProfilesTable.lastName), asc(juniorProfilesTable.firstName));

  res.json(profiles);
});

// POST /junior/profiles
router.post("/profiles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    firstName, lastName, dateOfBirth, ageCategory, pathwayLevel,
    handicapIndex, preferredTeeBox, notes, userId,
  } = req.body;

  if (!firstName || !lastName || !dateOfBirth || !ageCategory) {
    res.status(400).json({ error: "firstName, lastName, dateOfBirth, and ageCategory are required" });
    return;
  }
  if (!isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
  if (pathwayLevel && !isValidPathwayLevel(pathwayLevel)) { { res.status(400).json({ error: "Invalid pathwayLevel" }); return; } }

  const [profile] = await db.insert(juniorProfilesTable).values({
    organizationId: orgId,
    firstName,
    lastName,
    dateOfBirth: new Date(dateOfBirth),
    ageCategory,
    pathwayLevel: isValidPathwayLevel(pathwayLevel) ? pathwayLevel : "beginner",
    handicapIndex: handicapIndex ?? null,
    preferredTeeBox: preferredTeeBox ?? "red",
    notes: notes ?? null,
    userId: userId ?? null,
  }).returning();

  res.status(201).json(profile);
});

// GET /junior/profiles/:profileId
router.get("/profiles/:profileId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));

  const [profile] = await db.select()
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)));

  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }

  const [guardians, progress] = await Promise.all([
    db.select().from(guardianLinksTable)
      .where(eq(guardianLinksTable.juniorProfileId, profileId))
      .orderBy(desc(guardianLinksTable.isPrimary)),
    db
      .select({
        progressId: juniorPathwayProgressTable.id,
        pathwayId: juniorPathwayProgressTable.pathwayId,
        pathwayName: developmentPathwaysTable.name,
        currentLevelId: juniorPathwayProgressTable.currentLevelId,
        currentLevelName: pathwayLevelsTable.name,
        currentLevelOrder: pathwayLevelsTable.level,
        startedAt: juniorPathwayProgressTable.startedAt,
        lastProgressedAt: juniorPathwayProgressTable.lastProgressedAt,
        notes: juniorPathwayProgressTable.notes,
      })
      .from(juniorPathwayProgressTable)
      .innerJoin(developmentPathwaysTable, eq(juniorPathwayProgressTable.pathwayId, developmentPathwaysTable.id))
      .leftJoin(pathwayLevelsTable, eq(juniorPathwayProgressTable.currentLevelId, pathwayLevelsTable.id))
      .where(eq(juniorPathwayProgressTable.juniorProfileId, profileId)),
  ]);

  res.json({ ...profile, guardians, progress });
});

// PUT /junior/profiles/:profileId
router.put("/profiles/:profileId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));
  const { firstName, lastName, dateOfBirth, ageCategory, pathwayLevel, handicapIndex, preferredTeeBox, notes, isActive, userId } = req.body;

  if (ageCategory && !isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
  if (pathwayLevel && !isValidPathwayLevel(pathwayLevel)) { { res.status(400).json({ error: "Invalid pathwayLevel" }); return; } }

  const updateData: Partial<typeof juniorProfilesTable.$inferInsert> = { updatedAt: new Date() };
  if (firstName !== undefined) updateData.firstName = firstName;
  if (lastName !== undefined) updateData.lastName = lastName;
  if (dateOfBirth !== undefined) updateData.dateOfBirth = new Date(dateOfBirth);
  if (ageCategory !== undefined) updateData.ageCategory = ageCategory;
  if (pathwayLevel !== undefined) updateData.pathwayLevel = pathwayLevel;
  if (handicapIndex !== undefined) updateData.handicapIndex = handicapIndex;
  if (preferredTeeBox !== undefined) updateData.preferredTeeBox = preferredTeeBox;
  if (notes !== undefined) updateData.notes = notes;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (userId !== undefined) updateData.userId = userId;

  const [updated] = await db.update(juniorProfilesTable)
    .set(updateData)
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Profile not found" }); return; } }
  res.json(updated);
});

// DELETE /junior/profiles/:profileId
router.delete("/profiles/:profileId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));

  const [updated] = await db.update(juniorProfilesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)))
    .returning({ id: juniorProfilesTable.id });

  if (!updated) { { res.status(404).json({ error: "Profile not found" }); return; } }
  res.json({ ok: true });
});

// ─── GUARDIANS ────────────────────────────────────────────────────────────────

// POST /junior/profiles/:profileId/guardians
router.post("/profiles/:profileId/guardians", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));
  const { guardianName, guardianEmail, guardianPhone, relationship, isPrimary, guardianUserId } = req.body;

  if (!guardianName) { { res.status(400).json({ error: "guardianName is required" }); return; } }

  const [profile] = await db.select({ id: juniorProfilesTable.id })
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)));
  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }

  const [link] = await db.insert(guardianLinksTable).values({
    juniorProfileId: profileId,
    guardianName,
    guardianEmail: guardianEmail ?? null,
    guardianPhone: guardianPhone ?? null,
    relationship: relationship ?? "parent",
    isPrimary: isPrimary ?? true,
    guardianUserId: guardianUserId ?? null,
  }).returning();

  res.status(201).json(link);
});

// DELETE /junior/profiles/:profileId/guardians/:guardianId
router.delete("/profiles/:profileId/guardians/:guardianId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));
  const guardianId = parseInt(String((req.params as Record<string, string>).guardianId));

  // Verify the profile belongs to this org before deleting the guardian link
  const [profile] = await db.select({ id: juniorProfilesTable.id })
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)));
  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }

  const [deleted] = await db.delete(guardianLinksTable)
    .where(and(eq(guardianLinksTable.id, guardianId), eq(guardianLinksTable.juniorProfileId, profileId)))
    .returning({ id: guardianLinksTable.id });

  if (!deleted) { { res.status(404).json({ error: "Guardian link not found" }); return; } }
  res.json({ ok: true });
});

// ─── DEVELOPMENT PATHWAYS ──────────────────────────────────────────────────────

// GET /junior/pathways
router.get("/pathways", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathways = await db.select().from(developmentPathwaysTable)
    .where(eq(developmentPathwaysTable.organizationId, orgId))
    .orderBy(asc(developmentPathwaysTable.name));

  const allLevels = pathways.length > 0
    ? await db.select().from(pathwayLevelsTable)
      .where(inArray(pathwayLevelsTable.pathwayId, pathways.map(p => p.id)))
      .orderBy(asc(pathwayLevelsTable.sortOrder))
    : [];

  const levelsByPathway = allLevels.reduce<Record<number, typeof allLevels>>((acc, l) => {
    (acc[l.pathwayId] ??= []).push(l);
    return acc;
  }, {});

  res.json(pathways.map(p => ({ ...p, levels: levelsByPathway[p.id] ?? [] })));
});

// POST /junior/pathways
router.post("/pathways", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [pathway] = await db.insert(developmentPathwaysTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
  }).returning();

  res.status(201).json(pathway);
});

// PUT /junior/pathways/:pathwayId
router.put("/pathways/:pathwayId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathwayId = parseInt(String((req.params as Record<string, string>).pathwayId));
  const { name, description, isActive } = req.body;

  const updateData: Partial<typeof developmentPathwaysTable.$inferInsert> = { updatedAt: new Date() };
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (isActive !== undefined) updateData.isActive = isActive;

  const [updated] = await db.update(developmentPathwaysTable)
    .set(updateData)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Pathway not found" }); return; } }
  res.json(updated);
});

// DELETE /junior/pathways/:pathwayId
router.delete("/pathways/:pathwayId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathwayId = parseInt(String((req.params as Record<string, string>).pathwayId));

  const [deleted] = await db.delete(developmentPathwaysTable)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)))
    .returning({ id: developmentPathwaysTable.id });

  if (!deleted) { { res.status(404).json({ error: "Pathway not found" }); return; } }
  res.json({ ok: true });
});

// POST /junior/pathways/:pathwayId/levels
router.post("/pathways/:pathwayId/levels", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathwayId = parseInt(String((req.params as Record<string, string>).pathwayId));
  const { name, level, description, criteria, sortOrder } = req.body;

  if (!name || !level) { { res.status(400).json({ error: "name and level are required" }); return; } }
  if (!isValidPathwayLevel(level)) { { res.status(400).json({ error: "Invalid level value" }); return; } }

  const [pathway] = await db.select({ id: developmentPathwaysTable.id })
    .from(developmentPathwaysTable)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)));
  if (!pathway) { { res.status(404).json({ error: "Pathway not found" }); return; } }

  const [lvl] = await db.insert(pathwayLevelsTable).values({
    pathwayId,
    name,
    level,
    description: description ?? null,
    criteria: criteria ?? null,
    sortOrder: sortOrder ?? 0,
  }).returning();

  res.status(201).json(lvl);
});

// PUT /junior/pathways/:pathwayId/levels/:levelId
router.put("/pathways/:pathwayId/levels/:levelId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathwayId = parseInt(String((req.params as Record<string, string>).pathwayId));
  const levelId = parseInt(String((req.params as Record<string, string>).levelId));

  // Verify pathway belongs to org before modifying its level
  const [pathway] = await db.select({ id: developmentPathwaysTable.id })
    .from(developmentPathwaysTable)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)));
  if (!pathway) { { res.status(404).json({ error: "Pathway not found" }); return; } }

  const { name, level, description, criteria, sortOrder } = req.body;
  if (level && !isValidPathwayLevel(level)) { { res.status(400).json({ error: "Invalid level value" }); return; } }

  const updateData: Partial<typeof pathwayLevelsTable.$inferInsert> = {};
  if (name !== undefined) updateData.name = name;
  if (level !== undefined) updateData.level = level;
  if (description !== undefined) updateData.description = description;
  if (criteria !== undefined) updateData.criteria = criteria;
  if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

  const [updated] = await db.update(pathwayLevelsTable)
    .set(updateData)
    .where(and(eq(pathwayLevelsTable.id, levelId), eq(pathwayLevelsTable.pathwayId, pathwayId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Level not found" }); return; } }
  res.json(updated);
});

// DELETE /junior/pathways/:pathwayId/levels/:levelId
router.delete("/pathways/:pathwayId/levels/:levelId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const pathwayId = parseInt(String((req.params as Record<string, string>).pathwayId));
  const levelId = parseInt(String((req.params as Record<string, string>).levelId));

  // Verify pathway belongs to org before deleting its level
  const [pathway] = await db.select({ id: developmentPathwaysTable.id })
    .from(developmentPathwaysTable)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)));
  if (!pathway) { { res.status(404).json({ error: "Pathway not found" }); return; } }

  const [deleted] = await db.delete(pathwayLevelsTable)
    .where(and(eq(pathwayLevelsTable.id, levelId), eq(pathwayLevelsTable.pathwayId, pathwayId)))
    .returning({ id: pathwayLevelsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Level not found" }); return; } }
  res.json({ ok: true });
});

// ─── PATHWAY PROGRESS ─────────────────────────────────────────────────────────

// POST /junior/profiles/:profileId/progress
router.post("/profiles/:profileId/progress", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const profileId = parseInt(String((req.params as Record<string, string>).profileId));
  const { pathwayId, levelId, notes } = req.body;

  if (!pathwayId) { { res.status(400).json({ error: "pathwayId is required" }); return; } }

  const [profile] = await db.select({ id: juniorProfilesTable.id })
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, profileId), eq(juniorProfilesTable.organizationId, orgId)));
  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }

  // Verify the pathway belongs to this org
  const [pathway] = await db.select({ id: developmentPathwaysTable.id })
    .from(developmentPathwaysTable)
    .where(and(eq(developmentPathwaysTable.id, pathwayId), eq(developmentPathwaysTable.organizationId, orgId)));
  if (!pathway) { { res.status(404).json({ error: "Pathway not found" }); return; } }

  const existing = await db.select().from(juniorPathwayProgressTable)
    .where(and(
      eq(juniorPathwayProgressTable.juniorProfileId, profileId),
      eq(juniorPathwayProgressTable.pathwayId, pathwayId),
    ));

  if (existing.length > 0) {
    const [updated] = await db.update(juniorPathwayProgressTable)
      .set({
        currentLevelId: levelId ?? null,
        lastProgressedAt: new Date(),
        notes: notes ?? existing[0].notes,
      })
      .where(eq(juniorPathwayProgressTable.id, existing[0].id))
      .returning();
    return void res.json(updated);
  }

  const [progress] = await db.insert(juniorPathwayProgressTable).values({
    juniorProfileId: profileId,
    pathwayId,
    currentLevelId: levelId ?? null,
    notes: notes ?? null,
  }).returning();

  if (levelId) {
    const [lvl] = await db.select({ level: pathwayLevelsTable.level })
      .from(pathwayLevelsTable)
      .where(and(eq(pathwayLevelsTable.id, levelId), eq(pathwayLevelsTable.pathwayId, pathwayId)));
    if (lvl) {
      await db.update(juniorProfilesTable)
        .set({ pathwayLevel: lvl.level, updatedAt: new Date() })
        .where(eq(juniorProfilesTable.id, profileId));
    }
  }

  res.status(201).json(progress);
});

// ─── PROGRAMS ─────────────────────────────────────────────────────────────────

// GET /junior/programs
router.get("/programs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programs = await db.select().from(juniorProgramsTable)
    .where(eq(juniorProgramsTable.organizationId, orgId))
    .orderBy(desc(juniorProgramsTable.startDate));

  const programIds = programs.map(p => p.id);

  if (programIds.length === 0) {
    return void res.json([]);
  }

  const participantCounts = await db
    .select({ programId: programParticipantsTable.programId, cnt: count() })
    .from(programParticipantsTable)
    .where(inArray(programParticipantsTable.programId, programIds))
    .groupBy(programParticipantsTable.programId);

  const countMap = new Map(participantCounts.map(p => [p.programId, Number(p.cnt)]));

  res.json(programs.map(p => ({ ...p, participantCount: countMap.get(p.id) ?? 0 })));
});

// POST /junior/programs
router.post("/programs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, startDate, endDate, maxParticipants, ageCategories } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [program] = await db.insert(juniorProgramsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    maxParticipants: maxParticipants ?? null,
    ageCategories: ageCategories ?? [],
  }).returning();

  res.status(201).json(program);
});

// GET /junior/programs/:programId
router.get("/programs/:programId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));

  const [program] = await db.select().from(juniorProgramsTable)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)));
  if (!program) { { res.status(404).json({ error: "Program not found" }); return; } }

  const [sessions, participants] = await Promise.all([
    db.select().from(programSessionsTable)
      .where(eq(programSessionsTable.programId, programId))
      .orderBy(asc(programSessionsTable.scheduledAt)),
    db
      .select({
        id: programParticipantsTable.id,
        juniorProfileId: programParticipantsTable.juniorProfileId,
        enrolledAt: programParticipantsTable.enrolledAt,
        notes: programParticipantsTable.notes,
        firstName: juniorProfilesTable.firstName,
        lastName: juniorProfilesTable.lastName,
        ageCategory: juniorProfilesTable.ageCategory,
        pathwayLevel: juniorProfilesTable.pathwayLevel,
        handicapIndex: juniorProfilesTable.handicapIndex,
      })
      .from(programParticipantsTable)
      .innerJoin(juniorProfilesTable, eq(programParticipantsTable.juniorProfileId, juniorProfilesTable.id))
      .where(eq(programParticipantsTable.programId, programId))
      .orderBy(asc(juniorProfilesTable.lastName)),
  ]);

  res.json({ ...program, sessions, participants });
});

// PUT /junior/programs/:programId
router.put("/programs/:programId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const { name, description, startDate, endDate, maxParticipants, ageCategories, isActive } = req.body;

  const updateData: Partial<typeof juniorProgramsTable.$inferInsert> = { updatedAt: new Date() };
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
  if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;
  if (maxParticipants !== undefined) updateData.maxParticipants = maxParticipants;
  if (ageCategories !== undefined) updateData.ageCategories = ageCategories;
  if (isActive !== undefined) updateData.isActive = isActive;

  const [updated] = await db.update(juniorProgramsTable)
    .set(updateData)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Program not found" }); return; } }
  res.json(updated);
});

// DELETE /junior/programs/:programId
router.delete("/programs/:programId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));

  const [deleted] = await db.delete(juniorProgramsTable)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)))
    .returning({ id: juniorProgramsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Program not found" }); return; } }
  res.json({ ok: true });
});

// POST /junior/programs/:programId/participants
router.post("/programs/:programId/participants", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const { juniorProfileId, notes } = req.body;

  if (!juniorProfileId) { { res.status(400).json({ error: "juniorProfileId is required" }); return; } }

  const [program] = await db.select({ id: juniorProgramsTable.id, maxParticipants: juniorProgramsTable.maxParticipants })
    .from(juniorProgramsTable)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)));
  if (!program) { { res.status(404).json({ error: "Program not found" }); return; } }

  // Verify the junior profile also belongs to this org
  const [juniorProfile] = await db.select({ id: juniorProfilesTable.id })
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, juniorProfileId), eq(juniorProfilesTable.organizationId, orgId)));
  if (!juniorProfile) { { res.status(404).json({ error: "Junior profile not found in this organization" }); return; } }

  if (program.maxParticipants) {
    const [{ cnt }] = await db
      .select({ cnt: count() })
      .from(programParticipantsTable)
      .where(eq(programParticipantsTable.programId, programId));
    if (Number(cnt) >= program.maxParticipants) {
      res.status(409).json({ error: "Program is at maximum capacity" });
      return;
    }
  }

  const [participant] = await db.insert(programParticipantsTable).values({
    programId,
    juniorProfileId,
    notes: notes ?? null,
  }).returning();

  res.status(201).json(participant);
});

// DELETE /junior/programs/:programId/participants/:participantId
router.delete("/programs/:programId/participants/:participantId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const participantId = parseInt(String((req.params as Record<string, string>).participantId));

  // Verify the program belongs to this org
  const [program] = await db.select({ id: juniorProgramsTable.id })
    .from(juniorProgramsTable)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)));
  if (!program) { { res.status(404).json({ error: "Program not found" }); return; } }

  const [deleted] = await db.delete(programParticipantsTable)
    .where(and(eq(programParticipantsTable.id, participantId), eq(programParticipantsTable.programId, programId)))
    .returning({ id: programParticipantsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Participant not found" }); return; } }
  res.json({ ok: true });
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────────

// POST /junior/programs/:programId/sessions
router.post("/programs/:programId/sessions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const { title, description, scheduledAt, durationMinutes, location, coachName, notes } = req.body;

  if (!title || !scheduledAt) { { res.status(400).json({ error: "title and scheduledAt are required" }); return; } }

  const [program] = await db.select({ id: juniorProgramsTable.id })
    .from(juniorProgramsTable)
    .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)));
  if (!program) { { res.status(404).json({ error: "Program not found" }); return; } }

  const [session] = await db.insert(programSessionsTable).values({
    programId,
    title,
    description: description ?? null,
    scheduledAt: new Date(scheduledAt),
    durationMinutes: durationMinutes ?? 60,
    location: location ?? null,
    coachName: coachName ?? null,
    notes: notes ?? null,
  }).returning();

  res.status(201).json(session);
});

// PUT /junior/programs/:programId/sessions/:sessionId
router.put("/programs/:programId/sessions/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  const orgSession = await getOrgSession(sessionId, programId, orgId);
  if (!orgSession) { { res.status(404).json({ error: "Session not found" }); return; } }

  const { title, description, scheduledAt, durationMinutes, location, coachName, notes } = req.body;

  const updateData: Partial<typeof programSessionsTable.$inferInsert> = { updatedAt: new Date() };
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (scheduledAt !== undefined) updateData.scheduledAt = new Date(scheduledAt);
  if (durationMinutes !== undefined) updateData.durationMinutes = durationMinutes;
  if (location !== undefined) updateData.location = location;
  if (coachName !== undefined) updateData.coachName = coachName;
  if (notes !== undefined) updateData.notes = notes;

  const [updated] = await db.update(programSessionsTable)
    .set(updateData)
    .where(eq(programSessionsTable.id, sessionId))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Session not found" }); return; } }
  res.json(updated);
});

// DELETE /junior/programs/:programId/sessions/:sessionId
router.delete("/programs/:programId/sessions/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  const orgSession = await getOrgSession(sessionId, programId, orgId);
  if (!orgSession) { { res.status(404).json({ error: "Session not found" }); return; } }

  const [deleted] = await db.delete(programSessionsTable)
    .where(eq(programSessionsTable.id, sessionId))
    .returning({ id: programSessionsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Session not found" }); return; } }
  res.json({ ok: true });
});

// POST /junior/programs/:programId/sessions/:sessionId/attendance
router.post("/programs/:programId/sessions/:sessionId/attendance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  const orgSession = await getOrgSession(sessionId, programId, orgId);
  if (!orgSession) { { res.status(404).json({ error: "Session not found" }); return; } }

  const attendanceRecords: { juniorProfileId: number; attended: boolean; notes?: string }[] = req.body;

  if (!Array.isArray(attendanceRecords) || attendanceRecords.length === 0) {
    res.status(400).json({ error: "Provide an array of attendance records" });
    return;
  }

  const results = await Promise.all(
    attendanceRecords.map(record =>
      db.insert(programAttendanceTable)
        .values({
          sessionId,
          juniorProfileId: record.juniorProfileId,
          attended: record.attended,
          notes: record.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [programAttendanceTable.sessionId, programAttendanceTable.juniorProfileId],
          set: {
            attended: record.attended,
            notes: record.notes ?? null,
            markedAt: new Date(),
          },
        })
        .returning(),
    ),
  );

  res.json(results.flat());
});

// GET /junior/programs/:programId/sessions/:sessionId/attendance
router.get("/programs/:programId/sessions/:sessionId/attendance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const programId = parseInt(String((req.params as Record<string, string>).programId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  // Verify session belongs to org's program
  const orgSession = await getOrgSession(sessionId, programId, orgId);
  if (!orgSession) { { res.status(404).json({ error: "Session not found" }); return; } }

  const attendance = await db
    .select({
      id: programAttendanceTable.id,
      juniorProfileId: programAttendanceTable.juniorProfileId,
      attended: programAttendanceTable.attended,
      notes: programAttendanceTable.notes,
      markedAt: programAttendanceTable.markedAt,
      firstName: juniorProfilesTable.firstName,
      lastName: juniorProfilesTable.lastName,
      ageCategory: juniorProfilesTable.ageCategory,
    })
    .from(programAttendanceTable)
    .innerJoin(juniorProfilesTable, eq(programAttendanceTable.juniorProfileId, juniorProfilesTable.id))
    .where(eq(programAttendanceTable.sessionId, sessionId))
    .orderBy(asc(juniorProfilesTable.lastName));

  res.json(attendance);
});

// ─── AWARDS ───────────────────────────────────────────────────────────────────

// GET /junior/awards
router.get("/awards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { ageCategory, programId } = req.query as Record<string, string>;

  const conditions = [eq(juniorAwardsTable.organizationId, orgId)];
  if (ageCategory) {
    if (!isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
    conditions.push(eq(juniorAwardsTable.ageCategory, ageCategory as never));
  }
  if (programId) conditions.push(eq(juniorAwardsTable.programId, parseInt(programId)));

  const awards = await db
    .select({
      id: juniorAwardsTable.id,
      awardType: juniorAwardsTable.awardType,
      ageCategory: juniorAwardsTable.ageCategory,
      awardLabel: juniorAwardsTable.awardLabel,
      description: juniorAwardsTable.description,
      awardedAt: juniorAwardsTable.awardedAt,
      programId: juniorAwardsTable.programId,
      juniorProfileId: juniorAwardsTable.juniorProfileId,
      firstName: juniorProfilesTable.firstName,
      lastName: juniorProfilesTable.lastName,
    })
    .from(juniorAwardsTable)
    .innerJoin(juniorProfilesTable, eq(juniorAwardsTable.juniorProfileId, juniorProfilesTable.id))
    .where(and(...conditions))
    .orderBy(desc(juniorAwardsTable.awardedAt));

  res.json(awards);
});

// POST /junior/awards
router.post("/awards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const user = getAuthUser(req);
  const { juniorProfileId, awardType, ageCategory, awardLabel, description, programId, awardedAt } = req.body;

  if (!juniorProfileId || !awardType || !awardLabel) {
    res.status(400).json({ error: "juniorProfileId, awardType, and awardLabel are required" });
    return;
  }
  if (!isValidAwardType(awardType)) { { res.status(400).json({ error: "Invalid awardType" }); return; } }
  if (ageCategory && !isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }

  // Verify the junior profile belongs to this org
  const [juniorProfile] = await db.select({ id: juniorProfilesTable.id })
    .from(juniorProfilesTable)
    .where(and(eq(juniorProfilesTable.id, juniorProfileId), eq(juniorProfilesTable.organizationId, orgId)));
  if (!juniorProfile) { { res.status(404).json({ error: "Junior profile not found in this organization" }); return; } }

  // If programId provided, verify it belongs to this org
  if (programId) {
    const [prog] = await db.select({ id: juniorProgramsTable.id })
      .from(juniorProgramsTable)
      .where(and(eq(juniorProgramsTable.id, programId), eq(juniorProgramsTable.organizationId, orgId)));
    if (!prog) { { res.status(404).json({ error: "Program not found in this organization" }); return; } }
  }

  const [award] = await db.insert(juniorAwardsTable).values({
    organizationId: orgId,
    juniorProfileId,
    awardType,
    ageCategory: ageCategory ?? null,
    awardLabel,
    description: description ?? null,
    programId: programId ?? null,
    awardedAt: awardedAt ? new Date(awardedAt) : new Date(),
    awardedByUserId: user?.id ?? null,
  }).returning();

  res.status(201).json(award);
});

// DELETE /junior/awards/:awardId
router.delete("/awards/:awardId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const awardId = parseInt(String((req.params as Record<string, string>).awardId));

  const [deleted] = await db.delete(juniorAwardsTable)
    .where(and(eq(juniorAwardsTable.id, awardId), eq(juniorAwardsTable.organizationId, orgId)))
    .returning({ id: juniorAwardsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Award not found" }); return; } }
  res.json({ ok: true });
});

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────

/**
 * GET /junior/leaderboard?ageCategory=under_12&limit=20
 *
 * Aggregates tournament play data to build an age-group leaderboard.
 * bestGross = best (lowest) 18-hole round total across all tournaments in this org.
 * avgGross  = average round total across all rounds.
 * Juniors without a linked user account show with null scoring stats.
 */
router.get("/leaderboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { ageCategory } = req.query as Record<string, string>;
  if (ageCategory && !isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const profileConditions = [eq(juniorProfilesTable.organizationId, orgId), eq(juniorProfilesTable.isActive, true)];
  if (ageCategory) profileConditions.push(eq(juniorProfilesTable.ageCategory, ageCategory as never));

  const profiles = await db.select({
    id: juniorProfilesTable.id,
    firstName: juniorProfilesTable.firstName,
    lastName: juniorProfilesTable.lastName,
    ageCategory: juniorProfilesTable.ageCategory,
    pathwayLevel: juniorProfilesTable.pathwayLevel,
    handicapIndex: juniorProfilesTable.handicapIndex,
    userId: juniorProfilesTable.userId,
  })
    .from(juniorProfilesTable)
    .where(and(...profileConditions));

  if (profiles.length === 0) {
    return void res.json([]);
  }

  const userIds = profiles.map(p => p.userId).filter((id): id is number => id !== null);

  if (userIds.length === 0) {
    return void res.json(profiles.map(p => ({
      juniorProfileId: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      ageCategory: p.ageCategory,
      pathwayLevel: p.pathwayLevel,
      handicapIndex: p.handicapIndex,
      roundsPlayed: 0,
      avgGross: null,
      bestGross: null,
    })));
  }

  // Compute per-round totals first, then aggregate.
  // A "round" is identified by (playerId, round). We sum strokes per round,
  // then take the minimum round total (bestGross) and average round total (avgGross).
  const roundTotals = db
    .select({
      userId: playersTable.userId,
      roundTotal: sql<number>`SUM(${scoresTable.strokes})`.as("round_total"),
    })
    .from(scoresTable)
    .innerJoin(playersTable, eq(scoresTable.playerId, playersTable.id))
    .innerJoin(tournamentsTable, and(
      eq(playersTable.tournamentId, tournamentsTable.id),
      eq(tournamentsTable.organizationId, orgId),
    ))
    .where(inArray(playersTable.userId, userIds))
    .groupBy(playersTable.userId, scoresTable.playerId, scoresTable.round)
    .as("round_totals");

  const scoringData = await db
    .select({
      userId: roundTotals.userId,
      roundCount: sql<number>`COUNT(*)`.as("round_count"),
      bestGross: min(roundTotals.roundTotal),
      avgGrossRaw: avg(roundTotals.roundTotal),
    })
    .from(roundTotals)
    .groupBy(roundTotals.userId);

  const scoringMap = new Map(scoringData.map(s => [s.userId, s]));

  const leaderboard = profiles.map(p => {
    const scoring = p.userId ? scoringMap.get(p.userId) : undefined;
    return {
      juniorProfileId: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      ageCategory: p.ageCategory,
      pathwayLevel: p.pathwayLevel,
      handicapIndex: p.handicapIndex,
      roundsPlayed: scoring ? Number(scoring.roundCount) : 0,
      avgGross: scoring && Number(scoring.roundCount) > 0
        ? Math.round(Number(scoring.avgGrossRaw) * 10) / 10
        : null,
      bestGross: scoring ? Number(scoring.bestGross) : null,
    };
  });

  leaderboard.sort((a, b) => {
    if (a.handicapIndex !== null && b.handicapIndex !== null) {
      return Number(a.handicapIndex) - Number(b.handicapIndex);
    }
    if (a.handicapIndex !== null) return -1;
    if (b.handicapIndex !== null) return 1;
    return a.lastName.localeCompare(b.lastName);
  });

  res.json(leaderboard.slice(0, limit));
});

// ─── PORTAL ENDPOINTS (parent/junior access) ─────────────────────────────────

// GET /junior/portal/my-juniors — juniors linked to the current portal user
router.get("/portal/my-juniors", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const guardianJuniorIds = await db
    .select({ juniorProfileId: guardianLinksTable.juniorProfileId })
    .from(guardianLinksTable)
    .where(eq(guardianLinksTable.guardianUserId, user.id));

  const guardianIds = guardianJuniorIds.map(g => g.juniorProfileId);

  const [ownProfiles, guardianProfiles] = await Promise.all([
    db.select().from(juniorProfilesTable).where(and(
      eq(juniorProfilesTable.organizationId, orgId),
      eq(juniorProfilesTable.userId, user.id),
      eq(juniorProfilesTable.isActive, true),
    )),
    guardianIds.length > 0
      ? db.select().from(juniorProfilesTable)
        .where(and(
          eq(juniorProfilesTable.organizationId, orgId),
          inArray(juniorProfilesTable.id, guardianIds),
          eq(juniorProfilesTable.isActive, true),
        ))
      : Promise.resolve([]),
  ]);

  const seen = new Set<number>();
  const allProfiles = [...ownProfiles, ...guardianProfiles].filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const profileIds = allProfiles.map(p => p.id);

  type ProgressRow = { juniorProfileId: number; pathwayId: number; pathwayName: string; currentLevelId: number | null; currentLevelName: string | null; lastProgressedAt: Date | null };
  type UpcomingRow = { juniorProfileId: number; sessionId: number; sessionTitle: string; scheduledAt: Date; durationMinutes: number; location: string | null; coachName: string | null; programName: string };
  type AwardRow = typeof juniorAwardsTable.$inferSelect;

  let progress: ProgressRow[] = [];
  let upcoming: UpcomingRow[] = [];
  let awards: AwardRow[] = [];

  if (profileIds.length > 0) {
    [progress, upcoming, awards] = await Promise.all([
      db
        .select({
          juniorProfileId: juniorPathwayProgressTable.juniorProfileId,
          pathwayId: juniorPathwayProgressTable.pathwayId,
          pathwayName: developmentPathwaysTable.name,
          currentLevelId: juniorPathwayProgressTable.currentLevelId,
          currentLevelName: pathwayLevelsTable.name,
          lastProgressedAt: juniorPathwayProgressTable.lastProgressedAt,
        })
        .from(juniorPathwayProgressTable)
        .innerJoin(developmentPathwaysTable, eq(juniorPathwayProgressTable.pathwayId, developmentPathwaysTable.id))
        .leftJoin(pathwayLevelsTable, eq(juniorPathwayProgressTable.currentLevelId, pathwayLevelsTable.id))
        .where(inArray(juniorPathwayProgressTable.juniorProfileId, profileIds)),
      db
        .select({
          juniorProfileId: programParticipantsTable.juniorProfileId,
          sessionId: programSessionsTable.id,
          sessionTitle: programSessionsTable.title,
          scheduledAt: programSessionsTable.scheduledAt,
          durationMinutes: programSessionsTable.durationMinutes,
          location: programSessionsTable.location,
          coachName: programSessionsTable.coachName,
          programName: juniorProgramsTable.name,
        })
        .from(programParticipantsTable)
        .innerJoin(programSessionsTable, eq(programParticipantsTable.programId, programSessionsTable.programId))
        .innerJoin(juniorProgramsTable, and(
          eq(programParticipantsTable.programId, juniorProgramsTable.id),
          eq(juniorProgramsTable.organizationId, orgId),
        ))
        .where(and(
          inArray(programParticipantsTable.juniorProfileId, profileIds),
          sql`${programSessionsTable.scheduledAt} >= NOW()`,
        ))
        .orderBy(asc(programSessionsTable.scheduledAt))
        .limit(20),
      db.select().from(juniorAwardsTable)
        .where(and(
          inArray(juniorAwardsTable.juniorProfileId, profileIds),
          eq(juniorAwardsTable.organizationId, orgId),
        ))
        .orderBy(desc(juniorAwardsTable.awardedAt)),
    ]);
  }

  const progressMap: Record<number, ProgressRow[]> = {};
  for (const p of progress) (progressMap[p.juniorProfileId] ??= []).push(p);
  const upcomingMap: Record<number, UpcomingRow[]> = {};
  for (const s of upcoming) (upcomingMap[s.juniorProfileId] ??= []).push(s);
  const awardsMap: Record<number, AwardRow[]> = {};
  for (const a of awards) (awardsMap[a.juniorProfileId] ??= []).push(a);

  res.json(allProfiles.map(p => ({
    ...p,
    progress: progressMap[p.id] ?? [],
    upcomingSessions: upcomingMap[p.id] ?? [],
    awards: awardsMap[p.id] ?? [],
  })));
});

// GET /junior/portal/leaderboard?ageCategory=under_12
router.get("/portal/leaderboard", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { ageCategory } = req.query as Record<string, string>;
  if (ageCategory && !isValidAgeCategory(ageCategory)) { { res.status(400).json({ error: "Invalid ageCategory" }); return; } }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const profileConditions = [eq(juniorProfilesTable.organizationId, orgId), eq(juniorProfilesTable.isActive, true)];
  if (ageCategory) profileConditions.push(eq(juniorProfilesTable.ageCategory, ageCategory as never));

  const profiles = await db.select({
    id: juniorProfilesTable.id,
    firstName: juniorProfilesTable.firstName,
    lastName: juniorProfilesTable.lastName,
    ageCategory: juniorProfilesTable.ageCategory,
    pathwayLevel: juniorProfilesTable.pathwayLevel,
    handicapIndex: juniorProfilesTable.handicapIndex,
    userId: juniorProfilesTable.userId,
  })
    .from(juniorProfilesTable)
    .where(and(...profileConditions));

  const userIds = profiles.map(p => p.userId).filter((id): id is number => id !== null);

  let scoringMap: Map<number, { roundCount: number; avgGrossRaw: string | null; bestGross: string | null }> = new Map();

  if (userIds.length > 0) {
    const roundTotals = db
      .select({
        userId: playersTable.userId,
        roundTotal: sql<number>`SUM(${scoresTable.strokes})`.as("round_total"),
      })
      .from(scoresTable)
      .innerJoin(playersTable, eq(scoresTable.playerId, playersTable.id))
      .innerJoin(tournamentsTable, and(
        eq(playersTable.tournamentId, tournamentsTable.id),
        eq(tournamentsTable.organizationId, orgId),
      ))
      .where(inArray(playersTable.userId, userIds))
      .groupBy(playersTable.userId, scoresTable.playerId, scoresTable.round)
      .as("round_totals");

    const scoringData = await db
      .select({
        userId: roundTotals.userId,
        roundCount: sql<number>`COUNT(*)`.as("round_count"),
        bestGross: min(roundTotals.roundTotal),
        avgGrossRaw: avg(roundTotals.roundTotal),
      })
      .from(roundTotals)
      .groupBy(roundTotals.userId);

    scoringMap = new Map(scoringData.map(s => [
      s.userId as number,
      { roundCount: Number(s.roundCount), avgGrossRaw: String(s.avgGrossRaw), bestGross: String(s.bestGross) },
    ]));
  }

  const leaderboard = profiles.map(p => {
    const scoring = p.userId ? scoringMap.get(p.userId) : undefined;
    return {
      juniorProfileId: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      ageCategory: p.ageCategory,
      pathwayLevel: p.pathwayLevel,
      handicapIndex: p.handicapIndex,
      roundsPlayed: scoring ? scoring.roundCount : 0,
      avgGross: scoring && scoring.roundCount > 0
        ? Math.round(Number(scoring.avgGrossRaw) * 10) / 10
        : null,
      bestGross: scoring ? Number(scoring.bestGross) : null,
    };
  });

  leaderboard.sort((a, b) => {
    if (a.handicapIndex !== null && b.handicapIndex !== null) {
      return Number(a.handicapIndex) - Number(b.handicapIndex);
    }
    if (a.handicapIndex !== null) return -1;
    if (b.handicapIndex !== null) return 1;
    return a.lastName.localeCompare(b.lastName);
  });

  res.json(leaderboard.slice(0, limit));
});

export default router;
