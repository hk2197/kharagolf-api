import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  LayoutChangeEvent,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import Svg, { Line as SvgLine, Circle as SvgCircle, Polyline as SvgPolyline, Path as SvgPath, Rect as SvgRect } from "react-native-svg";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Video, ResizeMode, Audio, AVPlaybackStatus } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";
import {
  loadCoachDrawingClipboard,
  saveCoachDrawingClipboard,
} from "@/utils/coachDrawingClipboard";
import {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  type CoachPayoutChannelLabel,
  type CoachPayoutNotificationAttempt,
  coachPayoutChannelLabel,
  coachPayoutChannelText,
  coachPayoutChannelColors,
  coachPayoutBothChannelsNonSent,
  coachPayoutRetryState,
  formatCoachPayoutRetryCountdown,
  coachPayoutTriedTargetLabel,
  coachPayoutUpdatePrefsLinkLabel,
  coachPayoutShouldShowSupportHint,
} from "@workspace/coach-payout-labels";
import { useTranslation } from "react-i18next";
import {
  computeVoiceSyncAction,
  parseVoiceOverDurationMs,
  shouldRunVoiceSync,
} from "@workspace/voice-over-sync";
import { router, useLocalSearchParams } from "expo-router";

let RazorpayCheckout: { open: (opts: RzpOptions) => Promise<RzpSuccess> } | null = null;
try {
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface RzpOptions {
  key: string; order_id: string; amount: number; currency: string;
  name: string; description: string;
  prefill?: { name?: string; email?: string };
}
interface RzpSuccess { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }

interface SwingVideo {
  id: number; title: string | null; videoUrl: string;
  thumbnailUrl: string | null; club: string | null; view: string;
  notes: string | null; capturedAt: string;
  // Task #1052 — true source frame rate (detected on upload or by an earlier
  // viewer). Null until a real value is known.
  fps?: number | string | null;
}

interface Coach {
  proId: number; organizationId: number; organizationName: string | null;
  displayName: string; bio: string | null; photoUrl: string | null;
  specialisms: string[]; certifications: string[]; yearsExperience: number;
  hourlyRatePaise: number; asyncReviewPricePaise: number;
  acceptsInPerson: boolean; acceptsAsync: boolean;
  asyncTurnaroundHours: number;
  ratingsAvg: number; ratingsCount: number;
}

interface MyReviewRequest {
  request: {
    id: number; status: string; pricePaise: number;
    memberPrompt: string | null; createdAt: string; deliveredAt: string | null;
    rating: number | null; annotationId: number | null;
  };
  proName: string; proPhoto: string | null;
  videoUrl: string; videoThumb: string | null;
}

const GOLD = "#C9A84C";
const TABS = ["library", "find", "requests", "coach"] as const;
type TabKey = typeof TABS[number];

const formatRupees = (paise: number) => `₹${(paise / 100).toFixed(0)}`;

// Task #1052 — render the detected source frame rate the same way coaches see
// it on the delivery canvas, so golfers and reviewers can confirm slow-mo
// uploads were captured at the speed they expect.
const formatFpsLabel = (raw: unknown): string => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? `${Math.round(n)}fps` : "detecting…";
};

export default function CoachScreen() {
  const insets = useSafeAreaInsets();
  const { user, token } = useAuth();
  // Allow deep-link callers (e.g. the coach payout-paid push, Task #968) to
  // request a specific tab via `?tab=coach`. We coerce unknown values back to
  // the default so junk params can't put the screen into an unrenderable state.
  const params = useLocalSearchParams<{ tab?: string | string[]; focusPayoutId?: string | string[] }>();
  const requestedTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const requestedFocusPayoutId = Array.isArray(params.focusPayoutId) ? params.focusPayoutId[0] : params.focusPayoutId;
  const focusPayoutId = (() => {
    const n = requestedFocusPayoutId != null ? Number(requestedFocusPayoutId) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const initialTab: TabKey = (TABS as readonly string[]).includes(requestedTab ?? "")
    ? (requestedTab as TabKey)
    : "library";
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [isCoach, setIsCoach] = useState(false);

  // React to deep-link param changes after mount (warm-start taps re-fire the
  // route with new params instead of remounting the screen).
  useEffect(() => {
    if (requestedTab && (TABS as readonly string[]).includes(requestedTab)) {
      setTab(requestedTab as TabKey);
    }
  }, [requestedTab]);

  // Detect if user is also a registered coach
  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/coach-marketplace/me/coach-profile`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => setIsCoach(!!d.pro)).catch(() => setIsCoach(false));
  }, [token]);

  const visibleTabs = isCoach ? TABS : (TABS.filter(t => t !== "coach") as TabKey[]);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.header}>Coach & Swing Studio</Text>
      <View style={styles.tabBar}>
        {visibleTabs.map(t => (
          <Pressable key={t} onPress={() => setTab(t)}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "library" ? "My Swings"
                : t === "find" ? "Find Coach"
                : t === "requests" ? "My Reviews"
                : "Coach Workspace"}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "library" && <LibraryTab token={token} />}
      {tab === "find" && <FindCoachTab token={token} userName={user?.displayName} userEmail={user?.email} />}
      {tab === "requests" && <MyRequestsTab token={token} />}
      {tab === "coach" && isCoach && <CoachWorkspaceTab token={token} focusPayoutId={focusPayoutId} />}
    </View>
  );
}

/* ─────────────────────────── My Swings ─────────────────────────── */
function LibraryTab({ token }: { token: string | null }) {
  const [videos, setVideos] = useState<SwingVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCapture, setShowCapture] = useState(false);
  const [playing, setPlaying] = useState<SwingVideo | null>(null);
  const [comparing, setComparing] = useState<SwingVideo | null>(null);

  const loadVideos = useCallback(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE_URL}/api/swing-videos`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setVideos(d.swingVideos ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  useEffect(() => { loadVideos(); }, [loadVideos]);

  const onCaptureComplete = () => { setShowCapture(false); loadVideos(); };

  if (loading) return <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.actionRow}>
        <Pressable style={styles.primaryBtn} onPress={() => setShowCapture(true)}>
          <Feather name="video" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>Capture Swing</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Videos, quality: 1,
          });
          if (!result.canceled && result.assets[0]) {
            try {
              await uploadVideo(token!, result.assets[0].uri);
              loadVideos();
            } catch (e) {
              if ((e as { isConsentRequired?: boolean }).isConsentRequired) {
                Alert.alert(
                  "Video consent required",
                  (e as Error).message,
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
                  ],
                );
              } else {
                Alert.alert("Upload failed", String(e));
              }
            }
          }
        }}>
          <Feather name="upload" size={16} color={GOLD} />
          <Text style={styles.secondaryBtnText}>Upload</Text>
        </Pressable>
      </View>

      {videos.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="video-off" size={48} color={GOLD + "60"} />
          <Text style={styles.emptyText}>No swing videos yet. Capture or upload your first swing.</Text>
        </View>
      ) : (
        <FlatList
          data={videos}
          keyExtractor={i => String(i.id)}
          contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
          renderItem={({ item }) => (
            <View style={styles.videoCard}>
              <Pressable onPress={() => setPlaying(item)} style={styles.videoThumb}>
                <Feather name="play-circle" size={40} color={GOLD} />
              </Pressable>
              <View style={{ flex: 1, paddingHorizontal: 12 }}>
                <Text style={styles.videoTitle}>{item.title ?? `Swing ${item.id}`}</Text>
                <Text style={styles.videoMeta}>
                  {item.club ?? "—"} · {item.view.toUpperCase()}
                </Text>
                <Text style={styles.videoMeta}>{new Date(item.capturedAt).toLocaleDateString()}</Text>
                <View style={{ flexDirection: "row", marginTop: 8, gap: 8 }}>
                  <Pressable style={styles.smallBtn} onPress={() => setComparing(item)}>
                    <Text style={styles.smallBtnText}>Compare</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}
        />
      )}

      <CaptureModal visible={showCapture} onClose={() => setShowCapture(false)} onComplete={onCaptureComplete} token={token} />
      {playing && <PlayerModal video={playing} onClose={() => setPlaying(null)} />}
      {comparing && (
        <CompareModal anchor={comparing} videos={videos} token={token}
          onClose={() => setComparing(null)} />
      )}
    </View>
  );
}

