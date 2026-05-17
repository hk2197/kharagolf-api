/**
 * Lazy accessor for the `expo-notifications` native module.
 *
 * The module is removed from Expo Go on Android (SDK 53+), so importing
 * it statically would crash at app boot. We `require` it inside a
 * try/catch and return `null` when unavailable. Centralising the
 * lazy-load here also makes it trivial to mock in unit tests
 * (`vi.mock("@/utils/expoNotifications", ...)`).
 */
export type ExpoNotificationsModule = typeof import("expo-notifications");

let cached: ExpoNotificationsModule | null | undefined;

export function getExpoNotifications(): ExpoNotificationsModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-notifications") as ExpoNotificationsModule;
  } catch {
    cached = null;
  }
  return cached;
}
