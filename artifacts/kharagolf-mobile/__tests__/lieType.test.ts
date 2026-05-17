/**
 * Pins the canonicalisation rules for `lieTranslationKey` so the mobile
 * lie-label helper stays aligned with `lieAdjustmentLabel` on the API
 * server (artifacts/api-server/src/lib/caddie.ts):
 *   - null/empty/unrecognized fall back to "fairway"
 *   - case and surrounding whitespace are normalised
 *   - "sand" and "bunker" both collapse to "bunker"
 */
import { describe, it, expect, vi } from "vitest";
import { lieTranslationKey, translateLieType } from "@/i18n/lieType";

describe("lieTranslationKey", () => {
  it("maps known lies to themselves", () => {
    expect(lieTranslationKey("tee")).toBe("tee");
    expect(lieTranslationKey("fairway")).toBe("fairway");
    expect(lieTranslationKey("rough")).toBe("rough");
    expect(lieTranslationKey("hazard")).toBe("hazard");
    expect(lieTranslationKey("green")).toBe("green");
    expect(lieTranslationKey("unknown")).toBe("unknown");
  });

  it("collapses sand and bunker into bunker (server canonical label)", () => {
    expect(lieTranslationKey("sand")).toBe("bunker");
    expect(lieTranslationKey("Sand")).toBe("bunker");
    expect(lieTranslationKey("BUNKER")).toBe("bunker");
    expect(lieTranslationKey("bunker")).toBe("bunker");
  });

  it("normalises case and whitespace", () => {
    expect(lieTranslationKey("Fairway")).toBe("fairway");
    expect(lieTranslationKey("  ROUGH  ")).toBe("rough");
    expect(lieTranslationKey("Tee")).toBe("tee");
  });

  it("falls back to fairway for null/empty/unrecognized values", () => {
    expect(lieTranslationKey(null)).toBe("fairway");
    expect(lieTranslationKey(undefined)).toBe("fairway");
    expect(lieTranslationKey("")).toBe("fairway");
    expect(lieTranslationKey("   ")).toBe("fairway");
    expect(lieTranslationKey("waste-area")).toBe("fairway");
  });
});

describe("translateLieType", () => {
  it("looks up the caddieLie translation for the canonical key", () => {
    const t = vi.fn((key: string) => `t:${key}`) as unknown as Parameters<typeof translateLieType>[0];
    expect(translateLieType(t, "Sand")).toBe("t:caddieLie.bunker");
    expect(translateLieType(t, null)).toBe("t:caddieLie.fairway");
    expect(translateLieType(t, "rough")).toBe("t:caddieLie.rough");
  });
});
