/**
 * PDFKit tournament results report generator.
 * Produces a professional A4 LANDSCAPE PDF with committee-style header,
 * summary statistics, prize winners, standings tables, and sponsor logos.
 */

import PDFDocument from "pdfkit";

export interface ReportOrg {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

export interface ReportTournament {
  name: string;
  format: string;
  coursePar: number;
  rounds: number;
  courseName?: string | null;
  date?: string | null;
  roundCourseAssignments?: { roundNumber: number; courseName: string | null }[];
}

export interface ReportRoundScore {
  round: number;
  grossScore: number;
  scoreToPar: number;
  isComplete: boolean;
}

export interface ReportEntry {
  positionDisplay: string;
  playerName: string;
  playingHandicap: number;
  grossScore: number | null;
  netScore: number | null;
  scoreToPar: number | null;
  stablefordPoints: number | null;
  holesCompleted: number;
  roundScores?: ReportRoundScore[];
}

export interface ReportSideGameWinner {
  gameType: string;
  holeNumber: number | null;
  firstName: string | null;
  lastName: string | null;
  prize: string | null;
  notes: string | null;
}

export interface ReportSponsor {
  name: string;
  tier: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
}

export interface TournamentReportData {
  org: ReportOrg;
  tournament: ReportTournament;
  entries: ReportEntry[];
  netEntries: ReportEntry[];
  sideGameWinners: ReportSideGameWinner[];
  sponsors: ReportSponsor[];
  isStableford: boolean;
}

// ── A4 Landscape dimensions ────────────────────────────────────────────────────
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 72;

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex ?? "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [30, 77, 43];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (host === "169.254.169.254") return false;
    if (host === "metadata.google.internal" || host.startsWith("metadata.")) return false;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".internal")) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchLogoBuffer(url: string | null): Promise<Buffer | null> {
  if (!url || !isSafeUrl(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 2 * 1024 * 1024) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function formatScore(toPar: number | null): string {
  if (toPar === null) return "-";
  if (toPar === 0) return "E";
  if (toPar > 0) return `+${toPar}`;
  return String(toPar);
}

function formatLabel(f: string): string {
  return f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export async function generateTournamentReportPDF(data: TournamentReportData): Promise<Buffer> {
  const [logoBuffer, ...sponsorBuffers] = await Promise.all([
    fetchLogoBuffer(data.org.logoUrl),
    ...data.sponsors.map(s => fetchLogoBuffer(s.logoUrl)),
  ]);
  const sponsorLogoMap = new Map<number, Buffer | null>(
    data.sponsors.map((s, i) => [i, sponsorBuffers[i] ?? null]),
  );

  const pc = hexToRgb(data.org.primaryColor ?? "#1e4d2b");
  const pcHex = data.org.primaryColor ?? "#1e4d2b";

  // ── Pre-compute summary stats from entries ──────────────────────────────────
  const fieldSize = data.entries.length;
  const completed = data.entries.filter(e => e.holesCompleted >= 18);
  const grossScores = completed.filter(e => e.grossScore !== null).map(e => e.grossScore as number);
  const avgGross = grossScores.length > 0
    ? (grossScores.reduce((a, b) => a + b, 0) / grossScores.length).toFixed(1)
    : null;
  const bestGrossEntry = completed.find(e => e.grossScore !== null) ?? data.entries[0] ?? null;

  const sfScores = completed.filter(e => e.stablefordPoints !== null).map(e => e.stablefordPoints as number);
  const avgSf = sfScores.length > 0
    ? (sfScores.reduce((a, b) => a + b, 0) / sfScores.length).toFixed(1)
    : null;

  // ── Group side games ────────────────────────────────────────────────────────
  const groupedSideGames: Record<string, ReportSideGameWinner[]> = {};
  for (const w of data.sideGameWinners) {
    if (!groupedSideGames[w.gameType]) groupedSideGames[w.gameType] = [];
    groupedSideGames[w.gameType].push(w);
  }
  const sideGameLabels: Record<string, string> = {
    ctp: "Closest to Pin",
    ld: "Longest Drive",
    greenie: "Greenie",
  };

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Committee-style header bar ─────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, HEADER_H).fill(pc);

    // Left: org logo + name
    let headerTextX = MARGIN;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, MARGIN, 12, { height: 48 });
        headerTextX = MARGIN + 58;
      } catch { /* skip */ }
    }
    doc.fillColor("#ffffff").fontSize(18).font("Helvetica-Bold")
      .text(data.org.name.toUpperCase(), headerTextX, 14, { width: PAGE_W * 0.45, lineBreak: false });
    const hasMultiCourse = (data.tournament.roundCourseAssignments?.length ?? 0) > 1 &&
      new Set(data.tournament.roundCourseAssignments!.map(r => r.courseName).filter(Boolean)).size > 1;
    if (hasMultiCourse) {
      const rcLabel = data.tournament.roundCourseAssignments!
        .map(r => `R${r.roundNumber}: ${r.courseName ?? "TBD"}`)
        .join("  ·  ");
      doc.fillColor("rgba(255,255,255,0.7)").fontSize(8).font("Helvetica")
        .text(rcLabel, headerTextX, 36, { lineBreak: false });
    } else if (data.tournament.courseName) {
      doc.fillColor("rgba(255,255,255,0.7)").fontSize(9).font("Helvetica")
        .text(data.tournament.courseName, headerTextX, 36, { lineBreak: false });
    }
    const courseLineExists = hasMultiCourse || !!data.tournament.courseName;
    doc.fillColor("rgba(255,255,255,0.55)").fontSize(8).font("Helvetica")
      .text("Tournament Results Report", headerTextX, courseLineExists ? 50 : 38, { lineBreak: false });

    // Right: report label + generated date
    const rightX = PAGE_W * 0.75;
    const rightW = PAGE_W - rightX - MARGIN;
    doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
      .text("OFFICIAL RESULTS", rightX, 18, { width: rightW, align: "right", lineBreak: false });
    doc.fillColor("rgba(255,255,255,0.7)").fontSize(8).font("Helvetica")
      .text(`Generated: ${today}`, rightX, 34, { width: rightW, align: "right", lineBreak: false });
    if (data.tournament.date) {
      doc.fillColor("rgba(255,255,255,0.6)").fontSize(8)
        .text(`Tournament Date: ${data.tournament.date}`, rightX, 48, { width: rightW, align: "right", lineBreak: false });
    }

    doc.y = HEADER_H + 10;

    // ── Tournament title block ─────────────────────────────────────────────────
    const titleY = doc.y;
    doc.fillColor("#111827").fontSize(16).font("Helvetica-Bold")
      .text(data.tournament.name, MARGIN, titleY, { width: CONTENT_W * 0.65, lineBreak: false });
    const metaParts = [
      formatLabel(data.tournament.format),
      `${data.tournament.rounds} Round${data.tournament.rounds > 1 ? "s" : ""}`,
      `Par ${data.tournament.coursePar}`,
    ];
    doc.fillColor("#6b7280").fontSize(9).font("Helvetica")
      .text(metaParts.join("  ·  "), MARGIN, titleY + 22, { width: CONTENT_W * 0.65, lineBreak: false });
    doc.y = titleY + 42;

    // ── Summary statistics bar ────────────────────────────────────────────────
    const statBarY = doc.y;
    const statBarH = 32;
    doc.rect(MARGIN, statBarY, CONTENT_W, statBarH).fill("#f3f4f6");
    doc.rect(MARGIN, statBarY, 4, statBarH).fill(pcHex);

    const stats: Array<{ label: string; value: string }> = [
      { label: "FIELD SIZE", value: String(fieldSize) },
    ];
    if (data.isStableford) {
      if (avgSf !== null) stats.push({ label: "AVG POINTS", value: avgSf });
      if (bestGrossEntry && bestGrossEntry.stablefordPoints !== null)
        stats.push({ label: "BEST POINTS", value: `${bestGrossEntry.stablefordPoints} — ${bestGrossEntry.playerName}` });
    } else {
      if (avgGross !== null) stats.push({ label: "AVG GROSS", value: avgGross });
      if (bestGrossEntry && bestGrossEntry.grossScore !== null)
        stats.push({ label: "BEST GROSS", value: `${bestGrossEntry.grossScore} (${formatScore(bestGrossEntry.scoreToPar)}) — ${bestGrossEntry.playerName}` });
    }
    if (data.netEntries.length > 0 && !data.isStableford) {
      const bestNet = data.netEntries[0];
      if (bestNet?.netScore !== null)
        stats.push({ label: "BEST NET", value: `${bestNet?.netScore} — ${bestNet?.playerName}` });
    }
    stats.push({ label: "FINISHERS", value: String(completed.length) });

    const statSlotW = CONTENT_W / stats.length;
    for (let i = 0; i < stats.length; i++) {
      const sx = MARGIN + i * statSlotW + 12;
      doc.fillColor("#9ca3af").fontSize(6.5).font("Helvetica-Bold")
        .text(stats[i].label, sx, statBarY + 6, { width: statSlotW - 16, lineBreak: false });
      doc.fillColor("#111827").fontSize(9).font("Helvetica-Bold")
        .text(stats[i].value, sx, statBarY + 17, { width: statSlotW - 16, lineBreak: false });
    }
    doc.y = statBarY + statBarH + 10;

    // ── Section header helper ─────────────────────────────────────────────────
    function sectionHeader(title: string) {
      if (doc.y > PAGE_H - 100) { doc.addPage(); doc.y = MARGIN; }
      const hy = doc.y;
      doc.rect(MARGIN, hy, CONTENT_W, 20).fill(pcHex);
      doc.fillColor("#ffffff").fontSize(8.5).font("Helvetica-Bold")
        .text(title.toUpperCase(), MARGIN + 10, hy + 6, { width: CONTENT_W - 20, lineBreak: false });
      doc.y = hy + 24;
    }

    // ── Prize Winners ─────────────────────────────────────────────────────────
    const hasPodium = data.entries.length > 0;
    const hasSideGames = data.sideGameWinners.length > 0;

    if (hasPodium || hasSideGames) {
      sectionHeader("Prize Winners");

      // Podium — top 3
      const medals = ["🥇", "🥈", "🥉"];
      const placements = ["1st Place", "2nd Place", "3rd Place"];
      const podium = data.entries.slice(0, Math.min(3, data.entries.length));

      const colW1 = 130; const colW2 = 220; const colW3 = 180;
      for (let i = 0; i < podium.length; i++) {
        const e = podium[i];
        const score = data.isStableford
          ? (e.stablefordPoints !== null ? `${e.stablefordPoints} pts` : "")
          : e.grossScore !== null ? `${e.grossScore} gross  ${formatScore(e.scoreToPar)}` : "";

        if (doc.y > PAGE_H - 60) { doc.addPage(); doc.y = MARGIN; }
        const ry = doc.y;
        doc.fillColor(pcHex).fontSize(9).font("Helvetica-Bold")
          .text(`${medals[i]}  ${placements[i]}`, MARGIN + 8, ry, { width: colW1, lineBreak: false });
        doc.fillColor("#111827").fontSize(9).font("Helvetica-Bold")
          .text(e.playerName, MARGIN + 8 + colW1, ry, { width: colW2, lineBreak: false });
        doc.fillColor("#6b7280").fontSize(9).font("Helvetica")
          .text(score, MARGIN + 8 + colW1 + colW2, ry, { width: colW3, lineBreak: false });
        doc.y = ry + 15;
      }

      // Side game special awards
      if (hasSideGames) {
        doc.moveDown(0.3);
        for (const [type, winners] of Object.entries(groupedSideGames)) {
          const label = sideGameLabels[type] ?? formatLabel(type);
          for (const w of winners) {
            const name = [w.firstName, w.lastName].filter(Boolean).join(" ") || "—";
            const holeInfo = w.holeNumber ? ` – Hole ${w.holeNumber}` : "";
            const prizeInfo = w.prize ? `  ·  ${w.prize}` : "";
            if (doc.y > PAGE_H - 60) { doc.addPage(); doc.y = MARGIN; }
            const ry = doc.y;
            doc.fillColor(pcHex).fontSize(9).font("Helvetica-Bold")
              .text(`🏆  ${label}${holeInfo}`, MARGIN + 8, ry, { width: colW1 + colW2 * 0.4, lineBreak: false });
            doc.fillColor("#111827").fontSize(9).font("Helvetica")
              .text(`${name}${prizeInfo}`, MARGIN + 8 + colW1 + colW2 * 0.4, ry, { width: colW2 * 0.6 + colW3, lineBreak: false });
            doc.y = ry + 15;
          }
        }
      }
      doc.moveDown(0.5);
    }

    // ── Gross / Stableford standings ─────────────────────────────────────────
    sectionHeader(data.isStableford ? "Stableford Standings" : "Gross Score Standings");
    drawLeaderboardTable(doc, data.entries, data.isStableford, false, pcHex);
    doc.moveDown(0.5);

    if (data.netEntries && data.netEntries.length > 0 && !data.isStableford) {
      if (doc.y > PAGE_H - 100) doc.addPage();
      sectionHeader("Net Score Standings");
      drawLeaderboardTable(doc, data.netEntries, false, true, pcHex);
      doc.moveDown(0.5);
    }

    // ── Cumulative Round-by-Round Breakdown (multi-round only) ────────────────
    const rounds = data.tournament.rounds ?? 1;
    const cumulativeEntries = data.entries.filter(e => (e.roundScores?.length ?? 0) > 0);
    if (rounds > 1 && cumulativeEntries.length > 0 && !data.isStableford) {
      if (doc.y > PAGE_H - 100) doc.addPage();
      sectionHeader(`Cumulative Standings — ${rounds}-Round Breakdown`);

      const colPos = 36; const colName = 160; const colHcp = 36;
      const colRndW = Math.min(60, Math.floor((CONTENT_W - colPos - colName - colHcp - 50) / rounds));
      const colTot = 54;

      // Table header row
      const thY = doc.y;
      doc.rect(MARGIN, thY, CONTENT_W, 16).fill("#f3f4f6");
      const labels = ["POS", "PLAYER", "HCP", ...Array.from({ length: rounds }, (_, i) => `R${i + 1}`), "TOTAL"];
      const colStarts = [
        MARGIN + 2, MARGIN + colPos + 4, MARGIN + colPos + colName + 4,
        ...Array.from({ length: rounds }, (_, i) => MARGIN + colPos + colName + colHcp + i * colRndW + 4),
        MARGIN + colPos + colName + colHcp + rounds * colRndW + 4,
      ];
      for (let i = 0; i < labels.length; i++) {
        doc.fillColor("#6b7280").fontSize(6.5).font("Helvetica-Bold")
          .text(labels[i], colStarts[i], thY + 5, { width: i === 1 ? colName : 50, lineBreak: false, align: i === 0 ? "center" : "left" });
      }
      doc.y = thY + 18;

      cumulativeEntries.slice(0, 24).forEach((entry, idx) => {
        if (doc.y > PAGE_H - 40) { doc.addPage(); doc.y = MARGIN; }
        const ry = doc.y;
        if (idx % 2 === 0) doc.rect(MARGIN, ry, CONTENT_W, 14).fill("#fafafa");
        doc.rect(MARGIN, ry, CONTENT_W, 14).stroke("#e5e7eb");

        doc.fillColor("#6b7280").fontSize(7.5).font("Helvetica-Bold")
          .text(entry.positionDisplay, colStarts[0], ry + 4, { width: colPos, lineBreak: false, align: "center" });
        doc.fillColor("#111827").fontSize(7.5).font("Helvetica-Bold")
          .text(entry.playerName, colStarts[1], ry + 4, { width: colName - 4, lineBreak: false });
        doc.fillColor("#9ca3af").fontSize(7).font("Helvetica")
          .text(String(entry.playingHandicap), colStarts[2], ry + 4, { width: colHcp, lineBreak: false });

        let cumToPar = 0;
        for (let r = 0; r < rounds; r++) {
          const rs = (entry.roundScores ?? []).find(s => s.round === r + 1);
          const rx = colStarts[3 + r];
          if (rs && rs.isComplete) {
            cumToPar += rs.scoreToPar;
            const rStr = rs.scoreToPar === 0 ? "E" : rs.scoreToPar > 0 ? `+${rs.scoreToPar}` : `${rs.scoreToPar}`;
            const rCol = rs.scoreToPar < 0 ? "#dc2626" : rs.scoreToPar > 0 ? "#3b82f6" : "#111827";
            doc.fillColor(rCol).fontSize(7.5).font("Helvetica")
              .text(rStr, rx, ry + 4, { width: colRndW, lineBreak: false });
          } else {
            doc.fillColor("#d1d5db").fontSize(7.5).font("Helvetica")
              .text("–", rx, ry + 4, { width: colRndW, lineBreak: false });
          }
        }

        const totStr = entry.scoreToPar === null ? "–" : entry.scoreToPar === 0 ? "E" : entry.scoreToPar > 0 ? `+${entry.scoreToPar}` : `${entry.scoreToPar}`;
        const totCol = (entry.scoreToPar ?? 0) < 0 ? "#dc2626" : (entry.scoreToPar ?? 0) > 0 ? "#3b82f6" : "#111827";
        doc.fillColor(totCol).fontSize(7.5).font("Helvetica-Bold")
          .text(totStr, colStarts[3 + rounds], ry + 4, { width: colTot, lineBreak: false });
        doc.y = ry + 15;
      });
      doc.moveDown(0.5);
    }

    // ── Sponsors section ──────────────────────────────────────────────────────
    if (data.sponsors.length > 0) {
      if (doc.y > PAGE_H - 160) doc.addPage();
      sectionHeader("Tournament Sponsors");

      const tierOrder = ["title", "presenting", "gold", "silver", "bronze"];
      const tierLabels: Record<string, string> = {
        title: "Title Sponsor", presenting: "Presenting Sponsors",
        gold: "Gold Sponsors", silver: "Silver Sponsors", bronze: "Bronze Sponsors",
      };
      const tierLogoHeights: Record<string, number> = { title: 60, presenting: 45, gold: 40, silver: 30 };

      for (const tier of tierOrder) {
        const ts = data.sponsors.filter(s => s.tier === tier);
        if (ts.length === 0) continue;

        if (doc.y > PAGE_H - 80) doc.addPage();
        const tierY = doc.y;
        doc.fillColor("#6b7280").fontSize(7.5).font("Helvetica-Bold")
          .text((tierLabels[tier] ?? tier).toUpperCase(), MARGIN + 8, tierY, { lineBreak: false });
        doc.y = tierY + 12;

        const logoH = tierLogoHeights[tier] ?? 0;

        for (const s of ts) {
          const sIdx = data.sponsors.indexOf(s);
          const buf = sponsorLogoMap.get(sIdx) ?? null;
          if (doc.y > PAGE_H - 60) doc.addPage();

          if (buf && logoH > 0) {
            try {
              const imgY = doc.y;
              doc.image(buf, MARGIN + 8, imgY, { height: logoH });
              if (s.name) {
                doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold")
                  .text(s.name, MARGIN + 8 + Math.ceil(logoH * 2.2), imgY + logoH / 2 - 5, { width: 200, lineBreak: false });
              }
              doc.y = imgY + logoH + 6;
            } catch {
              doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold")
                .text(s.name, MARGIN + 8, doc.y, { lineBreak: false });
              doc.y += 14;
            }
          } else {
            const nameFont = tier === "bronze" ? "Helvetica" : "Helvetica-Bold";
            const nameSize = tier === "title" ? 13 : tier === "presenting" ? 12 : 10;
            doc.fillColor("#374151").fontSize(nameSize).font(nameFont)
              .text(s.name, MARGIN + 8, doc.y, { lineBreak: false });
            doc.y += nameSize + 4;
          }
        }
        doc.y += 6;
      }
    }

    // ── Footer on each page ──────────────────────────────────────────────────
    const footerY = PAGE_H - 22;
    doc.rect(0, footerY - 6, PAGE_W, 28).fill("#f9fafb");
    doc.fillColor("#9ca3af").fontSize(7).font("Helvetica")
      .text(
        `${data.org.name}  ·  Official Tournament Results  ·  Powered by KHARAGOLF Enterprise  ·  ${today}`,
        MARGIN, footerY, { width: CONTENT_W, align: "center", lineBreak: false },
      );

    doc.end();
  });
}

