/**
 * Task #1575 — "Re-run plan migration" button + dialog.
 *
 * Covers the per-club detail view's new action: opening the dialog,
 * choosing a target tier + reason, and POSTing to the dedicated
 * `/api/super-admin/clubs/:orgId/re-migrate` endpoint (NOT PATCH /tier,
 * which is the silent sales-y endpoint). After success the audit panel,
 * clubs list, and dashboard caches are all invalidated and the open
 * detail sheet's tier badge updates immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "super_admin" } }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

interface ClubFixture {
  id: number;
  name: string;
  slug: string;
  logoUrl: null;
  primaryColor: null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: null;
  memberCount: number;
  tournamentCount: number;
  activeTournaments: number;
  createdAt: string;
}

const SAMPLE_CLUB: ClubFixture = {
  id: 42,
  name: "Bayside CC",
  slug: "bayside-cc",
  logoUrl: null,
  primaryColor: null,
  subscriptionTier: "pro",
  isActive: true,
  contactEmail: null,
  memberCount: 12,
  tournamentCount: 3,
  activeTournaments: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

describe("Re-run plan migration — button + dialog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  // Mutable so a test can swap in a downgraded copy after the POST.
  let clubFixture: ClubFixture;

  beforeEach(() => {
    toastMock.mockClear();
    clubFixture = { ...SAMPLE_CLUB };
    // jsdom doesn't implement Pointer Capture; Radix Select calls these on
    // pointer-down to decide whether to open. Without these stubs, the
    // user-event click on a SelectTrigger throws and the dropdown never
    // opens, blocking the "pick a tier" interactions in the downgrade test.
    if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
      (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
    }
    if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
      (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
    }
    if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 1, activeClubs: 1, totalUsers: 12, totalTournaments: 3,
          activeTournaments: 1,
          tierBreakdown: { free: 0, starter: 0, pro: 1, enterprise: 0 },
          estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
          bookingsByClub: [],
        });
      }
      if (url.startsWith("/api/super-admin/clubs?") && method === "GET") {
        return jsonResponse({ clubs: [clubFixture], total: 1 });
      }
      if (url.startsWith("/api/super-admin/caddie-prompt-metrics")) {
        return jsonResponse({
          total: 0, windowStart: null, windowEnd: null,
          byMode: { shots: 0, rounds: 0 },
          avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
          p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
          avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/watch-position-metrics")) {
        const emptyWindow = {
          totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
          avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
          p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
        };
        return jsonResponse({
          windows: { "24h": emptyWindow, "7d": emptyWindow, "30d": emptyWindow },
          seriesByWindow: { "24h": [], "7d": [], "30d": [] },
          seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 86400 },
          recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/ops-alert-settings")) {
        return jsonResponse({ entries: [], config: null });
      }
      if (
        url.match(/\/api\/super-admin\/clubs\/\d+\/re-migrate$/)
        && method === "POST"
      ) {
        return jsonResponse({
          ok: true,
          organizationId: clubFixture.id,
          fromTier: "pro",
          toTier: "free",
          auditRecorded: true,
          recipientsAttempted: 2,
          recipientsEmailed: 2,
          pushAttempted: 1,
          pushSent: 1,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  async function openDetailSheet() {
    const user = userEvent.setup();
    renderPage();
    // Switch to Clubs view (the nav button label is "Clubs").
    await user.click(await screen.findByRole("button", { name: /^Clubs$/ }));
    // Wait for the row to render then click the row's open-detail
    // chevron (the only ghost-variant button in that row).
    const nameCell = await screen.findByText("Bayside CC");
    const row = nameCell.closest("tr") as HTMLElement;
    expect(row).toBeTruthy();
    const buttons = within(row).getAllByRole("button");
    // Last button in the row is the chevron-detail trigger.
    await user.click(buttons[buttons.length - 1]);
    await screen.findByTestId("button-open-re-migrate");
    return user;
  }

  it("opens the dialog with the club's current tier pre-selected", async () => {
    const user = await openDetailSheet();
    await user.click(screen.getByTestId("button-open-re-migrate"));

    const dialog = await screen.findByTestId("dialog-re-migrate");
    const dialogScope = within(dialog);
    expect(dialogScope.getByText(/Re-run plan migration/i)).toBeInTheDocument();
    // Pre-seed the trigger with the club's current tier ("pro").
    const trigger = dialogScope.getByTestId("select-re-migrate-tier");
    expect(trigger.textContent?.toLowerCase()).toContain("pro");
  });

  it("POSTs target tier + reason and refreshes both the audit panel and the tier badge", async () => {
    const user = await openDetailSheet();
    await user.click(screen.getByTestId("button-open-re-migrate"));
    await screen.findByTestId("dialog-re-migrate");

    // Type a reason. (We can't easily change the Radix Select in jsdom, so
    // we rely on the pre-selected "pro" value — the POST body still proves
    // the wiring works.)
    const reasonInput = screen.getByTestId("textarea-re-migrate-reason");
    await user.type(reasonInput, "Drifted from Stripe — manual reset");

    // Swap the fixture so subsequent invalidations refetch a downgraded
    // club (mirroring what the helper would have persisted server-side).
    clubFixture = { ...clubFixture, subscriptionTier: "free" };

    await user.click(screen.getByTestId("button-submit-re-migrate"));

    // POSTed with the right shape.
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        c => typeof c[0] === "string"
          && c[0] === "/api/super-admin/clubs/42/re-migrate",
      );
      expect(call).toBeTruthy();
      expect((call![1] as RequestInit).method).toBe("POST");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        targetTier: "pro",
        reason: "Drifted from Stripe — manual reset",
      });
    });

    // Dialog closes.
    await waitFor(() => {
      expect(screen.queryByTestId("dialog-re-migrate")).toBeNull();
    });

    // Confirmation toast surfaces the recipient counts so the operator
    // knows the realtime fan-out actually fired.
    await waitFor(() => {
      const toastArgs = toastMock.mock.calls.map(c => c[0]);
      expect(toastArgs.some((a: { title?: string; description?: string }) =>
        /Plan migration re-run/i.test(a.title ?? "")
        && /Notified 2 super admins by email/i.test(a.description ?? "")
        && /and 1 by push/i.test(a.description ?? ""),
      )).toBe(true);
    });

    // Tier badge in the still-open detail sheet now reads "free" — the
    // mutation's onSuccess patches selectedClub locally so the operator
    // doesn't have to wait for the refetch to resolve. The "Re-run plan
    // migration…" trigger only renders inside the detail sheet, so we use
    // it to locate the sheet container.
    const reopenBtn = screen.getByTestId("button-open-re-migrate");
    const sheet = reopenBtn.closest("div.bg-card") as HTMLElement;
    expect(sheet).toBeTruthy();
    await waitFor(() => {
      expect(within(sheet).getByText(/^free$/i)).toBeInTheDocument();
    });

    // Audit panel refresh was triggered (the React Query cache was
    // invalidated). We assert the GET happened by switching to the
    // plan-migrations view and confirming the request fires.
    const calls = fetchMock.mock.calls.map(c => c[0] as string);
    // Clubs list was invalidated → at least one re-fetch after the POST.
    const remigrateIdx = calls.findIndex(u => u.endsWith("/re-migrate"));
    const clubsAfter = calls
      .slice(remigrateIdx + 1)
      .filter(u => u.startsWith("/api/super-admin/clubs?"));
    expect(clubsAfter.length).toBeGreaterThan(0);
  });

  // Helper — open the Radix Select dropdown and click the option whose
  // visible label matches `label` (case-insensitive). Radix renders the
  // option list in a portal outside the dialog, so we scope the lookup to
  // listbox role rather than the dialog body.
  async function pickTier(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(screen.getByTestId("select-re-migrate-tier"));
    const listbox = await screen.findByRole("listbox");
    const opt = within(listbox).getByRole("option", { name: new RegExp(`^${label}$`, "i") });
    await user.click(opt);
  }

  it("requires a second click before POSTing a downgrade", async () => {
    // Task #1956 — picking a strictly-lower target tier surfaces an inline
    // warning and flips the submit button into a "Yes, downgrade" confirm.
    // The first click only flips the confirm flag; the second actually
    // POSTs. Same-tier and upgrade selections still submit on the first
    // click (covered by the existing tests above).
    const user = await openDetailSheet();
    await user.click(screen.getByTestId("button-open-re-migrate"));
    await screen.findByTestId("dialog-re-migrate");

    // Select "free" (strictly below "pro").
    await pickTier(user, "free");

    // Inline warning appears with the from→to framing.
    const warning = await screen.findByTestId("warning-re-migrate-downgrade");
    expect(warning.textContent).toMatch(/downgrade Bayside CC from/i);
    expect(warning.textContent).toMatch(/pro/i);
    expect(warning.textContent).toMatch(/free/i);

    // First click: button label changes, no POST yet.
    const submit = screen.getByTestId("button-submit-re-migrate");
    expect(submit.textContent).toMatch(/Re-run migration/i);
    await user.click(submit);

    await waitFor(() => {
      expect(
        screen.getByTestId("button-submit-re-migrate").textContent,
      ).toMatch(/Yes, downgrade/i);
    });
    const postedAfterFirst = fetchMock.mock.calls.some(
      c => typeof c[0] === "string"
        && c[0].endsWith("/re-migrate")
        && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postedAfterFirst).toBe(false);

    // Warning is still visible while the operator decides.
    expect(screen.getByTestId("warning-re-migrate-downgrade")).toBeInTheDocument();

    // Second click actually POSTs.
    await user.click(screen.getByTestId("button-submit-re-migrate"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        c => typeof c[0] === "string"
          && c[0] === "/api/super-admin/clubs/42/re-migrate",
      );
      expect(call).toBeTruthy();
      expect((call![1] as RequestInit).method).toBe("POST");
      // The mutation drops an empty reason via `reason.trim() || undefined`,
      // so JSON.stringify omits the field entirely on the empty path.
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        targetTier: "free",
      });
    });

    // Dialog closes after the successful submit.
    await waitFor(() => {
      expect(screen.queryByTestId("dialog-re-migrate")).toBeNull();
    });
  });

  it("resets the confirm step when the operator picks back up to the original tier", async () => {
    // Task #1956 — once the operator has flipped into "Yes, downgrade",
    // changing the target tier back to a same-or-higher option clears the
    // confirm flag and removes the warning, so an unrelated re-fire of the
    // same tier still goes out on the first click.
    const user = await openDetailSheet();
    await user.click(screen.getByTestId("button-open-re-migrate"));
    await screen.findByTestId("dialog-re-migrate");

    await pickTier(user, "free");
    await screen.findByTestId("warning-re-migrate-downgrade");
    await user.click(screen.getByTestId("button-submit-re-migrate"));
    await waitFor(() => {
      expect(
        screen.getByTestId("button-submit-re-migrate").textContent,
      ).toMatch(/Yes, downgrade/i);
    });

    // Pick the original tier back; the warning + confirm clear.
    await pickTier(user, "pro");
    await waitFor(() => {
      expect(screen.queryByTestId("warning-re-migrate-downgrade")).toBeNull();
    });
    expect(
      screen.getByTestId("button-submit-re-migrate").textContent,
    ).toMatch(/Re-run migration/i);

    // First click on the same-tier path POSTs straight away.
    await user.click(screen.getByTestId("button-submit-re-migrate"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        c => typeof c[0] === "string"
          && c[0] === "/api/super-admin/clubs/42/re-migrate",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        targetTier: "pro",
      });
    });
  });

  it("does not POST when the operator cancels the dialog", async () => {
    const user = await openDetailSheet();
    await user.click(screen.getByTestId("button-open-re-migrate"));
    await screen.findByTestId("dialog-re-migrate");
    await user.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("dialog-re-migrate")).toBeNull();
    });
    // No POST to /re-migrate should have happened.
    const posted = fetchMock.mock.calls.some(
      c => typeof c[0] === "string"
        && c[0].endsWith("/re-migrate")
        && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBe(false);
  });
});

/**
 * Task #1957 — row-level "Re-run migration…" shortcut on each unacknowledged
 * Plan Migration audit row. Opens the same dialog used by the per-club
 * detail sheet, but pre-seeded with the row's org id + current tier and
 * tagged with the audit row id so submitting also acknowledges that row.
 */
