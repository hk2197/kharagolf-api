/**
 * Custom Registration Forms & Post-Event Surveys — Task #142
 *
 * Registration Form (admin):
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/fields         List fields
 * POST   /organizations/:orgId/event-forms/:eventType/:eventId/fields         Create field
 * PATCH  /organizations/:orgId/event-forms/:eventType/:eventId/fields/:id    Update field
 * DELETE /organizations/:orgId/event-forms/:eventType/:eventId/fields/:id    Delete field
 * POST   /organizations/:orgId/event-forms/:eventType/:eventId/fields/reorder Reorder fields
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/responses      List responses (admin)
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/responses/csv  Export CSV
 *
 * Registration Form (public):
 * GET    /public/event-forms/:eventType/:eventId/fields                       Get fields (for public reg page)
 * POST   /public/event-forms/:eventType/:eventId/responses                    Submit responses (at registration)
 *
 * Survey (admin):
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/survey         Get or create survey config
 * PUT    /organizations/:orgId/event-forms/:eventType/:eventId/survey         Update survey metadata + fields
 * POST   /organizations/:orgId/event-forms/:eventType/:eventId/survey/send    Manually trigger survey send
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/survey/results Results + response rate
 * GET    /organizations/:orgId/event-forms/:eventType/:eventId/survey/results/csv CSV export
 *
 * Survey (public, token-gated):
 * GET    /public/survey-respond/:token    Get survey + respondent info
 * POST   /public/survey-respond/:token    Submit survey response
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  registrationFormFieldsTable,
  registrationFormResponsesTable,
  eventSurveyFormsTable,
  eventSurveyFieldsTable,
  eventSurveyRespondentsTable,
  eventSurveyResponseItemsTable,
  organizationsTable,
  playersTable,
  leagueMembersTable,
  tournamentsTable,
  leaguesTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { sendSurveyEmail } from "../lib/mailer";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser {
  id: number;
  role?: string;
  organizationId?: number | null;
}

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
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

function parseEventType(raw: string): "tournament" | "league" | null {
  if (raw === "tournament" || raw === "league") return raw;
  return null;
}

// ─── REGISTRATION FORM FIELDS (ADMIN) ────────────────────────────────────────

// GET /organizations/:orgId/event-forms/:eventType/:eventId/fields
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/fields", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(asc(registrationFormFieldsTable.sortOrder));

  res.json(fields);
});

// POST /organizations/:orgId/event-forms/:eventType/:eventId/fields
router.post("/organizations/:orgId/event-forms/:eventType/:eventId/fields", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { fieldType, label, placeholder, helpText, options, required, conditionalOnFieldId, conditionalOnValue, termsText } = req.body;
  if (!fieldType || !label) { { res.status(400).json({ error: "fieldType and label are required" }); return; } }

  const existing = await db.select({ sortOrder: registrationFormFieldsTable.sortOrder })
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(sql`${registrationFormFieldsTable.sortOrder} DESC`)
    .limit(1);

  const sortOrder = (existing[0]?.sortOrder ?? -1) + 1;

  const [field] = await db.insert(registrationFormFieldsTable).values({
    organizationId: orgId,
    eventId,
    eventType,
    fieldType,
    label,
    placeholder: placeholder ?? null,
    helpText: helpText ?? null,
    options: Array.isArray(options) ? options : null,
    required: required ?? false,
    conditionalOnFieldId: conditionalOnFieldId ?? null,
    conditionalOnValue: conditionalOnValue ?? null,
    termsText: termsText ?? null,
    sortOrder,
  }).returning();

  res.status(201).json(field);
});

// PATCH /organizations/:orgId/event-forms/:eventType/:eventId/fields/:fieldId
router.patch("/organizations/:orgId/event-forms/:eventType/:eventId/fields/:fieldId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const fieldId = parseInt(String((req.params as Record<string, string>).fieldId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { fieldType, label, placeholder, helpText, options, required, conditionalOnFieldId, conditionalOnValue, termsText } = req.body;

  const [field] = await db.update(registrationFormFieldsTable)
    .set({
      ...(fieldType ? { fieldType } : {}),
      ...(label !== undefined ? { label } : {}),
      placeholder: placeholder ?? null,
      helpText: helpText ?? null,
      options: Array.isArray(options) ? options : null,
      ...(required !== undefined ? { required } : {}),
      conditionalOnFieldId: conditionalOnFieldId ?? null,
      conditionalOnValue: conditionalOnValue ?? null,
      termsText: termsText ?? null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(registrationFormFieldsTable.id, fieldId),
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .returning();

  if (!field) { { res.status(404).json({ error: "Field not found" }); return; } }
  res.json(field);
});

// DELETE /organizations/:orgId/event-forms/:eventType/:eventId/fields/:fieldId
router.delete("/organizations/:orgId/event-forms/:eventType/:eventId/fields/:fieldId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const fieldId = parseInt(String((req.params as Record<string, string>).fieldId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.id, fieldId),
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ));

  res.status(204).send();
});

// POST /organizations/:orgId/event-forms/:eventType/:eventId/fields/reorder
router.post("/organizations/:orgId/event-forms/:eventType/:eventId/fields/reorder", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { orderedIds } = req.body as { orderedIds: number[] };
  if (!Array.isArray(orderedIds)) { { res.status(400).json({ error: "orderedIds array required" }); return; } }

  await Promise.all(
    orderedIds.map((id, idx) =>
      db.update(registrationFormFieldsTable)
        .set({ sortOrder: idx, updatedAt: new Date() })
        .where(and(
          eq(registrationFormFieldsTable.id, id),
          eq(registrationFormFieldsTable.organizationId, orgId),
        ))
    )
  );

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(asc(registrationFormFieldsTable.sortOrder));

  res.json(fields);
});

// ─── REGISTRATION FORM RESPONSES (ADMIN) ─────────────────────────────────────

// GET /organizations/:orgId/event-forms/:eventType/:eventId/responses
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/responses", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(asc(registrationFormFieldsTable.sortOrder));

  if (fields.length === 0) { { res.json({ fields: [], entries: [] }); return; } }

  const fieldIds = fields.map(f => f.id);
  const responses = await db.select()
    .from(registrationFormResponsesTable)
    .where(and(
      inArray(registrationFormResponsesTable.fieldId, fieldIds),
      eq(registrationFormResponsesTable.eventType, eventType),
    ));

  const entryIds = [...new Set(responses.map(r => r.entryId))];

  let entryNames: Record<number, string> = {};
  if (entryIds.length > 0) {
    if (eventType === "tournament") {
      const players = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
        .from(playersTable)
        .where(inArray(playersTable.id, entryIds));
      entryNames = Object.fromEntries(players.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
    } else {
      const members = await db.select({ id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName })
        .from(leagueMembersTable)
        .where(inArray(leagueMembersTable.id, entryIds));
      entryNames = Object.fromEntries(members.map(m => [m.id, `${m.firstName} ${m.lastName}`]));
    }
  }

  const entriesMap = new Map<number, Record<number, string | null>>();
  for (const r of responses) {
    if (!entriesMap.has(r.entryId)) entriesMap.set(r.entryId, {});
    entriesMap.get(r.entryId)![r.fieldId] = r.value;
  }

  const entries = Array.from(entriesMap.entries()).map(([entryId, answers]) => ({
    entryId,
    entryName: entryNames[entryId] ?? `Entry #${entryId}`,
    answers,
  }));

  res.json({ fields, entries });
});

// GET /organizations/:orgId/event-forms/:eventType/:eventId/responses/csv
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/responses/csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.organizationId, orgId),
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(asc(registrationFormFieldsTable.sortOrder));

  const fieldIds = fields.map(f => f.id);
  const responses = fieldIds.length > 0
    ? await db.select()
        .from(registrationFormResponsesTable)
        .where(and(
          inArray(registrationFormResponsesTable.fieldId, fieldIds),
          eq(registrationFormResponsesTable.eventType, eventType),
        ))
    : [];

  const entryIds = [...new Set(responses.map(r => r.entryId))];
  let entryNames: Record<number, string> = {};
  if (entryIds.length > 0) {
    if (eventType === "tournament") {
      const players = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
        .from(playersTable).where(inArray(playersTable.id, entryIds));
      entryNames = Object.fromEntries(players.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
    } else {
      const members = await db.select({ id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName })
        .from(leagueMembersTable).where(inArray(leagueMembersTable.id, entryIds));
      entryNames = Object.fromEntries(members.map(m => [m.id, `${m.firstName} ${m.lastName}`]));
    }
  }

  const csvEscape = (v: string | null | undefined) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = ['Entry Name', ...fields.map(f => f.label)];
  const responseMap = new Map<number, Map<number, string | null>>();
  for (const r of responses) {
    if (!responseMap.has(r.entryId)) responseMap.set(r.entryId, new Map());
    responseMap.get(r.entryId)!.set(r.fieldId, r.value);
  }

  const rows = Array.from(responseMap.entries()).map(([entryId, answers]) => {
    const name = entryNames[entryId] ?? `Entry #${entryId}`;
    return [name, ...fields.map(f => answers.get(f.id) ?? '')].map(csvEscape).join(',');
  });

  const csv = [headers.map(csvEscape).join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="registration-responses-${eventId}.csv"`);
  res.send(csv);
});

// ─── PUBLIC REGISTRATION FORM (no auth required) ─────────────────────────────

// GET /public/event-forms/:eventType/:eventId/fields
router.get("/public/event-forms/:eventType/:eventId/fields", async (req: Request, res: Response) => {
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ))
    .orderBy(asc(registrationFormFieldsTable.sortOrder));

  res.json(fields);
});

// POST /public/event-forms/:eventType/:eventId/responses
router.post("/public/event-forms/:eventType/:eventId/responses", async (req: Request, res: Response) => {
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }

  const { entryId, answers } = req.body as { entryId: number; answers: Record<string, string> };
  if (!entryId || !answers) { { res.status(400).json({ error: "entryId and answers are required" }); return; } }

  const fields = await db.select()
    .from(registrationFormFieldsTable)
    .where(and(
      eq(registrationFormFieldsTable.eventId, eventId),
      eq(registrationFormFieldsTable.eventType, eventType),
    ));

  // Check required fields, respecting conditional visibility
  const isFieldVisible = (field: typeof fields[0]): boolean => {
    if (!field.conditionalOnFieldId) return true;
    const parentAnswer = answers[String(field.conditionalOnFieldId)] ?? '';
    return parentAnswer === (field.conditionalOnValue ?? '');
  };

  for (const field of fields) {
    if (!field.required || !isFieldVisible(field)) continue;
    if (!answers[String(field.id)]) {
      res.status(400).json({ error: `Field "${field.label}" is required` });
      return;
    }
  }

  // Only persist responses for visible fields
  const inserts = Object.entries(answers)
    .filter(([fieldId]) => {
      const f = fields.find(f => f.id === parseInt(fieldId));
      return f && isFieldVisible(f);
    })
    .map(([fieldId, value]) => ({
      fieldId: parseInt(fieldId),
      entryId,
      eventType,
      value: value ?? null,
    }));

  if (inserts.length > 0) {
    await db.insert(registrationFormResponsesTable)
      .values(inserts)
      .onConflictDoUpdate({
        target: [registrationFormResponsesTable.fieldId, registrationFormResponsesTable.entryId, registrationFormResponsesTable.eventType],
        set: { value: sql`excluded.value` },
      });
  }

  res.json({ ok: true });
});

// ─── SURVEY (ADMIN) ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/event-forms/:eventType/:eventId/survey
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/survey", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  let [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));

  if (!survey) {
    [survey] = await db.insert(eventSurveyFormsTable).values({
      organizationId: orgId,
      eventId,
      eventType,
      title: "Post-Event Survey",
      sendDelayHours: 0,
      isActive: true,
    }).returning();
  }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  res.json({ ...survey, fields });
});

// PUT /organizations/:orgId/event-forms/:eventType/:eventId/survey
router.put("/organizations/:orgId/event-forms/:eventType/:eventId/survey", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { title, description, sendDelayHours, isActive } = req.body;

  let [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));

  if (!survey) {
    [survey] = await db.insert(eventSurveyFormsTable).values({
      organizationId: orgId,
      eventId,
      eventType,
      title: title ?? "Post-Event Survey",
      description: description ?? null,
      sendDelayHours: sendDelayHours ?? 0,
      isActive: isActive ?? true,
    }).returning();
  } else {
    [survey] = await db.update(eventSurveyFormsTable)
      .set({
        ...(title !== undefined ? { title } : {}),
        description: description ?? null,
        ...(sendDelayHours !== undefined ? { sendDelayHours: parseInt(sendDelayHours) } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(eventSurveyFormsTable.id, survey.id))
      .returning();
  }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  res.json({ ...survey, fields });
});

// POST /organizations/:orgId/event-forms/:eventType/:eventId/survey/fields
router.post("/organizations/:orgId/event-forms/:eventType/:eventId/survey/fields", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select({ id: eventSurveyFormsTable.id })
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const { fieldType, label, placeholder, helpText, options, required, termsText } = req.body;
  if (!fieldType || !label) { { res.status(400).json({ error: "fieldType and label are required" }); return; } }

  const existing = await db.select({ sortOrder: eventSurveyFieldsTable.sortOrder })
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(sql`${eventSurveyFieldsTable.sortOrder} DESC`)
    .limit(1);
  const sortOrder = (existing[0]?.sortOrder ?? -1) + 1;

  const [field] = await db.insert(eventSurveyFieldsTable).values({
    surveyId: survey.id,
    fieldType,
    label,
    placeholder: placeholder ?? null,
    helpText: helpText ?? null,
    options: Array.isArray(options) ? options : null,
    required: required ?? false,
    termsText: termsText ?? null,
    sortOrder,
  }).returning();

  res.status(201).json(field);
});

// PATCH /organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/:fieldId
router.patch("/organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/:fieldId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fieldId = parseInt(String((req.params as Record<string, string>).fieldId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select({ id: eventSurveyFormsTable.id })
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const { fieldType, label, placeholder, helpText, options, required, termsText } = req.body;

  const [field] = await db.update(eventSurveyFieldsTable)
    .set({
      ...(fieldType ? { fieldType } : {}),
      ...(label !== undefined ? { label } : {}),
      placeholder: placeholder ?? null,
      helpText: helpText ?? null,
      options: Array.isArray(options) ? options : null,
      ...(required !== undefined ? { required } : {}),
      termsText: termsText ?? null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(eventSurveyFieldsTable.id, fieldId),
      eq(eventSurveyFieldsTable.surveyId, survey.id),
    ))
    .returning();

  if (!field) { { res.status(404).json({ error: "Field not found" }); return; } }
  res.json(field);
});

// DELETE /organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/:fieldId
router.delete("/organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/:fieldId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fieldId = parseInt(String((req.params as Record<string, string>).fieldId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select({ id: eventSurveyFormsTable.id })
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  await db.delete(eventSurveyFieldsTable)
    .where(and(
      eq(eventSurveyFieldsTable.id, fieldId),
      eq(eventSurveyFieldsTable.surveyId, survey.id),
    ));

  res.status(204).send();
});

// POST /organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/reorder
router.post("/organizations/:orgId/event-forms/:eventType/:eventId/survey/fields/reorder", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select({ id: eventSurveyFormsTable.id })
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const { orderedIds } = req.body as { orderedIds: number[] };
  if (!Array.isArray(orderedIds)) { { res.status(400).json({ error: "orderedIds array required" }); return; } }

  await Promise.all(
    orderedIds.map((id, idx) =>
      db.update(eventSurveyFieldsTable)
        .set({ sortOrder: idx, updatedAt: new Date() })
        .where(and(
          eq(eventSurveyFieldsTable.id, id),
          eq(eventSurveyFieldsTable.surveyId, survey.id),
        ))
    )
  );

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  res.json(fields);
});

// POST /organizations/:orgId/event-forms/:eventType/:eventId/survey/send
router.post("/organizations/:orgId/event-forms/:eventType/:eventId/survey/send", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const orgName = org?.name ?? "KHARAGOLF";

  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://kharagolf.com";

  setImmediate(async () => {
    try {
      await sendSurveyEmails(survey.id, eventId, eventType, orgName, publicBaseUrl);
      await db.update(eventSurveyFormsTable)
        .set({ sentAt: new Date(), updatedAt: new Date() })
        .where(eq(eventSurveyFormsTable.id, survey.id));
    } catch (err) {
      logger.error({ err, surveyId: survey.id }, "[event-forms] Survey send error");
    }
  });

  res.json({ ok: true, message: "Survey emails enqueued" });
});

// GET /organizations/:orgId/event-forms/:eventType/:eventId/survey/results
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/survey/results", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.json({ survey: null, fields: [], results: [], responseRate: 0, totalRespondents: 0, responded: 0 }); return; } }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  const respondents = await db.select()
    .from(eventSurveyRespondentsTable)
    .where(eq(eventSurveyRespondentsTable.surveyId, survey.id));

  const totalRespondents = respondents.length;
  const responded = respondents.filter(r => r.respondedAt != null).length;
  const responseRate = totalRespondents > 0 ? Math.round((responded / totalRespondents) * 100) : 0;

  const respondedIds = respondents.filter(r => r.respondedAt != null).map(r => r.id);
  let responseItems: { respondentId: number; fieldId: number; value: string | null }[] = [];
  if (respondedIds.length > 0) {
    responseItems = await db.select({
      respondentId: eventSurveyResponseItemsTable.respondentId,
      fieldId: eventSurveyResponseItemsTable.fieldId,
      value: eventSurveyResponseItemsTable.value,
    })
      .from(eventSurveyResponseItemsTable)
      .where(inArray(eventSurveyResponseItemsTable.respondentId, respondedIds));
  }

  const results = fields.map(field => {
    const items = responseItems.filter(r => r.fieldId === field.id);
    const tally: Record<string, number> = {};
    const freeText: string[] = [];
    for (const item of items) {
      if (item.value == null) continue;
      if (field.fieldType === "dropdown" || field.fieldType === "checkbox" || field.fieldType === "terms_acceptance") {
        tally[item.value] = (tally[item.value] ?? 0) + 1;
      } else {
        freeText.push(item.value);
      }
    }
    return { field, tally, freeText, count: items.filter(i => i.value).length };
  });

  const rawRows = respondents.map(r => {
    const answers = Object.fromEntries(
      responseItems.filter(i => i.respondentId === r.id).map(i => [i.fieldId, i.value])
    );
    return { respondentId: r.id, respondentName: r.respondentName, respondedAt: r.respondedAt, answers };
  });

  res.json({ survey, fields, results, responseRate, totalRespondents, responded, rawRows });
});

// GET /organizations/:orgId/event-forms/:eventType/:eventId/survey/results/csv
router.get("/organizations/:orgId/event-forms/:eventType/:eventId/survey/results/csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  const eventType = parseEventType((req.params as Record<string, string>).eventType);
  if (!eventType) { { res.status(400).json({ error: "Invalid eventType" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(and(
      eq(eventSurveyFormsTable.organizationId, orgId),
      eq(eventSurveyFormsTable.eventId, eventId),
      eq(eventSurveyFormsTable.eventType, eventType),
    ));
  if (!survey) { { res.status(404).json({ error: "Survey not found" }); return; } }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  const respondents = await db.select()
    .from(eventSurveyRespondentsTable)
    .where(eq(eventSurveyRespondentsTable.surveyId, survey.id));

  const respondedIds = respondents.filter(r => r.respondedAt != null).map(r => r.id);
  let responseItems: { respondentId: number; fieldId: number; value: string | null }[] = [];
  if (respondedIds.length > 0) {
    responseItems = await db.select({
      respondentId: eventSurveyResponseItemsTable.respondentId,
      fieldId: eventSurveyResponseItemsTable.fieldId,
      value: eventSurveyResponseItemsTable.value,
    })
      .from(eventSurveyResponseItemsTable)
      .where(inArray(eventSurveyResponseItemsTable.respondentId, respondedIds));
  }

  const csvEscape = (v: string | null | undefined) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = ['Respondent Name', 'Responded At', ...fields.map(f => f.label)];
  const rows = respondents.map(r => {
    const answers = new Map(responseItems.filter(i => i.respondentId === r.id).map(i => [i.fieldId, i.value]));
    return [
      r.respondentName ?? '',
      r.respondedAt ? new Date(r.respondedAt).toISOString() : '',
      ...fields.map(f => answers.get(f.id) ?? ''),
    ].map(csvEscape).join(',');
  });

  const csv = [headers.map(csvEscape).join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="survey-responses-${eventId}.csv"`);
  res.send(csv);
});

// ─── PUBLIC SURVEY RESPONSE (token-gated, no login) ──────────────────────────

// GET /public/survey-respond/:token
router.get("/public/survey-respond/:token", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);

  const [respondent] = await db.select()
    .from(eventSurveyRespondentsTable)
    .where(eq(eventSurveyRespondentsTable.token, token));

  if (!respondent) { { res.status(404).json({ error: "Invalid or expired survey link" }); return; } }

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(eq(eventSurveyFormsTable.id, respondent.surveyId));

  if (!survey || !survey.isActive) { { res.status(404).json({ error: "Survey not available" }); return; } }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id))
    .orderBy(asc(eventSurveyFieldsTable.sortOrder));

  let existingAnswers: Record<number, string | null> = {};
  if (respondent.respondedAt) {
    const items = await db.select()
      .from(eventSurveyResponseItemsTable)
      .where(eq(eventSurveyResponseItemsTable.respondentId, respondent.id));
    existingAnswers = Object.fromEntries(items.map(i => [i.fieldId, i.value]));
  }

  res.json({
    survey: { id: survey.id, title: survey.title, description: survey.description },
    fields,
    respondentName: respondent.respondentName,
    alreadySubmitted: respondent.respondedAt != null,
    existingAnswers,
  });
});

// POST /public/survey-respond/:token
router.post("/public/survey-respond/:token", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);

  const [respondent] = await db.select()
    .from(eventSurveyRespondentsTable)
    .where(eq(eventSurveyRespondentsTable.token, token));

  if (!respondent) { { res.status(404).json({ error: "Invalid or expired survey link" }); return; } }
  if (respondent.respondedAt) { { res.status(409).json({ error: "Survey already submitted" }); return; } }

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(eq(eventSurveyFormsTable.id, respondent.surveyId));

  if (!survey || !survey.isActive) { { res.status(404).json({ error: "Survey not available" }); return; } }

  const fields = await db.select()
    .from(eventSurveyFieldsTable)
    .where(eq(eventSurveyFieldsTable.surveyId, survey.id));

  const { answers } = req.body as { answers: Record<string, string> };
  if (!answers) { { res.status(400).json({ error: "answers is required" }); return; } }

  for (const field of fields) {
    if (field.required && !answers[String(field.id)]) {
      res.status(400).json({ error: `"${field.label}" is required` });
      return;
    }
  }

  const inserts = Object.entries(answers)
    .filter(([fieldId]) => fields.some(f => f.id === parseInt(fieldId)))
    .map(([fieldId, value]) => ({
      respondentId: respondent.id,
      fieldId: parseInt(fieldId),
      value: value ?? null,
    }));

  if (inserts.length > 0) {
    await db.insert(eventSurveyResponseItemsTable)
      .values(inserts)
      .onConflictDoUpdate({
        target: [eventSurveyResponseItemsTable.respondentId, eventSurveyResponseItemsTable.fieldId],
        set: { value: sql`excluded.value` },
      });
  }

  await db.update(eventSurveyRespondentsTable)
    .set({ respondedAt: new Date() })
    .where(eq(eventSurveyRespondentsTable.id, respondent.id));

  res.json({ ok: true, message: "Thank you for completing the survey!" });
});

// ─── INTERNAL HELPER: Send survey emails ─────────────────────────────────────

export async function sendSurveyEmails(
  surveyId: number,
  eventId: number,
  eventType: "tournament" | "league",
  orgName: string,
  publicBaseUrl: string,
): Promise<void> {
  let entries: { id: number; firstName: string; lastName: string; email: string | null }[] = [];

  if (eventType === "tournament") {
    entries = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
    }).from(playersTable).where(eq(playersTable.tournamentId, eventId));
  } else {
    const members = await db.select({
      id: leagueMembersTable.id,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email,
    }).from(leagueMembersTable).where(eq(leagueMembersTable.leagueId, eventId));
    entries = members;
  }

  const [survey] = await db.select()
    .from(eventSurveyFormsTable)
    .where(eq(eventSurveyFormsTable.id, surveyId));
  if (!survey) return;

  for (const entry of entries) {
    if (!entry.email) continue;

    const token = randomUUID();
    const name = `${entry.firstName} ${entry.lastName}`;

    let respondentId: number;
    const [existing] = await db.select({ id: eventSurveyRespondentsTable.id })
      .from(eventSurveyRespondentsTable)
      .where(and(
        eq(eventSurveyRespondentsTable.surveyId, surveyId),
        eq(eventSurveyRespondentsTable.entryId, entry.id),
        eq(eventSurveyRespondentsTable.eventType, eventType),
      ));

    if (existing) {
      respondentId = existing.id;
    } else {
      const [created] = await db.insert(eventSurveyRespondentsTable).values({
        surveyId,
        entryId: entry.id,
        eventType,
        respondentName: name,
        respondentEmail: entry.email,
        token,
        emailSentAt: new Date(),
      }).returning();
      respondentId = created.id;
    }

    if (!existing) {
      const surveyUrl = `${publicBaseUrl}/survey/${token}`;
      try {
        await sendSurveyEmail({
          to: entry.email,
          name,
          orgName,
          surveyTitle: survey.title,
          surveyDescription: survey.description ?? undefined,
          surveyUrl,
        });
        await db.update(eventSurveyRespondentsTable)
          .set({ emailSentAt: new Date() })
          .where(eq(eventSurveyRespondentsTable.id, respondentId));
      } catch (err) {
        logger.error({ err, entryId: entry.id, surveyId }, "[event-forms] Survey email send error");
      }
    }
  }
}

export default router;
