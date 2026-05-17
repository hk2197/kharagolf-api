/**
 * Regression test: Task #1362 (follow-up to audit Task #1178, originally
 * Task #1014).
 *
 * The in-app QR check-in scanner uses `expo-camera`'s `onBarcodeScanned`
 * callback, which can fire many times in a single JS tick (one per detected
 * camera frame) for the same QR code. The fix in #1178 gates the handler
 * on a `useRef` (not `useState`) so the second invocation observes the
 * mutated guard *synchronously* and bails before issuing a duplicate
 * /checkin POST. If a future refactor regresses `scannedRef` back to
 * `useState`, all the queued callbacks would observe the stale `false`,
 * each fire its own POST, and the tournament desk would silently see the
 * same player checked in 2-3 times.
 *
 * This test renders `<QRCheckInScanner>`, captures the `onBarcodeScanned`
 * prop handed to `<CameraView>`, fires it twice synchronously with the
 * same valid KHGF QR payload, and asserts that `fetch` was called exactly
 * once with the expected /checkin URL, method, and bearer token. The
 * second invocation must hit the `scannedRef.current === true` early-bail
 * path. Both the success path (HTTP 200 from the server) and the
 * already-scanning early-bail path are covered.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

// ── Module mocks (must come BEFORE the component import) ─────────────────

// Capture the most recent `onBarcodeScanned` prop the scanner hands to
// `<CameraView>` so the test can invoke it directly. The real native
// CameraView would call this internally per detected frame.
let capturedOnBarcodeScanned: ((evt: { data: string }) => unknown) | null = null;

vi.mock("expo-camera", () => {
  const ReactInner = require("react") as typeof React;
  return {
    CameraView: (props: { onBarcodeScanned?: (evt: { data: string }) => unknown }) => {
      capturedOnBarcodeScanned = props.onBarcodeScanned ?? null;
      return ReactInner.createElement("div", { "data-testid": "camera-view" });
    },
    useCameraPermissions: () =>
      [{ granted: true }, async () => ({ granted: true })] as const,
  };
});

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));

vi.mock("@/utils/api", () => ({
  BASE_URL: "https://api.test",
}));

import { QRCheckInScanner } from "../components/QRCheckInScanner";

// Valid KHGF check-in QR payload: KHGF:ci:<orgId>:<tournamentId>:<playerId>
const VALID_QR = "KHGF:ci:9:42:11";
const EXPECTED_CHECKIN_URL =
  "https://api.test/api/organizations/9/tournaments/42/players/11/checkin";

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
}

let recordedCalls: RecordedCall[] = [];

function getHeader(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function buildOkFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recordedCalls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      authorization: getHeader(init, "Authorization"),
    });
    return new Response(
      JSON.stringify({ firstName: "Alice", lastName: "Player" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

beforeEach(() => {
  recordedCalls = [];
  capturedOnBarcodeScanned = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QRCheckInScanner — double-scan guard (Task #1362)", () => {
  it("fires only one /checkin POST when onBarcodeScanned is invoked twice in the same tick (success path)", async () => {
    const fetchMock = buildOkFetchMock();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <QRCheckInScanner
        visible
        token="test-token"
        onClose={() => {}}
      />,
    );

    expect(capturedOnBarcodeScanned).toBeTruthy();
    const onScan = capturedOnBarcodeScanned!;

    // Fire two synchronous scans before any awaited microtask resolves —
    // mirrors expo-camera dispatching multiple frames for the same QR
    // code in a single JS tick.
    await act(async () => {
      void onScan({ data: VALID_QR });
      void onScan({ data: VALID_QR });
    });

    // Exactly one POST to the check-in URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe(EXPECTED_CHECKIN_URL);
    expect(recordedCalls[0].method).toBe("POST");
    expect(recordedCalls[0].authorization).toBe("Bearer test-token");
  });

  it("the second synchronous invocation hits the already-scanning early-bail path (no fetch issued)", async () => {
    const fetchMock = buildOkFetchMock();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <QRCheckInScanner
        visible
        token="test-token"
        onClose={() => {}}
      />,
    );

    const onScan = capturedOnBarcodeScanned!;
    expect(onScan).toBeTruthy();

    // First scan kicks off the POST; do NOT await its microtask before
    // firing the second one.
    await act(async () => {
      const first = onScan({ data: VALID_QR });
      // The second invocation must observe `scannedRef.current === true`
      // synchronously (the ref mutates immediately) and return without
      // touching fetch. If `scannedRef` is ever regressed to `useState`,
      // both invocations would observe the stale `false` and fetch would
      // be called twice.
      const second = onScan({ data: VALID_QR });
      await Promise.all([first, second]);
    });

    // Only the first scan made a network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // And firing a third time after the first one settles must STILL be a
    // no-op until `resetScan` runs, proving the guard isn't released by
    // the success path itself.
    await act(async () => {
      await onScan({ data: VALID_QR });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
