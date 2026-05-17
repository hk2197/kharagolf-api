/**
 * Editable mapping from non-standard legacy plan slugs (e.g. "basic", "premium")
 * to a canonical SubscriptionTier (Task #1131).
 *
 * Replaces the previously hardcoded `LEGACY_SLUG_TIER_GUESSES` constant in the
 * super-admin frontend so support staff can add/edit entries themselves via
 * the Plan Migration audit panel without waiting for a code deploy.
 *
 * Strategy:
 *   - DB-backed via `legacy_plan_slug_mappings`
 *   - Small in-process cache (5 min TTL) to avoid hitting the DB on every
 *     audit-panel render
 *   - Seeded on first read with the same defaults the hardcoded mapping
 *     used to provide, so existing audit rows keep getting suggestions
 *     even before a super admin edits anything.
 */

import { db, legacyPlanSlugMappingsTable, appUsersTable } from "@workspace/db";
import { eq, inArray, aliasedTable } from "drizzle-orm";
import type { SubscriptionTier } from "./subscriptionTiers";
import { logger } from "./logger";

const RECOGNISED_TIERS: ReadonlyArray<SubscriptionTier> = [
  "free",
  "starter",
  "pro",
  "enterprise",
];

export function isRecognisedTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && (RECOGNISED_TIERS as readonly string[]).includes(value);
}

/** Canonical defaults — preserved from the original hardcoded mapping
 *  (super-admin.tsx `LEGACY_SLUG_TIER_GUESSES`) so behaviour is unchanged
 *  on first boot before anyone edits the table. */
export const DEFAULT_LEGACY_SLUG_MAPPINGS: Record<string, SubscriptionTier> = {
  basic: "starter",
  trial: "starter",
  starter_v2: "starter",
  premium: "pro",
  pro_v2: "pro",
  pro_plus: "pro",
  business: "pro",
  team: "pro",
  ent: "enterprise",
  enterprise_v2: "enterprise",
  unlimited: "enterprise",
};

export interface LegacySlugMapping {
  slug: string;
  tier: SubscriptionTier;
  notes: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  /** Display name of the user who originally created the mapping (Task #1299). */
  createdByDisplayName: string | null;
  /** Username of the creator — fallback when displayName is null. */
  createdByUsername: string | null;
  /** Email of the creator — last-resort identifier when both above are null. */
  createdByEmail: string | null;
  /** Display name of the user who last edited the mapping (Task #1299). */
  updatedByDisplayName: string | null;
  /** Username of the last editor — fallback when displayName is null. */
  updatedByUsername: string | null;
  /** Email of the last editor — last-resort identifier when both above are null. */
  updatedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CacheEntry {
  expiresAt: number;
  value: LegacySlugMapping[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CacheEntry | null = null;
let seedPromise: Promise<void> | null = null;

export function invalidateLegacySlugMappingsCache(): void {
  cache = null;
}

/**
 * One-time bootstrap of the canonical defaults — only inserts rows when
 * the table is completely empty. This way:
 *   - Fresh databases (or anywhere the migration seed didn't run) still
 *     get the same suggestions the hardcoded constant used to provide.
 *   - Once support staff start curating the table, deletions persist:
 *     a removed row will NOT reappear after the next API server restart.
 *
 * The migration `0096_legacy_plan_slug_mappings.sql` already seeds these
 * rows on managed deploys; this helper is the safety net for environments
 * where the migration didn't run (e.g. local dev DBs created via
 * `drizzle-kit push`).
 */
async function ensureSeeded(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    try {
      const existing = await db
        .select({ slug: legacyPlanSlugMappingsTable.slug })
        .from(legacyPlanSlugMappingsTable)
        .limit(1);
      if (existing.length > 0) return; // Already curated — never re-seed.

      const rows = Object.entries(DEFAULT_LEGACY_SLUG_MAPPINGS).map(([slug, tier]) => ({
        slug,
        tier,
        notes: "Seeded default (Task #977 hardcoded mapping)",
      }));
      if (rows.length === 0) return;
      await db
        .insert(legacyPlanSlugMappingsTable)
        .values(rows)
        .onConflictDoNothing({ target: legacyPlanSlugMappingsTable.slug });
    } catch (err) {
      logger.warn(
        { err },
        "[legacy-slug-mappings] seed failed — frontend will still fall back to suggestions for any rows already present",
      );
    }
  })();
  return seedPromise;
}

function normaliseSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return slug.length > 0 ? slug : null;
}

interface UserAuditFields {
  createdByDisplayName: string | null;
  createdByUsername: string | null;
  createdByEmail: string | null;
  updatedByDisplayName: string | null;
  updatedByUsername: string | null;
  updatedByEmail: string | null;
}

const EMPTY_USER_FIELDS: UserAuditFields = {
  createdByDisplayName: null,
  createdByUsername: null,
  createdByEmail: null,
  updatedByDisplayName: null,
  updatedByUsername: null,
  updatedByEmail: null,
};

