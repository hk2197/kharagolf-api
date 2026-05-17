import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted spy so vi.mock() (also hoisted) can capture listener registrations
// from the NativeEventEmitter the helper builds internally.
const captured = vi.hoisted(() => ({
  listeners: new Map<string, (evt: unknown) => void>(),
  removed: 0,
}));

vi.mock("react-native", () => {
  class FakeEmitter {
    addListener(event: string, fn: (evt: unknown) => void) {
      captured.listeners.set(event, fn);
      return { remove: () => { captured.removed += 1; } };
    }
  }
  return {
    NativeEventEmitter: FakeEmitter,
    NativeModules: { KharagolfWatchBridge: { /* truthy stub */ ping: () => 0 } },
    Platform: { OS: "ios" },
  };
});

// Import after the mock so the helper picks up the stubbed react-native.
import {
  deriveWatchBatteryAutoPctFromEvent,
  subscribeWatchBatteryAutoPct,
} from "../modules/KharagolfWatchBridge";

beforeEach(() => {
  captured.listeners.clear();
  captured.removed = 0;
});

describe("deriveWatchBatteryAutoPctFromEvent (Task #826)", () => {
  it("converts a fractional threshold to integer percent", () => {
    expect(deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: 0.45 })).toBe(45);
  });

  it("rounds to the nearest percent", () => {
    expect(deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: 0.234 })).toBe(23);
    expect(deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: 0.236 })).toBe(24);
  });

  it("clamps to the on-watch nudger's 10–50% range", () => {
    expect(deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: 0.95 })).toBe(50);
    expect(deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: 0.05 })).toBe(10);
  });

  it("returns null for missing or non-finite payloads", () => {
    expect(deriveWatchBatteryAutoPctFromEvent(undefined)).toBeNull();
    expect(deriveWatchBatteryAutoPctFromEvent(null)).toBeNull();
    expect(deriveWatchBatteryAutoPctFromEvent({})).toBeNull();
    expect(
      deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: Number.NaN }),
    ).toBeNull();
    expect(
      deriveWatchBatteryAutoPctFromEvent({ batteryAutoThreshold: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});

describe("subscribeWatchBatteryAutoPct (Task #826)", () => {
  it("invokes the listener when a watch nudge event arrives", () => {
    const onChange = vi.fn();
    const sub = subscribeWatchBatteryAutoPct(onChange);

    const fire = captured.listeners.get("KharagolfWatchSettingsChanged");
    expect(fire, "helper must register listener under expected event name").toBeDefined();

    fire!({ batteryAutoThreshold: 0.45 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(45);

    sub.remove();
    expect(captured.removed).toBe(1);
  });

  it("ignores malformed events instead of dropping into the setter", () => {
    const onChange = vi.fn();
    subscribeWatchBatteryAutoPct(onChange);
    const fire = captured.listeners.get("KharagolfWatchSettingsChanged")!;

    fire(undefined);
    fire({});
    fire({ batteryAutoThreshold: "0.4" });
    fire({ batteryAutoThreshold: Number.NaN });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("forwards multiple consecutive nudges in order", () => {
    const onChange = vi.fn();
    subscribeWatchBatteryAutoPct(onChange);
    const fire = captured.listeners.get("KharagolfWatchSettingsChanged")!;

    fire({ batteryAutoThreshold: 0.20 });
    fire({ batteryAutoThreshold: 0.35 });
    fire({ batteryAutoThreshold: 0.50 });

    expect(onChange.mock.calls.map((c) => c[0])).toEqual([20, 35, 50]);
  });
});
