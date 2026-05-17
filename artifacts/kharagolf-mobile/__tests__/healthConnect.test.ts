import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Platform = "ios" | "android" | "web";

interface NativeMock {
  isAvailable: ReturnType<typeof vi.fn>;
  requestAuthorization: ReturnType<typeof vi.fn>;
  readLast7Days: ReturnType<typeof vi.fn>;
}

interface Mocks {
  native: NativeMock | null;
  fetch: ReturnType<typeof vi.fn>;
}

let mocks: Mocks;

function makeNativeMock(): NativeMock {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    requestAuthorization: vi.fn().mockResolvedValue(true),
    readLast7Days: vi.fn().mockResolvedValue([]),
  };
}

async function loadModule(platform: Platform, opts: { withNative?: boolean } = {}) {
  vi.resetModules();
  const withNative = opts.withNative ?? (platform === "android");
  const native = withNative ? makeNativeMock() : null;
  mocks = {
    native,
    fetch: vi.fn().mockResolvedValue({ ok: true }),
  };

  vi.doMock("react-native", () => ({
    Platform: { OS: platform },
    NativeModules: { KharagolfHealthConnect: native ?? undefined },
  }));
  vi.doMock("@/utils/api", () => ({ BASE_URL: "https://test.example" }));

  globalThis.fetch = mocks.fetch as unknown as typeof fetch;

  return await import("../utils/healthConnect");
}

