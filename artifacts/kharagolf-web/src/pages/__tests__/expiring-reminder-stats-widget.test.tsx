/**
 * UI test: dashboard "Export reminder open rate" widget (Task #1531).
 *
 * Mounts <ExpiringReminderStatsWidget /> with a mocked fetch and asserts:
 *   - the headline open rate is rendered as a percentage and the
 *     prefetch count is surfaced alongside it as "(N prefetches hidden)"
 *   - flipping the "Include prefetches" checkbox switches
 *     `?includePrefetches=1` on, refetches, and the displayed numbers
 *     update (open rate inflates, the helper switches to "(incl. N
 *     prefetches)").
 *   - the widget self-hides when the API responds 401/403 (mirroring
 *     the role gate documented in the widget docstring — only
 *     org_admin / super_admin / membership_secretary should see it).
 *
 * The widget uses TanStack Query + fetch directly (no generated client),
 * so we mock global fetch in the same style as levy-totals-widget.test.tsx.
 *
 * Backend-side aggregation, the prefetch-vs-opened distinction, the
 * `includePrefetches` toggle semantics and role gating (401/403 vs.
 * 200 admin) are separately covered against the live PostgreSQL DB by
 * artifacts/api-server/src/tests/member-360-expiring-reminder-stats.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExpiringReminderStatsWidget } from "../dashboard";

interface DailyBucket {
  date: string;
  sent: number;
  opened: number;
  prefetched: number;
  clicked: number;
}
interface StatsResponse {
  windowDays: number;
  since: string;
  sent: number;
  opened: number;
  prefetched: number;
  clicked: number;
  openRate: number | null;
  clickRate: number | null;
  includePrefetches: boolean;
  daily?: DailyBucket[];
}

interface FetchHandler {
  default?: StatsResponse;
  withPrefetches?: StatsResponse;
  // Task #1889 — window-keyed responses so we can assert that flipping
  // the 7d / 30d / 90d selector actually drives a different payload
  // into the headline / stat tiles.
  byDays?: Record<number, StatsResponse>;
  status?: number;
  defaultCalls: number;
  withPrefetchesCalls: number;
  // Records the last `?days=` value the widget asked for so a single
  // assertion can pin down "did the toggle change the request?".
  lastDays: number | null;
  daysSeen: number[];
}

let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/data-requests/expiring-reminder-stats")) {
      const wantPrefetches = url.includes("includePrefetches=1");
      // Count the call regardless of status so the 401/403 self-hide
      // tests can wait on the request actually landing.
      if (wantPrefetches) handler.withPrefetchesCalls += 1;
      else handler.defaultCalls += 1;
      const daysMatch = url.match(/[?&]days=(\d+)/);
      const days = daysMatch ? Number.parseInt(daysMatch[1], 10) : null;
      handler.lastDays = days;
      if (days != null) handler.daysSeen.push(days);
      if (handler.status && handler.status >= 400) {
        return new Response("", { status: handler.status }) as unknown as Response;
      }
      // Window-specific payload wins over the legacy `default` /
      // `withPrefetches` fallbacks so existing tests keep working.
      const windowed = days != null ? handler.byDays?.[days] : undefined;
      if (windowed) {
        return new Response(JSON.stringify(windowed), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as unknown as Response;
      }
      if (wantPrefetches) {
        const body = handler.withPrefetches ?? {
          windowDays: days ?? 30,
          since: new Date().toISOString(),
          sent: 0, opened: 0, prefetched: 0, clicked: 0,
          openRate: null, clickRate: null,
          includePrefetches: true,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as unknown as Response;
      }
      handler.defaultCalls += 1;
      const body = handler.default ?? {
        windowDays: days ?? 30,
        since: new Date().toISOString(),
        sent: 0, opened: 0, prefetched: 0, clicked: 0,
        openRate: null, clickRate: null,
        includePrefetches: false,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget(orgId = 42) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ExpiringReminderStatsWidget orgId={orgId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = { defaultCalls: 0, withPrefetchesCalls: 0, lastDays: null, daysSeen: [] };
  // Reset the per-session window memory between tests so a leftover
  // "90d" doesn't bleed into the next render and break assumptions
  // about the default window.
  try { window.sessionStorage.clear(); } catch { /* private mode */ }
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try { window.sessionStorage.clear(); } catch { /* private mode */ }
});

