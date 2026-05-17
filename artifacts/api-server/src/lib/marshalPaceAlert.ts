/**
 * Marshal pace alert helper — Wave 3 W3-K.
 *
 * Idempotent insert into marshal_pace_alerts when a group falls behind a
 * configurable minutes threshold on a given hole.
 *
 * Migration 0083 split the dedupe into TWO partial unique indexes because
 * NULLs are treated as distinct in standard unique indexes (so general-play
 * rows with tournament_id IS NULL would never dedupe). The conflict target
 * here must therefore branch on tournamentId nullability:
 *   - tournament rows  → marshal_pace_alerts_t_dedupe
 *       (tournament_id, group_label, hole_number) WHERE tournament_id IS NOT NULL
 *   - general-play rows → marshal_pace_alerts_gp_dedupe
 *       (organization_id, group_label, hole_number) WHERE tournament_id IS NULL
 * Postgres requires the inferred form `ON CONFLICT (cols) WHERE pred`
 * (NOT `ON CONFLICT ON CONSTRAINT name`) for partial unique indexes,
 * since partial unique indexes are not table constraints.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export interface PaceAlertInput {
  tournamentId: number | null;
  organizationId: number;
  groupLabel: string;
  holeNumber: number;
  minutesBehind: number;
  thresholdMinutes?: number;
}

export interface PaceAlertResult {
  inserted: boolean;
  reason?: "below-threshold" | "duplicate" | "ok";
  id?: number;
}

export async function recordPaceAlertIfBehind(
  input: PaceAlertInput,
): Promise<PaceAlertResult> {
  const threshold = input.thresholdMinutes ?? 10;
  if (input.minutesBehind < threshold) return { inserted: false, reason: "below-threshold" };

  const rows = input.tournamentId !== null
    ? await db.execute(sql`
        INSERT INTO marshal_pace_alerts
          (tournament_id, organization_id, group_label, hole_number, minutes_behind)
        VALUES (${input.tournamentId}, ${input.organizationId}, ${input.groupLabel},
                ${input.holeNumber}, ${input.minutesBehind})
        ON CONFLICT (tournament_id, group_label, hole_number)
          WHERE tournament_id IS NOT NULL
          DO NOTHING
        RETURNING id
      `)
    : await db.execute(sql`
        INSERT INTO marshal_pace_alerts
          (tournament_id, organization_id, group_label, hole_number, minutes_behind)
        VALUES (NULL, ${input.organizationId}, ${input.groupLabel},
                ${input.holeNumber}, ${input.minutesBehind})
        ON CONFLICT (organization_id, group_label, hole_number)
          WHERE tournament_id IS NULL
          DO NOTHING
        RETURNING id
      `);
  const r = rows as unknown as { rows?: Array<{ id: number }> };
  const id = r.rows?.[0]?.id;
  return id ? { inserted: true, reason: "ok", id } : { inserted: false, reason: "duplicate" };
}
