/**
 * Task #2130 — unit coverage for the per-coach drawing clipboard storage
 * helper on mobile. Verifies the round-trip survives a simulated app
 * relaunch (separate `load` calls), keeps coaches isolated from each
 * other on a shared phone, and removes the entry on empty-array save /
 * explicit clear / sign-out cleanup (which is wired to AuthProvider).
 */
import { describe, it, expect, beforeEach } from "vitest";

const memoryStore = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    multiRemove: (keys: string[]) => {
      for (const k of keys) memoryStore.delete(k);
      return Promise.resolve();
    },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

import { vi } from "vitest";
import {
  loadCoachDrawingClipboard,
  saveCoachDrawingClipboard,
  clearCoachDrawingClipboard,
  clearAllCoachDrawingClipboards,
} from "@/utils/coachDrawingClipboard";

interface SampleShape {
  kind: "circle";
  t: number;
  x: number;
  y: number;
  r: number;
  color: string;
}

const SAMPLE: SampleShape[] = [
  { kind: "circle", t: 0.4, x: 100, y: 200, r: 30, color: "#fff" },
  { kind: "circle", t: 1.2, x: 110, y: 210, r: 22, color: "#fff" },
];

beforeEach(() => {
  memoryStore.clear();
});

describe("coachDrawingClipboard (mobile)", () => {
  it("returns an empty array when nothing has been saved yet", async () => {
    expect(await loadCoachDrawingClipboard(42)).toEqual([]);
  });

  it("round-trips shapes for a coach across separate load calls (the relaunch case)", async () => {
    await saveCoachDrawingClipboard(42, SAMPLE);
    expect(await loadCoachDrawingClipboard<SampleShape>(42)).toEqual(SAMPLE);
  });

  it("keeps each coach's clipboard isolated from the others", async () => {
    await saveCoachDrawingClipboard(1, SAMPLE);
    await saveCoachDrawingClipboard(2, [SAMPLE[0]]);
    expect(await loadCoachDrawingClipboard<SampleShape>(1)).toEqual(SAMPLE);
    expect(await loadCoachDrawingClipboard<SampleShape>(2)).toEqual([SAMPLE[0]]);
  });

  it("removes the entry when the saved array is empty (the clear path)", async () => {
    await saveCoachDrawingClipboard(7, SAMPLE);
    await saveCoachDrawingClipboard(7, []);
    expect(await loadCoachDrawingClipboard(7)).toEqual([]);
    expect(memoryStore.has("kharagolf:coachDrawingClipboard:7")).toBe(false);
  });

  it("clearCoachDrawingClipboard removes only the targeted coach's entry", async () => {
    await saveCoachDrawingClipboard(1, SAMPLE);
    await saveCoachDrawingClipboard(2, SAMPLE);
    await clearCoachDrawingClipboard(1);
    expect(await loadCoachDrawingClipboard(1)).toEqual([]);
    expect(await loadCoachDrawingClipboard<SampleShape>(2)).toEqual(SAMPLE);
  });

  it("clearAllCoachDrawingClipboards wipes every coach's clipboard but leaves unrelated keys alone", async () => {
    await saveCoachDrawingClipboard(1, SAMPLE);
    await saveCoachDrawingClipboard(2, SAMPLE);
    memoryStore.set("unrelated", "keep me");
    await clearAllCoachDrawingClipboards();
    expect(await loadCoachDrawingClipboard(1)).toEqual([]);
    expect(await loadCoachDrawingClipboard(2)).toEqual([]);
    expect(memoryStore.get("unrelated")).toBe("keep me");
  });

  it("returns an empty array on corrupted JSON instead of throwing", async () => {
    memoryStore.set("kharagolf:coachDrawingClipboard:9", "{not json");
    expect(await loadCoachDrawingClipboard(9)).toEqual([]);
  });

  it("returns an empty array when the stored payload is not an array", async () => {
    memoryStore.set("kharagolf:coachDrawingClipboard:9", '"oops"');
    expect(await loadCoachDrawingClipboard(9)).toEqual([]);
  });
});
