import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Wallet, Inbox, Settings, IndianRupee, Clock, Send, CheckCircle2, X, BellRing, BellOff, AlertTriangle } from 'lucide-react';
import {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  type CoachPayoutChannelLabel,
  type CoachPayoutNotificationAttempt,
  coachPayoutChannelLabel,
  coachPayoutChannelBadgeStyle,
  coachPayoutChannelText,
  coachPayoutBothChannelsNonSent,
  coachPayoutRetryState,
  formatCoachPayoutRetryCountdown,
  coachPayoutShouldShowSupportHint,
  coachEarningsTabLabel,
  coachPayoutTriedTargetLabel,
  coachPayoutUpdatePrefsLinkLabel,
} from '@workspace/coach-payout-labels';
import {
  notificationStatusTone,
  NOTIFICATION_CHANNEL_LABEL,
  NOTIFICATION_CHANNEL_ORDER,
} from '@/lib/notification-channel-status';
import {
  loadCoachDrawingClipboard,
  saveCoachDrawingClipboard,
} from '@/lib/coachDrawingClipboard';

const GOLD = '#C9A84C';
const formatRupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

// Task #761 — fall back to 30fps only until the true frame rate is detected
// from the source video via requestVideoFrameCallback (or supplied by the
// server). The ±1 frame buttons use the detected fps so they land on real
// frames for 60 / 120 / 240fps slow-mo footage.
const DEFAULT_FPS = 30;
const PLAYBACK_RATES = [0.25, 0.5, 1] as const;

interface Pro {
  id: number; displayName: string; bio: string | null;
  organizationId: number; specialisms: string[];
}
interface Profile {
  isListed: boolean;
  certifications: string[];
  yearsExperience: number;
  languages: string[];
  // Task #1356 — Typed handicap-range window the marketplace uses to
  // surface coaches whose preferred student-handicap range covers a
  // requested handicap. Numeric values are sent as `numeric(4,1)` strings
  // by the API (Drizzle convention); null on either bound = "no limit".
  coachesHandicapMin: string | null;
  coachesHandicapMax: string | null;
  hourlyRatePaise: number;
  asyncReviewPricePaise: number;
  acceptsInPerson: boolean;
  acceptsAsync: boolean;
  asyncTurnaroundHours: number;
  revenueSharePct: string;
  ratingsAvg: string;
  ratingsCount: number;
  payoutMethod: string | null;
  payoutAccountId: string | null;
  payoutAccountHolderName: string | null;
  payoutVpa: string | null;
  payoutBankAccountNumber: string | null;
  payoutBankIfsc: string | null;
  payoutVerificationStatus: string | null;
  payoutVerificationFailureReason: string | null;
}

interface PayoutNotification {
  id: number;
  payoutId: number;
  title: string;
  body: string;
  amountPaise: number;
  reference: string | null;
  notes: string | null;
  createdAt: string;
  readAt: string | null;
}

