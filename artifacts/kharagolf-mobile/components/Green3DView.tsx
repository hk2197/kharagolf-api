import React, { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, Dimensions } from "react-native";
import Svg, { G, Polygon, Line, Circle, Text as SvgText, Defs, LinearGradient, Stop } from "react-native-svg";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";

/**
 * Green3DView — Task #358
 *
 * Renders a 3D isometric projection of a green's contour grid with:
 *   • slope severity colouring (green = flat, yellow = moderate, red = steep)
 *   • a tap-selectable ball position
 *   • a putt-break arrow pointing in the direction the ball will roll based on
 *     the local downhill gradient between the selected ball position and the pin.
 *
 * Gracefully degrades to a 2D message when contour data is unavailable.
 */

export interface ContourData {
  rows: number;
  cols: number;
  cellMeters: number | string;
  elevations: number[]; // length = rows * cols, row-major
}

interface Props {
  visible: boolean;
  onClose: () => void;
  holeNumber: number;
  contour: ContourData | null;
  loading?: boolean;
  /** Pin position in grid coords (col, row). Defaults to centre. */
  pinCell?: { col: number; row: number };
}

const ISO_ANGLE = Math.PI / 6; // 30°
const COS_A = Math.cos(ISO_ANGLE);
const SIN_A = Math.sin(ISO_ANGLE);

function slopeColor(slope: number): string {
  // slope is in metres per metre (rise/run). 0.02 ~ subtle, 0.05+ severe.
  const s = Math.min(Math.abs(slope), 0.08);
  const t = s / 0.08;
  if (t < 0.5) {
    // Green → Yellow
    const k = t / 0.5;
    const r = Math.round(0x22 + (0xeb - 0x22) * k);
    const g = Math.round(0xc5 + (0xe0 - 0xc5) * k);
    const b = Math.round(0x5e + (0x4b - 0x5e) * k);
    return `rgb(${r},${g},${b})`;
  } else {
    // Yellow → Red
    const k = (t - 0.5) / 0.5;
    const r = Math.round(0xeb + (0xdc - 0xeb) * k);
    const g = Math.round(0xe0 + (0x26 - 0xe0) * k);
    const b = Math.round(0x4b + (0x26 - 0x4b) * k);
    return `rgb(${r},${g},${b})`;
  }
}

