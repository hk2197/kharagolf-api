/**
 * Apple Health bridge — TypeScript wrapper around the iOS-only
 * `KharagolfHealthKit` native module (see `plugins/withHealthKitBridge.js`).
 *
 * Reads the last 7 days of sleep, HRV, resting HR and steps from HealthKit
 * and pushes one row per day to `POST /api/portal/wellness/daily` with
 * `source: "apple_health"`. Also registers an `apple_health` row in
 * `wearable_connections` so the profile screen can surface a "connected"
 * badge.
 *
 * All entry points are no-ops on Android / web — call sites do not need to
 * guard by platform themselves.
 */

import { NativeModules, Platform } from "react-native";
import { BASE_URL } from "@/utils/api";

interface KharagolfHealthKitModule {
  isAvailable(): Promise<boolean>;
  requestAuthorization(): Promise<boolean>;
  readLast7Days(): Promise<HealthKitDay[]>;
}

export interface HealthKitDay {
  date: string;          // YYYY-MM-DD
  sleepMinutes?: number;
  hrvMs?: number;
  restingHr?: number;
  steps?: number;
}

const Native: KharagolfHealthKitModule | null =
  Platform.OS === "ios" ? (NativeModules.KharagolfHealthKit ?? null) : null;

export function isAppleHealthSupported(): boolean {
  return Platform.OS === "ios" && Native != null;
}

export async function isAppleHealthAvailable(): Promise<boolean> {
  if (!Native) return false;
  try { return await Native.isAvailable(); } catch { return false; }
}

/**
 * Triggers the standard HealthKit consent prompt (no-op if previously
 * granted/denied — iOS shows the sheet only on first request per type).
 * Returns true when the request completed successfully; iOS deliberately
 * does not reveal whether the user granted read access for privacy reasons,
 * so callers should follow up with `readLast7Days()` and check whether any
 * data flowed back.
 */
export async function requestAppleHealthAuthorization(): Promise<boolean> {
  if (!Native) return false;
  try { return await Native.requestAuthorization(); } catch { return false; }
}

export async function readAppleHealthLast7Days(): Promise<HealthKitDay[]> {
  if (!Native) return [];
  try { return await Native.readLast7Days(); } catch { return []; }
}

/** Push a single day's snapshot to the wellness store. */
async function pushDay(token: string, day: HealthKitDay): Promise<boolean> {
  if (!day.date) return false;
  // Skip days that contain no metrics at all — there's nothing to record and
  // upserting an empty row would clobber any future better data for the day.
  const hasAny =
    day.sleepMinutes != null || day.hrvMs != null ||
    day.restingHr != null || day.steps != null;
  if (!hasAny) return false;
  try {
    const res = await fetch(`${BASE_URL}/api/portal/wellness/daily`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        metricDate: day.date,
        source: "apple_health",
        sleepMinutes: day.sleepMinutes ?? null,
        hrvMs: day.hrvMs ?? null,
        restingHr: day.restingHr ?? null,
        steps: day.steps ?? null,
      }),
    });
    return res.ok;
  } catch { return false; }
}

/** Fire-and-forget upsert that the connection row exists with status=connected. */
async function markConnected(token: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/portal/wearable-connections`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider: "apple_health" }),
    });
  } catch { /* network — leave for next sync attempt */ }
}

export interface SyncResult {
  supported: boolean;
  authorized: boolean;
  daysWritten: number;
  daysRead: number;
}

/**
 * Read the last 7 days from HealthKit and POST each day to the wellness
 * endpoint. Used both on app launch and after a round finishes. Safe to
 * call on every platform — returns `{ supported: false }` when the bridge
 * is unavailable (Android, web, Expo Go without the dev client).
 */
export async function syncAppleHealthLast7Days(token: string): Promise<SyncResult> {
  if (!isAppleHealthSupported()) {
    return { supported: false, authorized: false, daysWritten: 0, daysRead: 0 };
  }
  const ok = await requestAppleHealthAuthorization();
  const days = await readAppleHealthLast7Days();
  let written = 0;
  for (const d of days) {
    if (await pushDay(token, d)) written += 1;
  }
  // Only flip the connection badge on once we've actually written something —
  // avoids a permanent "Connected" badge when the user denied every read scope.
  if (written > 0) await markConnected(token);
  return { supported: true, authorized: ok, daysWritten: written, daysRead: days.length };
}