function drawLeaderboardTable(
  doc: InstanceType<typeof PDFDocument>,
  entries: ReportEntry[],
  isStableford: boolean,
  isNet: boolean,
  accentHex: string,
) {
  // Dynamic player column width to fill CONTENT_W
  const c0 = 50; const c2 = 58; const c3 = 88; const c4 = 84; const c5 = 72;
  const c1 = CONTENT_W - c0 - c2 - c3 - c4 - c5;
  const colWidths = [c0, c1, c2, c3, c4, c5];
  const cols = [
    "Pos", "Player", "HCP",
    isStableford ? "Points" : (isNet ? "Net" : "Gross"),
    isStableford ? "—" : "To Par",
    "Thru",
  ];
  const rowH = 16;
  const startX = MARGIN;

  // Header row
  let rowY = doc.y;
  doc.rect(startX, rowY, CONTENT_W, rowH).fill("#e5e7eb");
  let cx = startX;
  for (let i = 0; i < cols.length; i++) {
    doc.fillColor("#374151").fontSize(7.5).font("Helvetica-Bold")
      .text(cols[i], cx + 4, rowY + 4, { width: colWidths[i] - 8, align: i >= 2 ? "center" : "left", lineBreak: false });
    cx += colWidths[i];
  }
  rowY += rowH;
  doc.y = rowY;

  const displayEntries = entries.slice(0, 40);
  for (let row = 0; row < displayEntries.length; row++) {
    if (rowY > PAGE_H - 50) { doc.addPage(); rowY = MARGIN; }
    const e = displayEntries[row];
    const bg = row % 2 === 0 ? "#ffffff" : "#f9fafb";
    doc.rect(startX, rowY, CONTENT_W, rowH).fill(bg);

    if (row < 3) {
      doc.rect(startX, rowY, 4, rowH).fill(accentHex);
    }

    cx = startX;
    const cells = [
      e.positionDisplay,
      e.playerName,
      String(e.playingHandicap),
      isStableford
        ? (e.stablefordPoints !== null ? String(e.stablefordPoints) : "-")
        : isNet
          ? (e.netScore !== null ? String(e.netScore) : "-")
          : (e.grossScore !== null ? String(e.grossScore) : "-"),
      isStableford ? "—" : formatScore(e.scoreToPar),
      e.holesCompleted >= 18 ? "F" : String(e.holesCompleted),
    ];

    for (let i = 0; i < cells.length; i++) {
      const isBold = i === 0 || (i === 3 && row === 0);
      doc.fillColor(row < 3 ? "#111827" : "#374151")
        .fontSize(8)
        .font(isBold ? "Helvetica-Bold" : "Helvetica")
        .text(cells[i], cx + 4, rowY + 4, { width: colWidths[i] - 8, align: i >= 2 ? "center" : "left", lineBreak: false });
      cx += colWidths[i];
    }
    rowY += rowH;
    doc.y = rowY;
  }

  if (entries.length > 40) {
    const moreLine = `… and ${entries.length - 40} more entries`;
    doc.fillColor("#9ca3af").fontSize(7).font("Helvetica")
      .text(moreLine, MARGIN + 6, doc.y + 2, { lineBreak: false });
    doc.y += 12;
  }
}
