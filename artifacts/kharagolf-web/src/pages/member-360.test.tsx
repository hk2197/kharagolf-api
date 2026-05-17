/**
 * Component test: ResendHistoryPopover system retry surfacing (Task 317).
 *
 * Task 251 wired the popover to render a violet "by system" badge for
 * cron-driven privacy retries (audit rows tagged `metadata.source === "cron"`,
 * exposed by the resend-history endpoint as `initiatedBy: "system"`) and
 * added an explicit "By system" filter tab. This test renders the popover
 * against a mocked endpoint and verifies:
 *
 *   1. The system entry's "by system" badge appears in the open popover.
 *   2. The "By system" filter tab narrows the visible list to only the
 *      system-initiated entry, hiding the admin- and member-initiated ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResendHistoryPopover, parseAddressSuppressedReason } from "./member-360";

const REQUEST_ID = 4242;
const ADMIN_ENTRY_ID = 1001;
const MEMBER_ENTRY_ID = 1002;
const SYSTEM_ENTRY_ID = 1003;

const HISTORY_PAYLOAD = {
  count: 3,
  history: [
    {
      id: ADMIN_ENTRY_ID,
      actorName: "Alice Admin",
      actorRole: "org_admin",
      reason: "filed notice resent — email:sent, in_app:sent, push:sent, sms:sent",
      createdAt: "2026-04-15T10:00:00.000Z",
      channels: {
        email: { status: "sent", at: "2026-04-15T10:00:01.000Z", error: null },
        inApp: { status: "sent", at: "2026-04-15T10:00:01.000Z", error: null },
        push: { status: "sent", at: "2026-04-15T10:00:01.000Z", error: null },
        sms: { status: "sent", at: "2026-04-15T10:00:01.000Z", error: null },
      },
      initiatedBy: "admin",
    },
    {
      id: MEMBER_ENTRY_ID,
      actorName: "Mary Member",
      actorRole: "member",
      reason: "member resent filed notice — email:sent",
      createdAt: "2026-04-16T11:00:00.000Z",
      channels: {
        email: { status: "sent", at: "2026-04-16T11:00:01.000Z", error: null },
        inApp: null,
        push: null,
        sms: null,
      },
      initiatedBy: "member",
    },
    {
      id: SYSTEM_ENTRY_ID,
      actorName: null,
      actorRole: null,
      reason: "automatic sms retry — sms:failed (exhausted) attempt:5",
      createdAt: "2026-04-17T12:00:00.000Z",
      channels: {
        email: null,
        inApp: null,
        push: null,
        sms: { status: "failed", at: "2026-04-17T12:00:01.000Z", error: "twilio 21610 unsubscribed" },
      },
      initiatedBy: "system",
    },
  ],
};

function renderPopover() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ResendHistoryPopover
        base={`/api/organizations/1/members-360/2`}
        requestId={REQUEST_ID}
        count={3}
        lastAt={"2026-04-17T12:00:00.000Z"}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(`/data-requests/${REQUEST_ID}/resend-history`)) {
      return new Response(JSON.stringify(HISTORY_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ResendHistoryPopover — system retry surfacing", () => {
  it("renders the 'by system' badge for cron-emitted entries when opened", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole("button", { name: /Resent 3 times/i }));

    // Wait for the popover content to appear with the resend history.
    await waitFor(() => {
      expect(screen.getByText(/Resend history/i)).toBeInTheDocument();
    });

    // The cron entry must surface the "by system" badge with the test id.
    const systemBadge = await screen.findByTestId(`resend-history-system-badge-${SYSTEM_ENTRY_ID}`);
    expect(systemBadge).toBeInTheDocument();
    expect(systemBadge).toHaveTextContent(/by system/i);
  });

  it("renders the initiator filter tabs even when the resend history is empty (Task 394)", async () => {
    // Override the fetch mock for this test so the endpoint reports zero
    // resends. Admins still want to pre-select the "By system" tab to
    // confirm the cron has not retried, so the filter bar must remain
    // visible alongside an explicit empty-state message.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/data-requests/${REQUEST_ID}/resend-history`)) {
          return new Response(JSON.stringify({ count: 0, history: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      },
    );

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ResendHistoryPopover
          base={`/api/organizations/1/members-360/2`}
          requestId={REQUEST_ID}
          count={0}
          lastAt={null}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Resent 0 times/i }));
    await waitFor(() => {
      expect(screen.getByText(/Resend history/i)).toBeInTheDocument();
    });

    // The filter bar must render even with zero history entries…
    const filterBar = await screen.findByTestId(`resend-history-initiator-filter-${REQUEST_ID}`);
    expect(filterBar).toBeInTheDocument();
    expect(
      within(filterBar).getByTestId(`resend-history-initiator-system-${REQUEST_ID}`),
    ).toBeInTheDocument();

    // …and the explicit empty-state message must explain the gap.
    expect(screen.getByTestId(`resend-history-empty-${REQUEST_ID}`)).toHaveTextContent(
      /No resends recorded yet/i,
    );

    // The "By system" tab is still selectable; clicking it does not crash and
    // keeps the empty-state message in view.
    await user.click(screen.getByTestId(`resend-history-initiator-system-${REQUEST_ID}`));
    expect(screen.getByTestId(`resend-history-empty-${REQUEST_ID}`)).toBeInTheDocument();
  });

  it("the 'By system' filter tab narrows the list to only system-initiated entries", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole("button", { name: /Resent 3 times/i }));
    await waitFor(() => {
      expect(screen.getByText(/Resend history/i)).toBeInTheDocument();
    });

    // Baseline: with the "All" tab active, all three entries are visible.
    expect(screen.getByText(/by Alice Admin/i)).toBeInTheDocument();
    expect(screen.getByText(/by Mary Member/i)).toBeInTheDocument();
    // The system entry has no actor name and falls back to "by system".
    const filterBar = await screen.findByTestId(`resend-history-initiator-filter-${REQUEST_ID}`);
    expect(filterBar).toBeInTheDocument();

    // Switch to the "By system" tab.
    const systemTab = await screen.findByTestId(`resend-history-initiator-system-${REQUEST_ID}`);
    await user.click(systemTab);

    // Only the system entry should remain. Admin- and member-initiated rows
    // (identified by their actor names) must be filtered out.
    await waitFor(() => {
      expect(screen.queryByText(/by Alice Admin/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/by Mary Member/i)).not.toBeInTheDocument();
    });

    // The system row's "by system" badge is still visible.
    const systemBadge = within(filterBar.parentElement as HTMLElement).queryByTestId(
      `resend-history-system-badge-${SYSTEM_ENTRY_ID}`,
    ) ?? screen.getByTestId(`resend-history-system-badge-${SYSTEM_ENTRY_ID}`);
    expect(systemBadge).toBeInTheDocument();
  });
});

/**
 * Task #2245 — when `dataRequestNotify.ts` skips the privacy email send
 * because the recipient address is already on the org's bounce/suppression
 * list, the resend-history audit row carries
 * `email.status === "skipped"` with
 * `email.error === "address_suppressed:<reason>"`. The popover must turn
 * that opaque error string into a controller-friendly explanation (and
 * deep-link into the suppressions admin page) instead of just showing
 * a "skipped" chip.
 */
