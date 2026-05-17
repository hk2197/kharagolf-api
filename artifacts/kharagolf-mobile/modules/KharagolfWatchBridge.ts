import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const { KharagolfWatchBridge: _bridge } = NativeModules;

/**
 * Convert a `KharagolfWatchSettingsChanged` event payload into the integer
 * percent shown on the phone-side Watch Settings slider. Returns `null`
 * when the payload is missing / malformed so the caller can ignore it.
 *
 * Mirrors the inline logic in `app/(tabs)/score.tsx` so the watch -> phone
 * threshold-sync forwarding path (Task #826) can be unit-tested without
 * mounting the full Score screen.
 */
export function deriveWatchBatteryAutoPctFromEvent(
  evt: { batteryAutoThreshold?: number } | undefined | null,
): number | null {
  const raw = evt?.batteryAutoThreshold;
  if (typeof raw !== "number" || !isFinite(raw)) return null;
  const clamped = Math.max(0.05, Math.min(0.95, raw));
  const pct = Math.round(clamped * 100);
  // Match the 10–50% bound enforced by the on-watch nudger so an off-grid
  // push (defensive) snaps back into the supported range.
  return Math.max(10, Math.min(50, pct));
}

/**
 * Subscribe to watch -> phone settings nudges (currently just the
 * battery-auto threshold). Calls [onChange] with the integer percent each
 * time the watch forwards a new value via the native bridge.
 *
 * Returns a `{ remove }` handle compatible with `useEffect` cleanup.
 */
export function subscribeWatchBatteryAutoPct(
  onChange: (pct: number) => void,
): { remove: () => void } {
  if (!_bridge) return { remove: () => {} };
  const emitter = new NativeEventEmitter(_bridge);
  const sub = emitter.addListener(
    "KharagolfWatchSettingsChanged",
    (evt: { batteryAutoThreshold?: number } | undefined) => {
      const pct = deriveWatchBatteryAutoPctFromEvent(evt);
      if (pct !== null) onChange(pct);
    },
  );
  return { remove: () => { try { sub.remove(); } catch { /* noop */ } } };
}

export interface WatchSettingsPayload {
  /** Battery-saver — suppresses haptics and pauses the aim sensor stream on the watch. */
  batteryMode: boolean;
  /** Master toggle for the haptic green-targeting feature. */
  hapticTargetingEnabled: boolean;
  /** Master toggle for voice score entry. */
  voiceEntryEnabled: boolean;
  /**
   * Fractional battery level (0.0–1.0) at or below which the watch should
   * auto-enable battery mode. Defaults to 0.30 if not provided. Persisted
   * native-side (App Group on iOS, SharedPreferences on Wear OS) so the
   * watcher can honour it without a round-trip to the phone.
   */
  batteryAutoThreshold?: number;
}

export const WatchBridge = {
  async pushToken(token: string): Promise<void> {
    if (!_bridge?.pushToken) return;
    return _bridge.pushToken(token);
  },

  async pushChallenge(code: string, challengeId: string): Promise<void> {
    if (!_bridge?.pushChallenge) return;
    return _bridge.pushChallenge(code, challengeId);
  },

  async pushHoleContext(
    tournamentId: number,
    playerId: number,
    round: number,
    holeNumber: number,
    par: number,
  ): Promise<void> {
    if (!_bridge?.pushHoleContext) return;
    return _bridge.pushHoleContext(tournamentId, playerId, round, holeNumber, par);
  },

  // Task #358 — push GPS distance + plays-like adjustment to the watch.
  async pushPlaysLike(
    holeNumber: number,
    rawYards: number,
    playsLikeYards: number,
    windAdj: number,
    elevAdj: number,
  ): Promise<void> {
    if (!_bridge?.pushPlaysLike) return;
    return _bridge.pushPlaysLike(holeNumber, rawYards, playsLikeYards, windAdj, elevAdj);
  },

  /**
   * Task #431 — tell the paired watch to begin streaming heart-rate samples
   * for the current round. The native bridge stashes `authToken` + `baseURL`
   * so it can forward inbound `hr.samples` batches received from the watch
   * to POST `${baseURL}/api/portal/hr-samples` until `hrStop()` is called.
   *
   * `context` carries the current tournament/round/hole/shot tagging that
   * each forwarded sample should be stamped with on the watch side.
   */
  async hrStart(
    authToken: string,
    baseURL: string,
    context: {
      tournamentId?: number | null;
      generalPlayRoundId?: number | null;
      playerId?: number | null;
      round?: number | null;
      holeNumber?: number | null;
      shotNumber?: number | null;
    },
  ): Promise<void> {
    if (!_bridge?.hrStart) return;
    return _bridge.hrStart(authToken, baseURL, context);
  },

  /** Task #431 — tell the paired watch to stop sampling and clear the auth token. */
  async hrStop(): Promise<void> {
    if (!_bridge?.hrStop) return;
    return _bridge.hrStop();
  },

  /** Task #431 — push fresh per-shot/per-hole context to tag subsequent samples. */
  async hrPushContext(context: {
    tournamentId?: number | null;
    generalPlayRoundId?: number | null;
    playerId?: number | null;
    round?: number | null;
    holeNumber?: number | null;
    shotNumber?: number | null;
  }): Promise<void> {
    if (!_bridge?.hrPushContext) return;
    return _bridge.hrPushContext(context);
  },

  /**
   * Push the user's watch UX preferences (battery mode, feature toggles) to the
   * paired watch app. Native bridges persist them in App Group UserDefaults
   * (iOS) or SharedPreferences (Wear OS) so background services can honour
   * them without a round-trip.
   */
  async pushSettings(settings: WatchSettingsPayload): Promise<void> {
    if (!_bridge?.pushSettings) return;
    return _bridge.pushSettings(
      !!settings.batteryMode,
      !!settings.hapticTargetingEnabled,
      !!settings.voiceEntryEnabled,
      // Default 30 % matches the watch-side fallback so a payload from an
      // older app version that doesn't carry this field still results in the
      // documented behaviour.
      typeof settings.batteryAutoThreshold === "number"
        ? Math.max(0.05, Math.min(0.95, settings.batteryAutoThreshold))
        : 0.30,
    );
  },

  isAvailable(): boolean {
    return !!_bridge && (Platform.OS === "ios" || Platform.OS === "android");
  },
};
