import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface PocketScorecardOrg {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  website?: string;
}

export interface PocketScorecardTournament {
  name: string;
  courseName: string | null;
  date: string;
  round: number;
  format: string;
  localRules?: string | null;
  courseConditions?: string | null;
  qrCodeUrl?: string;
}

export interface PocketSponsor {
  id: number;
  name: string;
  tier: string;
  logoUrl: string | null;
  websiteUrl?: string | null;
}

export interface PocketHoleSponsor {
  holeNumber: number;
  sponsorName: string;
}

export interface PocketSideGames {
  ctpHoles: number[];
  ldHoles: number[];
  ctpSponsorName?: string | null;
  ldSponsorName?: string | null;
}

export interface PocketPlayerCard {
  playerName: string;
  handicapIndex: number;
  playingHandicap: number;
  teeBox: string;
  teeTime: string;
  startingHole: number;
  partners: { name: string; handicapIndex: number }[];
  holes: { hole: number; yards: number | null; par: number; strokeIndex: number | null }[];
}

export interface PocketScorecardData {
  organization: PocketScorecardOrg;
  tournament: PocketScorecardTournament;
  sponsors: PocketSponsor[];
  holeSponsors: PocketHoleSponsor[];
  sideGames: PocketSideGames;
  players: PocketPlayerCard[];
}

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const HALF_W = PAGE_W / 2;
const MARGIN = 18;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [30, 77, 43];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function drawDashedLine(doc: InstanceType<typeof PDFDocument>, x1: number, y1: number, x2: number, y2: number) {
  doc.save();
  doc.strokeColor("#999999").lineWidth(0.5).dash(4, { space: 3 });
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
  doc.restore();
}

function formatLabel(f: string): string {
  return f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function drawPanel1(doc: InstanceType<typeof PDFDocument>, player: PocketPlayerCard, data: PocketScorecardData, x: number, y: number, w: number, h: number, logoBuffer: Buffer | null, qrBuffer: Buffer | null) {
  const org = data.organization;
  const t = data.tournament;
  const pc = hexToRgb(org.primaryColor);

  doc.save();
  doc.rect(x, y, w, 28).fill(pc);

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + 6, y + 4, { height: 20 });
      doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold")
        .text(org.name.toUpperCase(), x + 30, y + 7, { width: w - 38, align: "center" });
    } catch {
      doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold")
        .text(org.name.toUpperCase(), x + 8, y + 7, { width: w - 16, align: "center" });
    }
  } else {
    doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold")
      .text(org.name.toUpperCase(), x + 8, y + 7, { width: w - 16, align: "center" });
  }

  let cy = y + 34;
  doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold")
    .text(t.name, x + 8, cy, { width: w - 16, align: "center" });
  cy += 18;

  doc.fontSize(8).font("Helvetica").fillColor("#444444");
  const meta = [t.courseName, t.date, `Round ${t.round}`, formatLabel(t.format)].filter(Boolean).join("  |  ");
  doc.text(meta, x + 8, cy, { width: w - 16, align: "center" });
  cy += 14;

  doc.moveTo(x + 12, cy).lineTo(x + w - 12, cy).strokeColor("#cccccc").lineWidth(0.5).stroke();
  cy += 8;

  doc.fillColor("#000000").fontSize(13).font("Helvetica-Bold")
    .text(player.playerName, x + 12, cy, { width: w - 24 });
  cy += 17;

  doc.fontSize(8).font("Helvetica").fillColor("#333333");
  doc.text(`HCP Index: ${player.handicapIndex}  ->  Playing HCP: ${player.playingHandicap}`, x + 12, cy, { width: w - 24 });
  cy += 12;
  doc.text(`Tee: ${player.teeBox.toUpperCase()}  |  Tee Time: ${player.teeTime}  |  Starting Hole: ${player.startingHole}`, x + 12, cy, { width: w - 24 });
  cy += 16;

  if (player.partners.length > 0) {
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#555555")
      .text("PLAYING WITH:", x + 12, cy, { width: w - 24 });
    cy += 10;
    doc.font("Helvetica").fontSize(7).fillColor("#333333");
    for (const p of player.partners) {
      doc.text(`${p.name}  (HCP ${p.handicapIndex})`, x + 16, cy, { width: w - 32 });
      cy += 9;
    }
  }

  if (data.tournament.courseConditions) {
    cy += 4;
    doc.moveTo(x + 12, cy).lineTo(x + w - 12, cy).strokeColor("#eeeeee").lineWidth(0.3).stroke();
    cy += 5;
    doc.fontSize(6).font("Helvetica-Bold").fillColor("#555555")
      .text("COURSE CONDITIONS", x + 12, cy, { width: w - 24 });
    cy += 8;
    doc.fontSize(6).font("Helvetica").fillColor("#444444")
      .text(data.tournament.courseConditions, x + 12, cy, { width: w - 24, lineGap: 1 });
    cy = doc.y + 4;
  }

  if (qrBuffer) {
    try {
      doc.image(qrBuffer, x + w - 52, y + h - 56, { width: 44 });
      doc.fontSize(5).font("Helvetica").fillColor("#999999")
        .text("Scan for live leaderboard", x + w - 58, y + h - 10, { width: 58, align: "right" });
    } catch { /* ignore */ }
  }

  const titleSponsor = data.sponsors.find(s => s.tier === "title");
  if (titleSponsor) {
    const bottomY = y + h - 22;
    doc.fontSize(6).font("Helvetica").fillColor("#999999")
      .text("Title Sponsor", x + 8, bottomY, { width: w - 16, align: "center" });
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#333333")
      .text(titleSponsor.name, x + 8, bottomY + 8, { width: w - 16, align: "center" });
  }

  doc.restore();
}

