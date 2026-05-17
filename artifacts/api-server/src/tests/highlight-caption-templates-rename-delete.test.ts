/**
 * Test: Caption-template rename + delete + use flow (Task #997).
 *
 * The existing highlight-caption-templates.test.ts pinned POST/GET/DELETE
 * basics for Task #698. This file adds coverage for the endpoints added
 * in Task #856 that had no automated coverage:
 *
 *   • PATCH /api/portal/highlights/caption-templates/:id
 *       - rename rewrites the pattern AND re-derives tokenKeys from the
 *         placeholders in the new wording (so the saved keys can never
 *         drift out of sync with the wording players actually see)
 *       - rejects invalid token names (e.g. "1bad")
 *       - rejects > 12 placeholder tokens
 *       - rejects empty / oversize patterns
 *       - returns 409 when the new pattern collides with another saved
 *         template the same user already owns
 *       - same-pattern PATCH does NOT trip the conflict check
 *       - 404 on cross-user PATCH (cannot rename someone else's chip)
 *       - sampleCaption defaults to the existing snapshot when omitted
 *
 *   • POST /api/portal/highlights/caption-templates/:id/use
 *       - bumps useCount, updates lastUsedAt, refreshes sampleCaption
 *         when supplied
 *       - 204 with no body on success
 *       - 404 on cross-user use (cannot bump someone else's counters)
 *
 *   • DELETE /api/portal/highlights/caption-templates/:id
 *       - 404 for cross-user delete and unknown ids (regression for the
 *         tenant-isolation path)
 *
 *   • GET /api/portal/highlights/caption-templates
 *       - sort order honors lastUsedAt DESC so freshly-used chips
 *         bubble to the top of the management screen
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return { ...actual, enqueueRender: vi.fn(async (_id: number) => {}) };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  highlightCaptionTemplatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers";

let orgId: number;
let userIdA: number;
let userIdB: number;

beforeAll(async () => {
  const ts = uid("hctrd");
  const [o] = await db.insert(organizationsTable).values({
    name: `HCTRDOrg_${ts}`, slug: ts, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${ts}_a`, username: `${ts}_a`, email: `${ts}_a@t.local`,
    displayName: "Rename A", role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdA = u.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${ts}_b`, username: `${ts}_b`, email: `${ts}_b@t.local`,
    displayName: "Rename B", role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdB = u2.id;

  await db.insert(orgMembershipsTable).values([
    { userId: userIdA, organizationId: orgId, role: "player" },
    { userId: userIdB, organizationId: orgId, role: "player" },
  ]);
});

beforeEach(async () => {
  await db.delete(highlightCaptionTemplatesTable)
    .where(inArray(highlightCaptionTemplatesTable.userId, [userIdA, userIdB]));
});

afterAll(async () => {
  await db.delete(highlightCaptionTemplatesTable)
    .where(inArray(highlightCaptionTemplatesTable.userId, [userIdA, userIdB]));
  await db.delete(orgMembershipsTable)
    .where(inArray(orgMembershipsTable.userId, [userIdA, userIdB]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userIdA, userIdB]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function asUser(id: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId: orgId };
}

async function seedTemplate(userId: number, pattern: string, tokenKeys: string[], sampleCaption = "snapshot") {
  const r = await request(createTestApp(asUser(userId)))
    .post("/api/portal/highlights/caption-templates")
    .send({ pattern, tokenKeys, sampleCaption });
  expect(r.status).toBe(201);
  return r.body.template as { id: number; pattern: string; tokenKeys: string[]; sampleCaption: string; useCount: number };
}

describe("PATCH /api/portal/highlights/caption-templates/:id (rename)", () => {
  it("rewrites the pattern and re-derives tokenKeys from the new placeholders", async () => {
    const tpl = await seedTemplate(
      userIdA,
      "Hole {hole} · {club}",
      ["hole", "club"],
      "Hole 5 · 7-iron",
    );
    const app = createTestApp(asUser(userIdA));
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "#{hole} — {club} ({carry}y)" });
    expect(r.status).toBe(200);
    expect(r.body.template.pattern).toBe("#{hole} — {club} ({carry}y)");
    // Every placeholder in the new pattern lands in tokenKeys, deduped, and
    // the old "club"-only key set is replaced (not merged).
    expect(new Set(r.body.template.tokenKeys)).toEqual(new Set(["hole", "club", "carry"]));
    expect(r.body.template.tokenKeys).toHaveLength(3);
    // sampleCaption is preserved when not supplied — it's just a preview.
    expect(r.body.template.sampleCaption).toBe("Hole 5 · 7-iron");
  });

  it("accepts a fresh sampleCaption when supplied", async () => {
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const app = createTestApp(asUser(userIdA));
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "Hole {hole} — {club}", sampleCaption: "Hole 5 — 7-iron" });
    expect(r.status).toBe(200);
    expect(r.body.template.sampleCaption).toBe("Hole 5 — 7-iron");
  });

  it("rejects empty or oversize patterns", async () => {
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const app = createTestApp(asUser(userIdA));

    const empty = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "   " });
    expect(empty.status).toBe(400);

    const huge = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "x".repeat(281) });
    expect(huge.status).toBe(400);
  });

  it("rejects invalid placeholder names (regression for token validation)", async () => {
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const app = createTestApp(asUser(userIdA));
    // Leading-digit token name fails the identifier regex.
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "Bad {1bad}" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/1bad/);
  });

  it("rejects patterns with more than 12 placeholders", async () => {
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const app = createTestApp(asUser(userIdA));
    const tokens = Array.from({ length: 13 }, (_, i) => `{t${i}}`).join(" ");
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: tokens });
    expect(r.status).toBe(400);
  });

  it("returns 409 when the new pattern collides with another saved template", async () => {
    const t1 = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    await seedTemplate(userIdA, "Hole {hole} — {club}", ["hole", "club"]);
    const app = createTestApp(asUser(userIdA));
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${t1.id}`)
      .send({ pattern: "Hole {hole} — {club}" });
    expect(r.status).toBe(409);
    // Original template should be untouched.
    const [unchanged] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, t1.id));
    expect(unchanged.pattern).toBe("Hole {hole}");
  });

  it("does NOT trip the conflict check when the pattern is unchanged", async () => {
    // Patching with the exact same pattern is a metadata-only update.
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"], "old sample");
    const app = createTestApp(asUser(userIdA));
    const r = await request(app)
      .patch(`/api/portal/highlights/caption-templates/${tpl.id}`)
      .send({ pattern: "Hole {hole}", sampleCaption: "new sample" });
    expect(r.status).toBe(200);
    expect(r.body.template.pattern).toBe("Hole {hole}");
    expect(r.body.template.sampleCaption).toBe("new sample");
  });

  it("does not collide with a same-pattern template owned by ANOTHER user", async () => {
    // Patterns are unique per (userId, pattern), so user B already saving
    // "Hole {hole}" must not block user A from renaming into it.
    await seedTemplate(userIdB, "Hole {hole}", ["hole"]);
    const tplA = await seedTemplate(userIdA, "Hole {hole} — {club}", ["hole", "club"]);
    const r = await request(createTestApp(asUser(userIdA)))
      .patch(`/api/portal/highlights/caption-templates/${tplA.id}`)
      .send({ pattern: "Hole {hole}" });
    expect(r.status).toBe(200);
    expect(r.body.template.pattern).toBe("Hole {hole}");
  });

  it("returns 404 when another user attempts to rename the chip", async () => {
    const tplA = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const r = await request(createTestApp(asUser(userIdB)))
      .patch(`/api/portal/highlights/caption-templates/${tplA.id}`)
      .send({ pattern: "Hijacked {hole}" });
    expect(r.status).toBe(404);
    // Confirm the template was not actually mutated.
    const [row] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tplA.id));
    expect(row.pattern).toBe("Hole {hole}");
  });

  it("returns 400 for non-numeric ids and 404 for missing ids", async () => {
    const app = createTestApp(asUser(userIdA));
    const bad = await request(app)
      .patch("/api/portal/highlights/caption-templates/not-a-number")
      .send({ pattern: "Hole {hole}" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .patch("/api/portal/highlights/caption-templates/9999999")
      .send({ pattern: "Hole {hole}" });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/portal/highlights/caption-templates/:id/use", () => {
  it("bumps useCount, updates lastUsedAt and refreshes sampleCaption when supplied", async () => {
    const tpl = await seedTemplate(userIdA, "Hole {hole}", ["hole"], "Hole 5");
    const [before] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tpl.id));
    expect(before.useCount).toBe(0);
    const beforeUsedAt = before.lastUsedAt ? new Date(before.lastUsedAt).getTime() : 0;

    // Sleep a tick so the lastUsedAt comparison can move forward reliably
    // even on systems with coarse timestamp precision.
    await new Promise(r => setTimeout(r, 10));

    const app = createTestApp(asUser(userIdA));
    const r1 = await request(app)
      .post(`/api/portal/highlights/caption-templates/${tpl.id}/use`)
      .send({ sampleCaption: "Hole 7" });
    expect(r1.status).toBe(204);
    expect(r1.body).toEqual({});

    const [after1] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tpl.id));
    expect(after1.useCount).toBe(1);
    expect(after1.sampleCaption).toBe("Hole 7");
    expect(new Date(after1.lastUsedAt!).getTime()).toBeGreaterThanOrEqual(beforeUsedAt);

    // A second use without sampleCaption should bump the counter but leave
    // the snapshot text alone.
    const r2 = await request(app)
      .post(`/api/portal/highlights/caption-templates/${tpl.id}/use`)
      .send({});
    expect(r2.status).toBe(204);
    const [after2] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tpl.id));
    expect(after2.useCount).toBe(2);
    expect(after2.sampleCaption).toBe("Hole 7");
  });

  it("returns 404 when another user attempts to bump the use counter", async () => {
    const tplA = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const r = await request(createTestApp(asUser(userIdB)))
      .post(`/api/portal/highlights/caption-templates/${tplA.id}/use`)
      .send({});
    expect(r.status).toBe(404);
    const [row] = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tplA.id));
    expect(row.useCount).toBe(0);
  });

  it("returns 400 for non-numeric ids and 404 for missing ids", async () => {
    const app = createTestApp(asUser(userIdA));
    const bad = await request(app)
      .post("/api/portal/highlights/caption-templates/not-a-number/use")
      .send({});
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post("/api/portal/highlights/caption-templates/9999999/use")
      .send({});
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/portal/highlights/caption-templates ordering", () => {
  it("returns most-recently-used templates first", async () => {
    const t1 = await seedTemplate(userIdA, "Style A {hole}", ["hole"]);
    const t2 = await seedTemplate(userIdA, "Style B {hole}", ["hole"]);
    const t3 = await seedTemplate(userIdA, "Style C {hole}", ["hole"]);

    // Bump t1 last so it should sort first by lastUsedAt DESC.
    const app = createTestApp(asUser(userIdA));
    await new Promise(r => setTimeout(r, 5));
    await request(app).post(`/api/portal/highlights/caption-templates/${t2.id}/use`).send({});
    await new Promise(r => setTimeout(r, 5));
    await request(app).post(`/api/portal/highlights/caption-templates/${t3.id}/use`).send({});
    await new Promise(r => setTimeout(r, 5));
    await request(app).post(`/api/portal/highlights/caption-templates/${t1.id}/use`).send({});

    const list = await request(app).get("/api/portal/highlights/caption-templates");
    expect(list.status).toBe(200);
    const ids = (list.body.templates as Array<{ id: number }>).map(t => t.id);
    expect(ids.slice(0, 3)).toEqual([t1.id, t3.id, t2.id]);
  });
});

describe("DELETE /api/portal/highlights/caption-templates/:id (regression)", () => {
  it("returns 404 for unknown ids and refuses cross-user deletes", async () => {
    const tplA = await seedTemplate(userIdA, "Hole {hole}", ["hole"]);
    const missing = await request(createTestApp(asUser(userIdA)))
      .delete("/api/portal/highlights/caption-templates/9999999");
    expect(missing.status).toBe(404);

    const cross = await request(createTestApp(asUser(userIdB)))
      .delete(`/api/portal/highlights/caption-templates/${tplA.id}`);
    expect(cross.status).toBe(404);

    // Owner can still delete and the row is gone.
    const ok = await request(createTestApp(asUser(userIdA)))
      .delete(`/api/portal/highlights/caption-templates/${tplA.id}`);
    expect(ok.status).toBe(200);
    const rows = await db.select().from(highlightCaptionTemplatesTable)
      .where(eq(highlightCaptionTemplatesTable.id, tplA.id));
    expect(rows).toHaveLength(0);
  });
});
