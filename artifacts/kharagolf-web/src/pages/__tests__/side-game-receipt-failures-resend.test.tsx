/**
 * UI test (Task #1868): Stuck side-game receipts widget — "Re-queue delivery"
 * button (resend mutation).
 *
 * Mounts <SideGameReceiptFailuresWidget /> with a mocked admin payload and
 * clicks the row's `button-resend-receipt-<id>`. Asserts:
 *   - the click POSTs to `/admin/side-game-receipt-failures/<id>/resend` with
 *     no request body (matches the dashboard component contract)
 *   - while the mutation is pending the button label flips to "Re-queuing…"
 *   - on a `{ ok: true, requeued: { email: true, push: false } }` response, a
 *     success toast is fired whose description mentions the re-queued
 *     channels ("email" — push was not re-queued)
 *
 * Regression guard: if the request URL/method, the body-less POST, the
 * pending-state label, or the toast wording were changed, this test would
 * fail.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// English assertions below ("Re-queue delivery" / "Re-queuing…" / the
// "Receipt re-queued" toast title and description) only resolve when the
// `dashboard` namespace is loaded. The shared setup file intentionally
// leaves i18next alone so most tests can run without paying the
// locale-bundle cost; we only need the en pack here. Mirrors the pattern
// used in `portal-comm-prefs-erasure-storage-digest-link-change-hint.test.tsx`.
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
const ATTEMPT_ID = 9001;

function fixtureResponse() {
  return {
    items: [
      {
        id: ATTEMPT_ID,
        settlementId: 555,
        recipientUserId: 700,
        recipientClubMemberId: 314,
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
    ],
    counts: { total: 1, exhausted: 1, skipped: 0 },
  };
}

type FetchCall = {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
};

let fetchCalls: FetchCall[];
let resendResolver: ((value: Response) => void) | null;

function installFetch() {
  fetchCalls = [];
  resendResolver = null;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body,
    });
    if (url.includes(`/admin/side-game-receipt-failures/${ATTEMPT_ID}/resend`)) {
      // Return a promise we can resolve later so the test can observe the
      // pending "Re-queuing…" label.
      return new Promise<Response>(resolve => {
        resendResolver = resolve;
      });
    }
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

describe("<SideGameReceiptFailuresWidget /> — Re-queue delivery button (Task #1868)", () => {
  it("POSTs to the resend endpoint, shows a pending label, and toasts the re-queued channels on success", async () => {
    const user = userEvent.setup();
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-receipt-${ATTEMPT_ID}`);
    const button = within(row).getByTestId(`button-resend-receipt-${ATTEMPT_ID}`);
    expect(button).toHaveTextContent("Re-queue delivery");

    await user.click(button);

    // The POST should be in flight — assert URL, method, and body-less request.
    await waitFor(() => {
      const call = fetchCalls.find(c =>
        c.url.includes(`/admin/side-game-receipt-failures/${ATTEMPT_ID}/resend`),
      );
      expect(call).toBeDefined();
      expect(call!.method).toBe("POST");
      expect(call!.body == null).toBe(true);
    });

    // Pending label flips to "Re-queuing…" while the mutation is in flight.
    await waitFor(() => {
      expect(button).toHaveTextContent("Re-queuing…");
    });
    expect(button).toBeDisabled();

    // Resolve the mocked response — only email was re-queued.
    expect(resendResolver).not.toBeNull();
    resendResolver!(
      new Response(
        JSON.stringify({ ok: true, requeued: { email: true, push: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response,
    );

    // Success toast wording should mention the re-queued channel.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Receipt re-queued",
          description: expect.stringContaining("email"),
        }),
      );
    });

    // Push wasn't re-queued, so the description must not advertise it.
    const successCall = toastMock.mock.calls.find(
      ([arg]) => (arg as { title?: string }).title === "Receipt re-queued",
    );
    expect(successCall).toBeDefined();
    const successArg = successCall![0] as {
      description: string;
      variant?: string;
    };
    expect(successArg.description).not.toMatch(/push/i);
    // Success toast must not be flagged as destructive (that variant is
    // reserved for the onError path).
    expect(successArg.variant).toBeUndefined();
  });
});
