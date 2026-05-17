/**
 * Task #1637 — CRUD endpoints for reusable post-event survey templates.
 *
 * Pins the contract for:
 *   • GET    /api/organizations/:orgId/survey-templates
 *   • POST   /api/organizations/:orgId/survey-templates
 *   • PATCH  /api/organizations/:orgId/survey-templates/:templateId
 *   • DELETE /api/organizations/:orgId/survey-templates/:templateId
 *
 * Covers:
 *   • Happy path — an org_admin can save a template, list it, and have a
 *     tournament_director in the same org load (read) it.
 *   • Upsert — re-saving with the same name updates the existing row's
 *     questions instead of failing with a duplicate-name 409.
 *   • AuthZ — tournament_director can read but cannot create or delete.
 *     Players are rejected with 403 across the board.
 *   • Auth — unauthenticated callers get 401.
 *   • IDOR — admin of org A can't list, create, or delete templates for
 *     org B. Cross-org delete by id returns 404 (the row exists, but
 *     we scope by org so it's invisible).
 *   • Validation — empty name, empty questions, invalid question type
 *     all return 400.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  postEventSurveyTemplatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUser: TestUser;
let adminBUser: TestUser;
let tdAUser: TestUser;
let playerAUser: TestUser;

const userIdsToCleanup: number[] = [];

beforeAll(async () => {
  const stamp = uid("t1637");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1637 A ${stamp}`, slug: `t1637a-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1637 B ${stamp}`, slug: `t1637b-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  async function makeUser(
    suffix: string,
    role: "org_admin" | "tournament_director" | "player",
    orgId: number,
  ): Promise<TestUser> {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `t1637-${suffix}-${stamp}`,
      username: `t1637_${suffix}_${stamp}`,
      role,
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    userIdsToCleanup.push(u.id);
    return { id: u.id, username: `${suffix}_${stamp}`, role, organizationId: orgId };
  }

  adminAUser = await makeUser("admA", "org_admin", orgAId);
  adminBUser = await makeUser("admB", "org_admin", orgBId);
  tdAUser = await makeUser("tdA", "tournament_director", orgAId);
  playerAUser = await makeUser("plA", "player", orgAId);

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAUser.id, role: "org_admin" },
    { organizationId: orgBId, userId: adminBUser.id, role: "org_admin" },
    { organizationId: orgAId, userId: tdAUser.id, role: "tournament_director" },
    { organizationId: orgAId, userId: playerAUser.id, role: "player" },
  ]);
});

afterAll(async () => {
  await db.delete(postEventSurveyTemplatesTable)
    .where(inArray(postEventSurveyTemplatesTable.organizationId, [orgAId, orgBId]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIdsToCleanup));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToCleanup));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

beforeEach(async () => {
  // Wipe templates between tests so each one exercises a clean slate.
  await db.delete(postEventSurveyTemplatesTable)
    .where(inArray(postEventSurveyTemplatesTable.organizationId, [orgAId, orgBId]));
});

const sampleQuestions = [
  { id: "overall", prompt: "Overall experience", type: "rating" as const },
  { id: "comments", prompt: "Any comments?", type: "text" as const },
];

describe("POST /api/organizations/:orgId/survey-templates", () => {
  it("org_admin can create a template and the row is scoped to the org", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Standard post-round survey", questions: sampleQuestions });

    expect(res.status).toBe(201);
    expect(res.body.template.id).toBeDefined();
    expect(res.body.template.organizationId).toBe(orgAId);
    expect(res.body.template.name).toBe("Standard post-round survey");
    expect(res.body.template.questions).toHaveLength(2);
    expect(res.body.template.createdByUserId).toBe(adminAUser.id);
  });

  it("re-saving the same name upserts (overwrites questions, no duplicate row)", async () => {
    const app = createTestApp(adminAUser);

    const first = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Standard", questions: sampleQuestions });
    expect(first.status).toBe(201);
    const firstId = first.body.template.id;

    const updated = [{ id: "q1", prompt: "New question", type: "boolean" as const }];
    const second = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Standard", questions: updated });
    expect(second.status).toBe(201);
    expect(second.body.template.id).toBe(firstId); // same row, updated
    expect(second.body.template.questions).toHaveLength(1);
    expect(second.body.template.questions[0].prompt).toBe("New question");

    // Confirm only one row exists in the DB for this org.
    const rows = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.organizationId, orgAId));
    expect(rows).toHaveLength(1);
  });

  it("tournament_director cannot create templates (403)", async () => {
    const app = createTestApp(tdAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "TD attempt", questions: sampleQuestions });
    expect(res.status).toBe(403);
  });

  it("player cannot create templates (403)", async () => {
    const app = createTestApp(playerAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Player attempt", questions: sampleQuestions });
    expect(res.status).toBe(403);
  });

  it("unauthenticated caller is rejected (401)", async () => {
    const app = createTestApp(); // no user injected
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Anon", questions: sampleQuestions });
    expect(res.status).toBe(401);
  });

  it("admin of org A cannot create templates in org B (403, IDOR)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgBId}/survey-templates`)
      .send({ name: "Cross-org", questions: sampleQuestions });
    expect(res.status).toBe(403);
  });

  it("rejects empty name with 400", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "   ", questions: sampleQuestions });
    expect(res.status).toBe(400);
  });

  it("rejects empty questions array with 400", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Empty", questions: [] });
    expect(res.status).toBe(400);
  });

  it("rejects questions with invalid type with 400", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/survey-templates`)
      .send({
        name: "Bad",
        questions: [{ id: "x", prompt: "Hi", type: "rocket-rating" }],
      });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/organizations/:orgId/survey-templates", () => {
  it("returns the org's templates ordered by name", async () => {
    const app = createTestApp(adminAUser);
    await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Zebra", questions: sampleQuestions });
    await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Alpha", questions: sampleQuestions });

    const res = await request(app).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);
    expect(res.body.templates[0].name).toBe("Alpha");
    expect(res.body.templates[1].name).toBe("Zebra");
  });

  it("tournament_director can read the template list (so the dialog picker works)", async () => {
    const adminApp = createTestApp(adminAUser);
    await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "TD readable", questions: sampleQuestions });

    const tdApp = createTestApp(tdAUser);
    const res = await request(tdApp).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0].name).toBe("TD readable");
  });

  it("player cannot read templates (403)", async () => {
    const app = createTestApp(playerAUser);
    const res = await request(app).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res.status).toBe(403);
  });

  it("admin of org A cannot list templates from org B (403, IDOR)", async () => {
    const adminBApp = createTestApp(adminBUser);
    await request(adminBApp).post(`/api/organizations/${orgBId}/survey-templates`)
      .send({ name: "Org B private", questions: sampleQuestions });

    const adminAApp = createTestApp(adminAUser);
    const res = await request(adminAApp).get(`/api/organizations/${orgBId}/survey-templates`);
    expect(res.status).toBe(403);
  });

  it("returns empty list when the org has no templates", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([]);
  });

  // Task #2035 — the picker shows "who saved this template" so admins can
  // tell yesterday's edit apart from last season's leftover. The API joins
  // app_users and falls back from displayName → username so the UI never
  // gets a blank label for an active account.
  it("includes the creator's display name (or username fallback) and timestamps", async () => {
    // Stamp a display name on adminA so we can assert the join picked it up.
    await db.update(appUsersTable)
      .set({ displayName: "Sarah Admin" })
      .where(eq(appUsersTable.id, adminAUser.id));

    const adminApp = createTestApp(adminAUser);
    await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "With author", questions: sampleQuestions });

    const res = await request(adminApp).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    const tpl = res.body.templates[0];
    expect(tpl.createdByUserId).toBe(adminAUser.id);
    expect(tpl.createdByName).toBe("Sarah Admin");
    expect(typeof tpl.createdAt).toBe("string");
    expect(typeof tpl.updatedAt).toBe("string");

    // Clear the display name to confirm the username fallback path.
    await db.update(appUsersTable)
      .set({ displayName: null })
      .where(eq(appUsersTable.id, adminAUser.id));

    const res2 = await request(adminApp).get(`/api/organizations/${orgAId}/survey-templates`);
    expect(res2.status).toBe(200);
    expect(res2.body.templates[0].createdByName).toBeTruthy();
    expect(typeof res2.body.templates[0].createdByName).toBe("string");
  });
});

describe("PATCH /api/organizations/:orgId/survey-templates/:templateId", () => {
  it("org_admin can rename a template and createdByUserId / createdAt are preserved", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Original name", questions: sampleQuestions });
    expect(created.status).toBe(201);
    const tpl = created.body.template;

    // Small wait so updatedAt is observably newer than createdAt.
    await new Promise(r => setTimeout(r, 5));

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tpl.id}`)
      .send({ name: "New name" });

    expect(res.status).toBe(200);
    expect(res.body.template.id).toBe(tpl.id);
    expect(res.body.template.name).toBe("New name");
    // Provenance is intact.
    expect(res.body.template.createdByUserId).toBe(adminAUser.id);
    expect(res.body.template.createdAt).toBe(tpl.createdAt);
    // Questions untouched when only name is sent.
    expect(res.body.template.questions).toHaveLength(sampleQuestions.length);
  });

  it("trims whitespace around the new name", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Trim me", questions: sampleQuestions });
    const tpl = created.body.template;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tpl.id}`)
      .send({ name: "   Polished name   " });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe("Polished name");
  });

  it("can update questions without renaming", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Same name", questions: sampleQuestions });
    const tpl = created.body.template;

    const newQuestions = [{ id: "newq", prompt: "Updated", type: "boolean" as const }];
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tpl.id}`)
      .send({ questions: newQuestions });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe("Same name");
    expect(res.body.template.questions).toHaveLength(1);
    expect(res.body.template.questions[0].prompt).toBe("Updated");
    expect(res.body.template.createdByUserId).toBe(adminAUser.id);
    expect(res.body.template.createdAt).toBe(tpl.createdAt);
  });

  it("renaming to an already-used name returns 409 (no silent merge)", async () => {
    const app = createTestApp(adminAUser);
    await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Taken", questions: sampleQuestions });
    const other = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Free", questions: sampleQuestions });
    const otherId = other.body.template.id;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${otherId}`)
      .send({ name: "Taken" });
    expect(res.status).toBe(409);

    // Both rows still exist with their original names.
    const rows = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.organizationId, orgAId));
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.name).sort()).toEqual(["Free", "Taken"]);
  });

  it("renaming to the same name is a no-op success (does not 409 against itself)", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Stable", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Stable" });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe("Stable");
  });

  it("the same name can coexist across different orgs (no cross-org 409)", async () => {
    const adminAApp = createTestApp(adminAUser);
    const adminBApp = createTestApp(adminBUser);
    await request(adminBApp).post(`/api/organizations/${orgBId}/survey-templates`)
      .send({ name: "Shared name", questions: sampleQuestions });
    const created = await request(adminAApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Org A original", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(adminAApp)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Shared name" });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe("Shared name");
  });

  it("tournament_director cannot rename templates (403)", async () => {
    const adminApp = createTestApp(adminAUser);
    const created = await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "TD-no-rename", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const tdApp = createTestApp(tdAUser);
    const res = await request(tdApp)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);

    const [row] = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.id, tplId));
    expect(row.name).toBe("TD-no-rename");
  });

  it("player cannot rename templates (403)", async () => {
    const adminApp = createTestApp(adminAUser);
    const created = await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Player-no-rename", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const playerApp = createTestApp(playerAUser);
    const res = await request(playerApp)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Player tried" });
    expect(res.status).toBe(403);
  });

  it("unauthenticated caller is rejected (401)", async () => {
    const adminApp = createTestApp(adminAUser);
    const created = await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Anon-no-rename", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const anonApp = createTestApp();
    const res = await request(anonApp)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Anon" });
    expect(res.status).toBe(401);
  });

  it("admin of org A cannot rename a template in org B (403 cross-org)", async () => {
    const adminBApp = createTestApp(adminBUser);
    const created = await request(adminBApp).post(`/api/organizations/${orgBId}/survey-templates`)
      .send({ name: "Org B private", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const adminAApp = createTestApp(adminAUser);
    const res = await request(adminAApp)
      .patch(`/api/organizations/${orgBId}/survey-templates/${tplId}`)
      .send({ name: "Trespass" });
    expect(res.status).toBe(403);

    // Pointing at their own org with the cross-org id → 404.
    const cross = await request(adminAApp)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "Trespass" });
    expect(cross.status).toBe(404);

    const [row] = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.id, tplId));
    expect(row.name).toBe("Org B private");
  });

  it("returns 404 when the template id does not exist", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/999999999`)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("rejects empty name with 400", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Has name", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects a payload with neither name nor questions with 400", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Untouched", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects bad questions with 400", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "Bad-q-rename", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/survey-templates/${tplId}`)
      .send({ questions: [{ id: "x", prompt: "Hi", type: "rocket-rating" }] });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/organizations/:orgId/survey-templates/:templateId", () => {
  it("org_admin can delete their org's template", async () => {
    const app = createTestApp(adminAUser);
    const created = await request(app).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "To delete", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const res = await request(app)
      .delete(`/api/organizations/${orgAId}/survey-templates/${tplId}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(tplId);

    const remaining = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.id, tplId));
    expect(remaining).toHaveLength(0);
  });

  it("tournament_director cannot delete templates (403)", async () => {
    const adminApp = createTestApp(adminAUser);
    const created = await request(adminApp).post(`/api/organizations/${orgAId}/survey-templates`)
      .send({ name: "TD-no-delete", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const tdApp = createTestApp(tdAUser);
    const res = await request(tdApp)
      .delete(`/api/organizations/${orgAId}/survey-templates/${tplId}`);
    expect(res.status).toBe(403);

    // Row still exists.
    const remaining = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.id, tplId));
    expect(remaining).toHaveLength(1);
  });

  it("admin of org A cannot delete a template in org B (404, IDOR-safe)", async () => {
    const adminBApp = createTestApp(adminBUser);
    const created = await request(adminBApp).post(`/api/organizations/${orgBId}/survey-templates`)
      .send({ name: "Org B only", questions: sampleQuestions });
    const tplId = created.body.template.id;

    const adminAApp = createTestApp(adminAUser);
    // Even if admin A guesses the id and points at their own org, no match.
    const res = await request(adminAApp)
      .delete(`/api/organizations/${orgAId}/survey-templates/${tplId}`);
    expect(res.status).toBe(404);

    // Targeting org B directly hits the strict admin guard first → 403.
    const cross = await request(adminAApp)
      .delete(`/api/organizations/${orgBId}/survey-templates/${tplId}`);
    expect(cross.status).toBe(403);

    // Row still exists.
    const remaining = await db.select().from(postEventSurveyTemplatesTable)
      .where(eq(postEventSurveyTemplatesTable.id, tplId));
    expect(remaining).toHaveLength(1);
  });

  it("returns 404 when the template id does not exist", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .delete(`/api/organizations/${orgAId}/survey-templates/999999999`);
    expect(res.status).toBe(404);
  });
});
