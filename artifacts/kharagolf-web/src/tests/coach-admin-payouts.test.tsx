/**
 * E2E-style component test for the /coach-admin Coach Revenue & Payouts
 * screen — Task #765.
 *
 * Mirrors the backend coverage in
 * `artifacts/api-server/src/tests/coach-admin-payouts.test.ts` (Task #612)
 * with a browser-level safety net so a markup change to /coach-admin
 * cannot silently break the edit-share / run-batch / mark-paid flow.
 *
 * The test stubs `fetch` with a tiny in-memory backend that owns the
 * coach + payouts state, then walks the page through the same admin
 * journey the canonical Playwright plan does
 * (`coach-admin-payouts.e2e.md`):
 *
 *   1. Page loads → baseline lifetime / outstanding totals match the
 *      seeded delivered review at 80% revenue share.
 *   2. Admin edits the revenue share % to 60 → lifetime net + outstanding
 *      net cells immediately recompute.
 *   3. Admin clicks "Run payout batch" → outstanding clears to ₹0 and a
 *      pending payout row appears.
 *   4. Admin opens the mark-paid dialog, enters a reference + notes,
 *      confirms → row badge flips from "Pending" to "Paid" and the
 *      "Mark paid" button disappears.
 *
 * Each step asserts on the same `data-testid` hooks the page exposes,
 * so any rename / removal of those hooks (or break in the reload-on-
 * mutate flow) will fail this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachAdminPage from "@/pages/coach-admin";
import { Toaster } from "@/components/ui/toaster";

interface CoachState {
  proId: number;
  displayName: string;
  isActive: boolean;
  userId: number | null;
  isListed: boolean;
  revenueSharePct: number;
  lifetimeGrossPaise: number;
  deliveredCount: number;
  /**
   * Paise that have been swept into a payout already (counts toward
   * lifetime gross/net but no longer toward outstanding).
   */
  paidOutGrossPaise: number;
}

interface PayoutState {
  id: number;
  proId: number;
  organizationId: number;
  periodStart: string;
  periodEnd: string;
  grossPaise: number;
  netPayoutPaise: number;
  platformFeePaise: number;
  status: "pending" | "paid";
  paidAt: string | null;
  payoutReference: string | null;
  notes: string | null;
  createdAt: string;
}

function applyShare(grossPaise: number, sharePct: number) {
  return Math.round((grossPaise * sharePct) / 100);
}

function buildBackend(initial: CoachState) {
  const coach: CoachState = { ...initial };
  const payouts: PayoutState[] = [];
  let nextPayoutId = 100;

  const proName = (proId: number) => (proId === coach.proId ? coach.displayName : `Pro ${proId}`);

  const coachesPayload = () => {
    const lifetimeNet = applyShare(coach.lifetimeGrossPaise, coach.revenueSharePct);
    const outstandingGross = coach.lifetimeGrossPaise - coach.paidOutGrossPaise;
    const outstandingNet = applyShare(outstandingGross, coach.revenueSharePct);
    const outstandingCount = outstandingGross > 0 ? 1 : 0;
    return {
      coaches: [
        {
          proId: coach.proId,
          displayName: coach.displayName,
          isActive: coach.isActive,
          userId: coach.userId,
          isListed: coach.isListed,
          revenueSharePct: coach.revenueSharePct,
          lifetimeGrossPaise: coach.lifetimeGrossPaise,
          lifetimeNetPayoutPaise: lifetimeNet,
          deliveredCount: coach.deliveredCount,
          outstandingGrossPaise: outstandingGross,
          outstandingNetPayoutPaise: outstandingNet,
          outstandingCount,
        },
      ],
    };
  };

  const payoutsPayload = () => ({
    payouts: payouts.map(p => ({ payout: { ...p }, proName: proName(p.proId), notification: null })),
  });

  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  const err = (status: number, body: unknown) =>
    Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);

  const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (method === "GET" && url.startsWith("/api/coach-marketplace/admin/coaches")) {
      return ok(coachesPayload());
    }
    if (method === "GET" && url.startsWith("/api/swing-reviews/admin/payouts") && !url.includes("/run") && !url.includes("/mark-paid")) {
      return ok(payoutsPayload());
    }

    const shareMatch = url.match(/^\/api\/coach-marketplace\/pros\/(\d+)\/revenue-share$/);
    if (method === "POST" && shareMatch) {
      const proId = Number(shareMatch[1]);
      if (proId !== coach.proId) return err(404, { error: "unknown coach" });
      const pct = Number(body.revenueSharePct);
      if (!isFinite(pct) || pct < 0 || pct > 100) return err(400, { error: "bad pct" });
      coach.revenueSharePct = pct;
      return ok({ success: true, revenueSharePct: pct });
    }

    if (method === "POST" && url === "/api/swing-reviews/admin/payouts/run") {
      const outstandingGross = coach.lifetimeGrossPaise - coach.paidOutGrossPaise;
      if (outstandingGross <= 0) {
        return ok({ count: 0, payouts: [], message: "No eligible reviews", summary: { pending: 0, paid: 0 } });
      }
      const net = applyShare(outstandingGross, coach.revenueSharePct);
      const payout: PayoutState = {
        id: nextPayoutId++,
        proId: coach.proId,
        organizationId: 1,
        periodStart: new Date(Date.now() - 7 * 86400_000).toISOString(),
        periodEnd: new Date().toISOString(),
        grossPaise: outstandingGross,
        netPayoutPaise: net,
        platformFeePaise: outstandingGross - net,
        status: "pending",
        paidAt: null,
        payoutReference: null,
        notes: null,
        createdAt: new Date().toISOString(),
      };
      payouts.unshift(payout);
      coach.paidOutGrossPaise += outstandingGross;
      return ok({
        count: 1,
        payouts: [{ payoutId: payout.id, proId: payout.proId, netPayoutPaise: payout.netPayoutPaise, status: payout.status }],
        summary: { pending: 1, paid: 0 },
      });
    }

    const markPaidMatch = url.match(/^\/api\/swing-reviews\/admin\/payouts\/(\d+)\/mark-paid$/);
    if (method === "POST" && markPaidMatch) {
      const id = Number(markPaidMatch[1]);
      const p = payouts.find(x => x.id === id);
      if (!p) return err(404, { error: "unknown payout" });
      const ref = String(body.reference ?? "").trim();
      if (!ref) return err(400, { error: "reference required" });
      p.status = "paid";
      p.payoutReference = ref;
      p.notes = String(body.notes ?? "").trim() || null;
      p.paidAt = new Date().toISOString();
      return ok({ success: true });
    }

    return err(404, { error: `unhandled ${method} ${url}` });
  };

  return { handler, snapshot: () => ({ coach: { ...coach }, payouts: payouts.map(p => ({ ...p })) }) };
}

