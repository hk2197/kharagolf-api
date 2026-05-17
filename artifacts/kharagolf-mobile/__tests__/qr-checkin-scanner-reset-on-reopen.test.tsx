/**
 * Regression test: Task #1628.
 *
 * The QR check-in scanner modal previously kept its `scannedRef` and
 * `result` state across hide/show cycles — only the explicit "Scan
 * Another" button reset them. That meant a volunteer who closed the
 * modal mid-flow (e.g. tapped the X to dismiss the success card faster)
 * and then reopened it from the parent screen would see the stale
 * previous result card and have to tap "Scan Another" before the camera
 * came back. With a busy check-in queue that's friction.
 *
 * Fix: a `useEffect` keyed on `visible` resets `scannedRef.current` and
 * `result` whenever the modal transitions from hidden → visible. The
 * double-scan guard from Task #1178 / #1362 still holds *within* a
 * single open session because the reset only runs on the false → true
 * edge, not on every render.
 *
 * This test (1) renders the scanner visible, drives a successful scan,
 * confirms the result card is showing, (2) hides the modal, (3) shows
 * it again, and asserts the camera is rendered (not the result card).
 * It also confirms the double-scan guard still bails on a repeated
 * scan within the same open session.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

// ── Module mocks (must come BEFORE the component import) ─────────────────

// Capture the most recent `onBarcodeScanned` prop the scanner hands to
// `<CameraView>` so the test can invoke it directly. Also expose a
// counter so the test can assert how often the camera was mounted —
// when the result card is showing, `<CameraView>` is NOT rendered.
let capturedOnBarcodeScanned: ((evt: { data: string }) => unknown) | null = null;
let cameraMountCount = 0;

vi.mock("expo-camera", () => {
  const ReactInner = require("react") as typeof React;
  return {
    CameraView: (props: { onBarcodeScanned?: (evt: { data: string }) => unknown }) => {
      capturedOnBarcodeScanned = props.onBarcodeScanned ?? null;
      cameraMountCount += 1;
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

const VALID_QR = "KHGF:ci:9:42:11";

function buildOkFetchMock() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ firstName: "Alice", lastName: "Player" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

beforeEach(() => {
  capturedOnBarcodeScanned = null;
  cameraMountCount = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QRCheckInScanner — reset on reopen (Task #1628)", () => {
  it("returns to the live camera (not the previous result card) when the modal is closed and reopened", async () => {
    const fetchMock = buildOkFetchMock();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { rerender, queryByTestId, queryByText } = render(
      <QRCheckInScanner visible token="test-token" onClose={() => {}} />,
    );

    // (1) Camera should be mounted on first open.
    expect(queryByTestId("camera-view")).not.toBeNull();
    expect(capturedOnBarcodeScanned).toBeTruthy();

    // Drive a successful scan — the result card should replace the camera.
    await act(async () => {
      await capturedOnBarcodeScanned!({ data: VALID_QR });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryByText("Checked in successfully!")).not.toBeNull();
    expect(queryByText("Scan Another")).not.toBeNull();
    expect(queryByTestId("camera-view")).toBeNull();

    // (2) Volunteer closes the modal mid-flow (e.g. taps X on the
    // success card). The parent toggles `visible` to false.
    rerender(
      <QRCheckInScanner visible={false} token="test-token" onClose={() => {}} />,
    );

    // (3) Volunteer reopens the modal from the parent screen.
    rerender(
      <QRCheckInScanner visible token="test-token" onClose={() => {}} />,
    );

    // The reset-on-reopen effect must have cleared `result` so the
    // camera comes back instead of the stale success card.
    expect(queryByText("Checked in successfully!")).toBeNull();
    expect(queryByText("Scan Another")).toBeNull();
    expect(queryByTestId("camera-view")).not.toBeNull();
    expect(capturedOnBarcodeScanned).toBeTruthy();

    // And the double-scan guard from #1178 / #1362 must also have been
    // released so the volunteer can immediately scan the next player.
    await act(async () => {
      await capturedOnBarcodeScanned!({ data: "KHGF:ci:9:42:22" });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.test/api/organizations/9/tournaments/42/players/22/checkin",
    );
  });

  it("does NOT reset the double-scan guard on every render — only on the false → true edge of `visible`", async () => {
    const fetchMock = buildOkFetchMock();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { rerender } = render(
      <QRCheckInScanner visible token="test-token" onClose={() => {}} />,
    );

    const onScan = capturedOnBarcodeScanned!;
    expect(onScan).toBeTruthy();

    // Two synchronous scans within the same open session — second must
    // hit the early-bail path even though the modal will re-render.
    await act(async () => {
      const first = onScan({ data: VALID_QR });
      const second = onScan({ data: VALID_QR });
      await Promise.all([first, second]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A re-render with `visible` still true (e.g. parent state change)
    // must NOT release the guard — only a false → true transition does.
    rerender(
      <QRCheckInScanner visible token="other-token" onClose={() => {}} />,
    );
    await act(async () => {
      await capturedOnBarcodeScanned!({ data: VALID_QR });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
