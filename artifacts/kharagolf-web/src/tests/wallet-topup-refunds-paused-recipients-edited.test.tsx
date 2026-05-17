/**
 * Task #2195 — frontend coverage for the auto-refund digest's
 * *live-edit* paused-recipients warning.
 *
 * Task #1761 covered the case where the *saved* recipients list overlaps
 * the org's suppression table (the warning panel auto-opens on mount
 * because `editedPausedRecipients` immediately matches the hydrated
 * recipients). This test covers the equally important pre-save path:
 * the saved schedule's recipients are clean, but the treasurer types a
 * known-paused address into the textarea. The `editedPausedRecipients`
 * memo on `WalletTopupRefundEmailSchedulePanel` should re-derive on
 * every keystroke so the warning panel pops *before* they hit Save —
 * otherwise finance would silently lose that address on the next cron
 * tick with no inline feedback.
 *
 * Mirrors the fixture-driven mock pattern from
 * `wallet-topup-refunds-paused-recipients.test.tsx`: stubs `fetch`,
 * mocks `useGetMe` + `useActiveOrgContext`, and wraps in
 * QueryClientProvider so we don't drag in a real backend.
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

// The *saved* schedule has a single, perfectly clean recipient — none of
// the org's paused addresses appear here. That is the whole point: the
// panel must NOT render on initial mount, and must only appear once the
// treasurer types a paused address into the textarea.
const SAVED_CLEAN_RECIPIENT = "ops@example.test";

// The org's suppression table contains one paused address that the
// treasurer is *about* to retype into the digest box (the kind of typo
// you'd make from memory after the address bounced).
const PAUSED_FIXTURE: PausedRecipientRow[] = [
  {
    suppressionId: 555,
    email: "bounced.treasurer@example.test",
    reason: "bounced",
    bounceType: "HardBounce",
    description: "The recipient's mailbox does not exist",
    createdAt: "2026-04-15T12:00:00.000Z",
  },
];

const SCHEDULE_FIXTURE: ScheduleRow = {
  id: 4321,
  organizationId: 42,
  frequency: "weekly",
  recipients: [SAVED_CLEAN_RECIPIENT],
  enabled: true,
  lastSentAt: "2026-04-20T09:00:00.000Z",
  nextRunAt: "2026-04-27T09:00:00.000Z",
  createdAt: "2026-01-01T09:00:00.000Z",
  updatedAt: "2026-04-20T09:00:00.000Z",
};

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
    // Crucially: the suppression table has a paused address but the
    // *saved* schedule does not include it, so `pausedRecipients`
    // alone won't open the panel — only the live-edited list can.
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

  if (url.includes("/api/admin/wallet-topup-refunds?") && !url.includes("/email-schedule")) {
    return ok({ items: [], totalsByCurrency: {} });
  }
  if (
    method === "GET" &&
    url.includes("/api/admin/wallet-topup-refunds/email-schedule")
  ) {
    return ok(buildScheduleResponse());
  }
  return ok({});
});

beforeEach(() => {
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

describe("WalletTopupRefundEmailSchedulePanel — live-edit paused recipients (Task #2195)", () => {
  it("opens the warning panel as soon as a paused address is typed into the recipients textarea", async () => {
    renderWithProviders(<WalletTopupRefundsPage />);

    // ── Initial state ──────────────────────────────────────────────────
    // Wait for the schedule GET to resolve and the textarea to hydrate
    // from `sched.recipients`. The saved list is clean, so the warning
    // panel must NOT be rendered at this point — only the chip is, since
    // the org-level paused list still has one entry.
    const textarea = await screen.findByTestId(
      "input-refund-digest-recipients",
    );
    await waitFor(() => {
      expect(textarea).toHaveValue(SAVED_CLEAN_RECIPIENT);
    });

    // The saved recipients don't overlap the suppression table, so the
    // warning panel is not in the DOM yet (it's gated on
    // `editedPausedRecipients.length > 0 || (pausedExpanded && ...)`).
    expect(
      screen.queryByTestId("panel-refund-digest-paused-recipients"),
    ).toBeNull();

    // The chip *is* there — the org has a paused recipient — but it's
    // collapsed by default.
    expect(
      await screen.findByTestId("chip-refund-digest-paused-count"),
    ).toHaveTextContent(/1 paused/);

    // ── Live edit ──────────────────────────────────────────────────────
    // Treasurer types the paused address (with mixed casing, like a
    // real typo) into the textarea, alongside the existing clean
    // recipient. `editedPausedRecipients` should re-derive on this
    // keystroke and flip the panel open *before* Save is clicked.
    const TYPED_PAUSED = "Bounced.Treasurer@Example.test";
    fireEvent.change(textarea, {
      target: { value: `${SAVED_CLEAN_RECIPIENT}, ${TYPED_PAUSED}` },
    });

    // ── Warning panel ──────────────────────────────────────────────────
    const panel = await screen.findByTestId(
      "panel-refund-digest-paused-recipients",
    );
    const row = within(panel).getByTestId("refund-digest-paused-row-555");

    // The row renders the *just-typed* casing (preserved by the
    // memo's `out.push({ ...hit, email: r })`), not the lower-cased
    // form stored in the suppression table — so the treasurer can
    // recognise their own typo at a glance.
    expect(row).toHaveTextContent(TYPED_PAUSED);
    // Friendly reason label still comes from the suppression row.
    expect(row).toHaveTextContent(/Bounced \(HardBounce\)/);
    expect(row).toHaveTextContent(/The recipient's mailbox does not exist/);

    // The clean recipient must NOT show up as a paused row — only the
    // typed-in suppressed one does.
    expect(
      within(panel).queryByText(SAVED_CLEAN_RECIPIENT),
    ).toBeNull();
  });
});
