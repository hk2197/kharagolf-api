/**
 * UI test: per-channel "Retry push" / "Retry SMS" buttons inside the
 * AuditTab receipt-history panel (Task #338, coverage Task #504).
 *
 * Mounts <AuditTab /> with a mocked fetch that returns a single failed
 * levy_charge audit row. Expanding the row mounts <ReceiptAttemptsPanel>,
 * which fires GET /receipts and renders one row per attempt with a per-
 * channel retry button on the LATEST attempt only.
 *
 * Locks in:
 *   - Clicking "Retry push" on a failed-push attempt POSTs to
 *     /retry-receipt-channel with `{ channel: 'push' }` and refreshes the
 *     panel.
 *   - "Retry push" is disabled once pushRetryExhaustedAt is set.
 *   - "Retry SMS" is disabled when smsStatus is no longer 'failed' (e.g.
 *     a previous retry already succeeded and flipped it to 'sent').
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { AuditTab } from "../member-360";

const ORG_ID = 42;
const MEMBER_ID = 7;
const BASE = `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}`;

const AUDIT_ID = 5001;
const CHARGE_ID = 9100;
const LEVY_ID = 8200;
const ATTEMPT_LATEST = 700;
const ATTEMPT_OLDER = 699;

const TS = "2026-01-01T10:00:00Z";

interface ChannelState {
  pushStatus: "failed" | "sent" | "skipped" | null;
  pushAttempts: number;
  pushRetryExhaustedAt: string | null;
  smsStatus: "failed" | "sent" | "skipped" | null;
  smsAttempts: number;
  smsRetryExhaustedAt: string | null;
}

function buildAuditRow() {
  return [
    {
      id: AUDIT_ID, entity: "levy_charge", entityId: CHARGE_ID, action: "update",
      actorName: "Admin", actorRole: "org_admin", reason: "payment recorded",
      fieldChanges: null, createdAt: TS, ipAddress: null,
      linkedLevyId: LEVY_ID, linkedChargeId: CHARGE_ID,
      receiptLevyId: LEVY_ID, receiptStatus: "failed",
      receiptReason: "fcm down", receiptKind: "payment",
      receiptAmount: "100.00", receiptAt: TS,
    },
  ];
}

function buildReceiptResponse(latest: ChannelState) {
  return {
    chargeId: CHARGE_ID,
    currency: "INR",
    maxPushAttempts: 3,
    maxSmsAttempts: 3,
    maxWhatsappAttempts: 3,
    attempts: [
      {
        id: ATTEMPT_LATEST,
        kind: "payment",
        transactionAmount: "100.00",
        newBalance: "0.00",
        note: null,
        createdAt: TS,
        pushStatus: latest.pushStatus,
        pushAttempts: latest.pushAttempts,
        lastPushAt: TS,
        lastPushError: latest.pushStatus === "failed" ? "fcm down" : null,
        lastPushRetryAt: null,
        pushRetryExhaustedAt: latest.pushRetryExhaustedAt,
        smsStatus: latest.smsStatus,
        smsAttempts: latest.smsAttempts,
        lastSmsAt: TS,
        lastSmsError: latest.smsStatus === "failed" ? "twilio down" : null,
        lastSmsRetryAt: null,
        smsRetryExhaustedAt: latest.smsRetryExhaustedAt,
        whatsappStatus: null, whatsappAttempts: 0,
        lastWhatsappAt: null, lastWhatsappError: null,
        lastWhatsappRetryAt: null, whatsappRetryExhaustedAt: null,
      },
      // Older attempt — should NOT receive any retry button (only the latest does).
      {
        id: ATTEMPT_OLDER,
        kind: "payment",
        transactionAmount: "100.00",
        newBalance: "0.00",
        note: null,
        createdAt: "2025-12-30T10:00:00Z",
        pushStatus: "failed", pushAttempts: 1, lastPushAt: TS,
        lastPushError: "old", lastPushRetryAt: null, pushRetryExhaustedAt: null,
        smsStatus: "failed", smsAttempts: 1, lastSmsAt: TS,
        lastSmsError: "old", lastSmsRetryAt: null, smsRetryExhaustedAt: null,
        whatsappStatus: null, whatsappAttempts: 0,
        lastWhatsappAt: null, lastWhatsappError: null,
        lastWhatsappRetryAt: null, whatsappRetryExhaustedAt: null,
      },
    ],
  };
}

interface FetchHandler {
  retryCalls: Array<{ url: string; body: unknown }>;
  receiptState: ChannelState;
}
let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audit-log")) {
      return new Response(JSON.stringify(buildAuditRow()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.endsWith(`/levies/${LEVY_ID}/charges/${MEMBER_ID}/receipts`) && (!init || (init.method ?? "GET") === "GET")) {
      return new Response(JSON.stringify(buildReceiptResponse(handler.receiptState)), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.endsWith("/retry-receipt-channel") && init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      handler.retryCalls.push({ url, body });
      // Flip the in-memory channel state so the panel's refetch sees the
      // post-retry shape.
      if (body.channel === "push") {
        handler.receiptState = {
          ...handler.receiptState, pushStatus: "sent",
          pushAttempts: handler.receiptState.pushAttempts + 1,
        };
      } else if (body.channel === "sms") {
        handler.receiptState = {
          ...handler.receiptState, smsStatus: "sent",
          smsAttempts: handler.receiptState.smsAttempts + 1,
        };
      }
      return new Response(JSON.stringify({
        attempt: { id: ATTEMPT_LATEST },
        result: { channel: body.channel, status: "sent", attempts: 2, exhausted: false },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuditTab base={BASE} orgId={ORG_ID} memberId={MEMBER_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    retryCalls: [],
    receiptState: {
      pushStatus: "failed", pushAttempts: 1, pushRetryExhaustedAt: null,
      smsStatus: "failed", smsAttempts: 1, smsRetryExhaustedAt: null,
    },
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AuditTab /> — per-channel receipt retry buttons", () => {
  it("clicking 'Retry push' POSTs to /retry-receipt-channel with channel=push", async () => {
    const user = userEvent.setup();
    renderTab();

    // Expand the receipt-history panel for the failed audit row.
    await screen.findByTestId(`audit-entry-${AUDIT_ID}`);
    await user.click(screen.getByTestId(`button-audit-toggle-receipts-${AUDIT_ID}`));

    const pushBtn = await screen.findByTestId(`audit-receipt-attempt-${AUDIT_ID}-push-retry`);
    expect(pushBtn).not.toBeDisabled();

    await user.click(pushBtn);

    await waitFor(() => expect(handler.retryCalls.length).toBe(1));
    expect(handler.retryCalls[0].url).toContain(
      `/levies/${LEVY_ID}/charges/${MEMBER_ID}/retry-receipt-channel`,
    );
    expect(handler.retryCalls[0].body).toEqual({ channel: "push" });

    // Older attempts (idx > 0) never get their own retry button — the panel
    // renders exactly one push-retry and one sms-retry button per audit row,
    // bound to the latest attempt only. (testing-library throws if multiple
    // elements match the same test id, so getAllByTestId asserts the count.)
    expect(
      screen.getAllByTestId(`audit-receipt-attempt-${AUDIT_ID}-push-retry`),
    ).toHaveLength(1);
    expect(
      screen.getAllByTestId(`audit-receipt-attempt-${AUDIT_ID}-sms-retry`),
    ).toHaveLength(1);
    // And the older attempt's row exists (proving it's actually rendered),
    // so the "1 button" count above isn't a false negative from a missing row.
    expect(
      screen.getByTestId(`audit-receipt-attempt-${AUDIT_ID}-${ATTEMPT_OLDER}`),
    ).toBeInTheDocument();
  });

  it("clicking 'Retry SMS' POSTs to /retry-receipt-channel with channel=sms and disables the button after success", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByTestId(`audit-entry-${AUDIT_ID}`);
    await user.click(screen.getByTestId(`button-audit-toggle-receipts-${AUDIT_ID}`));

    const smsBtn = await screen.findByTestId(`audit-receipt-attempt-${AUDIT_ID}-sms-retry`);
    expect(smsBtn).not.toBeDisabled();

    await user.click(smsBtn);

    await waitFor(() => expect(handler.retryCalls.length).toBe(1));
    expect(handler.retryCalls[0].url).toContain(
      `/levies/${LEVY_ID}/charges/${MEMBER_ID}/retry-receipt-channel`,
    );
    expect(handler.retryCalls[0].body).toEqual({ channel: "sms" });

    // After the success the panel refetches and smsStatus flips to 'sent',
    // so the button must transition to disabled (the per-channel gate also
    // protects against accidental double-fire).
    await waitFor(() => {
      expect(
        screen.getByTestId(`audit-receipt-attempt-${AUDIT_ID}-sms-retry`),
      ).toBeDisabled();
    });
    // Push channel was failed and untouched — its button stays enabled.
    expect(
      screen.getByTestId(`audit-receipt-attempt-${AUDIT_ID}-push-retry`),
    ).not.toBeDisabled();
  });

  it("'Retry push' is disabled once pushRetryExhaustedAt is stamped", async () => {
    const user = userEvent.setup();
    handler.receiptState = {
      ...handler.receiptState,
      pushAttempts: 3,
      pushRetryExhaustedAt: TS,
    };
    renderTab();

    await screen.findByTestId(`audit-entry-${AUDIT_ID}`);
    await user.click(screen.getByTestId(`button-audit-toggle-receipts-${AUDIT_ID}`));

    const pushBtn = await screen.findByTestId(`audit-receipt-attempt-${AUDIT_ID}-push-retry`);
    expect(pushBtn).toBeDisabled();
  });

  it("'Retry SMS' is disabled once smsStatus is no longer 'failed'", async () => {
    const user = userEvent.setup();
    handler.receiptState = {
      ...handler.receiptState,
      smsStatus: "sent",
      smsAttempts: 2,
    };
    renderTab();

    await screen.findByTestId(`audit-entry-${AUDIT_ID}`);
    await user.click(screen.getByTestId(`button-audit-toggle-receipts-${AUDIT_ID}`));

    const smsBtn = await screen.findByTestId(`audit-receipt-attempt-${AUDIT_ID}-sms-retry`);
    expect(smsBtn).toBeDisabled();

    // And the push button (still failed) remains enabled — proves the disabled
    // state is per-channel, not row-wide.
    const pushBtn = screen.getByTestId(`audit-receipt-attempt-${AUDIT_ID}-push-retry`);
    expect(pushBtn).not.toBeDisabled();
  });
});