function drawPanel4(doc: InstanceType<typeof PDFDocument>, data: PocketScorecardData, x: number, y: number, w: number, h: number, sponsorLogoBuffers: Map<number, Buffer | null>) {
  const org = data.organization;
  let cy = y + 8;

  if (data.tournament.localRules) {
    doc.fillColor("#000000").fontSize(8).font("Helvetica-Bold")
      .text("LOCAL RULES", x + 10, cy, { width: w - 20 });
    cy += 12;
    doc.fontSize(6.5).font("Helvetica").fillColor("#333333")
      .text(data.tournament.localRules, x + 10, cy, { width: w - 20, lineGap: 1.5 });
    cy = doc.y + 10;
  }

  doc.moveTo(x + 10, cy).lineTo(x + w - 10, cy).strokeColor("#cccccc").lineWidth(0.5).stroke();
  cy += 8;

  doc.fillColor("#000000").fontSize(8).font("Helvetica-Bold")
    .text("SPONSORS", x + 10, cy, { width: w - 20 });
  cy += 12;

  const tierOrder = ["title", "presenting", "gold", "silver", "bronze"];
  const tierLabels: Record<string, string> = { title: "Title Sponsor", presenting: "Presenting Sponsors", gold: "Gold Sponsors", silver: "Silver Sponsors", bronze: "Bronze Sponsors" };
  // Logo heights per tier: title=60pt, presenting=45pt, gold=40pt, silver=30pt, bronze=text-only
  const tierLogoH: Record<string, number> = { title: 60, presenting: 45, gold: 40, silver: 30 };

  for (const tier of tierOrder) {
    const tierSponsors = data.sponsors.filter(s => s.tier === tier);
    if (tierSponsors.length === 0) continue;

    const nameSize = tier === "title" ? 9 : tier === "presenting" ? 8 : tier === "gold" ? 7.5 : 6.5;
    const logoH = tierLogoH[tier] ?? 0;

    doc.fontSize(5.5).font("Helvetica-Bold").fillColor("#888888")
      .text(tierLabels[tier]?.toUpperCase() ?? tier.toUpperCase(), x + 12, cy, { width: w - 24 });
    cy += 8;

    for (const s of tierSponsors) {
      if (cy > y + h - 30) break;
      const buf = sponsorLogoBuffers.get(s.id) ?? null;

      if (buf && logoH > 0) {
        // Draw logo image proportionally scaled to logoH
        try {
          doc.image(buf, x + 14, cy, { height: logoH });
          // Print name to the right of the logo
          const nameX = x + 14 + Math.ceil(logoH * 2.5); // rough width estimate
          if (nameX < x + w - 20) {
            doc.fontSize(nameSize - 1).font("Helvetica").fillColor("#555555")
              .text(s.name, nameX, cy + logoH / 2 - (nameSize - 1) / 2, { width: w - nameX + x - 8, lineBreak: false });
          }
          cy += logoH + 4;
        } catch {
          // Image invalid — fall back to text
          doc.fontSize(nameSize).font(tier === "bronze" ? "Helvetica" : "Helvetica-Bold").fillColor("#333333")
            .text(s.name, x + 14, cy, { width: w - 28 });
          cy += nameSize + 3;
        }
      } else {
        // Bronze or no logo: text-only
        doc.fontSize(nameSize).font(tier === "bronze" ? "Helvetica" : "Helvetica-Bold").fillColor("#333333")
          .text(s.name, x + 14, cy, { width: w - 28 });
        cy += nameSize + 3;
      }
    }
    cy += 3;
  }

  if (data.holeSponsors.length > 0) {
    if (cy < y + h - 40) {
      doc.moveTo(x + 10, cy).lineTo(x + w - 10, cy).strokeColor("#eeeeee").lineWidth(0.3).stroke();
      cy += 6;
      doc.fontSize(5.5).font("Helvetica-Bold").fillColor("#888888")
        .text("HOLE SPONSORS", x + 12, cy, { width: w - 24 });
      cy += 8;
      doc.fontSize(6).font("Helvetica").fillColor("#555555");
      for (const hs of data.holeSponsors) {
        if (cy > y + h - 15) break;
        doc.text(`Hole ${hs.holeNumber} - ${hs.sponsorName}`, x + 14, cy, { width: w - 28 });
        cy += 8;
      }
    }
  }

  if (org.website) {
    doc.fontSize(5.5).font("Helvetica").fillColor("#999999")
      .text(org.website, x + 8, y + h - 14, { width: w - 16, align: "center" });
  }
}

