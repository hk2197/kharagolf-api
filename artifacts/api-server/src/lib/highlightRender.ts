/**
 * Highlight reel rendering — Task #361.
 *
 * Composes a 15–30s slideshow MP4 from:
 *   – an SVG-rendered title card (player name, score summary)
 *   – player-supplied photos pulled from the org media gallery
 *   – an SVG-rendered closing summary card (best/worst hole, totals)
 *
 * Templates select colours and intro/outro durations.  Music is recorded as
 * metadata only — actual audio mixing is deferred (silent video for now).
 *
 * Renders are kicked off asynchronously from the route handler; on completion
 * the highlight_reels row is updated to status='ready' (or 'failed' with
 * errorMessage) and the player can post the result to the social feed.
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { db, highlightReelsTable, mediaTable, scoresTable, playersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

const W = 1280;
const H = 720;

export interface HighlightTemplate {
  id: string;
  name: string;
  accent: string;
  background: string;
  introSeconds: number;
  outroSeconds: number;
  perPhotoSeconds: number;
  description: string;
  /** Royalty-free synth chord (Hz) used as a soft music bed via ffmpeg's
   *  `aevalsrc`. Generated procedurally so no third-party audio licence applies. */
  musicChordHz: [number, number, number];
}

export const HIGHLIGHT_TEMPLATES: HighlightTemplate[] = [
  { id: "classic",    name: "Classic Fairway", description: "Crisp green accents and bold scorecard text — perfect for any round.", accent: "#10B981", background: "#0B1220", introSeconds: 3, outroSeconds: 3, perPhotoSeconds: 2.5, musicChordHz: [220.00, 261.63, 329.63] },
  { id: "twilight",   name: "Twilight Tee",    description: "Cinematic violet hues for late-evening rounds and tournaments under the lights.", accent: "#A78BFA", background: "#1A1430", introSeconds: 3, outroSeconds: 3, perPhotoSeconds: 2.5, musicChordHz: [196.00, 246.94, 293.66] },
  { id: "champion",   name: "Champion Gold",   description: "Trophy-ready gold treatment to celebrate a winning performance.", accent: "#F59E0B", background: "#1B1408", introSeconds: 3, outroSeconds: 3, perPhotoSeconds: 2.5, musicChordHz: [261.63, 329.63, 392.00] },
  { id: "minimalist", name: "Minimalist",      description: "Quick, clean cuts with electric-blue accents — fastest pacing.", accent: "#3B82F6", background: "#0F172A", introSeconds: 2, outroSeconds: 2, perPhotoSeconds: 2.0, musicChordHz: [174.61, 220.00, 277.18] },
];

export function getTemplate(id: string): HighlightTemplate {
  return HIGHLIGHT_TEMPLATES.find(t => t.id === id) ?? HIGHLIGHT_TEMPLATES[0];
}

function escapeXml(s: string): string {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" } as Record<string,string>)[c]);
}

