/**
 * Task #1732 — Regression coverage for the social-link backfill script.
 *
 * The backfill script (`scripts/backfillSocialLinks.ts`, originally Task
 * #1431) walks every `app_users` row whose `replit_user_id` matches the
 * `apple_<sub>` / `google_<sub>` placeholder format produced by
 * `providerLocalId(...)` in routes/social-auth.ts, and inserts a matching
 * row into `app_user_social_links`.
 *
 * It was originally validated by hand. This test pins down the contract
 * so that future drift in any of the following will fail loudly:
 *
 *   - the placeholder format itself (`<provider>_<sub>` — see
 *     `providerLocalId` in routes/social-auth.ts; if the prefix or
 *     separator changes, the SQL `left()` / `substr()` slicing would
 *     silently stop matching).
 *   - the unique indexes on `app_user_social_links`
 *     (`(provider, provider_sub)` and `(user_id, provider)`); the
 *     `ON CONFLICT DO NOTHING` clause depends on at least one of them
 *     firing for already-linked users.
 *   - the `erased_at` carve-out (erased accounts must not be revived
 *     with a fresh link row).
 *
 * Coverage:
 *   1. `apple_<sub>` placeholder → row inserted with provider=apple,
 *      provider_sub=<sub>.
 *   2. `google_<sub>` placeholder → row inserted with provider=google,
 *      provider_sub=<sub>.
 *   3. An unrelated `replit_user_id` (e.g. the legacy `repl_…` shape) is
 *      ignored entirely.
 *   4. A user that already has a link row in `app_user_social_links` is
 *      not duplicated (ON CONFLICT path).
 *   5. A user with `erased_at` set is skipped (no link row written).
 *   6. Re-running the backfill is a no-op (idempotency): inserted=0 on
 *      the second pass and total link count for the seeded users is
 *      unchanged.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-backfill-social-links";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  appUsersTable,
  appUserSocialLinksTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import { runBackfill } from "../lib/backfillSocialLinks.js";

// All seeded users are tracked here so the cleanup hook can delete just
// our rows (link rows cascade via FK).
const createdUserIds: number[] = [];

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Fixture identifiers — kept as module-level constants so individual
// `it` blocks can assert against them without re-deriving.
const appleSub = `apple-sub-${stamp}`;
const googleSub = `google-sub-${stamp}`;
const alreadyLinkedSub = `apple-already-${stamp}`;
const erasedSub = `google-erased-${stamp}`;

// IDs are populated in beforeAll once the rows are inserted.
let appleUserId = 0;
let googleUserId = 0;
let unrelatedUserId = 0;
let alreadyLinkedUserId = 0;
let erasedUserId = 0;

async function insertUser(opts: {
  replitUserId: string;
  erased?: boolean;
}): Promise<number> {
  const local = `${opts.replitUserId.replace(/[^a-z0-9]/gi, "_")}`.slice(0, 40);
  const [row] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: opts.replitUserId,
      username: `bf_${local}`,
      email: `${local}@example.test`.toLowerCase(),
      role: "player",
      emailVerified: true,
      erasedAt: opts.erased ? new Date() : null,
    })
    .returning({ id: appUsersTable.id });
  createdUserIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  // Seed a user per scenario the backfill needs to handle.

  // (1) Apple placeholder — should be backfilled.
  appleUserId = await insertUser({ replitUserId: `apple_${appleSub}` });

  // (2) Google placeholder — should be backfilled.
  googleUserId = await insertUser({ replitUserId: `google_${googleSub}` });

  // (3) Unrelated replit_user_id — must be ignored. We use a value that
  //     starts with `repl_` (the legacy Replit OAuth shape) which does
  //     NOT match the `apple_` / `google_` prefix used by the script.
  unrelatedUserId = await insertUser({
    replitUserId: `repl_unrelated_${stamp}`,
  });

  // (4) Apple placeholder, but already has a link row in the table —
  //     the ON CONFLICT DO NOTHING path must skip it without duplicating.
  alreadyLinkedUserId = await insertUser({
    replitUserId: `apple_${alreadyLinkedSub}`,
  });
  await db.insert(appUserSocialLinksTable).values({
    userId: alreadyLinkedUserId,
    provider: "apple",
    providerSub: alreadyLinkedSub,
  });

  // (5) Google placeholder, but the account has been erased — must be
  //     skipped so we don't materialise a link row on a tombstoned user.
  erasedUserId = await insertUser({
    replitUserId: `google_${erasedSub}`,
    erased: true,
  });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Link rows cascade-delete from app_users (FK has onDelete: cascade),
    // so wiping users is enough.
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("runBackfill (Task #1431 social-link backfill)", () => {
  it("inserts link rows for apple_/google_ placeholders, skips unrelated/already-linked/erased users, and is idempotent on re-run", async () => {
    // ── First pass ─────────────────────────────────────────────────────
    const first = await runBackfill();

    // The candidate count is shared across this test DB, so we can only
    // assert lower bounds — but the script counts every apple_/google_
    // user in the table, so it MUST include our 4 placeholder rows
    // (apple, google, already-linked, erased).
    expect(first.candidates).toBeGreaterThanOrEqual(4);
    // We seeded 2 fresh placeholders that must be inserted; other tests
    // in the suite may also seed placeholders that the backfill picks
    // up, so we use a lower bound.
    expect(first.inserted).toBeGreaterThanOrEqual(2);
    // skipped == candidates - inserted; with at least 1 already-linked
    // and 1 erased seed of ours, skipped must be ≥ 2.
    expect(first.skipped).toBeGreaterThanOrEqual(2);

    // (1) Apple placeholder → row inserted with the right shape.
    const appleLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, appleUserId));
    expect(appleLinks).toHaveLength(1);
    expect(appleLinks[0].provider).toBe("apple");
    expect(appleLinks[0].providerSub).toBe(appleSub);

    // (2) Google placeholder → row inserted with the right shape.
    const googleLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, googleUserId));
    expect(googleLinks).toHaveLength(1);
    expect(googleLinks[0].provider).toBe("google");
    expect(googleLinks[0].providerSub).toBe(googleSub);

    // (3) Unrelated `replit_user_id` (`repl_…`) → no link row written.
    const unrelatedLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, unrelatedUserId));
    expect(unrelatedLinks).toHaveLength(0);

    // (4) Already-linked user → still exactly one row (no duplicate).
    const alreadyLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, alreadyLinkedUserId));
    expect(alreadyLinks).toHaveLength(1);
    // And specifically the row we pre-seeded — same provider/sub.
    expect(alreadyLinks[0].provider).toBe("apple");
    expect(alreadyLinks[0].providerSub).toBe(alreadyLinkedSub);

    // (5) Erased user → no link row written, even though the placeholder
    //     prefix matches.
    const erasedLinks = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(eq(appUserSocialLinksTable.userId, erasedUserId));
    expect(erasedLinks).toHaveLength(0);
    // Defence in depth — also assert nothing landed under (google, erasedSub).
    const erasedBySub = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(and(
        eq(appUserSocialLinksTable.provider, "google"),
        eq(appUserSocialLinksTable.providerSub, erasedSub),
      ));
    expect(erasedBySub).toHaveLength(0);

    // Snapshot the link rows that exist for our seeded users right now.
    // Idempotency: a second pass must not change this set at all.
    const linksBefore = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(inArray(appUserSocialLinksTable.userId, createdUserIds));

    // ── Second pass ────────────────────────────────────────────────────
    const second = await runBackfill();

    // No rows are eligible for insertion the second time round.
    expect(second.inserted).toBe(0);
    // Candidate count is unchanged (we didn't add or remove app_users).
    expect(second.candidates).toBe(first.candidates);
    // Everything counts as "skipped (already linked or erased)" now.
    expect(second.skipped).toBe(second.candidates);

    // The set of link rows for our seeded users is byte-identical.
    const linksAfter = await db
      .select()
      .from(appUserSocialLinksTable)
      .where(inArray(appUserSocialLinksTable.userId, createdUserIds));

    expect(linksAfter).toHaveLength(linksBefore.length);
    const keyOf = (l: typeof linksAfter[number]) =>
      `${l.userId}:${l.provider}:${l.providerSub}`;
    expect(linksAfter.map(keyOf).sort()).toEqual(linksBefore.map(keyOf).sort());
  });
});
