/**
 * Task #578 — Image crop & resize dialog for marketing-site uploads.
 * Task #738 — Added rotate-90° steps and zoom slider so admins can
 *             fine-tune phone photos before picking the crop region.
 *
 * Lets the admin pick a crop region locked to the recommended aspect
 * ratio for the slot (hero 16:9, OG ~1.91:1, gallery 1:1) and outputs
 * a resized JPEG/PNG that gets uploaded instead of the raw file.
 *
 * The image is rendered into a fixed stage with a CSS rotate+scale
 * transform; the crop box is expressed in stage coordinates and the
 * exporter replays the same transform onto an output canvas so the
 * cropped pixels match exactly what the admin sees.
 *
 * Self-contained — uses pointer events and a 2D canvas, no extra deps.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Loader2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';

export type CropKind = 'hero' | 'og' | 'gallery';

interface CropPreset {
  /** width / height */
  aspect: number;
  /** Cropped output is downscaled so its width is at most this many px. */
  maxWidth: number;
  /** Friendly label shown in the dialog header. */
  label: string;
  /** Aspect-ratio hint shown alongside the label. */
  hint: string;
}

export const CROP_PRESETS: Record<CropKind, CropPreset> = {
  hero:    { aspect: 16 / 9,     maxWidth: 1920, label: 'Hero image',    hint: '16:9 widescreen' },
  og:      { aspect: 1200 / 630, maxWidth: 1200, label: 'Social share',  hint: '1200 × 630 (OG)' },
  gallery: { aspect: 1,          maxWidth: 1200, label: 'Gallery photo', hint: '1:1 square' },
};

interface Rect { x: number; y: number; w: number; h: number; }

interface Props {
  open: boolean;
  file: File | null;
  kind: CropKind;
  onCancel: () => void;
  /** Receives the cropped/resized File. */
  onConfirm: (cropped: File) => void;
}

const STAGE_W = 640;
const STAGE_H = 420;
const HANDLE = 14;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.05;

/**
 * Bounds of the rotated+scaled image as it sits inside the stage,
 * centered around (STAGE_W/2, STAGE_H/2).
 */
function imageBoundsOnStage(
  imgW: number,
  imgH: number,
  scale: number,
  rotation: number,
): { left: number; top: number; right: number; bottom: number } {
  const swapped = rotation % 180 !== 0;
  const bw = (swapped ? imgH : imgW) * scale;
  const bh = (swapped ? imgW : imgH) * scale;
  const left = (STAGE_W - bw) / 2;
  const top  = (STAGE_H - bh) / 2;
  return { left, top, right: left + bw, bottom: top + bh };
}

/**
 * Visible crop bounds — the intersection of the image's stage bounds
 * and the stage viewport itself, so the crop box always stays where
 * the admin can see it.
 */
function cropBounds(
  imgW: number,
  imgH: number,
  scale: number,
  rotation: number,
) {
  const b = imageBoundsOnStage(imgW, imgH, scale, rotation);
  return {
    left:   Math.max(b.left, 0),
    top:    Math.max(b.top, 0),
    right:  Math.min(b.right, STAGE_W),
    bottom: Math.min(b.bottom, STAGE_H),
  };
}

/**
 * Clamp a crop rectangle to the visible image area on the stage while
 * preserving the locked aspect ratio.
 */
function clampRect(r: Rect, bounds: { left: number; top: number; right: number; bottom: number }, aspect: number): Rect {
  const maxW = bounds.right - bounds.left;
  const maxH = bounds.bottom - bounds.top;
  let { x, y, w, h } = r;
  h = w / aspect;
  if (w > maxW) { w = maxW; h = w / aspect; }
  if (h > maxH) { h = maxH; w = h * aspect; }
  if (w < 32) { w = 32; h = w / aspect; }
  if (x < bounds.left) x = bounds.left;
  if (y < bounds.top) y = bounds.top;
  if (x + w > bounds.right)  x = bounds.right  - w;
  if (y + h > bounds.bottom) y = bounds.bottom - h;
  return { x, y, w, h };
}

/** Largest centered rect with the locked aspect that fits the bounds. */
function fitCenteredCrop(
  bounds: { left: number; top: number; right: number; bottom: number },
  aspect: number,
): Rect {
  const maxW = Math.max(32, bounds.right - bounds.left);
  const maxH = Math.max(32, bounds.bottom - bounds.top);
  let cw = maxW;
  let ch = cw / aspect;
  if (ch > maxH) { ch = maxH; cw = ch * aspect; }
  return {
    x: bounds.left + (maxW - cw) / 2,
    y: bounds.top  + (maxH - ch) / 2,
    w: cw,
    h: ch,
  };
}