function renderCardSvg(opts: {
  template: HighlightTemplate;
  title: string;
  subtitle?: string;
  lines?: string[];
  badge?: string;
}): string {
  const t = opts.template;
  const lines = opts.lines ?? [];
  const lineY = 360;
  const lineSpacing = 56;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${t.background}"/>
  <circle cx="${W - 100}" cy="120" r="220" fill="${t.accent}" fill-opacity="0.10"/>
  <rect x="60" y="60" width="14" height="${H - 120}" fill="${t.accent}" rx="6"/>
  ${opts.badge ? `<text x="100" y="120" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="bold" fill="${t.accent}">${escapeXml(opts.badge)}</text>` : ""}
  <text x="100" y="240" font-family="Arial,Helvetica,sans-serif" font-size="72" font-weight="900" fill="#FFFFFF">${escapeXml(opts.title)}</text>
  ${opts.subtitle ? `<text x="100" y="300" font-family="Arial,Helvetica,sans-serif" font-size="32" fill="#9CA3AF">${escapeXml(opts.subtitle)}</text>` : ""}
  ${lines.map((l, i) => `<text x="100" y="${lineY + i * lineSpacing}" font-family="Arial,Helvetica,sans-serif" font-size="40" fill="#FFFFFF">${escapeXml(l)}</text>`).join("\n  ")}
  <text x="${W - 80}" y="${H - 50}" font-family="Arial,Helvetica,sans-serif" font-size="22" fill="${t.accent}" text-anchor="end">KHARAGOLF</text>
</svg>`;
}

async function svgToPng(svg: string, transparent = false): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const resvg = new Resvg(svg, transparent
    ? { font: { loadSystemFonts: false } }
    : { font: { loadSystemFonts: false }, background: "rgba(0,0,0,1)" });
  return Buffer.from(resvg.render().asPng());
}

/**
 * Render a transparent caption strip overlay (per-clip caption). Wraps long
 * text onto up to 2 lines and keeps the strip pinned near the bottom so the
 * underlying photo or video footage remains visible.
 */
function renderCaptionOverlaySvg(text: string, template: HighlightTemplate): string {
  const maxCharsPerLine = 56;
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxCharsPerLine) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
    if (lines.length >= 2) break;
  }
  if (cur && lines.length < 2) lines.push(cur);
  if (lines.length === 0) lines.push("");
  const stripH = lines.length > 1 ? 170 : 110;
  const stripY = H - stripH - 40;
  const lineH = 50;
  const firstY = stripY + 60;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="60" y="${stripY}" width="${W - 120}" height="${stripH}" fill="#000000" fill-opacity="0.55" rx="14"/>
  <rect x="60" y="${stripY}" width="8" height="${stripH}" fill="${template.accent}" rx="3"/>
  ${lines.map((l, i) => `<text x="92" y="${firstY + i * lineH}" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="700" fill="#FFFFFF">${escapeXml(l)}</text>`).join("\n  ")}
</svg>`;
}

