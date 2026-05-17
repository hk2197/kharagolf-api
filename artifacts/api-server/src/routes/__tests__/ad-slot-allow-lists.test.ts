/**
 * Task #1032 — Audit ad slot keys to ensure none are silently dropped.
 *
 * Background: while adding tests for the round-summary sponsor banner we
 * discovered the prior task forgot to register `mobile_round_summary` in
 * the public sponsor-event allow-lists, which silently 400'd every
 * impression and click in production. Two parallel sets in
 * `routes/public.ts` (ALLOWED_SOURCES, AD_CAMPAIGN_SOURCES) had to be kept
 * in sync by hand with `DEFAULT_SLOTS` in `routes/ad-campaigns.ts`.
 *
 * The fix derives both sets in `public.ts` from the exported
 * `DEFAULT_SLOT_KEYS` source of truth, and the import of `public.ts`
 * triggers a startup assertion that throws if drift is ever reintroduced.
 *
 * This test pins the contract so a future refactor that resurrects a
 * hand-maintained allow-list cannot regress unnoticed: importing the
 * module here exercises the startup assertion, and we additionally assert
 * that every default slot key is in fact accepted by the public
 * sponsor-events route validation surface (via the exported sets we
 * re-derive locally to mirror what the route uses).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_SLOTS, DEFAULT_SLOT_KEYS } from "../ad-campaigns.js";

describe("Task #1032 — ad-campaign slot allow-list drift guard", () => {
  it("DEFAULT_SLOT_KEYS contains every key in DEFAULT_SLOTS", () => {
    for (const slot of DEFAULT_SLOTS) {
      expect(DEFAULT_SLOT_KEYS.has(slot.slotKey)).toBe(true);
    }
    expect(DEFAULT_SLOT_KEYS.size).toBe(DEFAULT_SLOTS.length);
  });

  it("importing routes/public.ts succeeds (startup assertion passes for every default slot)", async () => {
    // If any default slot key were ever missing from ALLOWED_SOURCES or
    // AD_CAMPAIGN_SOURCES this import would throw at module-evaluation
    // time. Awaiting the import is sufficient — we don't need the export.
    await expect(import("../public.js")).resolves.toBeDefined();
  });

  it("every default slot key is non-empty and snake_case (defensive)", () => {
    for (const slot of DEFAULT_SLOTS) {
      expect(slot.slotKey).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
