import { db } from "@workspace/db";
import {
  spectatorFollowsTable, playersTable, teeTimePlayersTable, appUsersTable,
} from "@workspace/db";
import { eq, and, or, inArray, type SQL } from "drizzle-orm";
import { sendPushToUsers } from "./push";
import { logger } from "./logger";
import type { ScoringEvent } from "./realtime";
import { translateSpectatorPush } from "./spectatorPushI18n";

type EventKind = ScoringEvent["eventType"];

function prefFilter(eventType: EventKind): SQL | null {
  switch (eventType) {
    case "hole_in_one": return eq(spectatorFollowsTable.notifyHio, true);
    case "eagle": return eq(spectatorFollowsTable.notifyEagle, true);
    case "birdie": return eq(spectatorFollowsTable.notifyBirdie, true);
    case "round_start": return eq(spectatorFollowsTable.notifyRoundStart, true);
    case "round_finish": return eq(spectatorFollowsTable.notifyRoundFinish, true);
    case "tee_off": return eq(spectatorFollowsTable.notifyTeeOff, true);
    default: return null;
  }
}

/**
 * Find spectator follows that target a specific player (directly or via the
 * player's tee-time group), filtered by the per-event opt-in column.
 * Returns the userIds of subscribers who should receive a push.
 */
async function resolveSubscriberUserIds(
  tournamentId: number,
  playerId: number | undefined,
  eventType: EventKind,
): Promise<number[]> {
  const pref = prefFilter(eventType);
  if (!pref || !playerId) return [];

  const groupRows = await db
    .select({ teeTimeId: teeTimePlayersTable.teeTimeId })
    .from(teeTimePlayersTable)
    .where(eq(teeTimePlayersTable.playerId, playerId));
  const teeTimeIds = [...new Set(groupRows.map(r => r.teeTimeId))];

  const targetConditions: SQL[] = [eq(spectatorFollowsTable.playerId, playerId)];
  if (teeTimeIds.length > 0) {
    targetConditions.push(inArray(spectatorFollowsTable.teeTimeId, teeTimeIds));
  }

  const rows = await db
    .select({ userId: spectatorFollowsTable.userId })
    .from(spectatorFollowsTable)
    .where(and(
      eq(spectatorFollowsTable.tournamentId, tournamentId),
      or(...targetConditions)!,
      pref,
    ));

  return [...new Set(rows.map(r => r.userId))];
}

/**
 * Group a set of userIds by their stored preferredLanguage so we can send
 * one push batch per language with localised copy.
 */
async function groupUserIdsByLanguage(
  userIds: number[],
): Promise<Map<string, number[]>> {
  const grouped = new Map<string, number[]>();
  if (userIds.length === 0) return grouped;

  const rows = await db
    .select({
      id: appUsersTable.id,
      lang: appUsersTable.preferredLanguage,
    })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, userIds));

  const seen = new Set<number>();
  for (const r of rows) {
    seen.add(r.id);
    const lang = r.lang ?? "en";
    const bucket = grouped.get(lang);
    if (bucket) bucket.push(r.id);
    else grouped.set(lang, [r.id]);
  }
  // Anyone we couldn't resolve (shouldn't happen) defaults to English.
  for (const id of userIds) {
    if (!seen.has(id)) {
      const bucket = grouped.get("en");
      if (bucket) bucket.push(id);
      else grouped.set("en", [id]);
    }
  }
  return grouped;
}

/**
 * Deliver granular push to spectator followers for a notable event.
 * Fire-and-forget — never throws. Each recipient receives the push in
 * their own preferred language (falling back to English).
 *
 * Task #1240 — although this file is named `*Notify*.ts`, it deliberately
 * does NOT route the per-language batch result through
 * `classifyPushDelivery` (the shared mapping introduced in Task #1070):
 * the helper is fire-and-forget, no caller branches on a "failed" status,
 * and the spectator-test admin debug endpoint at
 * `POST /api/portal/spectator-test-push` is the surface that does report
 * delivery classification (it routes through `classifyPushDelivery`
 * itself). Followers without a registered Expo token simply do not see
 * the alert — the same outcome as every other notify helper.
 */
export async function deliverSpectatorPush(event: ScoringEvent): Promise<void> {
  try {
    if (!event.playerId) return;
    const userIds = await resolveSubscriberUserIds(event.tournamentId, event.playerId, event.eventType);
    if (userIds.length === 0) return;

    const byLang = await groupUserIdsByLanguage(userIds);
    const data = {
      type: `spectator_${event.eventType}`,
      tournamentId: event.tournamentId,
      playerId: event.playerId,
      playerName: event.playerName,
      holeNumber: event.holeNumber,
      round: event.round,
    };

    await Promise.all(
      Array.from(byLang.entries()).map(async ([lang, ids]) => {
        const { title, body } = translateSpectatorPush(lang, event);
        await sendPushToUsers(ids, title, body, { ...data, lang });
      }),
    );
  } catch (err) {
    logger.warn({ err, event }, "[spectatorNotify] push delivery failed (non-fatal)");
  }
}

/**
 * Resolve the userId for a player record (for self-exclusion when needed).
 */
export async function getPlayerUserId(playerId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: playersTable.userId })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));
  return row?.userId ?? null;
}