export default function CoachWorkspacePage() {
  const [pro, setPro] = useState<Pro | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [earnings, setEarnings] = useState<any | null>(null);
  const [notifications, setNotifications] = useState<PayoutNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  // Task #1820 — render the Earnings tab label using the same shared
  // localised map that backs the payout-paid email footer (see
  // `COACH_EARNINGS_TAB_LABEL` in `@workspace/coach-payout-labels`),
  // so a coach who reads the email in Hindi/Japanese/etc. sees the
  // matching tab name in the workspace.
  const { i18n } = useTranslation();
  const earningsTabLabel = coachEarningsTabLabel(i18n.language);

  const load = useCallback(async () => {
    setLoading(true);
    const me = await (await fetch('/api/coach-marketplace/me/coach-profile', { credentials: 'include' })).json();
    setPro(me.pro); setProfile(me.profile);
    if (me.pro) {
      const q = await (await fetch('/api/swing-reviews/coach/queue', { credentials: 'include' })).json();
      setQueue(q.queue ?? []);
      const e = await (await fetch('/api/swing-reviews/coach/earnings', { credentials: 'include' })).json();
      setEarnings(e);
      const n = await (await fetch('/api/swing-reviews/coach/notifications', { credentials: 'include' })).json();
      setNotifications(n.notifications ?? []);
    }
    setLoading(false);
  }, []);

  const dismissNotification = async (id: number) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
    await fetch(`/api/swing-reviews/coach/notifications/${id}/read`, { method: 'POST', credentials: 'include' });
  };

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-zinc-400">Loading…</div>;
  if (!pro) {
    return (
      <div className="p-8 text-zinc-400">
        You aren't registered as a teaching pro. Ask your club admin to add you in the Lessons admin.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-1" style={{ color: GOLD }}>Coach Workspace</h1>
        <p className="text-zinc-400 mb-6">{pro.displayName}</p>

        {notifications.filter(n => !n.readAt).length > 0 && (
          <div className="space-y-2 mb-6">
            {notifications.filter(n => !n.readAt).map(n => (
              <div key={n.id}
                className="flex items-start gap-3 p-4 rounded-lg border border-emerald-700 bg-emerald-950/40">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-emerald-300">{n.title}</div>
                  <div className="text-sm text-zinc-300 mt-1">{n.body}</div>
                  {n.notes && <div className="text-xs text-zinc-400 mt-1 italic">"{n.notes}"</div>}
                </div>
                <Button variant="ghost" size="sm"
                  className="text-zinc-400 hover:text-white"
                  onClick={() => dismissNotification(n.id)}
                  aria-label="Mark notification as read">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Tabs defaultValue="queue">
          <TabsList className="bg-zinc-900 border border-zinc-800">
            <TabsTrigger value="queue"><Inbox className="w-4 h-4 mr-2" />Queue ({queue.length})</TabsTrigger>
            <TabsTrigger value="earnings"><Wallet className="w-4 h-4 mr-2" />{earningsTabLabel}</TabsTrigger>
            <TabsTrigger value="profile"><Settings className="w-4 h-4 mr-2" />Profile</TabsTrigger>
          </TabsList>

          <TabsContent value="queue">
            <QueueTab queue={queue} reload={load} coachId={pro.id} />
          </TabsContent>
          <TabsContent value="earnings">
            <EarningsTab earnings={earnings} reload={load} toast={toast} />
          </TabsContent>
          <TabsContent value="profile">
            <ProfileTab pro={pro} profile={profile} reload={load} toast={toast} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// Task #2131 — persisted, named drawing-preset library a coach can save
// once and re-use on any review. The shape mirrors the GET response from
// /api/swing-reviews/coach/drawing-presets and is intentionally loose
// on the drawings array (Shape[] would be ideal, but the API stores the
// blob verbatim and a coach who saved a pre-#2131 preset on another
// device must still see it round-trip).
interface DrawingPreset {
  id: number;
  name: string;
  drawings: Shape[];
  createdAt: string;
  updatedAt: string;
}

function QueueTab({ queue, reload, coachId }: { queue: any[]; reload: () => void; coachId: number }) {
  const [working, setWorking] = useState<any | null>(null);
  // Task #1712 — coach-local "drawings clipboard" lifted to the queue tab so
  // a Copy in one review survives opening a different review (DeliverDialog
  // unmounts when `working` flips).
  // Task #2130 — also persisted to localStorage keyed by the coach's pro id
  // so the clipboard survives a tab refresh / route change AND the
  // post-close `reload()` flicker that unmounts QueueTab (the rehydrate-
  // from-disk on remount is what gives the clipboard the "open a different
  // review and paste" lifetime documented in Task #2132). The initial
  // value is rehydrated synchronously inside `useState` so the first paint
  // already shows the correct Paste-button count instead of flashing
  // "0 → N" after a layout effect runs.
  const [drawingClipboard, setDrawingClipboardState] = useState<Shape[]>(
    () => loadCoachDrawingClipboard<Shape>(coachId),
  );
  // Wrap the setter so every clipboard mutation (copy, programmatic clear)
  // mirrors to localStorage. We persist before calling React's setState so
  // a crash inside the render phase still leaves a consistent on-disk
  // snapshot for the next mount.
  const setDrawingClipboard = useCallback(
    (next: Shape[] | ((prev: Shape[]) => Shape[])) => {
      setDrawingClipboardState(prev => {
        const value = typeof next === 'function'
          ? (next as (p: Shape[]) => Shape[])(prev)
          : next;
        saveCoachDrawingClipboard(coachId, value);
        return value;
      });
    },
    [coachId],
  );
  // If the signed-in coach changes (different `pro.id` after a re-login on
  // a shared device), reload the clipboard from disk for the new coach so
  // we never surface the previous coach's callout pattern.
  useEffect(() => {
    setDrawingClipboardState(loadCoachDrawingClipboard<Shape>(coachId));
  }, [coachId]);
  // Task #2131 — server-backed preset library lives here at the queue tab
  // so a save/rename/delete in one review's DeliverDialog is visible the
  // next time the coach opens any other review without a refetch round
  // trip. Loaded once on mount; mutating actions in the dialog patch this
  // state directly so the picker stays consistent.
  const [presets, setPresets] = useState<DrawingPreset[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/swing-reviews/coach/drawing-presets', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { presets: [] })
      .then(data => { if (!cancelled) setPresets(Array.isArray(data.presets) ? data.presets : []); })
      .catch(() => { /* best-effort: an empty library is the right fallback */ });
    return () => { cancelled = true; };
  }, []);
  if (queue.length === 0) return <div className="p-8 text-zinc-500">No pending reviews. 🎉</div>;
  return (
    <div className="space-y-3 mt-4">
      {queue.map(q => (
        <Card key={q.request.id} className="bg-zinc-900 border-zinc-800 p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Review #{q.request.id}</div>
            <div className="text-xs text-zinc-400">
              <Badge variant="outline" style={{ borderColor: GOLD, color: GOLD }}>{q.request.status}</Badge>
              {q.request.dueAt && <span className="ml-2"><Clock className="inline w-3 h-3" /> Due {new Date(q.request.dueAt).toLocaleString()}</span>}
            </div>
            {q.request.memberPrompt && <div className="text-sm text-zinc-300 mt-2 italic">"{q.request.memberPrompt}"</div>}
          </div>
          <Button onClick={() => setWorking(q)} style={{ backgroundColor: GOLD, color: '#000' }}>Open</Button>
        </Card>
      ))}
      {working && (
        <DeliverDialog
          item={working}
          onClose={() => { setWorking(null); reload(); }}
          drawingClipboard={drawingClipboard}
          setDrawingClipboard={setDrawingClipboard}
          presets={presets}
          setPresets={setPresets}
        />
      )}
    </div>
  );
}

type Shape =
  | { kind: 'line'; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'arrow'; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'circle'; t: number; x: number; y: number; r: number; color: string }
  | { kind: 'angle'; t: number; ax: number; ay: number; bx: number; by: number; cx: number; cy: number; color: string };

type DragMode =
  | { kind: 'move'; idx: number; offX: number; offY: number }
  | { kind: 'endpoint'; idx: number; which: 'a' | 'b' | 'c' | '1' | '2' }
  | { kind: 'circle-resize'; idx: number };

const HIT = 10;
const HANDLE = 12;

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestShape(s: Shape, px: number, py: number): boolean {
  if (s.kind === 'line' || s.kind === 'arrow') {
    return distToSeg(px, py, s.x1, s.y1, s.x2, s.y2) <= HIT;
  }
  if (s.kind === 'circle') {
    const d = Math.hypot(px - s.x, py - s.y);
    return Math.abs(d - s.r) <= HIT || d <= s.r;
  }
  // angle
  return (
    distToSeg(px, py, s.ax, s.ay, s.bx, s.by) <= HIT ||
    distToSeg(px, py, s.bx, s.by, s.cx, s.cy) <= HIT
  );
}

function shapeBBox(s: Shape): { x: number; y: number; w: number; h: number } {
  if (s.kind === 'line' || s.kind === 'arrow') {
    const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
    return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }
  if (s.kind === 'circle') return { x: s.x - s.r, y: s.y - s.r, w: s.r * 2, h: s.r * 2 };
  const xs = [s.ax, s.bx, s.cx], ys = [s.ay, s.by, s.cy];
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function translateShape(s: Shape, dx: number, dy: number): Shape {
  if (s.kind === 'line' || s.kind === 'arrow')
    return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  if (s.kind === 'circle') return { ...s, x: s.x + dx, y: s.y + dy };
  return { ...s, ax: s.ax + dx, ay: s.ay + dy, bx: s.bx + dx, by: s.by + dy, cx: s.cx + dx, cy: s.cy + dy };
}

function DeliverDialog({ item, onClose, drawingClipboard, setDrawingClipboard, presets, setPresets }: {
  item: any;
  onClose: () => void;
  drawingClipboard: Shape[];
  setDrawingClipboard: React.Dispatch<React.SetStateAction<Shape[]>>;
  presets: DrawingPreset[];
  setPresets: React.Dispatch<React.SetStateAction<DrawingPreset[]>>;
}) {
  const [textNotes, setTextNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tool, setTool] = useState<'select' | 'line' | 'arrow' | 'circle' | 'angle'>('line');
  const [color, setColor] = useState('#FFD700');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Task #1216 — multi-select. The "primary" index (last entry) is what
  // single-target actions like duplicate / move-to-current-time operate on,
  // while group actions (timeline drag, delete, retime ±1f) act on every
  // entry. selectedIdxs is the source of truth; primarySelectedIdx is a
  // memoised convenience for the common "is anything selected?" path.
  const [selectedIdxs, setSelectedIdxs] = useState<number[]>([]);
  const primarySelectedIdx = selectedIdxs.length > 0 ? selectedIdxs[selectedIdxs.length - 1] : null;
  const dragRef = useRef<DragMode | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const timelineStripRef = useRef<HTMLDivElement | null>(null);
  const markerDragRef = useRef<number | null>(null);
  const markerDragCleanupRef = useRef<(() => void) | null>(null);
  // Task #1415 — drag-to-rectangle box selection on the timeline strip.
  // While the pointer is down on the strip background (not on a marker)
  // we track {startX, currentX} so we can draw the selection rectangle
  // and live-update which markers fall inside the swept time range.
  const [boxSelect, setBoxSelect] = useState<{ startX: number; currentX: number } | null>(null);
  const boxSelectCleanupRef = useRef<(() => void) | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const [voiceUploadToken, setVoiceUploadToken] = useState<string | null>(null);
  const [voiceUploadTokenExp, setVoiceUploadTokenExp] = useState<number | null>(null);
  const [voiceDuration, setVoiceDuration] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const angleClicksRef = useRef<Array<{ x: number; y: number }>>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef<number>(0);
  const { toast } = useToast();
  const videoSrc = item.videoUrl;

  // Task #761 — true frame rate of the source video. Seeded from the server
  // (if a previous viewer detected it) and refined on the fly via
  // requestVideoFrameCallback. Falls back to 30fps until a real value is known.
  const initialFps = (() => {
    const f = Number(item.videoFps);
    return Number.isFinite(f) && f > 0 ? f : null;
  })();
  const [detectedFps, setDetectedFps] = useState<number | null>(initialFps);
  const fpsForStepping = detectedFps ?? DEFAULT_FPS;
  const fpsSamplesRef = useRef<number[]>([]);
  const lastFrameMediaTimeRef = useRef<number | null>(null);
  const fpsRvfcHandleRef = useRef<number | null>(null);
  const fpsPersistedRef = useRef<boolean>(initialFps != null);

  const currentTime = () => videoRef.current?.currentTime ?? 0;

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const persistDetectedFps = useCallback(async (fps: number) => {
    if (fpsPersistedRef.current) return;
    fpsPersistedRef.current = true;
    try {
      const r = await fetch(`/api/swing-reviews/requests/${item.request.id}/swing-video-fps`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fps }),
      });
      if (!r.ok) fpsPersistedRef.current = false;
    } catch {
      // Best-effort: failing to persist just means the next viewer will detect again.
      fpsPersistedRef.current = false;
    }
  }, [item.request.id]);

  // Schedule a requestVideoFrameCallback loop that samples consecutive
  // mediaTime deltas to derive the true source frame rate.
  const scheduleFpsProbe = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number; presentedFrames: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    // Don't stack multiple probe loops if loadedmetadata + play both fire.
    if (fpsRvfcHandleRef.current != null) return;
    const onFrame = (_now: number, metadata: { mediaTime: number; presentedFrames: number }) => {
      const last = lastFrameMediaTimeRef.current;
      if (last != null) {
        const dt = metadata.mediaTime - last;
        // Reject duplicate frames, paused/seeking artefacts, and absurd gaps.
        if (dt > 1 / 1000 && dt < 1 / 10) {
          fpsSamplesRef.current.push(dt);
          if (fpsSamplesRef.current.length >= 12 && detectedFps == null) {
            const sorted = [...fpsSamplesRef.current].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const fps = 1 / median;
            // Snap to common rates so 29.97 → 30, 59.94 → 60, etc.
            const common = [24, 25, 30, 50, 60, 90, 120, 240];
            const snapped = common.find(c => Math.abs(c - fps) / c < 0.04) ?? Math.round(fps * 100) / 100;
            setDetectedFps(snapped);
            void persistDetectedFps(snapped);
            fpsSamplesRef.current = [];
            return; // stop the loop
          }
        }
      }
      lastFrameMediaTimeRef.current = metadata.mediaTime;
      fpsRvfcHandleRef.current = v.requestVideoFrameCallback!(onFrame);
    };
    fpsRvfcHandleRef.current = v.requestVideoFrameCallback!(onFrame);
  }, [detectedFps, persistDetectedFps]);

  useEffect(() => {
    return () => {
      const v = videoRef.current as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (h: number) => void;
      }) | null;
      const h = fpsRvfcHandleRef.current;
      if (v && h != null && typeof v.cancelVideoFrameCallback === 'function') {
        v.cancelVideoFrameCallback(h);
      }
    };
  }, []);

  const stepFrames = (delta: number) => {
    const v = videoRef.current; if (!v) return;
    v.pause();
    setIsPlaying(false);
    const frameInterval = 1 / fpsForStepping;
    // Identify which frame currentTime falls inside. We seek mid-frame below,
    // so use floor (not round): from time = (n + 0.5) * frameInterval, round
    // would bump us up to n+1 and the next +1 press would skip a frame.
    const currentFrame = Math.floor(v.currentTime * fpsForStepping);
    const targetFrame = Math.max(0, currentFrame + delta);
    // Land inside the requested frame's window (not on the boundary, which
    // can render the previous frame on some browsers).
    const next = Math.max(
      0,
      Math.min(v.duration || 0, targetFrame * frameInterval + frameInterval / 2),
    );
    v.currentTime = next;
    setVideoTime(next);
    redraw();
  };

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current; if (!v) return;
    const t = Number(e.target.value);
    v.pause();
    setIsPlaying(false);
    v.currentTime = t;
    setVideoTime(t);
    redraw();
  };

  const redraw = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const t = currentTime();
    // Task #912 — visibility window is one frame wide so that nudging a shape
    // by ±1 frame actually makes it disappear from the old frame and appear
    // on the new one.
    const visibilityWindow = 0.5 / fpsForStepping;
    shapes.forEach((s, idx) => {
      if (Math.abs(s.t - t) > visibilityWindow) return;
      ctx.strokeStyle = s.color; ctx.lineWidth = 3;
      ctx.beginPath();
      if (s.kind === 'line') { ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke(); }
      else if (s.kind === 'arrow') {
        ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const len = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / len, uy = dy / len;
        const head = 12;
        const px = -uy, py = ux;
        const ax = s.x2 - ux * head + px * (head / 2);
        const ay = s.y2 - uy * head + py * (head / 2);
        const bx = s.x2 - ux * head - px * (head / 2);
        const by = s.y2 - uy * head - py * (head / 2);
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2); ctx.lineTo(ax, ay); ctx.lineTo(bx, by); ctx.closePath();
        ctx.fillStyle = s.color; ctx.fill();
      }
      else if (s.kind === 'circle') { ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke(); }
      else if (s.kind === 'angle') {
        ctx.moveTo(s.ax, s.ay); ctx.lineTo(s.bx, s.by); ctx.lineTo(s.cx, s.cy); ctx.stroke();
      }
      if (selectedIdxs.includes(idx)) {
        ctx.save();
        ctx.strokeStyle = '#00BFFF';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        const b = shapeBBox(s);
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.setLineDash([]);
        ctx.fillStyle = '#00BFFF';
        const handles: Array<{ x: number; y: number }> = [];
        if (s.kind === 'line' || s.kind === 'arrow') {
          handles.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
        } else if (s.kind === 'circle') {
          handles.push({ x: s.x + s.r, y: s.y });
        } else {
          handles.push({ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }, { x: s.cx, y: s.cy });
        }
        for (const h of handles) {
          ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    });
  }, [shapes, selectedIdxs]);

  useEffect(() => { redraw(); }, [shapes, selectedIdxs, redraw]);

  const onVideoLoaded = () => {
    const v = videoRef.current; const c = canvasRef.current; if (!v || !c) return;
    c.width = v.clientWidth; c.height = v.clientHeight;
    redraw();
  };

  const canvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const visibleAtNow = () => {
    const t = currentTime();
    const idxs: number[] = [];
    const visibilityWindow = 0.5 / fpsForStepping;
    shapes.forEach((s, i) => { if (Math.abs(s.t - t) <= visibilityWindow) idxs.push(i); });
    return idxs;
  };

  const beginSelectDrag = (p: { x: number; y: number }) => {
    const visible = visibleAtNow();
    // Hit-test top-most first; prefer the currently-selected shape if still under cursor
    const order = primarySelectedIdx != null && visible.includes(primarySelectedIdx)
      ? [primarySelectedIdx, ...visible.filter(i => i !== primarySelectedIdx).reverse()]
      : [...visible].reverse();
    for (const i of order) {
      const s = shapes[i];
      // Endpoint / handle hit-test first
      if (s.kind === 'line' || s.kind === 'arrow') {
        if (Math.hypot(p.x - s.x1, p.y - s.y1) <= HANDLE) {
          setSelectedIdxs([i]); dragRef.current = { kind: 'endpoint', idx: i, which: '1' }; lastPosRef.current = p; return true;
        }
        if (Math.hypot(p.x - s.x2, p.y - s.y2) <= HANDLE) {
          setSelectedIdxs([i]); dragRef.current = { kind: 'endpoint', idx: i, which: '2' }; lastPosRef.current = p; return true;
        }
      } else if (s.kind === 'circle') {
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (Math.abs(d - s.r) <= HANDLE) {
          setSelectedIdxs([i]); dragRef.current = { kind: 'circle-resize', idx: i }; lastPosRef.current = p; return true;
        }
      } else if (s.kind === 'angle') {
        for (const which of ['a', 'b', 'c'] as const) {
          const x = s[`${which}x` as 'ax'], y = s[`${which}y` as 'ay'];
          if (Math.hypot(p.x - x, p.y - y) <= HANDLE) {
            setSelectedIdxs([i]); dragRef.current = { kind: 'endpoint', idx: i, which }; lastPosRef.current = p; return true;
          }
        }
      }
      if (hitTestShape(s, p.x, p.y)) {
        setSelectedIdxs([i]); dragRef.current = { kind: 'move', idx: i, offX: p.x, offY: p.y }; lastPosRef.current = p; return true;
      }
    }
    setSelectedIdxs([]); dragRef.current = null; lastPosRef.current = null;
    return false;
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = canvasPos(e);
    if (tool === 'select') { beginSelectDrag(p); return; }
    if (tool === 'angle') {
      angleClicksRef.current.push(p);
      if (angleClicksRef.current.length === 3) {
        const [a, b, c] = angleClicksRef.current;
        setShapes(s => [...s, { kind: 'angle', t: currentTime(), ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: c.x, cy: c.y, color }]);
        angleClicksRef.current = [];
      }
      return;
    }
    drawStartRef.current = p;
  };
  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== 'select' || !dragRef.current) return;
    const p = canvasPos(e);
    const last = lastPosRef.current;
    if (!last) return;
    const dx = p.x - last.x, dy = p.y - last.y;
    const drag = dragRef.current;
    setShapes(prev => prev.map((s, i) => {
      if (i !== drag.idx) return s;
      if (drag.kind === 'move') return translateShape(s, dx, dy);
      if (drag.kind === 'circle-resize' && s.kind === 'circle') {
        return { ...s, r: Math.max(4, Math.hypot(p.x - s.x, p.y - s.y)) };
      }
      if (drag.kind === 'endpoint') {
        if ((s.kind === 'line' || s.kind === 'arrow') && drag.which === '1') return { ...s, x1: p.x, y1: p.y };
        if ((s.kind === 'line' || s.kind === 'arrow') && drag.which === '2') return { ...s, x2: p.x, y2: p.y };
        if (s.kind === 'angle' && (drag.which === 'a' || drag.which === 'b' || drag.which === 'c')) {
          return { ...s, [`${drag.which}x`]: p.x, [`${drag.which}y`]: p.y } as Shape;
        }
      }
      return s;
    }));
    lastPosRef.current = p;
  };
  const onCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === 'select') { dragRef.current = null; lastPosRef.current = null; return; }
    if (tool === 'angle') return;
    const start = drawStartRef.current; if (!start) return;
    const p = canvasPos(e);
    drawStartRef.current = null;
    if (tool === 'line') {
      setShapes(s => [...s, { kind: 'line', t: currentTime(), x1: start.x, y1: start.y, x2: p.x, y2: p.y, color }]);
    } else if (tool === 'arrow') {
      setShapes(s => [...s, { kind: 'arrow', t: currentTime(), x1: start.x, y1: start.y, x2: p.x, y2: p.y, color }]);
    } else if (tool === 'circle') {
      const r = Math.hypot(p.x - start.x, p.y - start.y);
      setShapes(s => [...s, { kind: 'circle', t: currentTime(), x: start.x, y: start.y, r, color }]);
    }
  };

  const undo = () => { setShapes(s => s.slice(0, -1)); setSelectedIdxs([]); };
  const clearAll = () => { setShapes([]); setSelectedIdxs([]); };
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
      const copy: Shape = { ...orig, t: currentTime() };
      const next = [...s, copy];
      setSelectedIdxs([next.length - 1]);
      return next;
    });
  };
  // Task #1416 — copy every selected drawing to the current playhead time
  // while preserving the relative offsets between markers in the group, so
  // a setup-phase callout (line + circle + angle) can be re-stamped at
  // mid-swing or at impact in one action. The earliest marker in the group
  // anchors at the playhead; later markers are shifted by the same delta
  // (clamped so no copy lands past the end of the clip).
  const duplicateGroupToCurrent = () => {
    if (selectedIdxs.length === 0) return;
    const target = currentTime();
    const dur = videoRef.current?.duration ?? videoDuration;
    const sel = selectedIdxs
      .map(i => shapes[i])
      .filter((x): x is Shape => !!x);
    if (sel.length === 0) return;
    const minT = Math.min(...sel.map(sh => sh.t));
    const cap = Number.isFinite(dur) && dur > 0 ? dur : Number.POSITIVE_INFINITY;
    const copies: Shape[] = sel.map(sh => ({
      ...sh,
      t: Math.max(0, Math.min(cap, target + (sh.t - minT))),
    }));
    // Promote the freshly pasted copies to the active selection so the
    // coach can immediately nudge or delete them (acceptance criterion).
    const baseLen = shapes.length;
    setShapes(s => [...s, ...copies]);
    setSelectedIdxs(copies.map((_, k) => baseLen + k));
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
      ? selectedIdxs.map(i => shapes[i]).filter((x): x is Shape => !!x)
      : shapes;
    if (source.length === 0) {
      toast({ title: 'Nothing to copy', description: 'Add a drawing first.' });
      return;
    }
    // Snapshot so subsequent edits to these shapes in this review don't
    // mutate the clipboard contents the coach will paste later.
    setDrawingClipboard(source.map(sh => ({ ...sh })));
    const scope = selectedIdxs.length > 0 ? 'selected' : 'all';
    toast({
      title: `Copied ${source.length} drawing${source.length === 1 ? '' : 's'}`,
      description: scope === 'selected'
        ? 'Open another review and Paste at the playhead.'
        : 'Copied every drawing on this review.',
    });
  };
  const pasteDrawings = () => {
    if (drawingClipboard.length === 0) return;
    const target = currentTime();
    const dur = videoRef.current?.duration ?? videoDuration;
    const minT = Math.min(...drawingClipboard.map(sh => sh.t));
    const cap = Number.isFinite(dur) && dur > 0 ? dur : Number.POSITIVE_INFINITY;
    const copies: Shape[] = drawingClipboard.map(sh => ({
      ...sh,
      t: Math.max(0, Math.min(cap, target + (sh.t - minT))),
    }));
    const baseLen = shapes.length;
    setShapes(s => [...s, ...copies]);
    setSelectedIdxs(copies.map((_, k) => baseLen + k));
    setTool('select');
  };

  // Task #2131 — persistent preset library. Save uses the same
  // selected-vs-all rule as Copy so a coach can curate a "setup
  // checkpoints" preset from a hand-picked group on a great review.
  // Apply uses the same offset-preserving math as pasteDrawings so
  // multi-shape patterns keep their internal timing relative to the
  // playhead.
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [renamingPresetId, setRenamingPresetId] = useState<number | null>(null);

  const savePresetFromCurrent = async () => {
    const source = selectedIdxs.length > 0
      ? selectedIdxs.map(i => shapes[i]).filter((x): x is Shape => !!x)
      : shapes;
    if (source.length === 0) {
      toast({ title: 'Nothing to save', description: 'Add a drawing first.' });
      return;
    }
    const raw = window.prompt(
      selectedIdxs.length > 0
        ? `Name this preset (${source.length} selected drawing${source.length === 1 ? '' : 's'})`
        : `Name this preset (${source.length} drawing${source.length === 1 ? '' : 's'})`,
      '',
    );
    if (raw === null) return; // Coach cancelled the dialog
    const name = raw.trim();
    if (!name) {
      toast({ title: 'Name required', description: 'Give the preset a short name.' });
      return;
    }
    if (name.length > 80) {
      toast({ title: 'Name too long', description: 'Keep preset names under 80 characters.' });
      return;
    }
    setSavingPreset(true);
    try {
      const r = await fetch('/api/swing-reviews/coach/drawing-presets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, drawings: source.map(sh => ({ ...sh })) }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast({ title: 'Save failed', description: body.error || `Server returned ${r.status}.` });
        return;
      }
      const body = await r.json();
      const newPreset: DrawingPreset = body.preset;
      setPresets(prev => [newPreset, ...prev.filter(p => p.id !== newPreset.id)]);
      toast({
        title: `Saved "${newPreset.name}"`,
        description: `Library now has ${presets.filter(p => p.id !== newPreset.id).length + 1} preset${(presets.filter(p => p.id !== newPreset.id).length + 1) === 1 ? '' : 's'}.`,
      });
    } catch {
      toast({ title: 'Save failed', description: 'Network error — try again.' });
    } finally {
      setSavingPreset(false);
    }
  };

  const applyPreset = (preset: DrawingPreset) => {
    if (!Array.isArray(preset.drawings) || preset.drawings.length === 0) {
      toast({ title: 'Empty preset', description: 'This preset has no drawings to paste.' });
      return;
    }
    const target = currentTime();
    const dur = videoRef.current?.duration ?? videoDuration;
    const minT = Math.min(...preset.drawings.map(sh => sh.t ?? 0));
    const cap = Number.isFinite(dur) && dur > 0 ? dur : Number.POSITIVE_INFINITY;
    const copies: Shape[] = preset.drawings.map(sh => ({
      ...sh,
      t: Math.max(0, Math.min(cap, target + ((sh.t ?? 0) - minT))),
    }));
    const baseLen = shapes.length;
    setShapes(s => [...s, ...copies]);
    setSelectedIdxs(copies.map((_, k) => baseLen + k));
    setTool('select');
    setPresetMenuOpen(false);
    toast({ title: `Pasted "${preset.name}"`, description: `${copies.length} drawing${copies.length === 1 ? '' : 's'} at the playhead.` });
  };

  const renamePreset = async (preset: DrawingPreset) => {
    const raw = window.prompt(`Rename "${preset.name}"`, preset.name);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name.length > 80 || name === preset.name) return;
    try {
      const r = await fetch(`/api/swing-reviews/coach/drawing-presets/${preset.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        toast({ title: 'Rename failed', description: `Server returned ${r.status}.` });
        return;
      }
      const body = await r.json();
      const updated: DrawingPreset = body.preset;
      setPresets(prev => [updated, ...prev.filter(p => p.id !== preset.id)]);
    } catch {
      toast({ title: 'Rename failed', description: 'Network error — try again.' });
    } finally {
      setRenamingPresetId(null);
    }
  };

  const deletePreset = async (preset: DrawingPreset) => {
    if (!window.confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/swing-reviews/coach/drawing-presets/${preset.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok && r.status !== 404) {
        toast({ title: 'Delete failed', description: `Server returned ${r.status}.` });
        return;
      }
      setPresets(prev => prev.filter(p => p.id !== preset.id));
      toast({ title: `Deleted "${preset.name}"` });
    } catch {
      toast({ title: 'Delete failed', description: 'Network error — try again.' });
    }
  };

  const retimeSelectedToCurrent = () => {
    if (selectedIdxs.length === 0) return;
    const t = currentTime();
    const sel = new Set(selectedIdxs);
    setShapes(s => s.map((sh, i) => sel.has(i) ? { ...sh, t } : sh));
  };
  // Task #1055 — drag a shape's marker on the timeline strip to retime it.
  // Pointer events are captured via window listeners so the drag continues
  // even if the cursor leaves the marker (markers move with the value).
  // Task #1216 — shift-click a marker to add/remove it from the selection,
  // and dragging a marker that's part of a multi-selection moves every
  // selected marker by the same delta (clamped so no marker leaves [0,dur]).
  const beginMarkerDrag = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    setTool('select');
    // Shift-click toggles membership without starting a drag — coaches use
    // this to assemble a group of markers (arrow + circle + angle on the
    // same key frame) before dragging them together.
    if (e.shiftKey) {
      setSelectedIdxs(prev => prev.includes(i) ? prev.filter(j => j !== i) : [...prev, i]);
      return;
    }
    const strip = timelineStripRef.current;
    const dur = videoRef.current?.duration ?? videoDuration;
    if (!strip || !dur) return;
    // Decide the drag group from the existing selection (closure value is
    // fine: this drag uses whatever was selected at pointer-down).
    const groupIdxs = (selectedIdxs.includes(i) && selectedIdxs.length > 1)
      ? selectedIdxs
      : [i];
    setSelectedIdxs(groupIdxs);
    // Snapshot starting times so each move applies a single shared delta.
    const startTimes = new Map<number, number>();
    groupIdxs.forEach(idx => { startTimes.set(idx, shapes[idx]?.t ?? 0); });
    const baseT = startTimes.get(i) ?? 0;
    const minT = Math.min(...startTimes.values());
    const maxT = Math.max(...startTimes.values());
    const minDelta = -minT;
    const maxDelta = dur - maxT;
    // Cancel any prior in-flight drag (e.g. interrupted by a re-grab) so
    // we don't accumulate orphaned window listeners.
    markerDragCleanupRef.current?.();
    markerDragRef.current = i;
    const onMove = (ev: PointerEvent) => {
      if (markerDragRef.current !== i) return;
      const r = strip.getBoundingClientRect();
      if (r.width <= 0) return;
      const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
      const t = (x / r.width) * dur;
      const desired = t - baseT;
      const delta = Math.max(minDelta, Math.min(maxDelta, desired));
      setShapes(prev => prev.map((sh, j) => {
        const base = startTimes.get(j);
        return base != null ? { ...sh, t: base + delta } : sh;
      }));
    };
    const cleanup = () => {
      markerDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      markerDragCleanupRef.current = null;
    };
    markerDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  // Detach any in-flight marker-drag listeners if the dialog unmounts mid-drag.
  useEffect(() => () => { markerDragCleanupRef.current?.(); }, []);

  // Task #1415 — mouse-down on empty strip starts a horizontal box-select.
  // Markers stop propagation in `beginMarkerDrag`, so this only fires for
  // empty timeline-strip background. Holding shift extends the existing
  // selection; otherwise the existing selection is cleared first.
  const beginBoxSelect = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setTool('select');
    const strip = timelineStripRef.current;
    const dur = videoRef.current?.duration ?? videoDuration;
    if (!strip || !dur) return;
    const r = strip.getBoundingClientRect();
    if (r.width <= 0) return;
    const startX = Math.max(0, Math.min(r.width, e.clientX - r.left));
    // Snapshot the base selection (= existing selection if shift, else empty)
    // so live-drag updates always re-derive from the same starting set.
    const baseSelection = e.shiftKey ? selectedIdxs.slice() : [];
    if (!e.shiftKey) setSelectedIdxs([]);
    setBoxSelect({ startX, currentX: startX });
    // Capture shapes by reference; they don't mutate during a drag.
    const snapShapes = shapes;
    boxSelectCleanupRef.current?.();
    const onMove = (ev: PointerEvent) => {
      const r2 = strip.getBoundingClientRect();
      if (r2.width <= 0) return;
      const x = Math.max(0, Math.min(r2.width, ev.clientX - r2.left));
      setBoxSelect(prev => prev ? { ...prev, currentX: x } : prev);
      const lo = Math.min(startX, x);
      const hi = Math.max(startX, x);
      const tLo = (lo / r2.width) * dur;
      const tHi = (hi / r2.width) * dur;
      const inRange: number[] = [];
      snapShapes.forEach((s, idx) => { if (s.t >= tLo && s.t <= tHi) inRange.push(idx); });
      // Preserve prior order: keep base entries first, then any newly
      // swept ones (de-duplicated). The "primary" entry stays the most
      // recently-added marker, so single-target actions keep working.
      const merged: number[] = [];
      const seen = new Set<number>();
      for (const idx of [...baseSelection, ...inRange]) {
        if (!seen.has(idx)) { seen.add(idx); merged.push(idx); }
      }
      setSelectedIdxs(merged);
    };
    const cleanup = () => {
      setBoxSelect(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      boxSelectCleanupRef.current = null;
    };
    boxSelectCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  // Tear down any in-flight box-select listeners on unmount.
  useEffect(() => () => { boxSelectCleanupRef.current?.(); }, []);

  const retimeSelectedByFrames = (delta: number) => {
    if (selectedIdxs.length === 0) return;
    const frameInterval = 1 / fpsForStepping;
    const dur = videoRef.current?.duration ?? 0;
    const sel = new Set(selectedIdxs);
    setShapes(s => s.map((sh, i) => {
      if (!sel.has(i)) return sh;
      const currentFrame = Math.floor(sh.t * fpsForStepping);
      const targetFrame = Math.max(0, currentFrame + delta);
      const next = Math.min(dur || Number.POSITIVE_INFINITY,
        targetFrame * frameInterval + frameInterval / 2);
      return { ...sh, t: next };
    }));
  };

  useEffect(() => {
    if (tool !== 'select') setSelectedIdxs([]);
  }, [tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdxs.length > 0) {
        if (inField) return;
        e.preventDefault();
        deleteSelected();
        return;
      }
      // Task #1416 — Cmd/Ctrl+D duplicates the entire selected group at the
      // current playhead. We preventDefault so the browser bookmark dialog
      // doesn't pop up. Falls through to the no-op if nothing is selected.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
          && (e.key === 'd' || e.key === 'D')
          && selectedIdxs.length > 0) {
        if (inField) return;
        e.preventDefault();
        duplicateGroupToCurrent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recordChunksRef.current = [];
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) recordChunksRef.current.push(ev.data); };
      mr.onstop = async () => {
        const blob = new Blob(recordChunksRef.current, { type: 'audio/webm' });
        const dur = (Date.now() - recordStartRef.current) / 1000;
        setVoiceDuration(dur);
        stream.getTracks().forEach(t => t.stop());
        await uploadVoice(blob);
      };
      recordStartRef.current = Date.now();
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (err: any) {
      toast({ title: 'Microphone unavailable', description: String(err?.message ?? err), variant: 'destructive' });
    }
  };
  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const uploadVoice = async (blob: Blob) => {
    setUploadingVoice(true);
    try {
      const r = await fetch('/api/swing-videos/upload-url', { method: 'POST', credentials: 'include' });
      const { uploadUrl, objectPath, uploadToken, uploadTokenExp } = await r.json();
      if (!uploadUrl || !objectPath || !uploadToken) throw new Error('No upload URL');
      const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'audio/webm' } });
      if (!put.ok) throw new Error('Upload failed');
      setVoiceUrl(objectPath);
      setVoiceUploadToken(uploadToken);
      setVoiceUploadTokenExp(uploadTokenExp);
      toast({ title: 'Voice-over uploaded' });
    } catch (e: any) {
      toast({ title: 'Voice upload failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setUploadingVoice(false);
    }
  };

  const start = async () => {
    await fetch(`/api/swing-reviews/requests/${item.request.id}/start`, { method: 'POST', credentials: 'include' });
    toast({ title: 'Marked in-review' });
  };

  const deliver = async () => {
    if (!textNotes.trim() && shapes.length === 0 && !voiceUrl) {
      toast({ title: 'Add written notes, drawings, or a voice-over before delivering', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    const res = await fetch(`/api/swing-reviews/requests/${item.request.id}/deliver`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
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
    setSubmitting(false);
    if (data.success) { toast({ title: 'Delivered' }); onClose(); }
    else toast({ title: 'Failed', description: data.error, variant: 'destructive' });
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
      role="dialog" aria-label={`Review #${item.request.id}`} data-testid="deliver-dialog">
      <Card className="bg-zinc-900 border-zinc-800 p-6 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold" style={{ color: GOLD }}>Review #{item.request.id}</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="relative mb-3" style={{ lineHeight: 0 }}>
          <video ref={videoRef} src={videoSrc} onLoadedMetadata={(e) => {
              onVideoLoaded();
              const v = e.currentTarget;
              setVideoDuration(v.duration || 0);
              v.playbackRate = playbackRate;
              if (detectedFps == null) scheduleFpsProbe();
            }}
            onTimeUpdate={(e) => { setVideoTime(e.currentTarget.currentTime); redraw(); }}
            onPlay={() => { setIsPlaying(true); if (detectedFps == null) scheduleFpsProbe(); }}
            onPause={() => setIsPlaying(false)}
            crossOrigin="anonymous"
            className="w-full max-h-[400px] bg-black" />
          <canvas ref={canvasRef}
            onMouseDown={onCanvasMouseDown} onMouseMove={onCanvasMouseMove} onMouseUp={onCanvasMouseUp}
            className={`absolute inset-0 w-full h-full ${tool === 'select' ? 'cursor-pointer' : 'cursor-crosshair'}`} />
        </div>
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={togglePlay}
              style={{ borderColor: GOLD, color: GOLD, minWidth: 60 }}>
              {isPlaying ? '❚❚ Pause' : '▶ Play'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => stepFrames(-1)}
              style={{ borderColor: GOLD, color: GOLD }} title="Previous frame">⏮ −1f</Button>
            <Button size="sm" variant="outline" onClick={() => stepFrames(1)}
              style={{ borderColor: GOLD, color: GOLD }} title="Next frame">+1f ⏭</Button>
            <span
              className="text-xs text-zinc-400 font-mono"
              title={detectedFps != null
                ? `Detected source frame rate: ${detectedFps}fps`
                : "Detecting source frame rate…"}
            >
              {detectedFps != null ? `${Math.round(detectedFps)}fps` : "detecting…"}
            </span>
            <span className="text-xs text-zinc-400 ml-2">Speed:</span>
            {PLAYBACK_RATES.map(r => (
              <Button key={r} size="sm" variant={playbackRate === r ? 'default' : 'outline'}
                onClick={() => setPlaybackRate(r)}
                style={playbackRate === r ? { backgroundColor: GOLD, color: '#000' } : { borderColor: GOLD, color: GOLD }}>
                {r}x
              </Button>
            ))}
            <span className="text-xs text-zinc-500 ml-auto font-mono">
              {videoTime.toFixed(2)}s / {videoDuration.toFixed(2)}s
            </span>
          </div>
          <input type="range" min={0} max={videoDuration || 0} step={1 / fpsForStepping}
            value={videoTime} onChange={onScrub} className="w-full accent-yellow-500"
            aria-label="Video scrubber" />
          {/* Task #1055 — drawing timeline strip: one draggable marker per
              shape so coaches can slide a drawing to any moment in one
              gesture instead of nudging by ±1 frame. */}
          <div
            ref={timelineStripRef}
            onPointerDown={beginBoxSelect}
            className="relative w-full h-6 mt-1 bg-zinc-800 rounded"
            aria-label="Drawing timeline. Drag horizontally on empty area to box-select markers."
            data-testid="drawing-timeline-strip"
            style={{ touchAction: 'none' }}
          >
            {videoDuration > 0 && shapes.map((s, i) => {
              const ratio = Math.max(0, Math.min(1, s.t / videoDuration));
              const isSel = selectedIdxs.includes(i);
              return (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-label={`Drawing ${i + 1} at ${s.t.toFixed(2)} seconds. Drag to retime. Shift-click to add to selection.`}
                  title={`Drawing #${i + 1} at ${s.t.toFixed(2)}s — drag to retime, shift-click to multi-select`}
                  data-testid={`drawing-marker-${i}`}
                  data-selected={isSel ? 'true' : 'false'}
                  onPointerDown={(e) => beginMarkerDrag(e, i)}
                  className="absolute top-0 cursor-ew-resize"
                  style={{
                    left: `${ratio * 100}%`,
                    transform: 'translateX(-50%)',
                    width: 10,
                    height: '100%',
                    background: s.color,
                    borderRadius: 3,
                    border: isSel ? '2px solid #00BFFF' : '1px solid rgba(0,0,0,0.6)',
                    boxShadow: isSel ? '0 0 6px #00BFFF' : undefined,
                    touchAction: 'none',
                  }}
                />
              );
            })}
            {videoDuration > 0 && (
              <div
                aria-hidden
                className="absolute top-0 bottom-0 w-px bg-yellow-500/70 pointer-events-none"
                style={{ left: `${Math.max(0, Math.min(1, videoTime / videoDuration)) * 100}%` }}
              />
            )}
            {/* Task #1415 — selection rectangle drawn while box-selecting. */}
            {boxSelect && (
              <div
                aria-hidden
                data-testid="drawing-timeline-box-select"
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: Math.min(boxSelect.startX, boxSelect.currentX),
                  width: Math.abs(boxSelect.currentX - boxSelect.startX),
                  background: 'rgba(0, 191, 255, 0.18)',
                  border: '1px solid rgba(0, 191, 255, 0.7)',
                }}
              />
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-3 items-center text-xs">
          <span className="text-zinc-400">Tool:</span>
          {(['select', 'line', 'arrow', 'circle', 'angle'] as const).map(t => (
            <Button key={t} size="sm" variant={tool === t ? 'default' : 'outline'}
              onClick={() => { setTool(t); angleClicksRef.current = []; }}
              style={tool === t ? { backgroundColor: GOLD, color: '#000' } : { borderColor: GOLD, color: GOLD }}>
              {t}
            </Button>
          ))}
          <input type="color" value={color} onChange={e => setColor(e.target.value)}
            className="w-8 h-8 bg-transparent border border-zinc-700 rounded" />
          <Button size="sm" variant="outline" onClick={undo}
            style={{ borderColor: '#666', color: '#ccc' }}>Undo</Button>
          <Button size="sm" variant="outline" onClick={clearAll}
            style={{ borderColor: '#666', color: '#ccc' }}>Clear</Button>
          <Button size="sm" variant="outline" onClick={duplicateSelected} disabled={primarySelectedIdx == null}
            style={{ borderColor: primarySelectedIdx != null ? GOLD : '#444', color: primarySelectedIdx != null ? GOLD : '#666' }}>
            Duplicate
          </Button>
          <Button size="sm" variant="outline" onClick={duplicateGroupToCurrent} disabled={selectedIdxs.length === 0}
            title="Copy every selected drawing to the current time, keeping their relative offsets (Ctrl/⌘+D)"
            style={{ borderColor: selectedIdxs.length > 0 ? GOLD : '#444', color: selectedIdxs.length > 0 ? GOLD : '#666' }}>
            Duplicate group
          </Button>
          {/* Task #1712 — Copy / Paste drawings clipboard. Copy stashes the
              selection (or the whole list) into a coach-local clipboard;
              Paste drops it at the playhead with the same offset-preserving
              math as Duplicate group. The clipboard survives between
              reviews in the same session. */}
          <Button size="sm" variant="outline" onClick={copyDrawings}
            data-testid="drawing-copy"
            disabled={shapes.length === 0}
            title={selectedIdxs.length > 0
              ? 'Copy selected drawings to the clipboard'
              : 'Copy all drawings on this review to the clipboard'}
            style={{ borderColor: shapes.length > 0 ? GOLD : '#444', color: shapes.length > 0 ? GOLD : '#666' }}>
            Copy drawings
          </Button>
          <Button size="sm" variant="outline" onClick={pasteDrawings}
            data-testid="drawing-paste"
            disabled={drawingClipboard.length === 0}
            title={drawingClipboard.length > 0
              ? 'Paste clipboard drawings at the current playhead, preserving relative offsets'
              : 'Copy drawings from any review first'}
            style={{ borderColor: drawingClipboard.length > 0 ? GOLD : '#444', color: drawingClipboard.length > 0 ? GOLD : '#666' }}>
            Paste drawings{drawingClipboard.length > 0 ? ` (${drawingClipboard.length})` : ''}
          </Button>
          {/* Task #2131 — persistent named-preset library. The button to
              the left saves the current selection (or all shapes) to the
              coach's permanent library; the dropdown to the right lets
              them apply any saved preset at the playhead, plus rename
              and delete entries. */}
          <Button size="sm" variant="outline" onClick={savePresetFromCurrent}
            data-testid="drawing-save-preset"
            disabled={shapes.length === 0 || savingPreset}
            title={selectedIdxs.length > 0
              ? 'Save the selected drawings as a named preset in your library'
              : 'Save every drawing on this review as a named preset in your library'}
            style={{ borderColor: shapes.length > 0 && !savingPreset ? GOLD : '#444', color: shapes.length > 0 && !savingPreset ? GOLD : '#666' }}>
            {savingPreset ? 'Saving…' : 'Save preset'}
          </Button>
          <div className="relative inline-block">
            <Button size="sm" variant="outline"
              data-testid="drawing-presets-toggle"
              onClick={() => setPresetMenuOpen(o => !o)}
              title={presets.length > 0
                ? `Apply, rename or delete one of your ${presets.length} saved preset${presets.length === 1 ? '' : 's'}`
                : 'No saved presets yet — use Save preset to start your library'}
              style={{ borderColor: presets.length > 0 ? GOLD : '#444', color: presets.length > 0 ? GOLD : '#666' }}>
              Presets{presets.length > 0 ? ` (${presets.length})` : ''} ▾
            </Button>
            {presetMenuOpen && (
              <div
                data-testid="drawing-presets-menu"
                className="absolute right-0 mt-1 w-72 max-h-80 overflow-y-auto bg-zinc-900 border border-zinc-700 rounded shadow-lg z-50"
                onMouseLeave={() => setPresetMenuOpen(false)}
              >
                {presets.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-400">
                    No saved presets yet. Draw something, then click "Save preset" to start your library.
                  </div>
                ) : (
                  presets.map(p => (
                    <div key={p.id}
                      data-testid={`drawing-preset-row-${p.id}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-zinc-800 border-b border-zinc-800 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => applyPreset(p)}
                        className="flex-1 text-left text-sm text-zinc-100 truncate"
                        title={`Paste "${p.name}" (${Array.isArray(p.drawings) ? p.drawings.length : 0} drawings) at the playhead`}
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="ml-2 text-xs text-zinc-500">
                          {Array.isArray(p.drawings) ? p.drawings.length : 0}
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid={`drawing-preset-rename-${p.id}`}
                        onClick={() => renamePreset(p)}
                        className="text-xs text-zinc-400 hover:text-zinc-100"
                        title="Rename this preset"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-testid={`drawing-preset-delete-${p.id}`}
                        onClick={() => deletePreset(p)}
                        className="text-xs text-red-400 hover:text-red-200"
                        title="Delete this preset"
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={retimeSelectedToCurrent} disabled={selectedIdxs.length === 0}
            title="Move selected shapes to the current video time"
            style={{ borderColor: selectedIdxs.length > 0 ? GOLD : '#444', color: selectedIdxs.length > 0 ? GOLD : '#666' }}>
            Move to current time
          </Button>
          <Button size="sm" variant="outline" onClick={() => retimeSelectedByFrames(-1)} disabled={selectedIdxs.length === 0}
            title="Move selected shapes one frame earlier"
            style={{ borderColor: selectedIdxs.length > 0 ? GOLD : '#444', color: selectedIdxs.length > 0 ? GOLD : '#666' }}>
            shape −1f
          </Button>
          <Button size="sm" variant="outline" onClick={() => retimeSelectedByFrames(1)} disabled={selectedIdxs.length === 0}
            title="Move selected shapes one frame later"
            style={{ borderColor: selectedIdxs.length > 0 ? GOLD : '#444', color: selectedIdxs.length > 0 ? GOLD : '#666' }}>
            shape +1f
          </Button>
          <Button size="sm" variant="outline" onClick={deleteSelected} disabled={selectedIdxs.length === 0}
            style={{ borderColor: selectedIdxs.length > 0 ? '#ff6666' : '#444', color: selectedIdxs.length > 0 ? '#ff6666' : '#666' }}>
            Delete shape
          </Button>
          <span className="text-zinc-500 ml-2" data-testid="drawing-selection-summary">
            {shapes.length} shape{shapes.length === 1 ? '' : 's'}
            {selectedIdxs.length > 0 && ` · ${selectedIdxs.length} selected`}
          </span>
        </div>
        {item.request.memberPrompt && (
          <div className="mb-4 p-3 bg-zinc-800 rounded">
            <div className="text-xs text-zinc-500 mb-1">Member's request</div>
            <div className="text-sm text-zinc-200">{item.request.memberPrompt}</div>
          </div>
        )}
        {item.request.status === 'paid' && (
          <Button variant="outline" onClick={start} className="mb-3" style={{ borderColor: GOLD, color: GOLD }}>
            Mark In-Review
          </Button>
        )}
        <div className="space-y-2">
          <label className="text-sm font-semibold" style={{ color: GOLD }}>Voice-over</label>
          <div className="flex items-center gap-2">
            {!recording
              ? <Button size="sm" onClick={startRecording} disabled={uploadingVoice}
                  style={{ backgroundColor: '#7a1f1f', color: '#fff' }}>● Record</Button>
              : <Button size="sm" onClick={stopRecording}
                  style={{ backgroundColor: '#000', color: '#fff', border: '1px solid #fff' }}>■ Stop</Button>}
            {voiceUrl && <span className="text-xs text-emerald-400">Voice-over ready ({voiceDuration?.toFixed(1)}s)</span>}
            {uploadingVoice && <span className="text-xs text-zinc-400">Uploading…</span>}
          </div>
          <label className="text-sm font-semibold pt-2 block" style={{ color: GOLD }}>Written feedback</label>
          <Textarea value={textNotes} onChange={e => setTextNotes(e.target.value)}
            placeholder="Detailed swing feedback…" rows={5}
            className="bg-zinc-800 border-zinc-700 text-white" />
          <Button onClick={deliver} disabled={submitting} style={{ backgroundColor: GOLD, color: '#000' }}>
            <Send className="w-4 h-4 mr-2" /> {submitting ? 'Delivering…' : 'Deliver Review'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// Task #1306 — coach-facing per-payout notification cell. Mirrors the
// admin badges (Task #1129) but without the Resend button (admin-only).
// When both channels missed (anything other than `sent`) we surface a
// short inline note so the coach knows we tried but couldn't reach
// them — payment itself is still complete.
function CoachPayoutNotificationCell({
  payoutId,
  payoutStatus,
  notification,
  onRetry,
}: {
  payoutId: number;
  payoutStatus: string;
  notification: CoachPayoutNotificationAttempt | null;
  onRetry: (payoutId: number) => Promise<void>;
}) {
  // Task #1543 — local "retrying" flag so the button is disabled during
  // the API call without yanking it from the DOM (parent reload happens
  // after the call resolves, which then re-derives the button state
  // from the fresh `coachRetryRequestedAt`).
  const [retrying, setRetrying] = useState(false);
  // Task #1913 — `now` ticks every second whenever the per-payout
  // cooldown is active so the inline "Try again in Xm Ys" countdown
  // updates in place AND the button reappears the moment the cooldown
  // expires, without requiring a page refresh. We seed with `Date.now()`
  // for the first paint and only attach an interval when actually
  // counting down (see effect below).
  const [now, setNow] = useState(() => Date.now());
  // Task #1543 / #1913 — single source of truth for "show button vs
  // show countdown vs show nothing", driven by the same helper the
  // API server uses so the client can never disagree about cooldown.
  // Computed before the early returns so the tick effect below stays
  // an unconditional hook call.
  const retryState = coachPayoutRetryState(notification, now);
  const inCooldown = retryState.kind === 'countdown';
  useEffect(() => {
    if (!inCooldown) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [inCooldown]);
  // Task #1920 — pull the active i18n language so the "tried {target}"
  // hint and "Update notification settings" link below render through
  // the shared lang→label tables (the rest of the badge text is still
  // the hardcoded English `coachPayoutChannelText`, tracked separately).
  const { i18n } = useTranslation();
  if (payoutStatus !== 'paid') {
    return <span className="text-zinc-600">—</span>;
  }
  if (!notification) {
    return (
      <Badge style={{ backgroundColor: '#2a2a2a', color: '#9ca3af' }}
        data-testid={`badge-coach-notif-pending-${payoutId}`}>
        Pending
      </Badge>
    );
  }
  const pushLabel: CoachPayoutChannelLabel = coachPayoutChannelLabel(
    notification.pushStatus, notification.pushAttempts,
    notification.pushRetryExhaustedAt, COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  );
  const smsLabel: CoachPayoutChannelLabel = coachPayoutChannelLabel(
    notification.smsStatus, notification.smsAttempts,
    notification.smsRetryExhaustedAt, COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  );
  const pushStyle = coachPayoutChannelBadgeStyle(pushLabel);
  const smsStyle = coachPayoutChannelBadgeStyle(smsLabel);
  const bothMissed = coachPayoutBothChannelsNonSent(pushLabel, smsLabel);
  // Task #1914 — once the coach has hit "Try again" enough times on
  // this stuck payout, surface a "contact support" deflection so the
  // next press becomes a support email instead of another retry into
  // the same broken contact details. The hint is driven by the same
  // helper the mobile coach screen uses so both platforms light it up
  // at exactly the same press count.
  const showSupportHint = coachPayoutShouldShowSupportHint(notification);
  // Task #1544 — only surface the masked target alongside a *non-sent*
  // badge: when the channel actually delivered the coach already knows
  // they got it, so repeating "we tried +91 ●●●●●● 4321" is noise. We
  // intentionally still hide the target on `opted_out` so the cell
  // doesn't leak the contact details of a coach who's silenced the
  // channel — they already know their own number.
  const showPushTarget = pushLabel !== 'sent' && pushLabel !== 'opted_out' && !!notification.pushTargetLabel;
  const showSmsTarget = smsLabel !== 'sent' && smsLabel !== 'opted_out' && !!notification.smsTargetMasked;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 flex-wrap" title={notification.lastPushError ?? undefined}>
        {pushLabel === 'sent'
          ? <BellRing className="w-3 h-3 text-emerald-400" />
          : <BellOff className="w-3 h-3 text-zinc-400" />}
        <span className="text-zinc-500">Push</span>
        <Badge
          style={{ backgroundColor: pushStyle.bg, color: pushStyle.fg }}
          data-testid={`badge-coach-notif-push-${payoutId}`}
          data-status={pushLabel}
        >
          {coachPayoutChannelText(pushLabel)}
        </Badge>
        {showPushTarget && (
          <span
            className="text-[11px] text-zinc-400"
            data-testid={`target-coach-notif-push-${payoutId}`}
          >
            {coachPayoutTriedTargetLabel(i18n.language, notification.pushTargetLabel!)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-wrap" title={notification.lastSmsError ?? undefined}>
        {smsLabel === 'sent'
          ? <BellRing className="w-3 h-3 text-emerald-400" />
          : <BellOff className="w-3 h-3 text-zinc-400" />}
        <span className="text-zinc-500">SMS</span>
        <Badge
          style={{ backgroundColor: smsStyle.bg, color: smsStyle.fg }}
          data-testid={`badge-coach-notif-sms-${payoutId}`}
          data-status={smsLabel}
        >
          {coachPayoutChannelText(smsLabel)}
        </Badge>
        {showSmsTarget && (
          <span
            className="text-[11px] text-zinc-400 font-mono"
            data-testid={`target-coach-notif-sms-${payoutId}`}
          >
            {coachPayoutTriedTargetLabel(i18n.language, notification.smsTargetMasked!)}
          </span>
        )}
      </div>
      {bothMissed && (
        <div
          className="flex items-start gap-1 mt-1 text-amber-300"
          data-testid={`note-coach-notif-both-missed-${payoutId}`}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="text-xs leading-tight">
            We couldn't reach you on push or SMS — your payout is still complete.{' '}
            {/* Task #1544 — deep link to the member portal communication
                preferences anchor so a coach who missed the notification
                can fix the underlying contact problem (re-enable push,
                update phone, etc.) without hunting through settings. */}
            <a
              href="/portal#comm-prefs"
              className="underline text-amber-200 hover:text-amber-100"
              data-testid={`link-coach-notif-update-prefs-${payoutId}`}
            >
              {coachPayoutUpdatePrefsLinkLabel(i18n.language)}
            </a>
          </span>
        </div>
      )}
      {retryState.kind === 'button' && (
        <Button
          variant="outline"
          size="sm"
          className="mt-1 h-7 px-2 text-xs border-zinc-700 hover:border-amber-500"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try { await onRetry(payoutId); } finally { setRetrying(false); }
          }}
          data-testid={`button-coach-notif-retry-${payoutId}`}
        >
          {retrying ? 'Retrying…' : 'Try again'}
        </Button>
      )}
      {/* Task #1913 — While the per-payout cooldown is still ticking,
          show a small live countdown where the button used to sit so
          coaches who look back 30 seconds later don't think the
          system silently dropped their press. The text re-renders
          every second via the `now` tick effect above and the button
          reappears automatically the moment the helper flips back to
          `kind === 'button'`. */}
      {retryState.kind === 'countdown' && (
        <div
          className="mt-1 text-xs text-zinc-400"
          data-testid={`countdown-coach-notif-retry-${payoutId}`}
          aria-live="polite"
        >
          Try again in {formatCoachPayoutRetryCountdown(retryState.remainingMs)}
        </div>
      )}
      {/* Task #1914 — "contact support" deflection sits below both the
          button and the cooldown countdown so the coach always sees it
          once they've crossed the hint threshold, regardless of which
          state the retry control is currently in. */}
      {showSupportHint && (
        <div
          className="flex items-start gap-1 mt-1 text-amber-300"
          data-testid={`note-coach-notif-support-hint-${payoutId}`}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="text-xs leading-tight">
            Still not getting through?{' '}
            <a
              href="mailto:support@kharagolf.com?subject=Stuck%20payout%20notification"
              className="underline text-amber-200 hover:text-amber-100"
              data-testid={`link-coach-notif-support-${payoutId}`}
            >
              Contact support
            </a>
            {' '}— we've also alerted your club admin.
          </span>
        </div>
      )}
    </div>
  );
}

function EarningsTab({ earnings, reload, toast }: { earnings: any; reload: () => Promise<void> | void; toast: any }) {
  // Task #1543 — coach-side "Try again" handler. Wrapped here (not in
  // the cell) so we can pop a toast and trigger a reload of the
  // earnings response after the API call so the cooldown timestamp the
  // server stamped flows back into the cell's button state.
  const onRetry = useCallback(async (payoutId: number) => {
    const res = await fetch(`/api/swing-reviews/coach/payouts/${payoutId}/retry-notification`, {
      method: 'POST',
      credentials: 'include',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast({
        title: "Couldn't try again",
        description: body?.error ?? `Request failed (${res.status})`,
        variant: 'destructive',
      });
      return;
    }
    toast({ title: 'Re-sending your payout notification…' });
    await reload();
  }, [reload, toast]);
  if (!earnings) return null;
  const s = earnings.summary;
  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Lifetime earnings</div>
          <div className="text-2xl font-bold" style={{ color: GOLD }}>{formatRupees(s.lifetimeEarningsPaise)}</div>
          <div className="text-xs text-zinc-400 mt-1">{s.deliveredCount} reviews delivered</div>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Pending payout</div>
          <div className="text-2xl font-bold text-white">{formatRupees(s.pendingPayoutPaise)}</div>
          <div className="text-xs text-zinc-400 mt-1">{s.unpaidCount} awaiting</div>
        </Card>
        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Revenue share</div>
          <div className="text-2xl font-bold text-white">{earnings.sharePct}%</div>
          <div className="text-xs text-zinc-400 mt-1">Set by club admin</div>
        </Card>
      </div>
      <Card className="bg-zinc-900 border-zinc-800 p-4">
        <h3 className="font-semibold mb-3" style={{ color: GOLD }}>Payout history</h3>
        {earnings.payouts.length === 0 ? (
          <div className="text-zinc-500 text-sm">No payouts yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-zinc-500 text-left">
              <th className="py-2">Period</th><th>Gross</th><th>Net</th><th>Status</th><th>Reference</th>
              <th>Notification</th>
            </tr></thead>
            <tbody>
              {earnings.payouts.map((p: any) => (
                <tr key={p.id} className="border-t border-zinc-800" data-testid={`row-coach-payout-${p.id}`}>
                  <td className="py-2">{new Date(p.periodStart).toLocaleDateString()} – {new Date(p.periodEnd).toLocaleDateString()}</td>
                  <td>{formatRupees(p.grossPaise)}</td>
                  <td className="font-semibold" style={{ color: GOLD }}>{formatRupees(p.netPayoutPaise)}</td>
                  <td><Badge variant="outline">{p.status}</Badge></td>
                  <td className="text-xs text-zinc-400">{p.payoutReference ?? '—'}</td>
                  <td className="text-xs" data-testid={`cell-coach-notification-${p.id}`}>
                    <CoachPayoutNotificationCell
                      payoutId={p.id}
                      payoutStatus={p.status}
                      notification={p.notification ?? null}
                      onRetry={onRetry}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ProfileTab({ pro, profile, reload, toast }: { pro: Pro; profile: Profile | null; reload: () => void; toast: any }) {
  const [form, setForm] = useState({
    isListed: profile?.isListed ?? false,
    certifications: (profile?.certifications ?? []).join(', '),
    yearsExperience: profile?.yearsExperience ?? 0,
    languages: (profile?.languages ?? ['en']).join(', '),
    // Task #1356 — typed handicap window. Empty string means "no bound";
    // we send `null` for those to clear the column server-side.
    coachesHandicapMin: profile?.coachesHandicapMin ?? '',
    coachesHandicapMax: profile?.coachesHandicapMax ?? '',
    hourlyRatePaise: profile?.hourlyRatePaise ?? 0,
    asyncReviewPricePaise: profile?.asyncReviewPricePaise ?? 0,
    acceptsInPerson: profile?.acceptsInPerson ?? true,
    acceptsAsync: profile?.acceptsAsync ?? true,
    asyncTurnaroundHours: profile?.asyncTurnaroundHours ?? 48,
  });
  const [saving, setSaving] = useState(false);

  const parseHandicap = (raw: string): number | null => {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  // Task #2013 — Guard against inverted Min/Max so a coach can't fat-
  // finger Min=20/Max=5 and silently disappear from the marketplace
  // handicap filter. Only flag the case when *both* bounds are typed
  // and numeric — one-sided ranges (blank min OR blank max) are valid
  // and mean "no lower / no upper limit".
  const parsedMin = parseHandicap(String(form.coachesHandicapMin));
  const parsedMax = parseHandicap(String(form.coachesHandicapMax));
  const handicapRangeError =
    parsedMin != null && parsedMax != null && parsedMin > parsedMax
      ? 'Min handicap must be less than or equal to Max handicap.'
      : null;

  const save = async () => {
    if (handicapRangeError) {
      toast({
        title: "Can't save profile",
        description: handicapRangeError,
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    await fetch(`/api/coach-marketplace/pros/${pro.id}/profile`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        certifications: form.certifications.split(',').map(s => s.trim()).filter(Boolean),
        yearsExperience: Number(form.yearsExperience),
        languages: form.languages.split(',').map(s => s.trim()).filter(Boolean),
        coachesHandicapMin: parseHandicap(String(form.coachesHandicapMin)),
        coachesHandicapMax: parseHandicap(String(form.coachesHandicapMax)),
        hourlyRatePaise: Number(form.hourlyRatePaise),
        asyncReviewPricePaise: Number(form.asyncReviewPricePaise),
        acceptsInPerson: form.acceptsInPerson,
        acceptsAsync: form.acceptsAsync,
        asyncTurnaroundHours: Number(form.asyncTurnaroundHours),
      }),
    });
    await fetch(`/api/coach-marketplace/pros/${pro.id}/list`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isListed: form.isListed }),
    });
    setSaving(false);
    toast({ title: 'Profile saved' });
    reload();
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6 mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">List in marketplace</div>
          <div className="text-xs text-zinc-400">Members can find you in the public coach directory.</div>
        </div>
        <Switch checked={form.isListed} onCheckedChange={v => setForm({ ...form, isListed: v })} />
      </div>
      <Field label="Years of experience">
        <Input type="number" value={form.yearsExperience}
          onChange={e => setForm({ ...form, yearsExperience: Number(e.target.value) })}
          className="bg-zinc-800 border-zinc-700 text-white" />
      </Field>
      <Field label="Certifications (comma-separated)">
        <Input value={form.certifications}
          onChange={e => setForm({ ...form, certifications: e.target.value })}
          placeholder="PGA, IGGA Class A"
          className="bg-zinc-800 border-zinc-700 text-white" />
      </Field>
      <Field label="Languages (comma-separated)">
        <Input value={form.languages}
          onChange={e => setForm({ ...form, languages: e.target.value })}
          placeholder="en, hi"
          className="bg-zinc-800 border-zinc-700 text-white" />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">Student handicap range</div>
        <div className="text-xs text-zinc-400">
          The marketplace handicap filter surfaces you to players whose
          handicap falls inside this range. Leave a side blank for "no
          limit" — e.g. blank min + max 18 means "I coach everyone up to 18".
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min handicap (blank = no minimum)">
            <Input type="number" step="0.1" value={form.coachesHandicapMin}
              onChange={e => setForm({ ...form, coachesHandicapMin: e.target.value })}
              placeholder="0"
              data-testid="input-coaches-handicap-min"
              className="bg-zinc-800 border-zinc-700 text-white" />
          </Field>
          <Field label="Max handicap (blank = no maximum)">
            <Input type="number" step="0.1" value={form.coachesHandicapMax}
              onChange={e => setForm({ ...form, coachesHandicapMax: e.target.value })}
              placeholder="36"
              data-testid="input-coaches-handicap-max"
              className="bg-zinc-800 border-zinc-700 text-white" />
          </Field>
        </div>
        {handicapRangeError && (
          <div
            className="text-xs text-red-400"
            data-testid="error-coaches-handicap-range"
            role="alert"
          >
            {handicapRangeError}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2 p-4 bg-zinc-800 rounded">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Async swing review</span>
            <Switch checked={form.acceptsAsync} onCheckedChange={v => setForm({ ...form, acceptsAsync: v })} />
          </div>
          <Field label="Price (₹)">
            <Input type="number" value={form.asyncReviewPricePaise / 100}
              onChange={e => setForm({ ...form, asyncReviewPricePaise: Math.round(Number(e.target.value) * 100) })}
              className="bg-zinc-900 border-zinc-700 text-white" />
          </Field>
          <Field label="Turnaround (hours)">
            <Input type="number" value={form.asyncTurnaroundHours}
              onChange={e => setForm({ ...form, asyncTurnaroundHours: Number(e.target.value) })}
              className="bg-zinc-900 border-zinc-700 text-white" />
          </Field>
        </div>
        <div className="space-y-2 p-4 bg-zinc-800 rounded">
          <div className="flex items-center justify-between">
            <span className="font-semibold">In-person lessons</span>
            <Switch checked={form.acceptsInPerson} onCheckedChange={v => setForm({ ...form, acceptsInPerson: v })} />
          </div>
          <Field label="Hourly rate (₹)">
            <Input type="number" value={form.hourlyRatePaise / 100}
              onChange={e => setForm({ ...form, hourlyRatePaise: Math.round(Number(e.target.value) * 100) })}
              className="bg-zinc-900 border-zinc-700 text-white" />
          </Field>
        </div>
      </div>
      <Button
        onClick={save}
        disabled={saving || !!handicapRangeError}
        data-testid="button-save-coach-profile"
        style={{ backgroundColor: GOLD, color: '#000' }}
      >
        {saving ? 'Saving…' : 'Save Profile'}
      </Button>
      <PayoutAccountSection profile={profile} reload={reload} toast={toast} />
    </Card>
  );
}

function maskVpa(vpa: string): string {
  const [name, domain] = vpa.split('@');
  if (!name || !domain) return vpa;
  const visible = name.slice(0, 2);
  return `${visible}${'•'.repeat(Math.max(2, name.length - 2))}@${domain}`;
}

interface PayoutAccountHistoryEntry {
  id: number;
  changeKind: 'created' | 'updated' | 'admin_reverify' | string;
  method: 'upi' | 'bank_account' | string;
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  payoutAccountId: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  // Task #1222 — populated for `admin_reverify` rows; null otherwise.
  verificationOutcome: string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

// Task #1222 — keep the audit-row label in lock-step with the admin
// list so coaches see the same wording in their workspace.
function payoutHistoryLabel(h: PayoutAccountHistoryEntry): string {
  if (h.changeKind === 'created') return 'Account added';
  if (h.changeKind === 'admin_reverify') {
    const outcome = h.verificationOutcome ?? 'unknown';
    return `Admin re-verified (${outcome})`;
  }
  return 'Account updated';
}

// Task #1720 — change-type filter values shared with the org-admin
// dialog (see `coach-admin.tsx`). Mirrors the API's accepted
// `changeKind` query-parameter values plus an `all` sentinel so the
// default (no filter) preserves the existing behaviour.
type PayoutHistoryChangeKindFilter = 'all' | 'created' | 'updated' | 'admin_reverify';
const PAYOUT_HISTORY_CHANGE_KIND_FILTER_OPTIONS: { value: PayoutHistoryChangeKindFilter; label: string }[] = [
  { value: 'all', label: 'All change types' },
  { value: 'created', label: 'Account added' },
  { value: 'updated', label: 'Account updated' },
  { value: 'admin_reverify', label: 'Admin re-verified payout' },
];

function PayoutAccountHistory({ url, refreshKey }: { url: string; refreshKey: number }) {
  const [items, setItems] = useState<PayoutAccountHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Task #1720 — coaches can narrow their own audit trail by change
  // kind. The select forwards the choice to the API as `?changeKind=`
  // so the server does the filtering and pagination still respects
  // the most-recent-N window.
  const [filterKind, setFilterKind] = useState<PayoutHistoryChangeKindFilter>('all');
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    const fetchUrl = filterKind === 'all'
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}changeKind=${encodeURIComponent(filterKind)}`;
    fetch(fetchUrl, { credentials: 'include' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) { setError(d?.error ?? 'Failed to load history'); return; }
        setItems(d.history ?? []);
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [url, refreshKey, filterKind]);

  if (error) return <div className="text-sm text-red-400 mt-3">{error}</div>;

  const filterControl = (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor="select-payout-history-filter-kind" className="text-zinc-400">
        Filter:
      </label>
      <select
        id="select-payout-history-filter-kind"
        value={filterKind}
        onChange={e => setFilterKind(e.target.value as PayoutHistoryChangeKindFilter)}
        className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded h-7 px-2"
        data-testid="select-payout-history-filter-kind"
      >
        {PAYOUT_HISTORY_CHANGE_KIND_FILTER_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );

  if (items === null) {
    return (
      <div className="mt-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-zinc-400">Recent changes</div>
          {filterControl}
        </div>
        <div className="text-xs text-zinc-500">Loading change history…</div>
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid="payout-account-history">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-zinc-400">Recent changes</div>
        {filterControl}
      </div>
      {items.length === 0 ? (
        filterKind === 'all' ? (
          <div className="text-xs text-zinc-500" data-testid="text-payout-history-empty">
            No changes recorded yet. Each future save of your payout account will appear here.
          </div>
        ) : (
          <div className="text-xs text-zinc-500" data-testid="text-payout-history-filter-empty">
            No rows match the selected change type.
          </div>
        )
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 5).map(h => (
            <li key={h.id} className="bg-zinc-900/60 border border-zinc-800 rounded p-2 text-xs"
              data-testid={`payout-history-row-${h.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-300 font-semibold">
                  {payoutHistoryLabel(h)}
                  <span className="text-zinc-500 font-normal ml-2">
                    ({h.method === 'upi' ? 'UPI' : 'Bank account'})
                  </span>
                </span>
                <span className="text-zinc-500">{new Date(h.createdAt).toLocaleString()}</span>
              </div>
              <div className="text-zinc-400 mt-1">
                {h.method === 'upi' && h.upiVpaMasked && <span>UPI {h.upiVpaMasked}</span>}
                {h.method === 'bank_account' && h.bankAccountLast4 && (
                  <span>Account •••• {h.bankAccountLast4}{h.bankIfsc && <span className="ml-2">IFSC {h.bankIfsc}</span>}</span>
                )}
                {h.accountHolderName && <span className="text-zinc-500"> · {h.accountHolderName}</span>}
              </div>
              {h.changeKind === 'admin_reverify' && h.verificationReason && (
                <div className="text-zinc-400 mt-1" data-testid={`payout-history-reason-${h.id}`}>
                  Reason: {h.verificationReason}
                </div>
              )}
              <div className="text-zinc-500 mt-1">
                By {h.changedByName ?? 'unknown'}{h.changedByRole ? ` (${h.changedByRole})` : ''}
                {h.ipAddress && <span> · IP {h.ipAddress}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Task #1701 — Coach-scoped notification dispatch trail.
//
// Reads from the coach-only `/me/payout-account/notification-history`
// endpoint (filtered server-side to the authenticated coach's userId +
// the `coach.payout.account.changed.coach` key) and groups the per-leg
// audit rows by the `historyId` they were written for, so each
// payout-account change shows up as a single block with its three
// channels (email / in-app / push) side-by-side.
//
// Lets a coach who disputes whether they were alerted see at a glance
// which legs went out and why a leg was skipped (e.g. `push_opted_out`,
// `no_email_on_file`) without having to ask an admin to check the
// system-wide notification audit page.

interface PayoutNotificationAuditEntry {
  id: number;
  channel: string;
  status: string;
  reason: string | null;
  historyId: number | null;
  createdAt: string;
}

function PayoutNotificationHistory({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<PayoutNotificationAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch('/api/coach-marketplace/me/payout-account/notification-history', { credentials: 'include' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) { setError(d?.error ?? 'Failed to load notification history'); return; }
        setEntries(d.entries ?? []);
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (error) {
    return (
      <div className="mt-3 text-sm text-red-400" data-testid="payout-notification-history-error">
        {error}
      </div>
    );
  }
  if (entries === null) {
    return <div className="mt-3 text-xs text-zinc-500">Loading notification history…</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="mt-3 text-xs text-zinc-500" data-testid="payout-notification-history-empty">
        No notifications recorded yet. Each payout-account change will list
        which alerts (email, in-app, push) we sent — and why a channel was
        skipped.
      </div>
    );
  }

  // Group by historyId so each payout-account change is one card with all
  // three channels side-by-side. Rows missing a historyId (legacy / future
  // schema drift) fall under a single "Unattributed" bucket so they stay
  // visible rather than silently dropped.
  type Group = { historyId: number | null; createdAt: string; rows: PayoutNotificationAuditEntry[] };
  const byHistory = new Map<string, Group>();
  for (const e of entries) {
    const key = e.historyId == null ? 'none' : String(e.historyId);
    const existing = byHistory.get(key);
    if (existing) {
      existing.rows.push(e);
      // Track the most recent createdAt within the group so ordering is stable.
      if (e.createdAt > existing.createdAt) existing.createdAt = e.createdAt;
    } else {
      byHistory.set(key, { historyId: e.historyId, createdAt: e.createdAt, rows: [e] });
    }
  }
  const groups = [...byHistory.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  return (
    <div className="mt-4" data-testid="payout-notification-history">
      <div className="text-xs font-semibold text-zinc-400 mb-2">Notification history</div>
      <ul className="space-y-2">
        {groups.map(group => {
          const byChannel = new Map<string, PayoutNotificationAuditEntry>();
          for (const r of group.rows) {
            const existing = byChannel.get(r.channel);
            if (!existing || r.createdAt > existing.createdAt) byChannel.set(r.channel, r);
          }
          const orderedChannels = [
            ...NOTIFICATION_CHANNEL_ORDER.filter(c => byChannel.has(c)),
            ...[...byChannel.keys()].filter(c => !NOTIFICATION_CHANNEL_ORDER.includes(c)),
          ];
          const groupKey = group.historyId ?? 'unattributed';
          return (
            <li
              key={String(groupKey)}
              className="bg-zinc-900/60 border border-zinc-800 rounded p-2 text-xs"
              data-testid={`payout-notification-history-row-${groupKey}`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-zinc-300 font-semibold">
                  Account change
                  {group.historyId != null && (
                    <span className="text-zinc-500 font-normal ml-2">#{group.historyId}</span>
                  )}
                </span>
                <span className="text-zinc-500">{new Date(group.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {orderedChannels.map(channel => {
                  const r = byChannel.get(channel)!;
                  const label = NOTIFICATION_CHANNEL_LABEL[channel] ?? channel;
                  return (
                    <div
                      key={channel}
                      className={`rounded border px-2 py-1 ${notificationStatusTone(r.status)}`}
                      data-testid={`payout-notification-channel-${groupKey}-${channel}`}
                    >
                      <div className="font-semibold">{label}</div>
                      <div className="capitalize">{r.status.replace(/_/g, ' ')}</div>
                      {r.reason && (
                        <div
                          className="text-[11px] opacity-80 mt-0.5"
                          data-testid={`payout-notification-reason-${groupKey}-${channel}`}
                        >
                          {r.reason}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PayoutAccountSection({ profile, reload, toast }: { profile: Profile | null; reload: () => void; toast: any }) {
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<'upi' | 'bank_account'>(
    profile?.payoutMethod === 'bank_account' ? 'bank_account' : 'upi',
  );
  const [accountHolderName, setAccountHolderName] = useState(profile?.payoutAccountHolderName ?? '');
  useEffect(() => {
    if (profile?.payoutMethod === 'bank_account') setMethod('bank_account');
    else if (profile?.payoutMethod === 'upi') setMethod('upi');
    if (profile?.payoutAccountHolderName) setAccountHolderName(profile.payoutAccountHolderName);
  }, [profile?.payoutMethod, profile?.payoutAccountHolderName]);
  const [upiVpa, setUpiVpa] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankAccountConfirm, setBankAccountConfirm] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingVerification, setPendingVerification] = useState<{
    method: 'upi' | 'bank_account';
    verifiedHolderName: string | null;
    fundAccountId: string;
    razorpayContactId: string;
    verificationToken: string;
    upiVpa?: string;
    bankAccountLast4?: string;
    bankIfsc?: string;
  } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const hasAccount = !!(profile?.payoutMethod && profile?.payoutAccountId);

  const buildPayloadBase = () => {
    const body: Record<string, unknown> = { method, accountHolderName: accountHolderName.trim() };
    if (contact.trim()) body.contact = contact.trim();
    if (email.trim()) body.email = email.trim();
    if (method === 'upi') body.upiVpa = upiVpa.trim();
    else { body.bankAccountNumber = bankAccountNumber.replace(/\s+/g, ''); body.bankIfsc = bankIfsc.toUpperCase().trim(); }
    return body;
  };

  const verify = async () => {
    setError(null);
    if (!accountHolderName.trim()) { setError('Account holder name is required'); return; }
    if (method === 'upi') {
      if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiVpa.trim())) {
        setError('Enter a valid UPI VPA, e.g. name@bank'); return;
      }
    } else {
      const acct = bankAccountNumber.replace(/\s+/g, '');
      if (!/^\d{6,20}$/.test(acct)) { setError('Enter a valid account number (6–20 digits)'); return; }
      if (acct !== bankAccountConfirm.replace(/\s+/g, '')) { setError('Account numbers do not match'); return; }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc.toUpperCase().trim())) {
        setError('Enter a valid IFSC code'); return;
      }
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/coach-marketplace/me/payout-account', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayloadBase()),
      });
      const data = await res.json();
      if (!res.ok || !data.verification || data.verification.status !== 'verified') {
        setError(data.error ?? 'Verification failed. Please check your details.');
        return;
      }
      if (!data.verification.verificationToken) {
        setError('Verification token missing. Please try again.');
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
    if (!pendingVerification) return;
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        method: pendingVerification.method,
        confirm: true,
        verificationToken: pendingVerification.verificationToken,
      };
      const res = await fetch('/api/coach-marketplace/me/payout-account', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to save payout account'); return; }
      toast({ title: 'Payout account saved', description: 'Future payouts will go to this account automatically.' });
      setEditing(false); setPendingVerification(null);
      setUpiVpa(''); setBankAccountNumber(''); setBankAccountConfirm(''); setBankIfsc('');
      setHistoryKey(k => k + 1);
      reload();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const needsAttention = profile?.payoutVerificationStatus === 'needs_attention';

  return (
    <div className="border-t border-zinc-800 pt-4 mt-2">
      {needsAttention && (
        <div
          data-testid="banner-payout-needs-attention"
          className="mb-3 p-3 rounded-lg border border-amber-600 bg-amber-950/40 text-amber-100 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2"
          role="alert"
        >
          <div className="text-sm">
            <div className="font-semibold text-amber-200">Your payout account needs re-verification</div>
            <div className="text-amber-100/80 mt-1">
              Our latest scheduled re-check of your saved payout details didn't go through, so payouts are paused
              until you re-save them.
              {profile?.payoutVerificationFailureReason ? (
                <>
                  {' '}Reason: <span className="text-amber-50">{profile.payoutVerificationFailureReason}</span>
                </>
              ) : null}
            </div>
          </div>
          {!editing && (
            <Button
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="button-payout-needs-attention-fix"
              style={{ backgroundColor: GOLD, color: '#000' }}
            >
              Re-verify account
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-semibold" style={{ color: GOLD }}>Payout account</div>
          <div className="text-xs text-zinc-400">Where we send your review earnings via RazorpayX.</div>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}
            style={{ borderColor: GOLD, color: GOLD }}>
            {hasAccount ? 'Update' : 'Add account'}
          </Button>
        )}
      </div>

      {hasAccount && !editing && (
        <div className="bg-zinc-800 rounded p-3 text-sm space-y-1">
          <div>
            <span className="text-zinc-500">Method: </span>
            <span className="text-white">{profile?.payoutMethod === 'upi' ? 'UPI' : 'Bank account'}</span>
          </div>
          {profile?.payoutAccountHolderName && (
            <div><span className="text-zinc-500">Holder: </span><span className="text-white">{profile.payoutAccountHolderName}</span></div>
          )}
          {profile?.payoutMethod === 'upi' && profile.payoutVpa && (
            <div><span className="text-zinc-500">UPI: </span><span className="text-white">{maskVpa(profile.payoutVpa)}</span></div>
          )}
          {profile?.payoutMethod === 'bank_account' && profile.payoutBankAccountNumber && (
            <div>
              <span className="text-zinc-500">Account: </span>
              <span className="text-white">•••• {profile.payoutBankAccountNumber.slice(-4)}</span>
              {profile.payoutBankIfsc && <span className="text-zinc-500 ml-2">IFSC {profile.payoutBankIfsc}</span>}
            </div>
          )}
        </div>
      )}

      {!hasAccount && !editing && (
        <div className="bg-zinc-800/60 rounded p-3 text-sm text-zinc-400">
          No payout account on file. Add one so we can send your earnings automatically.
        </div>
      )}

      <PayoutAccountHistory url="/api/coach-marketplace/me/payout-account/history" refreshKey={historyKey} />

      <PayoutNotificationHistory refreshKey={historyKey} />

      {editing && (
        <div className="space-y-3 bg-zinc-800/60 rounded p-3 mt-2">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setMethod('upi')}
              style={method === 'upi' ? { backgroundColor: GOLD, color: '#000' } : { borderColor: GOLD, color: GOLD, backgroundColor: 'transparent', border: '1px solid' }}>
              UPI
            </Button>
            <Button size="sm" onClick={() => setMethod('bank_account')}
              style={method === 'bank_account' ? { backgroundColor: GOLD, color: '#000' } : { borderColor: GOLD, color: GOLD, backgroundColor: 'transparent', border: '1px solid' }}>
              Bank account
            </Button>
          </div>
          <Field label="Account holder name (must match KYC)">
            <Input value={accountHolderName} onChange={e => setAccountHolderName(e.target.value)}
              className="bg-zinc-900 border-zinc-700 text-white" />
          </Field>
          {method === 'upi' ? (
            <Field label="UPI VPA">
              <Input value={upiVpa} onChange={e => setUpiVpa(e.target.value)}
                placeholder="name@bank" autoCapitalize="off"
                className="bg-zinc-900 border-zinc-700 text-white" />
            </Field>
          ) : (
            <>
              <Field label="Bank account number">
                <Input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)}
                  inputMode="numeric" className="bg-zinc-900 border-zinc-700 text-white" />
              </Field>
              <Field label="Re-enter account number">
                <Input value={bankAccountConfirm} onChange={e => setBankAccountConfirm(e.target.value)}
                  inputMode="numeric" className="bg-zinc-900 border-zinc-700 text-white" />
              </Field>
              <Field label="IFSC code">
                <Input value={bankIfsc} onChange={e => setBankIfsc(e.target.value.toUpperCase())}
                  placeholder="HDFC0001234" className="bg-zinc-900 border-zinc-700 text-white" />
              </Field>
            </>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Contact phone (optional)">
              <Input value={contact} onChange={e => setContact(e.target.value)}
                placeholder="9XXXXXXXXX" className="bg-zinc-900 border-zinc-700 text-white" />
            </Field>
            <Field label="Email (optional)">
              <Input value={email} onChange={e => setEmail(e.target.value)} type="email"
                className="bg-zinc-900 border-zinc-700 text-white" />
            </Field>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
          {pendingVerification ? (
            <div className="rounded border border-emerald-700 bg-emerald-950/40 p-3 space-y-2">
              <div className="text-sm font-semibold text-emerald-300">Verified with the bank</div>
              <div className="text-sm text-zinc-200">
                The {pendingVerification.method === 'upi' ? 'UPI ID' : 'bank account'} you entered
                is registered to:
              </div>
              <div className="text-base font-semibold text-white">
                {pendingVerification.verifiedHolderName ?? '(name not returned by bank)'}
              </div>
              {pendingVerification.method === 'upi' && pendingVerification.upiVpa && (
                <div className="text-xs text-zinc-400">UPI: {pendingVerification.upiVpa}</div>
              )}
              {pendingVerification.method === 'bank_account' && (
                <div className="text-xs text-zinc-400">
                  Account •••• {pendingVerification.bankAccountLast4}
                  {pendingVerification.bankIfsc ? ` · IFSC ${pendingVerification.bankIfsc}` : ''}
                </div>
              )}
              <div className="text-xs text-zinc-300">
                Confirm this is your account before we send future payouts here.
              </div>
              <div className="flex gap-2 pt-1">
                <Button onClick={confirmAndSave} disabled={submitting}
                  style={{ backgroundColor: GOLD, color: '#000' }}>
                  {submitting ? 'Saving…' : 'Confirm and use this account'}
                </Button>
                <Button variant="ghost" onClick={() => setPendingVerification(null)} disabled={submitting}>
                  That's not me — edit details
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button onClick={verify} disabled={submitting}
                style={{ backgroundColor: GOLD, color: '#000' }}>
                {submitting ? 'Verifying with bank…' : 'Verify account'}
              </Button>
              <Button variant="ghost" onClick={() => { setEditing(false); setError(null); setPendingVerification(null); }}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-zinc-400">{label}</label>
      {children}
    </div>
  );
}
