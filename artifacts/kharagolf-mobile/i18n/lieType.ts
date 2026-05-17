/**
 * Shared mapping from a raw `lieType` string returned by the API
 * (e.g. "fairway", "Sand", "BUNKER", null) to the canonical translation
 * key under `profile:caddieLie.*`.
 *
 * Mirrors `lieAdjustmentLabel` in `artifacts/api-server/src/lib/caddie.ts`
 * so the same raw value always renders as the same label everywhere it
 * surfaces in the mobile app:
 *   - null / empty / unrecognized → "fairway" (server fallback)
 *   - "sand" and "bunker" both collapse to "bunker"
 *   - tee, fairway, green, rough, hazard, unknown map to themselves
 */
import type { TFunction } from "i18next";

export const LIE_TRANSLATION_KEYS = [
  "tee",
  "fairway",
  "rough",
  "bunker",
  "hazard",
  "green",
  "unknown",
] as const;

export type LieTranslationKey = (typeof LIE_TRANSLATION_KEYS)[number];

const RAW_TO_KEY: Record<string, LieTranslationKey> = {
  tee: "tee",
  fairway: "fairway",
  rough: "rough",
  sand: "bunker",
  bunker: "bunker",
  hazard: "hazard",
  green: "green",
  unknown: "unknown",
};

export function lieTranslationKey(raw: string | null | undefined): LieTranslationKey {
  if (raw == null) return "fairway";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return "fairway";
  return RAW_TO_KEY[normalized] ?? "fairway";
}

export function translateLieType(t: TFunction, raw: string | null | undefined): string {
  return t(`caddieLie.${lieTranslationKey(raw)}`);
}
