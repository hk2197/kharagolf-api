/**
 * Task #2023 — UI smoke test for the "Send test to me" action inside the
 * notification-template preview dialog on the channels admin tab.
 *
 * Companion to the API contract test
 * (artifacts/api-server/src/tests/admin-notification-template-send-test.test.ts),
 * which pins down the response shape this UI relies on.
 *
 * Verifies that:
 *   1. The preview dialog footer carries a "Send test to me" button.
 *   2. Clicking it POSTs to
 *      `/api/admin/notification-templates/:key/send-test?lang=...` with
 *      the picker's currently-selected language.
 *   3. A successful response surfaces a success toast that names which
 *      channels delivered.
 *   4. A failed-channel response surfaces a destructive toast naming the
 *      failed channel(s) so the admin sees the partial outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin", preferredLanguage: "en" },
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import SettingsPage from "../admin";

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

const REGISTERED_KEYS = ["handicap.committee.changed"];
const REGISTERED_ENTRIES = REGISTERED_KEYS.map((key) => ({
  key,
  category: "handicap",
  description: `Sample description for ${key}.`,
  digestable: true,
  defaultChannels: ["email", "push"],
  auditRequired: true,
}));

function previewBody(lang: string) {
  return {
    key: REGISTERED_KEYS[0],
    category: "handicap",
    description: "The handicap committee changed your handicap index.",
    digestable: true,
    defaultChannels: ["email", "push"],
    auditRequired: true,
    branded: true,
    lang,
    availableLanguages: ["en", "es", "fr"],
    sample: {
      title: "Handicap updated",
      body: "Test body",
      html: "<!doctype html><html><body>x</body></html>",
    },
  };
}

let fetchedUrls: string[];
let fetchedInits: (RequestInit | undefined)[];

function installFetch(opts: { sendTestBody?: unknown; sendTestStatus?: number } = {}) {
  fetchedUrls = [];
  fetchedInits = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      fetchedInits.push(init);
      if (url.endsWith("/api/organizations/42")) return jsonResponse(ORG);
      if (url.endsWith("/api/admin/channel-status")) {
        return jsonResponse({
          channels: {
            email: { active: false, provider: null, setupInstructions: null },
            push: { active: false, provider: null, setupInstructions: null },
            sms: { active: false, provider: null, setupInstructions: null },
            whatsapp: { active: false, provider: null, setupInstructions: null },
          },
          payments: {
            stripe: {
              baseCurrency: "USD",
              usesStripe: false,
              secretKeyConfigured: false,
              webhookSecretConfigured: false,
              webhookEndpoint: "/api/stripe/webhook",
              warning: false,
              setupInstructions: null,
            },
          },
        });
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: REGISTERED_ENTRIES });
      }
      if (url.includes("/api/admin/notification-templates/") && url.includes("/send-test")) {
        if (opts.sendTestStatus && opts.sendTestStatus >= 400) {
          return jsonResponse({ error: "boom" }, opts.sendTestStatus);
        }
        return jsonResponse(
          opts.sendTestBody ?? {
            ok: true,
            key: REGISTERED_KEYS[0],
            lang: "en",
            channels: [
              { channel: "email", status: "sent" },
              { channel: "push", status: "sent" },
            ],
          },
        );
      }
      if (url.includes("/api/admin/notification-templates/") && url.includes("/preview")) {
        const m = url.match(/[?&]lang=([^&]+)/);
        const lang = m ? decodeURIComponent(m[1]) : "en";
        return jsonResponse(previewBody(lang));
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: null, email: null },
          defaults: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: 0, fallbackEmail: null },
        });
      }
      if (url.endsWith("/api/admin/wellness-sweep-status")) return jsonResponse({ lastSweep: null });
      if (url.startsWith("/api/admin/wellness-sweep-history")) return jsonResponse({ runs: [] });
      if (url.startsWith("/api/admin/")) return jsonResponse({ error: "not relevant" }, 404);
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

async function switchToChannelsSection() {
  const buttons = await screen.findAllByRole("button");
  const channelsButton = buttons.find(b => /channel/i.test(b.textContent ?? ""));
  if (!channelsButton) throw new Error("Could not find a channels-section sidebar button");
  fireEvent.click(channelsButton);
}

beforeEach(() => {
  toastMock.mockClear();
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  if (!('hasPointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!('releasePointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Send test to me action (Task #2023)", () => {
  it("renders the Send test button in the dialog footer and POSTs to the send-test endpoint with the current language", async () => {
    installFetch();
    renderPage();
    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);

    // Wait for the preview to load so the Send test button enables.
    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain("Handicap updated");
    });

    const sendBtn = await screen.findByTestId("button-preview-send-test");
    expect(sendBtn).toBeInTheDocument();
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendBtn);

    await waitFor(() => {
      const idx = fetchedUrls.findIndex(u =>
        u.includes(`/api/admin/notification-templates/${encodeURIComponent(REGISTERED_KEYS[0])}/send-test`)
        && u.includes("lang=en"),
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      // The send must use POST — never GET — so it can't be triggered
      // by accidental link prefetching or browser history navigation.
      expect((fetchedInits[idx]?.method ?? "GET").toUpperCase()).toBe("POST");
    });

    // Success toast names the channels that delivered so the admin can
    // tell at a glance which channels actually fired.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastCall = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(lastCall.title).toMatch(/dispatched/i);
    expect(lastCall.description).toMatch(/email/);
    expect(lastCall.description).toMatch(/push/);
  });

  it("surfaces a destructive toast when one or more channels failed", async () => {
    installFetch({
      sendTestBody: {
        ok: true,
        key: REGISTERED_KEYS[0],
        lang: "en",
        channels: [
          { channel: "email", status: "sent" },
          { channel: "push", status: "failed", reason: "push_provider_failed" },
        ],
      },
    });
    renderPage();
    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain("Handicap updated");
    });

    fireEvent.click(await screen.findByTestId("button-preview-send-test"));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastCall = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(lastCall.variant).toBe("destructive");
    expect(lastCall.title).toMatch(/failures/i);
    expect(lastCall.description).toMatch(/Failed: push/);
    expect(lastCall.description).toMatch(/Delivered: email/);
  });

  it("shows a destructive toast when the server returns a non-2xx response", async () => {
    installFetch({ sendTestStatus: 500 });
    renderPage();
    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);
    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain("Handicap updated");
    });

    fireEvent.click(await screen.findByTestId("button-preview-send-test"));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastCall = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title: string;
      variant?: string;
    };
    expect(lastCall.variant).toBe("destructive");
    expect(lastCall.title).toMatch(/failed/i);
  });
});
