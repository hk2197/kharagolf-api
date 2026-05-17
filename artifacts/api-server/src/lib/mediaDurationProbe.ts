/**
 * Shared video duration probe used by both the one-shot backfill script
 * (Task #855 — `scripts/backfillMediaDurations.ts`) and the on-demand
 * admin re-check endpoint (Task #1327 — `POST .../media/:mediaId/recheck-duration`).
 *
 * The probe downloads the object from object storage to a temp file,
 * runs ffprobe, and returns the rounded-up whole-second duration. It
 * returns `null` when the duration cannot be determined (ffprobe
 * timeout, no video stream, malformed file, etc.) so callers can
 * decide how to surface the failure — the backfill script counts it,
 * the admin endpoint stamps `duration_last_checked_at` so the row
 * stays visible for another retry attempt.
 */
import { spawn } from "child_process";
import { createWriteStream, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { ObjectStorageService } from "./objectStorage";

const storage = new ObjectStorageService();

/**
 * Download the object and read its video duration with ffprobe.
 *
 * @returns the rounded-up whole-second duration, or `null` if ffprobe
 *          could not determine the length within the 15s timeout.
 * @throws  whatever object storage throws (e.g. `ObjectNotFoundError`)
 *          — the caller distinguishes "missing object" from "probe
 *          failed" because they map to different admin-facing copy.
 */
export async function probeMediaDurationSeconds(objectPath: string): Promise<number | null> {
  const tmpVideo = path.join(tmpdir(), `${randomUUID()}_recheck.mp4`);
  try {
    const videoFile = await storage.getObjectEntityFile(objectPath);
    const nodeStream = videoFile.createReadStream();
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(tmpVideo);
      nodeStream.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      nodeStream.on("error", reject);
    });

    const raw = await new Promise<number | null>((resolve) => {
      let out = "";
      const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", tmpVideo]);
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 15000);
      proc.on("close", () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(out) as { streams?: Array<{ codec_type: string; duration?: string }> };
          const vs = data.streams?.find((s) => s.codec_type === "video");
          const parsed = vs?.duration ? parseFloat(vs.duration) : NaN;
          resolve(Number.isFinite(parsed) ? parsed : null);
        } catch { resolve(null); }
      });
    });

    if (raw === null) return null;
    // Round up so a 7.4s video reports 8s — the editor uses this to disable
    // the start/length steppers, and rounding down would make the last
    // fraction of a second unreachable.
    return Math.max(1, Math.ceil(raw));
  } finally {
    try { unlinkSync(tmpVideo); } catch { /* ignore */ }
  }
}
