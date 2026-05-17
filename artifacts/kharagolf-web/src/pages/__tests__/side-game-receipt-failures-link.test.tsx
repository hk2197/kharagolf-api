/**
 * UI test (Task #1516): Stuck side-game receipts widget — recipient name
 * deep-link to Member 360 (Task #1291).
 *
 * Mounts <SideGameReceiptFailuresWidget /> with a mocked admin payload that
 * contains two stuck rows — one whose recipient is resolved to a club member
 * (`recipientClubMemberId` set) and one that is not (null). Asserts:
 *   - the resolved row's name is wrapped in an <a> linking to
 *     `/member-360/<id>?tab=audit`
 *   - the unresolved row renders the recipient name as a plain label that
 *     is NOT wrapped in a link
 *
 * Regression guard: if the deep-link href shape, the conditional rendering
 * around `recipientClubMemberId`, or the test-id contracts were changed,
 * this test would fail.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enDashboard from "../../i18n/locales/en/dashboard.json";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { SideGameReceiptFailuresWidget } from "../dashboard";

// Task #1888 localised the panel via `useTranslation('dashboard')` so the
// recipient-name fallback (e.g. "User #700") and the row-detail line only
// resolve once the `dashboard` namespace is loaded. The shared setup file
// intentionally leaves i18next alone so most tests can run without paying
// the locale-bundle cost; we only need the en pack here.
beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      defaultNS: "dashboard",
      ns: ["dashboard"],
      resources: { en: { dashboard: enDashboard } },
      interpolation: { escapeValue: false },
    });
  }
});

const ORG_ID = 42;

const LINKED_ATTEMPT_ID = 9001;
const LINKED_CLUB_MEMBER_ID = 314;

const PLAIN_ATTEMPT_ID = 9002;

function fixtureResponse() {
  return {
    items: [
      {
        id: LINKED_ATTEMPT_ID,
        settlementId: 555,
        recipientUserId: 700,
        recipientClubMemberId: LINKED_CLUB_MEMBER_ID,
        payerName: "Payer Patty",
        recipientName: "Linked Larry",
        recipientEmail: "larry@example.com",
        gameLabel: "Skins",
        currency: "INR",
        amount: 1200,
        paidAt: "2026-04-29T10:00:00Z",
        emailStatus: "failed",
        emailAttempts: 4,
        lastEmailError: "smtp boom",
        emailRetryExhaustedAt: "2026-04-29T10:30:00Z",
        pushStatus: null,
        pushAttempts: 0,
        lastPushError: null,
        pushRetryExhaustedAt: null,
        emailStuck: true,
        pushStuck: false,
      },
      {
        id: PLAIN_ATTEMPT_ID,
        settlementId: 556,
        recipientUserId: 701,
        recipientClubMemberId: null,
        payerName: "Payer Pete",
        recipientName: "Unlinked Ursula",
        recipientEmail: null,
        gameLabel: "Nassau",
        currency: "INR",
        amount: 800,
        paidAt: "2026-04-29T10:05:00Z",
        emailStatus: "skipped",
        emailAttempts: 0,
        lastEmailError: null,
        emailRetryExhaustedAt: null,
        pushStatus: "skipped",
        pushAttempts: 0,
        lastPushError: null,
        pushRetryExhaustedAt: null,
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
    if (url.includes("/admin/side-game-receipt-failures")) {
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
      <SideGameReceiptFailuresWidget orgId={ORG_ID} />
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

describe("<SideGameReceiptFailuresWidget /> — Member 360 deep link (Task #1291)", () => {
  it("wraps the recipient name in a link to /member-360/:id?tab=audit when recipientClubMemberId is set", async () => {
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-receipt-${LINKED_ATTEMPT_ID}`);

    const link = within(row).getByTestId(`link-stuck-recipient-${LINKED_ATTEMPT_ID}`);
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute(
      "href",
      `/member-360/${LINKED_CLUB_MEMBER_ID}?tab=audit`,
    );

    // The recipient label lives inside the link.
    const label = within(row).getByTestId(`text-stuck-recipient-${LINKED_ATTEMPT_ID}`);
    expect(label).toHaveTextContent("Linked Larry");
    expect(link).toContainElement(label);
  });

  it("renders a plain (non-link) recipient label when recipientClubMemberId is null", async () => {
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-receipt-${PLAIN_ATTEMPT_ID}`);

    // No deep-link wrapper for this row.
    expect(
      within(row).queryByTestId(`link-stuck-recipient-${PLAIN_ATTEMPT_ID}`),
    ).not.toBeInTheDocument();

    const label = within(row).getByTestId(`text-stuck-recipient-${PLAIN_ATTEMPT_ID}`);
    expect(label).toHaveTextContent("Unlinked Ursula");
    expect(label.closest("a")).toBeNull();

    // Sanity: the linked row above is still a link, so this assertion isn't
    // accidentally passing because the widget never emits links at all.
    await waitFor(() => {
      expect(
        screen.getByTestId(`link-stuck-recipient-${LINKED_ATTEMPT_ID}`),
      ).toBeInTheDocument();
    });
  });
});
