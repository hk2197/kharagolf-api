/**
 * Lazy handle on `expo-notifications`.
 *
 * `expo-notifications` is removed from Expo Go on Android (SDK 53+), so the
 * top-level `require()` is wrapped in a try/catch — without that the app
 * crashes on launch in Expo Go. Centralising the lazy-load here also gives
 * the test suite a single, easily-mocked seam (Task #1565) so the
 * notification-tap end-to-end spec can substitute a controllable fake
 * without having to reach into the real native module.
 */
type NotificationsType = typeof import("expo-notifications");

let cached: NotificationsType | null | undefined;

export function getNotificationsModule(): NotificationsType | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-notifications") as NotificationsType;
  } catch {
    cached = null;
  }
  return cached;
}