describe("CoachAdminPage — full edit-share / run-batch / mark-paid flow (Task #765)", () => {
  let backend: ReturnType<typeof buildBackend>;
  const PRO_ID = 42;

  beforeEach(() => {
    backend = buildBackend({
      proId: PRO_ID,
      displayName: "E2E Coach",
      isActive: true,
      userId: 7,
      isListed: true,
      revenueSharePct: 80,
      lifetimeGrossPaise: 50_000, // ₹500
      deliveredCount: 1,
      paidOutGrossPaise: 0,
    });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("walks edit-share → run-batch → mark-paid and asserts totals at every step", async () => {
    const user = userEvent.setup();
    render(<CoachAdminPage />);

    // ── Step 1: BASELINE ────────────────────────────────────────────────
    // Wait for the initial load to settle (loading text is replaced by the
    // page container).
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    expect(within(row).getByTestId(`text-coach-name-${PRO_ID}`)).toHaveTextContent("E2E Coach");
    expect(within(row).getByTestId(`text-lifetime-gross-${PRO_ID}`)).toHaveTextContent("₹500");
    expect(within(row).getByTestId(`text-lifetime-net-${PRO_ID}`)).toHaveTextContent("₹400");
    expect(within(row).getByTestId(`text-outstanding-${PRO_ID}`)).toHaveTextContent("₹400");
    expect(screen.getByTestId("text-no-payouts")).toBeInTheDocument();

    // The share input shows the current value (80) but is not yet in
    // edit-mode, so the Save button must NOT be present.
    const shareInput = within(row).getByTestId(`input-share-${PRO_ID}`) as HTMLInputElement;
    expect(shareInput.value).toBe("80");
    expect(within(row).queryByTestId(`button-save-share-${PRO_ID}`)).toBeNull();

    // ── Step 2: EDIT REVENUE SHARE 80% → 60% ────────────────────────────
    await user.clear(shareInput);
    await user.type(shareInput, "60");
    const saveBtn = await within(row).findByTestId(`button-save-share-${PRO_ID}`);
    await user.click(saveBtn);

    // After save, page reloads → row leaves edit mode (Save button gone)
    // AND the totals reflect the new 60% share against the same gross.
    await waitFor(() =>
      expect(screen.queryByTestId(`button-save-share-${PRO_ID}`)).toBeNull(),
    );
    const rowAfterEdit = screen.getByTestId(`row-coach-${PRO_ID}`);
    expect((within(rowAfterEdit).getByTestId(`input-share-${PRO_ID}`) as HTMLInputElement).value).toBe("60");
    expect(within(rowAfterEdit).getByTestId(`text-lifetime-gross-${PRO_ID}`)).toHaveTextContent("₹500");
    // 60% of ₹500 = ₹300.
    expect(within(rowAfterEdit).getByTestId(`text-lifetime-net-${PRO_ID}`)).toHaveTextContent("₹300");
    expect(within(rowAfterEdit).getByTestId(`text-outstanding-${PRO_ID}`)).toHaveTextContent("₹300");

    // ── Step 3: RUN PAYOUT BATCH ────────────────────────────────────────
    await user.click(screen.getByTestId("button-run-payout-batch"));

    // A new payout row appears AND the outstanding cell falls to ₹0
    // because the seeded review is now attached to the freshly created
    // payout.
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-payout-/);
      expect(rows.length).toBeGreaterThan(0);
    });
    const outstandingCell = within(screen.getByTestId(`row-coach-${PRO_ID}`))
      .getByTestId(`text-outstanding-${PRO_ID}`);
    await waitFor(() => expect(outstandingCell).toHaveTextContent("₹0"));
    expect(outstandingCell).toHaveTextContent("0 unpaid");
    expect(screen.queryByTestId("text-no-payouts")).toBeNull();

    // Capture the payout id from the freshly created row.
    const payoutRow = screen.getAllByTestId(/^row-payout-/)[0]!;
    const payoutId = Number(payoutRow.getAttribute("data-testid")!.replace("row-payout-", ""));
    expect(within(payoutRow).getByTestId(`badge-status-${payoutId}`)).toHaveTextContent(/Pending/i);
    expect(within(payoutRow).getByTestId(`button-mark-paid-${payoutId}`)).toBeInTheDocument();

    // ── Step 4: MARK PAID ───────────────────────────────────────────────
    await user.click(within(payoutRow).getByTestId(`button-mark-paid-${payoutId}`));

    const dialog = await screen.findByTestId("dialog-mark-paid");
    const referenceInput = within(dialog).getByTestId("input-reference");
    const notesInput = within(dialog).getByTestId("input-notes");

    await user.type(referenceInput, "UPI-E2E-12345");
    await user.type(notesInput, "settled by e2e");
    await user.click(within(dialog).getByTestId("button-confirm-mark-paid"));

    // Dialog closes, and the row's badge flips to "Paid". The mark-paid
    // action button only renders while status === 'pending', so it must
    // disappear after the flip.
    await waitFor(() => expect(screen.queryByTestId("dialog-mark-paid")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId(`badge-status-${payoutId}`)).toHaveTextContent(/Paid/i),
    );
    expect(screen.queryByTestId(`button-mark-paid-${payoutId}`)).toBeNull();

    // Outstanding stays at ₹0 — the review is now attached to the
    // now-paid payout, not floating unpaid again.
    expect(
      within(screen.getByTestId(`row-coach-${PRO_ID}`)).getByTestId(`text-outstanding-${PRO_ID}`),
    ).toHaveTextContent("₹0");

    // Backend snapshot confirms the mark-paid call persisted reference +
    // notes — protects against the markup-only test passing while the
    // payload silently regresses.
    const snap = backend.snapshot();
    const persisted = snap.payouts.find(p => p.id === payoutId)!;
    expect(persisted.status).toBe("paid");
    expect(persisted.payoutReference).toBe("UPI-E2E-12345");
    expect(persisted.notes).toBe("settled by e2e");
    expect(persisted.paidAt).not.toBeNull();
  });
});

