import { db } from "@workspace/db";
import { deviceTokensTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoPushMessage {
  to: string | string[];
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  priority?: "default" | "normal" | "high";
  channelId?: string;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushDeliveryResult {
  attempted: number;
  sent: number;
  failed: number;
  invalid: number;
}

/**
 * High-level outcome of a `sendPushToUsers` call from a notify-helper's
 * point of view.
 *
 *   - `sent`        — at least one device ticket came back ok.
 *   - `failed`      — Expo (or our HTTP layer) returned an error for one or
 *                     more tickets. This is a real delivery problem worth
 *                     surfacing in alerting / dashboards.
 *   - `no_address`  — there was nothing to deliver to: the recipient has
 *                     no device tokens registered, every registered token
 *                     was non-Expo / invalid, or `userIds` was empty.
 *                     This is a benign outcome and MUST NOT be reported as
 *                     a failure (Task #1070).
 */
export type PushDeliveryStatus = "sent" | "failed" | "no_address";

/**
 * Map a {@link PushDeliveryResult} to the high-level status used by every
 * notify helper in `src/lib/*Notify*.ts`. Centralised here so call sites
 * cannot drift back into treating "no Expo tokens registered" as a
 * delivery failure.
 *
 * Decision rule:
 *   1. Any successful ticket  → `sent`.
 *   2. Any failed ticket / batch error → `failed`.
 *   3. Otherwise (attempted=0, no rows, or all tokens invalid) → `no_address`.
 */
export function classifyPushDelivery(result: PushDeliveryResult): PushDeliveryStatus {
  if (result.sent > 0) return "sent";
  if (result.failed > 0) return "failed";
  return "no_address";
}

export async function sendPushToUsers(
  userIds: number[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<PushDeliveryResult> {
  const result: PushDeliveryResult = { attempted: userIds.length, sent: 0, failed: 0, invalid: 0 };
  if (userIds.length === 0) return result;

  const rows = await db
    .select({ token: deviceTokensTable.token })
    .from(deviceTokensTable)
    .where(inArray(deviceTokensTable.userId, userIds));

  if (rows.length === 0) return result;

  const validMessages: ExpoPushMessage[] = [];
  for (const r of rows) {
    if (r.token.startsWith("ExponentPushToken[") || r.token.startsWith("ExpoPushToken[")) {
      validMessages.push({ to: r.token, title, body, sound: "default", priority: "high", data });
    } else {
      result.invalid++;
    }
  }

  if (validMessages.length === 0) return result;

  // Chunk into batches of 100 (Expo's limit)
  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < validMessages.length; i += 100) {
    chunks.push(validMessages.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        console.warn("[push] Expo API error:", res.status, await res.text());
        result.failed += chunk.length;
        continue;
      }

      const json = await res.json() as { data?: ExpoPushTicket[] };
      const tickets = json.data ?? [];
      for (let i = 0; i < chunk.length; i++) {
        const ticket = tickets[i];
        if (!ticket || ticket.status === "error") {
          console.warn("[push] Ticket error:", ticket?.message, ticket?.details);
          result.failed++;
        } else {
          result.sent++;
        }
      }
    } catch (err) {
      console.warn("[push] Failed to send push notification:", err);
      result.failed += chunk.length;
    }
  }

  return result;
}

export async function registerDeviceToken(userId: number, token: string, platform = "expo"): Promise<void> {
  await db
    .insert(deviceTokensTable)
    .values({ userId, token, platform, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [deviceTokensTable.userId, deviceTokensTable.token],
      set: { platform, updatedAt: new Date() },
    });
}

export async function unregisterDeviceToken(userId: number, token: string): Promise<void> {
  await db
    .delete(deviceTokensTable)
    .where(and(
      eq(deviceTokensTable.userId, userId),
      eq(deviceTokensTable.token, token),
    ));
}