describe("ResendHistoryPopover — address_suppressed surfacing", () => {
  const SUPPRESSED_ENTRY_ID = 2001;

  function mockHistory(history: unknown[]) {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/data-requests/${REQUEST_ID}/resend-history`)) {
          return new Response(JSON.stringify({ count: history.length, history }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      },
    );
  }

  it("renders a friendly bounce-list line for address_suppressed:<reason>", async () => {
    mockHistory([
      {
        id: SUPPRESSED_ENTRY_ID,
        actorName: null,
        actorRole: null,
        reason: "automatic email retry — email:skipped (address_suppressed:hard_bounce)",
        createdAt: "2026-04-20T09:00:00.000Z",
        channels: {
          email: {
            status: "skipped",
            at: "2026-04-20T09:00:01.000Z",
            error: "address_suppressed:hard_bounce",
          },
          inApp: null,
          push: null,
          sms: null,
        },
        initiatedBy: "system",
      },
    ]);

    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole("button", { name: /Resent 3 times/i }));
    await waitFor(() => {
      expect(screen.getByText(/Resend history/i)).toBeInTheDocument();
    });

    const note = await screen.findByTestId(
      `resend-history-address-suppressed-${SUPPRESSED_ENTRY_ID}`,
    );
    expect(note).toHaveTextContent(/address is on the organisation's bounce list/i);
    expect(note).toHaveTextContent(/hard bounce/i);

    const link = within(note).getByTestId(
      `resend-history-address-suppressed-link-${SUPPRESSED_ENTRY_ID}`,
    );
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/marketing");
  });

  it("does NOT render the bounce-list line for skipped rows without an address_suppressed error", async () => {
    mockHistory([
      {
        id: SUPPRESSED_ENTRY_ID,
        actorName: null,
        actorRole: null,
        reason: "automatic email retry — email:skipped (no_address)",
        createdAt: "2026-04-20T09:00:00.000Z",
        channels: {
          // A plain "skipped" outcome (e.g. `no_address`, opted-out) must
          // continue to render the existing badge-only treatment.
          email: { status: "skipped", at: "2026-04-20T09:00:01.000Z", error: "no_address" },
          inApp: null,
          push: null,
          sms: null,
        },
        initiatedBy: "system",
      },
    ]);

    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole("button", { name: /Resent 3 times/i }));
    await waitFor(() => {
      expect(screen.getByText(/Resend history/i)).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId(`resend-history-address-suppressed-${SUPPRESSED_ENTRY_ID}`),
    ).not.toBeInTheDocument();
  });
});

describe("parseAddressSuppressedReason", () => {
  it("returns null for non-suppression errors", () => {
    expect(parseAddressSuppressedReason(null)).toBeNull();
    expect(parseAddressSuppressedReason("")).toBeNull();
    expect(parseAddressSuppressedReason("twilio 21610 unsubscribed")).toBeNull();
    expect(parseAddressSuppressedReason("no_address")).toBeNull();
  });

  it("maps well-known suppression reasons to friendly labels", () => {
    expect(parseAddressSuppressedReason("address_suppressed:hard_bounce")).toBe("hard bounce");
    expect(parseAddressSuppressedReason("address_suppressed:soft_bounce")).toBe("soft bounce");
    expect(parseAddressSuppressedReason("address_suppressed:complaint")).toBe("spam complaint");
    expect(parseAddressSuppressedReason("address_suppressed:spam_complaint")).toBe("spam complaint");
    expect(parseAddressSuppressedReason("address_suppressed:unsubscribed")).toBe("unsubscribed");
    expect(parseAddressSuppressedReason("address_suppressed:manual")).toBe("added manually");
  });

  it("falls back to the raw reason (with underscores swapped for spaces) for unknown reasons", () => {
    expect(parseAddressSuppressedReason("address_suppressed:future_reason")).toBe("future reason");
    expect(parseAddressSuppressedReason("address_suppressed:")).toBe("reason unspecified");
  });
});
