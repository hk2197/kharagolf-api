/**
 * Component test: /admin/analytics page (Task #1141 — adds coverage to Task #982).
 *
 * Mounts <AdminAnalyticsPage /> with mocked auth + active-org context and a
 * mocked fetch, and asserts:
 *
 *   1. The page issues the summary fetch with the active org's id and the
 *      default 5 instrumented event names, then renders the totals tiles
 *      with the values from that response.
 *   2. Toggling an event-name filter checkbox re-issues the summary fetch
 *      with a narrowed `events=...` query string.
 *   3. The "Raw Events" tab is HIDDEN for non-super-admin roles (org_admin)
 *      and the raw endpoint is NEVER called for them — guards against the
 *      raw-rows surface accidentally leaking to club admins.
 *   4. The "Raw Events" tab is VISIBLE for super-admin and the raw endpoint
 *      IS called.
 *
 * Task #1571 — extends the suite to cover the Customize tab (Task #1318):
 *   5. Opening edit mode on a row reveals the inputs.
 *   6. Saving a display name + color issues PUT /events/metadata/:eventName
 *      with the trimmed payload, the events/names cache invalidates, and
 *      the totals tile re-renders with the new friendly label.
 *   7. A non-hex color shows an inline error and never fires the PUT.
 *   8. Resetting a customized row issues DELETE /events/metadata/:eventName
 *      and the totals tile reverts to the raw event name after the cache
 *      refresh.
 *
 * Regression guard: a typo in the events query param, the role check, the
 * tab-visibility wiring, or the cache-invalidation key would fail this test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ORG_ID = 4242;

// Mocks must be hoisted (vi.mock is hoisted automatically). The role is
// driven by a mutable variable so individual tests can flip it.
let currentRole: "org_admin" | "super_admin" = "org_admin";
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, role: currentRole, organizationId: ORG_ID },
    isLoading: false,
  }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => ORG_ID,
}));

// Recharts uses ResponsiveContainer which needs a layout — tests run in jsdom
// without real layout, so stub it out to avoid noisy `width(0) and height(0)`
// warnings cluttering the test output.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="recharts-responsive">{children}</div>,
  };
});

import AdminAnalyticsPage from "../admin-analytics";

const SUMMARY_DEFAULT = {
  from: "2026-03-15T00:00:00.000Z",
  to: "2026-04-15T00:00:00.000Z",
  events: [
    "player_login",
    "tournament_registration",
    "tee_booking_created",
    "scorecard_submitted",
    "payment_settled",
  ],
  totals: {
    player_login: 17,
    tournament_registration: 4,
    tee_booking_created: 9,
    scorecard_submitted: 6,
    payment_settled: 3,
  },
  series: [
    { day: "2026-04-10", player_login: 5, tournament_registration: 1, tee_booking_created: 2, scorecard_submitted: 0, payment_settled: 1 },
    { day: "2026-04-11", player_login: 12, tournament_registration: 3, tee_booking_created: 7, scorecard_submitted: 6, payment_settled: 2 },
  ],
};

const SUMMARY_FILTERED = {
  ...SUMMARY_DEFAULT,
  events: ["player_login"],
  totals: { player_login: 17 },
};

const RAW_EMPTY = {
  from: SUMMARY_DEFAULT.from,
  to: SUMMARY_DEFAULT.to,
  events: [],
  total: 0,
  limit: 100,
  offset: 0,
  rows: [],
};

// Backing store for the metadata mock — lets the PUT/DELETE handlers and
// the GET /events/names handler share state so cache-invalidation flows
// can be observed end-to-end.
type MetaRow = {
  displayName: string | null;
  description: string | null;
  color: string | null;
};
let metadataStore: Record<string, MetaRow> = {};

const NAMES_EVENTS = [
  "player_login",
  "tournament_registration",
  "tee_booking_created",
  "scorecard_submitted",
  "payment_settled",
];

let fetchMock: ReturnType<typeof vi.fn>;

function renderPage() {
  // The page uses useQuery from @tanstack/react-query, so wrap in a fresh
  // client to isolate state between tests.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminAnalyticsPage />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  currentRole = "org_admin";
  metadataStore = {};
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Per-event metadata mutations (Task #1318 / #1571). Match BEFORE the
    // less-specific /events/metadata listing so the param doesn't get
    // swallowed.
    const metaItem = url.match(/\/analytics\/events\/metadata\/([^?]+)/);
    if (metaItem) {
      const eventName = decodeURIComponent(metaItem[1]);
      if (method === "PUT") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as Partial<MetaRow>;
        const row: MetaRow = {
          displayName: payload.displayName ?? null,
          description: payload.description ?? null,
          color: payload.color ?? null,
        };
        metadataStore[eventName] = row;
        return jsonResponse({
          metadata: { eventName, ...row, updatedAt: new Date().toISOString() },
        });
      }
      if (method === "DELETE") {
        delete metadataStore[eventName];
        return jsonResponse({ ok: true });
      }
    }

    if (url.includes("/analytics/events/names")) {
      // Reflect the current metadata store so cache-invalidation refreshes
      // pick up the post-save / post-reset state.
      return jsonResponse({
        events: NAMES_EVENTS,
        metadata: { ...metadataStore },
        lookbackDays: 90,
      });
    }
    if (url.includes("/analytics/events/summary")) {
      // The events= param drives which canned response we return so the
      // narrowing assertion below can verify the request actually changed.
      const m = url.match(/[?&]events=([^&]*)/);
      const eventsParam = m ? decodeURIComponent(m[1]) : "";
      const onlyPlayerLogin = eventsParam === "player_login";
      return jsonResponse(onlyPlayerLogin ? SUMMARY_FILTERED : SUMMARY_DEFAULT);
    }
    if (url.includes("/analytics/events/raw")) {
      return jsonResponse(RAW_EMPTY);
    }
    return new Response("{}", { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function summaryCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/analytics/events/summary"));
}

function rawCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/analytics/events/raw"));
}

describe("AdminAnalyticsPage", () => {
  it("loads totals for the active org with the default 5 instrumented events", async () => {
    renderPage();

    // Wait for the totals tiles to populate from the summary fetch.
    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });
    expect(screen.getByTestId("total-tournament_registration")).toHaveTextContent("4");
    expect(screen.getByTestId("total-tee_booking_created")).toHaveTextContent("9");
    expect(screen.getByTestId("total-scorecard_submitted")).toHaveTextContent("6");
    expect(screen.getByTestId("total-payment_settled")).toHaveTextContent("3");

    // The summary URL should target the active org and request all 5
    // instrumented events as a comma-separated list.
    const calls = summaryCalls();
    expect(calls.length).toBeGreaterThan(0);
    const url = calls[calls.length - 1];
    expect(url).toContain(`/api/organizations/${ORG_ID}/analytics/events/summary`);
    expect(decodeURIComponent(url)).toContain(
      "events=player_login,tournament_registration,tee_booking_created,scorecard_submitted,payment_settled",
    );
  });

  it("re-issues the summary fetch with a narrowed events filter when a checkbox is toggled off", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });

    const callsBefore = summaryCalls().length;

    // Untick four of five — only `player_login` remains selected.
    for (const evt of [
      "tournament_registration",
      "tee_booking_created",
      "scorecard_submitted",
      "payment_settled",
    ]) {
      await user.click(screen.getByTestId(`checkbox-event-${evt}`));
    }

    // Wait for the narrowed request to fire.
    await waitFor(() => {
      const calls = summaryCalls();
      expect(calls.length).toBeGreaterThan(callsBefore);
      const last = decodeURIComponent(calls[calls.length - 1]);
      expect(last).toContain("events=player_login");
      // The narrowed URL must NOT include any other event name.
      expect(last).not.toContain("tournament_registration");
      expect(last).not.toContain("payment_settled");
    });

    // The totals grid only iterates over the still-selected events, so the
    // tiles for the unticked events are removed from the DOM entirely.
    await waitFor(() => {
      expect(screen.queryByTestId("total-payment_settled")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("total-tournament_registration")).not.toBeInTheDocument();
    expect(screen.queryByTestId("total-tee_booking_created")).not.toBeInTheDocument();
    expect(screen.queryByTestId("total-scorecard_submitted")).not.toBeInTheDocument();

    // The still-selected `player_login` tile remains and continues to
    // reflect the (narrowed) response total.
    expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
  });

  it("hides the Raw Events tab from non-super-admins and never calls /events/raw for them", async () => {
    currentRole = "org_admin";
    renderPage();

    // Trends tab is the default and should be present for everyone.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /trends/i })).toBeInTheDocument();
    });

    // The "Raw Events" tab trigger must NOT render for org_admin.
    expect(screen.queryByRole("tab", { name: /raw events/i })).not.toBeInTheDocument();

    // Give react-query a chance to fire any mistaken raw call before we
    // assert it never happened.
    await new Promise((r) => setTimeout(r, 50));
    expect(rawCalls().length).toBe(0);
  });

  // Task #1563 — when the API returns a per-channel breakdown for
  // notification_opened the dashboard must render it as TWO separate tiles
  // (push + in-app) instead of one combined tile so admins can tell whether
  // a spike came from native push or in-app card opens. The combined total
  // = push + in-app must always reconcile.
  it("splits notification_opened into push vs in-app tiles when the API returns a breakdown", async () => {
    // Re-wire fetch to return a summary that includes notification_opened
    // and the new breakdown payload. We also widen the events list returned
    // by /events/names so the page selects notification_opened by default.
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/analytics/events/names")) {
        return new Response(JSON.stringify({
          events: ["player_login", "notification_opened"],
          metadata: {},
          lookbackDays: 90,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/analytics/events/summary")) {
        return new Response(JSON.stringify({
          from: SUMMARY_DEFAULT.from,
          to: SUMMARY_DEFAULT.to,
          events: ["player_login", "notification_opened"],
          totals: { player_login: 17, notification_opened: 8 },
          series: [
            { day: "2026-04-10", player_login: 5, notification_opened: 3 },
            { day: "2026-04-11", player_login: 12, notification_opened: 5 },
          ],
          breakdowns: {
            notification_opened: {
              totals: { push: 6, in_app: 2 },
              series: [
                { day: "2026-04-10", push: 2, in_app: 1 },
                { day: "2026-04-11", push: 4, in_app: 1 },
              ],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/analytics/events/raw")) {
        return new Response(JSON.stringify(RAW_EMPTY), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderPage();

    // `notification_opened` is in FALLBACK_EVENTS so the breakdown tiles
    // appear on the very first summary response — no toggling required.
    await waitFor(() => {
      expect(screen.getByTestId("total-notification_opened__push")).toHaveTextContent("6");
    });
    expect(screen.getByTestId("total-notification_opened__in_app")).toHaveTextContent("2");

    // The combined tile must NOT render alongside the split — admins would
    // otherwise double-count by adding push + in-app to the combined total.
    expect(screen.queryByTestId("total-notification_opened")).not.toBeInTheDocument();

    // Tile labels make the channel obvious to a non-technical admin.
    expect(screen.getByTestId("tile-label-notification_opened__push"))
      .toHaveTextContent(/push/i);
    expect(screen.getByTestId("tile-label-notification_opened__in_app"))
      .toHaveTextContent(/in-app/i);

    // Reconciliation invariant — push + in-app == combined total surfaced
    // by the API. Catches a future regression where the breakdown query
    // drifts from the totals query.
    const push = parseInt(screen.getByTestId("total-notification_opened__push").textContent ?? "0", 10);
    const inApp = parseInt(screen.getByTestId("total-notification_opened__in_app").textContent ?? "0", 10);
    expect(push + inApp).toBe(8);

    // Other event tiles are unaffected by the breakdown — player_login
    // still renders as a single tile.
    expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
  });

  it("shows the Raw Events tab for super-admins and fires the raw fetch", async () => {
    currentRole = "super_admin";
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /raw events/i })).toBeInTheDocument();
    });

    // The raw endpoint should be called automatically (enabled by role).
    await waitFor(() => {
      expect(rawCalls().length).toBeGreaterThan(0);
    });
    const url = rawCalls()[0];
    expect(url).toContain(`/api/organizations/${ORG_ID}/analytics/events/raw`);
  });
});

// ─── Customize tab (Task #1571 → covers Task #1318) ──────────────────────

function metadataPutCalls(): Array<{ url: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter((c) => {
      const url = String(c[0]);
      const init = (c[1] ?? {}) as RequestInit;
      return url.includes("/analytics/events/metadata/")
        && (init.method ?? "GET").toUpperCase() === "PUT";
    })
    .map((c) => ({
      url: String(c[0]),
      body: JSON.parse(String((c[1] as RequestInit).body ?? "{}")),
    }));
}

function metadataDeleteCalls(): string[] {
  return fetchMock.mock.calls
    .filter((c) => {
      const url = String(c[0]);
      const init = (c[1] ?? {}) as RequestInit;
      return url.includes("/analytics/events/metadata/")
        && (init.method ?? "GET").toUpperCase() === "DELETE";
    })
    .map((c) => String(c[0]));
}

describe("AdminAnalyticsPage — Customize tab", () => {
  it("opens edit mode on a row when the Edit button is clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    // Wait until the totals tile renders so we know the page is mounted.
    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-player_login"));

    expect(screen.getByTestId("input-display-name-player_login")).toBeInTheDocument();
    expect(screen.getByTestId("input-color-player_login")).toBeInTheDocument();
    expect(screen.getByTestId("button-save-player_login")).toBeInTheDocument();
    expect(screen.getByTestId("button-cancel-player_login")).toBeInTheDocument();
  });

  it("saves a display name + color, fires PUT, and re-renders the totals tile", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });
    // Before any save the tile shows the raw event name.
    expect(screen.getByTestId("tile-label-player_login")).toHaveTextContent("player_login");

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-player_login"));

    await user.type(
      screen.getByTestId("input-display-name-player_login"),
      "Player Sign-In",
    );
    await user.type(screen.getByTestId("input-color-player_login"), "#3b82f6");
    await user.click(screen.getByTestId("button-save-player_login"));

    // PUT issued to the right URL with the trimmed payload.
    await waitFor(() => {
      const puts = metadataPutCalls();
      expect(puts.length).toBeGreaterThan(0);
      const last = puts[puts.length - 1];
      expect(last.url).toContain(
        `/api/organizations/${ORG_ID}/analytics/events/metadata/player_login`,
      );
      expect(last.body).toEqual({
        displayName: "Player Sign-In",
        description: null,
        color: "#3b82f6",
        category: null,
      });
    });

    // Cache invalidates → /events/names refetches → totals tile re-renders
    // with the new friendly label.
    await waitFor(() => {
      expect(screen.getByTestId("tile-label-player_login")).toHaveTextContent("Player Sign-In");
    });
  });

  it("shows an inline error and never fires PUT when the color is not a hex code", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-tee_booking_created"));

    await user.type(screen.getByTestId("input-color-tee_booking_created"), "red");
    await user.click(screen.getByTestId("button-save-tee_booking_created"));

    const err = await screen.findByTestId("error-tee_booking_created");
    expect(err.textContent ?? "").toMatch(/hex/i);

    // No PUT should have fired for the bad input.
    expect(metadataPutCalls()).toEqual([]);
  });

  it("cancels edit mode without firing PUT or losing the original metadata", async () => {
    const user = userEvent.setup();
    metadataStore = {
      tournament_registration: {
        displayName: "Tournament Sign-Up",
        description: null,
        color: "#a855f7",
      },
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("tile-label-tournament_registration"))
        .toHaveTextContent("Tournament Sign-Up");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-tournament_registration"));

    // Type something destructive then cancel — the edit must NOT persist.
    await user.clear(screen.getByTestId("input-display-name-tournament_registration"));
    await user.type(
      screen.getByTestId("input-display-name-tournament_registration"),
      "Throwaway",
    );
    await user.click(screen.getByTestId("button-cancel-tournament_registration"));

    // Edit-mode inputs are gone.
    expect(
      screen.queryByTestId("input-display-name-tournament_registration"),
    ).not.toBeInTheDocument();

    // No PUT should have fired for this row.
    const puts = metadataPutCalls()
      .filter((p) => p.url.includes("tournament_registration"));
    expect(puts).toEqual([]);

    // Totals tile still shows the original (unmodified) friendly label.
    expect(screen.getByTestId("tile-label-tournament_registration"))
      .toHaveTextContent("Tournament Sign-Up");
  });

  // Task #1950 — chart colors must be unique per org so the trends chart
  // and totals tiles never share a swatch. The Customize panel must surface
  // a clear inline warning ("This color is already used by <name>") and
  // must NOT fire the PUT when the admin tries to reuse a color another
  // event already owns. Server enforces the same rule for defense in depth;
  // this test pins the panel-side guard.
  it("blocks saving a color another event already uses and shows an inline warning naming that event", async () => {
    const user = userEvent.setup();
    // Pre-seed metadata so player_login already owns #3b82f6 with a
    // friendly label. The mock /events/names handler reflects this store
    // back to the panel.
    metadataStore = {
      player_login: {
        displayName: "Player Sign-In",
        description: null,
        color: "#3b82f6",
      },
    };

    renderPage();

    // Wait until the seeded friendly label has propagated into the totals
    // tile so we know the metadata store is loaded into the panel.
    await waitFor(() => {
      expect(screen.getByTestId("tile-label-player_login"))
        .toHaveTextContent("Player Sign-In");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-tee_booking_created"));

    // Try to save tee_booking_created with the SAME color — panel should
    // block, name the conflicting event by its display name, and never
    // hit the network.
    await user.type(
      screen.getByTestId("input-color-tee_booking_created"),
      "#3b82f6",
    );
    await user.click(screen.getByTestId("button-save-tee_booking_created"));

    const err = await screen.findByTestId("error-tee_booking_created");
    expect(err.textContent ?? "").toMatch(/already used/i);
    expect(err.textContent ?? "").toContain("Player Sign-In");

    // No PUT should have fired for the duplicate color.
    expect(metadataPutCalls()).toEqual([]);
  });

  it("uses the raw event name in the duplicate-color warning when the conflicting row has no display name", async () => {
    const user = userEvent.setup();
    metadataStore = {
      player_login: { displayName: null, description: null, color: "#22c55e" },
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("total-player_login")).toHaveTextContent("17");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-scorecard_submitted"));
    await user.type(
      screen.getByTestId("input-color-scorecard_submitted"),
      "#22c55e",
    );
    await user.click(screen.getByTestId("button-save-scorecard_submitted"));

    const err = await screen.findByTestId("error-scorecard_submitted");
    // No friendly label on the seeded row → fallback to the raw event name.
    expect(err.textContent ?? "").toContain("player_login");
    expect(metadataPutCalls()).toEqual([]);
  });

  it("treats the duplicate-color check as case-insensitive (#3B82F6 conflicts with #3b82f6)", async () => {
    const user = userEvent.setup();
    metadataStore = {
      player_login: {
        displayName: "Player Sign-In",
        description: null,
        color: "#3b82f6",
      },
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("tile-label-player_login"))
        .toHaveTextContent("Player Sign-In");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-payment_settled"));
    await user.type(
      screen.getByTestId("input-color-payment_settled"),
      "#3B82F6",
    );
    await user.click(screen.getByTestId("button-save-payment_settled"));

    const err = await screen.findByTestId("error-payment_settled");
    expect(err.textContent ?? "").toMatch(/already used/i);
    expect(metadataPutCalls()).toEqual([]);
  });

  it("allows re-saving the same color on the same event (no spurious self-conflict)", async () => {
    const user = userEvent.setup();
    metadataStore = {
      player_login: {
        displayName: "Player Sign-In",
        description: null,
        color: "#3b82f6",
      },
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("tile-label-player_login"))
        .toHaveTextContent("Player Sign-In");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-edit-player_login"));
    // Re-save the SAME color the row already owns — must not be flagged
    // as a conflict against itself.
    await user.click(screen.getByTestId("button-save-player_login"));

    await waitFor(() => {
      const puts = metadataPutCalls()
        .filter((p) => p.url.includes("/metadata/player_login"));
      expect(puts.length).toBeGreaterThan(0);
      expect(puts[puts.length - 1].body).toMatchObject({ color: "#3b82f6" });
    });
    // The error slot must never have rendered for this save.
    expect(screen.queryByTestId("error-player_login")).not.toBeInTheDocument();
  });

  it("resets a customized event via DELETE and the totals tile reverts to the raw name", async () => {
    const user = userEvent.setup();
    // Pre-seed metadata so the row shows up as customized on first render
    // and the Reset button is available.
    metadataStore = {
      payment_settled: {
        displayName: "Settled Payments",
        description: null,
        color: "#ef4444",
      },
    };

    renderPage();

    // The totals tile should already use the friendly label from the seed.
    await waitFor(() => {
      expect(screen.getByTestId("tile-label-payment_settled")).toHaveTextContent("Settled Payments");
    });

    await user.click(screen.getByRole("tab", { name: /customize/i }));
    await user.click(screen.getByTestId("button-reset-payment_settled"));

    // DELETE issued to the right URL.
    await waitFor(() => {
      const dels = metadataDeleteCalls();
      expect(dels.length).toBeGreaterThan(0);
      expect(dels[dels.length - 1]).toContain(
        `/api/organizations/${ORG_ID}/analytics/events/metadata/payment_settled`,
      );
    });

    // After cache invalidation the tile falls back to the raw event name.
    await waitFor(() => {
      expect(screen.getByTestId("tile-label-payment_settled")).toHaveTextContent("payment_settled");
    });
  });
});