function rowToMapping(
  row: typeof legacyPlanSlugMappingsTable.$inferSelect,
  users: UserAuditFields = EMPTY_USER_FIELDS,
): LegacySlugMapping {
  return {
    slug: row.slug,
    tier: row.tier as SubscriptionTier,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdByDisplayName: users.createdByDisplayName,
    createdByUsername: users.createdByUsername,
    createdByEmail: users.createdByEmail,
    updatedByDisplayName: users.updatedByDisplayName,
    updatedByUsername: users.updatedByUsername,
    updatedByEmail: users.updatedByEmail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listLegacySlugMappings(): Promise<LegacySlugMapping[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  await ensureSeeded();
  // Two left joins on app_users via aliases so the super-admin UI can show
  // who originally created each mapping AND who last edited it (Task #1299).
  const creatorUsers = aliasedTable(appUsersTable, "creatorUsers");
  const editorUsers = aliasedTable(appUsersTable, "editorUsers");
  const rows = await db
    .select({
      slug: legacyPlanSlugMappingsTable.slug,
      tier: legacyPlanSlugMappingsTable.tier,
      notes: legacyPlanSlugMappingsTable.notes,
      createdByUserId: legacyPlanSlugMappingsTable.createdByUserId,
      updatedByUserId: legacyPlanSlugMappingsTable.updatedByUserId,
      createdAt: legacyPlanSlugMappingsTable.createdAt,
      updatedAt: legacyPlanSlugMappingsTable.updatedAt,
      createdByDisplayName: creatorUsers.displayName,
      createdByUsername: creatorUsers.username,
      createdByEmail: creatorUsers.email,
      updatedByDisplayName: editorUsers.displayName,
      updatedByUsername: editorUsers.username,
      updatedByEmail: editorUsers.email,
    })
    .from(legacyPlanSlugMappingsTable)
    .leftJoin(creatorUsers, eq(creatorUsers.id, legacyPlanSlugMappingsTable.createdByUserId))
    .leftJoin(editorUsers, eq(editorUsers.id, legacyPlanSlugMappingsTable.updatedByUserId));
  const value: LegacySlugMapping[] = rows
    .map((row) => ({
      slug: row.slug,
      tier: row.tier as SubscriptionTier,
      notes: row.notes,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdByDisplayName: row.createdByDisplayName,
      createdByUsername: row.createdByUsername,
      createdByEmail: row.createdByEmail,
      updatedByDisplayName: row.updatedByDisplayName,
      updatedByUsername: row.updatedByUsername,
      updatedByEmail: row.updatedByEmail,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

async function fetchUserAuditFields(
  createdByUserId: number | null,
  updatedByUserId: number | null,
): Promise<UserAuditFields> {
  const ids = Array.from(
    new Set(
      [createdByUserId, updatedByUserId].filter(
        (id): id is number => typeof id === "number",
      ),
    ),
  );
  if (ids.length === 0) return EMPTY_USER_FIELDS;
  const userRows = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
    })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, ids));
  const byId = new Map(userRows.map((u) => [u.id, u]));
  const creator = createdByUserId != null ? byId.get(createdByUserId) ?? null : null;
  const editor = updatedByUserId != null ? byId.get(updatedByUserId) ?? null : null;
  return {
    createdByDisplayName: creator?.displayName ?? null,
    createdByUsername: creator?.username ?? null,
    createdByEmail: creator?.email ?? null,
    updatedByDisplayName: editor?.displayName ?? null,
    updatedByUsername: editor?.username ?? null,
    updatedByEmail: editor?.email ?? null,
  };
}

export interface UpsertLegacySlugMappingInput {
  slug: string;
  tier: string;
  notes?: string | null;
  userId?: number | null;
}

export type UpsertLegacySlugMappingError =
  | { kind: "invalid_slug" }
  | { kind: "invalid_tier" }
  | { kind: "reserved_slug" };

export async function upsertLegacySlugMapping(
  input: UpsertLegacySlugMappingInput,
): Promise<{ ok: true; mapping: LegacySlugMapping } | { ok: false; error: UpsertLegacySlugMappingError }> {
  const slug = normaliseSlug(input.slug);
  if (!slug) return { ok: false, error: { kind: "invalid_slug" } };
  if ((RECOGNISED_TIERS as readonly string[]).includes(slug)) {
    // A recognised-tier slug never needs a guess — refuse so the data stays clean.
    return { ok: false, error: { kind: "reserved_slug" } };
  }
  if (!isRecognisedTier(input.tier)) return { ok: false, error: { kind: "invalid_tier" } };

  const notes = typeof input.notes === "string" ? input.notes.trim() || null : null;
  const userId = typeof input.userId === "number" && Number.isFinite(input.userId) ? input.userId : null;
  const now = new Date();

  const [existing] = await db
    .select({ slug: legacyPlanSlugMappingsTable.slug })
    .from(legacyPlanSlugMappingsTable)
    .where(eq(legacyPlanSlugMappingsTable.slug, slug));

  const [row] = await db
    .insert(legacyPlanSlugMappingsTable)
    .values({
      slug,
      tier: input.tier,
      notes,
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: legacyPlanSlugMappingsTable.slug,
      set: {
        tier: input.tier,
        notes,
        updatedByUserId: userId,
        updatedAt: now,
      },
    })
    .returning();

  invalidateLegacySlugMappingsCache();
  void existing; // keep reference; useful for future audit logging
  // Resolve the creator/editor display info so the UI can render the
  // audit columns without a follow-up roundtrip (Task #1299).
  const users = await fetchUserAuditFields(row.createdByUserId, row.updatedByUserId);
  return { ok: true, mapping: rowToMapping(row, users) };
}

export async function deleteLegacySlugMapping(rawSlug: string): Promise<boolean> {
  const slug = normaliseSlug(rawSlug);
  if (!slug) return false;
  const result = await db
    .delete(legacyPlanSlugMappingsTable)
    .where(eq(legacyPlanSlugMappingsTable.slug, slug))
    .returning({ slug: legacyPlanSlugMappingsTable.slug });
  invalidateLegacySlugMappingsCache();
  return result.length > 0;
}
