/**
 * Member Feedback & Survey Tools API — Task #117
 * Base: /organizations/:orgId/surveys
 *
 * Survey Builder (admin)
 * GET    /                            List surveys
 * POST   /                            Create survey
 * GET    /:surveyId                   Get survey detail + questions
 * PATCH  /:surveyId                   Update survey metadata
 * DELETE /:surveyId                   Delete survey (draft only)
 * POST   /:surveyId/publish           Publish survey (draft→active)
 * POST   /:surveyId/close             Close survey (active→closed)
 *
 * Questions (admin)
 * GET    /:surveyId/questions         List questions
 * POST   /:surveyId/questions         Add question
 * PATCH  /:surveyId/questions/:qId   Update question
 * DELETE /:surveyId/questions/:qId   Delete question
 * POST   /:surveyId/questions/reorder Reorder questions
 *
 * Survey delivery (admin)
 * POST   /:surveyId/send              Send survey to member segment
 *
 * Member response (portal player)
 * GET    /active                      List active surveys for current member
 * GET    /respond/:surveyId           Get survey for responding
 * POST   /respond/:surveyId           Submit response
 *
 * Results dashboard (admin)
 * GET    /:surveyId/results           Aggregated results + individual responses
 * GET    /:surveyId/results/export    CSV export
 * GET    /nps-trend                   NPS trend over time
 * GET    /:surveyId/response-rate     Response rate (who has/hasn't responded)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  surveysTable,
  surveyQuestionsTable,
  surveyResponsesTable,
  surveyResponseItemsTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
} from "@workspace/db";
import { eq, and, desc, asc, sql, inArray, count as drizzleCount, avg } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser {
  id: number;
  role?: string;
  organizationId?: number | null;
  displayName?: string;
  email?: string;
}

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

function parseOrgId(req: Request): number {
  return parseInt(String((req.params as Record<string, string>).orgId));
}

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  const user = getUser(req);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director" || user.role === "committee_member") &&
    Number(user.organizationId) === orgId
  ) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "committee_member"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

function isOrgMember(user: SessionUser, orgId: number): boolean {
  return Number(user.organizationId) === orgId;
}

// ─── SURVEY LIST & CRUD ───────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status } = req.query;
  const conditions = [eq(surveysTable.organizationId, orgId)];
  if (status) conditions.push(eq(surveysTable.status, String(status) as "draft" | "active" | "closed"));

  const surveys = await db.select({
    id: surveysTable.id,
    title: surveysTable.title,
    description: surveysTable.description,
    status: surveysTable.status,
    trigger: surveysTable.trigger,
    isAnonymous: surveysTable.isAnonymous,
    targetSegment: surveysTable.targetSegment,
    publishedAt: surveysTable.publishedAt,
    closedAt: surveysTable.closedAt,
    createdAt: surveysTable.createdAt,
    updatedAt: surveysTable.updatedAt,
    responseCount: sql<number>`(
      SELECT count(*)::int FROM survey_responses sr WHERE sr.survey_id = ${surveysTable.id}
    )`,
    questionCount: sql<number>`(
      SELECT count(*)::int FROM survey_questions sq WHERE sq.survey_id = ${surveysTable.id}
    )`,
  })
    .from(surveysTable)
    .where(and(...conditions))
    .orderBy(desc(surveysTable.createdAt));

  res.json({ surveys });
});

router.post("/", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const user = getUser(req)!;

  const { title, description, trigger, isAnonymous, targetSegment } = req.body;
  if (!title) { { res.status(400).json({ error: "title is required" }); return; } }

  const [survey] = await db.insert(surveysTable).values({
    organizationId: orgId,
    title,
    description: description ?? null,
    trigger: trigger ?? "manual",
    isAnonymous: isAnonymous ?? false,
    targetSegment: targetSegment ?? null,
    createdByUserId: user.id,
  }).returning();

  res.status(201).json({ survey });
});

router.get("/:surveyId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));

  const user = getUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const [survey] = await db.select().from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));

  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder), asc(surveyQuestionsTable.id));

  res.json({ survey, questions });
});

router.patch("/:surveyId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [existing] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (existing.status === "closed") { { res.status(400).json({ error: "Cannot edit a closed survey" }); return; } }

  const allowed = ["title", "description", "trigger", "isAnonymous", "targetSegment"] as const;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const [survey] = await db.update(surveysTable).set(updates)
    .where(eq(surveysTable.id, surveyId)).returning();
  res.json({ survey });
});

router.delete("/:surveyId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [existing] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (existing.status !== "draft") { { res.status(400).json({ error: "Only draft surveys can be deleted" }); return; } }

  await db.delete(surveysTable).where(eq(surveysTable.id, surveyId));
  res.json({ ok: true });
});

// ─── LIFECYCLE ────────────────────────────────────────────────────────────────

router.post("/:surveyId/publish", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [existing] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (existing.status !== "draft") { { res.status(400).json({ error: "Only draft surveys can be published" }); return; } }

  const qCount = await db.select({ c: drizzleCount() }).from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId));
  if (!qCount[0] || qCount[0].c === 0) {
    res.status(400).json({ error: "Survey must have at least one question before publishing" }); return;
  }

  const [survey] = await db.update(surveysTable)
    .set({ status: "active", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(surveysTable.id, surveyId))
    .returning();
  res.json({ survey });
});

router.post("/:surveyId/close", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [existing] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (existing.status !== "active") { { res.status(400).json({ error: "Only active surveys can be closed" }); return; } }

  const [survey] = await db.update(surveysTable)
    .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
    .where(eq(surveysTable.id, surveyId))
    .returning();
  res.json({ survey });
});

// ─── QUESTIONS ────────────────────────────────────────────────────────────────

router.get("/:surveyId/questions", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select({ id: surveysTable.id })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder), asc(surveyQuestionsTable.id));

  res.json({ questions });
});

router.post("/:surveyId/questions", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (survey.status === "closed") { { res.status(400).json({ error: "Cannot add questions to a closed survey" }); return; } }

  const { type, questionText, isRequired, sortOrder, options, ratingMin, ratingMax } = req.body;
  if (!type || !questionText) { { res.status(400).json({ error: "type and questionText are required" }); return; } }

  const validTypes = ["rating", "multiple_choice", "free_text", "nps"];
  if (!validTypes.includes(type)) { { res.status(400).json({ error: "Invalid question type" }); return; } }

  const [question] = await db.insert(surveyQuestionsTable).values({
    surveyId,
    type,
    questionText,
    isRequired: isRequired !== false,
    sortOrder: sortOrder ?? 0,
    options: options ?? [],
    ratingMin: ratingMin ?? 1,
    ratingMax: ratingMax ?? 5,
  }).returning();

  res.status(201).json({ question });
});

router.patch("/:surveyId/questions/:qId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const qId = parseInt(String((req.params as Record<string, string>).qId));

  const [survey] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (survey.status === "closed") { { res.status(400).json({ error: "Cannot edit questions of a closed survey" }); return; } }

  const [existing] = await db.select({ id: surveyQuestionsTable.id })
    .from(surveyQuestionsTable)
    .where(and(eq(surveyQuestionsTable.id, qId), eq(surveyQuestionsTable.surveyId, surveyId)));
  if (!existing) { { res.status(404).json({ error: "Question not found" }); return; } }

  const allowed = ["type", "questionText", "isRequired", "sortOrder", "options", "ratingMin", "ratingMax"] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const [question] = await db.update(surveyQuestionsTable).set(updates)
    .where(eq(surveyQuestionsTable.id, qId)).returning();
  res.json({ question });
});

router.delete("/:surveyId/questions/:qId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const qId = parseInt(String((req.params as Record<string, string>).qId));

  const [survey] = await db.select({ id: surveysTable.id, status: surveysTable.status })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (survey.status === "closed") { { res.status(400).json({ error: "Cannot delete questions from a closed survey" }); return; } }

  await db.delete(surveyQuestionsTable)
    .where(and(eq(surveyQuestionsTable.id, qId), eq(surveyQuestionsTable.surveyId, surveyId)));
  res.json({ ok: true });
});

router.post("/:surveyId/questions/reorder", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select({ id: surveysTable.id })
    .from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const { order } = req.body;
  if (!Array.isArray(order)) { { res.status(400).json({ error: "order must be an array of question IDs" }); return; } }

  await Promise.all(
    order.map((qId: number, idx: number) =>
      db.update(surveyQuestionsTable)
        .set({ sortOrder: idx })
        .where(and(eq(surveyQuestionsTable.id, qId), eq(surveyQuestionsTable.surveyId, surveyId)))
    )
  );

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder));
  res.json({ questions });
});

// ─── SURVEY DELIVERY ──────────────────────────────────────────────────────────

router.post("/:surveyId/send", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select().from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }
  if (survey.status !== "active") { { res.status(400).json({ error: "Only active surveys can be sent" }); return; } }

  const { memberIds } = req.body;
  let targetCount = 0;

  if (Array.isArray(memberIds) && memberIds.length > 0) {
    targetCount = memberIds.length;
  } else {
    const members = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        eq(clubMembersTable.subscriptionStatus, "active"),
      ));
    targetCount = members.length;
  }

  res.json({ ok: true, sentTo: targetCount, message: `Survey sent to ${targetCount} member(s)` });
});

// ─── MEMBER RESPONSE (PORTAL) ─────────────────────────────────────────────────

router.get("/active", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = getUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const surveys = await db.select({
    id: surveysTable.id,
    title: surveysTable.title,
    description: surveysTable.description,
    trigger: surveysTable.trigger,
    isAnonymous: surveysTable.isAnonymous,
    publishedAt: surveysTable.publishedAt,
  })
    .from(surveysTable)
    .where(and(
      eq(surveysTable.organizationId, orgId),
      eq(surveysTable.status, "active"),
    ))
    .orderBy(desc(surveysTable.publishedAt));

  const surveysWithCompletion = await Promise.all(surveys.map(async (s) => {
    const [existing] = await db.select({ id: surveyResponsesTable.id })
      .from(surveyResponsesTable)
      .where(and(
        eq(surveyResponsesTable.surveyId, s.id),
        eq(surveyResponsesTable.respondentUserId, user.id),
      ))
      .limit(1);
    return { ...s, hasResponded: !!existing };
  }));

  res.json({ surveys: surveysWithCompletion });
});

router.get("/respond/:surveyId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const user = getUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const [survey] = await db.select().from(surveysTable)
    .where(and(
      eq(surveysTable.id, surveyId),
      eq(surveysTable.organizationId, orgId),
      eq(surveysTable.status, "active"),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found or not active" }); return; } }

  const [alreadyResponded] = await db.select({ id: surveyResponsesTable.id })
    .from(surveyResponsesTable)
    .where(and(
      eq(surveyResponsesTable.surveyId, surveyId),
      eq(surveyResponsesTable.respondentUserId, user.id),
    ))
    .limit(1);
  if (alreadyResponded) { { res.status(409).json({ error: "You have already responded to this survey" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder), asc(surveyQuestionsTable.id));

  res.json({ survey, questions });
});

router.post("/respond/:surveyId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const user = getUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const [survey] = await db.select().from(surveysTable)
    .where(and(
      eq(surveysTable.id, surveyId),
      eq(surveysTable.organizationId, orgId),
      eq(surveysTable.status, "active"),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found or not active" }); return; } }

  const [alreadyResponded] = await db.select({ id: surveyResponsesTable.id })
    .from(surveyResponsesTable)
    .where(and(
      eq(surveyResponsesTable.surveyId, surveyId),
      eq(surveyResponsesTable.respondentUserId, user.id),
    ))
    .limit(1);
  if (alreadyResponded) { { res.status(409).json({ error: "You have already responded to this survey" }); return; } }

  const { answers, isAnonymous } = req.body;
  if (!Array.isArray(answers)) { { res.status(400).json({ error: "answers must be an array" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId));

  const [response] = await db.insert(surveyResponsesTable).values({
    surveyId,
    organizationId: orgId,
    respondentUserId: isAnonymous || survey.isAnonymous ? null : user.id,
    respondentEmail: isAnonymous || survey.isAnonymous ? null : user.email,
    isAnonymous: Boolean(isAnonymous || survey.isAnonymous),
  }).returning();

  const itemsToInsert = answers.map((a: { questionId: number; ratingValue?: number; choiceValue?: string; textValue?: string; npsScore?: number }) => {
    const q = questions.find(q => q.id === a.questionId);
    if (!q) return null;
    return {
      responseId: response.id,
      questionId: a.questionId,
      ratingValue: a.ratingValue ?? null,
      choiceValue: a.choiceValue ?? null,
      textValue: a.textValue ?? null,
      npsScore: a.npsScore ?? null,
    };
  }).filter(Boolean) as {
    responseId: number;
    questionId: number;
    ratingValue: number | null;
    choiceValue: string | null;
    textValue: string | null;
    npsScore: number | null;
  }[];

  if (itemsToInsert.length > 0) {
    await db.insert(surveyResponseItemsTable).values(itemsToInsert);
  }

  res.status(201).json({ response, message: "Thank you for your feedback!" });
});

// ─── RESULTS DASHBOARD ────────────────────────────────────────────────────────

router.get("/:surveyId/results", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select().from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder));

  const responses = await db.select({
    id: surveyResponsesTable.id,
    respondentUserId: surveyResponsesTable.respondentUserId,
    respondentEmail: surveyResponsesTable.respondentEmail,
    isAnonymous: surveyResponsesTable.isAnonymous,
    completedAt: surveyResponsesTable.completedAt,
    respondentName: appUsersTable.displayName,
  })
    .from(surveyResponsesTable)
    .leftJoin(appUsersTable, eq(surveyResponsesTable.respondentUserId, appUsersTable.id))
    .where(eq(surveyResponsesTable.surveyId, surveyId))
    .orderBy(desc(surveyResponsesTable.completedAt));

  const responseIds = responses.map(r => r.id);
  const items = responseIds.length > 0
    ? await db.select().from(surveyResponseItemsTable)
      .where(inArray(surveyResponseItemsTable.responseId, responseIds))
    : [];

  const aggregated = questions.map(q => {
    const qItems = items.filter(i => i.questionId === q.id);
    if (q.type === "rating") {
      const vals = qItems.map(i => i.ratingValue).filter(v => v !== null) as number[];
      const avgVal = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      const distribution: Record<number, number> = {};
      for (let v = (q.ratingMin ?? 1); v <= (q.ratingMax ?? 5); v++) distribution[v] = 0;
      vals.forEach(v => { if (distribution[v] !== undefined) distribution[v]++; });
      return { questionId: q.id, type: q.type, questionText: q.questionText, responseCount: vals.length, average: avgVal ? Math.round(avgVal * 100) / 100 : null, distribution };
    }
    if (q.type === "nps") {
      const scores = qItems.map(i => i.npsScore).filter(v => v !== null) as number[];
      const promoters = scores.filter(s => s >= 9).length;
      const detractors = scores.filter(s => s <= 6).length;
      const nps = scores.length > 0 ? Math.round(((promoters - detractors) / scores.length) * 100) : null;
      return { questionId: q.id, type: q.type, questionText: q.questionText, responseCount: scores.length, nps, promoters, passives: scores.filter(s => s >= 7 && s <= 8).length, detractors };
    }
    if (q.type === "multiple_choice") {
      const choices: Record<string, number> = {};
      (q.options ?? []).forEach(o => { choices[o] = 0; });
      qItems.forEach(i => { if (i.choiceValue && choices[i.choiceValue] !== undefined) choices[i.choiceValue]++; });
      return { questionId: q.id, type: q.type, questionText: q.questionText, responseCount: qItems.length, choices };
    }
    const texts = qItems.map(i => i.textValue).filter(Boolean);
    return { questionId: q.id, type: q.type, questionText: q.questionText, responseCount: texts.length, texts };
  });

  const responsesWithItems = responses.map(r => ({
    ...r,
    respondentName: r.isAnonymous ? "Anonymous" : (r.respondentName ?? r.respondentEmail ?? "Unknown"),
    items: items.filter(i => i.responseId === r.id).map(i => {
      const q = questions.find(q => q.id === i.questionId);
      return { ...i, questionText: q?.questionText, questionType: q?.type };
    }),
  }));

  res.json({
    survey,
    totalResponses: responses.length,
    aggregated,
    responses: responsesWithItems,
  });
});

router.get("/:surveyId/results/export", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select().from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const questions = await db.select().from(surveyQuestionsTable)
    .where(eq(surveyQuestionsTable.surveyId, surveyId))
    .orderBy(asc(surveyQuestionsTable.sortOrder));

  const responses = await db.select({
    id: surveyResponsesTable.id,
    respondentUserId: surveyResponsesTable.respondentUserId,
    respondentEmail: surveyResponsesTable.respondentEmail,
    isAnonymous: surveyResponsesTable.isAnonymous,
    completedAt: surveyResponsesTable.completedAt,
    respondentName: appUsersTable.displayName,
  })
    .from(surveyResponsesTable)
    .leftJoin(appUsersTable, eq(surveyResponsesTable.respondentUserId, appUsersTable.id))
    .where(eq(surveyResponsesTable.surveyId, surveyId))
    .orderBy(asc(surveyResponsesTable.completedAt));

  const responseIds = responses.map(r => r.id);
  const items = responseIds.length > 0
    ? await db.select().from(surveyResponseItemsTable)
      .where(inArray(surveyResponseItemsTable.responseId, responseIds))
    : [];

  const headers = ["Response ID", "Respondent", "Email", "Completed At", ...questions.map(q => `Q${q.sortOrder + 1}: ${q.questionText}`)];
  const csvRows = [headers.join(",")];

  for (const r of responses) {
    const name = r.isAnonymous ? "Anonymous" : (r.respondentName ?? "");
    const email = r.isAnonymous ? "" : (r.respondentEmail ?? "");
    const row: string[] = [String(r.id), `"${name}"`, `"${email}"`, r.completedAt.toISOString()];
    for (const q of questions) {
      const item = items.find(i => i.responseId === r.id && i.questionId === q.id);
      let val = "";
      if (item) {
        if (q.type === "rating" && item.ratingValue !== null) val = String(item.ratingValue);
        else if (q.type === "nps" && item.npsScore !== null) val = String(item.npsScore);
        else if (q.type === "multiple_choice") val = item.choiceValue ?? "";
        else val = (item.textValue ?? "").replace(/"/g, '""');
      }
      row.push(`"${val}"`);
    }
    csvRows.push(row.join(","));
  }

  const csv = csvRows.join("\n");
  const filename = `survey-${surveyId}-results.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

router.get("/nps-trend", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db.select({
    surveyId: surveysTable.id,
    surveyTitle: surveysTable.title,
    closedAt: surveysTable.closedAt,
    publishedAt: surveysTable.publishedAt,
    npsScore: surveyResponseItemsTable.npsScore,
    completedAt: surveyResponsesTable.completedAt,
  })
    .from(surveysTable)
    .innerJoin(surveyResponsesTable, eq(surveyResponsesTable.surveyId, surveysTable.id))
    .innerJoin(surveyResponseItemsTable, eq(surveyResponseItemsTable.responseId, surveyResponsesTable.id))
    .innerJoin(surveyQuestionsTable, and(
      eq(surveyQuestionsTable.id, surveyResponseItemsTable.questionId),
      eq(surveyQuestionsTable.type, "nps"),
    ))
    .where(and(
      eq(surveysTable.organizationId, orgId),
    ))
    .orderBy(asc(surveyResponsesTable.completedAt));

  const byMonth: Record<string, { promoters: number; detractors: number; passives: number; total: number }> = {};
  for (const r of rows) {
    if (r.npsScore === null) continue;
    const key = `${r.completedAt.getFullYear()}-${String(r.completedAt.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = { promoters: 0, detractors: 0, passives: 0, total: 0 };
    byMonth[key].total++;
    if (r.npsScore >= 9) byMonth[key].promoters++;
    else if (r.npsScore <= 6) byMonth[key].detractors++;
    else byMonth[key].passives++;
  }

  const trend = Object.entries(byMonth).map(([month, d]) => ({
    month,
    nps: d.total > 0 ? Math.round(((d.promoters - d.detractors) / d.total) * 100) : null,
    promoters: d.promoters,
    passives: d.passives,
    detractors: d.detractors,
    total: d.total,
  }));

  res.json({ trend });
});

router.get("/:surveyId/response-rate", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const surveyId = parseInt(String((req.params as Record<string, string>).surveyId));
  const [survey] = await db.select().from(surveysTable)
    .where(and(eq(surveysTable.id, surveyId), eq(surveysTable.organizationId, orgId)));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const responded = await db.select({
    userId: surveyResponsesTable.respondentUserId,
    completedAt: surveyResponsesTable.completedAt,
    isAnonymous: surveyResponsesTable.isAnonymous,
    name: appUsersTable.displayName,
    email: appUsersTable.email,
  })
    .from(surveyResponsesTable)
    .leftJoin(appUsersTable, eq(surveyResponsesTable.respondentUserId, appUsersTable.id))
    .where(eq(surveyResponsesTable.surveyId, surveyId));

  const respondedUserIds = new Set(responded.map(r => r.userId).filter(Boolean));

  const allMembers = await db.select({
    userId: clubMembersTable.userId,
    name: appUsersTable.displayName,
    email: appUsersTable.email,
    memberNumber: clubMembersTable.memberNumber,
  })
    .from(clubMembersTable)
    .leftJoin(appUsersTable, eq(clubMembersTable.userId, appUsersTable.id))
    .where(and(
      eq(clubMembersTable.organizationId, orgId),
      eq(clubMembersTable.subscriptionStatus, "active"),
    ));

  const pending = allMembers.filter(m => !respondedUserIds.has(m.userId ?? null));
  const rate = allMembers.length > 0 ? Math.round((respondedUserIds.size / allMembers.length) * 100) : 0;

  res.json({
    totalMembers: allMembers.length,
    responded: responded.length,
    pending: pending.length,
    responseRate: rate,
    respondedList: responded.map(r => ({
      userId: r.isAnonymous ? null : r.userId,
      name: r.isAnonymous ? "Anonymous" : (r.name ?? r.email ?? "Unknown"),
      completedAt: r.completedAt,
    })),
    pendingList: pending.map(m => ({
      userId: m.userId,
      name: m.name ?? m.email ?? "Unknown",
      email: m.email,
      memberNumber: m.memberNumber,
    })),
  });
});

export default router;
