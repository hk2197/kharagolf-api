/**
 * Task #739 — Automated tests for the marketing-site image cropper.
 *
 * Covers:
 *  - The crop dialog opens after picking a non-GIF file in the
 *    marketing-site upload button.
 *  - GIF picks bypass the cropper and call the upload helper directly.
 *  - The cropped File handed to onConfirm has the expected aspect ratio
 *    for each slot (hero 16:9, OG 1200x630, gallery 1:1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { ImageCropDialog, CROP_PRESETS, type CropKind } from "@/components/ImageCropDialog";
import { ImageUploadButton } from "@/pages/club-marketing-site";

// --- Image / canvas / URL stubs (jsdom doesn't implement these) ----------

const SOURCE_W = 4000;
const SOURCE_H = 3000;

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  private _src = "";
  set src(v: string) {
    this._src = v;
    // Fire onload on the next microtask so the dialog's useEffect path
    // mirrors a real image load.
    queueMicrotask(() => {
      this.naturalWidth = SOURCE_W;
      this.naturalHeight = SOURCE_H;
      this.onload?.();
    });
  }
  get src() { return this._src; }
}

interface ToBlobCapture { type: string | undefined; width: number; height: number; }
const toBlobCaptures: ToBlobCapture[] = [];

function installCanvasAndImageMocks() {
  toBlobCaptures.length = 0;
  vi.stubGlobal("Image", MockImage as unknown as typeof Image);

  const createObjectURL = vi.fn(() => "blob:mock");
  const revokeObjectURL = vi.fn();
  // jsdom's URL doesn't have these by default.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true, writable: true, value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true, writable: true, value: revokeObjectURL,
  });

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  })) as unknown as HTMLCanvasElement["getContext"];

  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
    type?: string,
  ) {
    toBlobCaptures.push({ type, width: this.width, height: this.height });
    cb(new Blob(["x"], { type: type ?? "image/png" }));
  };

  // setPointerCapture/releasePointerCapture are not implemented in jsdom
  // but the dialog calls them defensively — stub them out.
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = function () {};
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = function () {};
  }
}

beforeEach(() => {
  installCanvasAndImageMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Aspect ratio per slot -----------------------------------------------

describe("ImageCropDialog — cropped output aspect ratio (Task #739)", () => {
  async function getCroppedFile(kind: CropKind): Promise<File> {
    const file = new File([new Uint8Array(64)], "photo.jpg", { type: "image/jpeg" });
    const received: File[] = [];
    render(
      <ImageCropDialog
        open
        file={file}
        kind={kind}
        onCancel={() => {}}
        onConfirm={(f) => received.push(f)}
      />,
    );
    // Wait for the image load + initial crop + outputDims to render.
    await waitFor(() => {
      expect(screen.getByTestId("crop-output-info")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("button-confirm-crop"));
    await waitFor(() => {
      expect(received.length).toBe(1);
    });
    return received[0];
  }

  it.each<[CropKind, number]>([
    ["hero", CROP_PRESETS.hero.aspect],
    ["og", CROP_PRESETS.og.aspect],
    ["gallery", CROP_PRESETS.gallery.aspect],
  ])("produces a %s file matching the locked aspect ratio", async (kind, aspect) => {
    const cropped = await getCroppedFile(kind);

    // The cropped File is renamed and converted to JPEG (source was JPEG).
    expect(cropped.name).toBe("photo-cropped.jpg");
    expect(cropped.type).toBe("image/jpeg");

    const cap = toBlobCaptures[toBlobCaptures.length - 1];
    expect(cap).toBeDefined();
    const ratio = cap.width / cap.height;
    expect(ratio).toBeCloseTo(aspect, 2);
    // Output width is capped by the preset's maxWidth.
    expect(cap.width).toBeLessThanOrEqual(CROP_PRESETS[kind].maxWidth);
  });

  it("keeps PNG output type when the source is PNG", async () => {
    const file = new File([new Uint8Array(64)], "logo.png", { type: "image/png" });
    const received: File[] = [];
    render(
      <ImageCropDialog
        open
        file={file}
        kind="gallery"
        onCancel={() => {}}
        onConfirm={(f) => received.push(f)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("crop-output-info")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("button-confirm-crop"));
    await waitFor(() => expect(received.length).toBe(1));

    const cropped = received[0];
    expect(cropped.name).toBe("logo-cropped.png");
    expect(cropped.type).toBe("image/png");
    const cap = toBlobCaptures[toBlobCaptures.length - 1];
    expect(cap.type).toBe("image/png");
  });
});

// --- Marketing-site upload button: opens cropper / GIF bypass ------------

describe("ImageUploadButton — cropper integration (Task #739)", () => {
  function pickFile(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) },
    });
    fireEvent.change(input);
  }

  it("opens the crop dialog after picking a JPEG (and does not upload yet)", async () => {
    const onUpload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <ImageUploadButton onUpload={onUpload} label="Upload" cropKind="hero" />,
    );
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(input).not.toBeNull();

    const file = new File([new Uint8Array(32)], "hero.jpg", { type: "image/jpeg" });
    pickFile(input, file);

    await waitFor(() => {
      expect(screen.getByTestId("image-crop-dialog")).toBeInTheDocument();
    });
    expect(onUpload).not.toHaveBeenCalled();
  });

  it.each<[CropKind, number]>([
    ["hero", CROP_PRESETS.hero.aspect],
    ["og", CROP_PRESETS.og.aspect],
    ["gallery", CROP_PRESETS.gallery.aspect],
  ])(
    "end-to-end: picking a file then confirming uploads a %s-cropped File with the right aspect",
    async (kind, aspect) => {
      const uploaded: File[] = [];
      const onUpload = (f: File) => {
        uploaded.push(f);
        return Promise.resolve();
      };
      const { container } = render(
        <ImageUploadButton onUpload={onUpload} label="Upload" cropKind={kind} />,
      );
      const input = container.querySelector('input[type=file]') as HTMLInputElement;
      const file = new File([new Uint8Array(32)], "pic.jpg", { type: "image/jpeg" });
      pickFile(input, file);

      await waitFor(() => {
        expect(screen.getByTestId("crop-output-info")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("button-confirm-crop"));

      await waitFor(() => expect(uploaded.length).toBe(1));
      const cropped = uploaded[0];
      // It must be the cropped file (renamed), not the raw pick.
      expect(cropped).not.toBe(file);
      expect(cropped.name).toBe("pic-cropped.jpg");
      const cap = toBlobCaptures[toBlobCaptures.length - 1];
      expect(cap.width / cap.height).toBeCloseTo(aspect, 2);
      expect(cap.width).toBeLessThanOrEqual(CROP_PRESETS[kind].maxWidth);
    },
  );

  it("bypasses the cropper for animated GIFs and uploads the original file", async () => {
    const onUpload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <ImageUploadButton onUpload={onUpload} label="Upload" cropKind="gallery" />,
    );
    const input = container.querySelector('input[type=file]') as HTMLInputElement;

    const gif = new File([new Uint8Array(8)], "anim.gif", { type: "image/gif" });
    pickFile(input, gif);

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledTimes(1);
    });
    const passed = onUpload.mock.calls[0][0] as File;
    expect(passed).toBe(gif);
    expect(passed.type).toBe("image/gif");
    // The cropper must NOT open for GIFs.
    expect(screen.queryByTestId("image-crop-dialog")).toBeNull();
  });
});
