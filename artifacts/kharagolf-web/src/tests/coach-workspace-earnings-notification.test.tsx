/**
 * Task #1306 — coach-facing earnings view shows the per-payout push/SMS
 * notification delivery state (mirroring the admin badges from Task #1129)
 * but never offers a Resend button.
 *
 * The component under test is `CoachWorkspacePage`'s "Earnings" tab. We
 * mock the API responses so each test renders a single payout in a
 * specific notification state and asserts on the badges + the
 * "couldn't reach you" inline note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import CoachWorkspacePage from "../pages/coach-workspace";

const PRO = {
  id: 99, organizationId: 1, displayName: "Test Coach", userId: 1,
};
const PROFILE = {
  proId: 99, organizationId: 1, isListed: true,
  certifications: [], yearsExperience: 0, languages: ["en"],
  hourlyRatePaise: 0, asyncReviewPricePaise: 0, acceptsInPerson: false,
  acceptsAsync: true, asyncTurnaroundHours: 24, revenueSharePct: "70",
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok, status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function buildEarnings(payouts: any[]) {
  return {
    summary: {
      lifetimeEarningsPaise: 100000,
      deliveredCount: 3,
      pendingPayoutPaise: 0,
      unpaidCount: 0,
    },
    sharePct: 70,
    payouts,
  };
}

function installFetch(payouts: any[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/coach-marketplace/me/coach-profile")) {
        return jsonResponse({ pro: PRO, profile: PROFILE });
      }
      if (url.endsWith("/api/swing-reviews/coach/queue")) {
        return jsonResponse({ queue: [] });
      }
      if (url.endsWith("/api/swing-reviews/coach/earnings")) {
        return jsonResponse(buildEarnings(payouts));
      }
      if (url.endsWith("/api/swing-reviews/coach/notifications")) {
        return jsonResponse({ notifications: [] });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
}

async function gotoEarnings() {
  render(<CoachWorkspacePage />);
  // Wait until the page loads the queue (tabs aren't rendered until then).
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: /Earnings/i })).toBeInTheDocument();
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: /Earnings/i }));
  // Wait for the table heading.
  await screen.findByText("Payout history");
}

describe("CoachWorkspacePage Earnings tab — Task #1306 notification cell", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows green Sent / Sent badges when both channels delivered", async () => {
    installFetch([{
      id: 501, periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-01-31T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "paid",
      payoutReference: "REF-OK",
      notification: {
        id: 1,
        pushStatus: "sent", pushAttempts: 1, lastPushAt: null,
        lastPushError: null, pushRetryExhaustedAt: null,
        smsStatus: "sent", smsAttempts: 1, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await gotoEarnings();
    const cell = await screen.findByTestId("cell-coach-notification-501");
    const inCell = within(cell);
    expect(inCell.getByTestId("badge-coach-notif-push-501")).toHaveTextContent(/Sent/);
    expect(inCell.getByTestId("badge-coach-notif-sms-501")).toHaveTextContent(/Sent/);
    // Both delivered → no inline "couldn't reach you" note.
    expect(screen.queryByTestId("note-coach-notif-both-missed-501")).toBeNull();
  });

  it("shows the 'couldn't reach you' note when both channels are non-sent", async () => {
    installFetch([{
      id: 502, periodStart: "2026-02-01T00:00:00Z", periodEnd: "2026-02-28T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "paid",
      payoutReference: "REF-MISSED",
      notification: {
        id: 2,
        pushStatus: "failed", pushAttempts: 5, lastPushAt: null,
        lastPushError: "boom", pushRetryExhaustedAt: "2026-02-28T01:00:00Z",
        smsStatus: "no_address", smsAttempts: 0, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await gotoEarnings();
    const cell = await screen.findByTestId("cell-coach-notification-502");
    const inCell = within(cell);
    // Push exhausted → "Failed (gave up)"
    expect(inCell.getByTestId("badge-coach-notif-push-502")).toHaveTextContent(/gave up/i);
    // SMS no address → "No phone"
    expect(inCell.getByTestId("badge-coach-notif-sms-502")).toHaveTextContent(/No phone/i);
    const note = await screen.findByTestId("note-coach-notif-both-missed-502");
    expect(note).toHaveTextContent(/couldn't reach you/i);
    expect(note).toHaveTextContent(/payout is still complete/i);
  });

  it("shows 'will retry' for a transient push failure that has not yet exhausted", async () => {
    installFetch([{
      id: 503, periodStart: "2026-03-01T00:00:00Z", periodEnd: "2026-03-31T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "paid",
      payoutReference: "REF-RETRY",
      notification: {
        id: 3,
        pushStatus: "failed", pushAttempts: 2, lastPushAt: null,
        lastPushError: "boom", pushRetryExhaustedAt: null,
        smsStatus: "sent", smsAttempts: 1, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await gotoEarnings();
    const cell = await screen.findByTestId("cell-coach-notification-503");
    const inCell = within(cell);
    expect(inCell.getByTestId("badge-coach-notif-push-503")).toHaveTextContent(/will retry/i);
    expect(inCell.getByTestId("badge-coach-notif-sms-503")).toHaveTextContent(/Sent/);
    // SMS sent → no "couldn't reach you" note.
    expect(screen.queryByTestId("note-coach-notif-both-missed-503")).toBeNull();
  });

  it("shows 'Pending' badge when a paid payout has no notification attempt row yet", async () => {
    installFetch([{
      id: 504, periodStart: "2026-04-01T00:00:00Z", periodEnd: "2026-04-30T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "paid",
      payoutReference: "REF-PENDING-NOTIF",
      notification: null,
    }]);
    await gotoEarnings();
    const cell = await screen.findByTestId("cell-coach-notification-504");
    expect(within(cell).getByTestId("badge-coach-notif-pending-504"))
      .toHaveTextContent(/pending/i);
  });

  it("renders an em-dash for non-paid payouts (notification cell is hidden until paid)", async () => {
    installFetch([{
      id: 506, periodStart: "2026-06-01T00:00:00Z", periodEnd: "2026-06-30T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "pending",
      payoutReference: null,
      notification: null,
    }]);
    await gotoEarnings();
    const cell = await screen.findByTestId("cell-coach-notification-506");
    expect(within(cell).getByText("—")).toBeInTheDocument();
    expect(within(cell).queryByTestId("badge-coach-notif-pending-506")).toBeNull();
  });

  it("never offers a Resend button to coaches (admin-only control)", async () => {
    installFetch([{
      id: 505, periodStart: "2026-05-01T00:00:00Z", periodEnd: "2026-05-31T00:00:00Z",
      grossPaise: 50000, netPayoutPaise: 40000, status: "paid",
      payoutReference: "REF-NO-RESEND",
      notification: {
        id: 4,
        pushStatus: "failed", pushAttempts: 5, lastPushAt: null,
        lastPushError: "boom", pushRetryExhaustedAt: "2026-05-31T01:00:00Z",
        smsStatus: "failed", smsAttempts: 5, lastSmsAt: null,
        lastSmsError: "boom", smsRetryExhaustedAt: "2026-05-31T01:00:00Z",
      },
    }]);
    await gotoEarnings();
    await screen.findByTestId("cell-coach-notification-505");
    // Admin button uses /resend|retry.*notif/i naming — ensure absent.
    expect(screen.queryByRole("button", { name: /resend/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry.*notif/i })).toBeNull();
  });
});
