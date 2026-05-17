/**
 * Task #910 — probe an uploaded swing video's true frame rate using ffprobe
 * so the swing_videos.fps column can be populated at upload time, instead of
 * waiting for a coach to open the review in their browser and let
 * requestVideoFrameCallback figure it out client-side.
 *
 * Returns the detected frame rate (e.g. 30, 59.94, 120) or `null` if it
 * cannot be determined within the timeout. The caller decides what to do
 * when null (we currently just leave the column NULL and fall back to the
 * existing client-side detection path).
 */
import { spawn } from "child_process";
import { createWriteStream, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

const storage = new ObjectStorageService();

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  // ffprobe rates come back as fractions like "30000/1001" or "60/1".
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(rate.trim());
  if (!m) return null;
  const num = parseFloat(m[1]);
  const den = m[2] ? parseFloat(m[2]) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
  // Snap to common camera rates so 29.97 reports as 29.97 but 59.999 → 60.
  const common = [24, 25, 29.97, 30, 50, 59.94, 60, 100, 120, 200, 240];
  const snapped = common.find(c => Math.abs(c - fps) / c < 0.005);
  return snapped ?? Math.round(fps * 1000) / 1000;
}

export async function probeVideoFps(objectPath: string): Promise<number | null> {
  const tmpVideo = path.join(tmpdir(), `${randomUUID()}_fpsprobe.mp4`);
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

    return await new Promise<number | null>((resolve) => {
      let out = "";
      const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", tmpVideo]);
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 15000);
      proc.on("close", () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(out) as { streams?: Array<{ codec_type: string; avg_frame_rate?: string; r_frame_rate?: string }> };
          const vs = data.streams?.find(s => s.codec_type === "video");
          if (!vs) { resolve(null); return; }
          // Prefer avg_frame_rate (true average) and fall back to r_frame_rate
          // (the source's nominal rate) when avg is unavailable / 0.
          const fps = parseRate(vs.avg_frame_rate) ?? parseRate(vs.r_frame_rate);
          resolve(fps);
        } catch { resolve(null); }
      });
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  } catch (e) {
    logger.warn({ e, objectPath }, "[videoFps] probe failed");
    return null;
  } finally {
    try { unlinkSync(tmpVideo); } catch { /* ignore */ }
  }
}
