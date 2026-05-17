/**
 * Health Connect bridge — TypeScript wrapper around the Android-only
 * `KharagolfHealthConnect` native module (see
 * `plugins/withHealthConnectBridge.js`).
 *
 * Reads the last 7 days of sleep, HRV, resting HR and steps from Google's
 * Health Connect SDK and pushes one row per day to
 * `POST /api/portal/wellness/daily` with `source: "google_fit"` (the wellness
 * store's existing identifier for Google's health graph). Also registers a
 * `health_connect` row in `wearable_connections` so the profile screen can
 * surface a "Health Connect connected" badge.
 *
 * All entry points are no-ops on iOS / web — call sites do not need to guard
 * by platform themselves.
 */

import { NativeModules, Platform } from "react-native";
import { BASE_URL } from "@/utils/api";

interface KharagolfHealthConnectModule {
  isAvailable(): Promise<boolean>;
  requestAuthorization(): Promise<boolean>;
  readLast7Days(): Promise<HealthConnectDay[]>;
}

export interface HealthConnectDay {
  date: string;          // YYYY-MM-DD
  sleepMinutes?: number | null;
  hrvMs?: number | null;
  restingHr?: number | null;
  steps?: number | null;
}

const Native: KharagolfHealthConnectModule | null =
  Platform.OS === "android" ? (NativeModules.KharagolfHealthConnect ?? null) : null;

export function isHealthConnectSupported(): boolean {
  return Platform.OS === "android" && Native != null;
}

export async function isHealthConnectAvailable(): Promise<boolean> {
  if (!Native) return false;
  try { return await Native.isAvailable(); } catch { return false; }
}

/**
 * Triggers Health Connect's permission sheet. Returns true when every
 * requested read scope was granted by the user. Unlike Apple Health, Health
 * Connect *does* report granted scopes back to the caller, so this signal is
 * authoritative.
 */
export async function requestHealthConnectAuthorization(): Promise<boolean> {
  if (!Native) return false;
  try { return await Native.requestAuthorization(); } catch { return false; }
}

export async function readHealthConnectLast7Days(): Promise<HealthConnectDay[]> {
  if (!Native) return [];
  try { return await Native.readLast7Days(); } catch { return []; }
}

/** Push a single day's snapshot to the wellness store. */
async function pushDay(token: string, day: HealthConnectDay): Promise<boolean> {
  if (!day.date) return false;
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
        // Health Connect is Google's unified health graph — the wellness
        // store already accepts "google_fit" as a valid source for this
        // shape of data, so we reuse it rather than minting a new column.
        source: "google_fit",
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
      body: JSON.stringify({ provider: "health_connect" }),
    });
  } catch { /* network — leave for next sync attempt */ }
}

export interface HealthConnectSyncResult {
  supported: boolean;
  authorized: boolean;
  daysWritten: number;
  daysRead: number;
}

/**
 * Read the last 7 days from Health Connect and POST each day to the wellness
 * endpoint. Used both on app launch and after a round finishes. Safe to call
 * on every platform — returns `{ supported: false }` when the bridge is
 * unavailable (iOS, web, Expo Go without the dev client).
 */
export async function syncHealthConnectLast7Days(token: string): Promise<HealthConnectSyncResult> {
  if (!isHealthConnectSupported()) {
    return { supported: false, authorized: false, daysWritten: 0, daysRead: 0 };
  }
  const ok = await requestHealthConnectAuthorization();
  const days = await readHealthConnectLast7Days();
  let written = 0;
  for (const d of days) {
    if (await pushDay(token, d)) written += 1;
  }
  // Only flip the connection badge on once we've actually written something —
  // avoids a permanent "Connected" badge when the user denied every scope.
  if (written > 0) await markConnected(token);
  return { supported: true, authorized: ok, daysWritten: written, daysRead: days.length };
}