function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("ffmpeg timeout")); }, timeoutMs);
    proc.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split("\n").slice(-3).join(" ")}`));
    });
  });
}

/** Probe a local video file's duration in seconds via ffprobe. Returns
 *  `null` when the duration cannot be determined — callers must treat
 *  that as "unknown" and fall back to whatever the request specified. */
function probeVideoDuration(localPath: string): Promise<number | null> {
  return new Promise(resolve => {
    let out = "";
    const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", localPath]);
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 10_000);
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out) as { streams?: Array<{ codec_type: string; duration?: string }> };
        const vs = data.streams?.find(s => s.codec_type === "video");
        const d = vs?.duration ? parseFloat(vs.duration) : null;
        resolve(d != null && Number.isFinite(d) && d > 0 ? d : null);
      } catch { resolve(null); }
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// Minimum clip length the renderer will produce. The trim-clamp safety
// net guarantees `startSec <= duration - MIN_CLIP_LENGTH_SEC` so a player
// who steps the start past the end of the video doesn't get black frames.
const MIN_CLIP_LENGTH_SEC = 0.5;

interface RoundSummary {
  playerName: string;
  tournamentName: string;
  totalStrokes: number;
  bestHole: { number: number; strokes: number } | null;
  worstHole: { number: number; strokes: number } | null;
  holesPlayed: number;
  fairwaysHit: number;
  girHit: number;
}

export async function buildRoundSummary(playerId: number | null, tournamentId: number | null): Promise<RoundSummary | null> {
  if (!playerId || !tournamentId) return null;
  const [p] = await db.select().from(playersTable).where(eq(playersTable.id, playerId)).limit(1);
  if (!p) return null;
  const scores = await db.select().from(scoresTable)
    .where(and(eq(scoresTable.playerId, playerId), eq(scoresTable.tournamentId, tournamentId)));
  if (scores.length === 0) {
    return {
      playerName: `${p.firstName} ${p.lastName}`,
      tournamentName: "",
      totalStrokes: 0,
      bestHole: null, worstHole: null,
      holesPlayed: 0, fairwaysHit: 0, girHit: 0,
    };
  }
  const total = scores.reduce((s, x) => s + x.strokes, 0);
  const sorted = [...scores].sort((a, b) => a.strokes - b.strokes);
  return {
    playerName: `${p.firstName} ${p.lastName}`,
    tournamentName: "",
    totalStrokes: total,
    bestHole: { number: sorted[0].holeNumber, strokes: sorted[0].strokes },
    worstHole: { number: sorted[sorted.length - 1].holeNumber, strokes: sorted[sorted.length - 1].strokes },
    holesPlayed: scores.length,
    fairwaysHit: scores.filter(s => s.fairwayHit === true).length,
    girHit: scores.filter(s => s.girHit === true).length,
  };
}

/**
 * Run the actual ffmpeg render pipeline for a reel that has already been
 * claimed by the worker (status='rendering'). Throws on failure so the
 * worker can decide whether to retry; on success the row is updated to
 * status='ready' with the final outputs.
 *
 * This function is the heavy/CPU-bound part of the highlight feature and
 * must NEVER run inside the API server process — it's invoked exclusively
 * by `src/highlightWorker.ts` (Task #418).
 */
export async function executeRender(reelId: number): Promise<void> {
  const storage = new ObjectStorageService();
  const tmp = mkdtempSync(path.join(tmpdir(), `reel-${reelId}-`));
  try {
    const [reel] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, reelId)).limit(1);
    if (!reel) return;

    const template = getTemplate(reel.templateId);
    const opts = (reel.options ?? {}) as {
      includedMediaIds?: number[];
      caption?: string;
      clips?: Array<{ mediaId: number; caption?: string; startSec?: number; durationSec?: number }>;
    };
    const summary = (reel.summary ?? {}) as Partial<RoundSummary>;

    // 1. Resolve player-supplied media for the reel.
    //
    // Priority:
    //   1. `opts.clips` is *present* (even if empty) → it is authoritative (Task #416).
    //      An empty clips array means "no player media", and we honor it.
    //   2. `opts.includedMediaIds` — legacy: ordered IDs without per-clip captions.
    //   3. Auto-pick: most-recent approved photos by this user (& tournament).
    //
    // Security: a media row qualifies if it is approved + same org AND either
    //   (a) uploaded by the caller, OR
    //   (b) belongs to the reel's tournament (already authorised at create time).
    // Anything else is silently dropped to prevent guessed cross-user inclusion.
    type ResolvedClip = {
      mediaId: number;
      caption: string | null;
      mediaType: string;
      objectPath: string;
      startSec?: number;
      durationSec?: number;
    };
    let clipsSpec: ResolvedClip[] = [];
    const clipsExplicit = Array.isArray(opts.clips);

    if (clipsExplicit && opts.clips!.length > 0) {
      const requested = opts.clips!
        .filter(c => c && Number.isFinite(Number(c.mediaId)))
        .slice(0, 12);
      const ids = requested.map(c => Number(c.mediaId));
      // Pull all candidate rows in the org and filter in JS using the
      // ownership/tournament rule (drizzle `or` would also work).
      const rows = await db.select().from(mediaTable).where(and(
        eq(mediaTable.organizationId, reel.organizationId),
        eq(mediaTable.approved, true),
        inArray(mediaTable.id, ids),
      ));
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const c of requested) {
        const m = byId.get(Number(c.mediaId));
        if (!m) continue;
        const ownsByUpload = m.uploadedByUserId === reel.userId;
        const ownsByRound = !!(reel.tournamentId && m.tournamentId === reel.tournamentId);
        if (!ownsByUpload && !ownsByRound) continue;
        // Sanitize trim values: only meaningful for video clips.
        const startNum = typeof c.startSec === "number" && Number.isFinite(c.startSec)
          ? Math.max(0, c.startSec) : undefined;
        const durNum = typeof c.durationSec === "number" && Number.isFinite(c.durationSec)
          ? Math.min(60, Math.max(0.5, c.durationSec)) : undefined;
        clipsSpec.push({
          mediaId: m.id,
          caption: typeof c.caption === "string" && c.caption.trim() ? c.caption.trim().slice(0, 140) : null,
          mediaType: m.mediaType,
          objectPath: m.objectPath,
          startSec: m.mediaType === "video" ? startNum : undefined,
          durationSec: m.mediaType === "video" ? durNum : undefined,
        });
      }
    } else if (clipsExplicit) {
      // Explicit empty selection — honor it (no player media).
      clipsSpec = [];
    } else {
      const idList = Array.isArray(opts.includedMediaIds) ? opts.includedMediaIds.slice(0, 8) : [];
      const mediaRows = idList.length > 0
        ? await db.select().from(mediaTable).where(and(
            eq(mediaTable.organizationId, reel.organizationId),
            eq(mediaTable.uploadedByUserId, reel.userId),
            eq(mediaTable.approved, true),
            inArray(mediaTable.id, idList),
          ))
        : await db.select().from(mediaTable).where(and(
            eq(mediaTable.organizationId, reel.organizationId),
            eq(mediaTable.uploadedByUserId, reel.userId),
            eq(mediaTable.approved, true),
            eq(mediaTable.mediaType, "image"),
            ...(reel.tournamentId ? [eq(mediaTable.tournamentId, reel.tournamentId)] : []),
          )).limit(6);
      // Preserve the order from idList when supplied
      const ordered = idList.length > 0
        ? idList.map(id => mediaRows.find(m => m.id === id)).filter(Boolean) as typeof mediaRows
        : mediaRows;
      clipsSpec = ordered
        .filter(m => m.mediaType === "image")
        .map(m => ({ mediaId: m.id, caption: null, mediaType: m.mediaType, objectPath: m.objectPath }));
    }

    // 2. Download each selected source (image or video) to the temp dir.
    type LocalClip = { localPath: string; caption: string | null; mediaType: string; mediaId: number; startSec?: number; durationSec?: number };
    const localClips: LocalClip[] = [];
    for (const c of clipsSpec) {
      try {
        const f = await storage.getObjectEntityFile(c.objectPath);
        const ext = c.mediaType === "video" ? "mp4" : "bin";
        const local = path.join(tmp, `media_${c.mediaId}.${ext}`);
        const buf = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const s = f.createReadStream();
          s.on("data", ch => chunks.push(ch as Buffer));
          s.on("end", () => resolve(Buffer.concat(chunks)));
          s.on("error", reject);
        });
        writeFileSync(local, buf);
        localClips.push({ localPath: local, caption: c.caption, mediaType: c.mediaType, mediaId: c.mediaId, startSec: c.startSec, durationSec: c.durationSec });
      } catch (e) {
        logger.warn({ reelId, mediaId: c.mediaId, err: e }, "[highlight] skipped clip");
      }
    }

    // 3. Build intro + outro PNG cards (and any data-driven scenes).
    const introSvg = renderCardSvg({
      template,
      badge: "ROUND HIGHLIGHTS",
      title: summary.playerName ?? reel.title,
      subtitle: summary.tournamentName || "Round Recap",
    });
    const outroLines: string[] = [];
    if (summary.totalStrokes) outroLines.push(`Total: ${summary.totalStrokes} strokes`);
    if (summary.holesPlayed) outroLines.push(`Holes played: ${summary.holesPlayed}`);
    if (summary.bestHole) outroLines.push(`Best hole: #${summary.bestHole.number} (${summary.bestHole.strokes})`);
    if (summary.fairwaysHit) outroLines.push(`Fairways hit: ${summary.fairwaysHit}`);
    if (summary.girHit) outroLines.push(`GIR: ${summary.girHit}`);
    const outroSvg = renderCardSvg({
      template,
      badge: "ROUND SUMMARY",
      title: "Great round!",
      subtitle: opts.caption || "Shared from KHARAGOLF",
      lines: outroLines.slice(0, 5),
    });
    const introPng = path.join(tmp, "intro.png");
    const outroPng = path.join(tmp, "outro.png");
    writeFileSync(introPng, await svgToPng(introSvg));
    writeFileSync(outroPng, await svgToPng(outroSvg));

    // Best-hole scene — only when we know the hole.
    let bestHolePng: string | null = null;
    if (summary.bestHole) {
      const bh = summary.bestHole;
      const lines = [
        `Hole #${bh.number}`,
        `${bh.strokes} stroke${bh.strokes === 1 ? "" : "s"}`,
      ];
      if (summary.worstHole && summary.worstHole.number !== bh.number) {
        lines.push(`(toughest hole: #${summary.worstHole.number}, ${summary.worstHole.strokes})`);
      }
      const svg = renderCardSvg({
        template,
        badge: "BEST HOLE",
        title: "Hole of the Day",
        subtitle: summary.playerName ?? "",
        lines,
      });
      bestHolePng = path.join(tmp, "best.png");
      writeFileSync(bestHolePng, await svgToPng(svg));
    }

    // Strokes-Gained / shotmaking scene — only when we have countable data.
    // We approximate Strokes Gained from fairways-hit and GIR (true SG needs
    // baseline data we don't yet ingest). Numbers are real, not faked.
    let sgPng: string | null = null;
    if (summary.holesPlayed && (summary.fairwaysHit || summary.girHit)) {
      const fw = summary.fairwaysHit ?? 0;
      const gir = summary.girHit ?? 0;
      const fwPct = Math.round((fw / summary.holesPlayed) * 100);
      const girPct = Math.round((gir / summary.holesPlayed) * 100);
      const lines: string[] = [
        `Fairways hit: ${fw}/${summary.holesPlayed}  (${fwPct}%)`,
        `Greens in reg: ${gir}/${summary.holesPlayed}  (${girPct}%)`,
      ];
      const svg = renderCardSvg({
        template,
        badge: "SHOTMAKING",
        title: "Strokes Gained",
        subtitle: "Tee-to-green snapshot",
        lines,
      });
      sgPng = path.join(tmp, "sg.png");
      writeFileSync(sgPng, await svgToPng(svg));
    }

    // 4. Build per-clip silent MP4s (intro, data scenes, each player clip, outro),
    //    then concat. Every clip is normalised to the same WxH/fps/codec/SAR so
    //    concat works without re-encoding errors.
    const clips: { file: string; seconds: number }[] = [];
    const fps = 30;
    const bgColor = template.background.replace("#", "0x");

    // Filter graph that scales/pads any input to W×H, fixes SAR, then optionally
    // overlays a caption strip PNG. Output label is `[v]`.
    const buildFilter = (hasOverlay: boolean) => {
      const base = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bgColor},setsar=1,format=yuv420p`;
      if (!hasOverlay) return `${base}[v]`;
      return `${base}[bg];[bg][1:v]overlay=0:0,format=yuv420p[v]`;
    };
    const encodeOpts = (out: string) => [
      "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-an",
      "-movflags", "+faststart",
      "-y", out,
    ];

    async function writeOverlayIfAny(caption: string | null, idx: string): Promise<string | null> {
      if (!caption) return null;
      const overlayPng = path.join(tmp, `overlay_${idx}.png`);
      writeFileSync(overlayPng, await svgToPng(renderCaptionOverlaySvg(caption, template), true));
      return overlayPng;
    }

    async function makeClipFromImage(image: string, seconds: number, idx: string, caption: string | null = null): Promise<string> {
      const out = path.join(tmp, `clip_${idx}.mp4`);
      const overlay = await writeOverlayIfAny(caption, idx);
      const args: string[] = ["-loop", "1", "-t", String(seconds), "-i", image];
      if (overlay) args.push("-i", overlay);
      args.push(
        "-filter_complex", buildFilter(!!overlay),
        "-map", "[v]",
        "-t", String(seconds),
        ...encodeOpts(out),
      );
      await runFfmpeg(args);
      return out;
    }

    async function makeClipFromVideo(video: string, seconds: number, idx: string, caption: string | null = null, startSec = 0): Promise<string> {
      const out = path.join(tmp, `clip_${idx}.mp4`);
      const overlay = await writeOverlayIfAny(caption, idx);
      // Safety net (Task #703): if the requested start time is past the
      // end of the source video, ffmpeg would seek to EOF and emit a
      // black/empty clip. Probe the actual duration and clamp `startSec`
      // to (duration - MIN_CLIP_LENGTH_SEC) so we always render real
      // footage. We leave the requested length alone — the inner -t flag
      // already truncates to whatever's actually available.
      let safeStart = Math.max(0, startSec);
      const probed = await probeVideoDuration(video);
      if (probed != null) {
        const maxStart = Math.max(0, probed - MIN_CLIP_LENGTH_SEC);
        if (safeStart > maxStart) {
          logger.info({ reelId, video, requested: startSec, probed, clamped: maxStart }, "[highlight] clamped clip start to source duration");
          safeStart = maxStart;
        }
      }
      const args: string[] = ["-ss", String(safeStart), "-t", String(seconds), "-i", video];
      if (overlay) args.push("-loop", "1", "-i", overlay);
      args.push(
        "-filter_complex", buildFilter(!!overlay),
        "-map", "[v]",
        "-t", String(seconds),
        ...encodeOpts(out),
      );
      await runFfmpeg(args);
      return out;
    }

    clips.push({ file: await makeClipFromImage(introPng, template.introSeconds, "intro"), seconds: template.introSeconds });
    if (bestHolePng) {
      clips.push({ file: await makeClipFromImage(bestHolePng, template.perPhotoSeconds, "best"), seconds: template.perPhotoSeconds });
    }
    if (sgPng) {
      clips.push({ file: await makeClipFromImage(sgPng, template.perPhotoSeconds, "sg"), seconds: template.perPhotoSeconds });
    }
    for (let i = 0; i < localClips.length; i++) {
      const c = localClips[i];
      const idx = `p${i}`;
      // For videos, honor the per-clip durationSec/startSec when supplied;
      // otherwise fall back to the template's per-photo timing.
      const seconds = c.mediaType === "video" && typeof c.durationSec === "number"
        ? c.durationSec
        : template.perPhotoSeconds;
      const file = c.mediaType === "video"
        ? await makeClipFromVideo(c.localPath, seconds, idx, c.caption, c.startSec ?? 0)
        : await makeClipFromImage(c.localPath, seconds, idx, c.caption);
      clips.push({ file, seconds });
    }
    clips.push({ file: await makeClipFromImage(outroPng, template.outroSeconds, "outro"), seconds: template.outroSeconds });

    // 5. Concat video, then mux a procedurally-generated royalty-free
    //    music bed (sine-chord pad) onto the final MP4.
    //    The chord is template-specific so each style has its own mood.
    const listFile = path.join(tmp, "concat.txt");
    writeFileSync(listFile, clips.map(c => `file '${c.file}'`).join("\n"));
    const silentOut = path.join(tmp, "reel_silent.mp4");
    await runFfmpeg([
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", "-movflags", "+faststart",
      "-y", silentOut,
    ]);

    const totalSecondsForAudio = clips.reduce((s, c) => s + c.seconds, 0);
    const [f1, f2, f3] = template.musicChordHz;
    // Soft chord with gentle attack/release envelope (1s fade in/out) so it
    // doesn't click. Levels kept low (peak ~0.25) to avoid harshness.
    const env = `min(1\\,min(t\\,${totalSecondsForAudio.toFixed(2)}-t))`;
    const aevalExpr =
      `(0.12*sin(2*PI*${f1}*t)+0.10*sin(2*PI*${f2}*t)+0.08*sin(2*PI*${f3}*t))*${env}`;
    const finalOut = path.join(tmp, "reel.mp4");
    await runFfmpeg([
      "-i", silentOut,
      "-f", "lavfi",
      "-i", `aevalsrc=${aevalExpr}:s=44100:d=${totalSecondsForAudio.toFixed(2)}`,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "96k",
      "-shortest", "-movflags", "+faststart",
      "-y", finalOut,
    ]);

    if (!existsSync(finalOut)) throw new Error("ffmpeg produced no output");
    const videoBuffer = readFileSync(finalOut);

    // 6. Generate thumbnail (first frame of intro card)
    const thumbBuffer = await svgToPng(introSvg);

    // 7. Upload outputs
    const reelKey = `highlights/${reel.userId}/reel_${reelId}_${Date.now()}.mp4`;
    const thumbKey = `highlights/${reel.userId}/thumb_${reelId}_${Date.now()}.png`;
    const outputObjectPath = await storage.saveRawBuffer(reelKey, videoBuffer, "video/mp4");
    const thumbnailPath = await storage.saveRawBuffer(thumbKey, thumbBuffer, "image/png");

    const totalSeconds = clips.reduce((s, c) => s + c.seconds, 0);

    // Register media rows so the /api/storage/objects/... server can serve the
    // rendered MP4 + thumbnail. Approved + tournamentId/leagueId null → public
    // (only by unguessable URL) so feed viewers can stream after post-to-feed,
    // and the owner can preview before posting.
    await db.insert(mediaTable).values([
      {
        organizationId: reel.organizationId,
        uploadedByUserId: reel.userId,
        objectPath: outputObjectPath,
        thumbnailPath,
        mediaType: "video",
        caption: reel.title,
        approved: true,
      },
      {
        organizationId: reel.organizationId,
        uploadedByUserId: reel.userId,
        objectPath: thumbnailPath,
        mediaType: "image",
        caption: `${reel.title} (thumbnail)`,
        approved: true,
      },
    ]);

    await db.update(highlightReelsTable).set({
      status: "ready",
      outputObjectPath,
      thumbnailPath,
      durationSeconds: Math.round(totalSeconds),
      renderCompletedAt: new Date(),
      updatedAt: new Date(),
      errorMessage: null,
    }).where(eq(highlightReelsTable.id, reelId));

    logger.info({ reelId, totalSeconds, clips: localClips.length }, "[highlight] render complete");

    // Task #2008 — central branded `highlight.ready` dispatch (push + branded
    // email + digest fan-out). Reads back the freshly-updated reel so the
    // notify path uses the persisted title / owner.
    try {
      const [reelAfter] = await db.select({
        id: highlightReelsTable.id,
        userId: highlightReelsTable.userId,
        title: highlightReelsTable.title,
      }).from(highlightReelsTable).where(eq(highlightReelsTable.id, reelId));
      if (reelAfter?.userId) {
        const { notifyHighlightReady } = await import("./brandedNotifications.js");
        void notifyHighlightReady({
          userIds: [reelAfter.userId],
          highlightId: reelAfter.id,
          highlightTitle: reelAfter.title ?? undefined,
        });
      }
    } catch (err) {
      logger.warn({ err, reelId }, "[highlight] branded ready notify failed (non-fatal)");
    }
  } finally {
    // Always clean the per-reel temp directory; the worker decides what to
    // do with the thrown error (retry vs. mark failed).
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