describe("CoachAdminPage — admin email deep link (Task #1223)", () => {
  const PRO_ID = 88;
  const OTHER_PRO_ID = 89;
  const ORIGINAL_URL = "/";

  function buildHandler(coachIds: number[]) {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    const err = (status: number, body: unknown) =>
      Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);
    const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.startsWith("/api/coach-marketplace/admin/coaches")) {
        return ok({
          coaches: coachIds.map(id => ({
            proId: id, displayName: `Coach #${id}`, isActive: true, userId: id + 1000,
            isListed: true, revenueSharePct: 80,
            lifetimeGrossPaise: 0, lifetimeNetPayoutPaise: 0,
            deliveredCount: 0, outstandingGrossPaise: 0, outstandingNetPayoutPaise: 0,
            outstandingCount: 0,
          })),
        });
      }
      if (method === "GET" && url.startsWith("/api/swing-reviews/admin/payouts")) {
        return ok({ payouts: [] });
      }
      // Per-coach payout-account history fetch issued by the dialog itself.
      const histMatch = url.match(/^\/api\/coach-marketplace\/admin\/coaches\/(\d+)\/payout-account\/history/);
      if (method === "GET" && histMatch) {
        return ok({ history: [] });
      }
      return err(404, { error: `unhandled ${method} ${url}` });
    };
    return handler;
  }

  beforeEach(() => {
    // jsdom doesn't ship scrollIntoView; stub it so the deep-link effect's
    // post-paint scroll doesn't blow up.
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", ORIGINAL_URL);
  });

  it("auto-opens the payout-history dialog for ?coach=:proId#payout-history", async () => {
    window.history.replaceState({}, "", `/coach-admin?coach=${PRO_ID}#payout-history`);
    vi.stubGlobal("fetch", vi.fn(buildHandler([OTHER_PRO_ID, PRO_ID])) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    // The targeted coach's row must render and the dialog must open
    // automatically — without the admin clicking the History button.
    await waitFor(() => expect(screen.getByTestId(`row-coach-${PRO_ID}`)).toBeInTheDocument());
    const dialog = await screen.findByTestId("dialog-payout-history");
    expect(within(dialog).getByText(`Coach #${PRO_ID}`)).toBeInTheDocument();

    // Row was scrolled into view (queued via a small post-paint setTimeout).
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("does not open the dialog when the deep link is missing the hash", async () => {
    window.history.replaceState({}, "", `/coach-admin?coach=${PRO_ID}`);
    vi.stubGlobal("fetch", vi.fn(buildHandler([PRO_ID])) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId(`row-coach-${PRO_ID}`)).toBeInTheDocument());

    // No dialog should pop open without the #payout-history hash.
    expect(screen.queryByTestId("dialog-payout-history")).toBeNull();
  });

  it("falls back silently when the deep-linked coach is no longer in the list", async () => {
    window.history.replaceState({}, "", `/coach-admin?coach=99999#payout-history`);
    vi.stubGlobal("fetch", vi.fn(buildHandler([PRO_ID, OTHER_PRO_ID])) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId(`row-coach-${PRO_ID}`)).toBeInTheDocument());

    // Give the deep-link effect a chance to run.
    await new Promise(r => setTimeout(r, 100));

    // No dialog, no error toast.
    expect(screen.queryByTestId("dialog-payout-history")).toBeNull();
    expect(screen.queryByTestId("text-error")).toBeNull();
  });

  // Task #1719 — the hash now optionally carries the chip selection
  // (`#payout-history=admin_reverify`) so the admin re-verify email can
  // open the dialog already filtered to that change kind.
  it("auto-applies the change-type chip from `#payout-history=admin_reverify`", async () => {
    window.history.replaceState(
      {},
      "",
      `/coach-admin?coach=${PRO_ID}#payout-history=admin_reverify`,
    );
    // The chip row only renders when the dialog has at least one entry,
    // so the local handler returns one minimal admin_reverify row for
    // the targeted coach (the shared `buildHandler` returns `[]`).
    const baseHandler = buildHandler([PRO_ID]);
    const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const histMatch = url.match(/^\/api\/coach-marketplace\/admin\/coaches\/(\d+)\/payout-account\/history/);
      if (method === "GET" && histMatch) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            history: [{
              id: 1, proId: PRO_ID, proName: `Coach #${PRO_ID}`,
              changeKind: "admin_reverify", method: "bank_account",
              accountHolderName: `Coach #${PRO_ID}`,
              upiVpaMasked: null, bankAccountLast4: "1234", bankIfsc: "HDFC0000001",
              payoutAccountId: "fa_1",
              changedByUserId: 99, changedByRole: "admin", changedByName: "Admin",
              verificationOutcome: "needs_attention",
              verificationReason: "Bank account is no longer accepting transfers",
              ipAddress: "10.0.0.1", userAgent: "vitest",
              createdAt: "2025-01-13T12:00:00.000Z",
            }],
          }),
        } as Response);
      }
      return baseHandler(input, init);
    };
    vi.stubGlobal("fetch", vi.fn(handler) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId(`row-coach-${PRO_ID}`)).toBeInTheDocument());

    const dialog = await screen.findByTestId("dialog-payout-history");
    // The "Admin re-verifications" chip should be the active one.
    const reverifyChip = await within(dialog).findByTestId(
      "chip-history-filter-admin_reverify",
    );
    expect(reverifyChip.getAttribute("aria-selected")).toBe("true");
    expect(
      within(dialog).getByTestId("chip-history-filter-all").getAttribute("aria-selected"),
    ).toBe("false");
  });
});