async function uploadVideo(token: string, fileUri: string, meta?: Partial<SwingVideo>) {
  const urlRes = await fetch(`${BASE_URL}/api/swing-videos/upload-url`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  const urlBody = await urlRes.json().catch(() => ({} as Record<string, unknown>));
  if (!urlRes.ok) {
    // Task #469 — propagate a structured consent-required error so the UI can
    // deep-link the member to the consent centre.
    if (urlRes.status === 403 && urlBody?.code === "CONSENT_REQUIRED") {
      const message = (urlBody as { consentRequired?: { message?: string } }).consentRequired?.message ?? "Video consent required";
      const err = new Error(message) as Error & { isConsentRequired?: boolean };
      err.isConsentRequired = true;
      throw err;
    }
    throw new Error("Failed to get upload URL");
  }
  const { uploadUrl, objectPath, uploadToken, uploadTokenExp } = urlBody as { uploadUrl?: string; objectPath?: string; uploadToken?: string; uploadTokenExp?: number };
  if (!uploadUrl || !objectPath || !uploadToken) throw new Error("Failed to get upload URL");
  await FileSystem.getInfoAsync(fileUri);
  const blob = await (await fetch(fileUri)).blob();
  const putRes = await fetch(uploadUrl, {
    method: "PUT", body: blob, headers: { "Content-Type": "video/mp4" },
  });
  if (!putRes.ok) throw new Error("Upload failed");
  const createRes = await fetch(`${BASE_URL}/api/swing-videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      videoUrl: objectPath,
      videoUploadToken: uploadToken,
      videoUploadTokenExp: uploadTokenExp,
      title: meta?.title ?? `Swing ${new Date().toLocaleDateString()}`,
      club: meta?.club ?? null,
      view: meta?.view ?? "dtl",
      notes: meta?.notes ?? null,
    }),
  });
  return await createRes.json();
}

function CaptureModal({ visible, onClose, onComplete, token }: {
  visible: boolean; onClose: () => void; onComplete: () => void; token: string | null;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);

  if (!visible) return null;
  if (!permission) return null;

  if (!permission.granted) {
    return (
      <Modal visible animationType="slide" onRequestClose={onClose}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>Camera Permission</Text>
          <Text style={{ color: "#fff", marginVertical: 16 }}>
            We need camera access to record your swing.
          </Text>
          <Pressable style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>Grant Permission</Text>
          </Pressable>
          <Pressable onPress={onClose}><Text style={{ color: GOLD, marginTop: 16 }}>Cancel</Text></Pressable>
        </View>
      </Modal>
    );
  }

  const startStop = async () => {
    if (!cameraRef.current) return;
    if (recording) {
      cameraRef.current.stopRecording();
      return;
    }
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 15 });
      setRecording(false);
      if (video?.uri && token) {
        setUploading(true);
        try {
          await uploadVideo(token, video.uri);
          onComplete();
        } catch (e) {
          if ((e as { isConsentRequired?: boolean }).isConsentRequired) {
            Alert.alert(
              "Video consent required",
              (e as Error).message,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
              ],
            );
          } else {
            Alert.alert("Upload failed", String(e));
          }
        } finally { setUploading(false); }
      }
    } catch (e) { setRecording(false); Alert.alert("Recording error", String(e)); }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView ref={cameraRef} style={{ flex: 1 }} mode="video" facing="back" videoQuality="1080p" />
        <View style={styles.captureControls}>
          <Pressable onPress={onClose} style={styles.captureBtn}>
            <Feather name="x" size={28} color="#fff" />
          </Pressable>
          <Pressable onPress={startStop} disabled={uploading} style={[styles.recordBtn, recording && styles.recordBtnActive]}>
            {uploading ? <LoadingSpinner color="#fff" /> : <View style={recording ? styles.recordSquare : styles.recordCircle} />}
          </Pressable>
          <View style={styles.captureBtn} />
        </View>
        <View style={{ position: "absolute", top: 60, alignSelf: "center" }}>
          <Text style={{ color: "#fff", fontSize: 12 }}>{recording ? "Recording…" : "Tap to record (max 15s)"}</Text>
        </View>
      </View>
    </Modal>
  );
}

type DrawShape =
  | { kind: "line"; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: "arrow"; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: "circle"; t: number; x: number; y: number; r: number; color: string }
  | { kind: "angle"; t: number; ax: number; ay: number; bx: number; by: number; cx: number; cy: number; color: string };

function PlayerModal({ video, onClose }: { video: SwingVideo; onClose: () => void }) {
  const { token } = useAuth();
  const videoRef = useRef<Video>(null);
  const [rate, setRate] = useState(1.0);
  const [tool, setTool] = useState<"line" | "circle" | "angle" | "off">("off");
  const [color, setColor] = useState("#FFD700");
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [overlay, setOverlay] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [currentT, setCurrentT] = useState(0);
  const [drag, setDrag] = useState<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const angleRef = useRef<Array<{ x: number; y: number }>>([]);
  const [saving, setSaving] = useState(false);
  const src = video.videoUrl.startsWith("/") ? `${BASE_URL}${video.videoUrl}` : video.videoUrl;
  useEffect(() => { videoRef.current?.setRateAsync(rate, true).catch(() => {}); }, [rate]);

  const onLayout = (e: any) => {
    const { width, height } = e.nativeEvent.layout;
    setOverlay({ w: width, h: height });
  };

  const handleTouchStart = (e: any) => {
    if (tool === "off") return;
    const { locationX: x, locationY: y } = e.nativeEvent;
    if (tool === "angle") {
      angleRef.current.push({ x, y });
      if (angleRef.current.length === 3) {
        const [a, b, c] = angleRef.current;
        setShapes(s => [...s, { kind: "angle", t: currentT, ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: c.x, cy: c.y, color }]);
        angleRef.current = [];
      }
      return;
    }
    setDrag({ x, y, cx: x, cy: y });
  };
  const handleTouchMove = (e: any) => {
    if (!drag) return;
    const { locationX: cx, locationY: cy } = e.nativeEvent;
    setDrag({ ...drag, cx, cy });
  };
  const handleTouchEnd = () => {
    if (!drag) return;
    if (tool === "line") {
      setShapes(s => [...s, { kind: "line", t: currentT, x1: drag.x, y1: drag.y, x2: drag.cx, y2: drag.cy, color }]);
    } else if (tool === "circle") {
      const r = Math.hypot(drag.cx - drag.x, drag.cy - drag.y);
      setShapes(s => [...s, { kind: "circle", t: currentT, x: drag.x, y: drag.y, r, color }]);
    }
    setDrag(null);
  };

  const visibleShapes = shapes.filter(s => Math.abs(s.t - currentT) < 0.4);

  const undo = () => setShapes(s => s.slice(0, -1));
  const clearAll = () => { setShapes([]); angleRef.current = []; };

  const saveAnnotation = async () => {
    if (shapes.length === 0) { Alert.alert("Nothing to save", "Draw something first."); return; }
    if (!token) { Alert.alert("Sign in required"); return; }
    setSaving(true);
    try {
      const r = await fetch(`${BASE_URL}/api/swing-videos/${video.id}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ drawings: shapes, textNotes: null }),
      });
      if (!r.ok) throw new Error(await r.text());
      Alert.alert("Saved", "Annotation saved to your swing.");
      setShapes([]);
    } catch (e: any) {
      Alert.alert("Save failed", String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={{ flex: 1 }} onLayout={onLayout}>
          <Video ref={videoRef} source={{ uri: src }} style={{ flex: 1 }}
            useNativeControls={tool === "off"} resizeMode={ResizeMode.CONTAIN} shouldPlay
            onPlaybackStatusUpdate={(s: any) => {
              if (s?.isLoaded && typeof s.positionMillis === "number") setCurrentT(s.positionMillis / 1000);
            }} />
          {tool !== "off" && (
            <View
              style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={handleTouchStart}
              onResponderMove={handleTouchMove}
              onResponderRelease={handleTouchEnd}
            >
              <Svg width={overlay.w} height={overlay.h}>
                {visibleShapes.map((s, i) => {
                  if (s.kind === "line") {
                    return <SvgLine key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={s.color} strokeWidth={3} />;
                  } else if (s.kind === "circle") {
                    return <SvgCircle key={i} cx={s.x} cy={s.y} r={s.r}
                      stroke={s.color} strokeWidth={3} fill="none" />;
                  } else if (s.kind === "angle") {
                    return <SvgPolyline key={i}
                      points={`${s.ax},${s.ay} ${s.bx},${s.by} ${s.cx},${s.cy}`}
                      stroke={s.color} strokeWidth={3} fill="none" />;
                  } else {
                    return <SvgLine key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={s.color} strokeWidth={3} />;
                  }
                })}
                {drag && tool === "line" && (
                  <SvgLine x1={drag.x} y1={drag.y} x2={drag.cx} y2={drag.cy}
                    stroke={color} strokeWidth={3} strokeDasharray="6,4" />
                )}
                {drag && tool === "circle" && (
                  <SvgCircle cx={drag.x} cy={drag.y}
                    r={Math.hypot(drag.cx - drag.x, drag.cy - drag.y)}
                    stroke={color} strokeWidth={3} fill="none" strokeDasharray="6,4" />
                )}
              </Svg>
            </View>
          )}
        </View>
        <View style={styles.playerBar}>
          <Pressable onPress={onClose}><Feather name="x" size={28} color="#fff" /></Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {/* Task #1052 — surface the detected source fps next to the rate
                buttons so reviewers can confirm slow-mo footage. */}
            <Text
              accessibilityLabel={`Source frame rate: ${formatFpsLabel(video.fps)}`}
              style={{ color: "#aaa", fontSize: 12, fontVariant: ["tabular-nums"], marginRight: 4 }}
            >
              {formatFpsLabel(video.fps)}
            </Text>
            {[0.25, 0.5, 1.0].map(r => (
              <Pressable key={r} onPress={() => setRate(r)}
                style={[styles.rateBtn, rate === r && styles.rateBtnActive]}>
                <Text style={{ color: rate === r ? "#000" : "#fff" }}>{r}x</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10, backgroundColor: "#111" }}>
          {(["off", "line", "circle", "angle"] as const).map(t => (
            <Pressable key={t} onPress={() => { setTool(t); angleRef.current = []; }}
              style={{
                paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
                backgroundColor: tool === t ? GOLD : "#222",
              }}>
              <Text style={{ color: tool === t ? "#000" : "#fff", fontSize: 12, fontWeight: "600" }}>
                {t === "off" ? "Pause draw" : t}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={undo} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#333" }}>
            <Text style={{ color: "#fff", fontSize: 12 }}>Undo</Text>
          </Pressable>
          <Pressable onPress={clearAll} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#333" }}>
            <Text style={{ color: "#fff", fontSize: 12 }}>Clear</Text>
          </Pressable>
          <Pressable onPress={saveAnnotation} disabled={saving}
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: GOLD }}>
            <Text style={{ color: "#000", fontSize: 12, fontWeight: "700" }}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 4, marginLeft: 4 }}>
            {["#FFD700", "#FF4136", "#39CCCC", "#FFFFFF"].map(c => (
              <Pressable key={c} onPress={() => setColor(c)}
                style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c, borderWidth: color === c ? 2 : 1, borderColor: "#fff" }} />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CompareModal({ anchor, videos, token, onClose }: {
  anchor: SwingVideo; videos: SwingVideo[]; token: string | null; onClose: () => void;
}) {
  const [right, setRight] = useState<SwingVideo | null>(null);
  const others = videos.filter(v => v.id !== anchor.id);
  const leftSrc = anchor.videoUrl.startsWith("/") ? `${BASE_URL}${anchor.videoUrl}` : anchor.videoUrl;
  const rightSrc = right ? (right.videoUrl.startsWith("/") ? `${BASE_URL}${right.videoUrl}` : right.videoUrl) : null;

  const save = async () => {
    if (!right || !token) return;
    await fetch(`${BASE_URL}/api/swing-videos/comparisons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leftVideoId: anchor.id, rightVideoId: right.id, label: "Side-by-side" }),
    });
    Alert.alert("Saved", "Comparison saved to library");
    onClose();
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={styles.playerBar}>
          <Pressable onPress={onClose}><Feather name="x" size={28} color="#fff" /></Pressable>
          <Text style={{ color: "#fff" }}>Side-by-side</Text>
          <Pressable onPress={save} disabled={!right}>
            <Text style={{ color: right ? GOLD : "#666" }}>Save</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1, borderRightWidth: 1, borderColor: "#333" }}>
            <Video source={{ uri: leftSrc }} style={{ flex: 1 }} resizeMode={ResizeMode.CONTAIN} useNativeControls shouldPlay isLooping />
          </View>
          <View style={{ flex: 1 }}>
            {rightSrc ? (
              <Video source={{ uri: rightSrc }} style={{ flex: 1 }} resizeMode={ResizeMode.CONTAIN} useNativeControls shouldPlay isLooping />
            ) : (
              <ScrollView style={{ flex: 1, padding: 8 }}>
                <Text style={{ color: "#fff", marginBottom: 8 }}>Pick a swing to compare:</Text>
                {others.map(v => (
                  <Pressable key={v.id} onPress={() => setRight(v)} style={styles.pickItem}>
                    <Text style={{ color: "#fff" }}>{v.title ?? `Swing ${v.id}`}</Text>
                    <Text style={{ color: "#999", fontSize: 11 }}>{new Date(v.capturedAt).toLocaleDateString()}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/* ─────────────────────────── Find Coach ─────────────────────────── */
type FindCoachMode = "all" | "in_person" | "async";

// Task #2022 — mirror the web sidebar's mode-aware copy so mobile players
// know whether the bracket is filtering hourly lessons or async reviews.
// The mapping matches `artifacts/kharagolf-web/src/pages/coach-marketplace.tsx`
// and the API at `artifacts/api-server/src/routes/coach-marketplace.ts`.
function priceFilterLabels(mode: FindCoachMode) {
  if (mode === "in_person") {
    return { minLabel: "Min ₹/hour", maxLabel: "Max ₹/hour", helper: "Filters by hourly rate" };
  }
  if (mode === "async") {
    return { minLabel: "Min ₹/review", maxLabel: "Max ₹/review", helper: "Filters by async review price" };
  }
  return { minLabel: "Min ₹", maxLabel: "Max ₹", helper: "Filters by hourly or async price" };
}

export function FindCoachTab({ token, userName, userEmail }: { token: string | null; userName?: string; userEmail?: string }) {
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Coach | null>(null);
  // Task #2022 — bring the same hourly-rate filter the web sidebar exposes
  // to the mobile coach tab. The mode toggle controls which price column
  // (hourly vs async) the API applies the bracket to.
  const [mode, setMode] = useState<FindCoachMode>("all");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (mode !== "all") params.set("mode", mode);
    const minRupees = parseFloat(priceMin);
    if (priceMin && Number.isFinite(minRupees) && minRupees >= 0) {
      params.set("priceMin", String(Math.round(minRupees * 100)));
    }
    const maxRupees = parseFloat(priceMax);
    if (priceMax && Number.isFinite(maxRupees) && maxRupees >= 0) {
      params.set("priceMax", String(Math.round(maxRupees * 100)));
    }
    const qs = params.toString();
    fetch(`${BASE_URL}/api/coach-marketplace/coaches${qs ? `?${qs}` : ""}`)
      .then(r => r.json()).then(d => { setCoaches(d.coaches ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [mode, priceMin, priceMax]);

  const labels = priceFilterLabels(mode);

  const filterBar = (
    <View style={styles.filterBar} testID="find-coach-filter-bar">
      <View style={styles.modeRow}>
        {(["all", "in_person", "async"] as const).map(m => (
          <Pressable
            key={m}
            onPress={() => setMode(m)}
            testID={`filter-mode-${m}`}
            accessibilityState={{ selected: mode === m }}
            style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
          >
            <Text style={[styles.modeBtnText, mode === m && styles.modeBtnTextActive]}>
              {m === "all" ? "All" : m === "in_person" ? "In-person" : "Async review"}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.priceRow}>
        <View style={styles.priceField}>
          <Text style={styles.filterLabel}>{labels.minLabel}</Text>
          <TextInput
            value={priceMin}
            onChangeText={setPriceMin}
            placeholder="0"
            placeholderTextColor="#666"
            inputMode="numeric"
            keyboardType="numeric"
            testID="filter-price-min"
            style={styles.filterInput}
          />
        </View>
        <View style={styles.priceField}>
          <Text style={styles.filterLabel}>{labels.maxLabel}</Text>
          <TextInput
            value={priceMax}
            onChangeText={setPriceMax}
            placeholder="any"
            placeholderTextColor="#666"
            inputMode="numeric"
            keyboardType="numeric"
            testID="filter-price-max"
            style={styles.filterInput}
          />
        </View>
      </View>
      <Text style={styles.filterHelper} testID="filter-price-helper">{labels.helper}</Text>
    </View>
  );

  if (loading) {
    return (
      <>
        {filterBar}
        <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
      </>
    );
  }
  if (coaches.length === 0) {
    return (
      <>
        {filterBar}
        <View style={styles.empty}>
          <Feather name="users" size={48} color={GOLD + "60"} />
          <Text style={styles.emptyText}>No coaches match your filters.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      {filterBar}
      <FlatList
        data={coaches}
        keyExtractor={c => String(c.proId)}
        contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
        renderItem={({ item }) => (
          <Pressable style={styles.coachCard} onPress={() => setSelected(item)}>
            {item.photoUrl ? (
              <Image source={{ uri: item.photoUrl.startsWith("/") ? `${BASE_URL}${item.photoUrl}` : item.photoUrl }}
                style={styles.coachAvatar} />
            ) : (
              <View style={[styles.coachAvatar, { backgroundColor: GOLD + "30", alignItems: "center", justifyContent: "center" }]}>
                <Feather name="user" size={28} color={GOLD} />
              </View>
            )}
            <View style={{ flex: 1, paddingHorizontal: 12 }}>
              <Text style={styles.coachName}>{item.displayName}</Text>
              <Text style={styles.coachOrg}>{item.organizationName ?? ""}</Text>
              <Text style={styles.coachMeta}>
                {item.yearsExperience}y exp · ⭐ {item.ratingsAvg.toFixed(1)} ({item.ratingsCount})
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                {item.acceptsAsync && (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>Async {formatRupees(item.asyncReviewPricePaise)}</Text>
                  </View>
                )}
                {item.acceptsInPerson && (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>In-person</Text>
                  </View>
                )}
              </View>
            </View>
          </Pressable>
        )}
      />
      {selected && (
        <CoachDetailModal coach={selected} token={token} userName={userName} userEmail={userEmail}
          onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function CoachDetailModal({ coach, token, userName, userEmail, onClose }: {
  coach: Coach; token: string | null; userName?: string; userEmail?: string; onClose: () => void;
}) {
  const [videos, setVideos] = useState<SwingVideo[]>([]);
  const [pickingVideo, setPickingVideo] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/swing-videos`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setVideos(d.swingVideos ?? []));
  }, [token]);

  const requestReview = async (videoId: number) => {
    if (!token) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/swing-reviews/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ proId: coach.proId, swingVideoId: videoId, memberPrompt: prompt }),
      });
      const data = await res.json();
      if (!res.ok) { Alert.alert("Error", data.error ?? "Failed"); return; }
      const order = data.razorpayOrder;
      if (!RazorpayCheckout) {
        Alert.alert("Payment", "Razorpay is not available in this build. Request created in pending state.");
        onClose(); return;
      }
      const result = await RazorpayCheckout.open({
        key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency,
        name: "KharaGolf Swing Review", description: `Review by ${coach.displayName}`,
        prefill: { name: userName, email: userEmail },
      });
      const verifyRes = await fetch(`${BASE_URL}/api/swing-reviews/requests/${data.request.id}/payment/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          razorpayOrderId: result.razorpay_order_id,
          razorpayPaymentId: result.razorpay_payment_id,
          razorpaySignature: result.razorpay_signature,
        }),
      });
      const verifyData = await verifyRes.json();
      if (verifyData.success) {
        Alert.alert("Submitted", `Your review will be ready within ${coach.asyncTurnaroundHours}h.`);
        onClose();
      } else { Alert.alert("Verification failed", verifyData.error ?? "Unknown"); }
    } catch (e) {
      Alert.alert("Error", String(e));
    } finally { setSubmitting(false); }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={styles.modalContainer} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={styles.modalTitle}>{coach.displayName}</Text>
          <Pressable onPress={onClose}><Feather name="x" size={28} color="#fff" /></Pressable>
        </View>
        <Text style={styles.coachOrg}>{coach.organizationName ?? ""}</Text>
        <Text style={styles.coachMeta}>
          {coach.yearsExperience}y exp · ⭐ {coach.ratingsAvg.toFixed(1)} ({coach.ratingsCount} reviews)
        </Text>
        {coach.bio && <Text style={styles.bio}>{coach.bio}</Text>}
        {coach.specialisms.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
            {coach.specialisms.map(s => <View key={s} style={styles.tag}><Text style={styles.tagText}>{s}</Text></View>)}
          </View>
        )}
        {coach.certifications.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.sectionLabel}>Certifications</Text>
            <Text style={{ color: "#ccc" }}>{coach.certifications.join(" · ")}</Text>
          </View>
        )}
        {coach.acceptsAsync && (
          <View style={{ marginTop: 20, padding: 12, backgroundColor: "#1a1a1a", borderRadius: 8 }}>
            <Text style={styles.sectionLabel}>Async Swing Review</Text>
            <Text style={{ color: "#ccc", marginBottom: 8 }}>
              {formatRupees(coach.asyncReviewPricePaise)} · turnaround {coach.asyncTurnaroundHours}h
            </Text>
            <TextInput placeholder="What should the coach focus on? (optional)"
              placeholderTextColor="#666" multiline
              style={styles.input} value={prompt} onChangeText={setPrompt} />
            <Pressable style={[styles.primaryBtn, { marginTop: 8 }]} onPress={() => setPickingVideo(true)}
              disabled={submitting}>
              {submitting ? <LoadingSpinner color="#000" /> : (
                <>
                  <Feather name="send" size={16} color="#000" />
                  <Text style={styles.primaryBtnText}>Pick Swing & Pay</Text>
                </>
              )}
            </Pressable>
          </View>
        )}
        {pickingVideo && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.sectionLabel}>Choose a swing</Text>
            {videos.length === 0 ? (
              <Text style={{ color: "#999" }}>No swings in your library yet. Capture one first.</Text>
            ) : videos.map(v => (
              <Pressable key={v.id} onPress={() => requestReview(v.id)} style={styles.pickItem}>
                <Text style={{ color: "#fff" }}>{v.title ?? `Swing ${v.id}`}</Text>
                <Text style={{ color: "#999", fontSize: 11 }}>
                  {v.club ?? "—"} · {new Date(v.capturedAt).toLocaleDateString()}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </Modal>
  );
}

/* ─────────────────────────── Drawing helpers ─────────────────────────── */
const SHAPE_VISIBLE_WINDOW_S = 0.5;

function shapesAtTime(shapes: DrawShape[], t: number): DrawShape[] {
  return shapes.filter(s => Math.abs(s.t - t) <= SHAPE_VISIBLE_WINDOW_S);
}

function ShapeSvg({ shape }: { shape: DrawShape }) {
  if (shape.kind === "line") {
    return <SvgLine x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={shape.color} strokeWidth={3} />;
  }
  if (shape.kind === "arrow") {
    const dx = shape.x2 - shape.x1;
    const dy = shape.y2 - shape.y1;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const head = 12;
    const px = -uy, py = ux;
    const ax = shape.x2 - ux * head + px * (head / 2);
    const ay = shape.y2 - uy * head + py * (head / 2);
    const bx = shape.x2 - ux * head - px * (head / 2);
    const by = shape.y2 - uy * head - py * (head / 2);
    return (
      <>
        <SvgLine x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={shape.color} strokeWidth={3} />
        <SvgPath d={`M${shape.x2},${shape.y2} L${ax},${ay} L${bx},${by} Z`} fill={shape.color} />
      </>
    );
  }
  if (shape.kind === "circle") {
    return <SvgCircle cx={shape.x} cy={shape.y} r={shape.r} stroke={shape.color} strokeWidth={3} fill="none" />;
  }
  // angle
  return (
    <SvgPolyline
      points={`${shape.ax},${shape.ay} ${shape.bx},${shape.by} ${shape.cx},${shape.cy}`}
      stroke={shape.color} strokeWidth={3} fill="none"
    />
  );
}

/* ─────────────────────────── My Reviews ─────────────────────────── */
function MyRequestsTab({ token }: { token: string | null }) {
  const [items, setItems] = useState<MyReviewRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE_URL}/api/swing-reviews/my-requests`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setItems(d.requests ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  useEffect(load, [load]);

  if (loading) return <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />;

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i, idx) => String(i.request.id) + "_" + idx}
        contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
        ListEmptyComponent={<Text style={styles.emptyText}>No review requests yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={styles.requestCard}
            onPress={() => setViewing(item.request.id)}
            testID={`my-review-open-${item.request.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Open review with ${item.proName}`}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.coachName}>{item.proName}</Text>
              <Text style={styles.coachMeta}>{statusLabel(item.request.status)} · {formatRupees(item.request.pricePaise)}</Text>
              <Text style={styles.coachMeta}>{new Date(item.request.createdAt).toLocaleString()}</Text>
              {item.request.rating && <Text style={{ color: GOLD, marginTop: 4 }}>You rated: {"⭐".repeat(item.request.rating)}</Text>}
            </View>
            <Feather name="chevron-right" size={20} color={GOLD} />
          </Pressable>
        )}
      />
      {viewing != null && <RequestDetailModal id={viewing} token={token} onClose={() => { setViewing(null); load(); }} />}
    </>
  );
}

function statusLabel(s: string) {
  return ({
    pending_payment: "Awaiting payment", paid: "Paid — in queue",
    in_review: "Coach reviewing", delivered: "Delivered",
    refunded: "Refunded", expired: "Expired",
  } as Record<string, string>)[s] ?? s;
}