describe("<ExpiringReminderStatsWidget />", () => {
  it("renders open rate and surfaces the suppressed prefetch count", async () => {
    // Mirrors the prefetch test seed in
    // artifacts/api-server/src/tests/member-360-expiring-reminder-stats.test.ts:
    // 4 sent, 1 real human open, 47 prefetches suppressed, 1 click.
    handler.default = {
      windowDays: 30,
      since: new Date().toISOString(),
      sent: 400,
      opened: 48,
      prefetched: 47,
      clicked: 12,
      openRate: 0.12,
      clickRate: 0.03,
      includePrefetches: false,
    };

    renderWidget();

    // Headline open rate is the *non-prefetched* rate (12.0%).
    const rate = await screen.findByTestId("expiring-reminder-open-rate");
    expect(rate).toHaveTextContent("12.0%");

    // The "(47 prefetches hidden)" annotation is the whole point of the
    // widget — admins must see how many opens were filtered out.
    const hidden = await screen.findByTestId("expiring-reminder-prefetches-hidden");
    expect(hidden).toHaveTextContent(/47/);
    expect(hidden).toHaveTextContent(/prefetches hidden/i);

    // Underlying numbers also surface in the stat tiles.
    expect(screen.getByTestId("expiring-reminder-stat-sent")).toHaveTextContent(/400/);
    expect(screen.getByTestId("expiring-reminder-stat-opened")).toHaveTextContent(/48/);
    expect(screen.getByTestId("expiring-reminder-stat-clicked")).toHaveTextContent(/12/);
    expect(screen.getByTestId("expiring-reminder-stat-prefetched")).toHaveTextContent(/47/);

    // The widget hits the endpoint with the correct org id and *without*
    // includePrefetches by default.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const defaultHit = calls.find(([input]) =>
      String(input).includes("/organizations/42/members-360/data-requests/expiring-reminder-stats"));
    expect(defaultHit).toBeDefined();
    expect(String(defaultHit?.[0])).not.toContain("includePrefetches=1");
  });

  it("flipping the checkbox folds prefetches back in and refetches", async () => {
    handler.default = {
      windowDays: 30,
      since: new Date().toISOString(),
      sent: 400,
      opened: 48,
      prefetched: 47,
      clicked: 12,
      openRate: 0.12,
      clickRate: 0.03,
      includePrefetches: false,
    };
    handler.withPrefetches = {
      windowDays: 30,
      since: new Date().toISOString(),
      sent: 400,
      // 48 real opens + 47 prefetches folded back in.
      opened: 95,
      prefetched: 47,
      clicked: 12,
      openRate: 0.2375,
      clickRate: 0.03,
      includePrefetches: true,
    };

    renderWidget();

    // Default render — non-prefetched rate.
    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("12.0%"));
    expect(screen.getByTestId("expiring-reminder-prefetches-hidden")).toBeInTheDocument();

    // Toggle the checkbox on.
    const toggle = screen.getByTestId("expiring-reminder-include-prefetches");
    fireEvent.click(toggle);

    // Endpoint is re-hit with includePrefetches=1 and the new numbers
    // replace the headline.
    await waitFor(() => expect(handler.withPrefetchesCalls).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("23.8%"));
    // The "(N prefetches hidden)" helper switches to "(incl. N prefetches)".
    expect(screen.queryByTestId("expiring-reminder-prefetches-hidden")).not.toBeInTheDocument();
    expect(screen.getByTestId("expiring-reminder-prefetches-included")).toHaveTextContent(/47/);
    // Opened tile now shows the inflated count.
    expect(screen.getByTestId("expiring-reminder-stat-opened")).toHaveTextContent(/95/);

    // Sanity: the URL string contained the toggle.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([input]) => String(input).includes("includePrefetches=1"))).toBe(true);
  });

  it("renders the daily trend sparkline above the stat tiles when buckets arrive", async () => {
    // Task #1890 — three days of data with *varying* sent volumes so
    // the rate trend (going up: 10% → 40% → 70%) clearly diverges from
    // the raw count trend. This guards against a regression where the
    // chart accidentally plots counts instead of open rates.
    handler.default = {
      windowDays: 3,
      since: new Date().toISOString(),
      sent: 130,
      opened: 18,
      prefetched: 12,
      clicked: 3,
      openRate: 0.1385,
      clickRate: 0.023,
      includePrefetches: false,
      daily: [
        // Day 1: high volume, low rate (10% open).
        { date: "2026-04-28", sent: 100, opened: 10, prefetched: 5, clicked: 0 },
        // Day 2: medium volume, medium rate (40% open).
        { date: "2026-04-29", sent: 20, opened: 8, prefetched: 6, clicked: 1 },
        // Day 3: low volume, high rate (70% open) — raw `opened`
        // count actually *fell* from 10 to 7 across the window, but
        // the rate climbed from 10% to 70%. The chart must reflect
        // the rate trend, not the count trend.
        { date: "2026-04-30", sent: 10, opened: 7, prefetched: 1, clicked: 2 },
      ],
    };

    renderWidget();

    const spark = await screen.findByTestId("expiring-reminder-trend-sparkline");
    expect(spark).toBeInTheDocument();

    // Both stacked series render — the solid opens area and the
    // visually-distinct prefetch area sit inside the same SVG.
    expect(screen.getByTestId("expiring-reminder-trend-opens-area")).toBeInTheDocument();
    expect(screen.getByTestId("expiring-reminder-trend-prefetches-area")).toBeInTheDocument();

    // Each bucket exposes a hover hit-target carrying the precise
    // counts and the day's open *rate* in a native <title> tooltip —
    // admins hover to see the exact day's numbers without needing a
    // JS chart library.
    const apr30 = screen.getByTestId("expiring-reminder-trend-day-2026-04-30");
    expect(apr30).toBeInTheDocument();
    const tooltip = apr30.querySelector("title");
    expect(tooltip?.textContent).toMatch(/2026-04-30/);
    expect(tooltip?.textContent).toMatch(/10 sent/);
    expect(tooltip?.textContent).toMatch(/7 opened/);
    expect(tooltip?.textContent).toMatch(/1 prefetched/);
    expect(tooltip?.textContent).toMatch(/2 clicked/);
    // Day 3 open rate: 7/10 = 70.0%. If the chart had fallen back to
    // counts, this would show as "7" not "70.0%".
    expect(tooltip?.textContent).toMatch(/70\.0%/);

    // Day 1 tooltip surfaces the *rate* (10.0%), not the raw count (10).
    const apr28 = screen.getByTestId("expiring-reminder-trend-day-2026-04-28");
    const apr28Tooltip = apr28.querySelector("title");
    expect(apr28Tooltip?.textContent).toMatch(/100 sent/);
    expect(apr28Tooltip?.textContent).toMatch(/10 opened/);
    expect(apr28Tooltip?.textContent).toMatch(/10\.0%/);

    // The headline numbers still render as before — the sparkline is
    // additive context, not a replacement.
    expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("13.9%");
  });

  it("plots open *rates* per day, not raw open counts (Task #1890 regression)", async () => {
    // Direct geometric regression for the chart math. Three days where
    // the raw `opened` count is identical (5/day) but the rate swings
    // from 5% → 25% → 50% as `sent` falls. The opens area's polygon
    // points must climb monotonically from left to right because
    // *rates* climb — if the chart plotted counts, all three points
    // would sit at the same height (a flat line).
    handler.default = {
      windowDays: 3,
      since: new Date().toISOString(),
      sent: 130,
      opened: 15,
      prefetched: 0,
      clicked: 0,
      openRate: 0.115,
      clickRate: 0,
      includePrefetches: false,
      daily: [
        { date: "2026-04-28", sent: 100, opened: 5, prefetched: 0, clicked: 0 }, // 5%
        { date: "2026-04-29", sent: 20,  opened: 5, prefetched: 0, clicked: 0 }, // 25%
        { date: "2026-04-30", sent: 10,  opened: 5, prefetched: 0, clicked: 0 }, // 50%
      ],
    };

    renderWidget();

    const opensArea = await screen.findByTestId("expiring-reminder-trend-opens-area");
    const points = opensArea.getAttribute("points") ?? "";
    // Polygon points are "x,y x,y x,y ..." with the first and last
    // pair clamped to the baseline (the polygon closes down). The 3
    // middle pairs are the daily rate plot points; their Y coordinates
    // must strictly *decrease* (smaller Y = higher on screen) as the
    // rate climbs from day 1 to day 3.
    const pairs = points.trim().split(/\s+/).map(p => {
      const [x, y] = p.split(",").map(Number);
      return { x, y };
    });
    // pairs[0] is the bottom-left baseline anchor; pairs[1..3] are the
    // 3 day plot points; pairs[4] is the bottom-right baseline anchor.
    expect(pairs.length).toBe(5);
    const dayPoints = pairs.slice(1, 4);
    // Higher rate = lower Y. With rates 5% → 25% → 50%:
    expect(dayPoints[0].y).toBeGreaterThan(dayPoints[1].y);
    expect(dayPoints[1].y).toBeGreaterThan(dayPoints[2].y);
    // And the last day must land well above the first day (the rate
    // 10x'd) — guard against a near-flat plot that a count-based chart
    // would produce.
    expect(dayPoints[0].y - dayPoints[2].y).toBeGreaterThan(10);

    // Tooltips report the rate, not the count, even though counts are
    // identical across all three days.
    expect(screen.getByTestId("expiring-reminder-trend-day-2026-04-28").querySelector("title")?.textContent)
      .toMatch(/5\.0%/);
    expect(screen.getByTestId("expiring-reminder-trend-day-2026-04-29").querySelector("title")?.textContent)
      .toMatch(/25\.0%/);
    expect(screen.getByTestId("expiring-reminder-trend-day-2026-04-30").querySelector("title")?.textContent)
      .toMatch(/50\.0%/);
  });

  it("handles sent=0 days without dividing by zero", async () => {
    // A quiet day with `sent === 0` has no defined rate and must plot
    // at the baseline — suppressing it would break the time-axis
    // continuity, but a NaN/Infinity rate would corrupt the SVG.
    handler.default = {
      windowDays: 2,
      since: new Date().toISOString(),
      sent: 4,
      opened: 2,
      prefetched: 0,
      clicked: 0,
      openRate: 0.5,
      clickRate: 0,
      includePrefetches: false,
      daily: [
        { date: "2026-04-29", sent: 0, opened: 0, prefetched: 0, clicked: 0 }, // quiet
        { date: "2026-04-30", sent: 4, opened: 2, prefetched: 0, clicked: 0 }, // 50%
      ],
    };

    renderWidget();

    const opensArea = await screen.findByTestId("expiring-reminder-trend-opens-area");
    const points = opensArea.getAttribute("points") ?? "";
    expect(points).not.toMatch(/NaN|Infinity/);

    // Quiet day's tooltip uses the em-dash placeholder for the rate.
    const quiet = screen.getByTestId("expiring-reminder-trend-day-2026-04-29").querySelector("title");
    expect(quiet?.textContent).toMatch(/0 sent/);
    expect(quiet?.textContent).toMatch(/—/);
  });

  it("omits the sparkline gracefully when the API returns no daily buckets", async () => {
    // Defensive: the widget shouldn't blow up if the response shape
    // ever regresses (e.g. an older deploy of the API). The headline
    // numbers should still render and the sparkline simply hides.
    handler.default = {
      windowDays: 30,
      since: new Date().toISOString(),
      sent: 4,
      opened: 1,
      prefetched: 0,
      clicked: 0,
      openRate: 0.25,
      clickRate: 0,
      includePrefetches: false,
      // No `daily` field on purpose.
    };

    renderWidget();

    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("25.0%"));
    expect(screen.queryByTestId("expiring-reminder-trend-sparkline")).not.toBeInTheDocument();
  });

  it("hides the widget when the API responds 403 (non-admin role)", async () => {
    handler.status = 403;

    renderWidget();

    // Wait for the call to actually land before asserting the hide —
    // otherwise the "not in the document" assertion would also pass on
    // the initial loading frame and give us no real signal that the
    // 403 path was exercised.
    await waitFor(() =>
      expect(handler.defaultCalls + handler.withPrefetchesCalls).toBeGreaterThanOrEqual(1));
    // After 401/403 the widget renders nothing — no card, no toggle.
    await waitFor(() => {
      expect(screen.queryByTestId("expiring-reminder-stats-widget")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("expiring-reminder-include-prefetches")).not.toBeInTheDocument();
  });

  it("also hides the widget on 401 (unauthenticated viewer)", async () => {
    handler.status = 401;

    renderWidget();
    await waitFor(() =>
      expect(handler.defaultCalls + handler.withPrefetchesCalls).toBeGreaterThanOrEqual(1));
    await waitFor(() => {
      expect(screen.queryByTestId("expiring-reminder-stats-widget")).not.toBeInTheDocument();
    });
  });

  // ─── Task #1889 — admin-selectable comparison window ───────────────────
  it("defaults to a 30d window and exposes 7d / 30d / 90d pills", async () => {
    renderWidget();

    // The selector renders the three documented buckets. We assert via
    // testids (not visible text) so a future relabel like "Last 7 days"
    // doesn't silently break the contract.
    expect(await screen.findByTestId("expiring-reminder-window-7d")).toBeInTheDocument();
    expect(screen.getByTestId("expiring-reminder-window-30d")).toBeInTheDocument();
    expect(screen.getByTestId("expiring-reminder-window-90d")).toBeInTheDocument();

    // The 30d pill is active out of the box (matches the API default).
    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-window-30d"))
        .toHaveAttribute("data-active", "true"));
    expect(screen.getByTestId("expiring-reminder-window-7d"))
      .toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("expiring-reminder-window-90d"))
      .toHaveAttribute("data-active", "false");

    // The default request pins `?days=30` so the URL reflects the
    // active window even when it matches the server-side default.
    await waitFor(() => expect(handler.lastDays).toBe(30));
  });

  it("switching to 7d refetches with ?days=7 and updates the headline", async () => {
    handler.byDays = {
      30: {
        windowDays: 30,
        since: new Date().toISOString(),
        sent: 400, opened: 48, prefetched: 47, clicked: 12,
        openRate: 0.12, clickRate: 0.03,
        includePrefetches: false,
      },
      7: {
        // The whole point of the selector — the prior week skews
        // *much* higher because a recent product change pushed
        // export reminders to a more engaged cohort.
        windowDays: 7,
        since: new Date().toISOString(),
        sent: 80, opened: 32, prefetched: 5, clicked: 6,
        openRate: 0.4, clickRate: 0.075,
        includePrefetches: false,
      },
    };

    renderWidget();

    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("12.0%"));
    expect(handler.daysSeen).toContain(30);

    fireEvent.click(screen.getByTestId("expiring-reminder-window-7d"));

    // The widget refetches against `?days=7`…
    await waitFor(() => expect(handler.daysSeen).toContain(7));
    // …the headline open rate switches to the 7d payload…
    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-open-rate")).toHaveTextContent("40.0%"));
    // …and so does each stat tile, so admins aren't reading mixed
    // numbers from two different windows on the same card.
    expect(screen.getByTestId("expiring-reminder-stat-sent")).toHaveTextContent(/80/);
    expect(screen.getByTestId("expiring-reminder-stat-opened")).toHaveTextContent(/32/);
    expect(screen.getByTestId("expiring-reminder-stat-clicked")).toHaveTextContent(/6/);
    expect(screen.getByTestId("expiring-reminder-stat-prefetched")).toHaveTextContent(/5/);

    // The active-pill indicator follows the click.
    expect(screen.getByTestId("expiring-reminder-window-7d"))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("expiring-reminder-window-30d"))
      .toHaveAttribute("data-active", "false");
  });

  it("composes the window selector with the includePrefetches toggle", async () => {
    handler.byDays = {
      90: {
        windowDays: 90,
        since: new Date().toISOString(),
        sent: 1200, opened: 150, prefetched: 60, clicked: 30,
        openRate: 0.125, clickRate: 0.025,
        includePrefetches: false,
      },
    };

    renderWidget();
    fireEvent.click(screen.getByTestId("expiring-reminder-window-90d"));

    // The first 90d hit drops the includePrefetches param.
    await waitFor(() => expect(handler.daysSeen).toContain(90));
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([input]) => {
      const u = String(input);
      return u.includes("days=90") && !u.includes("includePrefetches=1");
    })).toBe(true);

    // Wait for the data to land before reaching for the checkbox —
    // the prefetch toggle only renders out of the loading branch.
    await screen.findByTestId("expiring-reminder-include-prefetches");
    fireEvent.click(screen.getByTestId("expiring-reminder-include-prefetches"));

    // Both the window and the prefetch toggle ride together on the same
    // request — flipping one doesn't reset the other.
    await waitFor(() => {
      const recent = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(recent.some(([input]) => {
        const u = String(input);
        return u.includes("days=90") && u.includes("includePrefetches=1");
      })).toBe(true);
    });
  });

  it("remembers the chosen window across re-mounts via sessionStorage", async () => {
    renderWidget();

    fireEvent.click(await screen.findByTestId("expiring-reminder-window-90d"));
    await waitFor(() => expect(handler.daysSeen).toContain(90));

    // Tear down and remount — the second instance should read the
    // selection back out of sessionStorage instead of resetting to 30d.
    cleanup();
    handler.daysSeen = [];
    handler.lastDays = null;

    renderWidget();

    // Active pill is restored…
    await waitFor(() =>
      expect(screen.getByTestId("expiring-reminder-window-90d"))
        .toHaveAttribute("data-active", "true"));
    expect(screen.getByTestId("expiring-reminder-window-30d"))
      .toHaveAttribute("data-active", "false");
    // …and the very first request the remounted widget makes is
    // already against the remembered window — no flicker through 30d.
    await waitFor(() => expect(handler.lastDays).toBe(90));
    expect(handler.daysSeen).not.toContain(30);
  });
});