function drawScoreGrid(
  doc: InstanceType<typeof PDFDocument>,
  holes: PocketPlayerCard["holes"],
  label: string,
  sideGames: PocketSideGames,
  holeSponsors: PocketHoleSponsor[],
  x: number,
  y: number,
  w: number,
  showNet: boolean,
  showPts: boolean,
) {
  const cols = showNet && showPts ? 7 : showNet || showPts ? 6 : 5;
  const rowH = 13;
  const headerH = 14;
  const holeColW = 28;
  const dataColW = (w - holeColW) / (cols - 1);

  let cy = y;

  doc.rect(x, cy, w, headerH).fill("#333333");
  doc.fillColor("#ffffff").fontSize(6.5).font("Helvetica-Bold");
  const headers = ["Hole", "Yds", "Par", "SI", "Gross"];
  if (showNet) headers.push("Net");
  if (showPts) headers.push("Pts");
  let cx = x;
  doc.text(headers[0], cx + 2, cy + 3.5, { width: holeColW - 4, align: "center" });
  cx = x + holeColW;
  for (let i = 1; i < headers.length; i++) {
    doc.text(headers[i], cx + 1, cy + 3.5, { width: dataColW - 2, align: "center" });
    cx += dataColW;
  }
  cy += headerH;

  const ctpSet = new Set(sideGames.ctpHoles);
  const ldSet = new Set(sideGames.ldHoles);
  const holeSponsorMap = new Map(holeSponsors.map(h => [h.holeNumber, h.sponsorName]));

  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const bg = i % 2 === 0 ? "#ffffff" : "#f5f5f5";
    doc.rect(x, cy, w, rowH).fill(bg);

    doc.strokeColor("#dddddd").lineWidth(0.3);
    doc.moveTo(x, cy + rowH).lineTo(x + w, cy + rowH).stroke();

    cx = x;
    doc.fillColor("#000000").fontSize(6.5).font("Helvetica-Bold");

    let holeLabel = String(h.hole);
    const indicators: string[] = [];
    if (ctpSet.has(h.hole)) {
      const label = sideGames.ctpSponsorName ? `*CTP(${sideGames.ctpSponsorName})` : "*CTP";
      indicators.push(label);
    }
    if (ldSet.has(h.hole)) {
      const label = sideGames.ldSponsorName ? `>LD(${sideGames.ldSponsorName})` : ">LD";
      indicators.push(label);
    }
    if (holeSponsorMap.has(h.hole)) indicators.push("$");

    if (indicators.length > 0) {
      doc.text(holeLabel, cx + 1, cy + 3, { width: 14, align: "center" });
      doc.fontSize(4.5).font("Helvetica").fillColor("#666666");
      doc.text(indicators.join(" "), cx + 14, cy + 4, { width: holeColW - 16, align: "left" });
    } else {
      doc.text(holeLabel, cx + 2, cy + 3, { width: holeColW - 4, align: "center" });
    }

    cx = x + holeColW;
    doc.fontSize(6.5).font("Helvetica").fillColor("#333333");
    doc.text(h.yards != null ? String(h.yards) : "-", cx + 1, cy + 3, { width: dataColW - 2, align: "center" });
    cx += dataColW;
    doc.text(String(h.par), cx + 1, cy + 3, { width: dataColW - 2, align: "center" });
    cx += dataColW;
    doc.text(h.strokeIndex != null ? String(h.strokeIndex) : "-", cx + 1, cy + 3, { width: dataColW - 2, align: "center" });
    cx += dataColW;

    doc.rect(cx, cy, dataColW, rowH).stroke();
    cx += dataColW;
    if (showNet) { doc.rect(cx, cy, dataColW, rowH).stroke(); cx += dataColW; }
    if (showPts) { doc.rect(cx, cy, dataColW, rowH).stroke(); cx += dataColW; }

    cy += rowH;
  }

  const totalH = rowH + 2;
  doc.rect(x, cy, w, totalH).fill("#e8e8e8");
  doc.fillColor("#000000").fontSize(7).font("Helvetica-Bold");
  doc.text(label, x + 2, cy + 3.5, { width: holeColW - 4, align: "center" });
  cx = x + holeColW;
  cx += dataColW;
  const totalPar = holes.reduce((s, h) => s + h.par, 0);
  doc.text(String(totalPar), cx + 1, cy + 3.5, { width: dataColW - 2, align: "center" });
  cx += dataColW;
  cx += dataColW;
  doc.rect(cx, cy, dataColW, totalH).stroke();
  cx += dataColW;
  if (showNet) { doc.rect(cx, cy, dataColW, totalH).stroke(); cx += dataColW; }
  if (showPts) { doc.rect(cx, cy, dataColW, totalH).stroke(); }

  return cy + totalH;
}

