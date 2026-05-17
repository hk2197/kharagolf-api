/**
 * Background Apple Health sync.
 *
 * Schedules an iOS BGAppRefreshTask (via `expo-background-task`) that wakes the
 * app roughly once a day and pushes the latest 7 days of HealthKit metrics to
 * the wellness store. Without this, the readiness card would show stale data
 * for players who don't open the app for several days.
 *
 * iOS-only — Android does not get a background HealthKit equivalent (the
 * native bridge is iOS-only). On every other platform every export here is a
 * no-op.
 *
 * Important: `TaskManager.defineTask` must be called at module top-level so
 * the task body is registered before the JS runtime is asked to run it from a
 * cold launch in the background. Importing this module from `_layout.tsx`
 * (the app entry) is enough to satisfy that requirement.
 */

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";

import { isAppleHealthSupported, syncAppleHealthLast7Days } from "@/utils/appleHealth";

export const BACKGROUND_HEALTH_SYNC_TASK = "kharagolf-apple-health-sync";

// Mirrors TOKEN_KEY in context/auth.tsx — read directly from SecureStore so the
// background task does not need a React context.
const TOKEN_KEY = "kharagolf_player_token";

// Roughly once per day. iOS treats this as a minimum and may run the task less
// often (the system batches background work into power-friendly windows).
const DAILY_INTERVAL_MINUTES = 24 * 60;

// Define the task body at module scope so it survives a cold background launch.
// On non-iOS platforms TaskManager is still available but the task will never
// actually fire because we never register it.
if (Platform.OS === "ios") {
  // Guard against double-define during fast refresh in development.
  if (!TaskManager.isTaskDefined(BACKGROUND_HEALTH_SYNC_TASK)) {
    TaskManager.defineTask(BACKGROUND_HEALTH_SYNC_TASK, async () => {
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!token) {
          // No signed-in player — nothing to sync. Reporting Success keeps iOS
          // willing to schedule us again tomorrow.
          return BackgroundTask.BackgroundTaskResult.Success;
        }
        await syncAppleHealthLast7Days(token);
        return BackgroundTask.BackgroundTaskResult.Success;
      } catch {
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  }
}

/**
 * Register the daily background refresh. Safe to call repeatedly — the
 * underlying API is idempotent and we additionally early-return on platforms
 * where HealthKit is not available.
 */
export async function registerBackgroundHealthSync(): Promise<void> {
  if (Platform.OS !== "ios" || !isAppleHealthSupported()) return;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_HEALTH_SYNC_TASK);
    if (already) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_HEALTH_SYNC_TASK, {
      minimumInterval: DAILY_INTERVAL_MINUTES,
    });
  } catch {
    // Background scheduling is best-effort; foreground syncs still cover the
    // user when they next open the app.
  }
}

/** Cancel the background refresh — used on logout so we don't keep waking. */
export async function unregisterBackgroundHealthSync(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_HEALTH_SYNC_TASK);
    if (!already) return;
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_HEALTH_SYNC_TASK);
  } catch { /* ignore */ }
}
