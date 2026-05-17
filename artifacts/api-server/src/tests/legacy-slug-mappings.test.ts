/**
 * Integration tests for the editable legacy plan slug suggestions
 * (Tasks #1131 / #1300).
 *
 * Covers:
 *   - Authz on GET / PUT / DELETE /api/super-admin/legacy-slug-mappings
 *     (anonymous → 401, non-super-admin → 403, super_admin → 200).
 *   - The `upsertLegacySlugMapping` helper rejects empty / whitespace slugs,
 *     unknown tiers, and slugs that already name a recognised tier.
 *   - The lazy seed in `listLegacySlugMappings` inserts the canonical
 *     defaults exactly once when the table is empty, and never overwrites
 *     rows that support staff have already edited.
 *
 * The DB is real; the table is snapshotted in `beforeAll` and restored in
 * `afterAll` so this file is hermetic with respect to whatever rows the
 * production migration / earlier tests left behind.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import { db, legacyPlanSlugMappingsTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import { createTestApp, uid } from "./helpers.js";
import {
  DEFAULT_LEGACY_SLUG_MAPPINGS,
  invalidateLegacySlugMappingsCache,
  upsertLegacySlugMapping,
  deleteLegacySlugMapping,
} from "../lib/legacySlugMappings.js";
import type { SubscriptionTier } from "../lib/subscriptionTiers.js";

// All test-owned slugs are prefixed so cleanup never touches unrelated rows.
const PREFIX = `t1300_${process.pid}_${Math.random().toString(36).slice(2, 6)}_`;
const t = (name: string) => `${PREFIX}${name}`;

interface SnapshotRow {
  slug: string;
  tier: SubscriptionTier;
  notes: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

let originalRows: SnapshotRow[] = [];
let testUserId: number;

beforeAll(async () => {
  const rows = await db.select().from(legacyPlanSlugMappingsTable);
  originalRows = rows.map((r) => ({
    slug: r.slug,
    tier: r.tier as SubscriptionTier,
    notes: r.notes,
    createdByUserId: r.createdByUserId,
    updatedByUserId: r.updatedByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  // The mappings table has FKs into app_users for created_by / updated_by, so
  // tests that exercise those columns need a real user row to attribute to.
  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: uid("replit-t1300"),
      username: uid("t1300-su"),
      displayName: "Legacy Slug Test SU",
      role: "super_admin",
    })
    .returning({ id: appUsersTable.id });
  testUserId = user.id;
});

afterAll(async () => {
  // Hard reset: wipe everything we may have left behind (test-prefixed rows,
  // re-seeded defaults, support-edited defaults) and restore the exact
  // snapshot taken in beforeAll. This keeps the table identical to its
  // pre-test state even if the snapshot was empty (in which case the seed
  // test inserted defaults that would otherwise leak into later test files).
  await db.delete(legacyPlanSlugMappingsTable);
  if (originalRows.length > 0) {
    await db
      .insert(legacyPlanSlugMappingsTable)
      .values(
        originalRows.map((r) => ({
          slug: r.slug,
          tier: r.tier,
          notes: r.notes,
          createdByUserId: r.createdByUserId,
          updatedByUserId: r.updatedByUserId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      )
      .onConflictDoNothing({ target: legacyPlanSlugMappingsTable.slug });
  }
  invalidateLegacySlugMappingsCache();

  if (testUserId !== undefined) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

beforeEach(() => {
  invalidateLegacySlugMappingsCache();
});

// ────────────────────────────────────────────────────────────────────────
// Authorisation
// ────────────────────────────────────────────────────────────────────────

describe("GET /api/super-admin/legacy-slug-mappings — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/super-admin/legacy-slug-mappings");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({
      id: 1,
      username: "u",
      role: "org_admin",
      organizationId: 1,
    });
    const res = await request(app).get("/api/super-admin/legacy-slug-mappings");
    expect(res.status).toBe(403);
  });

  it("returns the mapping list for super_admin", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/legacy-slug-mappings");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.mappings)).toBe(true);
  });
});

describe("PUT /api/super-admin/legacy-slug-mappings/:slug — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .put(`/api/super-admin/legacy-slug-mappings/${t("auth-anon")}`)
      .send({ tier: "starter" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({
      id: 1,
      username: "u",
      role: "org_admin",
      organizationId: 1,
    });
    const res = await request(app)
      .put(`/api/super-admin/legacy-slug-mappings/${t("auth-org")}`)
      .send({ tier: "starter" });
    expect(res.status).toBe(403);
  });

  it("persists a mapping when caller is a super_admin", async () => {
    const slug = t("auth-su");
    const app = createTestApp({
      id: testUserId,
      username: "su",
      role: "super_admin",
    });
    const res = await request(app)
      .put(`/api/super-admin/legacy-slug-mappings/${slug}`)
      .send({ tier: "pro", notes: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.mapping.slug).toBe(slug);
    expect(res.body.mapping.tier).toBe("pro");
    expect(res.body.mapping.notes).toBe("hello");
    expect(res.body.mapping.createdByUserId).toBe(testUserId);
    expect(res.body.mapping.updatedByUserId).toBe(testUserId);
  });
});

describe("DELETE /api/super-admin/legacy-slug-mappings/:slug — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).delete(
      `/api/super-admin/legacy-slug-mappings/${t("del-anon")}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({
      id: 1,
      username: "u",
      role: "org_admin",
      organizationId: 1,
    });
    const res = await request(app).delete(
      `/api/super-admin/legacy-slug-mappings/${t("del-org")}`,
    );
    expect(res.status).toBe(403);
  });

  it("removes an existing mapping for super_admin and returns 404 thereafter", async () => {
    const slug = t("del-su");
    await db
      .insert(legacyPlanSlugMappingsTable)
      .values({ slug, tier: "starter", notes: null })
      .onConflictDoNothing({ target: legacyPlanSlugMappingsTable.slug });

    const app = createTestApp({ id: 7, username: "su", role: "super_admin" });
    const first = await request(app).delete(
      `/api/super-admin/legacy-slug-mappings/${slug}`,
    );
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    const second = await request(app).delete(
      `/api/super-admin/legacy-slug-mappings/${slug}`,
    );
    expect(second.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Helper validation (`upsertLegacySlugMapping`)
// ────────────────────────────────────────────────────────────────────────

describe("upsertLegacySlugMapping validation", () => {
  it("rejects empty slugs", async () => {
    const result = await upsertLegacySlugMapping({
      slug: "",
      tier: "starter",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_slug");
  });

  it("rejects whitespace-only slugs", async () => {
    const result = await upsertLegacySlugMapping({
      slug: "   ",
      tier: "starter",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_slug");
  });

  it("rejects unknown tiers", async () => {
    const result = await upsertLegacySlugMapping({
      slug: t("bad-tier"),
      tier: "diamond",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_tier");
  });

  it("rejects slugs that are already a recognised tier", async () => {
    for (const reserved of ["free", "starter", "pro", "enterprise"] as const) {
      const result = await upsertLegacySlugMapping({
        slug: reserved,
        tier: "pro",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("reserved_slug");
    }
  });

  it("also surfaces those errors through the PUT route", async () => {
    const app = createTestApp({ id: 1, username: "su", role: "super_admin" });

    const empty = await request(app)
      .put("/api/super-admin/legacy-slug-mappings/%20")
      .send({ tier: "pro" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/slug is required/i);

    const badTier = await request(app)
      .put(`/api/super-admin/legacy-slug-mappings/${t("via-route-bad-tier")}`)
      .send({ tier: "diamond" });
    expect(badTier.status).toBe(400);
    expect(badTier.body.error).toMatch(/tier must be one of/i);

    const reserved = await request(app)
      .put("/api/super-admin/legacy-slug-mappings/free")
      .send({ tier: "pro" });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toMatch(/recognised tier/i);
  });

  it("persists a valid mapping (lowercases and trims the slug)", async () => {
    const slug = t("Mixed-Case");
    const result = await upsertLegacySlugMapping({
      slug: `  ${slug}  `,
      tier: "enterprise",
      notes: "  trimmed note  ",
      userId: testUserId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mapping.slug).toBe(slug.toLowerCase());
      expect(result.mapping.tier).toBe("enterprise");
      expect(result.mapping.notes).toBe("trimmed note");
      expect(result.mapping.updatedByUserId).toBe(testUserId);
    }

    // Cleanup
    await deleteLegacySlugMapping(slug.toLowerCase());
  });
});

// ────────────────────────────────────────────────────────────────────────
// Lazy seed: defaults inserted exactly once, support edits never overwritten
// ────────────────────────────────────────────────────────────────────────

describe("lazy seed via listLegacySlugMappings", () => {
  it("inserts the canonical defaults exactly once when the table is empty, and never overwrites support edits", async () => {
    // Empty the table so a fresh module instance will perform the seed.
    await db.delete(legacyPlanSlugMappingsTable);
    invalidateLegacySlugMappingsCache();

    // Reset module state so the module-level `seedPromise` is fresh.
    vi.resetModules();
    const fresh1 = await import("../lib/legacySlugMappings.js");
    const seeded = await fresh1.listLegacySlugMappings();

    const expectedSlugs = Object.keys(DEFAULT_LEGACY_SLUG_MAPPINGS).sort();
    expect(seeded.map((m) => m.slug).sort()).toEqual(expectedSlugs);
    for (const [slug, tier] of Object.entries(DEFAULT_LEGACY_SLUG_MAPPINGS)) {
      const row = seeded.find((m) => m.slug === slug);
      expect(row, `default ${slug} should be seeded`).toBeTruthy();
      expect(row?.tier).toBe(tier);
    }

    // A second call within the *same* module instance must reuse the
    // resolved seedPromise — no duplicate inserts, no extra rows.
    fresh1.invalidateLegacySlugMappingsCache();
    const seededAgain = await fresh1.listLegacySlugMappings();
    expect(seededAgain).toHaveLength(expectedSlugs.length);

    // Simulate a support-staff edit on one of the seeded rows.
    const editedSlug = "basic";
    await db
      .update(legacyPlanSlugMappingsTable)
      .set({ tier: "enterprise", notes: "support edit — do not clobber" })
      .where(eq(legacyPlanSlugMappingsTable.slug, editedSlug));

    // A second seed attempt (fresh module → fresh seedPromise) must not
    // overwrite the curated row, and must not duplicate any defaults.
    vi.resetModules();
    const fresh2 = await import("../lib/legacySlugMappings.js");
    const afterEdit = await fresh2.listLegacySlugMappings();

    expect(afterEdit).toHaveLength(expectedSlugs.length);
    const editedRow = afterEdit.find((m) => m.slug === editedSlug);
    expect(editedRow?.tier).toBe("enterprise");
    expect(editedRow?.notes).toBe("support edit — do not clobber");

    // And a row the support staff *deleted* must stay deleted across seeds —
    // an empty table is the only trigger for re-seeding.
    const removedSlug = "premium";
    await db
      .delete(legacyPlanSlugMappingsTable)
      .where(eq(legacyPlanSlugMappingsTable.slug, removedSlug));

    vi.resetModules();
    const fresh3 = await import("../lib/legacySlugMappings.js");
    const afterDelete = await fresh3.listLegacySlugMappings();

    expect(afterDelete.find((m) => m.slug === removedSlug)).toBeUndefined();
    expect(afterDelete).toHaveLength(expectedSlugs.length - 1);
  });
});