export default function Green3DView({ visible, onClose, holeNumber, contour, loading, pinCell }: Props) {
  const screen = Dimensions.get("window");
  const W = screen.width;
  const H = Math.min(screen.height * 0.6, 480);

  const cellMeters = typeof contour?.cellMeters === "string" ? parseFloat(contour.cellMeters) : (contour?.cellMeters ?? 1.5);

  // Tap-selectable ball position (defaults to bottom-centre cell of grid)
  const defaultBall = useMemo(
    () => contour ? { col: Math.floor(contour.cols / 2), row: contour.rows - 1 } : null,
    [contour],
  );
  const [ball, setBall] = useState<{ col: number; row: number } | null>(defaultBall);
  React.useEffect(() => { setBall(defaultBall); }, [defaultBall]);

  const pin = useMemo(
    () => pinCell ?? (contour ? { col: Math.floor(contour.cols / 2), row: Math.floor(contour.rows / 2) } : null),
    [pinCell, contour],
  );

  // ─── Project a (col, row, elevation) point to screen coordinates ────────
  const project = useMemo(() => {
    if (!contour) return null;
    const { rows, cols, elevations } = contour;
    const elevMin = Math.min(...elevations);
    const elevMax = Math.max(...elevations);
    const elevRange = Math.max(elevMax - elevMin, 0.01);

    // Pixel scale: fit grid into viewport with margin
    const scale = Math.min((W * 0.85) / (cols * COS_A * 2), (H * 0.6) / (rows * SIN_A * 2 + 60));
    const elevPx = scale * 4; // exaggerate vertical to make slope visible
    const cx = W / 2;
    const cy = H * 0.55;

    // Bilinearly interpolate elevation so non-integer (col,row) — produced by
    // the break-arrow endpoint — never returns undefined / NaN.
    const sampleElev = (col: number, row: number): number => {
      const cc = Math.max(0, Math.min(cols - 1, col));
      const rr = Math.max(0, Math.min(rows - 1, row));
      const c0 = Math.floor(cc), c1 = Math.min(cols - 1, c0 + 1);
      const r0 = Math.floor(rr), r1 = Math.min(rows - 1, r0 + 1);
      const fc = cc - c0, fr = rr - r0;
      const e00 = elevations[r0 * cols + c0];
      const e10 = elevations[r0 * cols + c1];
      const e01 = elevations[r1 * cols + c0];
      const e11 = elevations[r1 * cols + c1];
      return (
        e00 * (1 - fc) * (1 - fr) +
        e10 * fc * (1 - fr) +
        e01 * (1 - fc) * fr +
        e11 * fc * fr
      );
    };

    return (col: number, row: number) => {
      const e = sampleElev(col, row);
      const eNorm = (e - elevMin) / elevRange;
      const x = cx + (col - cols / 2 - (row - rows / 2)) * COS_A * scale;
      const y = cy + (col - cols / 2 + (row - rows / 2)) * SIN_A * scale - eNorm * elevPx;
      return { x, y, elev: e };
    };
  }, [contour, W, H]);

  // ─── Build polygons for each cell ───────────────────────────────────────
  const polys = useMemo(() => {
    if (!contour || !project) return [] as { points: string; color: string; col: number; row: number }[];
    const { rows, cols, elevations } = contour;
    const out: { points: string; color: string; col: number; row: number }[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const p00 = project(c, r);
        const p10 = project(c + 1, r);
        const p11 = project(c + 1, r + 1);
        const p01 = project(c, r + 1);
        // local slope magnitude (max of two diagonals)
        const dz1 = Math.abs(elevations[r * cols + (c + 1)] - elevations[r * cols + c]) / cellMeters;
        const dz2 = Math.abs(elevations[(r + 1) * cols + c] - elevations[r * cols + c]) / cellMeters;
        const slope = Math.max(dz1, dz2);
        out.push({
          points: `${p00.x},${p00.y} ${p10.x},${p10.y} ${p11.x},${p11.y} ${p01.x},${p01.y}`,
          color: slopeColor(slope),
          col: c, row: r,
        });
      }
    }
    return out;
  }, [contour, project, cellMeters]);

  // ─── Compute break vector from ball → pin via downhill gradient ────────
  const breakArrow = useMemo(() => {
    if (!contour || !project || !ball || !pin) return null;
    const { rows, cols, elevations } = contour;
    // Simple model: break direction = downhill gradient at ball position.
    // Magnitude ~ proportional to slope * distance to pin (rough heuristic).
    const sample = (c: number, r: number) =>
      elevations[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
    const dEdC = (sample(ball.col + 1, ball.row) - sample(ball.col - 1, ball.row)) / (2 * cellMeters);
    const dEdR = (sample(ball.col, ball.row + 1) - sample(ball.col, ball.row - 1)) / (2 * cellMeters);
    // Downhill = -gradient
    const gx = -dEdC, gy = -dEdR;
    const mag = Math.sqrt(gx * gx + gy * gy);
    if (mag < 0.005) return { startCol: ball.col, startRow: ball.row, endCol: ball.col, endRow: ball.row, severity: "flat" as const };
    const distCells = Math.sqrt((pin.col - ball.col) ** 2 + (pin.row - ball.row) ** 2);
    // Break extent in cells, capped
    const breakLen = Math.min(distCells * mag * 8, distCells * 0.5);
    const endCol = ball.col + (gx / mag) * breakLen;
    const endRow = ball.row + (gy / mag) * breakLen;
    const severity = mag < 0.015 ? "subtle" : mag < 0.04 ? "moderate" : "severe";
    return { startCol: ball.col, startRow: ball.row, endCol, endRow, severity, mag };
  }, [contour, project, ball, pin, cellMeters]);

  const breakArrowScreen = useMemo(() => {
    if (!breakArrow || !project) return null;
    const a = project(breakArrow.startCol, breakArrow.startRow);
    const b = project(breakArrow.endCol, breakArrow.endRow);
    return { a, b, severity: breakArrow.severity, mag: breakArrow.mag };
  }, [breakArrow, project]);

  const ballScreen = (ball && project) ? project(ball.col, ball.row) : null;
  const pinScreen = (pin && project) ? project(pin.col, pin.row) : null;

  // ─── Tap handler: pick nearest grid cell ───────────────────────────────
  const onTap = (locationX: number, locationY: number) => {
    if (!contour || !project) return;
    let bestD = Infinity, bestCol = 0, bestRow = 0;
    for (let r = 0; r < contour.rows; r++) {
      for (let c = 0; c < contour.cols; c++) {
        const p = project(c, r);
        const d = (p.x - locationX) ** 2 + (p.y - locationY) ** 2;
        if (d < bestD) { bestD = d; bestCol = c; bestRow = r; }
      }
    }
    setBall({ col: bestCol, row: bestRow });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Hole {holeNumber} — 3D Green</Text>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
            <Feather name="x" size={22} color={Colors.text} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.loading}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={s.loadingText}>Loading green contour…</Text>
          </View>
        ) : !contour ? (
          <View style={s.fallback}>
            <Feather name="map" size={48} color={Colors.muted} />
            <Text style={s.fallbackTitle}>3D contour not available</Text>
            <Text style={s.fallbackBody}>
              Showing 2D map. Ask your course admin to upload green contour data so you can see slope and break.
            </Text>
          </View>
        ) : (
          <View>
            <Pressable onPress={(e) => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}>
              <Svg width={W} height={H} style={s.svg}>
                <Defs>
                  <LinearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor="#1a1a1a" />
                    <Stop offset="1" stopColor="#0a0a0a" />
                  </LinearGradient>
                </Defs>
                <G>
                  {polys.map((p, i) => (
                    <Polygon key={i} points={p.points} fill={p.color} stroke="rgba(0,0,0,0.25)" strokeWidth={0.5} />
                  ))}

                  {/* Break arrow */}
                  {breakArrowScreen && breakArrowScreen.severity !== "flat" && (
                    <>
                      <Line
                        x1={breakArrowScreen.a.x} y1={breakArrowScreen.a.y}
                        x2={breakArrowScreen.b.x} y2={breakArrowScreen.b.y}
                        stroke="#fff" strokeWidth={3} strokeLinecap="round" />
                      <Circle cx={breakArrowScreen.b.x} cy={breakArrowScreen.b.y} r={5} fill="#fff" />
                    </>
                  )}

                  {/* Pin */}
                  {pinScreen && (
                    <>
                      <Line x1={pinScreen.x} y1={pinScreen.y} x2={pinScreen.x} y2={pinScreen.y - 22} stroke="#fff" strokeWidth={1.5} />
                      <Polygon points={`${pinScreen.x},${pinScreen.y - 22} ${pinScreen.x + 10},${pinScreen.y - 18} ${pinScreen.x},${pinScreen.y - 14}`} fill="#dc2626" />
                      <Circle cx={pinScreen.x} cy={pinScreen.y} r={3} fill="#000" />
                    </>
                  )}

                  {/* Ball */}
                  {ballScreen && (
                    <Circle cx={ballScreen.x} cy={ballScreen.y} r={6} fill="#fff" stroke="#000" strokeWidth={1.5} />
                  )}
                </G>
              </Svg>
            </Pressable>

            <View style={s.legendRow}>
              <View style={s.legendItem}><View style={[s.legendSwatch, { backgroundColor: "rgb(34,197,94)" }]} /><Text style={s.legendText}>Flat</Text></View>
              <View style={s.legendItem}><View style={[s.legendSwatch, { backgroundColor: "rgb(235,224,75)" }]} /><Text style={s.legendText}>Moderate</Text></View>
              <View style={s.legendItem}><View style={[s.legendSwatch, { backgroundColor: "rgb(220,38,38)" }]} /><Text style={s.legendText}>Severe</Text></View>
            </View>

            <View style={s.infoBlock}>
              <Text style={s.infoTitle}>
                Break: {breakArrow?.severity ?? "—"}
                {breakArrow?.mag ? `  (${(breakArrow.mag * 100).toFixed(1)}% slope)` : ""}
              </Text>
              <Text style={s.infoBody}>Tap anywhere on the green to move your ball position. The arrow shows the direction the ball will break.</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 50, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  headerTitle: { color: Colors.text, fontSize: 16, fontWeight: "600" },
  closeBtn: { padding: 6 },
  svg: { backgroundColor: "#0a0a0a" },
  loading: { padding: 64, alignItems: "center", gap: 12 },
  loadingText: { color: Colors.muted, fontSize: 13 },
  fallback: { padding: 32, alignItems: "center", gap: 12 },
  fallbackTitle: { color: Colors.text, fontSize: 16, fontWeight: "600" },
  fallbackBody: { color: Colors.muted, fontSize: 13, textAlign: "center", lineHeight: 18 },
  legendRow: { flexDirection: "row", justifyContent: "center", gap: 24, paddingVertical: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 12, height: 12, borderRadius: 2 },
  legendText: { color: Colors.muted, fontSize: 11 },
  infoBlock: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 },
  infoTitle: { color: Colors.text, fontSize: 14, fontWeight: "600", marginBottom: 6 },
  infoBody: { color: Colors.muted, fontSize: 12, lineHeight: 16 },
});