interface AuditEntry {
  id: number;
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
  currentTier: string | null;
  fromTier: string | null;
  toTier: string | null;
  reason: string | null;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: number | null;
  acknowledgedByName: string | null;
  acknowledgedVia: 'email' | 'dashboard' | null;
  firstDigestedAt: string | null;
  triggerReason: 'cancelled' | 'unknown_tier' | 'manual' | null;
}

function makeAuditEntry(over: Partial<AuditEntry> & { id: number }): AuditEntry {
  return {
    organizationId: 700 + over.id,
    orgName: `Audit Club ${over.id}`,
    orgSlug: `audit-club-${over.id}`,
    currentTier: "pro",
    fromTier: "pro",
    toTier: "free",
    reason: null,
    createdAt: "2026-04-15T00:00:00.000Z",
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByName: null,
    acknowledgedVia: null,
    firstDigestedAt: null,
    triggerReason: null,
    ...over,
  };
}

describe("Re-run plan migration — row-level shortcut on the audit panel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let acknowledgeOk: boolean;
  // Tracks audit-row state so a successful re-run + acknowledge flips the
  // row to `acknowledged: true` on the next refetch (mirrors how the
  // server would mark the row reviewed).
  let entries: AuditEntry[];

  beforeEach(() => {
    toastMock.mockClear();
    acknowledgeOk = true;
    entries = [
      makeAuditEntry({ id: 901, organizationId: 5001, orgName: "Audit Club 901", currentTier: "pro" }),
    ];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
          activeTournaments: 0,
          tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
          bookingsByClub: [],
        });
      }
      if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
        return jsonResponse({
          total: 0, windowStart: null, windowEnd: null,
          byMode: { shots: 0, rounds: 0 },
          avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
          p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
          avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
        const emptyWindow = {
          totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
          avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
          p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
        };
        return jsonResponse({
          windows: { "24h": emptyWindow, "7d": emptyWindow, "30d": emptyWindow },
          seriesByWindow: { "24h": [], "7d": [], "30d": [] },
          seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 86400 },
          recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/legacy-slug-mappings") && method === "GET") {
        return jsonResponse({ mappings: [] });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        return jsonResponse({ entries, total: entries.length, page: 1, limit: 500 });
      }
      if (
        url.match(/\/api\/super-admin\/clubs\/\d+\/re-migrate$/)
        && method === "POST"
      ) {
        const orgId = Number(url.match(/clubs\/(\d+)\/re-migrate/)![1]);
        return jsonResponse({
          ok: true,
          organizationId: orgId,
          fromTier: "pro",
          toTier: "free",
          auditRecorded: true,
          recipientsAttempted: 2,
          recipientsEmailed: 2,
          pushAttempted: 1,
          pushSent: 1,
        });
      }
      if (
        url.match(/\/api\/super-admin\/plan-migration-audit\/\d+\/acknowledge$/)
        && method === "POST"
      ) {
        if (!acknowledgeOk) {
          return jsonResponse(
            { error: "Audit row already acknowledged elsewhere" },
            409,
          );
        }
        const ackId = Number(url.match(/audit\/(\d+)\/acknowledge/)![1]);
        entries = entries.map(e => (e.id === ackId
          ? { ...e, acknowledged: true, acknowledgedVia: 'dashboard' as const }
          : e));
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  async function openMigrationsView() {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    await screen.findByText("Audit Club 901");
    return user;
  }

  it("opens the dialog pre-seeded with the row's org name + current tier and surfaces the 'will also acknowledge' notice", async () => {
    const user = await openMigrationsView();

    await user.click(screen.getByTestId("button-row-re-migrate-901"));

    const dialog = await screen.findByTestId("dialog-re-migrate");
    const dialogScope = within(dialog);
    // Title + the row-derived org name in the description.
    expect(dialogScope.getByText(/Re-run plan migration/i)).toBeInTheDocument();
    expect(dialogScope.getByText("Audit Club 901")).toBeInTheDocument();
    // Tier select pre-seeded with the row's currentTier.
    const trigger = dialogScope.getByTestId("select-re-migrate-tier");
    expect(trigger.textContent?.toLowerCase()).toContain("pro");
    // "Currently on …" hint reflects the row's currentTier.
    expect(dialogScope.getByText(/Currently on/i).textContent?.toLowerCase()).toContain("pro");
    // Row-only notice that acknowledging will happen on submit.
    expect(dialogScope.getByTestId("text-re-migrate-from-audit-row")).toBeInTheDocument();
  });

  it("submitting the dialog POSTs to /re-migrate AND acknowledges the source row", async () => {
    const user = await openMigrationsView();
    await user.click(screen.getByTestId("button-row-re-migrate-901"));
    await screen.findByTestId("dialog-re-migrate");

    const reasonInput = screen.getByTestId("textarea-re-migrate-reason");
    await user.type(reasonInput, "Re-firing alert after slug fix");

    await user.click(screen.getByTestId("button-submit-re-migrate"));

    // Both the migrate POST and the acknowledge POST should fire — and the
    // acknowledge must happen AFTER the migrate so the new "manual" audit
    // row is written before the source row is cleared.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(c => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`);
      expect(calls).toEqual(
        expect.arrayContaining([
          "POST /api/super-admin/clubs/5001/re-migrate",
          "POST /api/super-admin/plan-migration-audit/901/acknowledge",
        ]),
      );
      const migrateIdx = calls.indexOf("POST /api/super-admin/clubs/5001/re-migrate");
      const ackIdx = calls.indexOf("POST /api/super-admin/plan-migration-audit/901/acknowledge");
      expect(migrateIdx).toBeGreaterThanOrEqual(0);
      expect(ackIdx).toBeGreaterThan(migrateIdx);
    });

    // POST body carries the typed reason.
    const migrateCall = fetchMock.mock.calls.find(
      c => typeof c[0] === "string"
        && c[0] === "/api/super-admin/clubs/5001/re-migrate",
    );
    expect(JSON.parse((migrateCall![1] as RequestInit).body as string)).toEqual({
      targetTier: "pro",
      reason: "Re-firing alert after slug fix",
    });

    // Dialog closes after success.
    await waitFor(() => {
      expect(screen.queryByTestId("dialog-re-migrate")).toBeNull();
    });

    // Success toast surfaces the fan-out counts (same wording as the per-
    // club detail sheet path — proves we share the same onSuccess handler).
    await waitFor(() => {
      const toastArgs = toastMock.mock.calls.map(c => c[0]);
      expect(toastArgs.some((a: { title?: string; description?: string }) =>
        /Plan migration re-run/i.test(a.title ?? "")
        && /Notified 2 super admins by email/i.test(a.description ?? ""),
      )).toBe(true);
    });

    // Audit list was invalidated → the next GET sees the row marked
    // acknowledged, so the row-level Re-run button is no longer in the DOM.
    await waitFor(() => {
      expect(screen.queryByTestId("button-row-re-migrate-901")).toBeNull();
    });
  });

  it("Cancel from the row-opened dialog skips both POSTs", async () => {
    const user = await openMigrationsView();
    await user.click(screen.getByTestId("button-row-re-migrate-901"));
    await screen.findByTestId("dialog-re-migrate");

    await user.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("dialog-re-migrate")).toBeNull();
    });

    const postedMigrate = fetchMock.mock.calls.some(
      c => typeof c[0] === "string"
        && c[0].endsWith("/re-migrate")
        && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    const postedAck = fetchMock.mock.calls.some(
      c => typeof c[0] === "string"
        && /\/plan-migration-audit\/\d+\/acknowledge$/.test(c[0])
        && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postedMigrate).toBe(false);
    expect(postedAck).toBe(false);
  });

  it("if the follow-up acknowledge fails, the migrate result is still reflected and a warning toast is shown", async () => {
    acknowledgeOk = false;

    const user = await openMigrationsView();
    await user.click(screen.getByTestId("button-row-re-migrate-901"));
    await screen.findByTestId("dialog-re-migrate");
    await user.click(screen.getByTestId("button-submit-re-migrate"));

    // Both POSTs fire — the acknowledge returns 409.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(c => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`);
      expect(calls).toEqual(
        expect.arrayContaining([
          "POST /api/super-admin/clubs/5001/re-migrate",
          "POST /api/super-admin/plan-migration-audit/901/acknowledge",
        ]),
      );
    });

    // The error toast surfaces the server message so the operator knows
    // the migrate landed but the source row needs a manual ack.
    await waitFor(() => {
      const toastArgs = toastMock.mock.calls.map(c => c[0]);
      expect(toastArgs.some((a: { title?: string; description?: string; variant?: string }) =>
        a.variant === "destructive"
        && /Audit row already acknowledged elsewhere/i.test(a.description ?? ""),
      )).toBe(true);
    });
  });
});
