import { useState, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Power, RotateCcw, TrendingUp, LineChart, Target, FlaskConical, Mail, Eye, UserPlus, Check, Info } from "lucide-react";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Tier {
  id: number; name: string; description: string | null; courseId: number | null;
  daysOfWeek: number[]; startTime: string | null; endTime: string | null;
  seasonStart: string | null; seasonEnd: string | null;
  memberType: "any" | "member" | "guest";
  memberRate: string; guestRate: string; priority: number; isActive: boolean;
}

interface Modifier {
  id: number; name: string; courseId: number | null;
  kind: "utilization" | "lead_time" | "weather";
  thresholdMin: string | null; thresholdMax: string | null;
  weatherCondition: string | null;
  adjustmentType: "percent" | "flat"; adjustmentValue: string;
  applyTo: "any" | "member" | "guest"; priority: number; isActive: boolean;
}

interface Config {
  organizationId: number; enabled: boolean;
  priceFloorPct: string; priceCeilingPct: string; dealBadgeThresholdPct: string;
  defaultMemberElasticity: string;
  defaultGuestElasticity: string;
}

interface Audit {
  id: number; action: string; entityType: string; entityId: number | null;
  notes: string | null; createdAt: string; payload: unknown;
}

interface Course { id: number; name: string }

interface PricingRule {
  id: number;
  name: string;
  conditions: {
    dayOfWeek?: number[];
    timeRange?: [string, string];
    occupancyMin?: number;
    leadTimeHoursMax?: number;
  };
  priceDeltaPct: string;
  priority: number;
  active: boolean;
}

