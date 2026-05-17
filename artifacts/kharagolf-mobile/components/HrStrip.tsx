import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import Svg, { Rect, Line as SvgLine, Text as SvgText } from "react-native-svg";
import Colors from "@/constants/colors";
import { fetchPortal } from "@/utils/api";

export interface HrHole {
  holeNumber: number;
  count: number;
  avgHr: number;
  maxHr: number;
  avgStress: number | null;
}

export interface HrShot {
  shotNumber: number;
  hrBpm: number | null;
  stressScore: number | null;
  recordedAt: string;
}

export interface HrRound {
  holes: HrHole[];
  shots: { holeNumber: number; shots: HrShot[] }[];
  baselineHrBpm: number | null;
}

/**
 * Map a HR value to a colour stop on a green→amber→red gradient relative to
 * the player's baseline. Used by both the per-hole strip and the per-round
 * heat-strip on the stats screen.
 */
export function hrColor(hr: number, baseline: number | null): string {
  if (baseline == null) return "#3b82f6"; // blue when we have no baseline
  const delta = hr - baseline;
  if (delta < 5) return "#22c55e";
  if (delta < 15) return "#eab308";
  if (delta < 25) return "#f97316";
  return "#ef4444";
}

/** Per-hole strip: one bar per shot for a single hole. Used after each hole. */
export function HoleHrStrip({ shots, baseline }: { shots: HrShot[]; baseline: number | null }) {
  const filtered = shots.filter(s => s.hrBpm != null);
  if (!filtered.length) return null;
  const W = 280, H = 60, PAD = 6;
  const barW = (W - PAD * 2) / filtered.length;
  const allHrs = filtered.map(s => s.hrBpm!);
  const minHr = Math.min(...allHrs, baseline ?? Math.min(...allHrs));
  const maxHr = Math.max(...allHrs, baseline ?? Math.max(...allHrs));
  const range = Math.max(maxHr - minHr, 1);
  return (
    <View style={{ marginTop: 10, padding: 10, backgroundColor: "rgba(239,68,68,0.06)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.18)" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={{ color: "#ef4444", fontSize: 11, fontWeight: "700" }}>❤️  HEART RATE THIS HOLE</Text>
        <Text style={{ color: Colors.muted, fontSize: 11 }}>
          avg {Math.round(allHrs.reduce((a, b) => a + b, 0) / allHrs.length)} · max {Math.max(...allHrs)} bpm
        </Text>
      </View>
      <Svg width={W} height={H}>
        {baseline != null ? (
          <SvgLine
            x1={PAD}
            y1={H - PAD - ((baseline - minHr) / range) * (H - PAD * 2)}
            x2={W - PAD}
            y2={H - PAD - ((baseline - minHr) / range) * (H - PAD * 2)}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={1}
            strokeDasharray="3,3"
          />
        ) : null}
        {filtered.map((s, i) => {
          const h = ((s.hrBpm! - minHr) / range) * (H - PAD * 2);
          return (
            <Rect
              key={i}
              x={PAD + i * barW + 1}
              y={H - PAD - h}
              width={Math.max(barW - 2, 2)}
              height={Math.max(h, 2)}
              fill={hrColor(s.hrBpm!, baseline)}
              rx={2}
            />
          );
        })}
      </Svg>
      <Text style={{ color: Colors.muted, fontSize: 10, marginTop: 4 }}>
        Shot 1 → Shot {filtered.length}{baseline != null ? `  ·  baseline ${baseline} bpm` : ""}
      </Text>
    </View>
  );
}

/** Round-wide heat-strip: one cell per hole, coloured by avg HR. */
export function RoundHrHeatStrip({ holes, baseline }: { holes: HrHole[]; baseline: number | null }) {
  if (!holes.length) {
    return (
      <Text style={{ color: Colors.muted, fontSize: 12, fontStyle: "italic" }}>
        No HR samples recorded for this round yet.
      </Text>
    );
  }
  const W = 320, H = 38, PAD = 4;
  const cellW = (W - PAD * 2) / holes.length;
  return (
    <View>
      <Svg width={W} height={H}>
        {holes.map((h, i) => (
          <React.Fragment key={h.holeNumber}>
            <Rect
              x={PAD + i * cellW + 1}
              y={PAD}
              width={Math.max(cellW - 2, 4)}
              height={H - PAD * 2}
              fill={hrColor(h.avgHr, baseline)}
              rx={3}
            />
            <SvgText
              x={PAD + i * cellW + cellW / 2}
              y={H / 2 + 4}
              fontSize={9}
              fill="#0b1d12"
              fontWeight="700"
              textAnchor="middle"
            >{h.holeNumber}</SvgText>
          </React.Fragment>
        ))}
      </Svg>
    </View>
  );
}

/**
 * Self-contained per-hole strip that fetches its own data. Used by the
 * scoring screen so it can be rendered without the parent caring about
 * fetching/refreshing.
 */
export function AutoHoleHrStrip(props: {
  token: string | null;
  tournamentId: number;
  round: number;
  holeNumber: number;
}) {
  const [data, setData] = useState<HrRound | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!props.token) return;
    setLoading(true);
    fetchPortal<HrRound>(`/hr-samples/round?tournamentId=${props.tournamentId}&round=${props.round}`, props.token)
      .then(d => { if (alive) setData(d); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [props.token, props.tournamentId, props.round, props.holeNumber]);

  if (loading && !data) return <ActivityIndicator color={Colors.primary} style={{ marginTop: 8 }} />;
  if (!data) return null;
  const holeShots = data.shots.find(h => h.holeNumber === props.holeNumber)?.shots ?? [];
  if (!holeShots.length) return null;
  return <HoleHrStrip shots={holeShots} baseline={data.baselineHrBpm} />;
}
