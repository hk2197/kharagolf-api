/**
 * Wave 1 W1-A — Centralised AI Caddie advice-mode resolver + enforcement.
 *
 * Modes (lib/db/src/schema/golf.ts → aiCaddieModeEnum):
 *   open          — all advice surfaces enabled
 *   distance_only — only F/C/B yardages permitted; club rec / strategy hidden
 *   lockdown      — every advice surface (including yardages) blocked + audited
 *
 * Precedence (first non-null wins):
 *   general_play_rounds.ai_caddie_mode (per-round override)
 *   tournaments.ai_caddie_mode
 *   leagues.ai_caddie_mode
 *   default 'open'
 *
 * Every surface that wants to render advice must call assertModeAllows().
 * On block the helper throws AiCaddieBlockedError AND writes one audit row
 * to ai_caddie_mode_blocks AND emits an analytics event so organisers can
 * later prove no advice leaked during a lockdown round.
 */

import { db, tournamentsTable, leaguesTable, generalPlayRoundsTable, leagueRoundsTable, aiCaddieModeBlocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { track } from "./analytics.js";

export type AiCaddieMode = "open" | "distance_only" | "lockdown";
export type AiCaddieSurface = "phone" | "web" | "watch";

/**
 * Actions that may be blocked. The helper does not treat these strings
 * specially — they are surfaced verbatim in the audit row + analytics
 * event, so any new advice surface can register its own action label
 * without changing this file.
 */
export type AiCaddieAction =
  | "caddie_ask"
  | "club_recommendation"
  | "distance_yardage"
  | "wind_advice"
  | "hazard_warning"
  | "strategy_tip";

export class AiCaddieBlockedError extends Error {
  readonly statusCode = 403;
  constructor(
    public readonly mode: AiCaddieMode,
    public readonly surface: AiCaddieSurface,
    public readonly action: AiCaddieAction,
  ) {
    super(`AI Caddie ${action} blocked by ${mode} mode on ${surface}`);
    this.name = "AiCaddieBlockedError";
  }
}

export interface ResolveCtx {
  tournamentId?: number | null;
  leagueId?: number | null;
  generalPlayRoundId?: number | null;
  leagueRoundId?: number | null;
}

/**
 * Resolve the effective mode for the given context. Returns 'open' when
 * no scoping ids are supplied (e.g. a free-form caddie chat outside any
 * round) so we don't accidentally lock down general practice.
 */
export async function getEffectiveMode(ctx: ResolveCtx): Promise<AiCaddieMode> {
  // Per-round override (general play) wins.
  if (ctx.generalPlayRoundId) {
    const [row] = await db
      .select({ mode: generalPlayRoundsTable.aiCaddieMode })
      .from(generalPlayRoundsTable)
      .where(eq(generalPlayRoundsTable.id, ctx.generalPlayRoundId))
      .limit(1);
    if (row?.mode) return row.mode as AiCaddieMode;
  }

  // League round → underlying tournament + league lookup.
  let tournamentId = ctx.tournamentId ?? null;
  let leagueId = ctx.leagueId ?? null;
  if (!tournamentId && ctx.leagueRoundId) {
    const [lr] = await db
      .select({
        tournamentId: leagueRoundsTable.tournamentId,
        leagueId: leagueRoundsTable.leagueId,
      })
      .from(leagueRoundsTable)
      .where(eq(leagueRoundsTable.id, ctx.leagueRoundId))
      .limit(1);
    if (lr) {
      tournamentId = lr.tournamentId;
      leagueId = leagueId ?? lr.leagueId;
    }
  }

  if (tournamentId) {
    const [row] = await db
      .select({ mode: tournamentsTable.aiCaddieMode })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId))
      .limit(1);
    if (row?.mode && row.mode !== "open") return row.mode as AiCaddieMode;
  }

  if (leagueId) {
    const [row] = await db
      .select({ mode: leaguesTable.aiCaddieMode })
      .from(leaguesTable)
      .where(eq(leaguesTable.id, leagueId))
      .limit(1);
    if (row?.mode && row.mode !== "open") return row.mode as AiCaddieMode;
  }

  return "open";
}

interface AssertCtx extends ResolveCtx {
  organizationId?: number | null;
  userId?: number | null;
  surface: AiCaddieSurface;
  action: AiCaddieAction;
  metadata?: Record<string, unknown>;
}

/**
 * Returns the effective mode if the action is permitted, otherwise
 * writes one audit row + analytics event and throws AiCaddieBlockedError.
 *
 * Block rules:
 *   lockdown      → blocks everything
 *   distance_only → blocks every action EXCEPT 'distance_yardage'
 *   open          → blocks nothing
 */
export async function assertModeAllows(ctx: AssertCtx): Promise<AiCaddieMode> {
  const mode = await getEffectiveMode(ctx);

  const allowed =
    mode === "open" ||
    (mode === "distance_only" && ctx.action === "distance_yardage");

  if (allowed) return mode;

  // Best-effort audit write + analytics event. We never let a logging
  // failure mask the original block, so any throw is swallowed.
  try {
    await db.insert(aiCaddieModeBlocksTable).values({
      organizationId: ctx.organizationId ?? null,
      userId: ctx.userId ?? null,
      tournamentId: ctx.tournamentId ?? null,
      leagueId: ctx.leagueId ?? null,
      roundId: ctx.generalPlayRoundId ?? ctx.leagueRoundId ?? null,
      mode,
      surface: ctx.surface,
      action: ctx.action,
      metadata: ctx.metadata ?? {},
    });
  } catch (err) {
    console.warn("[aiCaddieMode] failed to write audit row", err);
  }

  try {
    track("ai_caddie_blocked", {
      mode,
      surface: ctx.surface,
      action: ctx.action,
      tournament_id: ctx.tournamentId ?? null,
      league_id: ctx.leagueId ?? null,
    }, {
      organizationId: ctx.organizationId ?? undefined,
      userId: ctx.userId ?? undefined,
    });
  } catch {
    // analytics is fire-and-forget already; swallow defensively.
  }

  throw new AiCaddieBlockedError(mode, ctx.surface, ctx.action);
}
