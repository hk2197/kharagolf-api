/**
 * Task #1761 — frontend coverage for the auto-refund digest's
 * paused-recipients dashboard surface added in Task #1443.
 *
 * The wallet-topup-refunds page mounts WalletTopupRefundEmailSchedulePanel,
 * which renders a "X paused" chip and an inline warning panel sourced from
 * the GET /email-schedule endpoint's new `pausedRecipients` field, plus a
 * one-click "Remove from suppression list" button that POSTs to
 * /email-schedule/unsuppress.
 *
 * This test mocks `fetch` so the schedule GET hydrates with two paused
 * recipients, then asserts:
 *
 *   - The chip count (`chip-refund-digest-paused-count`) renders the
 *     correct number ("2 paused").
 *   - The warning panel (`panel-refund-digest-paused-recipients`)
 *     renders a row per paused address with the friendly reason label.
 *   - Clicking the per-row unsuppress button hits the unsuppress
 *     endpoint with the original-cased email in the JSON body.
 *
 * Mirrors the same pattern as `badge-share-drilldown.test.tsx` —
 * mocks `useGetMe` + `useActiveOrgContext` so we don't drag in the auth
 * stack, wraps in QueryClientProvider, and stubs `fetch`.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => 42,
  useActiveOrgContext: () => ({
    activeOrgId: 42,
    isOrgOverridden: false,
    setActiveOrg: () => {},
  }),
  ActiveOrgProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import WalletTopupRefundsPage from "@/pages/wallet-topup-refunds";

interface PausedRecipientRow {
  suppressionId: number;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
}

interface ScheduleRow {
  id: number;
  organizationId: number;
  frequency: "weekly" | "monthly";
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SCHEDULED_RECIPIENTS = ["Finance@Example.test", "Treasurer@example.test"];

const PAUSED_FIXTURE: PausedRecipientRow[] = [
  {
    suppressionId: 901,
    email: "Finance@Example.test",
    reason: "bounced",
    bounceType: "HardBounce",
    description: "The recipient's mailbox does not exist",
    createdAt: "2026-04-01T12:00:00.000Z",
  },
  {
    suppressionId: 902,
    email: "Treasurer@example.test",
    reason: "spam_complaint",
    bounceType: null,
    description: null,
    createdAt: "2026-04-02T12:00:00.000Z",
  },
];

const SCHEDULE_FIXTURE: ScheduleRow = {
  id: 1234,
  organizationId: 42,
  frequency: "weekly",
  recipients: [...SCHEDULED_RECIPIENTS],
  enabled: true,
  lastSentAt: "2026-04-20T09:00:00.000Z",
  nextRunAt: "2026-04-27T09:00:00.000Z",
  createdAt: "2026-01-01T09:00:00.000Z",
  updatedAt: "2026-04-20T09:00:00.000Z",
};

interface UnsuppressCall {
  url: string;
  body: { email: string };
}

let unsuppressCalls: UnsuppressCall[];

function buildScheduleResponse(): {
  schedule: ScheduleRow;
  history: never[];
  language: { configured: string | null; resolved: string; isFallback: boolean };
  pausedRecipients: PausedRecipientRow[];
  recipientLanguages: never[];
} {
  return {
    schedule: SCHEDULE_FIXTURE,
    history: [],
    language: { configured: "en", resolved: "en", isFallback: false },
    pausedRecipients: PAUSED_FIXTURE,
    recipientLanguages: [],
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();

  // The page's main refunds list — return an empty payload so the table
  // renders the empty state and the page mounts cleanly.
  if (url.includes("/api/admin/wallet-topup-refunds?") && !url.includes("/email-schedule")) {
    return ok({ items: [], totalsByCurrency: {} });
  }
  if (
    method === "GET" &&
    url.includes("/api/admin/wallet-topup-refunds/email-schedule")
  ) {
    return ok(buildScheduleResponse());
  }
  if (
    method === "POST" &&
    url.includes("/api/admin/wallet-topup-refunds/email-schedule/unsuppress")
  ) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { email: string };
    unsuppressCalls.push({ url, body });
    return ok({ ok: true, removed: 1, restoredToSchedule: false });
  }
  // Anything else: empty 200 keeps the page from spamming the console.
  return ok({});
});

beforeEach(() => {
  unsuppressCalls = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("WalletTopupRefundEmailSchedulePanel — paused recipients (Task #1761)", () => {
  it("renders the chip count and the warning panel from the GET response, and unsuppress hits the endpoint with the row's email", async () => {
    renderWithProviders(<WalletTopupRefundsPage />);

    // ── Chip ───────────────────────────────────────────────────────────
    // The chip renders only after the schedule GET resolves and the
    // saved recipients list is populated (gated on `sched && pausedRecipients.length > 0`).
    const chip = await screen.findByTestId("chip-refund-digest-paused-count");
    expect(chip).toHaveTextContent(/2 paused/);

    // ── Warning panel ──────────────────────────────────────────────────
    // The panel auto-opens because the saved (and hydrated) recipients
    // list contains both paused addresses, so `editedPausedRecipients`
    // is non-empty and gates the panel open without a chip click.
    const panel = await screen.findByTestId(
      "panel-refund-digest-paused-recipients",
    );
    const row901 = within(panel).getByTestId("refund-digest-paused-row-901");
    const row902 = within(panel).getByTestId("refund-digest-paused-row-902");

    // Original casing preserved (mixed case in the saved recipients).
    expect(row901).toHaveTextContent("Finance@Example.test");
    // Friendly reason label includes the bounce subtype.
    expect(row901).toHaveTextContent(/Bounced \(HardBounce\)/);
    expect(row901).toHaveTextContent(
      /The recipient's mailbox does not exist/,
    );

    expect(row902).toHaveTextContent("Treasurer@example.test");
    expect(row902).toHaveTextContent(/Spam complaint/);

    // ── Unsuppress button ──────────────────────────────────────────────
    const unsuppressBtn = within(row901).getByTestId(
      "button-refund-digest-unsuppress-901",
    );
    fireEvent.click(unsuppressBtn);

    await waitFor(() => {
      expect(unsuppressCalls).toHaveLength(1);
    });
    const call = unsuppressCalls[0];
    // The endpoint is called with the org id in the query string and the
    // original-cased email in the JSON body so the backend can find the
    // suppression row regardless of how the treasurer typed it.
    expect(call.url).toContain(
      "/api/admin/wallet-topup-refunds/email-schedule/unsuppress",
    );
    expect(call.url).toContain("organizationId=42");
    expect(call.body).toEqual({ email: "Finance@Example.test" });
  });
});
