/**
 * UI tests: mobile `ScheduleChangeLastSentCard` (Task #2097 — mobile mirror
 * of the web `ScheduleChangeOptOutsCard`'s sibling "last sent" audit panel
 * from Task #513 / Task #655 / Task #947).
 *
 * Verifies:
 *   1. The card self-hides on 401/403 (non-admin user).
 *   2. The card renders the empty-state copy when the GET returns [].
 *   3. The card lists the most recent send (timestamp, who triggered it,
 *      recipient list, recipient count, Resend button).
 *   4. The Resend button respects the per-row cooldown returned by the
 *      server and shows a live "Resend in Ns" countdown.
 *   5. Tapping Resend confirms via Alert and POSTs to the resend endpoint;
 *      the new send is prepended and the originating row is stamped.
 *   6. A 429 retry-after response stamps `lastResendAt` from the payload
 *      so the button immediately disables and shows the countdown.
 *   7. Earlier sends are collapsed by default and revealed on tap (web
 *      "Show N earlier sends" disclosure parity).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Alert } from "react-native";

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

import { ScheduleChangeLastSentCard } from "../components/ScheduleChangeLastSentCard";

interface ScheduleChangeSend {
  id: number;
  sentAt: string;
  recipients: Array<{ userId: number; email: string; displayName: string }>;
  lastResendAt: string | null;
  resendCooldownSeconds: number;
  changedBy: { userId: number; displayName: string; email: string | null } | null;
}

let getStatus = 200;
let getBody: ScheduleChangeSend[] = [];
let resendStatus = 201;
let resendResponse: Record<string, unknown> = {};
let postedSendIds: number[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  const resendMatch = url.match(/\/organizations\/(\d+)\/bounced-digest-schedule-sends\/(\d+)\/resend$/);
  if (resendMatch && method === "POST") {
    postedSendIds.push(parseInt(resendMatch[2], 10));
    return new Response(JSON.stringify(resendResponse), {
      status: resendStatus, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/bounced-digest-schedule-sends") && method === "GET") {
    if (getStatus === 200) {
      return new Response(JSON.stringify(getBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: getStatus, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

// React Native's `Alert.alert` is a no-op under jsdom (and `react-native-web`
// drops the buttons array entirely), so the destructive Resend button
// callback would never fire in tests. Auto-tap the destructive button
// when the confirmation prompt is presented so we can exercise the resend
// flow end-to-end. Cancel-button tests can opt in by overriding the spy.
type AlertButton = { text?: string; style?: string; onPress?: () => void };
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getStatus = 200;
  getBody = [];
  resendStatus = 201;
  resendResponse = {};
  postedSendIds = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  alertSpy = vi.spyOn(Alert, "alert").mockImplementation(((_t: string, _m?: string, buttons?: AlertButton[]) => {
    const destructive = buttons?.find((b) => b.style === "destructive");
    destructive?.onPress?.();
  }) as unknown as typeof Alert.alert);
});

afterEach(() => {
  cleanup();
  alertSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const baseSend: ScheduleChangeSend = {
  id: 101,
  sentAt: "2026-04-20T15:30:00Z",
  recipients: [
    { userId: 11, email: "alice@example.com", displayName: "Alice Director" },
    { userId: 22, email: "bob@example.com", displayName: "Bob Captain" },
  ],
  lastResendAt: null,
  resendCooldownSeconds: 60,
  changedBy: { userId: 99, displayName: "Pat Admin", email: "pat@example.com" },
};

describe("ScheduleChangeLastSentCard (Task #2097)", () => {
  it("self-hides when the API returns 403 (non-admin user)", async () => {
    getStatus = 403;
    const { container } = render(<ScheduleChangeLastSentCard orgId={7} token="t" />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-schedule-change-last-send"]')).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (signed-out / no session)", async () => {
    getStatus = 401;
    const { container } = render(<ScheduleChangeLastSentCard orgId={7} token="t" />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-schedule-change-last-send"]')).toBeNull();
    });
  });

  it("renders nothing when orgId or token is missing (no API call)", async () => {
    const { container } = render(<ScheduleChangeLastSentCard orgId={null} token={null} />);
    expect(container.querySelector('[data-testid="card-schedule-change-last-send"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when no schedule-change email has been sent", async () => {
    getBody = [];
    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);
    expect(await screen.findByTestId("text-no-schedule-sends")).toBeInTheDocument();
  });

  it("lists the most recent send with timestamp, trigger, and recipient list", async () => {
    getBody = [baseSend];
    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);

    expect(await screen.findByTestId("block-schedule-last-send")).toBeInTheDocument();
    expect(screen.getByTestId("text-last-sent-count")).toHaveTextContent("2 recipients");
    expect(screen.getByText(/triggered by Pat Admin/)).toBeInTheDocument();
    expect(screen.getByText("Alice Director")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Bob Captain")).toBeInTheDocument();
    expect(screen.getByTestId("button-resend-send-101")).toBeInTheDocument();
  });

  it("disables the Resend button while the row is on cooldown and shows a live countdown", async () => {
    const cooldownMs = 60_000;
    // Stamp the row 5s into its 60s cooldown — initial label "Resend in 5s".
    const lastResendAt = new Date(Date.now() - (cooldownMs - 5_000)).toISOString();
    getBody = [{ ...baseSend, lastResendAt, resendCooldownSeconds: 60 }];

    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);

    const cooldownLabel = await screen.findByTestId("text-resend-cooldown-101");
    expect(cooldownLabel.textContent).toMatch(/Resend in [45]s/);

    const btn = screen.getByTestId("button-resend-send-101") as HTMLButtonElement;
    // react-native-web maps `disabled` to the aria-disabled attribute on
    // the underlying <div role="button">.
    expect(btn.getAttribute("aria-disabled") ?? btn.getAttribute("disabled")).toBeTruthy();

    // Clicking does nothing while disabled — neither the confirmation
    // alert nor the POST should fire.
    await act(async () => { fireEvent.click(btn); });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(postedSendIds).toEqual([]);

    // Patch the row's `lastResendAt` further into the past so the next
    // cooldown re-render lands at "Resend in [23]s" — proving the label
    // is derived live from `Date.now()` rather than baked in at mount.
    // We trigger the re-render by toggling the earlier-sends disclosure
    // (a no-op state change here) — but since there are no earlier sends
    // we instead wait for the 1s setInterval tick the component installs.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const updated = screen.getByTestId("text-resend-cooldown-101");
    expect(updated.textContent).toMatch(/Resend in [34]s/);
  });

  it("confirms via Alert and POSTs to the resend endpoint, prepending the new send", async () => {
    getBody = [baseSend];
    resendStatus = 201;
    // The server returns the exact `last_resend_at` it just claimed for
    // the originating row — use a near-now timestamp so the cooldown
    // window is still active when we assert below.
    const resentFromLastResendAt = new Date(Date.now() - 1_000).toISOString();
    resendResponse = {
      id: 202,
      sentAt: new Date().toISOString(),
      recipients: baseSend.recipients,
      lastResendAt: null,
      resendCooldownSeconds: 60,
      changedBy: { userId: 99, displayName: "Pat Admin", email: "pat@example.com" },
      resentFromLastResendAt,
    };

    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);
    const btn = await screen.findByTestId("button-resend-send-101");

    await act(async () => { fireEvent.click(btn); });

    // Confirmation prompt fired with a destructive Resend button.
    expect(alertSpy).toHaveBeenCalled();

    await waitFor(() => { expect(postedSendIds).toEqual([101]); });

    // The new send (id 202) is prepended and the originating row (101)
    // is now stamped with `lastResendAt` so its Resend button shows the
    // countdown label.
    await waitFor(() => {
      expect(screen.getByTestId("button-resend-send-202")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("toggle-earlier-sends")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-earlier-sends"));
    expect(await screen.findByTestId("text-resend-cooldown-101")).toBeInTheDocument();
  });

  it("handles a 429 retry-after by stamping lastResendAt from the payload", async () => {
    getBody = [baseSend];
    resendStatus = 429;
    resendResponse = {
      error: "Cooldown",
      retryAfterSeconds: 42,
      cooldownSeconds: 60,
      lastResendAt: new Date(Date.now() - 18_000).toISOString(),
    };

    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);
    const btn = await screen.findByTestId("button-resend-send-101");

    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => { expect(postedSendIds).toEqual([101]); });

    // After the 429, the row is stamped and the button shows the
    // countdown label rather than the "Resend" word — proving the UI
    // disabled itself without waiting for a fresh GET round-trip.
    await waitFor(() => {
      expect(screen.getByTestId("text-resend-cooldown-101")).toBeInTheDocument();
    });
    expect(screen.getByTestId("text-resend-cooldown-101").textContent).toMatch(/Resend in 4\ds/);
  });

  it("collapses earlier sends behind a 'Show N earlier sends' disclosure", async () => {
    const earlier: ScheduleChangeSend = {
      id: 50,
      sentAt: "2026-04-10T12:00:00Z",
      recipients: [{ userId: 11, email: "alice@example.com", displayName: "Alice Director" }],
      lastResendAt: null,
      resendCooldownSeconds: 60,
      changedBy: { userId: 99, displayName: "Pat Admin", email: "pat@example.com" },
    };
    getBody = [baseSend, earlier];

    render(<ScheduleChangeLastSentCard orgId={7} token="t" />);

    // Earlier list is hidden by default; only the toggle is rendered.
    const toggle = await screen.findByTestId("toggle-earlier-sends");
    expect(toggle.textContent).toMatch(/Show 1 earlier send/);
    expect(screen.queryByTestId("list-earlier-sends")).toBeNull();
    expect(screen.queryByTestId("button-resend-send-50")).toBeNull();

    // Tap to expand — the earlier send (id 50) and its Resend button
    // now appear and the toggle copy flips.
    fireEvent.click(toggle);
    expect(screen.getByTestId("list-earlier-sends")).toBeInTheDocument();
    expect(screen.getByTestId("button-resend-send-50")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-earlier-sends").textContent).toMatch(/Hide 1 earlier send/);
  });
});
