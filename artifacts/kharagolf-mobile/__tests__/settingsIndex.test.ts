/**
 * Unit tests for the searchable settings index (Task #1836).
 *
 * The settings index is what makes the new side-game receipts toggle —
 * and the rest of the per-event email opt-out rows on the
 * /my-360/communications screen — discoverable from a top-level search
 * bar on the More tab. These tests pin down three things:
 *
 *   1. The index always emits the side-game receipts entry, with the
 *      `focus=sideGameReceipts` deep-link param the destination screen
 *      uses to scroll to and highlight the row.
 *   2. The query matcher is forgiving: case, punctuation (`side-game`
 *      vs `side game`), partial tokens (`receipt` matches `receipts`),
 *      and English keywords still hit even when the localised label
 *      uses different wording.
 *   3. The admin gate hides the club-settings row from members and
 *      shows it to admins, mirroring the More-tab gate.
 */
import { describe, it, expect } from "vitest";
import {
  buildSettingsIndex,
  filterSettingsIndex,
} from "../lib/settingsIndex";

// Minimal i18n stub: returns the key if no override is registered,
// otherwise returns the override. Lets each test pin specific labels.
function makeT(overrides: Record<string, string> = {}) {
  return (key: string): string =>
    Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : key;
}

describe("buildSettingsIndex", () => {
  it("includes the side-game receipts deep link with the focus param", () => {
    const idx = buildSettingsIndex(makeT() as never);
    const sideGame = idx.find(e => e.id === "comms-side-game-receipts");
    expect(sideGame).toBeDefined();
    expect(sideGame!.href).toBe("/my-360/communications");
    expect(sideGame!.params).toEqual({ focus: "sideGameReceipts" });
  });

  it("hides the club-settings entry from non-admin members", () => {
    const idx = buildSettingsIndex(makeT() as never, { isAdmin: false });
    expect(idx.some(e => e.id === "club-settings")).toBe(false);
  });

  it("includes the club-settings entry for admin members", () => {
    const idx = buildSettingsIndex(makeT() as never, { isAdmin: true });
    expect(idx.some(e => e.id === "club-settings")).toBe(true);
  });

  it("emits unique ids across the whole index", () => {
    const idx = buildSettingsIndex(makeT() as never, { isAdmin: true });
    const ids = idx.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("filterSettingsIndex", () => {
  // Build the index with realistic English labels so the matcher tests
  // exercise the actual production strings the user types against.
  const t = makeT({
    "moreItems.wallet": "Wallet",
    "moreItems.notifications": "Notifications",
    "commPrefs.emailOptOuts.sideGameReceiptsLabel": "Side-game payment receipts",
    "commPrefs.emailOptOuts.sideGameReceiptsDesc":
      "Email receipts when another player settles a casual side-game wager with you.",
    "commPrefs.emailOptOuts.dataExportExpiringLabel":
      "Email me when a data export is about to expire",
    "commPrefs.emailOptOuts.dataExportExpiringDesc":
      "Reminder email a few days before a data export download link stops working.",
  });
  const index = buildSettingsIndex(t as never);

  it("returns nothing for an empty query", () => {
    expect(filterSettingsIndex(index, "")).toHaveLength(0);
    expect(filterSettingsIndex(index, "   ")).toHaveLength(0);
  });

  it("finds the side-game receipts row for the canonical query", () => {
    const hits = filterSettingsIndex(index, "side game receipts");
    expect(hits.some(h => h.id === "comms-side-game-receipts")).toBe(true);
  });

  it("treats hyphens and case as insignificant", () => {
    const hits = filterSettingsIndex(index, "SIDE-GAME");
    expect(hits.some(h => h.id === "comms-side-game-receipts")).toBe(true);
  });

  it("matches partial tokens (receipt → receipts)", () => {
    const hits = filterSettingsIndex(index, "receipt");
    expect(hits.some(h => h.id === "comms-side-game-receipts")).toBe(true);
  });

  it("matches English keywords even when the label does not contain them", () => {
    // "wager" is in the description; "skins" is in the keywords array.
    const wagerHits = filterSettingsIndex(index, "wager");
    expect(wagerHits.some(h => h.id === "comms-side-game-receipts")).toBe(true);
    const skinsHits = filterSettingsIndex(index, "skins");
    expect(skinsHits.some(h => h.id === "comms-side-game-receipts")).toBe(true);
  });

  it("requires every query token to match (AND, not OR)", () => {
    // "wallet receipt" — wallet matches the wallet entry, receipt matches
    // the side-game entry; neither row contains both, so no hits.
    expect(filterSettingsIndex(index, "wallet receipt")).toHaveLength(0);
  });

  it("returns no results for an unknown query", () => {
    expect(filterSettingsIndex(index, "zzznotathing")).toHaveLength(0);
  });
});