function drawPanel2(doc: InstanceType<typeof PDFDocument>, player: PocketPlayerCard, data: PocketScorecardData, x: number, y: number, w: number, _h: number, showNet: boolean, showPts: boolean) {
  const front9 = player.holes.filter(h => h.hole <= 9);

  let cy = y + 6;
  doc.fillColor("#000000").fontSize(7).font("Helvetica-Bold")
    .text("FRONT 9", x + 8, cy, { width: w - 16 });
  cy += 12;

  drawScoreGrid(doc, front9, "OUT", data.sideGames, data.holeSponsors, x + 6, cy, w - 12, showNet, showPts);
}

function drawPanel3(doc: InstanceType<typeof PDFDocument>, player: PocketPlayerCard, data: PocketScorecardData, x: number, y: number, w: number, h: number, showNet: boolean, showPts: boolean) {
  const back9 = player.holes.filter(h => h.hole >= 10);

  let cy = y + 6;
  doc.fillColor("#000000").fontSize(7).font("Helvetica-Bold")
    .text("BACK 9", x + 8, cy, { width: w - 16 });
  cy += 12;

  const gridEnd = drawScoreGrid(doc, back9, "IN", data.sideGames, data.holeSponsors, x + 6, cy, w - 12, showNet, showPts);
  cy = gridEnd + 2;

  const totalH = 15;
  doc.rect(x + 6, cy, w - 12, totalH).fill("#333333");
  doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold")
    .text("TOTAL", x + 8, cy + 3, { width: 60 });
  const totalPar = player.holes.reduce((s, hl) => s + hl.par, 0);
  const cols = showNet && showPts ? 7 : showNet || showPts ? 6 : 5;
  const holeColW = 28;
  const dataColW = (w - 12 - holeColW) / (cols - 1);
  let cx = x + 6 + holeColW + dataColW;
  doc.text(String(totalPar), cx + 1, cy + 3, { width: dataColW - 2, align: "center" });
  cx += dataColW + dataColW;
  doc.rect(cx, cy, dataColW, totalH).strokeColor("#ffffff").lineWidth(0.5).stroke();
  cx += dataColW;
  if (showNet) { doc.rect(cx, cy, dataColW, totalH).strokeColor("#ffffff").lineWidth(0.5).stroke(); cx += dataColW; }
  if (showPts) { doc.rect(cx, cy, dataColW, totalH).strokeColor("#ffffff").lineWidth(0.5).stroke(); }
  cy += totalH + 12;

  doc.fillColor("#333333").fontSize(7).font("Helvetica");
  doc.text("Player: ______________________________", x + 10, cy, { width: w - 20 });
  cy += 14;
  doc.text("Marker: ______________________________", x + 10, cy, { width: w - 20 });
  cy += 14;
  doc.text("Date:     ______________________________", x + 10, cy, { width: w - 20 });
  cy += 18;

  doc.fontSize(5.5).font("Helvetica").fillColor("#888888");
  doc.text("Score Legend:   O Birdie   @ Eagle   [ ] Bogey   [X] Dbl Bogey+", x + 10, cy, { width: w - 20 });

  if (data.sideGames.ctpHoles.length > 0 || data.sideGames.ldHoles.length > 0) {
    cy += 10;
    doc.text("*CTP = Closest to Pin   >LD = Longest Drive   $ = Hole Sponsor", x + 10, cy, { width: w - 20 });
  }
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]") return false;
    if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) return false;
    if (host === "169.254.169.254" || host.endsWith(".internal") || host.endsWith(".local")) return false;
    if (host === "metadata.google.internal" || host.startsWith("metadata.")) return false;
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
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > 2 * 1024 * 1024) return null;
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

