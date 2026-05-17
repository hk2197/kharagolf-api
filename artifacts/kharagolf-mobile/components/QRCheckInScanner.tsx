import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";

export interface QRScannerProps {
  visible: boolean;
  token: string;
  onClose: () => void;
}

export function QRCheckInScanner({ visible, token, onClose }: QRScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  // Task #1178 (audit follow-up to #1014) — `scanned` MUST be a ref, not
  // useState. expo-camera's onBarcodeScanned can fire multiple times in a
  // single JS tick (one per detected frame); with a state-backed gate the
  // queued callbacks all observe the stale `false` before React commits
  // setScanned(true) and each fires their own /checkin POST → duplicate
  // check-ins. A ref mutates synchronously so the second invocation sees
  // `true` immediately and bails. Same anti-pattern as the feed reel
  // viewLoggedRef fix in #1014. Don't regress this back to useState.
  // Regression test: __tests__/qr-checkin-scanner-double-scan.test.tsx
  const scannedRef = useRef(false);
  const [result, setResult] = useState<{ success: boolean; message: string; playerName?: string } | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleScan = useCallback(async ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setProcessing(true);
    try {
      // Expected format: KHGF:ci:<orgId>:<tournamentId>:<playerId>
      const parts = data.split(":");
      if (parts.length !== 5 || parts[0] !== "KHGF" || parts[1] !== "ci") {
        setResult({ success: false, message: "Invalid QR code. Please scan a KHARAGOLF player check-in code." });
        return;
      }
      const orgId = parseInt(parts[2]);
      const tournamentId = parseInt(parts[3]);
      const playerId = parseInt(parts[4]);
      if (isNaN(orgId) || isNaN(tournamentId) || isNaN(playerId)) {
        setResult({ success: false, message: "Malformed check-in QR code." });
        return;
      }
      const resp = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${playerId}/checkin`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } }
      );
      const body = await resp.json().catch(() => ({}));
      if (resp.ok) {
        const playerName = body.firstName && body.lastName ? `${body.firstName} ${body.lastName}` : "Player";
        setResult({ success: true, message: "Checked in successfully!", playerName });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setResult({ success: false, message: body.error ?? `Check-in failed (${resp.status})` });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch {
      setResult({ success: false, message: "Network error. Please check your connection." });
    } finally {
      setProcessing(false);
    }
  }, [token]);

  const resetScan = () => { scannedRef.current = false; setResult(null); };

  // Task #1628 — Reset scanner state whenever the modal transitions from
  // hidden → visible so a volunteer who closed it mid-flow (e.g. tapped X
  // to dismiss the success card) returns to the live camera on reopen
  // instead of the stale previous result card. The double-scan guard from
  // #1178 / #1362 still holds *within* a single open session because this
  // only fires on the false → true edge.
  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      setResult(null);
    }
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={scannerStyles.container}
        accessibilityViewIsModal
        importantForAccessibility="yes"
      >
        <View style={scannerStyles.header}>
          <Text
            style={scannerStyles.headerTitle}
            accessibilityRole="header"
          >
            Scan Check-In QR
          </Text>
          <Pressable
            onPress={onClose}
            style={scannerStyles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="Close QR scanner"
          >
            <Feather name="x" size={22} color={Colors.text} accessible={false} />
          </Pressable>
        </View>
        {!permission ? (
          <View style={scannerStyles.centered}><ActivityIndicator color={Colors.primary} /></View>
        ) : !permission.granted ? (
          <View style={scannerStyles.centered}>
            <Feather name="camera-off" size={48} color={Colors.muted} />
            <Text style={scannerStyles.permText}>Camera access required</Text>
            <Pressable onPress={requestPermission} style={scannerStyles.permBtn}>
              <Text style={scannerStyles.permBtnText}>Grant Permission</Text>
            </Pressable>
          </View>
        ) : result ? (
          <View style={scannerStyles.resultContainer}>
            <View style={[scannerStyles.resultCard, { borderColor: result.success ? Colors.primary : "#EF4444" }]}>
              <Feather
                name={result.success ? "check-circle" : "x-circle"}
                size={52}
                color={result.success ? Colors.primary : "#EF4444"}
              />
              {result.playerName && <Text style={scannerStyles.playerName}>{result.playerName}</Text>}
              <Text style={[scannerStyles.resultMsg, { color: result.success ? Colors.primary : "#EF4444" }]}>
                {result.message}
              </Text>
              <Pressable onPress={resetScan} style={scannerStyles.scanAgainBtn}>
                <Text style={scannerStyles.scanAgainText}>Scan Another</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              onBarcodeScanned={handleScan}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            />
            {processing && (
              <View style={scannerStyles.processingOverlay}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={scannerStyles.processingText}>Processing...</Text>
              </View>
            )}
            <View style={scannerStyles.scanOverlay} pointerEvents="none">
              <View style={scannerStyles.scanFrame} />
              <Text style={scannerStyles.scanHint}>Point camera at a player's check-in QR code</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

export default QRCheckInScanner;

const scannerStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)", paddingTop: 56,
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, fontFamily: "Inter_700Bold" },
  closeBtn: { padding: 8, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.06)" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  permText: { fontSize: 16, color: Colors.textSecondary, textAlign: "center", fontFamily: "Inter_400Regular" },
  permBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permBtnText: { color: "#0D1117", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
  scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  scanFrame: {
    width: 220, height: 220, borderRadius: 18,
    borderWidth: 3, borderColor: Colors.primary,
    backgroundColor: "transparent",
    shadowColor: Colors.primary, shadowRadius: 20, shadowOpacity: 0.6,
  },
  scanHint: {
    position: "absolute", bottom: 80, color: Colors.text,
    fontSize: 14, fontFamily: "Inter_400Regular",
    textAlign: "center", paddingHorizontal: 32,
    backgroundColor: "rgba(11,21,18,0.8)", borderRadius: 10, padding: 10,
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(11,21,18,0.8)",
    alignItems: "center", justifyContent: "center", gap: 12,
  },
  processingText: { color: Colors.text, fontSize: 16, fontFamily: "Inter_500Medium" },
  resultContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  resultCard: {
    width: "100%", maxWidth: 340, borderRadius: 20, borderWidth: 2,
    backgroundColor: "rgba(11,21,18,0.9)", padding: 32,
    alignItems: "center", gap: 12,
  },
  playerName: { fontSize: 22, fontWeight: "700", color: Colors.text, fontFamily: "Inter_700Bold", textAlign: "center" },
  resultMsg: { fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center" },
  scanAgainBtn: { marginTop: 8, backgroundColor: Colors.primary, borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  scanAgainText: { color: "#0D1117", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
});
