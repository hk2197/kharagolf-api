/**
 * Year in Golf — server-side image card + short video render pipeline.
 *
 * Renders Spotify-Wrapped-style 1080×1920 chapter cards as PNGs from
 * server-side SVG, then composes them into a short MP4 slideshow using
 * the system ffmpeg binary. Used both for shareable single-card images
 * (e.g. og:image, deep-link previews) and for the per-recap short video
 * the user can save / share to social.
 */
import { Resvg } from "@resvg/resvg-js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { YearInGolfRecap } from "./year-in-golf";

const W = 1080;
const H = 1920;

const PALETTE: Array<[string, string]> = [
  ["#0f172a", "#1e293b"],
  ["#022c22", "#064e3b"],
  ["#1e1b4b", "#4338ca"],
  ["#7c2d12", "#c2410c"],
  ["#831843", "#be185d"],
  ["#0c4a6e", "#0369a1"],
  ["#365314", "#65a30d"],
  ["#3b0764", "#7e22ce"],
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Card {
  /** Stable chapter key — also drives palette selection. */
  key: string;
  title: string;
  metric: string;
  caption?: string;
}

export function buildCards(recap: YearInGolfRecap): Card[] {
  const t = recap.totals;
  const cards: Card[] = [];
  cards.push({ key: "intro", title: `${recap.user.displayName ?? "Your"}\n${recap.window.label} in Golf`, metric: "🏌️", caption: "Tap through your highlights" });
  cards.push({ key: "rounds", title: "Rounds played", metric: String(t.rounds), caption: `${t.holes} holes across ${t.courses} courses` });
  if (recap.bestRound) cards.push({ key: "best-round", title: "Best round", metric: String(recap.bestRound.gross), caption: recap.bestRound.courseName ?? "" });
  if (recap.longestDrive) cards.push({ key: "longest-drive", title: "Longest drive", metric: `${recap.longestDrive.distanceYards} yd`, caption: recap.longestDrive.club ?? "" });
  if (recap.lowestHoleScore) cards.push({ key: "lowest-hole", title: "Best hole", metric: `${recap.lowestHoleScore.strokes}`, caption: `Hole ${recap.lowestHoleScore.holeNumber} • par ${recap.lowestHoleScore.par ?? "?"}` });
  cards.push({ key: "courses", title: "Courses", metric: String(t.courses), caption: recap.topCourses.slice(0, 3).map(c => c.courseName).join(" • ") });
  if (t.partners > 0) cards.push({ key: "partners", title: "Playing partners", metric: String(t.partners), caption: recap.topPartners.slice(0, 3).map(p => p.name).join(" • ") });
  if (t.achievementsUnlocked > 0) cards.push({ key: "achievements", title: "Achievements", metric: String(t.achievementsUnlocked), caption: recap.achievements.slice(0, 3).map(a => a.badgeLabel).join(" • ") });
  if (recap.handicapJourney.startIndex != null && recap.handicapJourney.endIndex != null) {
    cards.push({ key: "handicap", title: "Handicap journey", metric: `${recap.handicapJourney.startIndex} → ${recap.handicapJourney.endIndex}`, caption: recap.handicapJourney.deltaLabel });
  }
  if (recap.mostImproved) cards.push({ key: "improved", title: "Most improved", metric: recap.mostImproved.deltaLabel, caption: recap.mostImproved.metric });
  cards.push({ key: "outro", title: "Share your year", metric: "KHARAGOLF", caption: "kharagolf.com" });
  return cards;
}

function renderSvg(card: Card, paletteIdx: number): string {
  const [a, b] = PALETTE[paletteIdx % PALETTE.length];
  const titleLines = card.title.split("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${a}"/>
      <stop offset="100%" stop-color="${b}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g font-family="-apple-system, Helvetica, Arial, sans-serif" fill="#ffffff" text-anchor="middle">
    ${titleLines.map((ln, i) => `<text x="${W / 2}" y="${340 + i * 96}" font-size="84" font-weight="800">${esc(ln)}</text>`).join("\n    ")}
    <text x="${W / 2}" y="${H / 2 + 60}" font-size="220" font-weight="900">${esc(card.metric)}</text>
    ${card.caption ? `<text x="${W / 2}" y="${H - 360}" font-size="48" font-weight="500" opacity="0.85">${esc(card.caption)}</text>` : ""}
    <text x="${W / 2}" y="${H - 140}" font-size="36" font-weight="600" opacity="0.7">KHARAGOLF • Year in Golf</text>
  </g>
</svg>`;
}

export function renderCardPng(recap: YearInGolfRecap, chapterIndex: number): Buffer {
  const cards = buildCards(recap);
  const idx = Math.max(0, Math.min(cards.length - 1, chapterIndex));
  const svg = renderSvg(cards[idx], idx);
  const r = new Resvg(svg, { fitTo: { mode: "width", value: W } });
  return Buffer.from(r.render().asPng());
}

/**
 * Compose a short ~30s MP4 slideshow from the chapter cards using the
 * system ffmpeg binary. Each card is shown for 3s with a simple cross-fade.
 */
export async function renderRecapVideo(recap: YearInGolfRecap): Promise<Buffer> {
  const cards = buildCards(recap);
  const dir = await mkdtemp(join(tmpdir(), "yig-"));
  try {
    const frames: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const png = Buffer.from(new Resvg(renderSvg(cards[i], i), { fitTo: { mode: "width", value: W } }).render().asPng());
      const fp = join(dir, `f_${String(i).padStart(3, "0")}.png`);
      await writeFile(fp, png);
      frames.push(fp);
    }
    const concatList = frames.map(f => `file '${f}'\nduration 3.0`).join("\n") + `\nfile '${frames[frames.length - 1]}'\n`;
    const listPath = join(dir, "list.txt");
    await writeFile(listPath, concatList);
    const outPath = join(dir, "out.mp4");

    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-vsync", "vfr",
        "-pix_fmt", "yuv420p",
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-movflags", "+faststart",
        outPath,
      ];
      const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      ff.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
      ff.on("error", reject);
      ff.on("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      });
    });

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