describe("CoachAdminPage — payout notification status + resend (Task #1129)", () => {
  let resendCalls: number;
  const PRO_ID = 7;
  const PAYOUT_ID = 501;
  const ATTEMPT_ID = 9001;

  beforeEach(() => {
    resendCalls = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function buildHandler(opts: {
    pushStatus?: string | null;
    pushAttempts?: number;
    pushExhausted?: boolean;
    smsStatus?: string | null;
    smsAttempts?: number;
    smsExhausted?: boolean;
  }) {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    const err = (status: number, body: unknown) =>
      Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);

    const notification = {
      id: ATTEMPT_ID,
      pushStatus: opts.pushStatus ?? null,
      pushAttempts: opts.pushAttempts ?? 0,
      lastPushAt: null,
      lastPushError: opts.pushStatus === "failed" ? "boom" : null,
      pushRetryExhaustedAt: opts.pushExhausted ? new Date().toISOString() : null,
      smsStatus: opts.smsStatus ?? null,
      smsAttempts: opts.smsAttempts ?? 0,
      lastSmsAt: null,
      lastSmsError: opts.smsStatus === "failed" ? "boom" : null,
      smsRetryExhaustedAt: opts.smsExhausted ? new Date().toISOString() : null,
    };
    const payoutRow = {
      payout: {
        id: PAYOUT_ID, proId: PRO_ID, organizationId: 1,
        periodStart: new Date(Date.now() - 7 * 86400_000).toISOString(),
        periodEnd: new Date().toISOString(),
        grossPaise: 50_000, netPayoutPaise: 40_000, platformFeePaise: 10_000,
        status: "paid" as const,
        paidAt: new Date().toISOString(),
        payoutReference: "REF-1129",
        notes: null,
        createdAt: new Date().toISOString(),
      },
      proName: "Notif Coach",
      notification,
    };

    const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.startsWith("/api/coach-marketplace/admin/coaches")) {
        return ok({ coaches: [{
          proId: PRO_ID, displayName: "Notif Coach", isActive: true, userId: 11,
          isListed: true, revenueSharePct: 80,
          lifetimeGrossPaise: 50_000, lifetimeNetPayoutPaise: 40_000,
          deliveredCount: 1, outstandingGrossPaise: 0, outstandingNetPayoutPaise: 0, outstandingCount: 0,
        }] });
      }
      if (method === "GET" && url.startsWith("/api/swing-reviews/admin/payouts") && !url.includes("/resend") && !url.includes("/mark-paid") && !url.endsWith("/run")) {
        return ok({ payouts: [payoutRow] });
      }
      if (method === "POST" && url === `/api/swing-reviews/admin/payouts/${PAYOUT_ID}/resend-notification`) {
        resendCalls += 1;
        // Mirror the backend: reset both push & SMS if they're in a resettable state.
        const resetPush = ["failed", "skipped"].includes(notification.pushStatus ?? "");
        const resetSms = ["failed", "skipped"].includes(notification.smsStatus ?? "");
        if (resetPush) {
          notification.pushStatus = "failed";
          notification.pushAttempts = 0;
          notification.lastPushError = null;
          notification.pushRetryExhaustedAt = null;
        }
        if (resetSms) {
          notification.smsStatus = "failed";
          notification.smsAttempts = 0;
          notification.lastSmsError = null;
          notification.smsRetryExhaustedAt = null;
        }
        return ok({ success: true, resetPush, resetSms });
      }
      return err(404, { error: `unhandled ${method} ${url}` });
    };
    return handler;
  }

  it("renders sent / exhausted / skipped per-channel badges and only shows Resend when something is resettable", async () => {
    vi.stubGlobal("fetch", vi.fn(buildHandler({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      smsStatus: "skipped", smsAttempts: 0,
    })) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-payout-${PAYOUT_ID}`);
    const pushBadge = within(row).getByTestId(`badge-notif-push-${PAYOUT_ID}`);
    const smsBadge = within(row).getByTestId(`badge-notif-sms-${PAYOUT_ID}`);
    expect(pushBadge.getAttribute("data-status")).toBe("exhausted");
    expect(pushBadge).toHaveTextContent(/gave up/i);
    expect(smsBadge.getAttribute("data-status")).toBe("skipped");
    expect(smsBadge).toHaveTextContent(/skipped/i);

    // Resend button is present because at least one channel is resettable.
    expect(within(row).getByTestId(`button-resend-notif-${PAYOUT_ID}`)).toBeInTheDocument();
  });

  it("resets exhausted/skipped channels via the resend button and reflects the new state", async () => {
    vi.stubGlobal("fetch", vi.fn(buildHandler({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      smsStatus: "skipped", smsAttempts: 0,
    })) as unknown as typeof fetch);
    const user = userEvent.setup();

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-payout-${PAYOUT_ID}`);
    const resendBtn = within(row).getByTestId(`button-resend-notif-${PAYOUT_ID}`);
    await user.click(resendBtn);

    await waitFor(() => expect(resendCalls).toBe(1));
    // After reset, both badges should show 'Failed (will retry)' (status=failed, attempts=0).
    await waitFor(() => {
      const updated = screen.getByTestId(`row-payout-${PAYOUT_ID}`);
      expect(within(updated).getByTestId(`badge-notif-push-${PAYOUT_ID}`).getAttribute("data-status")).toBe("failed");
      expect(within(updated).getByTestId(`badge-notif-sms-${PAYOUT_ID}`).getAttribute("data-status")).toBe("failed");
    });
  });

  it("hides the Resend button when both channels are already delivered", async () => {
    vi.stubGlobal("fetch", vi.fn(buildHandler({
      pushStatus: "sent", pushAttempts: 1,
      smsStatus: "sent", smsAttempts: 1,
    })) as unknown as typeof fetch);

    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-payout-${PAYOUT_ID}`);
    expect(within(row).getByTestId(`badge-notif-push-${PAYOUT_ID}`).getAttribute("data-status")).toBe("sent");
    expect(within(row).getByTestId(`badge-notif-sms-${PAYOUT_ID}`).getAttribute("data-status")).toBe("sent");
    expect(within(row).queryByTestId(`button-resend-notif-${PAYOUT_ID}`)).toBeNull();
  });
});

/**
 * Task #1419 — Lock down the inline payout-account verification badge that
 * Task #1221 added to the /coach-admin coaches table.
 *
 * The page maps each coach into one of four labels:
 *   - "verified"        → green   (bg #1a4d2e / fg #86efac), shows "Verified <date>"
 *   - "needs_attention" → amber   (bg #5a3a1a / fg #fcd34d), shows "Last verified <date>"
 *                                                            and the failure reason line
 *   - "pending"         → zinc    (bg #2a2a2a / fg #cbd5e1) — payout method saved
 *                                                            but no verification status yet
 *   - "unconfigured"    → grey    (bg #2a2a2a / fg #9ca3af) — coach has no payout
 *                                                            account at all; "Re-verify now"
 *                                                            button must be DISABLED.
 *
 * The pre-existing component test at the top of this file mocks coaches
 * without any of the new payout-verification fields, so the column
 * rendered here is implicitly exercising "unconfigured" only. This block
 * fans the seed coverage out to all four states and asserts the colours,
 * the verifiedAt / failure-reason side-text, and the Re-verify button's
 * disabled state.
 */
describe("CoachAdminPage — payout-account verification badge column (Task #1419)", () => {
  // Per `payoutVerificationBadgeStyle` in coach-admin.tsx — kept in sync
  // here so any future colour swap surfaces as an explicit test failure.
  const VERIFIED_STYLE       = { bg: "rgb(26, 77, 46)",  fg: "rgb(134, 239, 172)" };
  const NEEDS_ATTENTION_STYLE = { bg: "rgb(90, 58, 26)",  fg: "rgb(252, 211, 77)" };
  const PENDING_STYLE        = { bg: "rgb(42, 42, 42)",  fg: "rgb(203, 213, 225)" };
  const UNCONFIGURED_STYLE   = { bg: "rgb(42, 42, 42)",  fg: "rgb(156, 163, 175)" };

  // proIds are arbitrary but distinct so each row's testids don't collide.
  const PRO_VERIFIED = 201;
  const PRO_NEEDS_ATTENTION = 202;
  const PRO_PENDING = 203;
  const PRO_UNCONFIGURED = 204;

  // Stable ISO date so the "Verified <date>" / "Last verified <date>"
  // renders deterministically.
  const VERIFIED_AT = "2026-03-15T09:30:00.000Z";
  const FAILURE_REASON = "Bank IFSC could not be matched";

  function buildHandler() {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    const err = (status: number, body: unknown) =>
      Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);

    const baseCoach = {
      isActive: true,
      isListed: true,
      revenueSharePct: 80,
      lifetimeGrossPaise: 0,
      lifetimeNetPayoutPaise: 0,
      deliveredCount: 0,
      outstandingGrossPaise: 0,
      outstandingNetPayoutPaise: 0,
      outstandingCount: 0,
    };

    const coaches = [
      {
        ...baseCoach,
        proId: PRO_VERIFIED,
        displayName: "Verified Coach",
        userId: 1001,
        payoutMethod: "upi",
        payoutVerificationStatus: "verified",
        payoutVerifiedAt: VERIFIED_AT,
        payoutVerificationFailureReason: null,
      },
      {
        ...baseCoach,
        proId: PRO_NEEDS_ATTENTION,
        displayName: "Needs Attention Coach",
        userId: 1002,
        payoutMethod: "bank_account",
        payoutVerificationStatus: "needs_attention",
        payoutVerifiedAt: VERIFIED_AT,
        payoutVerificationFailureReason: FAILURE_REASON,
      },
      {
        ...baseCoach,
        proId: PRO_PENDING,
        displayName: "Pending Coach",
        userId: 1003,
        payoutMethod: "upi",
        // Account is saved (payoutMethod set) but the bank validator
        // hasn't returned a verdict yet → "Pending".
        payoutVerificationStatus: null,
        payoutVerifiedAt: null,
        payoutVerificationFailureReason: null,
      },
      {
        ...baseCoach,
        proId: PRO_UNCONFIGURED,
        displayName: "Unconfigured Coach",
        userId: 1004,
        payoutMethod: null,
        payoutVerificationStatus: null,
        payoutVerifiedAt: null,
        payoutVerificationFailureReason: null,
      },
    ];

    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.startsWith("/api/coach-marketplace/admin/coaches")) {
        return ok({ coaches });
      }
      if (method === "GET" && url.startsWith("/api/swing-reviews/admin/payouts")) {
        return ok({ payouts: [] });
      }
      return err(404, { error: `unhandled ${method} ${url}` });
    };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(buildHandler()) as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the right badge text + colour for each of the four states", async () => {
    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    // ── Verified ────────────────────────────────────────────────────────
    const verifiedRow = await screen.findByTestId(`row-coach-${PRO_VERIFIED}`);
    const verifiedBadge = within(verifiedRow).getByTestId(
      `badge-payout-verification-${PRO_VERIFIED}`,
    );
    expect(verifiedBadge).toHaveTextContent("Verified");
    expect(verifiedBadge).toHaveStyle({
      backgroundColor: VERIFIED_STYLE.bg,
      color: VERIFIED_STYLE.fg,
    });

    // ── Needs attention ────────────────────────────────────────────────
    const naRow = screen.getByTestId(`row-coach-${PRO_NEEDS_ATTENTION}`);
    const naBadge = within(naRow).getByTestId(
      `badge-payout-verification-${PRO_NEEDS_ATTENTION}`,
    );
    expect(naBadge).toHaveTextContent("Needs attention");
    expect(naBadge).toHaveStyle({
      backgroundColor: NEEDS_ATTENTION_STYLE.bg,
      color: NEEDS_ATTENTION_STYLE.fg,
    });
    // The badge's tooltip mirrors the failure reason so the admin can
    // see the full text on hover even when the inline truncation hides it.
    expect(naBadge).toHaveAttribute("title", FAILURE_REASON);

    // ── Pending (saved-but-no-status) ──────────────────────────────────
    const pendingRow = screen.getByTestId(`row-coach-${PRO_PENDING}`);
    const pendingBadge = within(pendingRow).getByTestId(
      `badge-payout-verification-${PRO_PENDING}`,
    );
    expect(pendingBadge).toHaveTextContent("Pending");
    expect(pendingBadge).toHaveStyle({
      backgroundColor: PENDING_STYLE.bg,
      color: PENDING_STYLE.fg,
    });

    // ── Unconfigured (no payout account) ───────────────────────────────
    const unconfRow = screen.getByTestId(`row-coach-${PRO_UNCONFIGURED}`);
    const unconfBadge = within(unconfRow).getByTestId(
      `badge-payout-verification-${PRO_UNCONFIGURED}`,
    );
    expect(unconfBadge).toHaveTextContent("Not configured");
    expect(unconfBadge).toHaveStyle({
      backgroundColor: UNCONFIGURED_STYLE.bg,
      color: UNCONFIGURED_STYLE.fg,
    });
  });

  it("shows the verifiedAt date only for verified + needs_attention rows", async () => {
    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const expectedDate = new Date(VERIFIED_AT).toLocaleDateString();

    // Verified row → "Verified <date>"
    const verifiedRow = await screen.findByTestId(`row-coach-${PRO_VERIFIED}`);
    const verifiedAtText = within(verifiedRow).getByTestId(
      `text-payout-verified-at-${PRO_VERIFIED}`,
    );
    expect(verifiedAtText).toHaveTextContent(`Verified ${expectedDate}`);

    // Needs-attention row → "Last verified <date>"
    const naRow = screen.getByTestId(`row-coach-${PRO_NEEDS_ATTENTION}`);
    const naAtText = within(naRow).getByTestId(
      `text-payout-verified-at-${PRO_NEEDS_ATTENTION}`,
    );
    expect(naAtText).toHaveTextContent(`Last verified ${expectedDate}`);

    // Pending + unconfigured rows → no verifiedAt line at all.
    expect(
      within(screen.getByTestId(`row-coach-${PRO_PENDING}`))
        .queryByTestId(`text-payout-verified-at-${PRO_PENDING}`),
    ).toBeNull();
    expect(
      within(screen.getByTestId(`row-coach-${PRO_UNCONFIGURED}`))
        .queryByTestId(`text-payout-verified-at-${PRO_UNCONFIGURED}`),
    ).toBeNull();
  });

  it("shows the failure reason inline only for the needs_attention row", async () => {
    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const naRow = await screen.findByTestId(`row-coach-${PRO_NEEDS_ATTENTION}`);
    const reason = within(naRow).getByTestId(
      `text-payout-failure-reason-${PRO_NEEDS_ATTENTION}`,
    );
    expect(reason).toHaveTextContent(FAILURE_REASON);
    // The full reason is also exposed via the title attr so the truncated
    // span reveals it on hover.
    expect(reason).toHaveAttribute("title", FAILURE_REASON);

    // The other three rows must NOT render a failure-reason line.
    for (const proId of [PRO_VERIFIED, PRO_PENDING, PRO_UNCONFIGURED]) {
      expect(
        within(screen.getByTestId(`row-coach-${proId}`))
          .queryByTestId(`text-payout-failure-reason-${proId}`),
      ).toBeNull();
    }
  });

  it("disables the Re-verify button only when no payout account is saved", async () => {
    render(<CoachAdminPage />);
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    // Rows with a saved payoutMethod → button is enabled.
    for (const proId of [PRO_VERIFIED, PRO_NEEDS_ATTENTION, PRO_PENDING]) {
      const btn = within(await screen.findByTestId(`row-coach-${proId}`))
        .getByTestId(`button-reverify-payout-${proId}`) as HTMLButtonElement;
      expect(btn).toBeEnabled();
    }

    // The unconfigured row → button is disabled with the explanatory tooltip.
    const unconfBtn = within(screen.getByTestId(`row-coach-${PRO_UNCONFIGURED}`))
      .getByTestId(`button-reverify-payout-${PRO_UNCONFIGURED}`) as HTMLButtonElement;
    expect(unconfBtn).toBeDisabled();
    expect(unconfBtn).toHaveAttribute(
      "title",
      "Coach has not saved a payout account yet",
    );
  });
});

/**
 * Task #1710 — Cover the click flow of the /coach-admin "Re-verify now"
 * button. Task #1419 nailed down rendering + the disabled state, but the
 * actual POST → toast outcome mapping (verified / needs_attention /
 * skipped / unknown fallback) and the in-flight "Re-verifying…" label
 * had no UI-level coverage, so a regression in
 * `reverifyPayoutAccount` could only be caught by humans.
 *
 * Each test below stubs `fetch` so the reverify endpoint returns a
 * specific outcome shape, then clicks `button-reverify-payout-{proId}`
 * and asserts the toast text / variant the page distinguishes:
 *
 *   - `verified`        → default (non-destructive) success toast
 *                         "Payout account re-verified".
 *   - `needs_attention` → destructive toast "Re-verification failed"
 *                         carrying the supplied failure reason.
 *   - `skipped`         → default informational toast
 *                         "Re-verification pending".
 *   - anything else     → destructive fallback "Re-verification error".
 *
 * A separate test holds the reverify response in a deferred promise so
 * we can verify the button shows "Re-verifying…" mid-flight before the
 * server replies.
 */
describe("CoachAdminPage — admin Re-verify-now click flow + toast outcomes (Task #1710)", () => {
  const PRO_ID = 301;
  const COACH_NAME = "Reverify Coach";

  function buildBackend(opts: {
    /** Concrete response to return synchronously from the reverify endpoint. */
    reverifyResponse?: { status: number; body: unknown };
    /**
     * Promise the reverify endpoint should await before resolving — used
     * to keep the request in-flight while the test asserts the pending
     * "Re-verifying…" label.
     */
    reverifyPending?: Promise<{ status: number; body: unknown }>;
  }) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    const err = (status: number, body: unknown) =>
      Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);
    const respond = (r: { status: number; body: unknown }) =>
      ({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: () => Promise.resolve(r.body),
      } as Response);

    const coachesPayload = () => ({
      coaches: [{
        proId: PRO_ID,
        displayName: COACH_NAME,
        isActive: true,
        userId: 9001,
        isListed: true,
        revenueSharePct: 80,
        lifetimeGrossPaise: 0,
        lifetimeNetPayoutPaise: 0,
        deliveredCount: 0,
        outstandingGrossPaise: 0,
        outstandingNetPayoutPaise: 0,
        outstandingCount: 0,
        // Saved payout account so the Re-verify button is enabled
        // (the disabled-when-unconfigured branch is already covered by
        // the Task #1419 block above).
        payoutMethod: "upi",
        payoutVerificationStatus: "needs_attention",
        payoutVerifiedAt: "2026-03-15T09:30:00.000Z",
        payoutVerificationFailureReason: "Initial failure",
      }],
    });

    const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};

      if (method === "GET" && url.startsWith("/api/coach-marketplace/admin/coaches")) {
        return ok(coachesPayload());
      }
      if (method === "GET" && url.startsWith("/api/swing-reviews/admin/payouts")) {
        return ok({ payouts: [] });
      }

      const reverifyMatch = url.match(
        /^\/api\/coach-marketplace\/admin\/coaches\/(\d+)\/payout-account\/reverify$/,
      );
      if (method === "POST" && reverifyMatch) {
        calls.push({ url, method, body: parsedBody });
        if (opts.reverifyPending) {
          return opts.reverifyPending.then(respond);
        }
        if (opts.reverifyResponse) {
          return Promise.resolve(respond(opts.reverifyResponse));
        }
        return err(500, { error: "no reverify response configured for this test" });
      }

      return err(404, { error: `unhandled ${method} ${url}` });
    };
    return { handler, calls };
  }

  function renderPage() {
    return render(
      <>
        <CoachAdminPage />
        <Toaster />
      </>,
    );
  }

  /**
   * Shared assertion every outcome test runs after the click resolves —
   * the page must POST to the documented reverify endpoint exactly once,
   * regardless of which outcome the backend returns. Centralising it
   * here makes the URL/method contract a hard requirement for the whole
   * outcome matrix instead of just the happy path.
   */
  function expectReverifyRequest(calls: Array<{ url: string; method: string; body: unknown }>) {
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      `/api/coach-marketplace/admin/coaches/${PRO_ID}/payout-account/reverify`,
    );
    expect(calls[0]!.method).toBe("POST");
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("verified outcome → success toast and POSTs to /payout-account/reverify", async () => {
    const backend = buildBackend({
      reverifyResponse: { status: 200, body: { outcome: "verified" } },
    });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    await user.click(within(row).getByTestId(`button-reverify-payout-${PRO_ID}`));

    // Documented success copy — title + coach-personalised description.
    await screen.findByText("Payout account re-verified");
    expect(screen.getByText(`${COACH_NAME}'s account is active.`)).toBeInTheDocument();

    // Right URL + method.
    expectReverifyRequest(backend.calls);
  });

  it("needs_attention outcome → destructive toast carrying the failure reason", async () => {
    const reason = "Bank rejected: name mismatch";
    const backend = buildBackend({
      reverifyResponse: { status: 200, body: { outcome: "needs_attention", reason } },
    });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    await user.click(within(row).getByTestId(`button-reverify-payout-${PRO_ID}`));

    await screen.findByText("Re-verification failed");
    const description = await screen.findByText(reason);
    // Walk up to the root <li> Toast element so we can confirm the
    // destructive variant class lives on the rendered toast — this
    // protects the "destructive" mapping for needs_attention from
    // silently flipping to a default toast.
    const toastRoot = description.closest("li");
    expect(toastRoot).not.toBeNull();
    expect(toastRoot!.className).toMatch(/destructive/);

    // Same endpoint contract regardless of outcome — re-asserted per
    // outcome so a regression that, say, only mis-routes the destructive
    // path can't slip through behind the success-path coverage.
    expectReverifyRequest(backend.calls);
  });

  it("skipped outcome → informational (non-destructive) toast with the supplied reason", async () => {
    const reason = "Validation cron is still running";
    const backend = buildBackend({
      reverifyResponse: { status: 200, body: { outcome: "skipped", reason } },
    });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    await user.click(within(row).getByTestId(`button-reverify-payout-${PRO_ID}`));

    await screen.findByText("Re-verification pending");
    const description = await screen.findByText(reason);
    const toastRoot = description.closest("li");
    expect(toastRoot).not.toBeNull();
    // Skipped is treated as informational, NOT destructive.
    expect(toastRoot!.className).not.toMatch(/destructive/);

    expectReverifyRequest(backend.calls);
  });

  it("unknown outcome → destructive fallback toast that surfaces the raw outcome", async () => {
    const backend = buildBackend({
      // Outcome the page doesn't recognise — `reason` deliberately
      // omitted so the fallback path renders the raw outcome string.
      reverifyResponse: { status: 200, body: { outcome: "weird_state" } },
    });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    await user.click(within(row).getByTestId(`button-reverify-payout-${PRO_ID}`));

    await screen.findByText("Re-verification error");
    const description = await screen.findByText("weird_state");
    const toastRoot = description.closest("li");
    expect(toastRoot).not.toBeNull();
    expect(toastRoot!.className).toMatch(/destructive/);

    expectReverifyRequest(backend.calls);
  });

  it("shows the 'Re-verifying…' label while the request is in flight, then snaps back", async () => {
    let resolveReverify!: (v: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>(r => {
      resolveReverify = r;
    });
    const backend = buildBackend({ reverifyPending: pending });
    vi.stubGlobal("fetch", vi.fn(backend.handler) as unknown as typeof fetch);
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-coach-admin")).toBeInTheDocument());

    const row = await screen.findByTestId(`row-coach-${PRO_ID}`);
    const btn = within(row).getByTestId(`button-reverify-payout-${PRO_ID}`) as HTMLButtonElement;

    // Idle state — default label, button enabled.
    expect(btn).toHaveTextContent(/Re-verify now/i);
    expect(btn).toBeEnabled();

    await user.click(btn);

    // While the deferred promise is unresolved, the button must flip to
    // the pending label AND become disabled so the admin can't fire
    // multiple concurrent re-verifications.
    await waitFor(() => expect(btn).toHaveTextContent(/Re-verifying…/));
    expect(btn).toBeDisabled();

    // The request must already be in flight (POST to the documented URL)
    // even though the response hasn't landed yet.
    expectReverifyRequest(backend.calls);

    // Resolve and confirm the label rolls back AFTER the request lands
    // and the button is re-enabled for another attempt.
    resolveReverify({ status: 200, body: { outcome: "verified" } });
    await waitFor(() => expect(btn).toHaveTextContent(/Re-verify now/i));
    expect(btn).toBeEnabled();
    // And the success toast still fires once the request resolves —
    // makes sure clearing the pending state doesn't short-circuit the
    // outcome mapping.
    await screen.findByText("Payout account re-verified");
  });
});