function RequestDetailModal({ id, token, onClose }: { id: number; token: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ request: any; video: any; annotation: any; pro: any; viewerRole?: "owner" | "coach" | "admin" } | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/swing-reviews/requests/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setData);
  }, [id, token]);

  const submitRating = async () => {
    if (!token || rating === 0) return;
    await fetch(`${BASE_URL}/api/swing-reviews/requests/${id}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating, comment }),
    });
    Alert.alert("Thanks", "Your rating has been recorded.");
    onClose();
  };

  if (!data) return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}><LoadingSpinner color={GOLD} /></View>
    </Modal>
  );

  // Task #1512 — when the underlying review (or its access) is gone, the
  // server returns an error body instead of {request, video, ...}. Render an
  // explicit fallback so a coach who taps a payout row for a deleted review
  // sees a friendly message instead of a crash.
  if (!data.request) return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={styles.modalTitle}>Review unavailable</Text>
          <Pressable
            onPress={onClose}
            testID={`request-detail-${id}-close-unavailable`}
            accessibilityRole="button"
            accessibilityLabel="Close review"
            hitSlop={12}
          >
            <Feather name="x" size={28} color="#fff" />
          </Pressable>
        </View>
        <Text testID={`request-detail-${id}-unavailable`} style={[styles.coachMeta, { marginTop: 12 }]}>
          This review is no longer available to view.
        </Text>
      </View>
    </Modal>
  );

  return <RequestDetailModalInner data={data} onClose={onClose} rating={rating} setRating={setRating} comment={comment} setComment={setComment} submitRating={submitRating} />;
}

function AudioLevelIndicator({ playing }: { playing: boolean }) {
  const bars = useRef([0, 1, 2, 3].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    if (!playing) {
      bars.forEach(b => {
        b.stopAnimation();
        Animated.timing(b, { toValue: 0.3, duration: 120, useNativeDriver: false }).start();
      });
      return;
    }
    const loops = bars.map((b, i) => {
      const dur = 380 + i * 90;
      return Animated.loop(
        Animated.sequence([
          Animated.timing(b, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(b, { toValue: 0.3, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ]),
      );
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    loops.forEach((l, i) => {
      timers.push(setTimeout(() => l.start(), i * 80));
    });
    return () => {
      timers.forEach(t => clearTimeout(t));
      loops.forEach(l => l.stop());
    };
  }, [playing, bars]);
  return (
    <View
      accessible
      accessibilityLabel={playing ? "Voice-over playing" : "Voice-over paused"}
      style={{ flexDirection: "row", alignItems: "flex-end", height: 18, width: 22, gap: 2 }}
    >
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            backgroundColor: playing ? GOLD : "#555",
            borderRadius: 1,
            height: b.interpolate({ inputRange: [0, 1], outputRange: [4, 18] }),
          }}
        />
      ))}
    </View>
  );
}

function formatVoiceTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VoiceOverProgress({ positionMs, durationMs }: { positionMs: number; durationMs: number | null }) {
  const hasDuration = typeof durationMs === "number" && durationMs > 0;
  const clampedPos = hasDuration ? Math.min(positionMs, durationMs as number) : positionMs;
  const pct = hasDuration ? Math.max(0, Math.min(1, clampedPos / (durationMs as number))) : 0;
  const label = hasDuration
    ? `${formatVoiceTime(clampedPos)} / ${formatVoiceTime(durationMs as number)}`
    : formatVoiceTime(clampedPos);
  return (
    <View
      accessible
      accessibilityLabel={`Voice-over progress ${label}`}
      style={{ gap: 4 }}
    >
      <View style={{ height: 3, backgroundColor: "#333", borderRadius: 2, overflow: "hidden" }}>
        <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: GOLD }} />
      </View>
      <Text style={{ color: "#aaa", fontSize: 12, fontVariant: ["tabular-nums"] }}>{label}</Text>
    </View>
  );
}

// Read-only marker strip beneath the member's swing-review playback. One
// marker per drawing, positioned by `t / durationSec`; tap to seek.
export function MemberDrawingTimeline({
  drawings,
  videoDurationMs,
  videoTime,
  onSeekMs,
}: {
  drawings: DrawShape[];
  videoDurationMs: number | null;
  videoTime: number;
  onSeekMs: (ms: number) => void;
}) {
  const [shapeTimelineWidth, setShapeTimelineWidth] = useState(0);
  if (drawings.length === 0) return null;
  return (
    <View
      onLayout={(e) => setShapeTimelineWidth(e.nativeEvent.layout.width)}
      style={styles.shapeTimelineTrack}
      accessibilityLabel="Drawing timeline"
      testID="review-drawing-timeline-strip"
    >
      {videoDurationMs != null && videoDurationMs > 0 && shapeTimelineWidth > 0 && drawings.map((s, i) => {
        const durMs = videoDurationMs;
        const durSec = durMs / 1000;
        // Guard malformed timestamps so they don't produce NaN positions.
        if (!Number.isFinite(s.t) || s.t < 0) return null;
        const left = Math.max(
          0,
          Math.min(shapeTimelineWidth - 10, (s.t / durSec) * shapeTimelineWidth - 5),
        );
        return (
          <Pressable
            key={i}
            onPress={() => {
              const targetMs = Math.max(0, Math.min(durMs, s.t * 1000));
              onSeekMs(targetMs);
            }}
            hitSlop={6}
            accessibilityLabel={`Drawing ${i + 1} at ${s.t.toFixed(2)} seconds. Tap to jump.`}
            testID={`review-drawing-marker-${i}`}
            style={[
              styles.shapeMarker,
              {
                left,
                backgroundColor: s.color,
                borderColor: "rgba(0,0,0,0.6)",
                borderWidth: 1,
              },
            ]}
          />
        );
      })}
      {videoDurationMs != null && videoDurationMs > 0 && shapeTimelineWidth > 0 && (
        <View
          pointerEvents="none"
          style={[styles.shapeTimelinePlayhead, {
            left: Math.max(0, Math.min(
              shapeTimelineWidth - 1,
              (videoTime / (videoDurationMs / 1000)) * shapeTimelineWidth,
            )),
          }]}
        />
      )}
    </View>
  );
}

export function RequestDetailModalInner({ data, onClose, rating, setRating, comment, setComment, submitRating }: {
  data: { request: any; video: any; annotation: any; pro: any; viewerRole?: "owner" | "coach" | "admin" };
  onClose: () => void; rating: number; setRating: (n: number) => void;
  comment: string; setComment: (s: string) => void; submitRating: () => void;
}) {
  // Task #1861 — coaches can now open their own delivered reviews from the
  // payout breakdown (Task #1512), so the member-facing rating prompt /
  // read-only "you rated" summary must key off the caller's role rather
  // than just the review status. Treat a missing viewerRole as "owner" so
  // older clients keep their existing behaviour.
  const isOwnerView = (data.viewerRole ?? "owner") === "owner";
  const [videoTime, setVideoTime] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);
  const [overlay, setOverlay] = useState({ width: 0, height: 0 });
  const memberVideoRef = useRef<Video>(null);
  const drawings: DrawShape[] = Array.isArray(data.annotation?.drawings)
    ? (data.annotation.drawings as DrawShape[])
    : [];
  const videoSrc = data.video?.videoUrl?.startsWith("/") ? `${BASE_URL}${data.video.videoUrl}` : data.video?.videoUrl;
  const voiceSrc = data.annotation?.voiceOverUrl
    ? (data.annotation.voiceOverUrl.startsWith("/") ? `${BASE_URL}${data.annotation.voiceOverUrl}` : data.annotation.voiceOverUrl)
    : null;
  const voiceDurationMs = parseVoiceOverDurationMs(
    data.annotation?.voiceOverDurationSeconds,
  );

  const voiceRef = useRef<Audio.Sound | null>(null);
  const voiceLoadedRef = useRef(false);
  const voicePlayingRef = useRef(false);
  const lastSyncRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const [voicePlaying, setVoicePlaying] = useState(false);

  useEffect(() => {
    if (!voiceSrc) return;
    let cancelled = false;
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          { uri: voiceSrc },
          { shouldPlay: false, positionMillis: 0 },
        );
        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        voiceRef.current = sound;
        voiceLoadedRef.current = true;
      } catch {
        // best-effort: leave voice unloaded
      }
    })();
    return () => {
      cancelled = true;
      const s = voiceRef.current;
      voiceRef.current = null;
      voiceLoadedRef.current = false;
      voicePlayingRef.current = false;
      if (s) s.unloadAsync().catch(() => {});
    };
  }, [voiceSrc]);

  // The drift-correction rules (throttle to 100 ms, only re-seek when drift
  // exceeds 250 ms, mirror playback rate, stop cleanly past the voice-over
  // duration) live in the shared `@workspace/voice-over-sync` package so
  // this code path and the web review modal
  // (artifacts/kharagolf-web/src/pages/coach-marketplace.tsx →
  // ReviewPlaybackModal) can never drift apart again.
  const syncVoiceToVideo = async (
    videoIsPlaying: boolean,
    videoPosMs: number,
    rate: number,
  ) => {
    const sound = voiceRef.current;
    if (!sound || !voiceLoadedRef.current) return;
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      const status = await sound.getStatusAsync();
      if (!status.isLoaded) return;
      const decision = computeVoiceSyncAction({
        videoPosMs,
        audioPosMs: status.positionMillis ?? 0,
        videoIsPlaying,
        rate,
        capMs: voiceDurationMs,
      });
      // Mirror the video playback rate onto the voice-over so slow-mo
      // review (e.g. 0.5×) keeps the coach commentary aligned with the
      // visuals — matches the web review modal which sets
      // `audio.playbackRate = decision.rate`. expo-av exposes this via
      // `setRateAsync(rate, shouldCorrectPitch)`; we pass `true` so the
      // coach's voice doesn't pitch-shift at non-1× speeds.
      const currentRate = typeof status.rate === "number" ? status.rate : 1;
      if (currentRate !== decision.rate) {
        try {
          await sound.setRateAsync(decision.rate, true);
        } catch {
          // ignore — some platforms reject extreme rates; we'll retry
          // next sync tick.
        }
      }
      if (decision.shouldPause && voicePlayingRef.current) {
        await sound.pauseAsync();
        voicePlayingRef.current = false;
        setVoicePlaying(false);
      }
      if (decision.seekToMs != null) {
        await sound.setPositionAsync(decision.seekToMs);
      }
      if (decision.shouldPlay) {
        if (!status.isPlaying) {
          await sound.playAsync();
        }
        voicePlayingRef.current = true;
        setVoicePlaying(true);
      }
    } catch {
      // ignore transient sync errors
    } finally {
      syncInFlightRef.current = false;
    }
  };

  const onPlaybackStatus = (st: AVPlaybackStatus) => {
    if (!st.isLoaded) return;
    if (typeof st.positionMillis === "number") {
      setVideoTime(st.positionMillis / 1000);
    }
    if (typeof st.durationMillis === "number" && st.durationMillis > 0) {
      const dur = st.durationMillis;
      setVideoDurationMs((prev) => (prev === dur ? prev : dur));
    }
    const now = Date.now();
    if (!shouldRunVoiceSync(lastSyncRef.current, now, false)) return;
    lastSyncRef.current = now;
    syncVoiceToVideo(
      !!st.isPlaying && !st.didJustFinish,
      st.positionMillis ?? 0,
      st.rate ?? 1,
    );
    if (st.didJustFinish) {
      const sound = voiceRef.current;
      if (sound && voicePlayingRef.current) {
        sound.pauseAsync().catch(() => {});
        voicePlayingRef.current = false;
        setVoicePlaying(false);
      }
    }
  };
  const onOverlayLayout = (e: LayoutChangeEvent) => {
    setOverlay({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  };

  const visibleShapes = shapesAtTime(drawings, videoTime);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID="review-playback-modal">
      <ScrollView
        style={styles.modalContainer}
        contentContainerStyle={{ paddingBottom: 60 }}
        testID="review-playback-modal-scroll"
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={styles.modalTitle}>{data.pro?.displayName}</Text>
          <Pressable onPress={onClose}><Feather name="x" size={28} color="#fff" /></Pressable>
        </View>
        <Text style={styles.coachMeta}>{statusLabel(data.request.status)}</Text>
        {videoSrc && (
          <View style={{ marginTop: 16 }}>
            <View
              style={{ height: 280, backgroundColor: "#000" }}
              onLayout={onOverlayLayout}
              testID="review-video"
            >
              <Video
                ref={memberVideoRef}
                source={{ uri: videoSrc }}
                style={{ flex: 1 }}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                progressUpdateIntervalMillis={120}
                onPlaybackStatusUpdate={onPlaybackStatus}
              />
              {drawings.length > 0 && overlay.width > 0 && (
                <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
                  <Svg width={overlay.width} height={overlay.height}>
                    {visibleShapes.map((s, i) => <ShapeSvg key={i} shape={s} />)}
                  </Svg>
                </View>
              )}
              {/* Task #1052 — show the detected source fps next to the native
                  playback controls so the golfer can confirm slow-mo footage
                  uploaded at the expected rate. */}
              <View pointerEvents="none" style={{
                position: "absolute", top: 6, right: 8,
                paddingHorizontal: 6, paddingVertical: 2,
                borderRadius: 4, backgroundColor: "rgba(0,0,0,0.55)",
              }}>
                <Text
                  accessibilityLabel={`Source frame rate: ${formatFpsLabel(data.video?.fps)}`}
                  style={{ color: "#eee", fontSize: 11, fontVariant: ["tabular-nums"] }}
                >
                  {formatFpsLabel(data.video?.fps)}
                </Text>
              </View>
            </View>
            {/* Task #1215 — read-only marker strip mirroring the coach's
                DeliverModal timeline. */}
            <MemberDrawingTimeline
              drawings={drawings}
              videoDurationMs={videoDurationMs}
              videoTime={videoTime}
              onSeekMs={(ms) => {
                memberVideoRef.current?.setPositionAsync(ms).catch(() => {});
              }}
            />
          </View>
        )}
        {drawings.length > 0 && (
          <Text style={[styles.coachMeta, { marginTop: 6 }]}>
            {drawings.length} drawing{drawings.length === 1 ? "" : "s"} · tap a marker on the timeline to jump to one
          </Text>
        )}
        {/* Task #1512 — when a delivered review's annotation has been
            deleted (e.g. coach scrubbed feedback), explain why no notes are
            shown so coaches landing here from the payout breakdown aren't
            left guessing. */}
        {!data.annotation && data.request.status === "delivered" && (
          <View style={{ marginTop: 16 }}>
            <Text testID={`request-detail-${data.request.id}-annotation-missing`} style={styles.coachMeta}>
              Coach feedback for this review is no longer available.
            </Text>
          </View>
        )}
        {data.annotation && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionLabel}>Coach feedback</Text>
            {data.annotation.textNotes && <Text style={styles.bio}>{data.annotation.textNotes}</Text>}
            {voiceSrc && (
              <View style={{ marginTop: 8, backgroundColor: "#1a1a1a", padding: 12, borderRadius: 8, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <AudioLevelIndicator playing={voicePlaying} />
                  <Text style={{ color: "#fff", flex: 1 }}>
                    🎙 Voice-over plays automatically with the video
                  </Text>
                </View>
                <VoiceOverProgress
                  positionMs={Math.max(0, Math.min(videoTime * 1000, voiceDurationMs ?? videoTime * 1000))}
                  durationMs={voiceDurationMs}
                />
                {(() => {
                  if (!voiceDurationMs || !videoDurationMs) return null;
                  const gapMs = videoDurationMs - voiceDurationMs;
                  if (gapMs < 2000) return null;
                  const gapSec = Math.round(gapMs / 1000);
                  const pastEnd = videoTime * 1000 >= voiceDurationMs;
                  return (
                    <Text style={{ color: "#aaa", fontSize: 12, fontStyle: "italic" }}>
                      {pastEnd
                        ? `Voice-over ended · ${gapSec}s of video remaining`
                        : `Voice-over ends ${gapSec}s before the video`}
                    </Text>
                  );
                })()}
              </View>
            )}
          </View>
        )}
        {isOwnerView && data.request.status === "delivered" && data.request.rating == null && (
          <View style={{ marginTop: 24, padding: 12, backgroundColor: "#1a1a1a", borderRadius: 8 }}>
            <Text style={styles.sectionLabel}>Rate this review</Text>
            <View style={{ flexDirection: "row", marginVertical: 8 }}>
              {[1,2,3,4,5].map(n => (
                <Pressable key={n} onPress={() => setRating(n)}>
                  <Feather name="star" size={28} color={n <= rating ? GOLD : "#444"} />
                </Pressable>
              ))}
            </View>
            <TextInput placeholder="Comment (optional)" placeholderTextColor="#666"
              style={styles.input} value={comment} onChangeText={setComment} multiline />
            <Pressable style={[styles.primaryBtn, { marginTop: 8 }]} onPress={submitRating}>
              <Text style={styles.primaryBtnText}>Submit Rating</Text>
            </Pressable>
          </View>
        )}
        {/* Task #1695 — once a delivered review has been rated, show a
            read-only summary of what the member submitted. Without this the
            modal showed nothing in place of the rating prompt on reopen, even
            though the list-row "You rated: ★★★★" label lives outside it.
            Task #1861 — coaches viewing their own delivered work see the
            same summary so they can read the score the member left them,
            with a non-self-referential header. */}
        {data.request.status === "delivered" && data.request.rating != null && (
          <View
            testID={`request-detail-${data.request.id}-rating-summary`}
            style={{ marginTop: 24, padding: 12, backgroundColor: "#1a1a1a", borderRadius: 8 }}
          >
            <Text style={styles.sectionLabel}>
              {isOwnerView ? "You rated this review" : "Member rating"}
            </Text>
            <View
              accessibilityRole="image"
              accessibilityLabel={
                isOwnerView
                  ? `You rated ${data.request.rating} out of 5 stars`
                  : `Member rated this review ${data.request.rating} out of 5 stars`
              }
              style={{ flexDirection: "row", marginVertical: 8 }}
            >
              {[1,2,3,4,5].map(n => (
                <Feather
                  key={n}
                  name="star"
                  size={24}
                  color={n <= data.request.rating ? GOLD : "#444"}
                  style={{ marginRight: 4 }}
                />
              ))}
            </View>
            {data.request.ratingComment ? (
              <Text
                testID={`request-detail-${data.request.id}-rating-comment`}
                style={{ color: "#ddd", fontStyle: "italic" }}
              >
                {`\u201C${data.request.ratingComment}\u201D`}
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </Modal>
  );
}

/* ─────────────────────────── Coach Workspace ─────────────────────────── */
function maskUpiVpa(vpa: string): string {
  const [name, domain] = vpa.split("@");
  if (!name || !domain) return vpa;
  return `${name.slice(0, 2)}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

interface PayoutAccountHistoryEntry {
  id: number;
  changeKind: string;
  method: string;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  changedByName: string | null;
  changedByRole: string | null;
  createdAt: string;
}

export function PayoutAccountCard({ profile, token, reload }: { profile: any | null; token: string | null; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<"upi" | "bank_account">(
    profile?.payoutMethod === "bank_account" ? "bank_account" : "upi",
  );
  const [accountHolderName, setAccountHolderName] = useState<string>(profile?.payoutAccountHolderName ?? "");
  useEffect(() => {
    if (profile?.payoutMethod === "bank_account") setMethod("bank_account");
    else if (profile?.payoutMethod === "upi") setMethod("upi");
    if (profile?.payoutAccountHolderName) setAccountHolderName(profile.payoutAccountHolderName);
  }, [profile?.payoutMethod, profile?.payoutAccountHolderName]);
  const [upiVpa, setUpiVpa] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountConfirm, setBankAccountConfirm] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingVerification, setPendingVerification] = useState<{
    method: "upi" | "bank_account";
    verifiedHolderName: string | null;
    fundAccountId: string;
    razorpayContactId: string;
    verificationToken: string;
    upiVpa?: string;
    bankAccountLast4?: string;
    bankIfsc?: string;
  } | null>(null);
  const [history, setHistory] = useState<PayoutAccountHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    if (!token) return;
    setHistoryError(null);
    fetch(`${BASE_URL}/api/coach-marketplace/me/payout-account/history`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setHistoryError(d?.error ?? "Failed to load history"); return; }
        setHistory(d.history ?? []);
      })
      .catch(e => setHistoryError(String(e?.message ?? e)));
  }, [token]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const hasAccount = !!(profile?.payoutMethod && profile?.payoutAccountId);
  const needsAttention = profile?.payoutVerificationStatus === "needs_attention";

  const buildPayloadBase = () => {
    const body: Record<string, unknown> = { method, accountHolderName: accountHolderName.trim() };
    if (contact.trim()) body.contact = contact.trim();
    if (email.trim()) body.email = email.trim();
    if (method === "upi") body.upiVpa = upiVpa.trim();
    else { body.bankAccountNumber = bankAccountNumber.replace(/\s+/g, ""); body.bankIfsc = bankIfsc.toUpperCase().trim(); }
    return body;
  };

  const verify = async () => {
    setError(null);
    if (!accountHolderName.trim()) { setError("Account holder name is required"); return; }
    if (method === "upi") {
      if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiVpa.trim())) {
        setError("Enter a valid UPI VPA, e.g. name@bank"); return;
      }
    } else {
      const acct = bankAccountNumber.replace(/\s+/g, "");
      if (!/^\d{6,20}$/.test(acct)) { setError("Enter a valid account number (6–20 digits)"); return; }
      if (acct !== bankAccountConfirm.replace(/\s+/g, "")) { setError("Account numbers do not match"); return; }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc.toUpperCase().trim())) {
        setError("Enter a valid IFSC code"); return;
      }
    }
    if (!token) { setError("Not signed in"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/coach-marketplace/me/payout-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildPayloadBase()),
      });
      const data = await res.json();
      if (!res.ok || !data.verification || data.verification.status !== "verified") {
        setError(data.error ?? "Verification failed. Please check your details."); return;
      }
      if (!data.verification.verificationToken) {
        setError("Verification token missing. Please try again.");
        return;
      }
      setPendingVerification({
        method: data.verification.method,
        verifiedHolderName: data.verification.verifiedHolderName ?? null,
        fundAccountId: data.verification.fundAccountId,
        razorpayContactId: data.verification.razorpayContactId,
        verificationToken: data.verification.verificationToken,
        upiVpa: data.verification.upiVpa,
        bankAccountLast4: data.verification.bankAccountLast4,
        bankIfsc: data.verification.bankIfsc,
      });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmAndSave = async () => {
    if (!pendingVerification || !token) return;
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        method: pendingVerification.method,
        confirm: true,
        verificationToken: pendingVerification.verificationToken,
      };
      const res = await fetch(`${BASE_URL}/api/coach-marketplace/me/payout-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to save payout account"); return; }
      Alert.alert("Payout account saved", "Future payouts will go to this account automatically.");
      setEditing(false); setPendingVerification(null);
      setUpiVpa(""); setBankAccountNumber(""); setBankAccountConfirm(""); setBankIfsc("");
      reload();
      loadHistory();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.earningsCard}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={styles.sectionLabel}>Payout account</Text>
        {!editing && (
          <Pressable onPress={() => setEditing(true)}>
            <Text style={{ color: GOLD, fontWeight: "600" }}>{hasAccount ? "Update" : "Add account"}</Text>
          </Pressable>
        )}
      </View>

      {needsAttention && (
        <View
          testID="banner-payout-needs-attention"
          style={{
            marginTop: 8,
            marginBottom: 8,
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#b45309",
            backgroundColor: "rgba(120, 53, 15, 0.35)",
          }}
        >
          <Text style={{ color: "#fde68a", fontWeight: "700", marginBottom: 4 }}>
            Your payout account needs re-verification
          </Text>
          <Text style={{ color: "#fef3c7", fontSize: 13 }}>
            Our latest scheduled re-check of your saved payout details didn't go through, so payouts are paused
            until you re-save them.
            {profile?.payoutVerificationFailureReason
              ? `\n\nReason: ${profile.payoutVerificationFailureReason}`
              : ""}
          </Text>
          {!editing && (
            <Pressable
              testID="button-payout-needs-attention-fix"
              onPress={() => setEditing(true)}
              style={{
                marginTop: 10,
                alignSelf: "flex-start",
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 6,
                backgroundColor: GOLD,
              }}
            >
              <Text style={{ color: "#000", fontWeight: "700" }}>Re-verify account</Text>
            </Pressable>
          )}
        </View>
      )}

      {hasAccount && !editing && (
        <View style={{ marginTop: 4 }}>
          <Text style={styles.coachMeta}>
            Method: <Text style={{ color: "#fff" }}>{profile.payoutMethod === "upi" ? "UPI" : "Bank account"}</Text>
          </Text>
          {profile.payoutAccountHolderName && (
            <Text style={styles.coachMeta}>
              Holder: <Text style={{ color: "#fff" }}>{profile.payoutAccountHolderName}</Text>
            </Text>
          )}
          {profile.payoutMethod === "upi" && profile.payoutVpa && (
            <Text style={styles.coachMeta}>
              UPI: <Text style={{ color: "#fff" }}>{maskUpiVpa(profile.payoutVpa)}</Text>
            </Text>
          )}
          {profile.payoutMethod === "bank_account" && profile.payoutBankAccountNumber && (
            <Text style={styles.coachMeta}>
              Account: <Text style={{ color: "#fff" }}>•••• {String(profile.payoutBankAccountNumber).slice(-4)}</Text>
              {profile.payoutBankIfsc ? <Text style={{ color: "#999" }}>  IFSC {profile.payoutBankIfsc}</Text> : null}
            </Text>
          )}
        </View>
      )}

      {!hasAccount && !editing && (
        <Text style={styles.coachMeta}>
          No payout account on file. Add one so we can send your earnings automatically.
        </Text>
      )}

      {editing && (
        <View style={{ marginTop: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["upi", "bank_account"] as const).map(m => (
              <Pressable key={m} onPress={() => setMethod(m)}
                style={[
                  { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: GOLD },
                  method === m && { backgroundColor: GOLD },
                ]}>
                <Text style={{ color: method === m ? "#000" : GOLD, fontWeight: "600" }}>
                  {m === "upi" ? "UPI" : "Bank account"}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput style={styles.input} placeholder="Account holder name (must match KYC)"
            placeholderTextColor="#666" value={accountHolderName} onChangeText={setAccountHolderName} />
          {method === "upi" ? (
            <TextInput style={styles.input} placeholder="UPI VPA (name@bank)" placeholderTextColor="#666"
              autoCapitalize="none" autoCorrect={false} value={upiVpa} onChangeText={setUpiVpa} />
          ) : (
            <>
              <TextInput style={styles.input} placeholder="Bank account number" placeholderTextColor="#666"
                keyboardType="number-pad" value={bankAccountNumber} onChangeText={setBankAccountNumber} />
              <TextInput style={styles.input} placeholder="Re-enter account number" placeholderTextColor="#666"
                keyboardType="number-pad" value={bankAccountConfirm} onChangeText={setBankAccountConfirm} />
              <TextInput style={styles.input} placeholder="IFSC code (e.g. HDFC0001234)" placeholderTextColor="#666"
                autoCapitalize="characters" autoCorrect={false} value={bankIfsc}
                onChangeText={t => setBankIfsc(t.toUpperCase())} />
            </>
          )}
          <TextInput style={styles.input} placeholder="Contact phone (optional)" placeholderTextColor="#666"
            keyboardType="phone-pad" value={contact} onChangeText={setContact} />
          <TextInput style={styles.input} placeholder="Email (optional)" placeholderTextColor="#666"
            autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          {error && <Text style={{ color: "#ff6b6b", marginTop: 8 }}>{error}</Text>}
          {pendingVerification ? (
            <View style={{ marginTop: 12, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: "#1f6f50", backgroundColor: "#0f2a22" }}>
              <Text style={{ color: "#6ee7b7", fontWeight: "700" }}>Verified with the bank</Text>
              <Text style={{ color: "#d4d4d8", marginTop: 4 }}>
                The {pendingVerification.method === "upi" ? "UPI ID" : "bank account"} you entered is registered to:
              </Text>
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16, marginTop: 4 }}>
                {pendingVerification.verifiedHolderName ?? "(name not returned by bank)"}
              </Text>
              {pendingVerification.method === "upi" && pendingVerification.upiVpa && (
                <Text style={{ color: "#a1a1aa", fontSize: 12, marginTop: 4 }}>UPI: {pendingVerification.upiVpa}</Text>
              )}
              {pendingVerification.method === "bank_account" && (
                <Text style={{ color: "#a1a1aa", fontSize: 12, marginTop: 4 }}>
                  Account •••• {pendingVerification.bankAccountLast4}
                  {pendingVerification.bankIfsc ? `  ·  IFSC ${pendingVerification.bankIfsc}` : ""}
                </Text>
              )}
              <Text style={{ color: "#d4d4d8", fontSize: 12, marginTop: 8 }}>
                Confirm this is your account before we send future payouts here.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <Pressable onPress={confirmAndSave} disabled={submitting}
                  style={{ backgroundColor: GOLD, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, opacity: submitting ? 0.6 : 1 }}>
                  <Text style={{ color: "#000", fontWeight: "700" }}>{submitting ? "Saving…" : "Confirm and use this account"}</Text>
                </Pressable>
                <Pressable onPress={() => setPendingVerification(null)} disabled={submitting}
                  style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: "#444" }}>
                  <Text style={{ color: "#ccc", fontWeight: "600" }}>That's not me</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <Pressable onPress={verify} disabled={submitting}
                style={{ backgroundColor: GOLD, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, opacity: submitting ? 0.6 : 1 }}>
                <Text style={{ color: "#000", fontWeight: "700" }}>{submitting ? "Verifying with bank…" : "Verify account"}</Text>
              </Pressable>
              <Pressable onPress={() => { setEditing(false); setError(null); setPendingVerification(null); }}
                style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: "#444" }}>
                <Text style={{ color: "#ccc", fontWeight: "600" }}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#333", paddingTop: 8 }}>
        <Text style={[styles.sectionLabel, { fontSize: 13 }]}>Recent changes</Text>
        {historyError && <Text style={{ color: "#ff6b6b", marginTop: 4 }}>{historyError}</Text>}
        {!historyError && history === null && <Text style={styles.coachMeta}>Loading…</Text>}
        {!historyError && history && history.length === 0 && (
          <Text style={styles.coachMeta}>No changes recorded yet.</Text>
        )}
        {!historyError && history && history.length > 0 && history.slice(0, 5).map(h => (
          <View key={h.id} style={{ marginTop: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: "#222" }}>
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>
              {h.changeKind === "created" ? "Account added" : "Account updated"}
              <Text style={{ color: "#999", fontWeight: "400" }}>
                {"  "}({h.method === "upi" ? "UPI" : "Bank account"})
              </Text>
            </Text>
            <Text style={styles.coachMeta}>
              {h.method === "upi" && h.upiVpaMasked ? `UPI ${h.upiVpaMasked}` : null}
              {h.method === "bank_account" && h.bankAccountLast4 ? `Account •••• ${h.bankAccountLast4}` : null}
              {h.bankIfsc ? `  IFSC ${h.bankIfsc}` : ""}
            </Text>
            <Text style={[styles.coachMeta, { color: "#777", fontSize: 11 }]}>
              {new Date(h.createdAt).toLocaleString()}
              {h.changedByName ? ` · ${h.changedByName}` : ""}
              {h.changedByRole ? ` (${h.changedByRole})` : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CoachWorkspaceTab({ token, focusPayoutId }: { token: string | null; focusPayoutId?: number | null }) {
  const { user } = useAuth();
  const coachId = user?.id ?? null;
  const [queue, setQueue] = useState<any[]>([]);
  const [earnings, setEarnings] = useState<any | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [working, setWorking] = useState<any | null>(null);
  // Task #1286 — payout id whose included reviews the coach is currently
  // inspecting (null = sheet closed). The sheet itself does its own fetch.
  const [payoutDetail, setPayoutDetail] = useState<any | null>(null);
  // Task #1712 — coach-local "drawings clipboard" lifted to the workspace
  // tab so a Copy in one review survives opening a different review (the
  // CoachDeliverModal unmounts when `working` flips).
  // Task #2130 — also persisted to AsyncStorage keyed by the coach's user
  // id so the clipboard survives an app relaunch / tab switch. We start
  // empty and rehydrate inside an effect because AsyncStorage reads are
  // async; the brief flash of an empty Paste button on first paint is
  // acceptable (paste is hidden until the deliver modal is opened anyway).
  const [drawingClipboard, setDrawingClipboardState] = useState<DrawShape[]>([]);
  // Re-hydrate whenever the signed-in coach changes. The `cancelled`
  // flag protects against a slow AsyncStorage read for a previous coach
  // resolving after a newer coach has signed in (which would otherwise
  // surface the prior coach's clipboard for a tick).
  useEffect(() => {
    if (coachId == null) {
      setDrawingClipboardState([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const loaded = await loadCoachDrawingClipboard<DrawShape>(coachId);
      if (cancelled) return;
      setDrawingClipboardState(loaded);
    })();
    return () => { cancelled = true; };
  }, [coachId]);
  // Wrap the setter so every clipboard mutation (copy, programmatic clear)
  // mirrors to AsyncStorage. We persist after computing `value` from the
  // previous state so functional updates work the same as plain values.
  const setDrawingClipboard = useCallback(
    (next: DrawShape[] | ((prev: DrawShape[]) => DrawShape[])) => {
      setDrawingClipboardState(prev => {
        const value = typeof next === "function"
          ? (next as (p: DrawShape[]) => DrawShape[])(prev)
          : next;
        if (coachId != null) {
          void saveCoachDrawingClipboard(coachId, value);
        }
        return value;
      });
    },
    [coachId],
  );
  // Task #2131 — server-backed library of named drawing presets, lifted
  // here so a save/rename/delete in one review's modal is visible the
  // next time this coach opens any review without a refetch round trip.
  // Loaded once per token; mutations patch this state in place.
  const [drawingPresets, setDrawingPresets] = useState<DrawingPreset[]>([]);

  const load = useCallback(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/swing-reviews/coach/queue`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setQueue(d.queue ?? []));
    fetch(`${BASE_URL}/api/swing-reviews/coach/earnings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setEarnings);
    fetch(`${BASE_URL}/api/coach-marketplace/me/coach-profile`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setProfile(d.profile ?? null));
    fetch(`${BASE_URL}/api/swing-reviews/coach/drawing-presets`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { presets: [] })
      .then(d => setDrawingPresets(Array.isArray(d.presets) ? d.presets : []))
      .catch(() => { /* best-effort: empty library is the right fallback */ });
  }, [token]);

  useEffect(load, [load]);

  // Task #1116 — highlight + scroll to the payout row that the just-tapped
  // payout-paid push is referring to. We start an animated flash once the
  // payouts list contains a row with the matching id, and ask the parent
  // ScrollView to scroll the row into view. Falls back gracefully when the
  // payout isn't in the visible page (no match → no flash, no scroll).
  const scrollRef = useRef<ScrollView | null>(null);
  const payoutRowYRef = useRef<Record<number, number>>({});
  const payoutCardYRef = useRef<number | null>(null);
  const highlight = useRef(new Animated.Value(0)).current;
  const lastFocusedRef = useRef<number | null>(null);
  const payouts: any[] = Array.isArray(earnings?.payouts) ? earnings.payouts : [];
  const focusedPayoutPresent = focusPayoutId != null && payouts.some((p: any) => Number(p.id) === focusPayoutId);

  const scrollToPayoutCard = useCallback(() => {
    let attempts = 0;
    const tryScroll = () => {
      const y = payoutCardYRef.current;
      if (y != null && scrollRef.current) {
        scrollRef.current.scrollTo({ y: Math.max(0, y - 40), animated: true });
      } else if (attempts++ < 10) {
        setTimeout(tryScroll, 80);
      }
    };
    tryScroll();
  }, []);
  const payoutNeedsAttention = profile?.payoutVerificationStatus === "needs_attention";

  useEffect(() => {
    if (focusPayoutId == null || !focusedPayoutPresent) return;
    if (lastFocusedRef.current === focusPayoutId) return;
    lastFocusedRef.current = focusPayoutId;
    // Defer scroll until the row's onLayout has reported a y position. We
    // poll a few times in case layout hasn't settled yet on first paint.
    let attempts = 0;
    const tryScroll = () => {
      const y = payoutRowYRef.current[focusPayoutId];
      if (y != null && scrollRef.current) {
        scrollRef.current.scrollTo({ y: Math.max(0, y - 40), animated: true });
      } else if (attempts++ < 10) {
        setTimeout(tryScroll, 80);
      }
    };
    tryScroll();
    highlight.setValue(0);
    Animated.sequence([
      Animated.timing(highlight, { toValue: 1, duration: 250, useNativeDriver: false, easing: Easing.out(Easing.quad) }),
      Animated.delay(2200),
      Animated.timing(highlight, { toValue: 0, duration: 600, useNativeDriver: false, easing: Easing.in(Easing.quad) }),
    ]).start();
  }, [focusPayoutId, focusedPayoutPresent, highlight]);

  const flashBg = highlight.interpolate({ inputRange: [0, 1], outputRange: ["rgba(201,168,76,0)", "rgba(201,168,76,0.22)"] });
  const flashBorder = highlight.interpolate({ inputRange: [0, 1], outputRange: ["rgba(201,168,76,0)", GOLD] });

  return (
    <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 12, paddingBottom: 120 }}>
      {earnings && (
        <View style={styles.earningsCard}>
          <Text style={styles.sectionLabel}>Earnings</Text>
          <Text style={{ color: GOLD, fontSize: 24, fontWeight: "700" }}>
            {formatRupees(earnings.summary.lifetimeEarningsPaise)}
          </Text>
          <Text style={styles.coachMeta}>
            Pending payout: {formatRupees(earnings.summary.pendingPayoutPaise)} ({earnings.summary.unpaidCount} reviews)
          </Text>
          {payoutNeedsAttention && (
            <Pressable
              testID="banner-earnings-payout-needs-attention"
              onPress={scrollToPayoutCard}
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: "#b45309",
                backgroundColor: "rgba(120, 53, 15, 0.35)",
              }}
            >
              <Text style={{ color: "#fde68a", fontWeight: "700" }}>
                Payouts paused — account needs re-verification
              </Text>
              <Text style={{ color: "#fef3c7", fontSize: 12, marginTop: 2 }}>
                Tap to re-verify in the Payout account section below.
              </Text>
            </Pressable>
          )}
          <Text style={styles.coachMeta}>Revenue share: {earnings.sharePct}%</Text>
        </View>
      )}
      {payouts.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <Text style={styles.sectionLabel}>Payouts</Text>
          {payouts.map((p: any) => {
            const isFocus = focusPayoutId != null && Number(p.id) === focusPayoutId;
            const RowWrap: any = isFocus ? Animated.View : View;
            const wrapStyle = isFocus
              ? { backgroundColor: flashBg, borderColor: flashBorder, borderWidth: 1, borderRadius: 8 }
              : null;
            return (
              <RowWrap
                key={p.id}
                style={wrapStyle}
                onLayout={(e: LayoutChangeEvent) => { payoutRowYRef.current[p.id] = e.nativeEvent.layout.y; }}
                testID={isFocus ? `payout-row-${p.id}-focused` : `payout-row-${p.id}`}
              >
                <Pressable
                  onPress={() => setPayoutDetail(p)}
                  testID={`payout-row-${p.id}-press`}
                  accessibilityRole="button"
                  accessibilityLabel={`View reviews included in payout ${p.id}`}
                  style={styles.payoutRow}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.coachName}>
                      {formatRupees(p.netPayoutPaise ?? 0)}
                      {p.status === "paid" ? "  · Paid" : `  · ${statusLabel(p.status)}`}
                    </Text>
                    <Text style={styles.coachMeta}>
                      {new Date(p.periodStart).toLocaleDateString()} – {new Date(p.periodEnd).toLocaleDateString()}
                    </Text>
                    {p.payoutReference ? (
                      <Text style={styles.coachMeta}>Ref: {p.payoutReference}</Text>
                    ) : null}
                    {p.paidAt ? (
                      <Text style={styles.coachMeta}>Paid {new Date(p.paidAt).toLocaleString()}</Text>
                    ) : null}
                    {/* Task #1306 — surface push/SMS delivery state for the
                        payout-paid notification so coaches can see whether
                        we actually reached them. Task #1543 added the
                        coach-side "Try again" button which the strip
                        renders when at least one channel missed. */}
                    <CoachPayoutNotificationStrip
                      payoutId={p.id}
                      payoutStatus={p.status}
                      notification={(p.notification ?? null) as CoachPayoutNotificationAttempt | null}
                      token={token}
                      reload={load}
                    />
                  </View>
                  <Feather name="chevron-right" size={20} color={GOLD} />
                </Pressable>
              </RowWrap>
            );
          })}
        </View>
      )}
      <View onLayout={(e: LayoutChangeEvent) => { payoutCardYRef.current = e.nativeEvent.layout.y; }}>
        <PayoutAccountCard profile={profile} token={token} reload={load} />
      </View>
      <Text style={styles.sectionLabel}>Queue ({queue.length})</Text>
      {queue.length === 0 ? (
        <Text style={styles.coachMeta}>No reviews to deliver.</Text>
      ) : queue.map((q: any) => (
        <Pressable
          key={q.request.id}
          testID={`coach-queue-row-${q.request.id}`}
          style={styles.requestCard}
          onPress={() => setWorking(q)}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.coachName}>Review #{q.request.id}</Text>
            <Text style={styles.coachMeta}>{statusLabel(q.request.status)} · {formatRupees(q.request.pricePaise)}</Text>
            {q.request.dueAt && <Text style={styles.coachMeta}>Due: {new Date(q.request.dueAt).toLocaleString()}</Text>}
            {q.request.memberPrompt && <Text style={styles.coachMeta} numberOfLines={2}>"{q.request.memberPrompt}"</Text>}
          </View>
          <Feather name="chevron-right" size={20} color={GOLD} />
        </Pressable>
      ))}
      {working && (
        <CoachDeliverModal
          queueItem={working}
          token={token}
          onClose={() => { setWorking(null); load(); }}
          drawingClipboard={drawingClipboard}
          setDrawingClipboard={setDrawingClipboard}
          drawingPresets={drawingPresets}
          setDrawingPresets={setDrawingPresets}
        />
      )}
      {payoutDetail && (
        <PayoutDetailModal
          payout={payoutDetail}
          token={token}
          onClose={() => setPayoutDetail(null)}
        />
      )}
    </ScrollView>
  );
}

// Task #1306 — render the per-channel push/SMS delivery state for a
// coach payout (mirrors the admin-side badges from Task #1129) plus an
// inline note when both channels missed. Coaches do not get a Resend
// button; that stays admin-only.
function CoachPayoutNotificationStrip({
  payoutId,
  payoutStatus,
  notification,
  token,
  reload,
}: {
  payoutId: number;
  payoutStatus: string;
  notification: CoachPayoutNotificationAttempt | null;
  token: string | null;
  reload: () => void;
}) {
  // Task #1543 — local "retrying" flag mirrors the web cell so the
  // press-once UX feels the same on both platforms; parent reload
  // refreshes the cooldown stamp returned with /coach/earnings.
  const [retrying, setRetrying] = useState(false);
  // Task #1913 — `now` ticks every second whenever the per-payout
  // cooldown is active so the "Try again in Xm Ys" line updates live
  // and the button reappears the moment the cooldown clears, matching
  // the web cell's behaviour. Hooks are declared before the early
  // returns so they stay called unconditionally.
  const [now, setNow] = useState(() => Date.now());
  const retryState = coachPayoutRetryState(notification, now);
  // Hide the cooldown countdown if we have no auth token to actually
  // hit the retry endpoint — matches the original `canRetry` guard so
  // an unauthenticated render never offers a retry affordance.
  const visibleRetryState = token ? retryState : { kind: "hidden" as const, remainingMs: 0 as const };
  const inCooldown = visibleRetryState.kind === "countdown";
  useEffect(() => {
    if (!inCooldown) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [inCooldown]);
  // Task #1920 — pull the active i18n language so the "tried {target}"
  // hint and "Update notification settings" link below render through
  // the same shared lang→label tables as the web cell (the rest of the
  // badge text is still the hardcoded English `coachPayoutChannelText`,
  // tracked separately).
  const { i18n } = useTranslation();
  if (payoutStatus !== "paid") return null;
  if (!notification) {
    return (
      <View
        style={[styles.coachNotifBadge, { backgroundColor: "#2a2a2a", marginTop: 6 }]}
        testID={`payout-notif-pending-${payoutId}`}
      >
        <Text style={[styles.coachNotifBadgeText, { color: "#9ca3af" }]}>Notification: pending</Text>
      </View>
    );
  }
  const pushLabel = coachPayoutChannelLabel(
    notification.pushStatus, notification.pushAttempts,
    notification.pushRetryExhaustedAt, COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  );
  const smsLabel = coachPayoutChannelLabel(
    notification.smsStatus, notification.smsAttempts,
    notification.smsRetryExhaustedAt, COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  );
  const pushColors = coachPayoutChannelColors(pushLabel);
  const smsColors = coachPayoutChannelColors(smsLabel);
  const bothMissed = coachPayoutBothChannelsNonSent(pushLabel, smsLabel);
  // Task #1914 — surface the "contact support" deflection once the coach
  // has hit "Try again" enough times that the next press is more likely
  // to fix the underlying contact problem via a support ticket than via
  // another retry into the same broken push token / phone number. Driven
  // by the same shared helper as the web coach workspace so both
  // platforms light up the hint at exactly the same press count.
  const showSupportHint = coachPayoutShouldShowSupportHint(notification);

  const onRetry = async () => {
    if (!token) return;
    setRetrying(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/swing-reviews/coach/payouts/${payoutId}/retry-notification`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        Alert.alert(
          "Couldn't try again",
          (body && body.error) ? String(body.error) : `Request failed (${res.status})`,
        );
      } else {
        Alert.alert("Re-sending your payout notification", "We'll try push and SMS again shortly.");
      }
    } catch (err: any) {
      Alert.alert("Couldn't try again", err?.message ?? "Network error");
    } finally {
      setRetrying(false);
      reload();
    }
  };

  // Task #1544 — only show the masked target alongside a *non-sent*
  // badge. When the channel actually delivered, repeating the contact
  // is noise; on `opted_out` we deliberately omit the target so the row
  // doesn't echo back a contact the coach has silenced (they already
  // know their own number).
  const showPushTarget = pushLabel !== "sent" && pushLabel !== "opted_out" && !!notification.pushTargetLabel;
  const showSmsTarget = smsLabel !== "sent" && smsLabel !== "opted_out" && !!notification.smsTargetMasked;
  return (
    <View style={{ marginTop: 6 }}>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <View
          style={[styles.coachNotifBadge, { backgroundColor: pushColors.bg }]}
          testID={`payout-notif-push-${payoutId}`}
          accessibilityLabel={`Push notification ${coachPayoutChannelText(pushLabel)}`}
        >
          <Text style={[styles.coachNotifBadgeText, { color: pushColors.fg }]}>
            Push: {coachPayoutChannelText(pushLabel)}
          </Text>
        </View>
        {showPushTarget && (
          <Text
            style={styles.coachNotifTarget}
            testID={`payout-notif-push-target-${payoutId}`}
          >
            {coachPayoutTriedTargetLabel(i18n.language, notification.pushTargetLabel!)}
          </Text>
        )}
        <View
          style={[styles.coachNotifBadge, { backgroundColor: smsColors.bg }]}
          testID={`payout-notif-sms-${payoutId}`}
          accessibilityLabel={`SMS notification ${coachPayoutChannelText(smsLabel)}`}
        >
          <Text style={[styles.coachNotifBadgeText, { color: smsColors.fg }]}>
            SMS: {coachPayoutChannelText(smsLabel)}
          </Text>
        </View>
        {showSmsTarget && (
          <Text
            style={styles.coachNotifTarget}
            testID={`payout-notif-sms-target-${payoutId}`}
          >
            {coachPayoutTriedTargetLabel(i18n.language, notification.smsTargetMasked!)}
          </Text>
        )}
      </View>
      {bothMissed && (
        <View style={{ marginTop: 4 }}>
          <Text
            style={styles.coachNotifBothMissed}
            testID={`payout-notif-both-missed-${payoutId}`}
          >
            We couldn't reach you on push or SMS — your payout is still complete.
          </Text>
          {/* Task #1544 — deep link to the member-360 communication
              preferences screen so a coach who missed a payout-paid
              notification can re-enable push or update their phone in
              one tap. */}
          <Pressable
            onPress={() => router.push("/my-360/communications")}
            testID={`payout-notif-update-prefs-${payoutId}`}
            accessibilityRole="link"
            accessibilityLabel={coachPayoutUpdatePrefsLinkLabel(i18n.language)}
            hitSlop={8}
          >
            <Text style={styles.coachNotifUpdatePrefs}>{coachPayoutUpdatePrefsLinkLabel(i18n.language)}</Text>
          </Pressable>
        </View>
      )}
      {visibleRetryState.kind === "button" && (
        <Pressable
          onPress={onRetry}
          disabled={retrying}
          testID={`payout-notif-retry-${payoutId}`}
          accessibilityRole="button"
          accessibilityLabel="Try sending the payout notification again"
          style={({ pressed }) => [
            styles.coachNotifRetryBtn,
            pressed && { opacity: 0.7 },
            retrying && { opacity: 0.5 },
          ]}
        >
          <Text style={styles.coachNotifRetryBtnText}>
            {retrying ? "Retrying…" : "Try again"}
          </Text>
        </Pressable>
      )}
      {/* Task #1913 — Live cooldown countdown shown in place of the
          button while the per-payout cooldown is still ticking. The
          parent's `now` state ticks every second so this re-renders in
          place; the button reappears the moment the helper flips back
          to `kind === 'button'`. */}
      {visibleRetryState.kind === "countdown" && (
        <Text
          style={styles.coachNotifRetryCountdown}
          testID={`payout-notif-retry-countdown-${payoutId}`}
          accessibilityLabel={`Try again in ${formatCoachPayoutRetryCountdown(visibleRetryState.remainingMs)}`}
        >
          {/* Template-literal form (rather than bare JSX text + child
              expression) keeps the mobile-screen-translation linter
              happy — same precedent as the rest of this strip's
              English copy ("Retrying…" / "Try again"), which lives
              inside JSX expressions and is therefore exempt from the
              JsxText scan. The string still belongs in the existing
              "translate the new payout notification copy" follow-up. */}
          {`Try again in ${formatCoachPayoutRetryCountdown(visibleRetryState.remainingMs)}`}
        </Text>
      )}
      {/* Task #1914 — "contact support" deflection sits below both the
          button and the cooldown countdown so the coach always sees it
          once they've crossed the hint threshold, regardless of which
          state the retry control is currently in. */}
      {showSupportHint && (
        <View style={{ marginTop: 6 }}>
          <Text
            style={styles.coachNotifSupportHint}
            testID={`payout-notif-support-hint-${payoutId}`}
          >
            Still not getting through? We've alerted your club admin.
          </Text>
          <Pressable
            onPress={() =>
              Linking.openURL(
                "mailto:support@kharagolf.com?subject=Stuck%20payout%20notification",
              )
            }
            testID={`payout-notif-support-link-${payoutId}`}
            accessibilityRole="link"
            accessibilityLabel="Email support about a stuck payout notification"
            hitSlop={8}
          >
            <Text style={styles.coachNotifSupportLink}>Contact support</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// Task #1286 — bottom sheet listing the swing-review requests rolled up
// into a single coach payout. Falls back gracefully if the fetch fails or
// returns an empty list (e.g. payout had no requests, or the row is older
// than the payout-id backfill).
function PayoutDetailModal({ payout, token, onClose }: { payout: any; token: string | null; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ requests: Array<{ id: number; memberName: string; deliveredAt: string | null; pricePaise: number; coachSharePaise: number }>; sharePct: number } | null>(null);
  // Task #1512 — let coaches drill into the existing swing-review detail
  // screen straight from the payout breakdown without leaving the workspace.
  const [viewingRequestId, setViewingRequestId] = useState<number | null>(null);

  useEffect(() => {
    if (!token) { setLoading(false); setError("Not signed in"); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${BASE_URL}/api/swing-reviews/coach/payouts/${payout.id}/requests`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
        return body;
      })
      .then(d => { if (!cancelled) setData({ requests: d.requests ?? [], sharePct: Number(d.sharePct ?? 0) }); })
      .catch(e => { if (!cancelled) setError(e?.message ?? "Couldn't load reviews"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [payout.id, token]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View
          testID={`payout-detail-sheet-${payout.id}`}
          style={{
            backgroundColor: "#0a0a0a",
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            padding: 16,
            maxHeight: "80%",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>Reviews in this payout</Text>
              <Text style={styles.coachMeta}>
                {formatRupees(payout.netPayoutPaise ?? 0)} ·{" "}
                {new Date(payout.periodStart).toLocaleDateString()} – {new Date(payout.periodEnd).toLocaleDateString()}
              </Text>
              {payout.payoutReference ? (
                <Text style={styles.coachMeta}>Ref: {payout.payoutReference}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              testID={`payout-detail-sheet-${payout.id}-close`}
              accessibilityRole="button"
              accessibilityLabel="Close payout details"
              hitSlop={12}
            >
              <Feather name="x" size={24} color={GOLD} />
            </Pressable>
          </View>

          {loading ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <LoadingSpinner color={GOLD} />
            </View>
          ) : error ? (
            <Text testID={`payout-detail-sheet-${payout.id}-error`} style={[styles.coachMeta, { color: "#f99", marginTop: 8 }]}>
              Couldn't load reviews: {error}
            </Text>
          ) : !data || data.requests.length === 0 ? (
            <Text testID={`payout-detail-sheet-${payout.id}-empty`} style={[styles.coachMeta, { marginTop: 8 }]}>
              No reviews are linked to this payout yet.
            </Text>
          ) : (
            <ScrollView style={{ marginTop: 4 }} contentContainerStyle={{ paddingBottom: 24 }}>
              {data.sharePct > 0 && (
                <Text style={[styles.coachMeta, { marginBottom: 8 }]}>
                  Coach share: {data.sharePct}% of each review
                </Text>
              )}
              {data.requests.map(r => (
                <Pressable
                  key={r.id}
                  testID={`payout-detail-request-${r.id}`}
                  onPress={() => setViewingRequestId(r.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open review ${r.id} from ${r.memberName}`}
                  style={{ padding: 12, backgroundColor: "#1a1a1a", borderRadius: 8, marginBottom: 8, flexDirection: "row", alignItems: "center" }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={styles.coachName} numberOfLines={1}>{r.memberName}</Text>
                      <Text style={styles.coachName}>{formatRupees(r.pricePaise)}</Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
                      <Text style={styles.coachMeta}>
                        Review #{r.id}
                        {r.deliveredAt ? ` · Delivered ${new Date(r.deliveredAt).toLocaleDateString()}` : ""}
                      </Text>
                      <Text style={[styles.coachMeta, { color: GOLD }]}>
                        Your share: {formatRupees(r.coachSharePaise)}
                      </Text>
                    </View>
                  </View>
                  <Feather name="chevron-right" size={20} color={GOLD} style={{ marginLeft: 8 }} />
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
      {/* Task #1512 — open the same review detail screen the member flow
          uses, layered over the payout sheet. Closing it returns the coach
          to the breakdown so they can hop into another review. */}
      {viewingRequestId != null && (
        <RequestDetailModal
          id={viewingRequestId}
          token={token}
          onClose={() => setViewingRequestId(null)}
        />
      )}
    </Modal>
  );
}

type DrawTool = "select" | "line" | "arrow" | "circle" | "angle";
const DRAW_COLORS = ["#FFD700", "#FF4444", "#22DD88", "#44AAFF", "#FFFFFF"];

// Task #761 — fall back to 30fps only when the source video's true frame rate
// is unknown. The web coach UI detects fps via requestVideoFrameCallback and
// persists it on the swing video record; we read that value here so ±1 frame
// taps land on real frames for 60 / 120 / 240fps slow-mo footage.
const DEFAULT_FPS = 30;
const PLAYBACK_RATES = [0.25, 0.5, 1.0] as const;

const HIT_RADIUS = 18;
const HANDLE_RADIUS = 22;

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestDrawShape(s: DrawShape, px: number, py: number): boolean {
  if (s.kind === "line" || s.kind === "arrow") {
    return distToSegment(px, py, s.x1, s.y1, s.x2, s.y2) <= HIT_RADIUS;
  }
  if (s.kind === "circle") {
    const d = Math.hypot(px - s.x, py - s.y);
    return Math.abs(d - s.r) <= HIT_RADIUS || d <= s.r;
  }
  return (
    distToSegment(px, py, s.ax, s.ay, s.bx, s.by) <= HIT_RADIUS ||
    distToSegment(px, py, s.bx, s.by, s.cx, s.cy) <= HIT_RADIUS
  );
}

function shapeBoundingBox(s: DrawShape): { x: number; y: number; w: number; h: number } {
  if (s.kind === "line" || s.kind === "arrow") {
    const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
    return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }
  if (s.kind === "circle") return { x: s.x - s.r, y: s.y - s.r, w: s.r * 2, h: s.r * 2 };
  const xs = [s.ax, s.bx, s.cx], ys = [s.ay, s.by, s.cy];
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function translateDrawShape(s: DrawShape, dx: number, dy: number): DrawShape {
  if (s.kind === "line" || s.kind === "arrow")
    return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  if (s.kind === "circle") return { ...s, x: s.x + dx, y: s.y + dy };
  return { ...s, ax: s.ax + dx, ay: s.ay + dy, bx: s.bx + dx, by: s.by + dy, cx: s.cx + dx, cy: s.cy + dy };
}

type DrawDrag =
  | { kind: "move"; idx: number }
  | { kind: "endpoint"; idx: number; which: "1" | "2" | "a" | "b" | "c" }
  | { kind: "circle-resize"; idx: number };

function shapeHandles(s: DrawShape): Array<{ x: number; y: number; which: "1" | "2" | "a" | "b" | "c" | "r" }> {
  if (s.kind === "line" || s.kind === "arrow")
    return [{ x: s.x1, y: s.y1, which: "1" }, { x: s.x2, y: s.y2, which: "2" }];
  if (s.kind === "circle") return [{ x: s.x + s.r, y: s.y, which: "r" }];
  return [{ x: s.ax, y: s.ay, which: "a" }, { x: s.bx, y: s.by, which: "b" }, { x: s.cx, y: s.cy, which: "c" }];
}

// Task #1416 / #1711 — pure helper for the coach Deliver modal's
// "Duplicate group" action. Given the current shapes array, the
// indices of the multi-selected markers, the playhead `target` (in
// seconds), and the source clip `duration`, returns the next shapes
// array (with appended copies) plus the indices of the freshly pasted
// copies (which become the active selection). The earliest selected
// source anchors at `target`; the rest are shifted by the same delta
// so relative offsets between selected sources are preserved. Each
// new `t` is clamped to [0, duration] so a paste near the end can't
// overrun the clip. When nothing is selected (or every selected idx
// is out of range) the helper returns the original shapes array
// reference + empty selection — callers can short-circuit on === to
// skip a pointless re-render.
export function computeDuplicateGroupShapes(
  shapes: DrawShape[],
  selectedIdxs: number[],
  target: number,
  duration: number,
): { shapes: DrawShape[]; selectedIdxs: number[] } {
  if (selectedIdxs.length === 0) return { shapes, selectedIdxs: [] };
  const sel = selectedIdxs.map(i => shapes[i]).filter((x): x is DrawShape => !!x);
  if (sel.length === 0) return { shapes, selectedIdxs: [] };
  const minT = Math.min(...sel.map(sh => sh.t));
  const cap = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const copies: DrawShape[] = sel.map(sh => ({
    ...sh,
    t: Math.max(0, Math.min(cap, target + (sh.t - minT))),
  }));
  const next = [...shapes, ...copies];
  const newIdxs = copies.map((_, k) => shapes.length + k);
  return { shapes: next, selectedIdxs: newIdxs };
}

// Task #2131 — server-backed named drawing-preset library row. Mirrors the
// API response shape; drawings is typed as DrawShape[] but tolerates the
// raw JSONB blob from older clients.
export interface DrawingPreset {
  id: number;
  name: string;
  drawings: DrawShape[];
  createdAt: string;
  updatedAt: string;
}

export function CoachDeliverModal({ queueItem, token, onClose, drawingClipboard, setDrawingClipboard, drawingPresets, setDrawingPresets }: {
  queueItem: any;
  token: string | null;
  onClose: () => void;
  drawingClipboard: DrawShape[];
  setDrawingClipboard: React.Dispatch<React.SetStateAction<DrawShape[]>>;
  drawingPresets: DrawingPreset[];
  setDrawingPresets: React.Dispatch<React.SetStateAction<DrawingPreset[]>>;
}) {
  const [textNotes, setTextNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [tool, setTool] = useState<DrawTool>("line");
  const [color, setColor] = useState(DRAW_COLORS[0]);
  const [drawMode, setDrawMode] = useState(false);
  const [overlay, setOverlay] = useState({ width: 0, height: 0 });
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [scrubberWidth, setScrubberWidth] = useState(0);
  const [shapeTimelineWidth, setShapeTimelineWidth] = useState(0);
  // Task #1216 — multi-select. The "primary" entry (last in the array) is
  // used by single-target actions (duplicate, move-to-current-time); group
  // actions (timeline drag, delete, retime ±1f) operate on the entire set.
  const [selectedIdxs, setSelectedIdxs] = useState<number[]>([]);
  const primarySelectedIdx = selectedIdxs.length > 0 ? selectedIdxs[selectedIdxs.length - 1] : null;
  const selectedIdxsRef = useRef<number[]>([]);
  useEffect(() => { selectedIdxsRef.current = selectedIdxs; }, [selectedIdxs]);
  // Task #1216 — once a coach long-presses a marker we enter "multi-select
  // mode": every subsequent plain tap on a marker toggles its membership in
  // the selection (no need to long-press each one). The mode auto-disables
  // when the selection becomes empty so a fresh tap returns to single-select.
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const multiSelectModeRef = useRef(false);
  useEffect(() => { multiSelectModeRef.current = multiSelectMode; }, [multiSelectMode]);
  useEffect(() => { if (selectedIdxs.length === 0) setMultiSelectMode(false); }, [selectedIdxs]);
  const dragModeRef = useRef<DrawDrag | null>(null);
  const dragLastRef = useRef<{ x: number; y: number } | null>(null);
  const shapesRef = useRef<DrawShape[]>([]);
  useEffect(() => { shapesRef.current = shapes; }, [shapes]);
  const shapeTimelineWidthRef = useRef(0);
  useEffect(() => { shapeTimelineWidthRef.current = shapeTimelineWidth; }, [shapeTimelineWidth]);
  const markerDragIdxRef = useRef<number | null>(null);
  // Task #1216 — long-press-then-tap multi-select on the timeline strip.
  // We track per-touch state so we can distinguish a quick tap (single
  // select) from a long-press (toggle membership) from a drag (move group).
  const LONG_PRESS_MS = 400;
  const TAP_MOVE_THRESHOLD = 6;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markerTouchRef = useRef<{
    bestIdx: number;
    longPressed: boolean;
    moved: boolean;
    group: { baseTimes: Map<number, number>; minDelta: number; maxDelta: number; baseT: number } | null;
  } | null>(null);
  // Task #1415 — long-press-then-drag on the timeline strip background
  // sweeps a rectangle and selects every marker whose time falls inside.
  // We track a separate "box-select" touch state so it doesn't collide
  // with the marker drag gesture (the two are mutually exclusive per
  // touch — at grant time we decide based on whether a marker is hit).
  const [boxSelectRect, setBoxSelectRect] = useState<{ startX: number; currentX: number } | null>(null);
  const boxSelectTouchRef = useRef<{
    startX: number;
    active: boolean;
    baseSelection: number[];
  } | null>(null);

  const [recording, setRecording] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const [voiceUploadToken, setVoiceUploadToken] = useState<string | null>(null);
  const [voiceUploadTokenExp, setVoiceUploadTokenExp] = useState<number | null>(null);
  const [voiceDuration, setVoiceDuration] = useState<number | null>(null);

  const videoRef = useRef<Video | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordStartRef = useRef<number>(0);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const angleClicksRef = useRef<Array<{ x: number; y: number }>>([]);
  const [, forceTick] = useState(0);
  const tickRef = useRef(0);
  const tick = () => { tickRef.current++; forceTick(tickRef.current); };

  const videoSrc = queueItem.videoUrl?.startsWith("/") ? `${BASE_URL}${queueItem.videoUrl}` : queueItem.videoUrl;

  // Task #761 — use the swing video's true fps (recorded by an earlier viewer)
  // to size the ±1 frame step. Fall back to 30fps only when unknown.
  const detectedFps = (() => {
    const f = Number(queueItem.videoFps);
    return Number.isFinite(f) && f > 0 ? f : null;
  })();
  const sourceFps = detectedFps ?? DEFAULT_FPS;

  const scrubberWidthRef = useRef(0);
  const durationRef = useRef(0);

  const onPlaybackStatus = (st: AVPlaybackStatus) => {
    if (st.isLoaded) {
      if (typeof st.positionMillis === "number") setVideoTime(st.positionMillis / 1000);
      if (typeof st.durationMillis === "number" && st.durationMillis > 0) {
        setVideoDuration(st.durationMillis / 1000);
      }
      setIsPlaying(!!st.isPlaying);
    }
  };

  useEffect(() => {
    videoRef.current?.setRateAsync(playbackRate, true)
      .catch((e) => console.warn("[coach] setRateAsync failed", e));
  }, [playbackRate]);
  useEffect(() => { scrubberWidthRef.current = scrubberWidth; }, [scrubberWidth]);
  useEffect(() => { durationRef.current = videoDuration; }, [videoDuration]);

  const seekTo = async (seconds: number) => {
    const v = videoRef.current; if (!v) return;
    const dur = durationRef.current;
    const clamped = Math.max(0, Math.min(dur || 0, seconds));
    try {
      await v.pauseAsync();
      // Task #761 — keep sub-millisecond precision so 120/240fps stepping
      // (8.33ms / 4.17ms per frame) doesn't drift over repeated presses.
      // expo-av's setPositionAsync accepts a number; rounding to integer ms
      // would bake in rounding error every step.
      await v.setPositionAsync(clamped * 1000);
      setVideoTime(clamped);
    } catch (e) {
      console.warn("[coach] seekTo failed", e);
    }
  };

  const seekBy = async (deltaMs: number) => {
    await seekTo(videoTime + deltaMs / 1000);
  };

  // Task #761 — step exactly one frame by quantising the current position to
  // the nearest frame boundary first, then jumping to (currentFrame + delta)
  // and landing inside that frame's window. Mirrors the web implementation so
  // repeated ±1 presses visit consecutive real frames without drift, even at
  // 60/120/240fps.
  const stepOneFrame = async (delta: number) => {
    const v = videoRef.current; if (!v) return;
    const dur = durationRef.current;
    const frameInterval = 1 / sourceFps;
    // Use floor (not round): we land mid-frame at (n + 0.5) * frameInterval,
    // so round would bump us up by one and the next +1 press would skip a
    // frame. floor recovers the actual frame index that contains videoTime.
    const currentFrame = Math.floor(videoTime * sourceFps);
    const targetFrame = Math.max(0, currentFrame + delta);
    const next = Math.max(0, Math.min(dur || 0, targetFrame * frameInterval + frameInterval / 2));
    try {
      await v.pauseAsync();
      await v.setPositionAsync(next * 1000);
      setVideoTime(next);
    } catch (e) {
      console.warn("[coach] stepOneFrame failed", e);
    }
  };

  const togglePlay = async () => {
    const v = videoRef.current; if (!v) return;
    try {
      if (isPlaying) await v.pauseAsync();
      else {
        await v.playAsync();
        await v.setRateAsync(playbackRate, true)
          .catch((e) => console.warn("[coach] setRateAsync (play) failed", e));
      }
    } catch (e) {
      console.warn("[coach] togglePlay failed", e);
    }
  };

  const scrubberPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const w = scrubberWidthRef.current;
        const dur = durationRef.current;
        if (w <= 0 || dur <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.nativeEvent as any).locationX / w));
        seekTo(ratio * dur);
      },
      onPanResponderMove: (e) => {
        const w = scrubberWidthRef.current;
        const dur = durationRef.current;
        if (w <= 0 || dur <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.nativeEvent as any).locationX / w));
        seekTo(ratio * dur);
      },
    })
  ).current;

  // Task #1055 — drag a shape's marker on the timeline strip to retime it.
  // We use a single PanResponder on the strip (not one per marker) so a touch
  // can grab the closest marker by hit-test, then drag it to a new time.
  // Task #1216 — the same gesture also drives multi-select using the
  // long-press-then-tap pattern: a long-press on a marker toggles its
  // membership in the selection (without starting a drag), a quick tap
  // single-selects, and a drag from a selected marker moves every selected
  // marker by the same time delta (clamped so no marker leaves [0, dur]).
  const SHAPE_MARKER_HIT_PX = 22;
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const shapeTimelinePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const w = shapeTimelineWidthRef.current;
        const dur = durationRef.current;
        if (w <= 0 || dur <= 0) return;
        const x = (e.nativeEvent as any).locationX;
        let bestIdx = -1;
        let bestDist = SHAPE_MARKER_HIT_PX;
        shapesRef.current.forEach((s, i) => {
          const mx = (s.t / dur) * w;
          const d = Math.abs(mx - x);
          if (d <= bestDist) { bestDist = d; bestIdx = i; }
        });
        if (bestIdx < 0) {
          // Task #1415 — touch landed on empty strip background. Set up a
          // pending box-select: a long-press here arms the gesture so a
          // follow-on horizontal drag sweeps a selection rectangle. A
          // quick tap on empty area does nothing (matches scrubbing UX).
          markerTouchRef.current = null;
          markerDragIdxRef.current = null;
          const startX = Math.max(0, Math.min(w, x));
          boxSelectTouchRef.current = {
            startX,
            active: false,
            // If we're already in multi-select mode, extend the existing
            // selection; otherwise replace it (mirrors web shift-vs-plain).
            baseSelection: multiSelectModeRef.current
              ? selectedIdxsRef.current.slice()
              : [],
          };
          clearLongPressTimer();
          longPressTimerRef.current = setTimeout(() => {
            const bst = boxSelectTouchRef.current;
            if (!bst) return;
            bst.active = true;
            setTool("select");
            // Show the rectangle immediately at the touch point so the
            // coach sees the gesture has been recognised before they drag.
            setBoxSelectRect({ startX: bst.startX, currentX: bst.startX });
            if (!multiSelectModeRef.current) {
              setSelectedIdxs([]);
            }
          }, LONG_PRESS_MS);
          return;
        }
        markerDragIdxRef.current = bestIdx;
        markerTouchRef.current = {
          bestIdx,
          longPressed: false,
          moved: false,
          group: null,
        };
        clearLongPressTimer();
        longPressTimerRef.current = setTimeout(() => {
          const tch = markerTouchRef.current;
          if (!tch || tch.moved) return;
          tch.longPressed = true;
          // Selecting from the timeline switches the tool to "select" so the
          // selection is visible on the canvas overlay too (mirrors web).
          setTool("select");
          // Long-press enters (or stays in) multi-select mode and toggles
          // membership; subsequent plain taps also toggle while mode is on.
          setMultiSelectMode(true);
          setSelectedIdxs(prev => prev.includes(bestIdx)
            ? prev.filter(j => j !== bestIdx)
            : [...prev, bestIdx]);
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (e, g) => {
        // Task #1415 — box-select branch (empty-area touch). If the
        // long-press has armed the gesture, sweep the rectangle and
        // recompute selection live; if the user dragged before the
        // long-press fired, cancel the pending box-select instead.
        const bst = boxSelectTouchRef.current;
        if (bst) {
          if (!bst.active) {
            if (Math.abs(g.dx) > TAP_MOVE_THRESHOLD || Math.abs(g.dy) > TAP_MOVE_THRESHOLD) {
              clearLongPressTimer();
              boxSelectTouchRef.current = null;
            }
            return;
          }
          const w = shapeTimelineWidthRef.current;
          const dur = durationRef.current;
          if (w <= 0 || dur <= 0) return;
          const currentX = Math.max(0, Math.min(w, (e.nativeEvent as any).locationX));
          setBoxSelectRect({ startX: bst.startX, currentX });
          const lo = Math.min(bst.startX, currentX);
          const hi = Math.max(bst.startX, currentX);
          const tLo = (lo / w) * dur;
          const tHi = (hi / w) * dur;
          const inRange: number[] = [];
          shapesRef.current.forEach((s, idx) => {
            if (s.t >= tLo && s.t <= tHi) inRange.push(idx);
          });
          const merged: number[] = [];
          const seen = new Set<number>();
          for (const idx of [...bst.baseSelection, ...inRange]) {
            if (!seen.has(idx)) { seen.add(idx); merged.push(idx); }
          }
          setSelectedIdxs(merged);
          return;
        }
        const tch = markerTouchRef.current;
        if (!tch) return;
        if (!tch.moved && (Math.abs(g.dx) > TAP_MOVE_THRESHOLD || Math.abs(g.dy) > TAP_MOVE_THRESHOLD)) {
          tch.moved = true;
          clearLongPressTimer();
          if (tch.longPressed) {
            // Already toggled membership; a follow-on movement shouldn't drag.
            markerDragIdxRef.current = null;
            return;
          }
          const dur = durationRef.current;
          if (dur <= 0) { markerDragIdxRef.current = null; return; }
          // If the grabbed marker is part of a multi-selection, drag the
          // whole group; otherwise replace the selection with just this one.
          const sel = selectedIdxsRef.current;
          const groupIdxs = (sel.includes(tch.bestIdx) && sel.length > 1) ? sel : [tch.bestIdx];
          if (!sel.includes(tch.bestIdx) || sel.length <= 1) {
            setTool("select");
            setSelectedIdxs(groupIdxs);
          }
          const baseTimes = new Map<number, number>();
          groupIdxs.forEach(idx => baseTimes.set(idx, shapesRef.current[idx]?.t ?? 0));
          const baseT = baseTimes.get(tch.bestIdx) ?? 0;
          const minT = Math.min(...baseTimes.values());
          const maxT = Math.max(...baseTimes.values());
          tch.group = { baseTimes, baseT, minDelta: -minT, maxDelta: dur - maxT };
        }
        if (!tch.group) return;
        const w = shapeTimelineWidthRef.current;
        const dur = durationRef.current;
        if (w <= 0 || dur <= 0) return;
        const clampedX = Math.max(0, Math.min(w, (e.nativeEvent as any).locationX));
        const t = (clampedX / w) * dur;
        const desired = t - tch.group.baseT;
        const delta = Math.max(tch.group.minDelta, Math.min(tch.group.maxDelta, desired));
        const baseTimes = tch.group.baseTimes;
        setShapes(prev => prev.map((sh, j) => {
          const base = baseTimes.get(j);
          return base != null ? { ...sh, t: base + delta } : sh;
        }));
      },
      onPanResponderRelease: () => {
        clearLongPressTimer();
        // Task #1415 — finalise the box-select gesture. If it actually
        // armed, leave the swept selection in place and turn on
        // multi-select mode so further taps continue to add markers
        // (matches the long-press → multi-select pattern). Always clear
        // the rectangle on release.
        const bst = boxSelectTouchRef.current;
        if (bst) {
          if (bst.active && selectedIdxsRef.current.length > 0) {
            setMultiSelectMode(true);
          }
          boxSelectTouchRef.current = null;
          setBoxSelectRect(null);
        }
        const tch = markerTouchRef.current;
        if (tch && !tch.moved && !tch.longPressed) {
          setTool("select");
          if (multiSelectModeRef.current) {
            // In multi-select mode (entered via long-press), plain taps
            // toggle membership without resetting the existing selection.
            setSelectedIdxs(prev => prev.includes(tch.bestIdx)
              ? prev.filter(j => j !== tch.bestIdx)
              : [...prev, tch.bestIdx]);
          } else {
            // Default mode: quick tap = single-select that marker.
            setSelectedIdxs([tch.bestIdx]);
          }
        }
        markerTouchRef.current = null;
        markerDragIdxRef.current = null;
      },
      onPanResponderTerminate: () => {
        clearLongPressTimer();
        boxSelectTouchRef.current = null;
        setBoxSelectRect(null);
        markerTouchRef.current = null;
        markerDragIdxRef.current = null;
      },
    })
  ).current;

  const onOverlayLayout = (e: LayoutChangeEvent) => {
    setOverlay({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        const p = { x: locationX, y: locationY };
        if (toolRef.current === "select") {
          // Hit-test visible shapes (top-most first)
          const t = timeRef.current;
          const visibleIdx: number[] = [];
          const coachVisibilityWindow = 0.5 / sourceFps;
          shapesRef.current.forEach((s, i) => { if (Math.abs(s.t - t) <= coachVisibilityWindow) visibleIdx.push(i); });
          const order = visibleIdx.slice().reverse();
          let hit: DrawDrag | null = null;
          for (const i of order) {
            const s = shapesRef.current[i];
            // Handle hit-test first
            for (const h of shapeHandles(s)) {
              if (Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_RADIUS) {
                if (h.which === "r") hit = { kind: "circle-resize", idx: i };
                else hit = { kind: "endpoint", idx: i, which: h.which };
                break;
              }
            }
            if (hit) break;
            if (hitTestDrawShape(s, p.x, p.y)) { hit = { kind: "move", idx: i }; break; }
          }
          if (hit) {
            dragModeRef.current = hit;
            dragLastRef.current = p;
            setSelectedIdxs([hit.idx]);
          } else {
            dragModeRef.current = null;
            dragLastRef.current = null;
            setSelectedIdxs([]);
          }
          tick();
          return;
        }
        if (toolRef.current === "angle") {
          angleClicksRef.current.push(p);
          if (angleClicksRef.current.length === 3) {
            const [a, b, c] = angleClicksRef.current;
            angleClicksRef.current = [];
            setShapes(s => [...s, { kind: "angle", t: timeRef.current, ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: c.x, cy: c.y, color: colorRef.current }]);
          } else {
            tick();
          }
          return;
        }
        dragStartRef.current = p;
        dragCurrentRef.current = p;
        tick();
      },
      onPanResponderMove: (evt) => {
        if (toolRef.current === "select") {
          const drag = dragModeRef.current;
          const last = dragLastRef.current;
          if (!drag || !last) return;
          const p = { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
          const dx = p.x - last.x, dy = p.y - last.y;
          setShapes(prev => prev.map((s, i) => {
            if (i !== drag.idx) return s;
            if (drag.kind === "move") return translateDrawShape(s, dx, dy);
            if (drag.kind === "circle-resize" && s.kind === "circle") {
              return { ...s, r: Math.max(4, Math.hypot(p.x - s.x, p.y - s.y)) };
            }
            if (drag.kind === "endpoint") {
              if ((s.kind === "line" || s.kind === "arrow") && drag.which === "1") return { ...s, x1: p.x, y1: p.y };
              if ((s.kind === "line" || s.kind === "arrow") && drag.which === "2") return { ...s, x2: p.x, y2: p.y };
              if (s.kind === "angle" && (drag.which === "a" || drag.which === "b" || drag.which === "c")) {
                return { ...s, [`${drag.which}x`]: p.x, [`${drag.which}y`]: p.y } as DrawShape;
              }
            }
            return s;
          }));
          dragLastRef.current = p;
          return;
        }
        if (toolRef.current === "angle") return;
        if (!dragStartRef.current) return;
        dragCurrentRef.current = { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
        tick();
      },
      onPanResponderRelease: () => {
        if (toolRef.current === "select") {
          dragModeRef.current = null;
          dragLastRef.current = null;
          return;
        }
        if (toolRef.current === "angle") return;
        const start = dragStartRef.current;
        const end = dragCurrentRef.current;
        dragStartRef.current = null;
        dragCurrentRef.current = null;
        if (!start || !end) return;
        const t = timeRef.current;
        const c = colorRef.current;
        if (toolRef.current === "line") {
          setShapes(s => [...s, { kind: "line", t, x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: c }]);
        } else if (toolRef.current === "arrow") {
          setShapes(s => [...s, { kind: "arrow", t, x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: c }]);
        } else if (toolRef.current === "circle") {
          const r = Math.max(2, Math.hypot(end.x - start.x, end.y - start.y));
          setShapes(s => [...s, { kind: "circle", t, x: start.x, y: start.y, r, color: c }]);
        }
        tick();
      },
    })
  ).current;

  // Refs to keep latest tool/color/time inside PanResponder closures
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const timeRef = useRef(videoTime);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { timeRef.current = videoTime; }, [videoTime]);

  const undo = () => { setShapes(s => s.slice(0, -1)); setSelectedIdxs([]); };
  const clearAll = () => { setShapes([]); angleClicksRef.current = []; setSelectedIdxs([]); };
  const deleteSelected = () => {
    if (selectedIdxs.length === 0) return;
    const sel = new Set(selectedIdxs);
    setShapes(s => s.filter((_, i) => !sel.has(i)));
    setSelectedIdxs([]);
  };
  const duplicateSelected = () => {
    if (primarySelectedIdx == null) return;
    setShapes(s => {
      const orig = s[primarySelectedIdx];
      if (!orig) return s;
      const copy: DrawShape = { ...orig, t: timeRef.current };
      const next = [...s, copy];
      setSelectedIdxs([next.length - 1]);
      return next;
    });
  };
  // Task #1416 — copy every selected drawing to the current playhead time
  // while preserving relative time offsets between markers in the group.
  // Delegates to the pure helper `computeDuplicateGroupShapes` so the
  // math is unit-testable from a vitest run that doesn't have to drive
  // the full PanResponder + Video stack (Task #1711 mobile coverage).
  const duplicateGroupToCurrent = () => {
    if (selectedIdxs.length === 0) return;
    const target = timeRef.current;
    const dur = videoDuration;
    setShapes(s => {
      const result = computeDuplicateGroupShapes(s, selectedIdxs, target, dur);
      if (result.shapes === s) return s;
      setSelectedIdxs(result.selectedIdxs);
      return result.shapes;
    });
  };
  // Task #1712 — coach-local clipboard for re-using callout patterns across
  // reviews. Copy stashes the current selection (or the whole shape list when
  // nothing is selected) into a parent-owned in-memory clipboard. Paste drops
  // the clipboard contents at the current playhead, re-using the same
  // offset-preserving math as duplicateGroupToCurrent (Task #1416) so an
  // alignment line + setup circle + impact angle keeps its relative timing.
  // Pasted shapes become the active selection so the coach can immediately
  // nudge them to fit the new member's swing.
  const copyDrawings = () => {
    const source = selectedIdxs.length > 0
      ? selectedIdxs.map(i => shapes[i]).filter((x): x is DrawShape => !!x)
      : shapes;
    if (source.length === 0) {
      Alert.alert("Nothing to copy", "Add a drawing first.");
      return;
    }
    // Snapshot so subsequent edits to these shapes in this review don't
    // mutate the clipboard contents the coach will paste later.
    setDrawingClipboard(source.map(sh => ({ ...sh })));
  };
  const pasteDrawings = () => {
    if (drawingClipboard.length === 0) return;
    const target = timeRef.current;
    const dur = videoDuration;
    setShapes(s => {
      const minT = Math.min(...drawingClipboard.map(sh => sh.t));
      const cap = Number.isFinite(dur) && dur > 0 ? dur : Number.POSITIVE_INFINITY;
      const copies: DrawShape[] = drawingClipboard.map(sh => ({
        ...sh,
        t: Math.max(0, Math.min(cap, target + (sh.t - minT))),
      }));
      const next = [...s, ...copies];
      const newIdxs = copies.map((_, k) => s.length + k);
      setSelectedIdxs(newIdxs);
      return next;
    });
    setTool("select");
  };

  // Task #2131 — persistent named-preset library. Save uses the same
  // selected-vs-all rule as Copy. Apply uses the same offset-preserving
  // math as pasteDrawings so multi-shape patterns keep their internal
  // timing relative to the playhead. The "name this preset" prompt is
  // a controlled modal because RN's Alert.prompt is iOS-only.
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [presetNameModal, setPresetNameModal] = useState<{ mode: "create" | "rename"; targetId: number | null; initial: string; pendingDrawings: DrawShape[] | null } | null>(null);
  const [presetNameDraft, setPresetNameDraft] = useState("");

  const openCreatePresetModal = () => {
    const source = selectedIdxs.length > 0
      ? selectedIdxs.map(i => shapes[i]).filter((x): x is DrawShape => !!x)
      : shapes;
    if (source.length === 0) {
      Alert.alert("Nothing to save", "Add a drawing first.");
      return;
    }
    setPresetNameDraft("");
    setPresetNameModal({ mode: "create", targetId: null, initial: "", pendingDrawings: source.map(sh => ({ ...sh })) });
  };

  const openRenamePresetModal = (preset: DrawingPreset) => {
    setPresetNameDraft(preset.name);
    setPresetNameModal({ mode: "rename", targetId: preset.id, initial: preset.name, pendingDrawings: null });
  };

  const submitPresetNameModal = async () => {
    const modal = presetNameModal;
    if (!modal || !token) return;
    const name = presetNameDraft.trim();
    if (!name) {
      Alert.alert("Name required", "Give the preset a short name.");
      return;
    }
    if (name.length > 80) {
      Alert.alert("Name too long", "Keep preset names under 80 characters.");
      return;
    }
    if (modal.mode === "create" && modal.pendingDrawings) {
      setSavingPreset(true);
      try {
        const r = await fetch(`${BASE_URL}/api/swing-reviews/coach/drawing-presets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name, drawings: modal.pendingDrawings }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          Alert.alert("Save failed", body.error || `Server returned ${r.status}.`);
          return;
        }
        const body = await r.json();
        const newPreset: DrawingPreset = body.preset;
        setDrawingPresets(prev => [newPreset, ...prev.filter(p => p.id !== newPreset.id)]);
        setPresetNameModal(null);
        Alert.alert("Saved", `"${newPreset.name}" added to your preset library.`);
      } catch {
        Alert.alert("Save failed", "Network error — try again.");
      } finally {
        setSavingPreset(false);
      }
    } else if (modal.mode === "rename" && modal.targetId != null) {
      if (name === modal.initial) { setPresetNameModal(null); return; }
      try {
        const r = await fetch(`${BASE_URL}/api/swing-reviews/coach/drawing-presets/${modal.targetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) {
          Alert.alert("Rename failed", `Server returned ${r.status}.`);
          return;
        }
        const body = await r.json();
        const updated: DrawingPreset = body.preset;
        setDrawingPresets(prev => [updated, ...prev.filter(p => p.id !== updated.id)]);
        setPresetNameModal(null);
      } catch {
        Alert.alert("Rename failed", "Network error — try again.");
      }
    }
  };

  const applyPreset = (preset: DrawingPreset) => {
    if (!Array.isArray(preset.drawings) || preset.drawings.length === 0) {
      Alert.alert("Empty preset", "This preset has no drawings to paste.");
      return;
    }
    const target = timeRef.current;
    const dur = videoDuration;
    setShapes(s => {
      const minT = Math.min(...preset.drawings.map(sh => sh.t ?? 0));
      const cap = Number.isFinite(dur) && dur > 0 ? dur : Number.POSITIVE_INFINITY;
      const copies: DrawShape[] = preset.drawings.map(sh => ({
        ...sh,
        t: Math.max(0, Math.min(cap, target + ((sh.t ?? 0) - minT))),
      }));
      const next = [...s, ...copies];
      const newIdxs = copies.map((_, k) => s.length + k);
      setSelectedIdxs(newIdxs);
      return next;
    });
    setTool("select");
    setPresetMenuOpen(false);
  };

  const deletePreset = (preset: DrawingPreset) => {
    if (!token) return;
    Alert.alert(
      `Delete "${preset.name}"?`,
      "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const r = await fetch(`${BASE_URL}/api/swing-reviews/coach/drawing-presets/${preset.id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!r.ok && r.status !== 404) {
                Alert.alert("Delete failed", `Server returned ${r.status}.`);
                return;
              }
              setDrawingPresets(prev => prev.filter(p => p.id !== preset.id));
            } catch {
              Alert.alert("Delete failed", "Network error — try again.");
            }
          },
        },
      ],
    );
  };

  const retimeSelectedToCurrent = () => {
    if (selectedIdxs.length === 0) return;
    const t = timeRef.current;
    const sel = new Set(selectedIdxs);
    setShapes(s => s.map((sh, i) => sel.has(i) ? { ...sh, t } : sh));
  };
  const retimeSelectedByFrames = (delta: number) => {
    if (selectedIdxs.length === 0) return;
    const frameInterval = 1 / sourceFps;
    const dur = videoDuration;
    const sel = new Set(selectedIdxs);
    setShapes(s => s.map((sh, i) => {
      if (!sel.has(i)) return sh;
      const currentFrame = Math.floor(sh.t * sourceFps);
      const targetFrame = Math.max(0, currentFrame + delta);
      const next = Math.min(dur || Number.POSITIVE_INFINITY,
        targetFrame * frameInterval + frameInterval / 2);
      return { ...sh, t: next };
    }));
  };
  useEffect(() => { if (tool !== "select") setSelectedIdxs([]); }, [tool]);
  // Task #1216 — clean up any pending long-press timer if the modal closes.
  useEffect(() => () => { clearLongPressTimer(); }, []);

  const start = async () => {
    if (!token) return;
    await fetch(`${BASE_URL}/api/swing-reviews/requests/${queueItem.request.id}/start`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    Alert.alert("Started", "Marked as in-review");
  };

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert("Microphone permission required"); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      recordStartRef.current = Date.now();
      setRecording(true);
    } catch (e: any) {
      Alert.alert("Recording failed", String(e?.message ?? e));
    }
  };
  const stopRecording = async () => {
    const rec = recordingRef.current;
    if (!rec) return;
    setRecording(false);
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      const dur = (Date.now() - recordStartRef.current) / 1000;
      setVoiceDuration(dur);
      recordingRef.current = null;
      if (uri && token) await uploadVoice(uri);
    } catch (e: any) {
      Alert.alert("Stop recording failed", String(e?.message ?? e));
    }
  };

  const uploadVoice = async (fileUri: string) => {
    if (!token) return;
    setUploadingVoice(true);
    try {
      const urlRes = await fetch(`${BASE_URL}/api/swing-videos/upload-url`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const { uploadUrl, objectPath, uploadToken, uploadTokenExp } = await urlRes.json();
      if (!uploadUrl || !objectPath || !uploadToken) throw new Error("No upload URL");
      const blob = await (await fetch(fileUri)).blob();
      const put = await fetch(uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": "audio/m4a" } });
      if (!put.ok) throw new Error("Upload failed");
      setVoiceUrl(objectPath);
      setVoiceUploadToken(uploadToken);
      setVoiceUploadTokenExp(uploadTokenExp);
    } catch (e: any) {
      Alert.alert("Voice upload failed", String(e?.message ?? e));
    } finally {
      setUploadingVoice(false);
    }
  };

  const deliver = async () => {
    if (!token) return;
    if (!textNotes.trim() && shapes.length === 0 && !voiceUrl) {
      Alert.alert("Add feedback", "Add written notes, drawings, or a voice-over before delivering.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/swing-reviews/requests/${queueItem.request.id}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          textNotes,
          drawings: shapes,
          voiceOverUrl: voiceUrl ?? undefined,
          voiceOverUploadToken: voiceUploadToken ?? undefined,
          voiceOverUploadTokenExp: voiceUploadTokenExp ?? undefined,
          voiceOverDurationSeconds: voiceDuration ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.success) { Alert.alert("Delivered", "Review sent to member."); onClose(); }
      else Alert.alert("Error", data.error ?? "Failed");
    } finally { setSubmitting(false); }
  };

  const dStart = dragStartRef.current;
  const dEnd = dragCurrentRef.current;
  const previewShape: DrawShape | null = (drawMode && dStart && dEnd && tool !== "angle" && tool !== "select")
    ? (tool === "line"
        ? { kind: "line", t: videoTime, x1: dStart.x, y1: dStart.y, x2: dEnd.x, y2: dEnd.y, color }
        : tool === "arrow"
          ? { kind: "arrow", t: videoTime, x1: dStart.x, y1: dStart.y, x2: dEnd.x, y2: dEnd.y, color }
          : { kind: "circle", t: videoTime, x: dStart.x, y: dStart.y, r: Math.hypot(dEnd.x - dStart.x, dEnd.y - dStart.y), color })
    : null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={styles.modalContainer} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={styles.modalTitle}>Review #{queueItem.request.id}</Text>
          <Pressable onPress={onClose}><Feather name="x" size={28} color="#fff" /></Pressable>
        </View>
        {videoSrc && (
          <View style={{ height: 320, marginTop: 16, backgroundColor: "#000" }} onLayout={onOverlayLayout}>
            <Video
              ref={videoRef}
              source={{ uri: videoSrc }}
              style={{ flex: 1 }}
              useNativeControls={!drawMode}
              resizeMode={ResizeMode.CONTAIN}
              progressUpdateIntervalMillis={120}
              onPlaybackStatusUpdate={onPlaybackStatus}
            />
            {/* Read-only shapes overlay (always visible) */}
            {overlay.width > 0 && (
              <View pointerEvents={drawMode ? "auto" : "none"}
                testID="coach-deliver-canvas-overlay"
                style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                {...(drawMode ? panResponder.panHandlers : {})}>
                <Svg width={overlay.width} height={overlay.height}>
                  {/* Task #912 — frame-scale visibility so retiming a shape by
                      ±1 frame visibly moves it off the old frame and onto the
                      new one. */}
                  {(() => {
                    const coachVisibilityWindow = 0.5 / sourceFps;
                    return shapes.map((s, idx) => {
                      if (Math.abs(s.t - videoTime) > coachVisibilityWindow) return null;
                      return <ShapeSvg key={"saved-" + idx} shape={s} />;
                    });
                  })()}
                  {previewShape && <ShapeSvg shape={previewShape} />}
                  {drawMode && tool === "angle" && angleClicksRef.current.map((p, i) => (
                    <SvgCircle key={"ang-" + i} cx={p.x} cy={p.y} r={4} fill={color} />
                  ))}
                  {drawMode && tool === "select" && selectedIdxs.length > 0 && (() => {
                    // Task #1216 — highlight every selected shape with the
                    // dashed bounding box so the canvas overlay stays in sync
                    // with the timeline-strip selection. Manipulation handles
                    // are only drawn for the primary (last-selected) shape.
                    // Task #2128 — each per-shape highlight gets a stable
                    // testID so the mobile box-select e2e (which mirrors
                    // the web sibling at coach-workspace-timeline-box-
                    // select) can assert the on-canvas highlights track
                    // the swept marker range, not just the timeline-strip
                    // marker borders.
                    return (
                      <>
                        {selectedIdxs.map((selIdx) => {
                          const sel = shapes[selIdx];
                          if (!sel) return null;
                          const b = shapeBoundingBox(sel);
                          return (
                            <SvgRect
                              key={"sel-box-" + selIdx}
                              testID={`canvas-selection-box-${selIdx}`}
                              x={b.x - 6} y={b.y - 6} width={b.w + 12} height={b.h + 12}
                              stroke="#00BFFF" strokeWidth={1.5} strokeDasharray="6,4" fill="none"
                            />
                          );
                        })}
                        {primarySelectedIdx != null && shapes[primarySelectedIdx] && shapeHandles(shapes[primarySelectedIdx]).map((h, i) => (
                          <SvgCircle key={"h-" + i} cx={h.x} cy={h.y} r={7} fill="#00BFFF" />
                        ))}
                      </>
                    );
                  })()}
                </Svg>
              </View>
            )}
          </View>
        )}

        {/* Scrubber + playback rate controls */}
        <View style={styles.playbackBar}>
          <Pressable onPress={togglePlay} style={styles.smallBtn}>
            <Text style={styles.smallBtnText}>{isPlaying ? "❚❚" : "▶"}</Text>
          </Pressable>
          <Pressable onPress={() => stepOneFrame(-1)} style={styles.smallBtn}>
            <Text style={styles.smallBtnText}>−1f</Text>
          </Pressable>
          <Pressable onPress={() => stepOneFrame(1)} style={styles.smallBtn}>
            <Text style={styles.smallBtnText}>+1f</Text>
          </Pressable>
          <Text style={[styles.coachMeta, { fontVariant: ["tabular-nums"] }]}>
            {detectedFps != null ? `${Math.round(detectedFps)}fps` : "detecting…"}
          </Text>
          {PLAYBACK_RATES.map(r => (
            <Pressable key={r} onPress={() => setPlaybackRate(r)}
              style={[styles.smallBtn, playbackRate === r && { backgroundColor: GOLD }]}>
              <Text style={[styles.smallBtnText, playbackRate === r && { color: "#000" }]}>{r}x</Text>
            </Pressable>
          ))}
          <Text style={[styles.coachMeta, { marginLeft: "auto", fontVariant: ["tabular-nums"] }]}>
            {videoTime.toFixed(2)}s / {videoDuration.toFixed(2)}s
          </Text>
        </View>
        <View
          onLayout={(e) => setScrubberWidth(e.nativeEvent.layout.width)}
          {...scrubberPanResponder.panHandlers}
          style={styles.scrubberTrack}>
          <View style={[styles.scrubberFill, {
            width: videoDuration > 0 ? `${Math.min(100, (videoTime / videoDuration) * 100)}%` : "0%",
          }]} />
          {videoDuration > 0 && scrubberWidth > 0 && (
            <View style={[styles.scrubberThumb, {
              left: Math.max(0, Math.min(scrubberWidth - 12, (videoTime / videoDuration) * scrubberWidth - 6)),
            }]} />
          )}
        </View>
        {/* Task #1055 — drawing timeline strip: one draggable marker per
            shape so coaches can slide a drawing to any moment in one
            gesture instead of repeatedly tapping shape ±1f. */}
        <View
          onLayout={(e) => setShapeTimelineWidth(e.nativeEvent.layout.width)}
          {...shapeTimelinePanResponder.panHandlers}
          style={styles.shapeTimelineTrack}
          accessibilityLabel="Drawing timeline"
          testID="drawing-timeline-strip"
        >
          {videoDuration > 0 && shapeTimelineWidth > 0 && shapes.map((s, i) => {
            const left = Math.max(
              0,
              Math.min(shapeTimelineWidth - 10, (s.t / videoDuration) * shapeTimelineWidth - 5),
            );
            const isSel = selectedIdxs.includes(i);
            return (
              <View
                key={i}
                testID={`drawing-marker-${i}`}
                accessibilityState={{ selected: isSel }}
                // Task #2128 — react-native-web drops aria-selected on
                // markers because the parent View has no interactive
                // role; expose the selection state via a stable data
                // attribute so the mobile box-select e2e can assert
                // marker-level selection without depending on the
                // hashed RNW border-color class.
                dataSet={{ selected: isSel ? "true" : "false" }}
                pointerEvents="none"
                style={[
                  styles.shapeMarker,
                  {
                    left,
                    backgroundColor: s.color,
                    borderColor: isSel ? "#00BFFF" : "rgba(0,0,0,0.6)",
                    borderWidth: isSel ? 2 : 1,
                  },
                ]}
              />
            );
          })}
          {videoDuration > 0 && shapeTimelineWidth > 0 && (
            <View
              pointerEvents="none"
              style={[styles.shapeTimelinePlayhead, {
                left: Math.max(0, Math.min(shapeTimelineWidth - 1, (videoTime / videoDuration) * shapeTimelineWidth)),
              }]}
            />
          )}
          {/* Task #1415 — selection rectangle drawn while box-selecting. */}
          {boxSelectRect && (
            <View
              testID="drawing-timeline-box-select"
              pointerEvents="none"
              style={[styles.shapeTimelineBoxSelect, {
                left: Math.min(boxSelectRect.startX, boxSelectRect.currentX),
                width: Math.abs(boxSelectRect.currentX - boxSelectRect.startX),
              }]}
            />
          )}
        </View>

        {/* Drawing toolbar */}
        <View style={styles.drawToolbar}>
          <Pressable
            onPress={() => { setDrawMode(d => !d); angleClicksRef.current = []; }}
            style={[styles.smallBtn, drawMode && { backgroundColor: GOLD }]}>
            <Text style={[styles.smallBtnText, drawMode && { color: "#000" }]}>
              {drawMode ? "Drawing on" : "Draw on frame"}
            </Text>
          </Pressable>
          {drawMode && (
            <>
              {(["select", "line", "arrow", "circle", "angle"] as DrawTool[]).map(t => (
                <Pressable key={t}
                  onPress={() => { setTool(t); angleClicksRef.current = []; }}
                  style={[styles.smallBtn, tool === t && { backgroundColor: GOLD }]}>
                  <Text style={[styles.smallBtnText, tool === t && { color: "#000" }]}>{t}</Text>
                </Pressable>
              ))}
              {DRAW_COLORS.map(c => (
                <Pressable key={c} onPress={() => setColor(c)}
                  style={[styles.colorSwatch, { backgroundColor: c }, color === c && { borderColor: "#fff", borderWidth: 2 }]} />
              ))}
              <Pressable onPress={undo} style={styles.smallBtn}>
                <Text style={styles.smallBtnText}>Undo</Text>
              </Pressable>
              <Pressable onPress={clearAll} style={styles.smallBtn}>
                <Text style={styles.smallBtnText}>Clear</Text>
              </Pressable>
              <Pressable
                onPress={duplicateSelected}
                disabled={primarySelectedIdx == null}
                style={[styles.smallBtn, primarySelectedIdx != null
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, primarySelectedIdx != null && { color: "#000" }]}>Duplicate</Text>
              </Pressable>
              <Pressable
                testID="duplicate-group-button"
                onPress={duplicateGroupToCurrent}
                disabled={selectedIdxs.length === 0}
                style={[styles.smallBtn, selectedIdxs.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, selectedIdxs.length > 0 && { color: "#000" }]}>Duplicate group</Text>
              </Pressable>
              {/* Task #1712 — Copy / Paste drawings clipboard. Copy stashes
                  the selection (or the whole list) into a coach-local
                  clipboard; Paste drops it at the playhead with the same
                  offset-preserving math as Duplicate group. The clipboard
                  survives between reviews in the same session. */}
              <Pressable
                onPress={copyDrawings}
                disabled={shapes.length === 0}
                testID="drawing-copy"
                style={[styles.smallBtn, shapes.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, shapes.length > 0 && { color: "#000" }]}>Copy drawings</Text>
              </Pressable>
              <Pressable
                onPress={pasteDrawings}
                disabled={drawingClipboard.length === 0}
                testID="drawing-paste"
                style={[styles.smallBtn, drawingClipboard.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, drawingClipboard.length > 0 && { color: "#000" }]}>
                  {drawingClipboard.length > 0
                    ? `Paste drawings (${drawingClipboard.length})`
                    : "Paste drawings"}
                </Text>
              </Pressable>
              {/* Task #2131 — persistent named-preset library. Save uses
                  the same selected-vs-all rule as Copy; Presets opens a
                  picker for apply / rename / delete. */}
              <Pressable
                onPress={openCreatePresetModal}
                disabled={shapes.length === 0 || savingPreset}
                testID="drawing-save-preset"
                style={[styles.smallBtn, shapes.length > 0 && !savingPreset
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, shapes.length > 0 && !savingPreset && { color: "#000" }]}>
                  {savingPreset ? "Saving…" : "Save preset"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setPresetMenuOpen(o => !o)}
                testID="drawing-presets-toggle"
                style={[styles.smallBtn, drawingPresets.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, drawingPresets.length > 0 && { color: "#000" }]}>
                  {drawingPresets.length > 0 ? `Presets (${drawingPresets.length}) ▾` : "Presets ▾"}
                </Text>
              </Pressable>
              <Pressable
                onPress={retimeSelectedToCurrent}
                disabled={selectedIdxs.length === 0}
                style={[styles.smallBtn, selectedIdxs.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, selectedIdxs.length > 0 && { color: "#000" }]}>Move to current time</Text>
              </Pressable>
              <Pressable
                onPress={() => retimeSelectedByFrames(-1)}
                disabled={selectedIdxs.length === 0}
                style={[styles.smallBtn, selectedIdxs.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, selectedIdxs.length > 0 && { color: "#000" }]}>shape −1f</Text>
              </Pressable>
              <Pressable
                onPress={() => retimeSelectedByFrames(1)}
                disabled={selectedIdxs.length === 0}
                style={[styles.smallBtn, selectedIdxs.length > 0
                  ? { backgroundColor: GOLD, borderColor: GOLD }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, selectedIdxs.length > 0 && { color: "#000" }]}>shape +1f</Text>
              </Pressable>
              <Pressable
                onPress={deleteSelected}
                disabled={selectedIdxs.length === 0}
                style={[styles.smallBtn, selectedIdxs.length > 0
                  ? { backgroundColor: "#7a1f1f", borderColor: "#7a1f1f" }
                  : { opacity: 0.5 }]}>
                <Text style={[styles.smallBtnText, selectedIdxs.length > 0 && { color: "#fff" }]}>Delete shape</Text>
              </Pressable>
            </>
          )}
          <Text testID="drawing-selection-summary" style={[styles.coachMeta, { marginLeft: 4 }]}>
            {shapes.length} shape{shapes.length === 1 ? "" : "s"}
            {selectedIdxs.length > 0 ? ` · ${selectedIdxs.length} selected${multiSelectMode ? " (tap to add/remove)" : ""}` : ""} · {videoTime.toFixed(1)}s
          </Text>
        </View>

        {queueItem.request.memberPrompt && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.sectionLabel}>Member's request</Text>
            <Text style={styles.bio}>{queueItem.request.memberPrompt}</Text>
          </View>
        )}
        {queueItem.request.status === "paid" && (
          <Pressable style={[styles.secondaryBtn, { marginTop: 12 }]} onPress={start}>
            <Text style={styles.secondaryBtnText}>Mark In-Review</Text>
          </Pressable>
        )}

        <View style={{ marginTop: 16 }}>
          <Text style={styles.sectionLabel}>Voice-over</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {!recording ? (
              <Pressable onPress={startRecording} disabled={uploadingVoice}
                style={[styles.smallBtn, { backgroundColor: "#7a1f1f", borderColor: "#7a1f1f" }]}>
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>● Record</Text>
              </Pressable>
            ) : (
              <Pressable onPress={stopRecording}
                style={[styles.smallBtn, { backgroundColor: "#000", borderColor: "#fff" }]}>
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>■ Stop</Text>
              </Pressable>
            )}
            {uploadingVoice && <Text style={styles.coachMeta}>Uploading…</Text>}
            {voiceUrl && !uploadingVoice && (
              <Text style={[styles.coachMeta, { color: "#22DD88" }]}>
                Voice-over ready ({voiceDuration?.toFixed(1)}s)
              </Text>
            )}
          </View>
        </View>

        <View style={{ marginTop: 16 }}>
          <Text style={styles.sectionLabel}>Written feedback</Text>
          <TextInput multiline placeholder="Detailed swing feedback…" placeholderTextColor="#666"
            value={textNotes} onChangeText={setTextNotes} style={[styles.input, { minHeight: 120 }]} />
        </View>
        <Pressable style={[styles.primaryBtn, { marginTop: 16 }]} onPress={deliver} disabled={submitting}>
          {submitting ? <LoadingSpinner color="#000" /> : (
            <>
              <Feather name="check" size={16} color="#000" />
              <Text style={styles.primaryBtnText}>Deliver Review</Text>
            </>
          )}
        </Pressable>
      </ScrollView>
      {/* Task #2131 — preset library picker. Lives outside the
          ScrollView so it overlays the toolbar correctly on tap. */}
      {presetMenuOpen && (
        <View style={styles.presetSheetBackdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setPresetMenuOpen(false)} />
          <View style={styles.presetSheet} testID="drawing-presets-menu">
            <View style={styles.presetSheetHeader}>
              <Text style={styles.presetSheetTitle}>Drawing presets</Text>
              <Pressable onPress={() => setPresetMenuOpen(false)} hitSlop={8}>
                <Feather name="x" size={20} color="#888" />
              </Pressable>
            </View>
            {drawingPresets.length === 0 ? (
              <Text style={styles.presetEmpty}>
                No saved presets yet. Draw something, then tap "Save preset" to start your library.
              </Text>
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {drawingPresets.map(p => (
                  <View key={p.id} style={styles.presetRow} testID={`drawing-preset-row-${p.id}`}>
                    <Pressable style={{ flex: 1 }} onPress={() => applyPreset(p)}>
                      <Text style={styles.presetName} numberOfLines={1}>{p.name}</Text>
                      <Text style={styles.presetMeta}>
                        {Array.isArray(p.drawings) ? p.drawings.length : 0} drawing{(Array.isArray(p.drawings) ? p.drawings.length : 0) === 1 ? "" : "s"}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => openRenamePresetModal(p)} testID={`drawing-preset-rename-${p.id}`} style={styles.presetActionBtn}>
                      <Text style={styles.presetActionText}>Rename</Text>
                    </Pressable>
                    <Pressable onPress={() => deletePreset(p)} testID={`drawing-preset-delete-${p.id}`} style={styles.presetActionBtn}>
                      <Text style={[styles.presetActionText, { color: "#ff6666" }]}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}
      {/* Task #2131 — name-this-preset / rename-preset modal. Controlled
          TextInput because RN Alert.prompt is iOS-only. */}
      <Modal visible={presetNameModal !== null} transparent animationType="fade" onRequestClose={() => setPresetNameModal(null)}>
        <View style={styles.presetSheetBackdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setPresetNameModal(null)} />
          <View style={[styles.presetSheet, { paddingBottom: 16 }]}>
            <Text style={styles.presetSheetTitle}>
              {presetNameModal?.mode === "rename" ? "Rename preset" : "Save drawing preset"}
            </Text>
            <TextInput
              testID="drawing-preset-name-input"
              autoFocus
              value={presetNameDraft}
              onChangeText={setPresetNameDraft}
              placeholder="e.g. Setup checkpoints"
              placeholderTextColor="#666"
              maxLength={80}
              style={[styles.input, { marginTop: 12 }]}
            />
            <View style={{ flexDirection: "row", gap: 12, marginTop: 12 }}>
              <Pressable style={[styles.smallBtn, { flex: 1 }]} onPress={() => setPresetNameModal(null)}>
                <Text style={styles.smallBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="drawing-preset-name-submit"
                style={[styles.smallBtn, { flex: 1, backgroundColor: GOLD, borderColor: GOLD }]}
                onPress={submitPresetNameModal}
                disabled={savingPreset}
              >
                <Text style={[styles.smallBtnText, { color: "#000" }]}>
                  {savingPreset ? "Saving…" : (presetNameModal?.mode === "rename" ? "Rename" : "Save preset")}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

/* ─────────────────────────── Styles ─────────────────────────── */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { color: GOLD, fontSize: 22, fontWeight: "700", paddingHorizontal: 16, marginBottom: 8 },
  tabBar: { flexDirection: "row", paddingHorizontal: 12, marginBottom: 8 },
  tabBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, marginRight: 8 },
  tabBtnActive: { backgroundColor: GOLD },
  tabText: { color: "#999", fontSize: 12 },
  tabTextActive: { color: "#000", fontWeight: "600" },
  actionRow: { flexDirection: "row", paddingHorizontal: 12, gap: 8, marginBottom: 8 },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: GOLD, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, flex: 1 },
  primaryBtnText: { color: "#000", fontWeight: "600" },
  secondaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderColor: GOLD, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, flex: 1 },
  secondaryBtnText: { color: GOLD, fontWeight: "600" },
  smallBtn: { backgroundColor: "#1a1a1a", borderColor: GOLD, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  smallBtnText: { color: GOLD, fontSize: 12 },
  // Task #2131 — preset library picker styles.
  presetSheetBackdrop: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  presetSheet: { backgroundColor: "#1a1a1a", borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, borderTopWidth: 1, borderColor: "#333" },
  presetSheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  presetSheetTitle: { color: GOLD, fontWeight: "600", fontSize: 16 },
  presetEmpty: { color: "#888", fontSize: 13, paddingVertical: 12 },
  presetRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderColor: "#2a2a2a", gap: 10 },
  presetName: { color: "#fff", fontSize: 14, fontWeight: "500" },
  presetMeta: { color: "#888", fontSize: 11, marginTop: 2 },
  presetActionBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  presetActionText: { color: "#aaa", fontSize: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyText: { color: "#999", marginTop: 12, textAlign: "center" },
  videoCard: { flexDirection: "row", padding: 12, backgroundColor: "#1a1a1a", marginBottom: 8, borderRadius: 8 },
  videoThumb: { width: 80, height: 80, backgroundColor: "#000", alignItems: "center", justifyContent: "center", borderRadius: 4 },
  videoTitle: { color: "#fff", fontWeight: "600" },
  videoMeta: { color: "#999", fontSize: 12 },
  coachCard: { flexDirection: "row", padding: 12, backgroundColor: "#1a1a1a", marginBottom: 8, borderRadius: 8, alignItems: "center" },
  coachAvatar: { width: 56, height: 56, borderRadius: 28 },
  coachName: { color: "#fff", fontWeight: "600", fontSize: 16 },
  coachOrg: { color: "#aaa", fontSize: 12 },
  coachMeta: { color: "#999", fontSize: 12, marginTop: 2 },
  bio: { color: "#ccc", marginTop: 8, lineHeight: 20 },
  tag: { backgroundColor: GOLD + "30", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginRight: 6, marginBottom: 4 },
  tagText: { color: GOLD, fontSize: 11 },
  sectionLabel: { color: GOLD, fontSize: 14, fontWeight: "600", marginBottom: 6 },
  modalContainer: { flex: 1, backgroundColor: "#0a0a0a", padding: 16 },
  modalTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  input: { backgroundColor: "#1a1a1a", color: "#fff", padding: 12, borderRadius: 8, borderColor: "#333", borderWidth: 1, marginTop: 8 },
  pickItem: { padding: 12, backgroundColor: "#1a1a1a", marginBottom: 6, borderRadius: 6 },
  captureControls: { position: "absolute", bottom: 40, left: 0, right: 0, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  captureBtn: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  recordBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "#fff" },
  recordBtnActive: { borderColor: "#f00" },
  recordCircle: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#f00" },
  recordSquare: { width: 24, height: 24, backgroundColor: "#f00", borderRadius: 4 },
  playerBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, backgroundColor: "#000" },
  rateBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, backgroundColor: "#222" },
  rateBtnActive: { backgroundColor: GOLD },
  requestCard: { flexDirection: "row", padding: 12, backgroundColor: "#1a1a1a", marginBottom: 8, borderRadius: 8, alignItems: "center" },
  payoutRow: { flexDirection: "row", padding: 12, backgroundColor: "#1a1a1a", marginBottom: 8, borderRadius: 8, alignItems: "center" },
  coachNotifBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  coachNotifBadgeText: { fontSize: 11, fontWeight: "600" },
  coachNotifBothMissed: { color: "#fca5a5", fontSize: 11, fontStyle: "italic", marginTop: 4 },
  // Task #1543 — coach-side "Try again" button on a missed payout notification.
  coachNotifRetryBtn: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: GOLD,
    backgroundColor: "rgba(201,168,76,0.12)",
  },
  coachNotifRetryBtnText: { color: GOLD, fontSize: 12, fontWeight: "600" },
  // Task #1913 — live cooldown countdown rendered in place of the
  // "Try again" button while the per-payout cooldown is still ticking.
  // `tabular-nums` keeps the seconds digits from jittering as they
  // tick down, mirroring the masked-target style above.
  coachNotifRetryCountdown: {
    color: "#9ca3af",
    fontSize: 12,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
  },
  // Task #1544 — masked contact snapshot ("tried +91 ●●●●●● 4321") and
  // the deep link to the comm-prefs screen from the both-missed note.
  coachNotifTarget: { color: "#9ca3af", fontSize: 11, fontVariant: ["tabular-nums"] },
  coachNotifUpdatePrefs: { color: "#86efac", fontSize: 12, fontWeight: "600", marginTop: 2, textDecorationLine: "underline" },
  // Task #1914 — "Still not getting through? Contact support" deflection
  // shown after the coach has hammered Try again on the same payout.
  coachNotifSupportHint: { color: "#fcd34d", fontSize: 11, fontStyle: "italic" },
  coachNotifSupportLink: { color: "#fcd34d", fontSize: 12, fontWeight: "600", marginTop: 2, textDecorationLine: "underline" },
  earningsCard: { padding: 16, backgroundColor: "#1a1a1a", borderRadius: 8, marginBottom: 12 },
  drawToolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 10 },
  colorSwatch: { width: 22, height: 22, borderRadius: 11, borderColor: "#444", borderWidth: 1 },
  playbackBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 },
  scrubberTrack: { height: 28, marginTop: 6, justifyContent: "center", backgroundColor: "transparent" },
  scrubberFill: { position: "absolute", left: 0, top: 12, height: 4, backgroundColor: GOLD, borderRadius: 2 },
  scrubberThumb: { position: "absolute", top: 7, width: 14, height: 14, borderRadius: 7, backgroundColor: GOLD, borderColor: "#000", borderWidth: 1 },
  shapeTimelineTrack: { position: "relative", height: 24, marginTop: 4, backgroundColor: "#1a1a1a", borderRadius: 4 },
  shapeMarker: { position: "absolute", top: 2, width: 10, height: 20, borderRadius: 3 },
  shapeTimelinePlayhead: { position: "absolute", top: 0, bottom: 0, width: 1, backgroundColor: "rgba(212,175,55,0.7)" },
  shapeTimelineBoxSelect: { position: "absolute", top: 0, bottom: 0, backgroundColor: "rgba(0,191,255,0.18)", borderWidth: 1, borderColor: "rgba(0,191,255,0.7)" },
  // Task #2022 — Find-Coach filter bar (mode toggle + price range) on mobile.
  filterBar: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 8 },
  modeRow: { flexDirection: "row", gap: 6 },
  modeBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: GOLD },
  modeBtnActive: { backgroundColor: GOLD },
  modeBtnText: { color: GOLD, fontSize: 12, fontWeight: "600" },
  modeBtnTextActive: { color: "#000" },
  priceRow: { flexDirection: "row", gap: 8 },
  priceField: { flex: 1 },
  filterLabel: { color: "#999", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  filterInput: { backgroundColor: "#1a1a1a", color: "#fff", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderColor: "#333", borderWidth: 1, fontSize: 13 },
  filterHelper: { color: "#888", fontSize: 11, fontStyle: "italic" },
});