async function generateQrBuffer(url: string): Promise<Buffer | null> {
  try {
    const png = await QRCode.toBuffer(url, { type: "png", width: 120, margin: 1, errorCorrectionLevel: "M" });
    return png;
  } catch {
    return null;
  }
}

export async function generatePocketScorecardPDF(data: PocketScorecardData): Promise<Buffer> {
  // Pre-fetch org logo + all sponsor logos + QR code concurrently (SSRF-safe)
  const [logoBuffer, qrBuffer, ...rawSponsorBuffers] = await Promise.all([
    fetchLogoBuffer(data.organization.logoUrl),
    data.tournament.qrCodeUrl ? generateQrBuffer(data.tournament.qrCodeUrl) : Promise.resolve(null),
    ...data.sponsors.map(s => fetchLogoBuffer(s.logoUrl)),
  ]);
  const sponsorLogoBuffers = new Map<number, Buffer | null>(
    data.sponsors.map((s, i) => [s.id, rawSponsorBuffers[i] ?? null]),
  );

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0, autoFirstPage: false });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const showNet = ["net_stroke", "stableford"].includes(data.tournament.format);
    const showPts = data.tournament.format === "stableford";

    for (const player of data.players) {
      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });

      doc.rect(0, 0, PAGE_W, PAGE_H).fill("#ffffff");

      drawPanel4(doc, data, MARGIN, MARGIN, HALF_W - MARGIN * 1.5, PAGE_H - MARGIN * 2, sponsorLogoBuffers);
      drawPanel1(doc, player, data, HALF_W + MARGIN * 0.5, MARGIN, HALF_W - MARGIN * 1.5, PAGE_H - MARGIN * 2, logoBuffer, qrBuffer ?? null);

      drawDashedLine(doc, HALF_W, 0, HALF_W, PAGE_H);

      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
      doc.rect(0, 0, PAGE_W, PAGE_H).fill("#ffffff");

      drawPanel2(doc, player, data, MARGIN, MARGIN, HALF_W - MARGIN * 1.5, PAGE_H - MARGIN * 2, showNet, showPts);
      drawPanel3(doc, player, data, HALF_W + MARGIN * 0.5, MARGIN, HALF_W - MARGIN * 1.5, PAGE_H - MARGIN * 2, showNet, showPts);

      drawDashedLine(doc, HALF_W, 0, HALF_W, PAGE_H);
    }

    doc.end();
  });
}
