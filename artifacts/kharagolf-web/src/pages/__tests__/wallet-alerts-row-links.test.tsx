import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ORG_ID = 4242;

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, role: "org_admin", organizationId: ORG_ID },
    isLoading: false,
  }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => ORG_ID,
}));

import WalletAlertsPage from "../wallet-alerts";

const ALERT_ROW = {
  id: 11,
  withdrawalId: 9876,
  organizationId: ORG_ID,
  userId: 555,
  outcome: "processed",
  amount: 1250.5,
  currency: "INR",
  destination: "ICICI ••1234",
  utr: "UTR1234",
  reason: null,
  createdAt: "2026-04-25T10:00:00.000Z",
  recipientName: "Alice Searchable",
  recipientEmail: "alice@example.com",
  emailStatus: "failed",
  emailAttempts: 5,
  lastEmailAt: "2026-04-25T10:05:00.000Z",
  lastEmailError: "bounced",
  emailRetryExhaustedAt: "2026-04-25T10:05:00.000Z",
  pushStatus: null,
  pushAttempts: 0,
  lastPushAt: null,
  lastPushError: null,
  pushRetryExhaustedAt: null,
  emailStuck: true,
  pushStuck: false,
};

const RESPONSE = {
  items: [ALERT_ROW],
  counts: { total: 1, exhausted: 1, skipped: 0 },
  page: { limit: 50, offset: 0 },
  filters: { channel: null, state: null, q: null },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/wallet-withdrawal-notify-failures")) {
      return new Response(JSON.stringify(RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WalletAlertsPage />
    </QueryClientProvider>,
  );
}

describe("WalletAlertsPage row links (Task #1498)", () => {
  it("renders distinct recipient (wallet history) and withdrawal (detail) deep links", async () => {
    renderPage();

    const recipientLink = await waitFor(() =>
      screen.getByTestId(`link-recipient-${ALERT_ROW.id}`),
    );
    const withdrawalLink = screen.getByTestId(`link-withdrawal-${ALERT_ROW.id}`);

    const recipientHref = recipientLink.getAttribute("href") ?? "";
    const withdrawalHref = withdrawalLink.getAttribute("href") ?? "";

    expect(recipientHref).toContain(`/member-360/${ALERT_ROW.userId}`);
    expect(recipientHref).toContain("tab=financial");
    expect(recipientHref).not.toMatch(/withdrawalId=/);

    expect(withdrawalHref).toContain(`/member-360/${ALERT_ROW.userId}`);
    expect(withdrawalHref).toContain(`withdrawalId=${ALERT_ROW.withdrawalId}`);
    expect(withdrawalHref).toContain(`#withdrawal-${ALERT_ROW.withdrawalId}`);

    expect(withdrawalHref).not.toBe(recipientHref);
  });
});