export default function DynamicPricingPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [config, setConfig] = useState<Config | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [editTier, setEditTier] = useState<Partial<Tier> | null>(null);
  const [editMod, setEditMod] = useState<Partial<Modifier> | null>(null);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [editRule, setEditRule] = useState<Partial<PricingRule> | null>(null);

  // Task #1163 — Test rule preview state. When `testRule` is set we open a
  // dialog showing which upcoming slots in the next 7 days would actually
  // trigger the rule, with the rule step highlighted in each breakdown so
  // off-by-one and time-zone slip-ups are visible before the rule goes live.
  type RuleTestMatch = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; ruleStepIndex: number;
    breakdown: { source: string; label: string; before: number; after: number; detail?: { ruleId?: number } }[];
  };
  // Task #1344 — structured "why didn't this rule match" reason for a slot
  // that fell short of exactly one condition. Mirrors the API's
  // `RuleMatchFailure` discriminated union so we can render the expected vs
  // actual values in plain English.
  type RuleTestFailure =
    | { condition: "dayOfWeek"; expected: number[]; actual: number }
    | { condition: "timeRange"; expected: [string, string]; actual: string }
    | { condition: "occupancyMin"; expected: number; actual: number }
    | { condition: "leadTimeHoursMax"; expected: number; actual: number };
  type RuleTestNearMiss = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: RuleTestFailure[];
  };
  type RuleTestResult = {
    rule: PricingRule;
    days: number;
    memberType: "member" | "guest";
    courseId: number | null;
    slotsConsidered: number;
    matchCount: number;
    matches: RuleTestMatch[];
    nearMissLimit: number;
    nearMisses: RuleTestNearMiss[];
  };
  const [testRule, setTestRule] = useState<PricingRule | null>(null);
  const [testRuleMemberType, setTestRuleMemberType] = useState<"member" | "guest">("member");
  const [testRuleCourseId, setTestRuleCourseId] = useState<number | "">("");
  const [testRuleResult, setTestRuleResult] = useState<RuleTestResult | null>(null);
  const [testRuleLoading, setTestRuleLoading] = useState(false);
  const [testRuleError, setTestRuleError] = useState<string | null>(null);

  // Task #1345 — Test tier and Test modifier preview state. Mirrors the
  // rule preview above: when `testTier`/`testModifier` is set we open a
  // dialog showing which upcoming slots in the next 7 days resolve to that
  // tier as their base price (or include that modifier in their breakdown),
  // with the matching breakdown step highlighted so off-by-one settings
  // become visible before the engine goes live in production.
  type TierTestMatch = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; tierStepIndex: number;
    breakdown: { source: string; label: string; before: number; after: number; detail?: { tierId?: number } }[];
  };
  // Task #1606 — structured "why didn't this tier match" reason for a slot
  // that fell short of exactly one condition (or lost on priority). Mirrors
  // the API's `TierMatchFailure` discriminated union so we can render the
  // expected vs actual values in plain English.
  type TierTestFailure =
    | { condition: "course"; expected: number; actual: number }
    | { condition: "dayOfWeek"; expected: number[]; actual: number }
    | { condition: "timeRange"; expected: [string | null, string | null]; actual: string }
    | { condition: "season"; expected: [string | null, string | null]; actual: string }
    | { condition: "memberType"; expected: "any" | "member" | "guest"; actual: "member" | "guest" }
    | { condition: "priorityLoss"; expected: number; actual: { tierId: number; tierName: string; priority: number } }
    | { condition: "zeroRate"; expected: "member" | "guest"; actual: 0 };
  type TierTestNearMiss = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: TierTestFailure[];
  };
  type TierTestResult = {
    tier: { id: number; name: string };
    days: number;
    memberType: "member" | "guest";
    courseId: number | null;
    slotsConsidered: number;
    matchCount: number;
    matches: TierTestMatch[];
    nearMissLimit: number;
    nearMisses: TierTestNearMiss[];
  };
  const [testTier, setTestTier] = useState<Tier | null>(null);
  const [testTierMemberType, setTestTierMemberType] = useState<"member" | "guest">("member");
  const [testTierCourseId, setTestTierCourseId] = useState<number | "">("");
  const [testTierResult, setTestTierResult] = useState<TierTestResult | null>(null);
  const [testTierLoading, setTestTierLoading] = useState(false);
  const [testTierError, setTestTierError] = useState<string | null>(null);
  // Task #1996 — admin-controlled near-miss row count for the tier preview.
  // The API clamps 0–25; 0 hides the section entirely, larger values surface
  // more candidates when debugging a tier that's silently losing slots.
  const [testTierNearMissLimit, setTestTierNearMissLimit] = useState<number>(5);

  type ModifierTestMatch = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; modifierStepIndex: number;
    breakdown: { source: string; label: string; before: number; after: number; detail?: { modifierId?: number } }[];
  };
  // Task #1606 — structured "why didn't this modifier match" reason for a
  // slot that fell short of exactly one condition. Mirrors the API's
  // `ModifierMatchFailure` discriminated union.
  type ModifierTestFailure =
    | { condition: "course"; expected: number; actual: number }
    | { condition: "applyTo"; expected: "any" | "member" | "guest"; actual: "member" | "guest" }
    | { condition: "utilizationBelowMin"; expected: number; actual: number }
    | { condition: "utilizationAboveMax"; expected: number; actual: number }
    | { condition: "leadTimeBelowMin"; expected: number; actual: number }
    | { condition: "leadTimeAboveMax"; expected: number; actual: number }
    | { condition: "weatherMissing"; expected: string; actual: null }
    | { condition: "weatherMismatch"; expected: string; actual: string };
  type ModifierTestNearMiss = {
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: ModifierTestFailure[];
  };
  // Task #1994 — per-day forecast strip for weather modifier previews.
  // The backend fetches Open-Meteo's daily forecast for every distinct
  // course in the slot list, so the dialog can show "Mon=rain, Tue=clear,
  // …" alongside the matches and admins can see *why* their rule does
  // (or doesn't) fire on each upcoming day.
  type ModifierForecastDay = {
    date: string;
    weatherCode: number | null;
    condition: string | null;
    precipitationSum: number | null;
    windSpeedMax: number | null;
    temperatureMax: number | null;
    temperatureMin: number | null;
  };
  type ModifierForecastStrip = {
    courseId: number;
    courseName: string | null;
    days: ModifierForecastDay[];
  };
  type ModifierForecastBlock = {
    enabled: boolean;
    unavailable: boolean;
    reason: string | null;
    source: "open-meteo";
    byCourse: ModifierForecastStrip[];
  };
  type ModifierTestResult = {
    modifier: { id: number; name: string; kind: string };
    days: number;
    memberType: "member" | "guest";
    courseId: number | null;
    /** Task #1607 — global condition applied when forecast mode is off; null when per-day forecast is in effect. */
    simulatedWeather: string | null;
    /** Task #1994 — per-day forecast strip when the admin chose forecast mode. */
    forecast: ModifierForecastBlock | null;
    slotsConsidered: number;
    matchCount: number;
    matches: (ModifierTestMatch & { weatherConditionUsed?: string | null })[];
    nearMissLimit: number;
    nearMisses: ModifierTestNearMiss[];
  };
  const [testModifier, setTestModifier] = useState<Modifier | null>(null);
  const [testModifierMemberType, setTestModifierMemberType] = useState<"member" | "guest">("member");
  const [testModifierCourseId, setTestModifierCourseId] = useState<number | "">("");
  const [testModifierResult, setTestModifierResult] = useState<ModifierTestResult | null>(null);
  const [testModifierLoading, setTestModifierLoading] = useState(false);
  const [testModifierError, setTestModifierError] = useState<string | null>(null);
  // Task #1607 — admin-controlled simulated weather condition for the
  // modifier preview dialog. Only meaningful when the modifier kind is
  // "weather"; the override text is shown when mode === "override".
  const [testModifierSimulateWeather, setTestModifierSimulateWeather] = useState<string>("");
  // Task #1996 — sibling of testTierNearMissLimit for the modifier preview.
  // Same 0–25 range; 0 hides the near-miss section.
  const [testModifierNearMissLimit, setTestModifierNearMissLimit] = useState<number>(5);
  // Task #1994 — three-way weather mode selector for weather modifiers:
  //   "forecast" → ask the backend to use the live 7-day forecast per day
  //                (the new default — gives admins a realistic outlook)
  //   "override" → admin types a single condition that's applied globally
  //   "none"     → realistic "no forecast attached" preview (zero matches
  //                expected unless modifier has no weather condition)
  type ModifierWeatherMode = "forecast" | "override" | "none";
  const [testModifierWeatherMode, setTestModifierWeatherMode] = useState<ModifierWeatherMode>("forecast");

  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [previewCourseId, setPreviewCourseId] = useState<number | null>(null);
  const [previewFrom, setPreviewFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [previewTo, setPreviewTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  });
  const [previewMemberType, setPreviewMemberType] = useState<"member" | "guest">("member");
  const [previewData, setPreviewData] = useState<{ date: string; rows: { time: string; price: number; basePrice?: number; isDeal: boolean; tierName: string | null; dealBadge?: string | null; breakdown?: { source: string; label: string; before: number; after: number }[] }[] }[]>([]);

  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [reportTo, setReportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<{ summary: { revenue: number; seats_booked: number; seats_total: number | null; bookings: number; avg_price_per_seat: number } | null; daily: { day: string; slots_total: number; seats_booked: number; seats_total: number; revenue: number; avg_price_per_seat: number }[]; byTier: { id: number; name: string; bookings: number; revenue: number }[] } | null>(null);

  type ForecastResult = {
    horizonDays: number;
    assumptions: { historicalSampleDays: number; memberShare: number; fallbackUtilization: number; slotsConsidered: number; elasticity: number; memberElasticity: number; guestElasticity: number };
    active: { revenue: number; seatsBooked: number; seatsTotal: number; slots: number; avgPrice: number; utilizationPct: number };
    draft:  { revenue: number; seatsBooked: number; seatsTotal: number; slots: number; avgPrice: number; utilizationPct: number };
    delta: { revenue: number; revenuePct: number | null; avgPrice: number; avgPricePct: number | null; utilizationPct: number };
    daily: { date: string; activeRevenue: number; draftRevenue: number; activeAvgPrice: number; draftAvgPrice: number; activeSeatsBooked: number; draftSeatsBooked: number; seatsTotal: number }[];
  };

  const [inlineForecast, setInlineForecast] = useState<ForecastResult | null>(null);
  const [inlineForecastLoading, setInlineForecastLoading] = useState(false);
  const [inlineForecastError, setInlineForecastError] = useState<string | null>(null);

  const [inlineModForecast, setInlineModForecast] = useState<ForecastResult | null>(null);
  const [inlineModForecastLoading, setInlineModForecastLoading] = useState(false);
  const [inlineModForecastError, setInlineModForecastError] = useState<string | null>(null);

  const [forecastHorizon, setForecastHorizon] = useState<14 | 30>(14);
  const [forecastDraftTierId, setForecastDraftTierId] = useState<number | "all-active" | "">("");
  const [forecastMemberElasticity, setForecastMemberElasticity] = useState<number>(-0.2);
  const [forecastGuestElasticity, setForecastGuestElasticity] = useState<number>(-0.7);
  // Track whether the user has hand-picked each elasticity value this session.
  // Until they do, we keep each dropdown locked to the org's saved default so a
  // late-arriving config load doesn't stomp on a deliberate selection.
  const [memberElasticityTouched, setMemberElasticityTouched] = useState(false);
  const [guestElasticityTouched, setGuestElasticityTouched] = useState(false);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);

  type ForecastAccuracyRow = {
    forecastId: number;
    scenario: string;
    label: string | null;
    horizonDays: number;
    windowStart: string;
    windowEnd: string;
    courseId: number | null;
    createdAt: string;
    projectedRevenue: number;
    projectedAvgPrice: number;
    actualRevenue: number;
    actualAvgPrice: number;
    actualSeatsBooked: number;
    revenueError: number;
    revenueErrorPct: number | null;
    accuracyPct: number | null;
    accuracyBucket: "high" | "medium" | "low" | null;
    status: "complete" | "pending";
  };
  type ForecastAccuracySummary = {
    sampleSize: number;
    avgAccuracyPct: number;
    avgAbsoluteErrorPct: number;
    bucketCounts: { high: number; medium: number; low: number };
  };
  const [accuracyRows, setAccuracyRows] = useState<ForecastAccuracyRow[]>([]);
  const [accuracySummary, setAccuracySummary] = useState<ForecastAccuracySummary | null>(null);
  const [accuracyLoading, setAccuracyLoading] = useState(false);
  const [accuracyError, setAccuracyError] = useState<string | null>(null);
  const [accuracyCourseId, setAccuracyCourseId] = useState<number | "">("");
  const [accuracyScenario, setAccuracyScenario] = useState<"" | "active" | "draft">("");
  const [accuracyIncludePending, setAccuracyIncludePending] = useState(false);
  // Task #1258 — when an admin clicks the "Last projection" badge on a
  // tier/modifier card we pre-filter the accuracy view to that publish
  // label and remember which forecast row to scroll-to/highlight so the
  // matching row is impossible to miss.
  const [accuracyLabel, setAccuracyLabel] = useState<string>("");
  const [highlightForecastId, setHighlightForecastId] = useState<number | null>(null);
  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);

  const [accuracyTabSeen, setAccuracyTabSeen] = useState(false);
  const [activeTab, setActiveTab] = useState("tiers");

  type PublishSnapshot = {
    tierId?: number;
    modifierId?: number;
    label: string;
    scenario: string;
    horizonDays: number;
    windowStart: string;
    windowEnd: string;
    projectedRevenue: number;
    projectedAvgPrice: number;
    projectedSeatsBooked: number;
    projectedSeatsTotal: number;
    createdAt: string;
  };
  const [publishSnapshots, setPublishSnapshots] = useState<Record<string, PublishSnapshot>>({});
  // Task #1257 — sibling map for modifier publish snapshots, populated from
  // the new `modifiers/publish-snapshots` endpoint and rendered as a badge
  // on each demand-modifier card (mirrors the tier-card badge above).
  const [modifierPublishSnapshots, setModifierPublishSnapshots] = useState<Record<string, PublishSnapshot>>({});

  // Drill-down detail for a single past forecast (Task #1097). The dialog
  // opens with the row's metadata immediately, and the per-day projected vs
  // actual breakdown loads asynchronously from the detail endpoint.
  type ForecastAccuracyDetail = {
    forecast: {
      id: number; scenario: string; label: string | null; horizonDays: number;
      windowStart: string; windowEnd: string; courseId: number | null;
      actorUserId: number | null; createdAt: string;
      projectedRevenue: number; projectedAvgPrice: number;
      projectedSeatsBooked: number; projectedSeatsTotal: number;
      assumptions: Record<string, unknown> | null;
    };
    totals: {
      projectedRevenue: number; actualRevenue: number;
      actualSeatsBooked: number; actualBookings: number;
      seatsTotal: number; revenueError: number;
      revenueErrorPct: number | null; accuracyPct: number | null;
      utilizationPct: number; avgPricePerSeat: number;
    };
    daily: {
      day: string; projectedRevenue: number; actualRevenue: number;
      actualBookings: number; actualSeatsBooked: number;
      slotsTotal: number; seatsTotal: number;
      utilizationPct: number; avgPricePerSeat: number;
      revenueDelta: number; pending: boolean;
    }[];
    biggestMiss: { day: string; revenueDelta: number } | null;
    status: "complete" | "pending";
    // Task #1263 — "snapshot" when the per-day projection comes from the
    // snapshot the forecaster recorded; "flat" when this is a forecast
    // saved before per-day projections were captured and the API is
    // attributing the projected total evenly across the horizon.
    projectionSource?: "snapshot" | "flat";
  };
  const [drillRow, setDrillRow] = useState<ForecastAccuracyRow | null>(null);
  const [drillDetail, setDrillDetail] = useState<ForecastAccuracyDetail | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  useEffect(() => {
    if (!drillRow || !orgId) {
      setDrillDetail(null);
      setDrillError(null);
      setDrillLoading(false);
      return;
    }
    const controller = new AbortController();
    setDrillLoading(true);
    setDrillError(null);
    setDrillDetail(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${drillRow.forecastId}`,
          { credentials: "include", signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!controller.signal.aborted) setDrillDetail(j);
      } catch (e) {
        if (controller.signal.aborted) return;
        setDrillError(e instanceof Error ? e.message : "Failed to load detail");
      } finally {
        if (!controller.signal.aborted) setDrillLoading(false);
      }
    })();
    return () => controller.abort();
  }, [drillRow, orgId]);

  const runAccuracy = async () => {
    if (!orgId) return;
    setAccuracyLoading(true);
    setAccuracyError(null);
    try {
      const qs = new URLSearchParams({ limit: "100" });
      if (accuracyCourseId !== "") qs.set("courseId", String(accuracyCourseId));
      if (accuracyScenario !== "") qs.set("scenario", accuracyScenario);
      if (accuracyIncludePending) qs.set("includePending", "true");
      if (accuracyLabel !== "") qs.set("label", accuracyLabel);
      const res = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setAccuracyRows(j.rows ?? []);
      setAccuracySummary(j.summary ?? null);
    } catch (e) {
      setAccuracyError(e instanceof Error ? e.message : "Failed to load");
      setAccuracyRows([]);
      setAccuracySummary(null);
    } finally {
      setAccuracyLoading(false);
    }
  };

  const downloadAccuracyCsv = () => {
    if (accuracyRows.length === 0) return;
    const headers = [
      "window_start",
      "window_end",
      "scenario",
      "label",
      "projected_revenue",
      "actual_revenue",
      "error_pct",
      "accuracy_pct",
      "bucket",
    ];
    const escape = (v: unknown): string => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const r of accuracyRows) {
      lines.push([
        r.windowStart,
        r.windowEnd,
        r.scenario,
        r.label ?? "",
        r.projectedRevenue,
        r.status === "pending" ? "" : r.actualRevenue,
        r.revenueErrorPct == null ? "" : r.revenueErrorPct.toFixed(2),
        r.accuracyPct == null ? "" : r.accuracyPct.toFixed(2),
        r.accuracyBucket ?? r.status,
      ].map(escape).join(","));
    }
    const csv = lines.join("\n");
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const slug = sanitize(orgSlug && orgSlug.trim() ? orgSlug : `org-${orgId}`);
    const starts = accuracyRows.map(r => r.windowStart).filter(Boolean).sort();
    const ends = accuracyRows.map(r => r.windowEnd).filter(Boolean).sort();
    const fromDate = sanitize(starts[0] ?? "");
    const toDate = sanitize(ends[ends.length - 1] ?? "");
    const range = fromDate && toDate ? `_${fromDate}_to_${toDate}` : "";
    const filename = `${slug}_forecast-accuracy${range}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Auto-load (and re-load on filter changes) once the admin has opened the
  // tab at least once. Debounced so toggling filters quickly doesn't fan out
  // a burst of requests.
  useEffect(() => {
    if (!accuracyTabSeen || !orgId) return;
    const handle = setTimeout(() => { runAccuracy(); }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accuracyTabSeen, orgId, accuracyCourseId, accuracyScenario, accuracyIncludePending, accuracyLabel]);

  // Task #1258 — when a label filter is active, the most-recent matching
  // row is the snapshot the admin clicked through from. Highlight & scroll
  // it into view so they don't have to hunt for it. We derive the target
  // row from the loaded rows rather than threading it through state from
  // the badge click, so it stays correct after manual filter changes.
  useEffect(() => {
    if (!accuracyLabel) {
      setHighlightForecastId(null);
      return;
    }
    const match = accuracyRows.find(r => r.label === accuracyLabel);
    setHighlightForecastId(match ? match.forecastId : null);
  }, [accuracyLabel, accuracyRows]);

  useEffect(() => {
    if (highlightForecastId == null) return;
    const node = highlightedRowRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightForecastId]);

  const reload = async () => {
    if (!orgId) return;
    const [c, t, m, a, cr, rl, org, ps, mps] = await Promise.all([
      fetch(`/api/organizations/${orgId}/tee-pricing/config`, { credentials: "include" }).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tee-pricing/tiers`, { credentials: "include" }).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tee-pricing/modifiers`, { credentials: "include" }).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tee-pricing/audit?limit=50`, { credentials: "include" }).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/courses`, { credentials: "include" }).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tee-pricing/rules`, { credentials: "include" }).then(r => r.json()).catch(() => []),
      fetch(`/api/organizations/${orgId}`, { credentials: "include" }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/organizations/${orgId}/tee-pricing/tiers/publish-snapshots`, { credentials: "include" })
        .then(r => r.ok ? r.json() : { snapshots: {} })
        .catch(() => ({ snapshots: {} })),
      fetch(`/api/organizations/${orgId}/tee-pricing/modifiers/publish-snapshots`, { credentials: "include" })
        .then(r => r.ok ? r.json() : { snapshots: {} })
        .catch(() => ({ snapshots: {} })),
    ]);
    setConfig(c); setTiers(t); setModifiers(m); setAudit(a);
    setCourses(cr);
    setRules(Array.isArray(rl) ? rl : []);
    if (org && typeof org.slug === "string") setOrgSlug(org.slug);
    setPublishSnapshots((ps && typeof ps === "object" && ps.snapshots) ? ps.snapshots : {});
    setModifierPublishSnapshots((mps && typeof mps === "object" && mps.snapshots) ? mps.snapshots : {});
    if (cr.length && previewCourseId == null) setPreviewCourseId(cr[0].id);
    if (!memberElasticityTouched && c?.defaultMemberElasticity != null) {
      const n = parseFloat(c.defaultMemberElasticity);
      if (Number.isFinite(n)) setForecastMemberElasticity(n);
    }
    if (!guestElasticityTouched && c?.defaultGuestElasticity != null) {
      const n = parseFloat(c.defaultGuestElasticity);
      if (Number.isFinite(n)) setForecastGuestElasticity(n);
    }
  };
  useEffect(() => { reload(); }, [orgId]);

  const saveConfig = async (patch: Partial<Config>) => {
    const next = { ...(config ?? {}), ...patch };
    const res = await fetch(`/api/organizations/${orgId}/tee-pricing/config`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (res.ok) { toast({ title: "Saved" }); reload(); }
    else toast({ title: "Save failed", variant: "destructive" });
  };

  const saveTier = async (opts?: { toastDescription?: string }) => {
    if (!editTier) return;
    const url = editTier.id
      ? `/api/organizations/${orgId}/tee-pricing/tiers/${editTier.id}`
      : `/api/organizations/${orgId}/tee-pricing/tiers`;
    const res = await fetch(url, {
      method: editTier.id ? "PATCH" : "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editTier),
    });
    if (res.ok) {
      setEditTier(null); reload();
      toast({ title: "Tier saved", description: opts?.toastDescription });
    }
    else toast({ title: "Save failed", variant: "destructive" });
  };

  const applyDraftFromForecast = async () => {
    if (!inlineForecast) { await saveTier(); return; }
    const d = inlineForecast.delta;
    const revStr = `${d.revenue >= 0 ? "+" : ""}₹${Math.round(d.revenue).toLocaleString()}`
      + (d.revenuePct != null ? ` (${d.revenuePct >= 0 ? "+" : ""}${d.revenuePct.toFixed(1)}%)` : "");
    const avgStr = `${d.avgPrice >= 0 ? "+" : ""}₹${d.avgPrice.toFixed(0)}`
      + (d.avgPricePct != null ? ` (${d.avgPricePct >= 0 ? "+" : ""}${d.avgPricePct.toFixed(1)}%)` : "");
    await saveTier({ toastDescription: `Projected revenue ${revStr} · avg ₹/seat ${avgStr} over next ${inlineForecast.horizonDays} days.` });
  };

  // Save the draft and immediately flip it live via the same activate endpoint
  // that the manual toggle uses, so the audit trail matches a regular activation.
  const [applyActivateBusy, setApplyActivateBusy] = useState(false);
  const applyAndActivateDraft = async () => {
    if (!editTier || applyActivateBusy) return;
    setApplyActivateBusy(true);
    try {
      const url = editTier.id
        ? `/api/organizations/${orgId}/tee-pricing/tiers/${editTier.id}`
        : `/api/organizations/${orgId}/tee-pricing/tiers`;
      const saveRes = await fetch(url, {
        method: editTier.id ? "PATCH" : "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editTier),
      });
      if (!saveRes.ok) { toast({ title: "Save failed", variant: "destructive" }); return; }
      const saved = await saveRes.json().catch(() => null);
      const tierId = editTier.id ?? saved?.id;
      // Pin the new id back onto editTier so any retry from this same open
      // editor PATCHes instead of POSTing a duplicate tier.
      if (!editTier.id && saved?.id) {
        setEditTier({ ...editTier, id: saved.id });
      }
      if (!tierId) {
        toast({ title: "Activation failed", description: "Could not resolve saved tier id.", variant: "destructive" });
        reload();
        return;
      }
      const actRes = await fetch(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/activate`, {
        method: "POST", credentials: "include",
      });
      if (!actRes.ok) {
        toast({ title: "Saved, but activation failed", variant: "destructive" });
        reload();
        return;
      }
      setEditTier(null);
      reload();
      let description: string | undefined;
      if (inlineForecast) {
        const d = inlineForecast.delta;
        const revStr = `${d.revenue >= 0 ? "+" : ""}₹${Math.round(d.revenue).toLocaleString()}`
          + (d.revenuePct != null ? ` (${d.revenuePct >= 0 ? "+" : ""}${d.revenuePct.toFixed(1)}%)` : "");
        description = `Projected revenue ${revStr} over next ${inlineForecast.horizonDays} days.`;
      }
      toast({ title: "Tier applied & activated", description });
    } finally {
      setApplyActivateBusy(false);
    }
  };

  const deleteTier = async (id: number) => {
    if (!confirm("Delete this tier?")) return;
    await fetch(`/api/organizations/${orgId}/tee-pricing/tiers/${id}`, { method: "DELETE", credentials: "include" });
    reload();
  };

  const toggleTier = async (t: Tier) => {
    const action = t.isActive ? "deactivate" : "activate";
    await fetch(`/api/organizations/${orgId}/tee-pricing/tiers/${t.id}/${action}`, {
      method: "POST", credentials: "include",
    });
    reload();
  };

  const saveMod = async () => {
    if (!editMod) return;
    const url = editMod.id
      ? `/api/organizations/${orgId}/tee-pricing/modifiers/${editMod.id}`
      : `/api/organizations/${orgId}/tee-pricing/modifiers`;
    const res = await fetch(url, {
      method: editMod.id ? "PATCH" : "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editMod),
    });
    if (res.ok) { setEditMod(null); reload(); toast({ title: "Modifier saved" }); }
    else toast({ title: "Save failed", variant: "destructive" });
  };

  const deleteMod = async (id: number) => {
    if (!confirm("Delete this modifier?")) return;
    await fetch(`/api/organizations/${orgId}/tee-pricing/modifiers/${id}`, { method: "DELETE", credentials: "include" });
    reload();
  };

  const runPreview = async () => {
    if (!previewCourseId) return;
    const times = ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00"];
    const res = await fetch(`/api/organizations/${orgId}/tee-pricing/preview-calendar`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: previewCourseId, fromDate: previewFrom, toDate: previewTo, times, memberType: previewMemberType }),
    });
    if (res.ok) { const j = await res.json(); setPreviewData(j.calendar); }
  };

  const runForecast = async () => {
    if (!orgId) return;
    setForecastLoading(true);
    try {
      // Build a "draft" snapshot. We mirror the current tier set but flip the
      // selected pending tier between active/inactive states so the engine sees
      // exactly what would happen on activation.
      const tierOverrides: Partial<Tier>[] = [];
      if (forecastDraftTierId === "all-active") {
        // No overrides — draft == active. Useful as a sanity check.
      } else if (forecastDraftTierId !== "") {
        const id = Number(forecastDraftTierId);
        const tier = tiers.find(t => t.id === id);
        if (tier) {
          tierOverrides.push({ ...tier, isActive: !tier.isActive });
        }
      }
      const body = {
        horizonDays: forecastHorizon,
        courseId: previewCourseId ?? undefined,
        draft: { tierOverrides },
        memberElasticity: forecastMemberElasticity,
        guestElasticity: forecastGuestElasticity,
      };
      const res = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) setForecast(await res.json());
      else toast({ title: "Forecast failed", variant: "destructive" });
    } finally { setForecastLoading(false); }
  };

  // Inline "what-if" forecast for the open tier editor dialog. Debounced so
  // typing in fields doesn't hammer the endpoint. We also abort in-flight
  // requests when the inputs change so a slow stale response can't overwrite
  // the fresh state.
  useEffect(() => {
    if (!editTier || !orgId) {
      setInlineForecast(null);
      setInlineForecastError(null);
      setInlineForecastLoading(false);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setInlineForecastLoading(true);
      setInlineForecastError(null);
      try {
        const override: Partial<Tier> = {
          name: editTier.name ?? "Draft tier",
          courseId: editTier.courseId ?? null,
          daysOfWeek: editTier.daysOfWeek ?? [0,1,2,3,4,5,6],
          startTime: editTier.startTime ?? null,
          endTime: editTier.endTime ?? null,
          seasonStart: editTier.seasonStart ?? null,
          seasonEnd: editTier.seasonEnd ?? null,
          memberType: editTier.memberType ?? "any",
          memberRate: editTier.memberRate ?? "0",
          guestRate: editTier.guestRate ?? "0",
          priority: editTier.priority ?? 0,
          isActive: editTier.isActive ?? true,
        };
        if (editTier.id) override.id = editTier.id;
        const body = {
          horizonDays: 14,
          courseId: editTier.courseId ?? undefined,
          draft: { tierOverrides: [override] },
        };
        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: ForecastResult = await res.json();
        if (controller.signal.aborted) return;
        setInlineForecast(j);
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setInlineForecast(null);
        setInlineForecastError(e instanceof Error ? e.message : "Forecast failed");
      } finally {
        if (!controller.signal.aborted) setInlineForecastLoading(false);
      }
    }, 500);
    return () => { clearTimeout(handle); controller.abort(); };
  }, [
    orgId,
    editTier?.id,
    editTier?.name,
    editTier?.courseId,
    editTier?.memberType,
    editTier?.memberRate,
    editTier?.guestRate,
    editTier?.priority,
    editTier?.startTime,
    editTier?.endTime,
    editTier?.seasonStart,
    editTier?.seasonEnd,
    editTier?.isActive,
    JSON.stringify(editTier?.daysOfWeek ?? []),
  ]);

  // Inline "what-if" forecast for the open modifier editor dialog. Mirrors the
  // tier-editor effect: debounced + abortable so typing doesn't hammer the
  // endpoint and slow stale responses can't overwrite fresh state.
  useEffect(() => {
    if (!editMod || !orgId) {
      setInlineModForecast(null);
      setInlineModForecastError(null);
      setInlineModForecastLoading(false);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setInlineModForecastLoading(true);
      setInlineModForecastError(null);
      try {
        const override: Partial<Modifier> = {
          name: editMod.name ?? "Draft modifier",
          courseId: editMod.courseId ?? null,
          kind: editMod.kind ?? "utilization",
          thresholdMin: editMod.thresholdMin ?? null,
          thresholdMax: editMod.thresholdMax ?? null,
          weatherCondition: editMod.weatherCondition ?? null,
          adjustmentType: editMod.adjustmentType ?? "percent",
          adjustmentValue: editMod.adjustmentValue ?? "0",
          applyTo: editMod.applyTo ?? "any",
          priority: editMod.priority ?? 0,
          isActive: editMod.isActive ?? true,
        };
        if (editMod.id) override.id = editMod.id;
        const body = {
          horizonDays: 14,
          courseId: editMod.courseId ?? undefined,
          draft: { modifierOverrides: [override] },
        };
        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: ForecastResult = await res.json();
        if (controller.signal.aborted) return;
        setInlineModForecast(j);
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setInlineModForecast(null);
        setInlineModForecastError(e instanceof Error ? e.message : "Forecast failed");
      } finally {
        if (!controller.signal.aborted) setInlineModForecastLoading(false);
      }
    }, 500);
    return () => { clearTimeout(handle); controller.abort(); };
  }, [
    orgId,
    editMod?.id,
    editMod?.name,
    editMod?.courseId,
    editMod?.kind,
    editMod?.thresholdMin,
    editMod?.thresholdMax,
    editMod?.weatherCondition,
    editMod?.adjustmentType,
    editMod?.adjustmentValue,
    editMod?.applyTo,
    editMod?.priority,
    editMod?.isActive,
  ]);

  // Task #1163 — kick off a rule preview whenever the test dialog opens or
  // the admin changes the course/member-type filters inside it. We refetch
  // rather than caching client-side because slot inventory and bookings
  // (which feed occupancy + lead-time conditions) change continuously.
  useEffect(() => {
    if (!testRule || !orgId) return;
    const controller = new AbortController();
    setTestRuleLoading(true);
    setTestRuleError(null);
    (async () => {
      try {
        const body: Record<string, unknown> = { days: 7, memberType: testRuleMemberType };
        if (testRuleCourseId !== "") body.courseId = testRuleCourseId;
        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/rules/${testRule.id}/preview`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: RuleTestResult = await res.json();
        if (controller.signal.aborted) return;
        setTestRuleResult(j);
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setTestRuleResult(null);
        setTestRuleError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        if (!controller.signal.aborted) setTestRuleLoading(false);
      }
    })();
    return () => controller.abort();
  }, [orgId, testRule?.id, testRuleMemberType, testRuleCourseId]);

  // Task #1345 — same fetch loop as the rule preview above, for tier
  // previews. Refetches whenever the dialog opens or the course/member-type
  // filter changes, since slot inventory + bookings change continuously.
  useEffect(() => {
    if (!testTier || !orgId) return;
    const controller = new AbortController();
    setTestTierLoading(true);
    setTestTierError(null);
    (async () => {
      try {
        // Task #1606 — also request near-miss reasons (default of 5).
        // Task #1996 — admin can bump the count via the dialog input.
        const body: Record<string, unknown> = { days: 7, memberType: testTierMemberType, nearMissLimit: testTierNearMissLimit };
        if (testTierCourseId !== "") body.courseId = testTierCourseId;
        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/tiers/${testTier.id}/preview`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: TierTestResult = await res.json();
        if (controller.signal.aborted) return;
        setTestTierResult(j);
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setTestTierResult(null);
        setTestTierError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        if (!controller.signal.aborted) setTestTierLoading(false);
      }
    })();
    return () => controller.abort();
  }, [orgId, testTier?.id, testTierMemberType, testTierCourseId, testTierNearMissLimit]);

  // Task #1345 — modifier preview fetch loop, sibling of the tier loop.
  useEffect(() => {
    if (!testModifier || !orgId) return;
    const controller = new AbortController();
    setTestModifierLoading(true);
    setTestModifierError(null);
    (async () => {
      try {
        // Task #1606 — also request near-miss reasons (default of 5).
        // Task #1996 — admin can bump the count via the dialog input.
        const body: Record<string, unknown> = { days: 7, memberType: testModifierMemberType, nearMissLimit: testModifierNearMissLimit };
        if (testModifierCourseId !== "") body.courseId = testModifierCourseId;
        // Task #1607 / #1994 — translate the three-way weather mode into
        // backend params:
        //   forecast → useForecast=true (no simulateWeather, so the backend
        //              uses Open-Meteo's per-day forecast)
        //   override → simulateWeather=<text>  (global condition wins)
        //   none     → simulateWeather=""      (no condition attached)
        if (testModifier.kind === "weather") {
          if (testModifierWeatherMode === "forecast") {
            body.useForecast = true;
          } else if (testModifierWeatherMode === "override") {
            body.simulateWeather = testModifierSimulateWeather;
          } else {
            body.simulateWeather = "";
          }
        }
        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/modifiers/${testModifier.id}/preview`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: ModifierTestResult = await res.json();
        if (controller.signal.aborted) return;
        setTestModifierResult(j);
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setTestModifierResult(null);
        setTestModifierError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        if (!controller.signal.aborted) setTestModifierLoading(false);
      }
    })();
    return () => controller.abort();
  }, [orgId, testModifier?.id, testModifier?.kind, testModifierMemberType, testModifierCourseId, testModifierWeatherMode, testModifierSimulateWeather, testModifierNearMissLimit]);

  const runReport = async () => {
    const qs = new URLSearchParams({ fromDate: reportFrom, toDate: reportTo });
    if (previewCourseId) qs.set("courseId", String(previewCourseId));
    const res = await fetch(`/api/organizations/${orgId}/tee-pricing/yield-report?${qs}`, { credentials: "include" });
    if (res.ok) setReport(await res.json());
  };

  const fillRate = useMemo(() => {
    if (!report?.summary?.seats_total) return 0;
    return report.summary.seats_booked / report.summary.seats_total;
  }, [report]);

  if (!user) return <div className="p-8">Loading…</div>;

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><TrendingUp className="h-6 w-6"/>Dynamic Pricing & Yield</h1>
          <p className="text-sm text-muted-foreground">Set tiered tee-time prices that adapt to demand, lead time and weather.</p>
        </div>
        {config && (
          <div className="flex items-center gap-3">
            <Label className="text-sm">Engine</Label>
            <Switch checked={config.enabled} onCheckedChange={(v) => saveConfig({ enabled: v })} data-testid="switch-engine"/>
            <Badge variant={config.enabled ? "default" : "secondary"}>{config.enabled ? "Active" : "Disabled"}</Badge>
          </div>
        )}
      </div>

      {config && (
        <Card>
          <CardHeader><CardTitle>Caps & Floors</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Floor (% of base)</Label>
              <Input type="number" step="0.05" value={config.priceFloorPct}
                onChange={(e) => setConfig({ ...config, priceFloorPct: e.target.value })}
                onBlur={() => saveConfig({ priceFloorPct: config.priceFloorPct })}/>
            </div>
            <div>
              <Label>Ceiling (% of base)</Label>
              <Input type="number" step="0.05" value={config.priceCeilingPct}
                onChange={(e) => setConfig({ ...config, priceCeilingPct: e.target.value })}
                onBlur={() => saveConfig({ priceCeilingPct: config.priceCeilingPct })}/>
            </div>
            <div>
              <Label>Deal-badge threshold (% of base)</Label>
              <Input type="number" step="0.05" value={config.dealBadgeThresholdPct}
                onChange={(e) => setConfig({ ...config, dealBadgeThresholdPct: e.target.value })}
                onBlur={() => saveConfig({ dealBadgeThresholdPct: config.dealBadgeThresholdPct })}/>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); if (v === "accuracy") setAccuracyTabSeen(true); }}>
        <TabsList>
          <TabsTrigger value="tiers">Pricing Tiers</TabsTrigger>
          <TabsTrigger value="modifiers">Demand Modifiers</TabsTrigger>
          <TabsTrigger value="rules" data-testid="tab-rules">Rules</TabsTrigger>
          <TabsTrigger value="preview">Preview Calendar</TabsTrigger>
          <TabsTrigger value="forecast" data-testid="tab-forecast">Forecast Impact</TabsTrigger>
          <TabsTrigger value="accuracy" data-testid="tab-accuracy">Forecast Accuracy</TabsTrigger>
          <TabsTrigger value="report">Yield Report</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="tiers" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setEditTier({ daysOfWeek: [0,1,2,3,4,5,6], memberType: "any", priority: 0, isActive: true, memberRate: "0", guestRate: "0" } as Partial<Tier>)} data-testid="btn-add-tier">
              <Plus className="h-4 w-4 mr-1"/>Add Tier
            </Button>
          </div>
          <div className="grid gap-3">
            {tiers.length === 0 && <Card><CardContent className="py-8 text-center text-muted-foreground">No tiers yet. Create one to begin.</CardContent></Card>}
            {tiers.map(t => {
              const snap = publishSnapshots[String(t.id)];
              return (
              <Card key={t.id} data-testid={`tier-${t.id}`}>
                <CardContent className="py-4 flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <Badge variant={t.isActive ? "default" : "secondary"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                      <Badge variant="outline">priority {t.priority}</Badge>
                      {t.memberType !== "any" && <Badge variant="outline">{t.memberType}</Badge>}
                      {snap && (
                        <button
                          type="button"
                          onClick={() => {
                            // Task #1258 — pre-filter the accuracy view so
                            // it lands directly on the publish snapshot the
                            // admin just clicked, scoped to the tier's
                            // course (if pinned) so neighbouring courses
                            // don't drown out the row.
                            setAccuracyLabel(`publish:tier-${t.id}`);
                            setAccuracyCourseId(t.courseId ?? "");
                            setAccuracyScenario("active");
                            setAccuracyIncludePending(true);
                            setHighlightForecastId(null);
                            setActiveTab("accuracy");
                            setAccuracyTabSeen(true);
                          }}
                          className="inline-flex"
                          data-testid={`tier-${t.id}-publish-snapshot`}
                          title={`Snapshot taken ${new Date(snap.createdAt).toLocaleString()} for window ${snap.windowStart} → ${snap.windowEnd}. Click to open Forecast Accuracy filtered to this tier.`}
                        >
                          <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                            Last projection: ₹{Math.round(snap.projectedRevenue).toLocaleString()} over {snap.horizonDays} days
                          </Badge>
                        </button>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {t.daysOfWeek.map(d => DOW_LABELS[d]).join(",")}{" "}
                      {t.startTime || t.endTime ? ` · ${t.startTime ?? ""}–${t.endTime ?? ""}` : ""}
                      {t.seasonStart || t.seasonEnd ? ` · season ${t.seasonStart ?? "*"}→${t.seasonEnd ?? "*"}` : ""}
                      {" · "}member ₹{t.memberRate} / guest ₹{t.guestRate}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => toggleTier(t)} title={t.isActive ? "Deactivate (rollback)" : "Activate"}>
                      {t.isActive ? <RotateCcw className="h-4 w-4"/> : <Power className="h-4 w-4"/>}
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      data-testid={`btn-test-tier-${t.id}`}
                      title="Preview which upcoming slots would resolve to this tier"
                      onClick={() => {
                        setTestTier(t);
                        setTestTierResult(null);
                        setTestTierError(null);
                        setTestTierMemberType(t.memberType === "guest" ? "guest" : "member");
                        setTestTierCourseId(t.courseId ?? "");
                        // Task #1996 — reset to the default count each time
                        // the dialog reopens so an earlier debug session
                        // doesn't bleed into the next tier.
                        setTestTierNearMissLimit(5);
                      }}
                    ><FlaskConical className="h-4 w-4"/></Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditTier(t)}><Pencil className="h-4 w-4"/></Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteTier(t.id)}><Trash2 className="h-4 w-4"/></Button>
                  </div>
                </CardContent>
              </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="modifiers" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setEditMod({ kind: "utilization", adjustmentType: "percent", adjustmentValue: "0", applyTo: "any", priority: 0, isActive: true } as Partial<Modifier>)} data-testid="btn-add-modifier">
              <Plus className="h-4 w-4 mr-1"/>Add Modifier
            </Button>
          </div>
          <div className="grid gap-3">
            {modifiers.length === 0 && <Card><CardContent className="py-8 text-center text-muted-foreground">No demand modifiers yet.</CardContent></Card>}
            {modifiers.map(m => {
              const snap = modifierPublishSnapshots[String(m.id)];
              return (
              <Card key={m.id} data-testid={`modifier-${m.id}`}>
                <CardContent className="py-4 flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.name}</span>
                      <Badge>{m.kind}</Badge>
                      <Badge variant={m.isActive ? "default" : "secondary"}>{m.isActive ? "Active" : "Inactive"}</Badge>
                      {snap && (
                        <button
                          type="button"
                          onClick={() => {
                            // Task #1258 — same flow as the tier badge:
                            // pre-filter the accuracy view to this
                            // modifier's publish snapshot so the admin
                            // doesn't have to scroll for the row.
                            setAccuracyLabel(`publish:modifier-${m.id}`);
                            setAccuracyCourseId(m.courseId ?? "");
                            setAccuracyScenario("active");
                            setAccuracyIncludePending(true);
                            setHighlightForecastId(null);
                            setActiveTab("accuracy");
                            setAccuracyTabSeen(true);
                          }}
                          className="inline-flex"
                          data-testid={`modifier-${m.id}-publish-snapshot`}
                          title={`Snapshot taken ${new Date(snap.createdAt).toLocaleString()} for window ${snap.windowStart} → ${snap.windowEnd}. Click to open Forecast Accuracy filtered to this modifier.`}
                        >
                          <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                            Last projection: ₹{Math.round(snap.projectedRevenue).toLocaleString()} over {snap.horizonDays} days
                          </Badge>
                        </button>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {m.kind === "utilization" && `Utilisation ${m.thresholdMin ?? "*"}–${m.thresholdMax ?? "*"} `}
                      {m.kind === "lead_time" && `Lead-time ${m.thresholdMin ?? "*"}–${m.thresholdMax ?? "*"} hrs `}
                      {m.kind === "weather" && `Weather: ${m.weatherCondition ?? "any"} `}
                      → {parseFloat(m.adjustmentValue) > 0 ? "+" : ""}{m.adjustmentValue}{m.adjustmentType === "percent" ? "%" : " ₹"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost" size="sm"
                      data-testid={`btn-test-modifier-${m.id}`}
                      title="Preview which upcoming slots would include this modifier"
                      onClick={() => {
                        setTestModifier(m);
                        setTestModifierResult(null);
                        setTestModifierError(null);
                        setTestModifierMemberType(m.applyTo === "guest" ? "guest" : "member");
                        setTestModifierCourseId(m.courseId ?? "");
                        // Task #1607 — pre-fill the override with the
                        // modifier's own configured condition so flipping into
                        // "override" mode is immediately useful.
                        setTestModifierSimulateWeather(m.kind === "weather" ? (m.weatherCondition ?? "") : "");
                        // Task #1996 — reset to the default count each time
                        // the dialog reopens, sibling of the tier preview.
                        setTestModifierNearMissLimit(5);
                        // Task #1994 — default to forecast mode for weather
                        // modifiers so admins see the realistic outlook for
                        // the next 7 days without having to opt in.
                        setTestModifierWeatherMode("forecast");
                      }}
                    ><FlaskConical className="h-4 w-4"/></Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditMod(m)}><Pencil className="h-4 w-4"/></Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteMod(m.id)}><Trash2 className="h-4 w-4"/></Button>
                  </div>
                </CardContent>
              </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <div className="flex justify-end">
            <Button
              data-testid="btn-add-rule"
              onClick={() => setEditRule({ name: "", conditions: {}, priceDeltaPct: "0", priority: 0, active: true })}
            >
              <Plus className="h-4 w-4 mr-1"/>Add Rule
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Lightweight pricing rules. Each rule applies a flat % adjustment when its conditions match
            (day of week, time window, occupancy, lead time). Rules stack in priority order and the
            triggered rule appears in the booking confirmation breakdown.
          </p>
          <div className="grid gap-3">
            {rules.length === 0 && (
              <Card><CardContent className="py-8 text-center text-muted-foreground">
                No rules yet. Add one to apply simple price adjustments without configuring tiers.
              </CardContent></Card>
            )}
            {rules.map(r => {
              const c = r.conditions ?? {};
              const parts: string[] = [];
              if (c.dayOfWeek?.length) parts.push(c.dayOfWeek.map(d => DOW_LABELS[d]).join(","));
              if (c.timeRange) parts.push(`${c.timeRange[0]}–${c.timeRange[1]}`);
              if (c.occupancyMin != null) parts.push(`occupancy ≥${Math.round(c.occupancyMin * 100)}%`);
              if (c.leadTimeHoursMax != null) parts.push(`lead ≤${c.leadTimeHoursMax}h`);
              const delta = parseFloat(r.priceDeltaPct);
              return (
                <Card key={r.id} data-testid={`rule-${r.id}`}>
                  <CardContent className="py-4 flex items-center justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <Badge variant={r.active ? "default" : "secondary"}>{r.active ? "Active" : "Inactive"}</Badge>
                        <Badge variant="outline">priority {r.priority}</Badge>
                        <Badge>{delta > 0 ? "+" : ""}{delta}%</Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {parts.length ? parts.join(" · ") : "Always (no conditions)"}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost" size="sm"
                        data-testid={`btn-test-rule-${r.id}`}
                        title="Preview which upcoming slots would trigger this rule"
                        onClick={() => {
                          setTestRule(r);
                          setTestRuleResult(null);
                          setTestRuleError(null);
                          setTestRuleMemberType("member");
                          setTestRuleCourseId("");
                        }}
                      ><FlaskConical className="h-4 w-4"/></Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditRule(r)} data-testid={`btn-edit-rule-${r.id}`}><Pencil className="h-4 w-4"/></Button>
                      <Button variant="ghost" size="sm" data-testid={`btn-delete-rule-${r.id}`} onClick={async () => {
                        if (!confirm(`Delete rule "${r.name}"?`)) return;
                        const res = await fetch(`/api/organizations/${orgId}/tee-pricing/rules/${r.id}`, {
                          method: "DELETE", credentials: "include",
                        });
                        if (res.ok) { toast({ title: "Rule deleted" }); reload(); }
                        else toast({ title: "Delete failed", variant: "destructive" });
                      }}><Trash2 className="h-4 w-4"/></Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="preview" className="space-y-4">
          <Card>
            <CardContent className="py-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
              <div>
                <Label>Course</Label>
                <select className="w-full border rounded p-2" value={previewCourseId ?? ""} onChange={e => setPreviewCourseId(parseInt(e.target.value))}>
                  {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div><Label>From</Label><Input type="date" value={previewFrom} onChange={e => setPreviewFrom(e.target.value)}/></div>
              <div><Label>To</Label><Input type="date" value={previewTo} onChange={e => setPreviewTo(e.target.value)}/></div>
              <div>
                <Label>Member type</Label>
                <select className="w-full border rounded p-2" value={previewMemberType} onChange={e => setPreviewMemberType(e.target.value as "member"|"guest")}>
                  <option value="member">Member</option><option value="guest">Guest</option>
                </select>
              </div>
              <Button onClick={runPreview} data-testid="btn-run-preview">Preview</Button>
            </CardContent>
          </Card>
          {previewData.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border">
                <thead><tr className="bg-muted"><th className="p-2 text-left">Date</th>
                  {previewData[0].rows.map(r => <th key={r.time} className="p-2 text-center">{r.time}</th>)}
                </tr></thead>
                <tbody>
                  {previewData.map(d => (
                    <tr key={d.date} className="border-t">
                      <td className="p-2 font-medium">{d.date}</td>
                      {d.rows.map(r => {
                        const tooltip = r.breakdown && r.breakdown.length > 0
                          ? r.breakdown.map(s => `${s.label}: ₹${s.before.toFixed(0)} → ₹${s.after.toFixed(0)}`).join('\n')
                          : (r.tierName ?? "Base price");
                        return (
                          <td key={r.time} className={`p-2 text-center cursor-help ${r.isDeal ? "bg-green-50" : ""}`} title={tooltip}>
                            <div>₹{r.price}{r.dealBadge && <span className="ml-1 text-green-700 text-xs">{r.dealBadge}</span>}</div>
                            {r.basePrice != null && r.basePrice !== r.price && (
                              <div className="text-[10px] text-muted-foreground line-through">₹{r.basePrice}</div>
                            )}
                            {r.tierName && <div className="text-[10px] text-muted-foreground">{r.tierName}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="forecast" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><LineChart className="h-4 w-4"/>Draft vs. active forecast</CardTitle>
              <p className="text-xs text-muted-foreground">
                Project revenue, average price and utilisation over the next horizon, comparing the current
                live configuration against a draft change. Demand is estimated from the past 90 days of bookings.
              </p>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
              <div>
                <Label>Course (optional)</Label>
                <select className="w-full border rounded p-2" value={previewCourseId ?? ""} onChange={e => setPreviewCourseId(e.target.value ? parseInt(e.target.value) : null)}>
                  <option value="">All</option>
                  {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Horizon</Label>
                <select className="w-full border rounded p-2" value={forecastHorizon}
                  onChange={e => setForecastHorizon(Number(e.target.value) === 30 ? 30 : 14)} data-testid="select-forecast-horizon">
                  <option value={14}>Next 14 days</option>
                  <option value={30}>Next 30 days</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <Label>Draft change</Label>
                <select className="w-full border rounded p-2" value={String(forecastDraftTierId)}
                  onChange={e => setForecastDraftTierId(e.target.value === "" ? "" : (e.target.value === "all-active" ? "all-active" : Number(e.target.value)))}
                  data-testid="select-forecast-draft">
                  <option value="">— Pick a tier to flip —</option>
                  <option value="all-active">No change (sanity check)</option>
                  {tiers.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.isActive ? "Deactivate" : "Activate"}: {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label
                  title="Member price elasticity. Members are typically far less sensitive to price than walk-in guests; -0.2 means a 10% price rise reduces member bookings by ~2%."
                >
                  Member elasticity
                </Label>
                <select className="w-full border rounded p-2" value={String(forecastMemberElasticity)}
                  onChange={e => { setMemberElasticityTouched(true); setForecastMemberElasticity(Number(e.target.value)); }}
                  data-testid="select-forecast-member-elasticity">
                  <option value={0}>0 · demand fixed</option>
                  <option value={-0.1}>-0.1 · very low</option>
                  <option value={-0.2}>-0.2 · default (member)</option>
                  <option value={-0.3}>-0.3 · low</option>
                  <option value={-0.5}>-0.5 · moderate</option>
                  <option value={-0.8}>-0.8 · high</option>
                </select>
                {config && parseFloat(config.defaultMemberElasticity) !== forecastMemberElasticity && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-blue-600 hover:underline"
                    onClick={() => saveConfig({ defaultMemberElasticity: String(forecastMemberElasticity) })}
                    data-testid="btn-save-default-member-elasticity"
                  >
                    Save as club default
                  </button>
                )}
                {config && parseFloat(config.defaultMemberElasticity) === forecastMemberElasticity && (
                  <p className="mt-1 text-xs text-muted-foreground">Club default</p>
                )}
              </div>
              <div>
                <Label
                  title="Guest (walk-in) price elasticity. Guests are typically much more price-sensitive than members; -0.7 means a 10% price rise reduces guest bookings by ~7%."
                >
                  Guest elasticity
                </Label>
                <select className="w-full border rounded p-2" value={String(forecastGuestElasticity)}
                  onChange={e => { setGuestElasticityTouched(true); setForecastGuestElasticity(Number(e.target.value)); }}
                  data-testid="select-forecast-guest-elasticity">
                  <option value={0}>0 · demand fixed</option>
                  <option value={-0.3}>-0.3 · low</option>
                  <option value={-0.5}>-0.5 · moderate</option>
                  <option value={-0.7}>-0.7 · default (guest)</option>
                  <option value={-1}>-1.0 · unit</option>
                  <option value={-1.5}>-1.5 · high</option>
                </select>
                {config && parseFloat(config.defaultGuestElasticity) !== forecastGuestElasticity && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-blue-600 hover:underline"
                    onClick={() => saveConfig({ defaultGuestElasticity: String(forecastGuestElasticity) })}
                    data-testid="btn-save-default-guest-elasticity"
                  >
                    Save as club default
                  </button>
                )}
                {config && parseFloat(config.defaultGuestElasticity) === forecastGuestElasticity && (
                  <p className="mt-1 text-xs text-muted-foreground">Club default</p>
                )}
              </div>
              <Button onClick={runForecast} disabled={forecastLoading || forecastDraftTierId === ""} data-testid="btn-run-forecast">
                {forecastLoading ? "Simulating…" : "Forecast"}
              </Button>
            </CardContent>
          </Card>

          {forecast && (
            <>
              <Card>
                <CardHeader><CardTitle className="text-sm">Summary · next {forecast.horizonDays} days · {forecast.assumptions.slotsConsidered} slots</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Metric</th>
                          <th className="p-2">Active</th>
                          <th className="p-2">Draft</th>
                          <th className="p-2">Δ</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b" data-testid="row-revenue">
                          <td className="p-2 font-medium">Projected revenue</td>
                          <td className="p-2">₹{Math.round(forecast.active.revenue).toLocaleString()}</td>
                          <td className="p-2">₹{Math.round(forecast.draft.revenue).toLocaleString()}</td>
                          <td className={`p-2 font-semibold ${forecast.delta.revenue >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {forecast.delta.revenue >= 0 ? "+" : ""}₹{Math.round(forecast.delta.revenue).toLocaleString()}
                            {forecast.delta.revenuePct != null && (
                              <span className="ml-1 text-xs">({forecast.delta.revenuePct >= 0 ? "+" : ""}{forecast.delta.revenuePct.toFixed(1)}%)</span>
                            )}
                          </td>
                        </tr>
                        <tr className="border-b">
                          <td className="p-2 font-medium">Avg ₹/seat</td>
                          <td className="p-2">₹{forecast.active.avgPrice.toFixed(0)}</td>
                          <td className="p-2">₹{forecast.draft.avgPrice.toFixed(0)}</td>
                          <td className={`p-2 font-semibold ${forecast.delta.avgPrice >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {forecast.delta.avgPrice >= 0 ? "+" : ""}₹{forecast.delta.avgPrice.toFixed(0)}
                            {forecast.delta.avgPricePct != null && (
                              <span className="ml-1 text-xs">({forecast.delta.avgPricePct >= 0 ? "+" : ""}{forecast.delta.avgPricePct.toFixed(1)}%)</span>
                            )}
                          </td>
                        </tr>
                        <tr className="border-b" data-testid="row-utilization">
                          <td
                            className="p-2 font-medium"
                            title={
                              forecast.assumptions.memberElasticity === 0 && forecast.assumptions.guestElasticity === 0
                                ? "Demand response disabled (both elasticities = 0): draft utilisation matches active."
                                : `Draft utilisation is shifted from the active forecast per segment. Member elasticity ${forecast.assumptions.memberElasticity} (a 10% price change moves member bookings by ${(forecast.assumptions.memberElasticity * 10).toFixed(1)}%); guest elasticity ${forecast.assumptions.guestElasticity} (a 10% price change moves guest bookings by ${(forecast.assumptions.guestElasticity * 10).toFixed(1)}%).`
                            }
                          >
                            Projected utilisation
                          </td>
                          <td className="p-2">{(forecast.active.utilizationPct * 100).toFixed(1)}%</td>
                          <td className="p-2" data-testid="cell-draft-util">{(forecast.draft.utilizationPct * 100).toFixed(1)}%</td>
                          <td className={`p-2 font-semibold ${forecast.delta.utilizationPct >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {forecast.delta.utilizationPct >= 0 ? "+" : ""}{(forecast.delta.utilizationPct * 100).toFixed(1)} pp
                          </td>
                        </tr>
                        <tr>
                          <td className="p-2 font-medium">Estimated booked seats</td>
                          <td className="p-2">{forecast.active.seatsBooked.toLocaleString()} / {forecast.active.seatsTotal.toLocaleString()}</td>
                          <td className="p-2" data-testid="cell-draft-seats">{Math.round(forecast.draft.seatsBooked).toLocaleString()} / {forecast.draft.seatsTotal.toLocaleString()}</td>
                          <td className={`p-2 ${forecast.draft.seatsBooked - forecast.active.seatsBooked >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {forecast.draft.seatsBooked - forecast.active.seatsBooked >= 0 ? "+" : ""}{Math.round(forecast.draft.seatsBooked - forecast.active.seatsBooked).toLocaleString()}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Member share assumed: {(forecast.assumptions.memberShare * 100).toFixed(0)}%
                    · fallback utilisation: {(forecast.assumptions.fallbackUtilization * 100).toFixed(0)}%
                    · history window: last {forecast.assumptions.historicalSampleDays} days
                    · member elasticity: {forecast.assumptions.memberElasticity}
                    {forecast.assumptions.memberElasticity !== 0 && (
                      <> (a 10% price change shifts member bookings by {(forecast.assumptions.memberElasticity * 10).toFixed(1)}%)</>
                    )}
                    · guest elasticity: {forecast.assumptions.guestElasticity}
                    {forecast.assumptions.guestElasticity !== 0 && (
                      <> (a 10% price change shifts guest bookings by {(forecast.assumptions.guestElasticity * 10).toFixed(1)}%)</>
                    )}.
                    {" "}Members are typically far less price-sensitive than walk-in guests, so the two coefficients are applied per segment.
                  </p>
                </CardContent>
              </Card>

              {forecast.daily.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Daily breakdown</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Day</th>
                          <th className="p-2">Active ₹</th>
                          <th className="p-2">Draft ₹</th>
                          <th className="p-2">Δ</th>
                          <th className="p-2">Active avg</th>
                          <th className="p-2">Draft avg</th>
                          <th className="p-2">Active seats</th>
                          <th className="p-2">Draft seats</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecast.daily.map(d => {
                          const delta = d.draftRevenue - d.activeRevenue;
                          return (
                            <tr key={d.date} className="border-b">
                              <td className="p-2">{d.date}</td>
                              <td className="p-2">₹{Math.round(d.activeRevenue).toLocaleString()}</td>
                              <td className="p-2">₹{Math.round(d.draftRevenue).toLocaleString()}</td>
                              <td className={`p-2 ${delta >= 0 ? "text-green-600" : "text-red-600"}`}>
                                {delta >= 0 ? "+" : ""}₹{Math.round(delta).toLocaleString()}
                              </td>
                              <td className="p-2">₹{d.activeAvgPrice.toFixed(0)}</td>
                              <td className="p-2">₹{d.draftAvgPrice.toFixed(0)}</td>
                              <td className="p-2 text-muted-foreground">{d.activeSeatsBooked} / {d.seatsTotal}</td>
                              <td className="p-2 text-muted-foreground">{Math.round(d.draftSeatsBooked)} / {d.seatsTotal}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="accuracy" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Target className="h-5 w-5"/>Forecast Accuracy</CardTitle>
              <p className="text-sm text-muted-foreground">Compare past forecasts against realised revenue. Each forecast is auto-recorded when its window is published.</p>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
              <div>
                <Label>Course</Label>
                <select
                  className="w-full border rounded p-2"
                  value={accuracyCourseId === "" ? "" : String(accuracyCourseId)}
                  onChange={e => setAccuracyCourseId(e.target.value === "" ? "" : parseInt(e.target.value))}
                  data-testid="select-accuracy-course"
                >
                  <option value="">All courses</option>
                  {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Scenario</Label>
                <select
                  className="w-full border rounded p-2"
                  value={accuracyScenario}
                  onChange={e => setAccuracyScenario(e.target.value as "" | "active" | "draft")}
                  data-testid="select-accuracy-scenario"
                >
                  <option value="">All scenarios</option>
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  checked={accuracyIncludePending}
                  onCheckedChange={setAccuracyIncludePending}
                  data-testid="switch-accuracy-pending"
                />
                <Label className="text-sm">Include pending windows</Label>
              </div>
              <div className="md:col-span-2 flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={downloadAccuracyCsv}
                  disabled={accuracyLoading || accuracyRows.length === 0}
                  data-testid="btn-download-accuracy-csv"
                >
                  Download CSV
                </Button>
                <Button onClick={runAccuracy} disabled={accuracyLoading} data-testid="btn-run-accuracy">
                  {accuracyLoading ? "Loading…" : "Refresh"}
                </Button>
              </div>
              {accuracyLabel && (
                <div className="md:col-span-5 flex items-center gap-2" data-testid="accuracy-label-chip">
                  <span className="text-xs text-muted-foreground">Filtered to publish snapshot:</span>
                  <Badge variant="secondary" className="font-mono text-xs">{accuracyLabel}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAccuracyLabel("")}
                    data-testid="btn-clear-accuracy-label"
                  >
                    Clear
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {accuracyError && (
            <Card><CardContent className="py-4 text-sm text-red-600" data-testid="accuracy-error">Couldn't load accuracy: {accuracyError}</CardContent></Card>
          )}

          {accuracySummary && (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3" data-testid="accuracy-summary">
              <Card><CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Sample size</div>
                <div className="text-2xl font-bold" data-testid="accuracy-sample">{accuracySummary.sampleSize}</div>
                <div className="text-[10px] text-muted-foreground">completed forecasts</div>
              </CardContent></Card>
              <Card><CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Avg accuracy</div>
                <div className="text-2xl font-bold" data-testid="accuracy-avg">{accuracySummary.avgAccuracyPct.toFixed(1)}%</div>
                <div className="text-[10px] text-muted-foreground">avg abs error {accuracySummary.avgAbsoluteErrorPct.toFixed(1)}%</div>
              </CardContent></Card>
              <Card><CardContent className="py-4">
                <div className="text-xs text-muted-foreground">High accuracy</div>
                <div className="text-2xl font-bold text-green-600" data-testid="accuracy-bucket-high">{accuracySummary.bucketCounts.high}</div>
                <div className="text-[10px] text-muted-foreground">≥ 85% accurate</div>
              </CardContent></Card>
              <Card><CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Medium accuracy</div>
                <div className="text-2xl font-bold text-amber-600" data-testid="accuracy-bucket-medium">{accuracySummary.bucketCounts.medium}</div>
                <div className="text-[10px] text-muted-foreground">70–84% accurate</div>
              </CardContent></Card>
              <Card><CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Low accuracy</div>
                <div className="text-2xl font-bold text-red-600" data-testid="accuracy-bucket-low">{accuracySummary.bucketCounts.low}</div>
                <div className="text-[10px] text-muted-foreground">&lt; 70% accurate</div>
              </CardContent></Card>
            </div>
          )}

          <Card>
            <CardHeader><CardTitle>Past forecasts</CardTitle></CardHeader>
            <CardContent>
              {accuracyRows.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground" data-testid="accuracy-empty">
                  {accuracyLoading ? "Loading forecasts…" : "No forecasts recorded yet for the selected filters."}
                </div>
              ) : (
                <table className="w-full text-sm" data-testid="accuracy-table">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Window</th>
                      <th>Scenario</th>
                      <th>Label</th>
                      <th className="text-right">Projected ₹</th>
                      <th className="text-right">Actual ₹</th>
                      <th className="text-right">Error %</th>
                      <th className="text-right">Accuracy</th>
                      <th>Bucket</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accuracyRows.map(r => {
                      const bucketColor =
                        r.accuracyBucket === "high" ? "bg-green-100 text-green-800" :
                        r.accuracyBucket === "medium" ? "bg-amber-100 text-amber-800" :
                        r.accuracyBucket === "low" ? "bg-red-100 text-red-800" :
                        "bg-muted text-muted-foreground";
                      const isHighlighted = highlightForecastId === r.forecastId;
                      return (
                        <tr
                          key={r.forecastId}
                          ref={isHighlighted ? highlightedRowRef : undefined}
                          className={`border-b cursor-pointer hover:bg-muted/40 ${isHighlighted ? "bg-amber-50 ring-2 ring-amber-400" : ""}`}
                          data-testid={`accuracy-row-${r.forecastId}`}
                          data-highlighted={isHighlighted ? "true" : undefined}
                          onClick={() => setDrillRow(r)}
                        >
                          <td className="p-2">{r.windowStart} → {r.windowEnd}</td>
                          <td><Badge variant="outline">{r.scenario}</Badge></td>
                          <td className="text-muted-foreground">{r.label ?? "—"}</td>
                          <td className="text-right">₹{Math.round(r.projectedRevenue).toLocaleString()}</td>
                          <td className="text-right">{r.status === "pending" ? <span className="text-muted-foreground">pending</span> : `₹${Math.round(r.actualRevenue).toLocaleString()}`}</td>
                          <td className={`text-right ${r.revenueErrorPct == null ? "text-muted-foreground" : (r.revenueErrorPct ?? 0) >= 0 ? "text-red-600" : "text-green-600"}`}>
                            {r.revenueErrorPct == null ? "—" : `${r.revenueErrorPct >= 0 ? "+" : ""}${r.revenueErrorPct.toFixed(1)}%`}
                          </td>
                          <td className="text-right font-medium">{r.accuracyPct == null ? "—" : `${r.accuracyPct.toFixed(1)}%`}</td>
                          <td>
                            {r.accuracyBucket
                              ? <span className={`inline-block rounded px-2 py-0.5 text-xs ${bucketColor}`}>{r.accuracyBucket}</span>
                              : <span className="text-muted-foreground text-xs">{r.status}</span>}
                          </td>
                          <td className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`btn-drill-accuracy-${r.forecastId}`}
                              onClick={(e) => { e.stopPropagation(); setDrillRow(r); }}
                            >
                              View
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <ForecastAccuracyEmailSchedulePanel orgId={orgId ?? 0} />
        </TabsContent>

        <TabsContent value="report" className="space-y-4">
          <Card>
            <CardContent className="py-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div><Label>From</Label><Input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)}/></div>
              <div><Label>To</Label><Input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)}/></div>
              <div>
                <Label>Course (optional)</Label>
                <select className="w-full border rounded p-2" value={previewCourseId ?? ""} onChange={e => setPreviewCourseId(parseInt(e.target.value))}>
                  <option value="">All</option>
                  {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <Button onClick={runReport} data-testid="btn-run-report">Generate</Button>
            </CardContent>
          </Card>
          {report?.summary && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Revenue</div><div className="text-2xl font-bold">₹{(report.summary.revenue ?? 0).toLocaleString()}</div></CardContent></Card>
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Bookings</div><div className="text-2xl font-bold">{report.summary.bookings ?? 0}</div></CardContent></Card>
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Fill rate</div><div className="text-2xl font-bold">{(fillRate * 100).toFixed(1)}%</div></CardContent></Card>
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Avg ₹/seat</div><div className="text-2xl font-bold">₹{(report.summary.avg_price_per_seat ?? 0).toFixed(0)}</div></CardContent></Card>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Baseline revenue (no dynamic pricing)</div><div className="text-xl font-semibold">₹{(report.summary.baseline_revenue ?? 0).toLocaleString()}</div></CardContent></Card>
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Uplift vs baseline</div><div className={`text-xl font-semibold ${(report.summary.uplift_revenue ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{(report.summary.uplift_revenue ?? 0) >= 0 ? '+' : ''}₹{(report.summary.uplift_revenue ?? 0).toLocaleString()}</div></CardContent></Card>
                <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">Uplift %</div><div className={`text-xl font-semibold ${(report.summary.uplift_pct ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{report.summary.uplift_pct == null ? '—' : `${(report.summary.uplift_pct ?? 0) >= 0 ? '+' : ''}${(report.summary.uplift_pct ?? 0).toFixed(1)}%`}</div></CardContent></Card>
              </div>
            </>
          )}
          {report?.daily && report.daily.length > 0 && (
            <Card><CardHeader><CardTitle>Daily breakdown</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left"><th className="p-2">Day</th><th>Slots</th><th>Seats</th><th>Revenue</th><th>Avg ₹/seat</th></tr></thead>
                  <tbody>
                    {report.daily.map(d => (
                      <tr key={d.day} className="border-b"><td className="p-2">{d.day}</td>
                        <td>{d.slots_total}</td>
                        <td>{d.seats_booked} / {d.seats_total}</td>
                        <td>₹{(d.revenue ?? 0).toLocaleString()}</td>
                        <td>₹{(d.avg_price_per_seat ?? 0).toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
          {report?.byTier && report.byTier.length > 0 && (
            <Card><CardHeader><CardTitle>Performance by tier</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left"><th className="p-2">Tier</th><th>Bookings</th><th>Revenue</th></tr></thead>
                  <tbody>
                    {report.byTier.map(t => (
                      <tr key={t.id} className="border-b"><td className="p-2">{t.name}</td><td>{t.bookings}</td><td>₹{(t.revenue ?? 0).toLocaleString()}</td></tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="audit">
          <Card><CardContent className="py-4">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left"><th className="p-2">When</th><th>Action</th><th>Entity</th><th>Notes</th></tr></thead>
              <tbody>
                {audit.map(a => (
                  <tr key={a.id} className="border-b"><td className="p-2">{new Date(a.createdAt).toLocaleString()}</td>
                    <td><Badge variant="outline">{a.action}</Badge></td>
                    <td>{a.entityType}{a.entityId ? `#${a.entityId}` : ""}</td>
                    <td className="text-muted-foreground">{a.notes ?? ""}</td>
                  </tr>
                ))}
                {audit.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No activity yet.</td></tr>}
              </tbody>
            </table>
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      {/* Tier editor dialog */}
      <Dialog open={!!editTier} onOpenChange={(o) => !o && setEditTier(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{editTier?.id ? "Edit" : "New"} pricing tier</DialogTitle></DialogHeader>
          {editTier && (
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={editTier.name ?? ""} onChange={e => setEditTier({ ...editTier, name: e.target.value })} data-testid="input-tier-name"/></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Course</Label>
                  <select className="w-full border rounded p-2" value={editTier.courseId ?? ""} onChange={e => setEditTier({ ...editTier, courseId: e.target.value ? parseInt(e.target.value) : null })}>
                    <option value="">All courses</option>
                    {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div><Label>Member type</Label>
                  <select className="w-full border rounded p-2" value={editTier.memberType ?? "any"} onChange={e => setEditTier({ ...editTier, memberType: e.target.value as "any"|"member"|"guest" })}>
                    <option value="any">Any</option><option value="member">Member only</option><option value="guest">Guest only</option>
                  </select>
                </div>
              </div>
              <div>
                <Label>Days of week</Label>
                <div className="flex gap-1 flex-wrap">
                  {DOW_LABELS.map((d, i) => {
                    const sel = (editTier.daysOfWeek ?? []).includes(i);
                    return <Button key={i} type="button" variant={sel ? "default" : "outline"} size="sm" onClick={() => {
                      const arr = new Set(editTier.daysOfWeek ?? []);
                      if (sel) arr.delete(i); else arr.add(i);
                      setEditTier({ ...editTier, daysOfWeek: Array.from(arr).sort() });
                    }}>{d}</Button>;
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Start time</Label><Input type="time" value={editTier.startTime ?? ""} onChange={e => setEditTier({ ...editTier, startTime: e.target.value || null })}/></div>
                <div><Label>End time</Label><Input type="time" value={editTier.endTime ?? ""} onChange={e => setEditTier({ ...editTier, endTime: e.target.value || null })}/></div>
                <div><Label>Season start (MM-DD)</Label><Input placeholder="04-01" value={editTier.seasonStart ?? ""} onChange={e => setEditTier({ ...editTier, seasonStart: e.target.value || null })}/></div>
                <div><Label>Season end (MM-DD)</Label><Input placeholder="09-30" value={editTier.seasonEnd ?? ""} onChange={e => setEditTier({ ...editTier, seasonEnd: e.target.value || null })}/></div>
                <div><Label>Member rate ₹</Label><Input type="number" step="0.01" value={editTier.memberRate ?? "0"} onChange={e => setEditTier({ ...editTier, memberRate: e.target.value })}/></div>
                <div><Label>Guest rate ₹</Label><Input type="number" step="0.01" value={editTier.guestRate ?? "0"} onChange={e => setEditTier({ ...editTier, guestRate: e.target.value })}/></div>
                <div><Label>Priority</Label><Input type="number" value={editTier.priority ?? 0} onChange={e => setEditTier({ ...editTier, priority: parseInt(e.target.value) || 0 })}/></div>
                <div className="flex items-center gap-2 pt-6"><Switch checked={editTier.isActive ?? true} onCheckedChange={v => setEditTier({ ...editTier, isActive: v })}/><Label>Active</Label></div>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid="inline-forecast">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LineChart className="h-4 w-4"/>
                    What-if forecast · next 14 days
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {inlineForecastLoading ? "Updating…" : (inlineForecast ? `${inlineForecast.assumptions.slotsConsidered} slots` : "")}
                  </span>
                </div>
                {inlineForecastError && (
                  <p className="text-xs text-red-600">Couldn't compute forecast: {inlineForecastError}</p>
                )}
                {inlineForecast && (
                  <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
                    <div className="text-xs text-muted-foreground">
                      Looks good? Commit this draft as the live tier without scrolling.
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={applyDraftFromForecast}
                        disabled={inlineForecastLoading || applyActivateBusy}
                        data-testid="btn-apply-draft"
                        title={`Apply draft · projected revenue ${inlineForecast.delta.revenue >= 0 ? "+" : ""}₹${Math.round(inlineForecast.delta.revenue).toLocaleString()}${inlineForecast.delta.revenuePct != null ? ` (${inlineForecast.delta.revenuePct >= 0 ? "+" : ""}${inlineForecast.delta.revenuePct.toFixed(1)}%)` : ""}`}
                      >
                        Apply this draft
                      </Button>
                      {editTier?.isActive === false && (
                        <Button
                          size="sm"
                          variant="default"
                          onClick={applyAndActivateDraft}
                          disabled={inlineForecastLoading || applyActivateBusy}
                          data-testid="btn-apply-activate-draft"
                          title="Save the draft and immediately activate it"
                        >
                          <Power className="h-4 w-4 mr-1"/>{applyActivateBusy ? "Activating…" : "Apply & activate"}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {inlineForecast ? (
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Revenue Δ</div>
                      <div className={`font-semibold ${inlineForecast.delta.revenue >= 0 ? "text-green-600" : "text-red-600"}`} data-testid="inline-forecast-revenue">
                        {inlineForecast.delta.revenue >= 0 ? "+" : ""}₹{Math.round(inlineForecast.delta.revenue).toLocaleString()}
                        {inlineForecast.delta.revenuePct != null && (
                          <span className="ml-1 text-xs">({inlineForecast.delta.revenuePct >= 0 ? "+" : ""}{inlineForecast.delta.revenuePct.toFixed(1)}%)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        ₹{Math.round(inlineForecast.active.revenue).toLocaleString()} → ₹{Math.round(inlineForecast.draft.revenue).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Avg ₹/seat Δ</div>
                      <div className={`font-semibold ${inlineForecast.delta.avgPrice >= 0 ? "text-green-600" : "text-red-600"}`} data-testid="inline-forecast-avgprice">
                        {inlineForecast.delta.avgPrice >= 0 ? "+" : ""}₹{inlineForecast.delta.avgPrice.toFixed(0)}
                        {inlineForecast.delta.avgPricePct != null && (
                          <span className="ml-1 text-xs">({inlineForecast.delta.avgPricePct >= 0 ? "+" : ""}{inlineForecast.delta.avgPricePct.toFixed(1)}%)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        ₹{inlineForecast.active.avgPrice.toFixed(0)} → ₹{inlineForecast.draft.avgPrice.toFixed(0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Utilisation</div>
                      <div className="font-semibold" data-testid="inline-forecast-utilisation">
                        {(inlineForecast.draft.utilizationPct * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        modelled from last {inlineForecast.assumptions.historicalSampleDays}d
                      </div>
                    </div>
                  </div>
                ) : (
                  !inlineForecastError && (
                    <p className="text-xs text-muted-foreground">
                      {inlineForecastLoading ? "Simulating draft impact…" : "Edit any field to preview revenue, avg price and utilisation impact."}
                    </p>
                  )
                )}
              </div>
            </div>
          )}
          <DialogFooter><Button variant="ghost" onClick={() => setEditTier(null)}>Cancel</Button><Button onClick={() => saveTier()} data-testid="btn-save-tier">Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modifier editor dialog */}
      <Dialog open={!!editMod} onOpenChange={(o) => !o && setEditMod(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editMod?.id ? "Edit" : "New"} demand modifier</DialogTitle></DialogHeader>
          {editMod && (
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={editMod.name ?? ""} onChange={e => setEditMod({ ...editMod, name: e.target.value })} data-testid="input-mod-name"/></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Kind</Label>
                  <select className="w-full border rounded p-2" value={editMod.kind ?? "utilization"} onChange={e => setEditMod({ ...editMod, kind: e.target.value as Modifier["kind"] })}>
                    <option value="utilization">Utilization</option>
                    <option value="lead_time">Lead time (hours)</option>
                    <option value="weather">Weather</option>
                  </select>
                </div>
                <div><Label>Apply to</Label>
                  <select className="w-full border rounded p-2" value={editMod.applyTo ?? "any"} onChange={e => setEditMod({ ...editMod, applyTo: e.target.value as Modifier["applyTo"] })}>
                    <option value="any">All seats</option><option value="member">Member only</option><option value="guest">Guest only</option>
                  </select>
                </div>
              </div>
              {editMod.kind === "weather"
                ? <div><Label>Weather condition</Label><Input placeholder="rain, clear, storm…" value={editMod.weatherCondition ?? ""} onChange={e => setEditMod({ ...editMod, weatherCondition: e.target.value })}/></div>
                : (
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label>Threshold min{editMod.kind === "utilization" ? " (0–1)" : " (hrs)"}</Label><Input type="number" step="0.01" value={editMod.thresholdMin ?? ""} onChange={e => setEditMod({ ...editMod, thresholdMin: e.target.value })}/></div>
                    <div><Label>Threshold max</Label><Input type="number" step="0.01" value={editMod.thresholdMax ?? ""} onChange={e => setEditMod({ ...editMod, thresholdMax: e.target.value })}/></div>
                  </div>
                )}
              <div className="grid grid-cols-3 gap-3">
                <div><Label>Adjustment type</Label>
                  <select className="w-full border rounded p-2" value={editMod.adjustmentType ?? "percent"} onChange={e => setEditMod({ ...editMod, adjustmentType: e.target.value as "percent"|"flat" })}>
                    <option value="percent">% of price</option><option value="flat">Flat ₹</option>
                  </select>
                </div>
                <div><Label>Value</Label><Input type="number" step="0.01" value={editMod.adjustmentValue ?? "0"} onChange={e => setEditMod({ ...editMod, adjustmentValue: e.target.value })}/></div>
                <div><Label>Priority</Label><Input type="number" value={editMod.priority ?? 0} onChange={e => setEditMod({ ...editMod, priority: parseInt(e.target.value) || 0 })}/></div>
              </div>
              <div className="flex items-center gap-2"><Switch checked={editMod.isActive ?? true} onCheckedChange={v => setEditMod({ ...editMod, isActive: v })}/><Label>Active</Label></div>
              <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid="inline-mod-forecast">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LineChart className="h-4 w-4"/>
                    What-if forecast · next 14 days
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {inlineModForecastLoading ? "Updating…" : (inlineModForecast ? `${inlineModForecast.assumptions.slotsConsidered} slots` : "")}
                  </span>
                </div>
                {inlineModForecastError && (
                  <p className="text-xs text-red-600">Couldn't compute forecast: {inlineModForecastError}</p>
                )}
                {inlineModForecast ? (
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Revenue Δ</div>
                      <div className={`font-semibold ${inlineModForecast.delta.revenue >= 0 ? "text-green-600" : "text-red-600"}`} data-testid="inline-mod-forecast-revenue">
                        {inlineModForecast.delta.revenue >= 0 ? "+" : ""}₹{Math.round(inlineModForecast.delta.revenue).toLocaleString()}
                        {inlineModForecast.delta.revenuePct != null && (
                          <span className="ml-1 text-xs">({inlineModForecast.delta.revenuePct >= 0 ? "+" : ""}{inlineModForecast.delta.revenuePct.toFixed(1)}%)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        ₹{Math.round(inlineModForecast.active.revenue).toLocaleString()} → ₹{Math.round(inlineModForecast.draft.revenue).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Avg ₹/seat Δ</div>
                      <div className={`font-semibold ${inlineModForecast.delta.avgPrice >= 0 ? "text-green-600" : "text-red-600"}`} data-testid="inline-mod-forecast-avgprice">
                        {inlineModForecast.delta.avgPrice >= 0 ? "+" : ""}₹{inlineModForecast.delta.avgPrice.toFixed(0)}
                        {inlineModForecast.delta.avgPricePct != null && (
                          <span className="ml-1 text-xs">({inlineModForecast.delta.avgPricePct >= 0 ? "+" : ""}{inlineModForecast.delta.avgPricePct.toFixed(1)}%)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        ₹{inlineModForecast.active.avgPrice.toFixed(0)} → ₹{inlineModForecast.draft.avgPrice.toFixed(0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Utilisation</div>
                      <div className="font-semibold" data-testid="inline-mod-forecast-utilisation">
                        {(inlineModForecast.draft.utilizationPct * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        modelled from last {inlineModForecast.assumptions.historicalSampleDays}d
                      </div>
                    </div>
                  </div>
                ) : (
                  !inlineModForecastError && (
                    <p className="text-xs text-muted-foreground">
                      {inlineModForecastLoading ? "Simulating draft impact…" : "Edit any field to preview revenue, avg price and utilisation impact."}
                    </p>
                  )
                )}
              </div>
            </div>
          )}
          <DialogFooter><Button variant="ghost" onClick={() => setEditMod(null)}>Cancel</Button><Button onClick={saveMod} data-testid="btn-save-mod">Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rule editor dialog (Task #1004) */}
      <Dialog open={!!editRule} onOpenChange={(o) => !o && setEditRule(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editRule?.id ? "Edit" : "New"} pricing rule</DialogTitle></DialogHeader>
          {editRule && (
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input
                  data-testid="input-rule-name"
                  value={editRule.name ?? ""}
                  onChange={e => setEditRule({ ...editRule, name: e.target.value })}
                  placeholder="e.g. Weekend mornings"
                />
              </div>
              <div>
                <Label>Days of week</Label>
                <div className="flex gap-1 flex-wrap">
                  {DOW_LABELS.map((lbl, idx) => {
                    const selected = editRule.conditions?.dayOfWeek?.includes(idx) ?? false;
                    return (
                      <Button
                        key={idx} type="button" size="sm"
                        variant={selected ? "default" : "outline"}
                        data-testid={`rule-dow-${idx}`}
                        onClick={() => {
                          const cur = editRule.conditions?.dayOfWeek ?? [];
                          const next = selected ? cur.filter(d => d !== idx) : [...cur, idx].sort();
                          setEditRule({ ...editRule, conditions: { ...(editRule.conditions ?? {}), dayOfWeek: next.length ? next : undefined } });
                        }}
                      >{lbl}</Button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start time</Label>
                  <Input
                    type="time"
                    value={editRule.conditions?.timeRange?.[0] ?? ""}
                    onChange={e => {
                      const start = e.target.value;
                      const end = editRule.conditions?.timeRange?.[1] ?? "";
                      const tr = (start && end) ? [start, end] as [string, string] : undefined;
                      setEditRule({ ...editRule, conditions: { ...(editRule.conditions ?? {}), timeRange: tr } });
                    }}
                  />
                </div>
                <div>
                  <Label>End time</Label>
                  <Input
                    type="time"
                    value={editRule.conditions?.timeRange?.[1] ?? ""}
                    onChange={e => {
                      const end = e.target.value;
                      const start = editRule.conditions?.timeRange?.[0] ?? "";
                      const tr = (start && end) ? [start, end] as [string, string] : undefined;
                      setEditRule({ ...editRule, conditions: { ...(editRule.conditions ?? {}), timeRange: tr } });
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Min occupancy (0–1)</Label>
                  <Input
                    type="number" step="0.05" min="0" max="1"
                    value={editRule.conditions?.occupancyMin ?? ""}
                    onChange={e => {
                      const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                      setEditRule({ ...editRule, conditions: { ...(editRule.conditions ?? {}), occupancyMin: v } });
                    }}
                  />
                </div>
                <div>
                  <Label>Max lead time (hrs)</Label>
                  <Input
                    type="number" step="1" min="0"
                    value={editRule.conditions?.leadTimeHoursMax ?? ""}
                    onChange={e => {
                      const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                      setEditRule({ ...editRule, conditions: { ...(editRule.conditions ?? {}), leadTimeHoursMax: v } });
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Price delta (%)</Label>
                  <Input
                    data-testid="input-rule-delta"
                    type="number" step="0.5"
                    value={editRule.priceDeltaPct ?? "0"}
                    onChange={e => setEditRule({ ...editRule, priceDeltaPct: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Priority</Label>
                  <Input
                    type="number"
                    value={editRule.priority ?? 0}
                    onChange={e => setEditRule({ ...editRule, priority: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={editRule.active ?? true} onCheckedChange={v => setEditRule({ ...editRule, active: v })}/>
                <Label>Active</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditRule(null)}>Cancel</Button>
            <Button data-testid="btn-save-rule" onClick={async () => {
              if (!editRule) return;
              if (!editRule.name?.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
              const url = editRule.id
                ? `/api/organizations/${orgId}/tee-pricing/rules/${editRule.id}`
                : `/api/organizations/${orgId}/tee-pricing/rules`;
              const res = await fetch(url, {
                method: editRule.id ? "PATCH" : "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: editRule.name,
                  conditions: editRule.conditions ?? {},
                  priceDeltaPct: editRule.priceDeltaPct ?? "0",
                  priority: editRule.priority ?? 0,
                  active: editRule.active ?? true,
                }),
              });
              if (res.ok) { setEditRule(null); reload(); toast({ title: "Rule saved" }); }
              else toast({ title: "Save failed", variant: "destructive" });
            }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rule preview / "Test rule" dialog (Task #1163) */}
      <Dialog open={!!testRule} onOpenChange={(o) => { if (!o) { setTestRule(null); setTestRuleResult(null); setTestRuleError(null); } }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-test-rule">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4"/>
              Test rule
              {testRule && <span className="text-sm text-muted-foreground font-normal">· {testRule.name}</span>}
            </DialogTitle>
          </DialogHeader>
          {testRule && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                These are the open tee slots in the next 7 days that would trigger this rule. The
                triggered rule line is highlighted in each slot's price breakdown so wrong-time-zone
                or off-by-one mistakes in the conditions become visible before customers see them.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <Label>Course</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testRuleCourseId === "" ? "" : String(testRuleCourseId)}
                    onChange={e => setTestRuleCourseId(e.target.value === "" ? "" : parseInt(e.target.value))}
                    data-testid="select-test-rule-course"
                  >
                    <option value="">All courses</option>
                    {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Member type</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testRuleMemberType}
                    onChange={e => setTestRuleMemberType(e.target.value === "guest" ? "guest" : "member")}
                    data-testid="select-test-rule-member-type"
                  >
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </select>
                </div>
                <div className="text-sm text-muted-foreground" data-testid="text-test-rule-summary">
                  {testRuleLoading ? "Evaluating slots…" : (
                    testRuleResult
                      ? `${testRuleResult.matchCount} of ${testRuleResult.slotsConsidered} slots trigger this rule.`
                      : "—"
                  )}
                </div>
              </div>
              {testRuleError && (
                <Card><CardContent className="py-3 text-sm text-red-600" data-testid="text-test-rule-error">{testRuleError}</CardContent></Card>
              )}
              {testRuleResult && testRuleResult.matchCount === 0 && !testRuleLoading && (
                <Card><CardContent className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-test-rule">
                  No upcoming slots in the next 7 days match this rule's conditions.
                  {testRuleResult.nearMisses.length > 0
                    ? " See the near-misses below for the closest slots and the single condition each one fell short of."
                    : " Double-check the day-of-week, time window, occupancy and lead-time settings."}
                </CardContent></Card>
              )}
              {/* Task #1344 — near-miss section. Shown whenever the API
                  returns near-miss slots, regardless of match count, so admins
                  can debug a rule that's matching far fewer slots than they
                  expected (not just the zero-match case). */}
              {testRuleResult && testRuleResult.nearMisses.length > 0 && (
                <div className="space-y-2" data-testid="section-test-rule-near-misses">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold">Near misses</h3>
                    <p className="text-xs text-muted-foreground">
                      Upcoming slots that failed exactly one condition — the most
                      likely culprits when the rule isn't firing where you expect.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border" data-testid="table-test-rule-near-misses">
                      <thead>
                        <tr className="bg-muted text-left">
                          <th className="p-2">Date</th>
                          <th className="p-2">Time</th>
                          <th className="p-2">Course</th>
                          <th className="p-2">Why it didn't match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testRuleResult.nearMisses.map(nm => {
                          const courseName = courses.find(c => c.id === nm.courseId)?.name ?? `#${nm.courseId}`;
                          const dowNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                          const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
                          const fmtLead = (n: number) => n < 48 ? `${n.toFixed(1)}h` : `${(n / 24).toFixed(1)}d`;
                          const reasonText = (f: RuleTestFailure): string => {
                            if (f.condition === "dayOfWeek") {
                              const expected = f.expected.map(d => dowNames[d] ?? String(d)).join(", ");
                              return `Wrong day of week — rule expects ${expected || "(none)"}, slot is ${dowNames[f.actual] ?? String(f.actual)}`;
                            }
                            if (f.condition === "timeRange") {
                              return `Outside time window — rule expects ${f.expected[0]}–${f.expected[1]}, slot is at ${f.actual}`;
                            }
                            if (f.condition === "occupancyMin") {
                              return `Occupancy too low — rule needs at least ${fmtPct(f.expected)}, slot is at ${fmtPct(f.actual)}`;
                            }
                            return `Lead time too long — rule needs ≤ ${fmtLead(f.expected)}, slot is ${fmtLead(f.actual)} away`;
                          };
                          return (
                            <tr key={nm.slotId} className="border-t align-top" data-testid={`row-test-near-miss-${nm.slotId}`}>
                              <td className="p-2 whitespace-nowrap">{nm.slotDate}</td>
                              <td className="p-2 whitespace-nowrap">{nm.slotTime}</td>
                              <td className="p-2 whitespace-nowrap">{courseName}</td>
                              <td className="p-2">
                                {nm.failures.map((f, i) => (
                                  <div
                                    key={i}
                                    data-testid={`near-miss-reason-${nm.slotId}`}
                                    data-condition={f.condition}
                                  >
                                    <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">{f.condition}:</span>
                                    {reasonText(f)}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {testRuleResult && testRuleResult.matchCount > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border" data-testid="table-test-rule-matches">
                    <thead>
                      <tr className="bg-muted text-left">
                        <th className="p-2">Date</th>
                        <th className="p-2">Time</th>
                        <th className="p-2">Course</th>
                        <th className="p-2 text-right">Occupancy</th>
                        <th className="p-2 text-right">Lead</th>
                        <th className="p-2 text-right">Base</th>
                        <th className="p-2 text-right">Final</th>
                        <th className="p-2 text-right">Δ from rule</th>
                        <th className="p-2">Breakdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testRuleResult.matches.map(m => {
                        const courseName = courses.find(c => c.id === m.courseId)?.name ?? `#${m.courseId}`;
                        return (
                          <tr key={`${m.slotId}`} className="border-t align-top" data-testid={`row-test-match-${m.slotId}`}>
                            <td className="p-2 whitespace-nowrap">{m.slotDate}</td>
                            <td className="p-2 whitespace-nowrap">{m.slotTime}</td>
                            <td className="p-2 whitespace-nowrap">{courseName}</td>
                            <td className="p-2 text-right">{(m.utilizationPct * 100).toFixed(0)}% <span className="text-muted-foreground text-xs">({m.bookedCount}/{m.capacity})</span></td>
                            <td className="p-2 text-right">{m.leadTimeHours < 48 ? `${m.leadTimeHours.toFixed(1)}h` : `${(m.leadTimeHours / 24).toFixed(1)}d`}</td>
                            <td className="p-2 text-right">₹{m.basePrice.toFixed(0)}</td>
                            <td className="p-2 text-right font-medium">₹{m.finalPrice.toFixed(0)}</td>
                            <td className={`p-2 text-right font-semibold ${m.priceDelta >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {m.priceDelta >= 0 ? "+" : ""}₹{m.priceDelta.toFixed(0)}
                            </td>
                            <td className="p-2">
                              <ol className="space-y-0.5 text-xs">
                                {m.breakdown.map((s, i) => {
                                  const isThisRule = i === m.ruleStepIndex;
                                  return (
                                    <li
                                      key={i}
                                      className={isThisRule ? "bg-yellow-100 border-l-2 border-yellow-500 px-1 rounded font-medium" : ""}
                                      data-testid={isThisRule ? `breakdown-rule-hit-${m.slotId}` : undefined}
                                    >
                                      <span className="text-muted-foreground">{s.label}:</span>{" "}
                                      ₹{s.before.toFixed(0)} → ₹{s.after.toFixed(0)}
                                    </li>
                                  );
                                })}
                              </ol>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setTestRule(null); setTestRuleResult(null); setTestRuleError(null); }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tier preview / "Test tier" dialog (Task #1345) */}
      <Dialog open={!!testTier} onOpenChange={(o) => { if (!o) { setTestTier(null); setTestTierResult(null); setTestTierError(null); } }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-test-tier">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4"/>
              Test tier
              {testTier && <span className="text-sm text-muted-foreground font-normal">· {testTier.name}</span>}
            </DialogTitle>
          </DialogHeader>
          {testTier && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                These are the open tee slots in the next 7 days that would resolve to this tier as their
                base price. The matching tier line is highlighted in each slot's price breakdown so
                wrong-day, wrong-time-window or season-window mistakes become visible before customers
                see them. Inactive (draft) tiers are previewed as if they were active.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <Label>Course</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testTierCourseId === "" ? "" : String(testTierCourseId)}
                    onChange={e => setTestTierCourseId(e.target.value === "" ? "" : parseInt(e.target.value))}
                    data-testid="select-test-tier-course"
                  >
                    <option value="">All courses</option>
                    {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Member type</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testTierMemberType}
                    onChange={e => setTestTierMemberType(e.target.value === "guest" ? "guest" : "member")}
                    data-testid="select-test-tier-member-type"
                  >
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </select>
                </div>
                {/* Task #1996 — admin-controlled near-miss row count.
                    The API clamps to 0–25; 0 hides the section, larger
                    values surface more candidate slots when debugging a
                    tier that's silently losing slots. */}
                <div>
                  <Label htmlFor="input-test-tier-near-miss-limit">Near misses</Label>
                  <Input
                    id="input-test-tier-near-miss-limit"
                    type="number"
                    min={0}
                    max={25}
                    step={1}
                    value={testTierNearMissLimit}
                    onChange={e => {
                      const raw = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
                      const n = Number.isFinite(raw) ? raw : 0;
                      setTestTierNearMissLimit(Math.max(0, Math.min(25, n)));
                    }}
                    data-testid="input-test-tier-near-miss-limit"
                  />
                </div>
                <div className="text-sm text-muted-foreground" data-testid="text-test-tier-summary">
                  {testTierLoading ? "Evaluating slots…" : (
                    testTierResult
                      ? `${testTierResult.matchCount} of ${testTierResult.slotsConsidered} slots resolve to this tier.`
                      : "—"
                  )}
                </div>
              </div>
              {testTierError && (
                <Card><CardContent className="py-3 text-sm text-red-600" data-testid="text-test-tier-error">{testTierError}</CardContent></Card>
              )}
              {testTierResult && testTierResult.matchCount === 0 && !testTierLoading && (
                <Card><CardContent className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-test-tier">
                  No upcoming slots in the next 7 days resolve to this tier as their base price.
                  {testTierResult.nearMisses.length > 0
                    ? " See the near-misses below for the closest slots and the single condition each one fell short of."
                    : " Double-check the day-of-week, time window, season window, member type and priority — a higher-priority tier may be winning the slot."}
                </CardContent></Card>
              )}
              {/* Task #1606 — tier near-miss section. Shown whenever the API
                  returns near-miss slots (regardless of match count) so admins
                  can debug a tier that's matching far fewer slots than they
                  expected, including the priority-loss case where a higher-
                  priority tier won the slot instead. */}
              {testTierResult && testTierResult.nearMisses.length > 0 && (
                <div className="space-y-2" data-testid="section-test-tier-near-misses">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold">Near misses</h3>
                    <p className="text-xs text-muted-foreground">
                      Upcoming slots that failed exactly one condition or lost the
                      slot to a higher-priority tier — the most likely culprits
                      when this tier isn't winning slots where you expect.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border" data-testid="table-test-tier-near-misses">
                      <thead>
                        <tr className="bg-muted text-left">
                          <th className="p-2">Date</th>
                          <th className="p-2">Time</th>
                          <th className="p-2">Course</th>
                          <th className="p-2">Why it didn't match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testTierResult.nearMisses.map(nm => {
                          const courseName = courses.find(c => c.id === nm.courseId)?.name ?? `#${nm.courseId}`;
                          const dowNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                          const reasonText = (f: TierTestFailure): string => {
                            if (f.condition === "course") {
                              const want = courses.find(c => c.id === f.expected)?.name ?? `#${f.expected}`;
                              const got = courses.find(c => c.id === f.actual)?.name ?? `#${f.actual}`;
                              return `Wrong course — tier is scoped to ${want}, slot is on ${got}`;
                            }
                            if (f.condition === "dayOfWeek") {
                              const expected = f.expected.map(d => dowNames[d] ?? String(d)).join(", ");
                              return `Wrong day of week — tier expects ${expected || "(none)"}, slot is ${dowNames[f.actual] ?? String(f.actual)}`;
                            }
                            if (f.condition === "timeRange") {
                              const lo = f.expected[0] ?? "(open)";
                              const hi = f.expected[1] ?? "(open)";
                              return `Outside time window — tier expects ${lo}–${hi}, slot is at ${f.actual}`;
                            }
                            if (f.condition === "season") {
                              const lo = f.expected[0] ?? "(open)";
                              const hi = f.expected[1] ?? "(open)";
                              return `Outside season — tier expects ${lo}–${hi}, slot date is ${f.actual}`;
                            }
                            if (f.condition === "memberType") {
                              return `Wrong member type — tier targets ${f.expected}, previewing for ${f.actual}`;
                            }
                            if (f.condition === "priorityLoss") {
                              return `Lost to higher-priority tier "${f.actual.tierName}" (priority ${f.actual.priority}) — this tier's priority is ${f.expected}`;
                            }
                            // zeroRate
                            return `Tier won the slot but its ${f.expected} rate is ₹0, so it adds no step to the breakdown`;
                          };
                          return (
                            <tr key={nm.slotId} className="border-t align-top" data-testid={`row-test-tier-near-miss-${nm.slotId}`}>
                              <td className="p-2 whitespace-nowrap">{nm.slotDate}</td>
                              <td className="p-2 whitespace-nowrap">{nm.slotTime}</td>
                              <td className="p-2 whitespace-nowrap">{courseName}</td>
                              <td className="p-2">
                                {nm.failures.map((f, i) => (
                                  <div
                                    key={i}
                                    data-testid={`tier-near-miss-reason-${nm.slotId}`}
                                    data-condition={f.condition}
                                  >
                                    <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">{f.condition}:</span>
                                    {reasonText(f)}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {testTierResult && testTierResult.matchCount > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border" data-testid="table-test-tier-matches">
                    <thead>
                      <tr className="bg-muted text-left">
                        <th className="p-2">Date</th>
                        <th className="p-2">Time</th>
                        <th className="p-2">Course</th>
                        <th className="p-2 text-right">Occupancy</th>
                        <th className="p-2 text-right">Lead</th>
                        <th className="p-2 text-right">Base</th>
                        <th className="p-2 text-right">Final</th>
                        <th className="p-2 text-right">Tier rate</th>
                        <th className="p-2">Breakdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testTierResult.matches.map(m => {
                        const courseName = courses.find(c => c.id === m.courseId)?.name ?? `#${m.courseId}`;
                        return (
                          <tr key={`${m.slotId}`} className="border-t align-top" data-testid={`row-test-tier-match-${m.slotId}`}>
                            <td className="p-2 whitespace-nowrap">{m.slotDate}</td>
                            <td className="p-2 whitespace-nowrap">{m.slotTime}</td>
                            <td className="p-2 whitespace-nowrap">{courseName}</td>
                            <td className="p-2 text-right">{(m.utilizationPct * 100).toFixed(0)}% <span className="text-muted-foreground text-xs">({m.bookedCount}/{m.capacity})</span></td>
                            <td className="p-2 text-right">{m.leadTimeHours < 48 ? `${m.leadTimeHours.toFixed(1)}h` : `${(m.leadTimeHours / 24).toFixed(1)}d`}</td>
                            <td className="p-2 text-right">₹{m.basePrice.toFixed(0)}</td>
                            <td className="p-2 text-right font-medium">₹{m.finalPrice.toFixed(0)}</td>
                            <td className={`p-2 text-right font-semibold ${m.priceDelta >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {m.priceDelta >= 0 ? "+" : ""}₹{m.priceDelta.toFixed(0)}
                            </td>
                            <td className="p-2">
                              <ol className="space-y-0.5 text-xs">
                                {m.breakdown.map((s, i) => {
                                  const isThisTier = i === m.tierStepIndex;
                                  return (
                                    <li
                                      key={i}
                                      className={isThisTier ? "bg-yellow-100 border-l-2 border-yellow-500 px-1 rounded font-medium" : ""}
                                      data-testid={isThisTier ? `breakdown-tier-hit-${m.slotId}` : undefined}
                                    >
                                      <span className="text-muted-foreground">{s.label}:</span>{" "}
                                      ₹{s.before.toFixed(0)} → ₹{s.after.toFixed(0)}
                                    </li>
                                  );
                                })}
                              </ol>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setTestTier(null); setTestTierResult(null); setTestTierError(null); }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modifier preview / "Test modifier" dialog (Task #1345) */}
      <Dialog open={!!testModifier} onOpenChange={(o) => { if (!o) { setTestModifier(null); setTestModifierResult(null); setTestModifierError(null); } }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-test-modifier">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4"/>
              Test modifier
              {testModifier && <span className="text-sm text-muted-foreground font-normal">· {testModifier.name}</span>}
            </DialogTitle>
          </DialogHeader>
          {testModifier && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                These are the open tee slots in the next 7 days whose price breakdown would include this
                modifier. The modifier line is highlighted in each breakdown so off-by-one threshold or
                lead-time mistakes become visible before customers see them.
                {testModifier.kind === "weather" && " Tee slots don't carry weather conditions until the live engine evaluates them, so by default this preview pulls Open-Meteo's 7-day forecast for each course and matches each slot against its own day's expected condition — switch to Override to force a single condition, or to No weather data to see the realistic no-forecast scenario."}
                {" "}Inactive (draft) modifiers are previewed as if they were active.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <Label>Course</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testModifierCourseId === "" ? "" : String(testModifierCourseId)}
                    onChange={e => setTestModifierCourseId(e.target.value === "" ? "" : parseInt(e.target.value))}
                    data-testid="select-test-modifier-course"
                  >
                    <option value="">All courses</option>
                    {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Member type</Label>
                  <select
                    className="w-full border rounded p-2"
                    value={testModifierMemberType}
                    onChange={e => setTestModifierMemberType(e.target.value === "guest" ? "guest" : "member")}
                    data-testid="select-test-modifier-member-type"
                  >
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </select>
                </div>
                {testModifier.kind === "weather" ? (
                  // Task #1994 — three-way mode selector replaces the single
                  // simulated-weather text input. Forecast mode is the default;
                  // Override is the legacy "single global condition" path; None
                  // is the realistic "no forecast attached yet" preview.
                  <div>
                    <Label>Weather source</Label>
                    <select
                      className="w-full border rounded p-2"
                      value={testModifierWeatherMode}
                      onChange={e => setTestModifierWeatherMode(e.target.value as ModifierWeatherMode)}
                      data-testid="select-test-modifier-weather-mode"
                    >
                      <option value="forecast">7-day forecast (per day)</option>
                      <option value="override">Override single condition…</option>
                      <option value="none">No weather data (realistic)</option>
                    </select>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground" data-testid="text-test-modifier-summary">
                    {testModifierLoading ? "Evaluating slots…" : (
                      testModifierResult
                        ? `${testModifierResult.matchCount} of ${testModifierResult.slotsConsidered} slots include this modifier.`
                        : "—"
                    )}
                  </div>
                )}
                {/* Task #1996 — admin-controlled near-miss row count.
                    The API clamps to 0–25; 0 hides the section, larger
                    values surface more candidate slots when debugging a
                    modifier that's silently losing slots. */}
                <div>
                  <Label htmlFor="input-test-modifier-near-miss-limit">Near misses</Label>
                  <Input
                    id="input-test-modifier-near-miss-limit"
                    type="number"
                    min={0}
                    max={25}
                    step={1}
                    value={testModifierNearMissLimit}
                    onChange={e => {
                      const raw = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
                      const n = Number.isFinite(raw) ? raw : 0;
                      setTestModifierNearMissLimit(Math.max(0, Math.min(25, n)));
                    }}
                    data-testid="input-test-modifier-near-miss-limit"
                  />
                </div>
              </div>
              {testModifier.kind === "weather" && testModifierWeatherMode === "override" && (
                // Override condition input — only shown when the admin has
                // explicitly opted out of forecast mode for what-if testing.
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="md:col-span-1">
                    <Label>Override condition</Label>
                    <Input
                      type="text"
                      placeholder="rain, clear, storm…"
                      value={testModifierSimulateWeather}
                      onChange={e => setTestModifierSimulateWeather(e.target.value)}
                      data-testid="input-test-modifier-simulate-weather"
                    />
                  </div>
                  <p className="md:col-span-2 text-xs text-muted-foreground">
                    Applied to every slot in the preview. Match is case-insensitive against the modifier's own
                    configured condition.
                  </p>
                </div>
              )}
              {testModifier.kind === "weather" && (
                // Summary line — surfaces what condition was applied so the
                // admin can correlate the table below.
                <div className="text-sm text-muted-foreground" data-testid="text-test-modifier-summary">
                  {testModifierLoading ? "Evaluating slots…" : (() => {
                    if (!testModifierResult) return "—";
                    const base = `${testModifierResult.matchCount} of ${testModifierResult.slotsConsidered} slots include this modifier`;
                    if (testModifierWeatherMode === "forecast") {
                      const fc = testModifierResult.forecast;
                      if (fc && fc.enabled && !fc.unavailable) {
                        return `${base} when each day is evaluated under its live forecast.`;
                      }
                      // Forecast was requested but the backend fell back —
                      // either no lat/lng or an upstream outage. Show the
                      // reason so admins know what happened.
                      const reason = fc?.reason ?? "forecast unavailable";
                      const fallback = testModifierResult.simulatedWeather
                        ? ` (using modifier condition "${testModifierResult.simulatedWeather}" as fallback)`
                        : "";
                      return `${base} — forecast unavailable: ${reason}${fallback}.`;
                    }
                    if (testModifierWeatherMode === "override") {
                      return testModifierResult.simulatedWeather
                        ? `${base} when condition is "${testModifierResult.simulatedWeather}".`
                        : `${base} (override is empty — weather modifiers can't match without a condition).`;
                    }
                    return `${base} (no weather attached — realistic preview).`;
                  })()}
                </div>
              )}
              {/* Task #1994 — per-course forecast strip. Renders one row per
                  course in the preview with the next 7 days' expected
                  conditions pulled from Open-Meteo. Admins can scan the strip
                  to see exactly which days the modifier is expected to fire
                  before publishing. Only shown in forecast mode. */}
              {testModifier.kind === "weather"
                && testModifierWeatherMode === "forecast"
                && testModifierResult?.forecast
                && testModifierResult.forecast.enabled
                && !testModifierResult.forecast.unavailable
                && testModifierResult.forecast.byCourse.length > 0 && (
                <div className="space-y-2" data-testid="section-test-modifier-forecast">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold">Forecast outlook</h3>
                    <p className="text-xs text-muted-foreground">
                      Next {testModifierResult.days} days from Open-Meteo. Days whose condition matches the
                      modifier's <code className="text-foreground">{testModifier.weatherCondition ?? "any"}</code> trigger are highlighted.
                    </p>
                  </div>
                  <div className="space-y-1">
                    {testModifierResult.forecast.byCourse.map(strip => {
                      const wantedRaw = testModifier.weatherCondition?.trim().toLowerCase() ?? "";
                      const matchCount = wantedRaw
                        ? strip.days.filter(d => (d.condition ?? "").toLowerCase() === wantedRaw).length
                        : 0;
                      const courseName = strip.courseName ?? courses.find(c => c.id === strip.courseId)?.name ?? `Course #${strip.courseId}`;
                      return (
                        <div
                          key={strip.courseId}
                          className="border rounded p-2 text-xs"
                          data-testid={`forecast-strip-${strip.courseId}`}
                        >
                          <div className="flex items-baseline justify-between mb-1">
                            <div className="font-medium text-sm">{courseName}</div>
                            {wantedRaw && (
                              <div className="text-muted-foreground" data-testid={`forecast-match-count-${strip.courseId}`}>
                                {matchCount} of {strip.days.length} days match "{testModifier.weatherCondition}"
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {strip.days.map(d => {
                              const cond = (d.condition ?? "").toLowerCase();
                              const isMatch = !!wantedRaw && cond === wantedRaw;
                              const dt = new Date(d.date + "T00:00:00");
                              const dow = dt.toLocaleDateString(undefined, { weekday: "short" });
                              return (
                                <div
                                  key={d.date}
                                  className={`px-2 py-1 rounded border text-center min-w-[64px] ${isMatch ? "bg-yellow-100 border-yellow-500" : "bg-muted/50"}`}
                                  data-testid={`forecast-day-${strip.courseId}-${d.date}`}
                                  data-condition={d.condition ?? ""}
                                  data-match={isMatch ? "true" : "false"}
                                  title={`${d.date}${d.weatherCode != null ? ` · WMO ${d.weatherCode}` : ""}`}
                                >
                                  <div className="font-semibold">{dow}</div>
                                  <div className="text-[11px]">{d.condition ?? "—"}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Forecast was requested but unavailable — surface the reason
                  so admins know they're looking at a fallback preview. */}
              {testModifier.kind === "weather"
                && testModifierWeatherMode === "forecast"
                && testModifierResult?.forecast
                && testModifierResult.forecast.unavailable && (
                <Card>
                  <CardContent className="py-3 text-sm" data-testid="forecast-unavailable-notice">
                    <div className="font-medium">Forecast unavailable</div>
                    <div className="text-muted-foreground text-xs mt-1">
                      {testModifierResult.forecast.reason ?? "The forecast service didn't return data for the courses in this preview."}
                      {testModifierResult.simulatedWeather
                        ? ` Falling back to the modifier's own condition ("${testModifierResult.simulatedWeather}") so you still see matches.`
                        : " Switch to Override to test specific conditions while the service is down."}
                    </div>
                  </CardContent>
                </Card>
              )}
              {testModifierError && (
                <Card><CardContent className="py-3 text-sm text-red-600" data-testid="text-test-modifier-error">{testModifierError}</CardContent></Card>
              )}
              {testModifierResult && testModifierResult.matchCount === 0 && !testModifierLoading && (
                <Card><CardContent className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-test-modifier">
                  No upcoming slots in the next 7 days include this modifier in their breakdown.
                  {testModifierResult.nearMisses.length > 0
                    ? " See the near-misses below for the closest slots and the single condition each one fell short of."
                    : " Double-check the kind, threshold range, course scope and member type — slots also need to fall inside the threshold to trigger this modifier."}
                </CardContent></Card>
              )}
              {/* Task #1606 — modifier near-miss section. Surfaces upcoming
                  slots that fell off the band by exactly one dimension —
                  utilisation/lead-time threshold, course scope, member-type
                  scope, or weather mismatch — so admins can tell "no slot is
                  busy enough yet" from "wrong course scope" at a glance. */}
              {testModifierResult && testModifierResult.nearMisses.length > 0 && (
                <div className="space-y-2" data-testid="section-test-modifier-near-misses">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold">Near misses</h3>
                    <p className="text-xs text-muted-foreground">
                      Upcoming slots that failed exactly one of the modifier's
                      conditions — the most likely culprits when this modifier
                      isn't firing where you expect.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border" data-testid="table-test-modifier-near-misses">
                      <thead>
                        <tr className="bg-muted text-left">
                          <th className="p-2">Date</th>
                          <th className="p-2">Time</th>
                          <th className="p-2">Course</th>
                          <th className="p-2">Why it didn't match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testModifierResult.nearMisses.map(nm => {
                          const courseName = courses.find(c => c.id === nm.courseId)?.name ?? `#${nm.courseId}`;
                          const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
                          const fmtLead = (n: number) => n < 48 ? `${n.toFixed(1)}h` : `${(n / 24).toFixed(1)}d`;
                          const reasonText = (f: ModifierTestFailure): string => {
                            if (f.condition === "course") {
                              const want = courses.find(c => c.id === f.expected)?.name ?? `#${f.expected}`;
                              const got = courses.find(c => c.id === f.actual)?.name ?? `#${f.actual}`;
                              return `Wrong course — modifier is scoped to ${want}, slot is on ${got}`;
                            }
                            if (f.condition === "applyTo") {
                              return `Wrong member type — modifier targets ${f.expected}, previewing for ${f.actual}`;
                            }
                            if (f.condition === "utilizationBelowMin") {
                              return `Occupancy too low — modifier needs at least ${fmtPct(f.expected)}, slot is at ${fmtPct(f.actual)}`;
                            }
                            if (f.condition === "utilizationAboveMax") {
                              return `Occupancy too high — modifier caps at ${fmtPct(f.expected)}, slot is at ${fmtPct(f.actual)}`;
                            }
                            if (f.condition === "leadTimeBelowMin") {
                              return `Lead time too short — modifier needs at least ${fmtLead(f.expected)}, slot is ${fmtLead(f.actual)} away`;
                            }
                            if (f.condition === "leadTimeAboveMax") {
                              return `Lead time too long — modifier caps at ${fmtLead(f.expected)}, slot is ${fmtLead(f.actual)} away`;
                            }
                            if (f.condition === "weatherMissing") {
                              return f.expected
                                ? `Weather data missing — modifier expects "${f.expected}" but the slot has no forecast attached yet`
                                : `Modifier has no weather condition configured — set one to make this fire`;
                            }
                            // weatherMismatch
                            return `Weather doesn't match — modifier expects "${f.expected}", slot's forecast is "${f.actual}"`;
                          };
                          return (
                            <tr key={nm.slotId} className="border-t align-top" data-testid={`row-test-modifier-near-miss-${nm.slotId}`}>
                              <td className="p-2 whitespace-nowrap">{nm.slotDate}</td>
                              <td className="p-2 whitespace-nowrap">{nm.slotTime}</td>
                              <td className="p-2 whitespace-nowrap">{courseName}</td>
                              <td className="p-2">
                                {nm.failures.map((f, i) => (
                                  <div
                                    key={i}
                                    data-testid={`modifier-near-miss-reason-${nm.slotId}`}
                                    data-condition={f.condition}
                                  >
                                    <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">{f.condition}:</span>
                                    {reasonText(f)}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {testModifierResult && testModifierResult.matchCount > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border" data-testid="table-test-modifier-matches">
                    <thead>
                      <tr className="bg-muted text-left">
                        <th className="p-2">Date</th>
                        <th className="p-2">Time</th>
                        <th className="p-2">Course</th>
                        <th className="p-2 text-right">Occupancy</th>
                        <th className="p-2 text-right">Lead</th>
                        <th className="p-2 text-right">Base</th>
                        <th className="p-2 text-right">Final</th>
                        <th className="p-2 text-right">Δ from modifier</th>
                        <th className="p-2">Breakdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testModifierResult.matches.map(m => {
                        const courseName = courses.find(c => c.id === m.courseId)?.name ?? `#${m.courseId}`;
                        return (
                          <tr key={`${m.slotId}`} className="border-t align-top" data-testid={`row-test-modifier-match-${m.slotId}`}>
                            <td className="p-2 whitespace-nowrap">{m.slotDate}</td>
                            <td className="p-2 whitespace-nowrap">{m.slotTime}</td>
                            <td className="p-2 whitespace-nowrap">{courseName}</td>
                            <td className="p-2 text-right">{(m.utilizationPct * 100).toFixed(0)}% <span className="text-muted-foreground text-xs">({m.bookedCount}/{m.capacity})</span></td>
                            <td className="p-2 text-right">{m.leadTimeHours < 48 ? `${m.leadTimeHours.toFixed(1)}h` : `${(m.leadTimeHours / 24).toFixed(1)}d`}</td>
                            <td className="p-2 text-right">₹{m.basePrice.toFixed(0)}</td>
                            <td className="p-2 text-right font-medium">₹{m.finalPrice.toFixed(0)}</td>
                            <td className={`p-2 text-right font-semibold ${m.priceDelta >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {m.priceDelta >= 0 ? "+" : ""}₹{m.priceDelta.toFixed(0)}
                            </td>
                            <td className="p-2">
                              {/* Task #1994 — surface the per-day condition the
                                  engine used for this slot so admins can audit
                                  forecast-driven matches at a glance. Shown
                                  only when forecast mode is on; override mode's
                                  global condition is already in the summary. */}
                              {testModifier?.kind === "weather"
                                && testModifierWeatherMode === "forecast"
                                && m.weatherConditionUsed && (
                                <div
                                  className="text-[11px] text-muted-foreground mb-1"
                                  data-testid={`breakdown-weather-used-${m.slotId}`}
                                >
                                  Forecast: <span className="font-medium text-foreground">{m.weatherConditionUsed}</span>
                                </div>
                              )}
                              <ol className="space-y-0.5 text-xs">
                                {m.breakdown.map((s, i) => {
                                  const isThisMod = i === m.modifierStepIndex;
                                  return (
                                    <li
                                      key={i}
                                      className={isThisMod ? "bg-yellow-100 border-l-2 border-yellow-500 px-1 rounded font-medium" : ""}
                                      data-testid={isThisMod ? `breakdown-modifier-hit-${m.slotId}` : undefined}
                                    >
                                      <span className="text-muted-foreground">{s.label}:</span>{" "}
                                      ₹{s.before.toFixed(0)} → ₹{s.after.toFixed(0)}
                                    </li>
                                  );
                                })}
                              </ol>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setTestModifier(null); setTestModifierResult(null); setTestModifierError(null); }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Forecast accuracy drill-down (Task #1097) */}
      <Dialog open={!!drillRow} onOpenChange={(o) => !o && setDrillRow(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-forecast-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-4 w-4"/>
              Forecast detail
              {drillRow && (
                <span className="text-xs text-muted-foreground font-normal">
                  · {drillRow.windowStart} → {drillRow.windowEnd} · {drillRow.scenario}
                  {drillRow.label ? ` · ${drillRow.label}` : ""}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {drillError && (
            <div className="text-sm text-red-600" data-testid="drill-error">
              Couldn't load forecast detail: {drillError}
            </div>
          )}
          {drillLoading && !drillDetail && (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="drill-loading">
              Loading per-day breakdown…
            </div>
          )}
          {drillDetail && (() => {
            const d = drillDetail;
            const maxBar = Math.max(
              1,
              ...d.daily.map(row => Math.max(row.projectedRevenue, row.actualRevenue)),
            );
            const a = d.forecast.assumptions ?? {};
            const fmtAssumption = (v: unknown) => {
              if (v == null) return "—";
              if (typeof v === "number") return Number.isFinite(v) ? v.toString() : "—";
              return String(v);
            };
            const courseName = d.forecast.courseId != null
              ? (courses.find(c => c.id === d.forecast.courseId)?.name ?? `Course ${d.forecast.courseId}`)
              : "All courses";
            return (
              <div className="space-y-4">
                {d.projectionSource === "flat" && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                    data-testid="drill-flat-projection-notice"
                    role="status"
                  >
                    <Info className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true"/>
                    <div>
                      <span className="font-medium">Per-day numbers approximated</span>
                      {" — this forecast was saved before per-day projections were captured, so the daily breakdown uses a flat baseline derived from the forecast totals."}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3" data-testid="drill-summary">
                  <Card><CardContent className="py-3">
                    <div className="text-xs text-muted-foreground">Projected revenue</div>
                    <div className="text-xl font-bold">₹{Math.round(d.totals.projectedRevenue).toLocaleString()}</div>
                  </CardContent></Card>
                  <Card><CardContent className="py-3">
                    <div className="text-xs text-muted-foreground">Actual revenue</div>
                    <div className="text-xl font-bold" data-testid="drill-actual-revenue">
                      {d.status === "pending" ? <span className="text-muted-foreground text-base">pending</span> : `₹${Math.round(d.totals.actualRevenue).toLocaleString()}`}
                    </div>
                  </CardContent></Card>
                  <Card><CardContent className="py-3">
                    <div className="text-xs text-muted-foreground">Revenue gap</div>
                    <div className={`text-xl font-bold ${d.totals.revenueError >= 0 ? "text-red-600" : "text-green-600"}`}>
                      {d.totals.revenueError >= 0 ? "+" : ""}₹{Math.round(d.totals.revenueError).toLocaleString()}
                      {d.totals.revenueErrorPct != null && (
                        <span className="ml-1 text-xs">({d.totals.revenueErrorPct >= 0 ? "+" : ""}{d.totals.revenueErrorPct.toFixed(1)}%)</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">over- minus under-projection</div>
                  </CardContent></Card>
                  <Card><CardContent className="py-3">
                    <div className="text-xs text-muted-foreground">Accuracy</div>
                    <div className="text-xl font-bold" data-testid="drill-accuracy">
                      {d.totals.accuracyPct == null ? "—" : `${d.totals.accuracyPct.toFixed(1)}%`}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Util {(d.totals.utilizationPct * 100).toFixed(1)}% · avg ₹{d.totals.avgPricePerSeat.toFixed(0)}/seat
                    </div>
                  </CardContent></Card>
                </div>

                {d.biggestMiss && (
                  <Card data-testid="drill-biggest-miss">
                    <CardContent className="py-3 text-sm">
                      <span className="font-medium">Biggest single-day gap: </span>
                      {d.biggestMiss.day} ·{" "}
                      <span className={d.biggestMiss.revenueDelta >= 0 ? "text-green-600" : "text-red-600"}>
                        {d.biggestMiss.revenueDelta >= 0 ? "+" : ""}₹{Math.round(d.biggestMiss.revenueDelta).toLocaleString()}
                      </span>
                      <span className="text-muted-foreground">
                        {d.projectionSource === "flat"
                          ? " vs flat projected baseline"
                          : " vs projected baseline"}
                      </span>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Per-day projected vs actual revenue</CardTitle></CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="drill-daily-table">
                        <thead>
                          <tr className="border-b text-left">
                            <th className="p-1">Day</th>
                            <th className="p-1 w-1/3">Projected vs actual</th>
                            <th className="p-1 text-right">Projected ₹</th>
                            <th className="p-1 text-right">Actual ₹</th>
                            <th className="p-1 text-right">Δ</th>
                            <th className="p-1 text-right">Bookings</th>
                            <th className="p-1 text-right">Util%</th>
                            <th className="p-1 text-right">Avg ₹/seat</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.daily.map(row => {
                            const projWidth = Math.round((row.projectedRevenue / maxBar) * 100);
                            const actWidth = Math.round((row.actualRevenue / maxBar) * 100);
                            return (
                              <tr key={row.day} className="border-b align-middle" data-testid={`drill-day-${row.day}`}>
                                <td className="p-1 whitespace-nowrap">{row.day}{row.pending && <span className="ml-1 text-[10px] text-muted-foreground">(pending)</span>}</td>
                                <td className="p-1">
                                  <div className="space-y-0.5">
                                    <div className="h-2 bg-blue-200 rounded" style={{ width: `${projWidth}%` }} title={`Projected ₹${Math.round(row.projectedRevenue).toLocaleString()}`}/>
                                    <div className={`h-2 rounded ${row.pending ? "bg-muted" : "bg-emerald-500"}`} style={{ width: `${actWidth}%` }} title={`Actual ₹${Math.round(row.actualRevenue).toLocaleString()}`}/>
                                  </div>
                                </td>
                                <td className="p-1 text-right">₹{Math.round(row.projectedRevenue).toLocaleString()}</td>
                                <td className="p-1 text-right">{row.pending ? <span className="text-muted-foreground">—</span> : `₹${Math.round(row.actualRevenue).toLocaleString()}`}</td>
                                <td className={`p-1 text-right ${row.pending ? "text-muted-foreground" : row.revenueDelta >= 0 ? "text-green-600" : "text-red-600"}`}>
                                  {row.pending ? "—" : `${row.revenueDelta >= 0 ? "+" : ""}₹${Math.round(row.revenueDelta).toLocaleString()}`}
                                </td>
                                <td className="p-1 text-right">{row.pending ? "—" : row.actualBookings}</td>
                                <td className="p-1 text-right">{row.seatsTotal === 0 ? "—" : `${(row.utilizationPct * 100).toFixed(0)}%`}</td>
                                <td className="p-1 text-right">{row.actualSeatsBooked === 0 ? "—" : `₹${row.avgPricePerSeat.toFixed(0)}`}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex gap-4 mt-2 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1" data-testid="drill-projection-source">
                        <span className="inline-block h-2 w-3 bg-blue-200 rounded"/>
                        {d.projectionSource === "flat"
                          ? "Projected (flat per-day baseline)"
                          : "Projected (per-day snapshot)"}
                      </span>
                      <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 bg-emerald-500 rounded"/>Actual</span>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Forecast assumptions</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs" data-testid="drill-assumptions">
                      <div><div className="text-muted-foreground">Course</div><div className="font-medium">{courseName}</div></div>
                      <div><div className="text-muted-foreground">Horizon</div><div className="font-medium">{d.forecast.horizonDays} days</div></div>
                      <div><div className="text-muted-foreground">Snapshot taken</div><div className="font-medium">{new Date(d.forecast.createdAt).toLocaleString()}</div></div>
                      <div><div className="text-muted-foreground">Member elasticity</div><div className="font-medium">{fmtAssumption(a.memberElasticity)}{a.memberElasticitySource ? ` (${a.memberElasticitySource})` : ""}</div></div>
                      <div><div className="text-muted-foreground">Guest elasticity</div><div className="font-medium">{fmtAssumption(a.guestElasticity)}{a.guestElasticitySource ? ` (${a.guestElasticitySource})` : ""}</div></div>
                      <div><div className="text-muted-foreground">Member share (mix)</div><div className="font-medium">{a.memberShare != null ? `${(Number(a.memberShare) * 100).toFixed(0)}%` : "—"}</div></div>
                      <div><div className="text-muted-foreground">Fallback utilisation</div><div className="font-medium">{a.fallbackUtilization != null ? `${(Number(a.fallbackUtilization) * 100).toFixed(0)}%` : "—"}</div></div>
                      <div><div className="text-muted-foreground">Sample window</div><div className="font-medium">{fmtAssumption(a.historicalSampleDays)} days</div></div>
                      <div><div className="text-muted-foreground">Slots considered</div><div className="font-medium">{fmtAssumption(a.slotsConsidered)}</div></div>
                      <div><div className="text-muted-foreground">Projected seats booked</div><div className="font-medium">{d.forecast.projectedSeatsBooked} / {d.forecast.projectedSeatsTotal}</div></div>
                      <div><div className="text-muted-foreground">Projected avg ₹/seat</div><div className="font-medium">₹{d.forecast.projectedAvgPrice.toFixed(0)}</div></div>
                      <div><div className="text-muted-foreground">Actual seats booked</div><div className="font-medium">{d.totals.actualSeatsBooked} / {d.totals.seatsTotal}</div></div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDrillRow(null)} data-testid="btn-close-drill">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ForecastAccuracySchedule {
  id: number;
  organizationId: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextRunAt: string | null;
}

interface ForecastAccuracyFinanceMember {
  userId: number;
  displayName: string | null;
  email: string;
  role: string;
}

interface ForecastAccuracyFinanceMissingMember {
  userId: number;
  displayName: string | null;
  username: string | null;
  role: string;
}

const FINANCE_ROLE_LABEL: Record<string, string> = {
  treasurer: 'Treasurer',
};

interface ForecastAccuracyScheduleRun {
  id: number;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  rowCount: number;
  recipients: string[];
  status: string;
  errorMessage: string | null;
}

function ForecastAccuracyEmailSchedulePanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<{ schedule: ForecastAccuracySchedule | null; history: ForecastAccuracyScheduleRun[] }>({
    queryKey: ['forecast-accuracy-email-schedule', orgId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
  });

  const financeMembersQuery = useQuery<{
    members: ForecastAccuracyFinanceMember[];
    missingEmail?: ForecastAccuracyFinanceMissingMember[];
    missingEmailCount?: number;
  }>({
    queryKey: ['forecast-accuracy-finance-members', orgId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
  });

  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [hydratedFor, setHydratedFor] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);

  const sched = q.data?.schedule ?? null;
  const hydrationKey = sched ? sched.id : -1;
  if (hydratedFor !== hydrationKey && q.isSuccess) {
    if (sched) {
      setFrequency(sched.frequency);
      setRecipients(sched.recipients.join(', '));
      setEnabled(sched.enabled);
    } else {
      setFrequency('weekly');
      setRecipients('');
      setEnabled(true);
    }
    setHydratedFor(hydrationKey);
  }

  const parsedRecipients = recipients
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const invalid = parsedRecipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));

  const financeMembers = financeMembersQuery.data?.members ?? [];
  const financeMissingEmail = financeMembersQuery.data?.missingEmail ?? [];
  // Prefer the server-supplied count as canonical (handles the case where
  // the backend ever decides to truncate the list for display but still
  // wants to expose the full tally to the UI). Fall back to list length
  // for older API responses without the count field.
  const financeMissingEmailCount = financeMembersQuery.data?.missingEmailCount ?? financeMissingEmail.length;
  const recipientEmailSet = new Set(parsedRecipients.map(e => e.toLowerCase()));
  const memberQueryLower = memberQuery.trim().toLowerCase();
  const filteredFinanceMembers = financeMembers.filter(m => {
    if (!memberQueryLower) return true;
    return (
      m.email.toLowerCase().includes(memberQueryLower) ||
      (m.displayName ?? '').toLowerCase().includes(memberQueryLower) ||
      (FINANCE_ROLE_LABEL[m.role] ?? m.role).toLowerCase().includes(memberQueryLower)
    );
  });

  const addFinanceMember = (member: ForecastAccuracyFinanceMember) => {
    if (recipientEmailSet.has(member.email.toLowerCase())) return;
    const trimmed = recipients.trim();
    const sep = trimmed.length === 0 ? '' : (trimmed.endsWith(',') || trimmed.endsWith(';') ? ' ' : ', ');
    setRecipients(trimmed + sep + member.email);
    setMemberQuery('');
  };

  const matchedFinanceMembersByEmail = new Map<string, ForecastAccuracyFinanceMember>();
  for (const m of financeMembers) matchedFinanceMembersByEmail.set(m.email.toLowerCase(), m);
  const recipientMemberMatches = parsedRecipients
    .map(e => ({ email: e, member: matchedFinanceMembersByEmail.get(e.toLowerCase()) ?? null }))
    .filter(x => x.member !== null) as Array<{ email: string; member: ForecastAccuracyFinanceMember }>;

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Forecast accuracy schedule saved', description: enabled ? 'Finance will receive the next accuracy CSV automatically.' : 'Schedule paused; no emails will be sent.' });
      queryClient.invalidateQueries({ queryKey: ['forecast-accuracy-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: 'Schedule removed' });
      queryClient.invalidateQueries({ queryKey: ['forecast-accuracy-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/preview`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        subject: string; html: string; filename: string;
        perDayFilename: string;
        rowCount: number;
        perDayRowCount: number;
        recipients: string[]; frequency: 'daily' | 'weekly' | 'monthly';
        periodStart: string; periodEnd: string;
        csvSample: { header: string; rows: string[]; totalRows: number; sampleSize: number };
        perDayCsvSample: { header: string; rows: string[]; totalRows: number; sampleSize: number };
      }>;
    },
    onSuccess: () => setPreviewOpen(true),
    onError: (e: Error) => toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule/send-now`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ status: string; rowCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({ title: 'Accuracy CSV sent', description: `Delivered ${res.rowCount} window${res.rowCount === 1 ? '' : 's'} to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}.` });
      } else {
        toast({ title: 'Send failed', description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey: ['forecast-accuracy-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Send failed', description: e.message, variant: 'destructive' }),
  });

  const history = q.data?.history ?? [];
  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  if (!orgId) return null;

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3" data-testid="forecast-accuracy-email-schedule">
      <div className="flex items-start gap-2">
        <Mail className="w-4 h-4 text-emerald-300 mt-0.5" />
        <div>
          <p className="text-sm font-semibold">Email this accuracy report to finance on a schedule</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Send the same CSV the Download button produces (window dates, scenario, projected vs actual revenue, error %, accuracy bucket) automatically each day, week, or month so reconciliation can happen straight from the inbox. Pending windows are excluded.
          </p>
        </div>
      </div>
      {q.isLoading ? (
        <div className="py-3 text-center text-xs text-muted-foreground">Loading schedule…</div>
      ) : q.isError ? (
        <div className="py-3 text-center text-xs text-rose-500">Failed to load schedule.</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Frequency</Label>
              <Select value={frequency} onValueChange={v => setFrequency(v as 'daily' | 'weekly' | 'monthly')}>
                <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-forecast-accuracy-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
              {frequency === 'daily' && (
                <p
                  className="mt-1 text-[11px] text-amber-600 dark:text-amber-400"
                  data-testid="forecast-accuracy-frequency-daily-hint"
                >
                  This sends one email per day to each recipient — pause anytime if it gets noisy.
                </p>
              )}
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer h-8">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  data-testid="toggle-forecast-accuracy-enabled"
                  className="accent-emerald-500"
                />
                {enabled ? 'Enabled' : 'Paused'}
              </label>
            </div>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Add finance team member</Label>
            <div className="relative mt-1" data-testid="forecast-accuracy-finance-picker">
              <div className="relative">
                <UserPlus className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={memberQuery}
                  onChange={e => { setMemberQuery(e.target.value); setMemberPickerOpen(true); }}
                  onFocus={() => setMemberPickerOpen(true)}
                  onBlur={() => { setTimeout(() => setMemberPickerOpen(false), 150); }}
                  placeholder={
                    financeMembersQuery.isLoading ? 'Loading finance team…' :
                    financeMembers.length === 0 ? 'No finance team members tagged yet' :
                    'Search treasurers by name or email…'
                  }
                  disabled={financeMembersQuery.isLoading || financeMembers.length === 0}
                  className="h-8 text-xs pl-7"
                  data-testid="input-forecast-accuracy-finance-search"
                />
              </div>
              {memberPickerOpen && financeMembers.length > 0 && (
                <div
                  className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
                  data-testid="forecast-accuracy-finance-picker-dropdown"
                >
                  {filteredFinanceMembers.length === 0 ? (
                    <div className="px-2 py-2 text-[11px] text-muted-foreground" data-testid="forecast-accuracy-finance-picker-empty">
                      No matching finance team members.
                    </div>
                  ) : filteredFinanceMembers.map(m => {
                    const already = recipientEmailSet.has(m.email.toLowerCase());
                    return (
                      <button
                        key={m.userId}
                        type="button"
                        onMouseDown={e => { e.preventDefault(); if (!already) addFinanceMember(m); }}
                        disabled={already}
                        className={`w-full text-left px-2 py-1.5 text-xs flex items-center justify-between gap-2 ${already ? 'opacity-60 cursor-not-allowed' : 'hover:bg-accent hover:text-accent-foreground'}`}
                        data-testid={`forecast-accuracy-finance-option-${m.userId}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium truncate block">{m.displayName ?? m.email}</span>
                          <span className="text-[10px] text-muted-foreground truncate block">
                            {m.email} · {FINANCE_ROLE_LABEL[m.role] ?? m.role}
                          </span>
                        </span>
                        {already && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-label="Already added" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1" data-testid="forecast-accuracy-finance-picker-help">
              {financeMembersQuery.isError
                ? 'Could not load finance team members.'
                : financeMembers.length === 0 && !financeMembersQuery.isLoading
                ? 'Tag treasurers in Members to enable name-based selection. You can still add any email below.'
                : 'Pick from your treasurers, or type any email below for external accountants.'}
            </div>
            {financeMissingEmail.length > 0 && (
              <div
                className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2"
                data-testid="forecast-accuracy-finance-missing-email"
              >
                <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-200">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <span
                      className="font-medium"
                      data-testid="forecast-accuracy-finance-missing-email-count"
                    >
                      {financeMissingEmailCount} finance team member{financeMissingEmailCount === 1 ? '' : 's'} can't be picked because they don't have an email on file.
                    </span>
                    <span className="text-muted-foreground"> Click a name to update their email in Members.</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {financeMissingEmail.map(m => {
                        const label = m.displayName ?? m.username ?? `User #${m.userId}`;
                        const searchTerm = m.displayName ?? m.username ?? '';
                        const href = searchTerm
                          ? `/club-members?search=${encodeURIComponent(searchTerm)}`
                          : '/club-members';
                        return (
                          <a
                            key={m.userId}
                            href={href}
                            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-100 hover:bg-amber-500/20"
                            data-testid={`forecast-accuracy-finance-missing-email-link-${m.userId}`}
                            title={`Open Members and search for ${label} to add their email`}
                          >
                            <Mail className="w-3 h-3" />
                            <span className="truncate max-w-[140px]">{label}</span>
                            <span className="text-[9px] opacity-70">· {FINANCE_ROLE_LABEL[m.role] ?? m.role}</span>
                          </a>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Recipients (comma- or whitespace-separated)</Label>
            <Textarea
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="finance@club.com, controller@club.com"
              className="mt-1 text-xs min-h-[60px]"
              data-testid="input-forecast-accuracy-recipients"
            />
            {recipientMemberMatches.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1" data-testid="forecast-accuracy-recipient-member-tags">
                {recipientMemberMatches.map(({ email, member }) => (
                  <Badge
                    key={email}
                    variant="secondary"
                    className="text-[10px] gap-1 bg-emerald-500/15 text-emerald-700 border border-emerald-500/30"
                    data-testid={`forecast-accuracy-recipient-member-tag-${member.userId}`}
                    title={`${member.displayName ?? member.email} · ${FINANCE_ROLE_LABEL[member.role] ?? member.role}`}
                  >
                    <UserPlus className="w-3 h-3" />
                    {member.displayName ?? member.email}
                  </Badge>
                ))}
              </div>
            )}
            <div className="text-[10px] mt-1">
              {invalid.length > 0 ? (
                <span className="text-rose-500">Invalid: {invalid.join(', ')}</span>
              ) : parsedRecipients.length > 0 ? (
                <span className="text-muted-foreground">
                  {parsedRecipients.length} recipient{parsedRecipients.length === 1 ? '' : 's'}
                  {recipientMemberMatches.length > 0 ? ` · ${recipientMemberMatches.length} from finance team` : ''}
                </span>
              ) : (
                <span className="text-muted-foreground">Enter at least one email address.</span>
              )}
            </div>
          </div>
          {sched && (
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>Last sent: {sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : 'never'}</span>
              <span>Next run: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—'}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              data-testid="button-save-forecast-accuracy-schedule"
            >
              {saveMut.isPending ? 'Saving…' : sched ? 'Update schedule' : 'Create schedule'}
            </Button>
            {sched && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending}
                  data-testid="button-preview-forecast-accuracy"
                  className="gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  {previewMut.isPending ? 'Loading…' : 'Preview'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendNowMut.mutate()}
                  disabled={sendNowMut.isPending || !sched.enabled || sched.recipients.length === 0}
                  data-testid="button-send-forecast-accuracy-now"
                >
                  {sendNowMut.isPending ? 'Sending…' : 'Send now'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { if (confirm('Remove the forecast accuracy email schedule?')) deleteMut.mutate(); }}
                  disabled={deleteMut.isPending}
                  data-testid="button-delete-forecast-accuracy-schedule"
                  className="text-rose-500 hover:text-rose-600"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          {sched && (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted text-[10px] text-muted-foreground uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-2 py-1.5">Sent</th>
                    <th className="text-left px-2 py-1.5">Period</th>
                    <th className="text-left px-2 py-1.5">Rows</th>
                    <th className="text-left px-2 py-1.5">Recipients</th>
                    <th className="text-left px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={5} className="px-2 py-3 text-center text-muted-foreground" data-testid="forecast-accuracy-history-empty">No accuracy emails sent yet.</td></tr>
                  ) : history.map(h => {
                    const tone = h.status === 'sent' ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30'
                      : h.status === 'failed' ? 'bg-red-500/20 text-red-700 border-red-500/30'
                      : 'bg-amber-500/20 text-amber-700 border-amber-500/30';
                    return (
                      <tr key={h.id} className="border-t" data-testid={`forecast-accuracy-history-row-${h.id}`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                        <td className="px-2 py-1.5">{h.rowCount}</td>
                        <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                          {h.recipients.length} ({h.recipients.join(', ')})
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge className={`${tone} border text-[10px]`}>{h.status}</Badge>
                          {h.errorMessage && <div className="text-[10px] text-rose-500 mt-1 truncate max-w-[14rem]" title={h.errorMessage}>{h.errorMessage}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl" data-testid="dialog-forecast-accuracy-preview">
          <DialogHeader>
            <DialogTitle>Preview — next forecast accuracy email</DialogTitle>
          </DialogHeader>
          {previewMut.data && (
            <div className="space-y-3 max-h-[70vh] overflow-y-auto">
              <p className="text-xs text-muted-foreground">
                This is what the next scheduled email would look like if sent right now. Nothing has been sent and no run was recorded.
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject</div>
                  <div data-testid="text-forecast-accuracy-preview-subject">{previewMut.data.subject}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Recipients</div>
                  <div data-testid="text-forecast-accuracy-preview-recipients">
                    {previewMut.data.recipients.length === 0 ? '—' : previewMut.data.recipients.join(', ')}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Period</div>
                  <div>
                    {new Date(previewMut.data.periodStart).toLocaleString()} → {new Date(previewMut.data.periodEnd).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">CSV contents</div>
                  <div data-testid="text-forecast-accuracy-preview-counts">
                    <span className="text-emerald-600 font-semibold">{previewMut.data.rowCount}</span> window{previewMut.data.rowCount === 1 ? '' : 's'}
                    <span className="text-muted-foreground"> · </span>
                    <span className="text-emerald-600 font-semibold" data-testid="text-forecast-accuracy-preview-per-day-count">{previewMut.data.perDayRowCount}</span> per-day row{previewMut.data.perDayRowCount === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
              <div data-testid="forecast-accuracy-preview-csv-sample">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  CSV sample ({previewMut.data.filename})
                </div>
                <pre className="border rounded-md bg-muted text-[11px] leading-snug font-mono p-2 overflow-x-auto whitespace-pre">
{[previewMut.data.csvSample.header, ...previewMut.data.csvSample.rows].join('\n') || '(empty)'}
                </pre>
                <div className="text-[10px] text-muted-foreground mt-1" data-testid="forecast-accuracy-preview-csv-footer">
                  Showing {previewMut.data.csvSample.sampleSize} of {previewMut.data.csvSample.totalRows} row{previewMut.data.csvSample.totalRows === 1 ? '' : 's'}
                  {previewMut.data.csvSample.totalRows > previewMut.data.csvSample.sampleSize ? ' (sample truncated)' : ''}.
                </div>
              </div>
              <div data-testid="forecast-accuracy-preview-per-day-csv-sample">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  Per-day CSV sample ({previewMut.data.perDayFilename})
                </div>
                {previewMut.data.perDayCsvSample.totalRows === 0 ? (
                  <div
                    className="border rounded-md bg-muted/40 text-[11px] text-muted-foreground p-3 text-center"
                    data-testid="forecast-accuracy-preview-per-day-csv-empty"
                  >
                    No per-day rows for this period yet — the companion sheet will populate once forecasts in the window have elapsed days to score.
                  </div>
                ) : (
                  <>
                    <pre className="border rounded-md bg-muted text-[11px] leading-snug font-mono p-2 overflow-x-auto whitespace-pre">
{[previewMut.data.perDayCsvSample.header, ...previewMut.data.perDayCsvSample.rows].join('\n')}
                    </pre>
                    <div className="text-[10px] text-muted-foreground mt-1" data-testid="forecast-accuracy-preview-per-day-csv-footer">
                      Showing {previewMut.data.perDayCsvSample.sampleSize} of {previewMut.data.perDayCsvSample.totalRows} row{previewMut.data.perDayCsvSample.totalRows === 1 ? '' : 's'}
                      {previewMut.data.perDayCsvSample.totalRows > previewMut.data.perDayCsvSample.sampleSize ? ' (sample truncated)' : ''}.
                    </div>
                  </>
                )}
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Rendered body</div>
                <div className="border rounded-md bg-white overflow-hidden">
                  <iframe
                    title="Email body preview"
                    srcDoc={previewMut.data.html}
                    sandbox=""
                    className="w-full h-[420px] bg-white"
                    data-testid="iframe-forecast-accuracy-preview-body"
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(false)} data-testid="button-close-forecast-accuracy-preview">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