describe("healthConnect", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    vi.doUnmock("react-native");
    vi.doUnmock("@/utils/api");
    globalThis.fetch = originalFetch;
  });

  describe("isHealthConnectSupported / no-ops on iOS & web", () => {
    it("syncHealthConnectLast7Days is a no-op on iOS", async () => {
      const mod = await loadModule("ios", { withNative: false });
      const result = await mod.syncHealthConnectLast7Days("token-xyz");
      expect(result).toEqual({
        supported: false,
        authorized: false,
        daysWritten: 0,
        daysRead: 0,
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("syncHealthConnectLast7Days is a no-op on web", async () => {
      const mod = await loadModule("web", { withNative: false });
      const result = await mod.syncHealthConnectLast7Days("token-xyz");
      expect(result.supported).toBe(false);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("isHealthConnectSupported returns false when native module is missing on Android", async () => {
      const mod = await loadModule("android", { withNative: false });
      expect(mod.isHealthConnectSupported()).toBe(false);
      const result = await mod.syncHealthConnectLast7Days("token-xyz");
      expect(result.supported).toBe(false);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("isHealthConnectSupported returns true when bridge is wired on Android", async () => {
      const mod = await loadModule("android");
      expect(mod.isHealthConnectSupported()).toBe(true);
    });
  });

  describe("syncHealthConnectLast7Days on Android", () => {
    it("posts only days that contain at least one metric and reuses 'google_fit' as source", async () => {
      const mod = await loadModule("android");
      mocks.native!.readLast7Days.mockResolvedValue([
        // Full day — should be posted
        { date: "2026-04-13", sleepMinutes: 420, hrvMs: 55, restingHr: 58, steps: 9000 },
        // Partial day — only steps; still has data, should be posted
        { date: "2026-04-14", sleepMinutes: null, hrvMs: null, restingHr: null, steps: 4321 },
        // Empty day — every field null; must be skipped
        { date: "2026-04-15", sleepMinutes: null, hrvMs: null, restingHr: null, steps: null },
        // Missing date — must be skipped (cannot upsert without metricDate)
        { date: "", sleepMinutes: 100 },
      ]);

      const result = await mod.syncHealthConnectLast7Days("token-xyz");

      expect(result.supported).toBe(true);
      expect(result.daysRead).toBe(4);
      expect(result.daysWritten).toBe(2);

      // Two daily posts + one connection upsert (markConnected) = 3 calls.
      expect(mocks.fetch).toHaveBeenCalledTimes(3);

      const dailyCalls = mocks.fetch.mock.calls.filter(
        (c) => String(c[0]).endsWith("/api/portal/wellness/daily"),
      );
      expect(dailyCalls).toHaveLength(2);
      for (const call of dailyCalls) {
        const init = call[1] as RequestInit;
        const body = JSON.parse(String(init.body));
        expect(body.source).toBe("google_fit");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer token-xyz",
        );
      }
      const dates = dailyCalls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).metricDate);
      expect(dates).toEqual(["2026-04-13", "2026-04-14"]);
    });

    it("upserts the connection badge when at least one day was written", async () => {
      const mod = await loadModule("android");
      mocks.native!.readLast7Days.mockResolvedValue([
        { date: "2026-04-13", steps: 1000 },
      ]);

      await mod.syncHealthConnectLast7Days("tok");

      const badgeCall = mocks.fetch.mock.calls.find(
        (c) => String(c[0]).endsWith("/api/portal/wearable-connections"),
      );
      expect(badgeCall).toBeDefined();
      const body = JSON.parse(String((badgeCall![1] as RequestInit).body));
      expect(body).toEqual({ provider: "health_connect" });
    });

    it("does NOT upsert the connection badge when zero days were written", async () => {
      const mod = await loadModule("android");
      // Every day is empty → daysWritten === 0, so the badge must not flip on.
      mocks.native!.readLast7Days.mockResolvedValue([
        { date: "2026-04-13", sleepMinutes: null, hrvMs: null, restingHr: null, steps: null },
        { date: "2026-04-14", sleepMinutes: null, hrvMs: null, restingHr: null, steps: null },
      ]);

      const result = await mod.syncHealthConnectLast7Days("tok");

      expect(result.daysWritten).toBe(0);
      const badgeCall = mocks.fetch.mock.calls.find(
        (c) => String(c[0]).endsWith("/api/portal/wearable-connections"),
      );
      expect(badgeCall).toBeUndefined();
    });

    it("does NOT count a day as written when the wellness POST returns non-OK", async () => {
      const mod = await loadModule("android");
      mocks.native!.readLast7Days.mockResolvedValue([
        { date: "2026-04-13", steps: 1000 },
        { date: "2026-04-14", steps: 2000 },
      ]);
      // First daily POST fails, second succeeds.
      mocks.fetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: true });

      const result = await mod.syncHealthConnectLast7Days("tok");
      expect(result.daysRead).toBe(2);
      expect(result.daysWritten).toBe(1);
      // Badge should still be flipped on because at least one day made it through.
      const badgeCall = mocks.fetch.mock.calls.find(
        (c) => String(c[0]).endsWith("/api/portal/wearable-connections"),
      );
      expect(badgeCall).toBeDefined();
    });

    it("does NOT upsert the connection badge when every daily POST fails", async () => {
      const mod = await loadModule("android");
      mocks.native!.readLast7Days.mockResolvedValue([
        { date: "2026-04-13", steps: 1000 },
        { date: "2026-04-14", steps: 2000 },
      ]);
      mocks.fetch.mockResolvedValue({ ok: false });

      const result = await mod.syncHealthConnectLast7Days("tok");
      expect(result.daysWritten).toBe(0);
      const badgeCall = mocks.fetch.mock.calls.find(
        (c) => String(c[0]).endsWith("/api/portal/wearable-connections"),
      );
      expect(badgeCall).toBeUndefined();
    });

    it("returns gracefully when the native bridge throws", async () => {
      const mod = await loadModule("android");
      mocks.native!.readLast7Days.mockRejectedValue(new Error("boom"));
      const result = await mod.syncHealthConnectLast7Days("tok");
      expect(result.supported).toBe(true);
      expect(result.daysRead).toBe(0);
      expect(result.daysWritten).toBe(0);
    });

    it("propagates the granted-scopes signal from requestAuthorization", async () => {
      const mod = await loadModule("android");
      mocks.native!.requestAuthorization.mockResolvedValue(false);
      mocks.native!.readLast7Days.mockResolvedValue([]);
      const result = await mod.syncHealthConnectLast7Days("tok");
      expect(result.authorized).toBe(false);
    });
  });
});
