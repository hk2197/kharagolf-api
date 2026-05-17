/**
 * UI test (Task #1869): Stuck wallet-withdrawal alerts widget — recipient
 * name deep-link to Member 360.
 *
 * Mirrors `side-game-receipt-failures-link.test.tsx` (Task #1516) so the
 * two admin-facing recovery widgets get equal coverage. The widget under
 * test is `WalletWithdrawalNotifyFailuresWidget`, which is structurally a
 * twin of `SideGameReceiptFailuresWidget` (per its header comment) and
 * gained the same Member 360 deep-link in this task — opening the
 * Financial tab (the wallet/withdrawal trail) instead of the Audit tab
 * (the receipt-delivery trail used by the side-game widget).
 *
 * Mounts the widget with a mocked admin payload that contains two stuck
 * rows — one whose recipient is resolved to a club member
 * (`recipientClubMemberId` set) and one that is not (null). Asserts:
 *   - the resolved row's name is wrapped in an <a> linking to
 *     `/member-360/<id>?tab=financial`
 *   - the unresolved row renders the recipient name as a plain label
 *     that is NOT wrapped in a link
 *
 * Regression guard: if the deep-link href shape (path or `tab=` value),
 * the conditional rendering around `recipientClubMemberId`, or the
 * test-id contracts were changed, this test would fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { WalletWithdrawalNotifyFailuresWidget } from "../dashboard";

const ORG_ID = 42;

const LINKED_ATTEMPT_ID = 7001;
const LINKED_CLUB_MEMBER_ID = 271;

const PLAIN_ATTEMPT_ID = 7002;

function fixtureResponse() {
  return {
    items: [
      {
        id: LINKED_ATTEMPT_ID,
        withdrawalId: 8801,
        organizationId: ORG_ID,
        userId: 500,
        recipientClubMemberId: LINKED_CLUB_MEMBER_ID,
        outcome: "processed",
        amount: 1500,
        currency: "INR",
        destination: "UPI · alice@upi",
        utr: "UTR111",
        reason: null,
        createdAt: "2026-04-29T11:00:00Z",
        recipientName: "Linked Larry",
        recipientEmail: "larry@example.com",
        emailStatus: "failed",
        emailAttempts: 4,
        lastEmailAt: null,
        lastEmailError: "smtp boom",
        emailRetryExhaustedAt: "2026-04-29T11:30:00Z",
        pushStatus: null,
        pushAttempts: 0,
        lastPushAt: null,
        lastPushError: null,
        pushRetryExhaustedAt: null,
        smsStatus: null,
        smsError: null,
        lastSmsAt: null,
        whatsappStatus: null,
        whatsappError: null,
        lastWhatsappAt: null,
        emailStuck: true,
        pushStuck: false,
      },
      {
        id: PLAIN_ATTEMPT_ID,
        withdrawalId: 8802,
        organizationId: ORG_ID,
        userId: 501,
        recipientClubMemberId: null,
        outcome: "reversed",
        amount: 900,
        currency: "INR",
        destination: "Bank · ****1234",
        utr: null,
        reason: null,
        createdAt: "2026-04-29T11:05:00Z",
        recipientName: "Unlinked Ursula",
        recipientEmail: null,
        emailStatus: "skipped",
        emailAttempts: 0,
        lastEmailAt: null,
        lastEmailError: null,
        emailRetryExhaustedAt: null,
        pushStatus: "skipped",
        pushAttempts: 0,
        lastPushAt: null,
        lastPushError: null,
        pushRetryExhaustedAt: null,
        smsStatus: null,
        smsError: null,
        lastSmsAt: null,
        whatsappStatus: null,
        whatsappError: null,
        lastWhatsappAt: null,
        emailStuck: true,
        pushStuck: true,
      },
    ],
    counts: { total: 2, exhausted: 1, skipped: 1 },
  };
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/wallet-withdrawal-notify-failures")) {
      return new Response(JSON.stringify(fixtureResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WalletWithdrawalNotifyFailuresWidget orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<WalletWithdrawalNotifyFailuresWidget /> — Member 360 deep link (Task #1869)", () => {
  it("wraps the recipient name in a link to /member-360/:id?tab=financial when recipientClubMemberId is set", async () => {
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-withdrawal-${LINKED_ATTEMPT_ID}`);

    const link = within(row).getByTestId(`link-stuck-withdrawal-recipient-${LINKED_ATTEMPT_ID}`);
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute(
      "href",
      `/member-360/${LINKED_CLUB_MEMBER_ID}?tab=financial`,
    );

    // The recipient label lives inside the link.
    const label = within(row).getByTestId(`text-stuck-withdrawal-recipient-${LINKED_ATTEMPT_ID}`);
    expect(label).toHaveTextContent("Linked Larry");
    expect(link).toContainElement(label);
  });

  it("renders a plain (non-link) recipient label when recipientClubMemberId is null", async () => {
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-withdrawal-${PLAIN_ATTEMPT_ID}`);

    // No deep-link wrapper for this row.
    expect(
      within(row).queryByTestId(`link-stuck-withdrawal-recipient-${PLAIN_ATTEMPT_ID}`),
    ).not.toBeInTheDocument();

    const label = within(row).getByTestId(`text-stuck-withdrawal-recipient-${PLAIN_ATTEMPT_ID}`);
    expect(label).toHaveTextContent("Unlinked Ursula");
    expect(label.closest("a")).toBeNull();

    // Sanity: the linked row above is still a link, so this assertion
    // isn't accidentally passing because the widget never emits links
    // at all.
    await waitFor(() => {
      expect(
        screen.getByTestId(`link-stuck-withdrawal-recipient-${LINKED_ATTEMPT_ID}`),
      ).toBeInTheDocument();
    });
  });
});
