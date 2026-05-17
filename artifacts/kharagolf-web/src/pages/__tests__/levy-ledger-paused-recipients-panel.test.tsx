/**
 * Task #2201 — UI coverage for the levy-ledger paused-recipients dashboard.
 *
 * Task #1763 shipped the backend + UI for the amber "paused recipients" chip
 * and the per-row "Remove from suppression list" button on the levy-ledger
 * email-schedule editor. The HTTP contract (GET / PUT / POST unsuppress,
 * cross-org scoping, run-snapshot union, schedule restore) is already
 * covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/levy-ledger-email-paused-recipients.test.ts.
 * This file pins down the *web wiring* the task brief explicitly calls
 * out, for both the per-levy schedule drawer and the club-wide combined
 * digest panel:
 *
 *   1. The amber `chip-ledger-paused-recipients` (or the
 *      `chip-org-…` variant) renders when the API returns a non-empty
 *      `pausedRecipients` list, and shows the correct count.
 *   2. Clicking the chip expands the warning panel
 *      (`ledger-paused-recipients-panel` / `org-ledger-paused-recipients-panel`)
 *      and renders one row per paused address with the suppression
 *      reason copy.
 *   3. The "Remove from suppression list" button (testid
 *      `button-ledger-unsuppress-{email}` / `button-org-ledger-unsuppress-{email}`)
 *      POSTs to the matching `/email-schedule/unsuppress` endpoint with
 *      the right email payload, and the success toast surfaces.
 *   4. Snapshot-only paused rows (suppressionId === null, e.g. the
 *      suppression was already lifted by a prior unsuppress click but
 *      the address survives via the run-history snapshot) render the
 *      "from run history" label and DO NOT render the unsuppress button.
 *   5. The chip + panel are not rendered when the API returns an empty
 *      `pausedRecipients` list — i.e. the warning is exclusively a
 *      reaction to real server-side state, never client-only noise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import {
  LevyLedgerEmailSchedulePanel,
  OrgLevyLedgerEmailSchedulePanel,
} from "../club-members";

const ORG_ID = 42;
const LEVY_ID = 7;

interface PausedRow {
  suppressionId: number | null;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
  fromRunSnapshot?: boolean;
}

interface ScheduleResponse {
  schedule: {
    id: number;
    organizationId: number;
    levyId?: number;
    frequency: "weekly" | "monthly";
    enabled: boolean;
    recipients: string[];
    deliveryFormat?: "combined" | "per_levy_zip" | "both";
    lastSentAt: string | null;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  history: unknown[];
  pausedRecipients: PausedRow[];
}

interface Handler {
  perLevy: ScheduleResponse;
  org: ScheduleResponse;
  unsuppressCalls: Array<{ url: string; body: { email: string } }>;
  unsuppressResponse: { ok: true; removed: number; restoredToSchedule: boolean };
  unsuppressStatus: number;
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (
      method === "POST" &&
      (url.endsWith(`/levies/${LEVY_ID}/email-schedule/unsuppress`) ||
        url.endsWith(`/levy-ledger/email-schedule/unsuppress`))
    ) {
      const body = init?.body ? (JSON.parse(init.body as string) as { email: string }) : { email: "" };
      handler.unsuppressCalls.push({ url, body });
      return new Response(JSON.stringify(handler.unsuppressResponse), {
        status: handler.unsuppressStatus,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith(`/levies/${LEVY_ID}/email-schedule`)) {
      return new Response(JSON.stringify(handler.perLevy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith(`/levy-ledger/email-schedule`)) {
      return new Response(JSON.stringify(handler.org), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

function makeSchedule(overrides: Partial<ScheduleResponse["schedule"] & object> = {}) {
  return {
    id: 1,
    organizationId: ORG_ID,
    levyId: LEVY_ID,
    frequency: "weekly" as const,
    enabled: true,
    recipients: ["treasurer@club.example", "secretary@club.example"],
    deliveryFormat: "combined" as const,
    lastSentAt: new Date("2026-04-01T00:00:00Z").toISOString(),
    nextRunAt: new Date("2026-05-08T00:00:00Z").toISOString(),
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-04-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderPerLevy() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LevyLedgerEmailSchedulePanel orgId={ORG_ID} levyId={LEVY_ID} />
    </QueryClientProvider>,
  );
}

function renderOrg() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OrgLevyLedgerEmailSchedulePanel orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = {
    perLevy: { schedule: null, history: [], pausedRecipients: [] },
    org: { schedule: null, history: [], pausedRecipients: [] },
    unsuppressCalls: [],
    unsuppressResponse: { ok: true, removed: 1, restoredToSchedule: false },
    unsuppressStatus: 200,
  };
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Per-levy schedule drawer (Member 360 → Levies)
// ─────────────────────────────────────────────────────────────────────────
describe("Per-levy LevyLedgerEmailSchedulePanel — paused recipients", () => {
  it("renders the amber chip with the count and expands the warning panel + unsuppress button on click", async () => {
    handler.perLevy = {
      schedule: makeSchedule(),
      history: [],
      pausedRecipients: [
        {
          suppressionId: 11,
          email: "treasurer@club.example",
          reason: "bounced",
          bounceType: "permanent",
          description: "smtp 550 5.1.1 user unknown",
          createdAt: new Date("2026-04-15T12:00:00Z").toISOString(),
        },
      ],
    };

    renderPerLevy();

    // 1. The chip renders with the right count.
    const chip = await screen.findByTestId("chip-ledger-paused-recipients");
    expect(chip).toHaveTextContent(/1 paused/);

    // The warning panel is collapsed by default — only the chip is showing.
    expect(screen.queryByTestId("ledger-paused-recipients-panel")).not.toBeInTheDocument();

    // 2. Clicking the chip expands the warning panel.
    const user = userEvent.setup();
    await user.click(chip);

    const panel = await screen.findByTestId("ledger-paused-recipients-panel");
    // Row + email both render with the recipient's email preserved.
    const row = within(panel).getByTestId("ledger-paused-row-treasurer@club.example");
    expect(within(row).getByTestId("ledger-paused-email-treasurer@club.example")).toHaveTextContent("treasurer@club.example");
    // Reason label uses the friendly "Bounced (permanent)" copy from
    // levyLedgerPausedReasonLabel — the suppression description is
    // appended on the same line so finance can see the SMTP error.
    expect(row).toHaveTextContent(/Bounced \(permanent\)/);
    expect(row).toHaveTextContent(/smtp 550 5\.1\.1 user unknown/);
  });

  it("clicking 'Remove from suppression list' POSTs the email to the per-levy unsuppress endpoint", async () => {
    handler.perLevy = {
      schedule: makeSchedule(),
      history: [],
      pausedRecipients: [
        {
          suppressionId: 22,
          email: "treasurer@club.example",
          reason: "unsubscribed",
          bounceType: null,
          description: null,
          createdAt: new Date("2026-04-15T12:00:00Z").toISOString(),
        },
      ],
    };
    handler.unsuppressResponse = { ok: true, removed: 1, restoredToSchedule: true };

    renderPerLevy();

    const chip = await screen.findByTestId("chip-ledger-paused-recipients");
    const user = userEvent.setup();
    await user.click(chip);

    const button = await screen.findByTestId("button-ledger-unsuppress-treasurer@club.example");
    expect(button).toHaveTextContent(/Remove from suppression list/);

    await user.click(button);

    // Endpoint hit with the right payload, scoped to /levies/:id/email-schedule/unsuppress.
    await waitFor(() => {
      expect(handler.unsuppressCalls).toHaveLength(1);
    });
    const call = handler.unsuppressCalls[0];
    expect(call.url).toContain(`/organizations/${ORG_ID}/members-360/levies/${LEVY_ID}/email-schedule/unsuppress`);
    expect(call.body).toEqual({ email: "treasurer@club.example" });

    // Success toast surfaces with the "added back" copy because the
    // server reported restoredToSchedule=true (Task #1763 + #1444).
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const successCall = toastMock.mock.calls.find(
      ([arg]) => (arg as { title?: string }).title === "Removed from suppression list",
    );
    expect(successCall).toBeTruthy();
    expect((successCall![0] as { description: string }).description).toMatch(/added back to the recipients list/);
  });

  it("hides the unsuppress button on snapshot-only rows (suppressionId === null) and shows the 'from run history' label instead", async () => {
    handler.perLevy = {
      schedule: makeSchedule({ recipients: ["survivor@club.example"] }),
      history: [],
      pausedRecipients: [
        {
          // The address is no longer on the live suppression list (the
          // admin already lifted it) but survives via the most recent
          // run's snapshot — the panel must still surface it so finance
          // knows why the last run silently dropped it, but offering an
          // unsuppress button would be a no-op so we hide it.
          suppressionId: null,
          email: "lifted@club.example",
          reason: "spam_complaint",
          bounceType: null,
          description: null,
          createdAt: new Date("2026-04-10T12:00:00Z").toISOString(),
          fromRunSnapshot: true,
        },
      ],
    };

    renderPerLevy();

    const chip = await screen.findByTestId("chip-ledger-paused-recipients");
    const user = userEvent.setup();
    await user.click(chip);

    await screen.findByTestId("ledger-paused-recipients-panel");
    expect(screen.queryByTestId("button-ledger-unsuppress-lifted@club.example")).not.toBeInTheDocument();
    expect(screen.getByTestId("ledger-paused-history-lifted@club.example")).toHaveTextContent(/from run history/);
    // The "auto-removed on last run" copy fires off `fromRunSnapshot: true`.
    expect(screen.getByTestId("ledger-paused-row-lifted@club.example")).toHaveTextContent(/auto-removed on last run/);
  });

  it("does not render the chip or panel when the API returns an empty pausedRecipients list", async () => {
    handler.perLevy = {
      schedule: makeSchedule(),
      history: [],
      pausedRecipients: [],
    };

    renderPerLevy();

    // Wait for the panel to finish hydrating — the schedule rows
    // ("Last sent:" line) only render after the query resolves.
    await screen.findByText(/Last sent:/);
    expect(screen.queryByTestId("chip-ledger-paused-recipients")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-paused-recipients-panel")).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Club-wide combined ledger digest panel (org-levy-ledger-email-schedule)
// ─────────────────────────────────────────────────────────────────────────
describe("OrgLevyLedgerEmailSchedulePanel — paused recipients", () => {
  it("renders the amber chip + warning panel under the org-wide testid prefix", async () => {
    handler.org = {
      schedule: makeSchedule({ levyId: undefined }),
      history: [],
      pausedRecipients: [
        {
          suppressionId: 31,
          email: "treasurer@club.example",
          reason: "bounced",
          bounceType: "permanent",
          description: "550 mailbox unavailable",
          createdAt: new Date("2026-04-15T12:00:00Z").toISOString(),
        },
        {
          suppressionId: 32,
          email: "secretary@club.example",
          reason: "unsubscribed",
          bounceType: null,
          description: null,
          createdAt: new Date("2026-04-16T12:00:00Z").toISOString(),
        },
      ],
    };

    renderOrg();

    // The org panel container itself is the data-testid the task
    // brief explicitly names — confirm we mounted the right surface.
    await screen.findByTestId("org-levy-ledger-email-schedule");
    const chip = await screen.findByTestId("chip-org-ledger-paused-recipients");
    expect(chip).toHaveTextContent(/2 paused/);

    const user = userEvent.setup();
    await user.click(chip);

    const panel = await screen.findByTestId("org-ledger-paused-recipients-panel");
    expect(within(panel).getByTestId("org-ledger-paused-row-treasurer@club.example")).toHaveTextContent(/Bounced \(permanent\)/);
    expect(within(panel).getByTestId("org-ledger-paused-row-secretary@club.example")).toHaveTextContent(/Unsubscribed/);
  });

  it("clicking the org-wide unsuppress button POSTs to /levy-ledger/email-schedule/unsuppress with the email", async () => {
    handler.org = {
      schedule: makeSchedule({ levyId: undefined }),
      history: [],
      pausedRecipients: [
        {
          suppressionId: 41,
          email: "treasurer@club.example",
          reason: "bounced",
          bounceType: "permanent",
          description: null,
          createdAt: new Date("2026-04-15T12:00:00Z").toISOString(),
        },
      ],
    };
    handler.unsuppressResponse = { ok: true, removed: 1, restoredToSchedule: false };

    renderOrg();

    const chip = await screen.findByTestId("chip-org-ledger-paused-recipients");
    const user = userEvent.setup();
    await user.click(chip);

    const button = await screen.findByTestId("button-org-ledger-unsuppress-treasurer@club.example");
    expect(button).toHaveTextContent(/Remove from suppression list/);
    await user.click(button);

    await waitFor(() => {
      expect(handler.unsuppressCalls).toHaveLength(1);
    });
    const call = handler.unsuppressCalls[0];
    // Important — the org button must hit the org-wide endpoint, NOT
    // the per-levy one. This locks in that the two panels don't get
    // their endpoints crossed (which would silently lift suppressions
    // for the wrong scope).
    expect(call.url).toContain(`/organizations/${ORG_ID}/members-360/levy-ledger/email-schedule/unsuppress`);
    expect(call.url).not.toContain(`/levies/`);
    expect(call.body).toEqual({ email: "treasurer@club.example" });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const successCall = toastMock.mock.calls.find(
      ([arg]) => (arg as { title?: string }).title === "Removed from suppression list",
    );
    expect(successCall).toBeTruthy();
    // restoredToSchedule=false → the "next run" copy, NOT the "added back" copy.
    expect((successCall![0] as { description: string }).description).toMatch(/can receive ledger digests again on the next run/);
  });

  it("hides the org-wide unsuppress button on snapshot-only rows", async () => {
    handler.org = {
      schedule: makeSchedule({ levyId: undefined, recipients: ["committee@club.example"] }),
      history: [],
      pausedRecipients: [
        {
          suppressionId: null,
          email: "captain@club.example",
          reason: "bounced",
          bounceType: "permanent",
          description: null,
          createdAt: new Date("2026-04-10T12:00:00Z").toISOString(),
          fromRunSnapshot: true,
        },
      ],
    };

    renderOrg();

    const chip = await screen.findByTestId("chip-org-ledger-paused-recipients");
    const user = userEvent.setup();
    await user.click(chip);

    await screen.findByTestId("org-ledger-paused-recipients-panel");
    expect(screen.queryByTestId("button-org-ledger-unsuppress-captain@club.example")).not.toBeInTheDocument();
    expect(screen.getByTestId("org-ledger-paused-history-captain@club.example")).toHaveTextContent(/from run history/);
  });

  it("does not render the chip or warning panel when there are no paused recipients", async () => {
    handler.org = {
      schedule: makeSchedule({ levyId: undefined }),
      history: [],
      pausedRecipients: [],
    };

    renderOrg();

    await screen.findByText(/Last sent:/);
    expect(screen.queryByTestId("chip-org-ledger-paused-recipients")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-ledger-paused-recipients-panel")).not.toBeInTheDocument();
  });
});
