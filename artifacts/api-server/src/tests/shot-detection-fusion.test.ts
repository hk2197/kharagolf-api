import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @workspace/db before importing the module under test, so loadGreens()
// returns deterministic green coordinates without touching the real database.
// The select shape mirrors holeDetailsTable's actual column names: greenCentreLat
// and greenCentreLng (both numeric/text, parsed via parseFloat in the lib).
// Stateful in-memory store for the gps_chunk_buffer table so the persisted
// GPS chunk buffer (Task #690) can be exercised end-to-end without standing
// up a real Postgres. Keyed identically to the real unique index
// (user_id, context_key, sample_timestamp_ms).
type GpsRow = {
  id: number;
  userId: number;
  contextKey: string;
  sampleTimestampMs: string;
  lat: string;
  lng: string;
  accuracyM: string | null;
};
const _gpsRows: GpsRow[] = [];
let _gpsId = 1;

vi.mock("@workspace/db", () => {
  const greens = Array.from({ length: 18 }, (_, i) => ({
    holeNumber: i + 1,
    greenCentreLat: "0.0",
    greenCentreLng: String(0.001 * (i + 1)), // ~111m apart per .001 deg
  }));

  // Marker objects that the lib uses as "table" references.
  const gpsChunkBufferTable = { __name: "gps_chunk_buffer" } as Record<string, unknown>;
  const isGps = (t: unknown) => t === gpsChunkBufferTable;

  // Filter a single drizzle "where(...)" clause our lib produces. The lib
  // builds three shapes: equality on userId+contextKey (+ optional lte on
  // sampleTimestampMs). The mock pulls those values out of the (cond) arg
  // by stashing them on the helpers below.
  type Cond = { __filter: (r: GpsRow) => boolean };
  const eq = (col: { __col: keyof GpsRow }, v: unknown): Cond => ({
    __filter: (r) => String(r[col.__col]) === String(v),
  });
  const lte = (col: { __col: keyof GpsRow }, v: unknown): Cond => ({
    __filter: (r) => Number(r[col.__col]) <= Number(v),
  });
  const gte = (col: { __col: keyof GpsRow }, v: unknown): Cond => ({
    __filter: (r) => Number(r[col.__col]) >= Number(v),
  });
  const and = (...cs: Cond[]): Cond => ({ __filter: (r) => cs.every(c => c.__filter(r)) });

  // Replace bound table column refs with markers carrying their key name.
  for (const k of ["userId", "contextKey", "sampleTimestampMs", "lat", "lng", "accuracyM"]) {
    gpsChunkBufferTable[k] = { __col: k };
  }

  const db = {
    select: (shape?: Record<string, unknown>) => ({
      from: (t: unknown) => ({
        where: (cond?: Cond) => {
          if (isGps(t)) {
            const filtered = cond ? _gpsRows.filter(cond.__filter) : _gpsRows.slice();
            // count(*) shape
            if (shape && "count" in shape) {
              return Promise.resolve([{ count: filtered.length }]);
            }
            return Promise.resolve(filtered.map(r => ({ ...r })));
          }
          return Promise.resolve(greens);
        },
      }),
    }),
    insert: (t: unknown) => ({
      values: (vs: Array<Omit<GpsRow, "id">>) => {
        const vals = Array.isArray(vs) ? vs : [vs];
        const onConflictDoNothing = () => {
          if (!isGps(t)) return Promise.resolve();
          for (const v of vals) {
            const dup = _gpsRows.some(r =>
              r.userId === v.userId &&
              r.contextKey === v.contextKey &&
              r.sampleTimestampMs === v.sampleTimestampMs);
            if (!dup) _gpsRows.push({ id: _gpsId++, ...v });
          }
          return Promise.resolve();
        };
        // Some callers don't go through onConflict; mirror the same insert.
        const thenable = {
          onConflictDoNothing,
          then: (resolve: (v: unknown) => void) => onConflictDoNothing().then(resolve),
        };
        return thenable;
      },
    }),
    delete: (t: unknown) => ({
      where: (cond?: Cond) => {
        if (!isGps(t)) return Promise.resolve();
        for (let i = _gpsRows.length - 1; i >= 0; i--) {
          if (!cond || cond.__filter(_gpsRows[i])) _gpsRows.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: () => Promise.resolve(),
  };

  return {
    db,
    gpsChunkBufferTable,
    shotsTable: {},
    holeDetailsTable: {},
    watchMotionBufferTable: {},
    // drizzle-orm helpers used by shot-detection.ts. We re-export from this
    // mock so the lib's `eq`/`and`/`lte` resolve to our filter-builder shims
    // even though the real package isn't loaded for the tests of the buffer.
    __esModule: true,
  };
});

// Override drizzle-orm helpers so the lib's eq/and/lte/gte resolve to the
// filter builders our mock above understands.
vi.mock("drizzle-orm", async () => {
  const eq = (col: { __col: string }, v: unknown) => ({
    __filter: (r: Record<string, unknown>) => String(r[col.__col]) === String(v),
  });
  const lte = (col: { __col: string }, v: unknown) => ({
    __filter: (r: Record<string, unknown>) => Number(r[col.__col]) <= Number(v),
  });
  const gte = (col: { __col: string }, v: unknown) => ({
    __filter: (r: Record<string, unknown>) => Number(r[col.__col]) >= Number(v),
  });
  const and = (...cs: Array<{ __filter: (r: Record<string, unknown>) => boolean }>) => ({
    __filter: (r: Record<string, unknown>) => cs.every(c => c.__filter(r)),
  });
  // sql is only used inside db.execute in our lib (raw cap enforcement),
  // and the mock execute is a no-op — a stub function suffices.
  const sql = Object.assign(() => ({}), { raw: () => ({}) });
  return { eq, lte, gte, and, sql };
});

import {
  detectShotsFromSignals,
  detectedShotsToInsert,
  SENSITIVITY_PRESETS,
  bufferGPSSamples,
  peekGPSSamples,
  clearGPSSamples,
  mergeBufferedGPS,
  pruneExpiredGpsBuffersGlobal,
} from "../lib/shot-detection";

describe("shot-detection fusion + dedupe + hole progression", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deduplicates a single swing recorded by all three sources within 8s", async () => {
    // Wearable + motion + GPS-stop all describing the same swing must collapse
    // to one shot, with the wearable winning on precedence.
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: Array.from({ length: 30 }, (_, i) => ({
        lat: 0.0, lng: 0.0005, timestamp: t0 + i * 500,
      })),
      motion: [{ timestamp: t0 + 1_000, peakG: 1.2 }],
      wearableShots: [
        { lat: 0.0, lng: 0.0005, timestamp: t0, shotType: "tee", club: "driver" },
      ],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe("wearable");
  });

  it("emits separate shots for two swings spaced beyond the dedupe window", async () => {
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: [
        ...Array.from({ length: 20 }, (_, i) => ({ lat: 0.0, lng: 0.0005, timestamp: t0 + i * 500 })),
        ...Array.from({ length: 20 }, (_, i) => ({ lat: 0.0, lng: 0.0008, timestamp: t0 + 60_000 + i * 500 })),
      ],
      motion: [],
      wearableShots: [
        { lat: 0.0, lng: 0.0005, timestamp: t0,           shotType: "tee",     club: "driver" },
        { lat: 0.0, lng: 0.0008, timestamp: t0 + 60_000,  shotType: "fairway", club: "7i" },
      ],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBe(2);
    expect(result.every(r => r.source === "wearable")).toBe(true);
  });

  it("falls back to motion+GPS fusion when no wearable signal is present", async () => {
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: Array.from({ length: 30 }, (_, i) => ({
        lat: 0.0, lng: 0.0005, timestamp: t0 + i * 500,
      })),
      motion: [{ timestamp: t0 + 1_000, peakG: 1.2 }],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(["fused", "motion", "gps"]).toContain(result[0].source);
  });

  it("keeps multi-putt holes on the same hole instead of advancing on first putt", async () => {
    // Player hits an approach near hole 1's green (lng 0.001), then takes
    // two putts on the green itself. All three should remain on hole 1, not
    // spill onto hole 2.
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const onGreenLat = 0.0;
    const onGreenLng = 0.001;
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: [],
      motion: [],
      wearableShots: [
        // Approach from 30m short of the green
        { lat: onGreenLat, lng: onGreenLng - 0.0003, timestamp: t0,           shotType: "approach", club: "9i" },
        // First putt on the green
        { lat: onGreenLat, lng: onGreenLng,          timestamp: t0 + 60_000,  shotType: "putt",     club: "putter" },
        // Second putt on the green
        { lat: onGreenLat, lng: onGreenLng,          timestamp: t0 + 120_000, shotType: "putt",     club: "putter" },
      ],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBe(3);
    expect(result.map(r => r.holeNumber)).toEqual([1, 1, 1]);
  });

  it("preserves wearable-provided shotType and club through detect + insert mapping", async () => {
    // Garmin labelled this as a putt with a putter even though we placed it
    // 8m from the pin (where our distance heuristic would say "chip"). The
    // wearable classification must win, and survive the insert mapping so
    // SG category splits are computed against the right category.
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: [],
      motion: [],
      wearableShots: [
        { lat: 0.0, lng: 0.001, timestamp: t0,           shotType: "tee",  club: "driver" },
        { lat: 0.0, lng: 0.001, timestamp: t0 + 60_000,  shotType: "putt", club: "putter" },
      ],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBe(2);
    expect(result[0].shotType).toBe("tee");
    expect(result[0].club).toBe("driver");
    expect(result[0].shotTypeFromWearable).toBe(true);
    expect(result[1].shotType).toBe("putt");
    expect(result[1].club).toBe("putter");
    expect(result[1].shotTypeFromWearable).toBe(true);

    const rows = detectedShotsToInsert(result, { round: 1, userId: 7 });
    expect(rows[0].shotType).toBe("tee");
    expect(rows[0].club).toBe("driver");
    expect(rows[1].shotType).toBe("putt");
    expect(rows[1].club).toBe("putter");
  });

  it("advances to the next hole only when a candidate is closer to the next green", async () => {
    // Two shots near hole 1's green, then one shot clearly closer to hole 2's
    // green (lng 0.002). The third shot should be on hole 2.
    const t0 = Date.parse("2026-04-18T10:00:00Z");
    const result = await detectShotsFromSignals({
      courseId: 1,
      gps: [],
      motion: [],
      wearableShots: [
        { lat: 0.0, lng: 0.001,   timestamp: t0,            shotType: "approach", club: "9i" },
        { lat: 0.0, lng: 0.001,   timestamp: t0 + 60_000,   shotType: "putt",     club: "putter" },
        // Now near hole 2's green
        { lat: 0.0, lng: 0.0019,  timestamp: t0 + 600_000,  shotType: "approach", club: "8i" },
      ],
      sensitivity: SENSITIVITY_PRESETS.medium,
    });

    expect(result.length).toBe(3);
    expect(result.map(r => r.holeNumber)).toEqual([1, 1, 2]);
  });
});

describe("GPS chunk buffer (Task #525, persisted in Task #690)", () => {
  beforeEach(async () => {
    await clearGPSSamples(7777, "t:1:r:1");
    await clearGPSSamples(7777, "g:9:r:1");
  });

  it("merges chunks idempotently — replayed chunks contribute zero new samples", async () => {
    const t0 = Date.parse("2026-04-19T10:00:00Z");
    const chunk = Array.from({ length: 5 }, (_, i) => ({
      lat: 0.0, lng: 0.0001 * i, timestamp: t0 + i * 5000,
    }));
    expect(await bufferGPSSamples(7777, "t:1:r:1", chunk)).toBe(5);
    // Replay the exact same chunk — count must not grow.
    expect(await bufferGPSSamples(7777, "t:1:r:1", chunk)).toBe(5);
    // A partially-overlapping retry contributes only the truly new samples.
    const overlap = [
      { lat: 0.0, lng: 0.0004, timestamp: t0 + 4 * 5000 }, // dup
      { lat: 0.0, lng: 0.0005, timestamp: t0 + 5 * 5000 }, // new
      { lat: 0.0, lng: 0.0006, timestamp: t0 + 6 * 5000 }, // new
    ];
    expect(await bufferGPSSamples(7777, "t:1:r:1", overlap)).toBe(7);
    const peeked = await peekGPSSamples(7777, "t:1:r:1");
    // Time-sorted, no duplicates by timestamp.
    expect(peeked.map(s => s.timestamp)).toEqual([
      t0, t0 + 5000, t0 + 10000, t0 + 15000, t0 + 20000, t0 + 25000, t0 + 30000,
    ]);
  });

  it("scopes buffers per (user,context) — tournament round 1 ≠ general-play round 1", async () => {
    const t0 = Date.parse("2026-04-19T10:00:00Z");
    await bufferGPSSamples(7777, "t:1:r:1", [{ lat: 1, lng: 1, timestamp: t0 }]);
    await bufferGPSSamples(7777, "g:9:r:1", [{ lat: 2, lng: 2, timestamp: t0 }]);
    expect((await peekGPSSamples(7777, "t:1:r:1")).map(s => s.lat)).toEqual([1]);
    expect((await peekGPSSamples(7777, "g:9:r:1")).map(s => s.lat)).toEqual([2]);
  });

  it("clearGPSSamples drops the buffer for the round (post-commit cleanup)", async () => {
    await bufferGPSSamples(7777, "t:1:r:1", [{ lat: 1, lng: 1, timestamp: Date.now() }]);
    expect((await peekGPSSamples(7777, "t:1:r:1")).length).toBe(1);
    await clearGPSSamples(7777, "t:1:r:1");
    expect((await peekGPSSamples(7777, "t:1:r:1")).length).toBe(0);
  });

  it("mergeBufferedGPS combines server-buffered chunks + request gps without duplicates", async () => {
    const t0 = Date.parse("2026-04-19T10:00:00Z");
    await bufferGPSSamples(7777, "t:1:r:1", [
      { lat: 0, lng: 0, timestamp: t0 },
      { lat: 0, lng: 0, timestamp: t0 + 1000 },
    ]);
    const merged = await mergeBufferedGPS(7777, "t:1:r:1", [
      { lat: 0, lng: 0, timestamp: t0 + 1000 }, // dup
      { lat: 0, lng: 0, timestamp: t0 + 2000 }, // new
    ]);
    expect(merged.map(s => s.timestamp)).toEqual([t0, t0 + 1000, t0 + 2000]);
  });

  it("global TTL sweep purges expired rows from abandoned (user,context) pairs", async () => {
    // An abandoned round leaves rows in the table whose owning context is
    // never touched again. The opportunistic global prune must reap them
    // even though no caller ever reads/writes that specific (user,context).
    const fresh = Date.now() - 60_000; // 1 min old — well within TTL
    const stale = Date.now() - (9 * 60 * 60 * 1000); // 9 h old — beyond 8 h TTL
    await bufferGPSSamples(5555, "g:abandoned:r:1", [{ lat: 0, lng: 0, timestamp: fresh }]);
    await bufferGPSSamples(6666, "t:active:r:1", [{ lat: 0, lng: 0, timestamp: fresh }]);
    // Inject a stale row directly into the mock store via a buffer call
    // whose timestamp is below the cutoff — the per-context prune at write
    // time would normally reject it, so we bypass by writing fresh first
    // then mutating the row to look stale (mirrors the "abandoned days ago"
    // shape the global sweep needs to handle).
    _gpsRows.find(r => r.userId === 5555)!.sampleTimestampMs = String(stale);

    await pruneExpiredGpsBuffersGlobal();

    // The stale row from the abandoned context is gone, even though we
    // never touched (5555, "g:abandoned:r:1") again after the sweep.
    expect((await peekGPSSamples(5555, "g:abandoned:r:1")).length).toBe(0);
    // The fresh row from the still-active context is untouched.
    expect((await peekGPSSamples(6666, "t:active:r:1")).length).toBe(1);
  });

  it("survives a simulated server restart — persisted rows are read back as before", async () => {
    // Simulate the original Task #690 failure mode: the phone streams chunks
    // mid-round, the server process restarts, and the round-end commit must
    // still see those samples. With the in-memory Map the second peek would
    // be empty; with the persisted buffer the rows are still in the table.
    const t0 = Date.parse("2026-04-19T10:00:00Z");
    await bufferGPSSamples(8888, "t:42:r:1", [
      { lat: 0, lng: 0, timestamp: t0 },
      { lat: 0, lng: 0, timestamp: t0 + 5000 },
      { lat: 0, lng: 0, timestamp: t0 + 10000 },
    ]);
    // Re-import the lib to mimic a fresh process (no module-level Map state).
    vi.resetModules();
    const fresh = await import("../lib/shot-detection");
    const after = await fresh.peekGPSSamples(8888, "t:42:r:1");
    expect(after.map(s => s.timestamp)).toEqual([t0, t0 + 5000, t0 + 10000]);
    await fresh.clearGPSSamples(8888, "t:42:r:1");
  });
});
