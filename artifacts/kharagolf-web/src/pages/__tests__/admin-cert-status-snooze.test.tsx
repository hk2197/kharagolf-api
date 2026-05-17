/**
 * Task #1261 — UI tests for the HTTPS re-nudge snooze controls in the
 * admin custom-domain panel (admin.tsx → CustomDomainCertStatus).
 *
 * The Cert Status card is the only place admins can act on the snooze
 * surface. These tests pin down its three states:
 *
 *   - Failed cert with no snooze → "Snooze re-nudge for 14 days" button
 *     visible alongside the next-renudge ETA line, posts to
 *     POST /custom-domain/snooze-renudge with no body, swaps to the
 *     snoozed state on success.
 *   - Failed cert with an active snooze → "Re-nudge snoozed until …"
 *     line visible, "Cancel snooze" button visible, the next-renudge
 *     ETA line is hidden so the panel doesn't contradict itself.
 *     Cancel posts DELETE /custom-domain/snooze-renudge and returns the
 *     panel to the unsnoozed state.
 *   - Healthy cert (status === 'active') → no snooze surface at all
 *     (a snooze on a healthy cert is meaningless and would just confuse).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Task #1481 — Radix Select uses pointer capture and scrollIntoView,
// neither of which jsdom implements, so the dropdown won't open without
// these no-op shims. Local to this file to avoid leaking into other
// tests that don't need them.
beforeAll(() => {
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "hasPointerCapture")) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true, value: () => false,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "releasePointerCapture")) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true, value: () => {},
    });
  }
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "scrollIntoView")) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true, value: () => {},
    });
  }
});

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

interface Org {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  website: string | null;
  defaultLanguage: string | null;
}

interface CertState {
  customDomain: string | null;
  status: "none" | "pending" | "active" | "failed";
  provider: string | null;
  error: string | null;
  requestedAt: string | null;
  issuedAt: string | null;
  checkedAt: string | null;
  notifiedStatus: "active" | "failed" | null;
  notifiedHost: string | null;
  notifiedAt: string | null;
  nextRenudgeAt: string | null;
  renudgeSnoozedUntil: string | null;
}

type FetchCall = { url: string; method: string; body: string | null };

let currentOrg: Org;
let certState: CertState;
let fetchCalls: FetchCall[];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeOrg(overrides: Partial<Org> = {}): Org {
  return {
    id: 42,
    name: "Pine Valley",
    slug: "pinevalley",
    description: null,
    logoUrl: null,
    primaryColor: "#1e4d2b",
    customDomain: "golf.pinevalley.com",
    subscriptionTier: "enterprise",
    isActive: true,
    contactEmail: null,
    contactPhone: null,
    address: null,
    website: null,
    defaultLanguage: "en",
    ...overrides,
  };
}

function makeCertState(overrides: Partial<CertState> = {}): CertState {
  return {
    customDomain: "golf.pinevalley.com",
    status: "failed",
    provider: "letsencrypt",
    error: "Could not provision certificate (DNS lookup failed).",
    requestedAt: "2026-04-20T08:00:00.000Z",
    issuedAt: null,
    checkedAt: "2026-04-24T08:00:00.000Z",
    notifiedStatus: "failed",
    notifiedHost: "golf.pinevalley.com",
    notifiedAt: "2026-04-21T08:00:00.000Z",
    nextRenudgeAt: "2026-04-27T12:00:00.000Z",
    renudgeSnoozedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  toastMock.mockReset();
  // Pin the clock so "snoozed until …" timestamps render deterministically
  // and the snooze-active vs snooze-elapsed branching is stable. Don't
  // fake setTimeout/setInterval — react-query's scheduling needs real
  // timers for waitFor() to converge.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));

  currentOrg = makeOrg();
  certState = makeCertState();
  fetchCalls = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      fetchCalls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : null,
      });

      if (url.endsWith("/api/organizations/42") && method === "GET") {
        return jsonResponse(currentOrg);
      }

      if (url.endsWith("/api/organizations/42/custom-domain/status")
          && method === "GET") {
        return jsonResponse(certState);
      }

      if (url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
          && method === "POST") {
        // Mirror the API: read the chosen `days` value from the request
        // body (default 14 if omitted, matching the server-side default)
        // and write the resulting snooze into our in-memory cert state
        // so the next refetch returns the snoozed shape.
        let days = 14;
        if (typeof init?.body === "string" && init.body.length > 0) {
          try {
            const parsed = JSON.parse(init.body) as { days?: number };
            if (typeof parsed.days === "number") days = parsed.days;
          } catch {
            // fall through with default
          }
        }
        const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        certState = makeCertState({ renudgeSnoozedUntil: until.toISOString() });
        return jsonResponse({ renudgeSnoozedUntil: until.toISOString(), days });
      }

      if (url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
          && method === "DELETE") {
        certState = makeCertState({ ...certState, renudgeSnoozedUntil: null });
        return jsonResponse({ renudgeSnoozedUntil: null });
      }

      // The reachability panel auto-runs a verify on mount; failing it
      // silently keeps the test focused on the cert-status panel.
      if (url.endsWith("/api/organizations/42/marketing-site/verify-domain")) {
        return jsonResponse({ error: "skipped" }, 503);
      }

      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gotoDomainSection() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  const navBtn = await screen.findByRole("button", { name: /custom domain/i });
  fireEvent.click(navBtn);
  await screen.findByRole("button", { name: /save domain/i });
}

describe("admin.tsx — HTTPS re-nudge snooze controls (Task #1261)", () => {
  it("shows the 'Snooze re-nudge for 14 days' button on a failed cert with no snooze", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    const btn = await screen.findByTestId("cert-status-snooze");
    expect(btn).toBeVisible();
    // Task #1481 — chooser defaults to 14 days, so the button label
    // still reads "Snooze re-nudge for 14 days" out of the box.
    expect(btn.textContent).toMatch(/Snooze re-nudge for 14 days/);
    // Without an active snooze, the Cancel/snoozed-until surface must
    // NOT render so admins don't see contradictory state.
    expect(screen.queryByTestId("cert-status-snoozed-until")).toBeNull();
    expect(screen.queryByTestId("cert-status-cancel-snooze")).toBeNull();
  });

  it("posts to /custom-domain/snooze-renudge with the default 14-day window and swaps to the snoozed state on success", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    const btn = await screen.findByTestId("cert-status-snooze");
    fireEvent.click(btn);

    // Wait for the panel to flip into the snoozed shape.
    await screen.findByTestId("cert-status-snoozed-until");

    const snoozeCall = fetchCalls.find(
      (c) =>
        c.url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
        && c.method === "POST",
    );
    expect(snoozeCall).toBeTruthy();
    // Task #1481 — body now carries the chooser's selected `days` value.
    // With no explicit pick the chooser defaults to the platform default
    // (14), so the request matches the previous server-default behaviour.
    expect(JSON.parse(snoozeCall!.body!)).toEqual({ days: 14 });

    // Cancel surface is now visible, snooze-button is gone.
    expect(screen.getByTestId("cert-status-cancel-snooze")).toBeVisible();
    expect(screen.queryByTestId("cert-status-snooze")).toBeNull();
  });

  it("renders 'Re-nudge snoozed until …' and hides the next-renudge ETA when a snooze is active", async () => {
    // Snooze 5 days into the future, comfortably past "now".
    certState = makeCertState({
      renudgeSnoozedUntil: "2026-04-29T12:00:00.000Z",
    });

    await gotoDomainSection();

    const line = await screen.findByTestId("cert-status-snoozed-until");
    expect(line).toBeVisible();
    expect(line.textContent).toMatch(/Re-nudge snoozed until/);

    // The next-renudge ETA line ("Next reminder in X days") is meant to
    // tell admins when the next email will arrive. While snoozed, that
    // line would directly contradict the snoozed-until line above it,
    // so it must not render.
    expect(screen.queryByTestId("cert-status-next-renudge")).toBeNull();
    // Snooze button is gone, replaced by Cancel.
    expect(screen.queryByTestId("cert-status-snooze")).toBeNull();
    expect(screen.getByTestId("cert-status-cancel-snooze")).toBeVisible();
  });

  it("Cancel snooze posts DELETE and returns the panel to the unsnoozed state", async () => {
    certState = makeCertState({
      renudgeSnoozedUntil: "2026-04-29T12:00:00.000Z",
    });

    await gotoDomainSection();

    const cancelBtn = await screen.findByTestId("cert-status-cancel-snooze");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("cert-status-snoozed-until")).toBeNull();
    });

    const cancelCall = fetchCalls.find(
      (c) =>
        c.url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
        && c.method === "DELETE",
    );
    expect(cancelCall).toBeTruthy();

    // Snooze button is back, ETA line is back, Cancel is gone.
    expect(await screen.findByTestId("cert-status-snooze")).toBeVisible();
    expect(screen.getByTestId("cert-status-next-renudge")).toBeVisible();
    expect(screen.queryByTestId("cert-status-cancel-snooze")).toBeNull();
  });

  it("treats a past renudgeSnoozedUntil as expired and shows the Snooze button (not Cancel)", async () => {
    // Server may briefly return a past snooze before the next cron clears
    // it — UI should treat that as no snooze rather than offering Cancel
    // on something the cron will wipe within minutes.
    certState = makeCertState({
      renudgeSnoozedUntil: "2026-04-20T12:00:00.000Z",
    });

    await gotoDomainSection();

    expect(await screen.findByTestId("cert-status-snooze")).toBeVisible();
    expect(screen.queryByTestId("cert-status-snoozed-until")).toBeNull();
    expect(screen.queryByTestId("cert-status-cancel-snooze")).toBeNull();
  });

  // Task #1481 — duration chooser tests
  it("renders the snooze duration chooser with 7 / 14 / 30 / 90 day presets", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    // The label and trigger should be present alongside the snooze button.
    expect(await screen.findByTestId("cert-status-snooze-duration-label"))
      .toBeVisible();
    const trigger = await screen.findByTestId("cert-status-snooze-duration");
    expect(trigger).toBeVisible();
    // Default of 14 days should be reflected in the trigger's text.
    expect(trigger.textContent).toMatch(/14 days/);

    // Open the dropdown so the items are mounted, then assert each
    // preset is offered and rendered with its pluralized label.
    fireEvent.click(trigger);
    const opt7 = await screen.findByTestId("cert-status-snooze-duration-option-7");
    expect(opt7.textContent).toMatch(/^7 days$/);
    expect(screen.getByTestId("cert-status-snooze-duration-option-14").textContent)
      .toMatch(/^14 days$/);
    expect(screen.getByTestId("cert-status-snooze-duration-option-30").textContent)
      .toMatch(/^30 days$/);
    expect(screen.getByTestId("cert-status-snooze-duration-option-90").textContent)
      .toMatch(/^90 days$/);
  });

  it("sends the chooser-selected days value (e.g. 30) when the admin picks a non-default duration", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    // Open the chooser and pick 30 days.
    const trigger = await screen.findByTestId("cert-status-snooze-duration");
    fireEvent.click(trigger);
    const opt30 = await screen.findByTestId("cert-status-snooze-duration-option-30");
    fireEvent.click(opt30);

    // The button label should now reflect the selected duration so the
    // admin sees what they're about to commit to before clicking.
    await waitFor(() => {
      expect(screen.getByTestId("cert-status-snooze").textContent)
        .toMatch(/Snooze re-nudge for 30 days/);
    });

    // Click Snooze and verify the request body carries the picked window.
    fireEvent.click(screen.getByTestId("cert-status-snooze"));
    await screen.findByTestId("cert-status-snoozed-until");

    const snoozeCall = fetchCalls.find(
      (c) =>
        c.url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
        && c.method === "POST",
    );
    expect(snoozeCall).toBeTruthy();
    expect(JSON.parse(snoozeCall!.body!)).toEqual({ days: 30 });
  });

  it("sends days=7 when the admin picks the shortest preset", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    const trigger = await screen.findByTestId("cert-status-snooze-duration");
    fireEvent.click(trigger);
    const opt7 = await screen.findByTestId("cert-status-snooze-duration-option-7");
    fireEvent.click(opt7);

    await waitFor(() => {
      expect(screen.getByTestId("cert-status-snooze").textContent)
        .toMatch(/Snooze re-nudge for 7 days/);
    });

    fireEvent.click(screen.getByTestId("cert-status-snooze"));
    await screen.findByTestId("cert-status-snoozed-until");

    const snoozeCall = fetchCalls.find(
      (c) =>
        c.url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
        && c.method === "POST",
    );
    expect(snoozeCall).toBeTruthy();
    expect(JSON.parse(snoozeCall!.body!)).toEqual({ days: 7 });
  });

  it("sends days=90 (the API's hard cap) when the admin picks the longest preset", async () => {
    certState = makeCertState({ renudgeSnoozedUntil: null });

    await gotoDomainSection();

    const trigger = await screen.findByTestId("cert-status-snooze-duration");
    fireEvent.click(trigger);
    const opt90 = await screen.findByTestId("cert-status-snooze-duration-option-90");
    fireEvent.click(opt90);

    await waitFor(() => {
      expect(screen.getByTestId("cert-status-snooze").textContent)
        .toMatch(/Snooze re-nudge for 90 days/);
    });

    fireEvent.click(screen.getByTestId("cert-status-snooze"));
    await screen.findByTestId("cert-status-snoozed-until");

    const snoozeCall = fetchCalls.find(
      (c) =>
        c.url.endsWith("/api/organizations/42/custom-domain/snooze-renudge")
        && c.method === "POST",
    );
    expect(snoozeCall).toBeTruthy();
    expect(JSON.parse(snoozeCall!.body!)).toEqual({ days: 90 });
  });

  it("does not render the duration chooser when a snooze is already active", async () => {
    // While snoozed, the panel renders the "snoozed until …" line and a
    // Cancel button — the chooser is irrelevant in that state and would
    // just be visual noise next to a Cancel that ignores it.
    certState = makeCertState({
      renudgeSnoozedUntil: "2026-04-29T12:00:00.000Z",
    });

    await gotoDomainSection();

    await screen.findByTestId("cert-status-snoozed-until");
    expect(screen.queryByTestId("cert-status-snooze-duration")).toBeNull();
    expect(screen.queryByTestId("cert-status-snooze-duration-label")).toBeNull();
  });

  it("does not render any snooze surface on a healthy cert (status === 'active')", async () => {
    certState = makeCertState({
      status: "active",
      issuedAt: "2026-04-22T08:00:00.000Z",
      error: null,
      notifiedStatus: "active",
      // Even if the server somehow returned a stale snooze on a healthy
      // cert (it shouldn't — the active path clears it), the UI must
      // not surface controls that would only confuse admins.
      renudgeSnoozedUntil: "2026-04-29T12:00:00.000Z",
    });

    await gotoDomainSection();

    await screen.findByTestId("cert-status-badge-active");
    expect(screen.queryByTestId("cert-status-snooze")).toBeNull();
    expect(screen.queryByTestId("cert-status-cancel-snooze")).toBeNull();
    expect(screen.queryByTestId("cert-status-snoozed-until")).toBeNull();
  });
});
