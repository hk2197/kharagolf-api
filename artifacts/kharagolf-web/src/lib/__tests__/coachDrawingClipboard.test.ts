/**
 * Task #2130 — unit coverage for the per-coach drawing clipboard storage
 * helper. Verifies the round-trip survives a simulated tab refresh
 * (separate `load` calls), keeps coaches isolated from each other on a
 * shared device, and removes the entry on empty-array save / explicit
 * clear / sign-out cleanup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadCoachDrawingClipboard,
  saveCoachDrawingClipboard,
  clearCoachDrawingClipboard,
  clearAllCoachDrawingClipboards,
} from "../coachDrawingClipboard";

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

describe("coachDrawingClipboard (web)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty array when nothing has been saved yet", () => {
    expect(loadCoachDrawingClipboard(42)).toEqual([]);
  });

  it("round-trips shapes for a coach across separate load calls (the refresh case)", () => {
    saveCoachDrawingClipboard(42, SAMPLE);
    // Simulate a fresh page load — the in-memory state is gone but
    // localStorage still holds the entry.
    expect(loadCoachDrawingClipboard<SampleShape>(42)).toEqual(SAMPLE);
  });

  it("keeps each coach's clipboard isolated from the others", () => {
    saveCoachDrawingClipboard(1, SAMPLE);
    saveCoachDrawingClipboard(2, [SAMPLE[0]]);
    expect(loadCoachDrawingClipboard<SampleShape>(1)).toEqual(SAMPLE);
    expect(loadCoachDrawingClipboard<SampleShape>(2)).toEqual([SAMPLE[0]]);
  });

  it("removes the entry when the saved array is empty (the clear path)", () => {
    saveCoachDrawingClipboard(7, SAMPLE);
    saveCoachDrawingClipboard(7, []);
    expect(loadCoachDrawingClipboard(7)).toEqual([]);
    // No empty placeholder left behind.
    expect(window.localStorage.getItem("kharagolf:coachDrawingClipboard:7")).toBeNull();
  });

  it("clearCoachDrawingClipboard removes only the targeted coach's entry", () => {
    saveCoachDrawingClipboard(1, SAMPLE);
    saveCoachDrawingClipboard(2, SAMPLE);
    clearCoachDrawingClipboard(1);
    expect(loadCoachDrawingClipboard(1)).toEqual([]);
    expect(loadCoachDrawingClipboard<SampleShape>(2)).toEqual(SAMPLE);
  });

  it("clearAllCoachDrawingClipboards wipes every coach's clipboard but leaves unrelated keys alone", () => {
    saveCoachDrawingClipboard(1, SAMPLE);
    saveCoachDrawingClipboard(2, SAMPLE);
    window.localStorage.setItem("unrelated", "keep me");
    clearAllCoachDrawingClipboards();
    expect(loadCoachDrawingClipboard(1)).toEqual([]);
    expect(loadCoachDrawingClipboard(2)).toEqual([]);
    expect(window.localStorage.getItem("unrelated")).toBe("keep me");
  });

  it("returns an empty array on corrupted JSON instead of throwing", () => {
    window.localStorage.setItem("kharagolf:coachDrawingClipboard:9", "{not json");
    expect(loadCoachDrawingClipboard(9)).toEqual([]);
  });

  it("returns an empty array when the stored payload is not an array", () => {
    window.localStorage.setItem("kharagolf:coachDrawingClipboard:9", '"oops"');
    expect(loadCoachDrawingClipboard(9)).toEqual([]);
  });
});
