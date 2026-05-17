import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Pressable, Text, StyleSheet, BackHandler } from "react-native";
import AdSlot, { type AdDelivery } from "./AdSlot";
import { useActiveClub } from "@/context/activeClub";

/**
 * Fullscreen sponsor splash shown once per app session when a `mobile_splash`
 * creative is eligible. Auto-dismisses after the slot's rotation time, or the
 * user can tap "Skip" to close it. Tapping the ad itself opens the sponsor
 * link via AdSlot's built-in click handler.
 *
 * Implementation note: AdSlot is mounted exactly once and renders the splash
 * inside an absolutely-positioned overlay. The overlay is invisible and not
 * interactive until AdSlot signals onLoaded, so a pending or empty delivery
 * never blocks the app behind a blank fullscreen view. Because AdSlot mounts
 * only once, exactly one impression is logged per displayed splash.
 */
export default function SponsorSplash() {
  const { activeOrgId } = useActiveClub();
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the active club changes, allow the splash to show again for the new
  // org (subject to a fresh delivery being eligible).
  useEffect(() => {
    setDismissed(false);
    setShown(false);
  }, [activeOrgId]);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  const dismiss = useCallback(() => {
    clearTimer();
    setDismissed(true);
    setShown(false);
  }, [clearTimer]);

  const handleLoaded = useCallback((d: AdDelivery) => {
    setShown(true);
    const sec = d.slot?.rotationSeconds ?? 4;
    if (sec > 0) {
      clearTimer();
      timeoutRef.current = setTimeout(() => dismiss(), sec * 1000);
    }
  }, [clearTimer, dismiss]);

  const handleEmpty = useCallback(() => {
    setDismissed(true);
  }, []);

  // Hardware back on Android dismisses the overlay while it's showing.
  useEffect(() => {
    if (!shown) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [shown, dismiss]);

  if (!activeOrgId || dismissed) return null;

  return (
    <View
      // Until the creative loads, the overlay is invisible and ignores touches
      // so the underlying app remains fully usable.
      style={[styles.overlay, shown ? styles.overlayShown : styles.overlayHidden]}
      pointerEvents={shown ? "auto" : "none"}
      accessibilityViewIsModal={shown}
    >
      <View style={styles.adWrap}>
        <AdSlot
          orgId={activeOrgId}
          slotKey="mobile_splash"
          rotate={false}
          onLoaded={handleLoaded}
          onEmpty={handleEmpty}
        />
      </View>
      {shown ? (
        <Pressable style={styles.skip} onPress={dismiss} accessibilityRole="button">
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: "center", alignItems: "center",
  },
  overlayHidden: { opacity: 0 },
  overlayShown: { opacity: 1, backgroundColor: "#000" },
  adWrap: { width: "100%", height: "100%" },
  skip: {
    position: "absolute", top: 48, right: 16,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
  },
  skipText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
