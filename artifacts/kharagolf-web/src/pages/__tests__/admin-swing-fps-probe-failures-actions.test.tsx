/**
 * Task #2126 — Cover the admin "Swing-video frame-rate probe failures" panel
 * (Task #1705) with end-to-end UI tests. The server endpoints are unit-tested
 * elsewhere; this file pins down the React UI:
 *
 *   1. The "All clear" empty state renders when the API returns
 *      `{ failures: [], failureCount: 0 }`.
 *   2. Clicking "Re-enqueue" POSTs to
 *      `/api/admin/swing-fps-probe-failures/:id/reenqueue`, fires a success
 *      toast and refetches the list.
 *   3. Clicking "Dismiss" POSTs to the dismiss endpoint, fires a success
 *      toast and the refetch removes the row from the UI.
 *   4. A failed POST surfaces a destructive error toast and leaves the row
 *      in place (no optimistic removal).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
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

const STRIPE_OK = {
  baseCurrency: "USD",
  usesStripe: true,
  secretKeyConfigured: true,
  webhookSecretConfigured: true,
  webhookEndpoint: "/api/stripe/webhook",
  warning: false,
  setupInstructions: null,
};

type ProbeFailure = {
  id: number;
  swingVideoId: number;
  objectPath: string;
  attempts: number;
  errorMessage: string | null;
  errorMessagePreview: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

// Mutable so individual tests can prepare GET responses and the simulated
// "after the action ran" refetch state.
let currentFailures: ProbeFailure[] = [];
// Per-id behaviour for POST handlers (reenqueue/dismiss). Default: succeed.
const postBehaviour = new Map<string, { ok: boolean; status?: number; body?: unknown }>();
// Captured POST requests so the tests can assert which endpoints were called.
const postRequests: { url: string; method: string }[] = [];

function makeFailure(id: number, swingVideoId: number, errPreview: string): ProbeFailure {
  return {
    id,
    swingVideoId,
    objectPath: `swings/${swingVideoId}.mp4`,
    attempts: 5,
    errorMessage: `${errPreview} (full)`,
    errorMessagePreview: errPreview,
    completedAt: "2026-04-29T12:00:00.000Z",
    updatedAt: "2026-04-29T12:00:00.000Z",
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      // Probe-failure action endpoints (the focus of this test file).
      const actionMatch = url.match(/\/api\/admin\/swing-fps-probe-failures\/(\d+)\/(reenqueue|dismiss)$/);
      if (actionMatch && method === "POST") {
        postRequests.push({ url, method });
        const key = `${actionMatch[2]}:${actionMatch[1]}`;
        const beh = postBehaviour.get(key) ?? { ok: true };
        if (!beh.ok) {
          return jsonResponse(beh.body ?? { error: "boom" }, beh.status ?? 500);
        }
        return jsonResponse({ ok: true });
      }
      // Probe-failures list endpoint — what the panel polls.
      if (url.endsWith("/api/admin/swing-fps-probe-failures")) {
        return jsonResponse({
          failures: currentFailures,
          failureCount: currentFailures.length,
        });
      }

      // Everything below is just the supporting data the admin page fetches
      // when the "Comm Channels" section mounts. None of it is the subject
      // of this test, but the panel is rendered alongside it so we have to
      // keep these endpoints from blowing up the page.
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
          payments: { stripe: STRIPE_OK },
        });
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: {
            minCount: 0,
            minSharePct: 0,
            minAttempted: 0,
            wowMinDelta: null,
            email: null,
          },
          defaults: {
            minCount: 0,
            minSharePct: 0,
            minAttempted: 0,
            wowMinDelta: 0,
            fallbackEmail: null,
          },
        });
      }
      if (url.includes("/api/admin/stripe-webhook-deliveries")) {
        return jsonResponse({ deliveries: [] });
      }
      if (url.endsWith("/api/admin/stripe-webhook-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      if (url.includes("/api/admin/stripe-webhook-sweep-history")) {
        return jsonResponse({ days: 14, runs: [] });
      }
      if (url.endsWith("/api/admin/wellness-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      if (url.includes("/api/admin/wellness-sweep-history")) {
        return jsonResponse({ days: 30, runs: [] });
      }
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift")) {
        return jsonResponse(null);
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: [] });
      }
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

// The probe-failures panel lives inside the "Comm Channels" section, which
// isn't the default tab. Click into it so the panel mounts.
async function openChannelsTab() {
  const user = userEvent.setup();
  const navBtn = await screen.findByRole("button", { name: /comm channels/i });
  await act(async () => {
    await user.click(navBtn);
  });
  return user;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin");
  currentFailures = [];
  postBehaviour.clear();
  postRequests.length = 0;
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Swing-video fps probe-failures panel actions (Task #2126)", () => {
  it("renders the 'All clear' empty state when the API returns no failures", async () => {
    currentFailures = [];
    renderPage();
    await openChannelsTab();

    // The All-clear badge and the explanatory empty-state copy should both
    // appear once the GET resolves.
    const badge = await screen.findByTestId("badge-swing-fps-probe-failures-count");
    expect(badge.textContent).toMatch(/all clear/i);

    const emptyText = await screen.findByTestId("text-swing-fps-probe-failures-empty");
    expect(emptyText.textContent ?? "").toMatch(/no failed fps probes/i);

    // No row buttons should be in the tree at all when there are zero failures.
    expect(screen.queryByTestId(/^button-swing-fps-probe-failure-reenqueue-/)).toBeNull();
    expect(screen.queryByTestId(/^button-swing-fps-probe-failure-dismiss-/)).toBeNull();
  });

  it("re-enqueues a failure, fires a success toast and refetches the list", async () => {
    currentFailures = [makeFailure(101, 555, "ffprobe: signal SIGSEGV")];
    renderPage();
    const user = await openChannelsTab();

    // The row and its action buttons mount once the GET resolves.
    await screen.findByTestId("row-swing-fps-probe-failure-101");
    const badge = await screen.findByTestId("badge-swing-fps-probe-failures-count");
    expect(badge.textContent).toMatch(/1.*failed/i);

    // Simulate the worker picking the row up after the re-enqueue: the next
    // refetch returns an empty list. This proves the click triggered a
    // refetch (vs. only an optimistic local update).
    currentFailures = [];

    const reenqueueBtn = screen.getByTestId("button-swing-fps-probe-failure-reenqueue-101");
    await act(async () => {
      await user.click(reenqueueBtn);
    });

    // The exact endpoint specified by the task description is called.
    await waitFor(() => {
      expect(
        postRequests.some(
          (r) =>
            r.method === "POST" &&
            r.url.endsWith("/api/admin/swing-fps-probe-failures/101/reenqueue"),
        ),
      ).toBe(true);
    });

    // Success toast fires with the "Probe re-enqueued" copy.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastToast = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title?: string;
      variant?: string;
    };
    expect(lastToast.title).toMatch(/re-enqueued/i);
    expect(lastToast.variant).not.toBe("destructive");

    // The refetch picks up the now-empty list and the row disappears, the
    // panel flips to the All-clear badge.
    await waitFor(() => {
      expect(screen.queryByTestId("row-swing-fps-probe-failure-101")).toBeNull();
    });
    expect(
      (await screen.findByTestId("badge-swing-fps-probe-failures-count")).textContent,
    ).toMatch(/all clear/i);
  });

  it("dismisses a failure, fires a success toast and removes the row", async () => {
    currentFailures = [
      makeFailure(202, 777, "object missing in storage"),
      makeFailure(203, 778, "decode error: moov atom missing"),
    ];
    renderPage();
    const user = await openChannelsTab();

    await screen.findByTestId("row-swing-fps-probe-failure-202");
    await screen.findByTestId("row-swing-fps-probe-failure-203");
    expect(
      (await screen.findByTestId("badge-swing-fps-probe-failures-count")).textContent,
    ).toMatch(/2.*failed/i);

    // Simulate the server-side delete — refetch returns only the survivor.
    currentFailures = [makeFailure(203, 778, "decode error: moov atom missing")];

    const dismissBtn = screen.getByTestId("button-swing-fps-probe-failure-dismiss-202");
    await act(async () => {
      await user.click(dismissBtn);
    });

    await waitFor(() => {
      expect(
        postRequests.some(
          (r) =>
            r.method === "POST" &&
            r.url.endsWith("/api/admin/swing-fps-probe-failures/202/dismiss"),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastToast = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title?: string;
      variant?: string;
    };
    expect(lastToast.title).toMatch(/dismissed/i);
    expect(lastToast.variant).not.toBe("destructive");

    // The dismissed row is gone, the other row stays put, and the count
    // badge drops to 1.
    await waitFor(() => {
      expect(screen.queryByTestId("row-swing-fps-probe-failure-202")).toBeNull();
    });
    expect(screen.getByTestId("row-swing-fps-probe-failure-203")).toBeTruthy();
    expect(
      (await screen.findByTestId("badge-swing-fps-probe-failures-count")).textContent,
    ).toMatch(/1.*failed/i);
  });

  it("surfaces a destructive toast on a failed POST and leaves the row in place", async () => {
    currentFailures = [makeFailure(303, 999, "ffprobe: timeout")];
    renderPage();
    const user = await openChannelsTab();

    await screen.findByTestId("row-swing-fps-probe-failure-303");

    // Force the re-enqueue endpoint to fail with the server's standard
    // `{ error: "..." }` envelope so we exercise the error-extraction path.
    postBehaviour.set("reenqueue:303", {
      ok: false,
      status: 500,
      body: { error: "queue is paused" },
    });

    const reenqueueBtn = screen.getByTestId("button-swing-fps-probe-failure-reenqueue-303");
    await act(async () => {
      await user.click(reenqueueBtn);
    });

    // The endpoint was still called.
    await waitFor(() => {
      expect(
        postRequests.some((r) =>
          r.url.endsWith("/api/admin/swing-fps-probe-failures/303/reenqueue"),
        ),
      ).toBe(true);
    });

    // A destructive toast is fired with the server-supplied error message.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const lastToast = toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
      title?: string;
      description?: string;
      variant?: string;
    };
    expect(lastToast.variant).toBe("destructive");
    expect(lastToast.title).toMatch(/re-enqueue failed/i);
    expect(lastToast.description ?? "").toMatch(/queue is paused/i);

    // The row stays in place — no optimistic removal on failure.
    expect(screen.getByTestId("row-swing-fps-probe-failure-303")).toBeTruthy();
    expect(
      (await screen.findByTestId("badge-swing-fps-probe-failures-count")).textContent,
    ).toMatch(/1.*failed/i);
  });
});