export function ImageCropDialog({ open, file, kind, onCancel, onConfirm }: Props) {
  const preset = CROP_PRESETS[kind];
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Base scale that fits the rotated image inside the stage. */
  const [baseScale, setBaseScale] = useState(1);
  /** User-controlled zoom multiplier (1 = fit). */
  const [zoom, setZoom] = useState(1);
  /** Rotation in degrees, always one of 0/90/180/270. */
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState<Rect | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Drag state: either move (offsets within crop) or resize from BR corner.
  const dragRef = useRef<
    | { mode: 'move'; offX: number; offY: number }
    | { mode: 'resize' }
    | null
  >(null);

  // Recompute the base "fit" scale whenever the image or rotation changes.
  function computeBaseScale(img: HTMLImageElement, rot: number): number {
    const swapped = rot % 180 !== 0;
    const w = swapped ? img.naturalHeight : img.naturalWidth;
    const h = swapped ? img.naturalWidth  : img.naturalHeight;
    return Math.min(STAGE_W / w, STAGE_H / h, 1);
  }

  // Load the picked file into an Image element.
  useEffect(() => {
    if (!open || !file) {
      setImgUrl(null); setImgEl(null); setCrop(null);
      setLoadError(false); setRotation(0); setZoom(1); setBaseScale(1);
      return;
    }
    setLoadError(false);
    setRotation(0);
    setZoom(1);
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      const bs = computeBaseScale(img, 0);
      setBaseScale(bs);
      const bounds = cropBounds(img.naturalWidth, img.naturalHeight, bs * 1, 0);
      setCrop(fitCenteredCrop(bounds, preset.aspect));
    };
    img.onerror = () => {
      setImgEl(null); setCrop(null);
      setLoadError(true);
    };
    img.src = url;
    return () => { URL.revokeObjectURL(url); };
  }, [open, file, preset.aspect]);

  // When rotation or zoom changes, recompute base-fit and re-center crop.
  useEffect(() => {
    if (!imgEl) return;
    const bs = computeBaseScale(imgEl, rotation);
    setBaseScale(bs);
    const bounds = cropBounds(imgEl.naturalWidth, imgEl.naturalHeight, bs * zoom, rotation);
    setCrop((prev) => prev ? clampRect(prev, bounds, preset.aspect) : fitCenteredCrop(bounds, preset.aspect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation]);

  useEffect(() => {
    if (!imgEl) return;
    const bounds = cropBounds(imgEl.naturalWidth, imgEl.naturalHeight, baseScale * zoom, rotation);
    setCrop((prev) => prev ? clampRect(prev, bounds, preset.aspect) : fitCenteredCrop(bounds, preset.aspect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, baseScale]);

  const stageScale = baseScale * zoom;
  const bounds = imgEl
    ? cropBounds(imgEl.naturalWidth, imgEl.naturalHeight, stageScale, rotation)
    : { left: 0, top: 0, right: STAGE_W, bottom: STAGE_H };

  function onPointerDownMove(e: React.PointerEvent) {
    if (!crop) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = stageRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    dragRef.current = { mode: 'move', offX: px - crop.x, offY: py - crop.y };
  }
  function onPointerDownResize(e: React.PointerEvent) {
    if (!crop) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: 'resize' };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current || !crop || !imgEl) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (dragRef.current.mode === 'move') {
      const next = clampRect(
        { x: px - dragRef.current.offX, y: py - dragRef.current.offY, w: crop.w, h: crop.h },
        bounds, preset.aspect,
      );
      setCrop(next);
    } else {
      const newW = Math.max(32, px - crop.x);
      const next = clampRect({ x: crop.x, y: crop.y, w: newW, h: newW / preset.aspect },
        bounds, preset.aspect);
      setCrop(next);
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = null;
  }

  function rotateClockwise() {
    setRotation((r) => (r + 90) % 360);
  }

  const outputDims = useMemo(() => {
    if (!imgEl || !crop) return null;
    // 1 stage-pixel covers (1 / stageScale) source pixels.
    const srcW = crop.w / stageScale;
    const srcH = crop.h / stageScale;
    const outW = Math.round(Math.min(srcW, preset.maxWidth));
    const outH = Math.round(outW / preset.aspect);
    return { srcW, srcH, outW, outH };
  }, [imgEl, crop, stageScale, preset.maxWidth, preset.aspect]);

  async function confirm() {
    if (!imgEl || !crop || !file || !outputDims) return;
    setBusy(true);
    try {
      const { outW, outH } = outputDims;
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      // Fill with white so JPEG output has a clean background where the
      // source had transparency.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Replay the on-screen transform so the cropped pixels match what
      // the admin sees in the dialog.
      const k = outW / crop.w; // stage→output scale
      ctx.save();
      ctx.scale(k, k);
      ctx.translate(-crop.x, -crop.y);
      ctx.translate(STAGE_W / 2, STAGE_H / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(stageScale, stageScale);
      ctx.drawImage(imgEl, -imgEl.naturalWidth / 2, -imgEl.naturalHeight / 2);
      ctx.restore();

      // Pick the output type. PNG only when the source was PNG with
      // alpha (rare for hero/OG/gallery); otherwise JPEG for a smaller
      // file that respects the 10 MB limit.
      const keepPng = file.type === 'image/png';
      const outType = keepPng ? 'image/png' : 'image/jpeg';
      const quality = keepPng ? undefined : 0.9;
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => b ? resolve(b) : reject(new Error('toBlob failed')),
          outType,
          quality,
        );
      });
      const ext = outType === 'image/png' ? 'png' : 'jpg';
      const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
      const outFile = new File([blob], `${baseName}-cropped.${ext}`, {
        type: outType,
        lastModified: Date.now(),
      });
      onConfirm(outFile);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="max-w-3xl" data-testid="image-crop-dialog">
        <DialogHeader>
          <DialogTitle>Crop {preset.label.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Rotate or zoom the photo to taste, then drag the box to pick
            the area. Locked to <strong>{preset.hint}</strong> for the best fit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          <div
            className="relative bg-muted/30 rounded border overflow-hidden select-none"
            style={{ width: STAGE_W, height: STAGE_H, maxWidth: '100%' }}
          >
            {loadError ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive px-4 text-center" data-testid="crop-load-error">
                Couldn't read this image. Please pick a different file.
              </div>
            ) : imgUrl && imgEl ? (
              <div
                ref={stageRef}
                className="absolute inset-0"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                data-testid="crop-stage"
              >
                <img
                  src={imgUrl}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: imgEl.naturalWidth,
                    height: imgEl.naturalHeight,
                    transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${stageScale})`,
                    transformOrigin: 'center center',
                    userSelect: 'none',
                    pointerEvents: 'none',
                  }}
                />
                {crop && (
                  <>
                    {/* Dark overlay rendered as 4 rectangles around the crop box. */}
                    <div className="absolute inset-0 pointer-events-none">
                      <div className="absolute bg-black/55" style={{ left: 0, top: 0, width: '100%', height: crop.y }} />
                      <div className="absolute bg-black/55" style={{ left: 0, top: crop.y + crop.h, width: '100%', bottom: 0 }} />
                      <div className="absolute bg-black/55" style={{ left: 0, top: crop.y, width: crop.x, height: crop.h }} />
                      <div className="absolute bg-black/55" style={{ left: crop.x + crop.w, top: crop.y, right: 0, height: crop.h }} />
                    </div>
                    <div
                      className="absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)] cursor-move"
                      style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}
                      onPointerDown={onPointerDownMove}
                      data-testid="crop-box"
                    />
                    <div
                      className="absolute bg-white border border-black/60 cursor-nwse-resize"
                      style={{
                        left: crop.x + crop.w - HANDLE / 2,
                        top: crop.y + crop.h - HANDLE / 2,
                        width: HANDLE, height: HANDLE,
                      }}
                      onPointerDown={onPointerDownResize}
                      data-testid="crop-resize-handle"
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading image…
              </div>
            )}
          </div>

          {imgEl && !loadError && (
            <div className="flex w-full max-w-md items-center gap-3" data-testid="crop-controls">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={rotateClockwise}
                disabled={busy}
                data-testid="button-rotate-crop"
                title="Rotate 90° clockwise"
              >
                <RotateCw className="w-4 h-4 mr-1" />
                Rotate
              </Button>
              <ZoomOut className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
              <Slider
                value={[zoom]}
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                onValueChange={(v) => setZoom(v[0] ?? 1)}
                disabled={busy}
                aria-label="Zoom"
                data-testid="slider-zoom-crop"
                className="flex-1"
              />
              <ZoomIn className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-xs tabular-nums text-muted-foreground w-12 text-right" data-testid="text-zoom-value">
                {zoom.toFixed(2)}×
              </span>
            </div>
          )}

          {outputDims && (
            <div className="text-xs text-muted-foreground" data-testid="crop-output-info">
              Output: {outputDims.outW} × {outputDims.outH}px
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy} data-testid="button-cancel-crop">
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || !crop || !imgEl} data-testid="button-confirm-crop">
            {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Use cropped image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
