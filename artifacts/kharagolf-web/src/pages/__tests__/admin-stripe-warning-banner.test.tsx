/**
 * Task #969 — UI smoke test for the Stripe-misconfigured admin banner.
 *
 * Companion to artifacts/api-server/src/tests/admin-channel-status-stripe-warning.test.ts
 * (Task #830), which pins down the API contract. This file covers the other
 * half: that admin.tsx actually renders the warning banner when the
 * channel-status API reports `payments.stripe.warning === true`, and hides it
 * when the flag is false. Catches regressions like an accidental conditional
 * removal, a `data-testid` rename, or a layout change that drops the banner.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import SettingsPage from "../admin";

interface StripeStatus {
  baseCurrency: string | null;
  usesStripe: boolean;
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  webhookEndpoint: string;
  warning: boolean;
  setupInstructions: string | null;
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ORG = {
  id: 42,
  name: "Pine Valley",
  slug: "pinevalley",
  description: null,
  logoUrl: null,
  primaryColor: "#1e4d2b",
  customDomain: null,
  subscriptionTier: "enterprise",
  isActive: true,
  contactEmail: null,
  contactPhone: null,
  address: null,
  website: null,
  defaultLanguage: "en",
};

const fetchedUrls: string[] = [];

function installFetch(stripe: StripeStatus) {
  fetchedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      if (url.endsWith("/api/organizations/42")) {
        return jsonResponse(ORG);
      }
      if (url.endsWith("/api/admin/channel-status")) {
        return jsonResponse({
          channels: {
            email: { active: false, provider: null, setupInstructions: null },
            push: { active: false, provider: null, setupInstructions: null },
            sms: { active: false, provider: null, setupInstructions: null },
            whatsapp: { active: false, provider: null, setupInstructions: null },
          },
          payments: { stripe },
        });
      }
      // The reauth-alert-settings query feeds a useEffect that reads
      // .settings.minCount, so the response must have the right shape even
      // though it's irrelevant to the banner under test.
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: { minCount: 0, minSharePct: 0, minAttempted: 0, email: null },
          defaults: { minCount: 0, minSharePct: 0, minAttempted: 0, fallbackEmail: null },
        });
      }
      if (url.endsWith("/api/admin/wellness-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      // All other admin queries (shop products, ghin credentials, etc.) are
      // irrelevant to the banner — degrade gracefully with an empty 200.
      return jsonResponse({}, 200);
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

const STRIPE_BASE: Omit<StripeStatus, "warning"> = {
  baseCurrency: "USD",
  usesStripe: true,
  secretKeyConfigured: true,
  webhookSecretConfigured: false,
  webhookEndpoint: "/api/stripe/webhook",
  setupInstructions: "Set STRIPE_WEBHOOK_SECRET on the API server.",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Stripe-misconfigured warning banner (Task #969)", () => {
  it("renders the banner when channel-status reports payments.stripe.warning === true", async () => {
    installFetch({ ...STRIPE_BASE, warning: true });
    renderPage();

    const banner = await screen.findByTestId("banner-stripe-webhook-warning");
    expect(banner).toBeInTheDocument();
    expect(banner).toBeVisible();
  });

  it("does NOT render the banner when payments.stripe.warning === false", async () => {
    installFetch({
      ...STRIPE_BASE,
      webhookSecretConfigured: true,
      setupInstructions: null,
      warning: false,
    });
    renderPage();

    // Wait until the page has actually issued the channel-status request,
    // so the banner-absent assertion runs after the query has resolved
    // (otherwise it could pass simply because the query is still pending).
    await waitFor(() => {
      expect(fetchedUrls.some(u => u.endsWith("/api/admin/channel-status")))
        .toBe(true);
    });
    // And give React-Query a tick to flush the resolved data into render.
    await waitFor(() => {
      expect(screen.queryByTestId("banner-stripe-webhook-warning"))
        .not.toBeInTheDocument();
    });
  });
});
