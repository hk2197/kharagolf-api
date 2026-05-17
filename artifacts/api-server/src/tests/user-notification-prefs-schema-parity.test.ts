/**
 * Task #2179 — Live-DB schema parity guard for `user_notification_prefs`.
 *
 * Background
 * ----------
 * While building the alert-mute dashboard tests (Task #1733), every typed
 * insert into `user_notification_prefs` was failing at runtime because the
 * Drizzle schema declared columns the live DB didn't have. The tests had
 * to fall back to raw SQL inserts to work around the drift, which masked
 * the real bug — any production code path doing a typed insert into this
 * table would fail the same way.
 *
 * What this test does
 * -------------------
 * Walks every column declared on `userNotificationPrefsTable` via Drizzle's
 * runtime `getTableConfig` introspection and asserts that the live DB has
 * a matching column in `information_schema.columns` with:
 *   • the same SQL data type (mapped from Drizzle's column type),
 *   • the same nullability,
 *   • a NOT NULL column has SOME default if the schema declares one
 *     (the exact default literal is intentionally not pinned — that
 *     surface is already covered by the cosmetic-default rules in
 *     `scripts/check-db-drift.sh` / `lib/db/scripts/check-drift-fast.ts`).
 *
 * The test is scoped to the one table that previously caused the drift
 * footgun. It runs in a few seconds (one `information_schema.columns`
 * query, no pg_dump, no drizzle-kit push) so it can sit on the regular
 * vitest pretest run and surface the regression the moment it returns —
 * complementing the broader pre-deploy drift script which only fires in
 * CI / production deploys.
 */
import { describe, it, expect } from "vitest";
import { db, userNotificationPrefsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

// Map a Drizzle column's runtime SQL type string (e.g. `boolean`,
// `integer`, `timestamp with time zone`) to the values Postgres reports
// in `information_schema.columns.data_type`. Drizzle prints the type the
// same way Postgres stores it for the cases we care about, so the map
// is intentionally tiny — anything unmapped falls back to a raw equality
// check, which surfaces unfamiliar shapes as a test failure rather than
// silently passing.
const DRIZZLE_TO_PG_TYPE: Record<string, string> = {
  "boolean": "boolean",
  "integer": "integer",
  "serial": "integer",
  "text": "text",
  "timestamp with time zone": "timestamp with time zone",
};

describe("user_notification_prefs — schema/DB column parity", () => {
  it("every Drizzle column exists in the live DB with matching type & nullability", async () => {
    const config = getTableConfig(userNotificationPrefsTable);
    const tableName = config.name;

    type LiveColumn = {
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    };
    const liveRowsResult = await db.execute<LiveColumn>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `);
    // node-postgres-style result.rows; drizzle's neon driver also exposes .rows.
    const liveRows = (liveRowsResult as unknown as { rows: LiveColumn[] }).rows
      ?? (liveRowsResult as unknown as LiveColumn[]);
    const liveByName = new Map<string, LiveColumn>();
    for (const r of liveRows) liveByName.set(r.column_name, r);

    const missing: string[] = [];
    const wrongType: string[] = [];
    const wrongNullability: string[] = [];
    const missingDefault: string[] = [];

    for (const col of config.columns) {
      const live = liveByName.get(col.name);
      if (!live) {
        missing.push(col.name);
        continue;
      }
      const drizzleType = col.getSQLType();
      const expectedPgType = DRIZZLE_TO_PG_TYPE[drizzleType] ?? drizzleType;
      if (live.data_type !== expectedPgType) {
        wrongType.push(
          `${col.name}: drizzle=${drizzleType}(→${expectedPgType}) live=${live.data_type}`,
        );
      }
      const liveNullable = live.is_nullable === "YES";
      const drizzleNullable = !col.notNull;
      if (liveNullable !== drizzleNullable) {
        wrongNullability.push(
          `${col.name}: drizzle.notNull=${col.notNull} live.is_nullable=${live.is_nullable}`,
        );
      }
      // If the schema declares a default for a NOT NULL column, the live
      // DB must also carry SOME default — otherwise a typed insert that
      // omits the column would fail at runtime even though the schema
      // pretends it's safe to omit. Default *literal* equality is left
      // to the broader drift script (it knows about cosmetic re-formatting).
      if (col.notNull && col.default !== undefined && live.column_default == null) {
        missingDefault.push(col.name);
      }
    }

    const detail = [
      missing.length > 0 ? `MISSING in live DB: ${missing.join(", ")}` : null,
      wrongType.length > 0 ? `WRONG TYPE: ${wrongType.join(" | ")}` : null,
      wrongNullability.length > 0
        ? `WRONG NULLABILITY: ${wrongNullability.join(" | ")}`
        : null,
      missingDefault.length > 0
        ? `MISSING DEFAULT (drizzle declares one but live has NULL): ${missingDefault.join(", ")}`
        : null,
    ].filter(Boolean).join("\n");

    expect(detail, `\nSchema drift in user_notification_prefs:\n${detail}\n`).toBe("");
  });

  it("a typed Drizzle insert into user_notification_prefs succeeds end-to-end", async () => {
    // The original drift footgun: typed insert blew up at runtime because
    // a column the schema declared was missing in the DB. Doing one real
    // typed insert here pins the exact failure mode that started this
    // task. We use a transaction we roll back so the test leaves no rows.
    const config = getTableConfig(userNotificationPrefsTable);
    const tempUserId = -1 * (Date.now() % 1_000_000_000);
    let inserted = 0;
    try {
      await db.transaction(async (tx) => {
        // Seed a throwaway app_users row so the FK to app_users.id
        // doesn't trip the insert; then exercise the typed insert.
        await tx.execute(sql`
          INSERT INTO app_users (id, replit_user_id, username, display_name, email, role)
          VALUES (${tempUserId}, ${`schema-parity-${tempUserId}`}, ${`schema_parity_${tempUserId}`}, ${`schema-parity-${tempUserId}`}, ${`schema-parity-${tempUserId}@t2179.test`}, 'player')
        `);
        await tx.insert(userNotificationPrefsTable).values({
          userId: tempUserId,
          notifyWalletRefundDigestFailed: false,
        });
        inserted += 1;
        // Roll back so the test is non-destructive.
        throw new Error("__rollback__");
      });
    } catch (e) {
      if ((e as Error).message !== "__rollback__") throw e;
    }
    expect(inserted).toBe(1);
    expect(config.columns.length).toBeGreaterThan(0);
  });
});
