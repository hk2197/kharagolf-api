/**
 * Regression test: Task #1627 (follow-up to Task #1362).
 *
 * The QR check-in scanner has four user-facing error branches:
 *   1. Non-KHARAGOLF QR payload → "Invalid QR code. Please scan a
 *      KHARAGOLF player check-in code." (no /checkin POST issued)
 *   2. Malformed payload where one of the IDs isn't numeric →
 *      "Malformed check-in QR code." (no /checkin POST issued)
 *   3. Server returns non-2xx (e.g. 409 already-checked-in) → the
 *      server's `error` field is shown verbatim
 *   4. Network failure (fetch throws) → "Network error. Please check
 *      your connection."
 *
 * If a future refactor reorders the parsing/error-handling chain (e.g.
 * starts firing the POST before validating the payload, or swallows the
 * server's `error` field behind a generic message), volunteers at the
 * tournament desk would see misleading text — for example "Checked in
 * successfully!" for a player who is in fact already checked in, or a
 * generic "Check-in failed" instead of the explicit reason. This test
 * pins down each branch's exact rendered message and the network-call
 * shape that must accompany it.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";

// ── Module mocks (must come BEFORE the component import) ─────────────────

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

const VALID_QR = "KHGF:ci:9:42:11";

beforeEach(() => {
  capturedOnBarcodeScanned = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fireScan(payload: string) {
  expect(capturedOnBarcodeScanned).toBeTruthy();
  await act(async () => {
    await capturedOnBarcodeScanned!({ data: payload });
  });
}

describe("QRCheckInScanner — error branches (Task #1627)", () => {
  it("shows the 'Invalid QR code' message and never POSTs when the payload isn't a KHARAGOLF check-in QR", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<QRCheckInScanner visible token="test-token" onClose={() => {}} />);

    // A QR from some unrelated app — wrong prefix.
    await fireScan("https://example.com/not-a-checkin-code");

    expect(
      await screen.findByText(
        "Invalid QR code. Please scan a KHARAGOLF player check-in code.",
      ),
    ).toBeTruthy();
    // Parse-error branch must short-circuit BEFORE issuing any network call.
    expect(fetchMock).not.toHaveBeenCalled();
    // And the success branch must not have rendered.
    expect(screen.queryByText("Checked in successfully!")).toBeNull();
  });

  it("shows the 'Malformed check-in QR code' message and never POSTs when one of the IDs isn't numeric", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<QRCheckInScanner visible token="test-token" onClose={() => {}} />);

    // Right prefix and right number of parts, but the player ID is not a
    // number — must fail the isNaN guard.
    await fireScan("KHGF:ci:9:42:not-a-number");

    expect(
      await screen.findByText("Malformed check-in QR code."),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Checked in successfully!")).toBeNull();
  });

  it("shows the server's `error` field verbatim when the /checkin endpoint returns a non-2xx (e.g. 409 already checked in)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "Player is already checked in." }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<QRCheckInScanner visible token="test-token" onClose={() => {}} />);

    await fireScan(VALID_QR);

    // The server's reason is shown verbatim — NOT a generic fallback.
    expect(
      await screen.findByText("Player is already checked in."),
    ).toBeTruthy();
    // The endpoint was indeed called (this branch only fires after the POST).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Success branch must not have fired for a non-2xx.
    expect(screen.queryByText("Checked in successfully!")).toBeNull();
  });

  it("shows the network-error message when fetch itself throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<QRCheckInScanner visible token="test-token" onClose={() => {}} />);

    await fireScan(VALID_QR);

    expect(
      await screen.findByText("Network error. Please check your connection."),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Checked in successfully!")).toBeNull();
  });
});
