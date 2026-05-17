/**
 * UI test: Receipt-status badges + resend shortcut on the Member 360 audit
 * timeline (Task #253 / #291).
 *
 * Mounts <AuditTab /> with a mocked fetch that returns one of each receipt
 * outcome (sent / skipped / failed) plus a non-levy row. Asserts:
 *   - the corresponding Sent / Skipped / Failed badges render
 *   - the resend button only appears for skipped/failed rows (not for sent
 *     or non-levy rows)
 *   - clicking the button POSTs to
 *     /api/organizations/:orgId/members-360/levies/:receiptLevyId/charges/:memberId/resend-receipt
 *
 * Regression guard: if the AuditTab badge mapping or the resend URL were
 * changed, this test would fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { AuditTab } from "../member-360";

interface AuditFixture {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  fieldChanges: Record<string, unknown> | null;
  createdAt: string;
  ipAddress: string | null;
  linkedLevyId: number | null;
  linkedChargeId: number | null;
  receiptLevyId: number | null;
  receiptStatus: "sent" | "skipped" | "failed" | null;
  receiptReason: string | null;
  receiptKind: "payment" | "partial_payment" | "refund" | "waiver" | null;
  receiptAmount: string | null;
  receiptAt: string | null;
}

const ORG_ID = 42;
const MEMBER_ID = 7;
const BASE = `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}`;

const SENT_AUDIT_ID = 1001;
const SKIPPED_AUDIT_ID = 1002;
const FAILED_AUDIT_ID = 1003;
const PROFILE_AUDIT_ID = 1004;

const SENT_CHARGE_ID = 501;
const SKIPPED_CHARGE_ID = 502;
const FAILED_CHARGE_ID = 503;

const SENT_LEVY_ID = 9001;
const SKIPPED_LEVY_ID = 9002;
const FAILED_LEVY_ID = 9003;

function fixtures(): AuditFixture[] {
  const ts = new Date("2026-01-01T10:00:00Z").toISOString();
  return [
    {
      id: SENT_AUDIT_ID, entity: "levy_charge", entityId: SENT_CHARGE_ID, action: "update",
      actorName: "Admin", actorRole: "org_admin", reason: "payment recorded",
      fieldChanges: null, createdAt: ts, ipAddress: null,
      linkedLevyId: SENT_LEVY_ID, linkedChargeId: SENT_CHARGE_ID,
      receiptLevyId: SENT_LEVY_ID, receiptStatus: "sent",
      receiptReason: null, receiptKind: "payment", receiptAmount: "100.00", receiptAt: ts,
    },
    {
      id: SKIPPED_AUDIT_ID, entity: "levy_charge", entityId: SKIPPED_CHARGE_ID, action: "update",
      actorName: "Admin", actorRole: "org_admin", reason: "payment recorded",
      fieldChanges: null, createdAt: ts, ipAddress: null,
      linkedLevyId: SKIPPED_LEVY_ID, linkedChargeId: SKIPPED_CHARGE_ID,
      receiptLevyId: SKIPPED_LEVY_ID, receiptStatus: "skipped",
      receiptReason: "no_email", receiptKind: "payment", receiptAmount: "50.00", receiptAt: ts,
    },
    {
      id: FAILED_AUDIT_ID, entity: "levy_charge", entityId: FAILED_CHARGE_ID, action: "update",
      actorName: "Admin", actorRole: "org_admin", reason: "payment recorded",
      fieldChanges: null, createdAt: ts, ipAddress: null,
      linkedLevyId: FAILED_LEVY_ID, linkedChargeId: FAILED_CHARGE_ID,
      receiptLevyId: FAILED_LEVY_ID, receiptStatus: "failed",
      receiptReason: "smtp boom", receiptKind: "partial_payment", receiptAmount: "25.00", receiptAt: ts,
    },
    {
      id: PROFILE_AUDIT_ID, entity: "profile", entityId: 1, action: "update",
      actorName: "Admin", actorRole: "org_admin", reason: "profile updated",
      fieldChanges: null, createdAt: ts, ipAddress: null,
      linkedLevyId: null, linkedChargeId: null,
      receiptLevyId: null, receiptStatus: null,
      receiptReason: null, receiptKind: null, receiptAmount: null, receiptAt: null,
    },
  ];
}

interface FetchHandler {
  resendCalls: Array<{ url: string; method: string }>;
}
let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audit-log")) {
      return new Response(JSON.stringify(fixtures()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/resend-receipt") && init?.method === "POST") {
      handler.resendCalls.push({ url, method: init.method });
      return new Response(JSON.stringify({
        chargeId: FAILED_CHARGE_ID,
        receipt: { status: "sent", reason: null, kind: "partial_payment", amount: "25.00", at: new Date().toISOString() },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuditTab base={BASE} orgId={ORG_ID} memberId={MEMBER_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = { resendCalls: [] };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AuditTab /> — receipt-status column", () => {
  it("renders Sent / Skipped / Failed badges next to levy_charge audit rows", async () => {
    renderTab();

    // Wait for the audit rows to render
    await screen.findByTestId(`audit-entry-${SENT_AUDIT_ID}`);

    const sentBadge = screen.getByTestId(`audit-receipt-status-${SENT_AUDIT_ID}`);
    expect(sentBadge).toHaveTextContent(/Receipt sent/i);

    const skippedBadge = screen.getByTestId(`audit-receipt-status-${SKIPPED_AUDIT_ID}`);
    expect(skippedBadge).toHaveTextContent(/Receipt skipped/i);

    const failedBadge = screen.getByTestId(`audit-receipt-status-${FAILED_AUDIT_ID}`);
    expect(failedBadge).toHaveTextContent(/Receipt failed/i);

    // Non-levy row must not get a receipt badge
    expect(
      screen.queryByTestId(`audit-receipt-status-${PROFILE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
  });

  it("only shows the resend button for failed/skipped receipts (not sent or non-levy)", async () => {
    renderTab();
    await screen.findByTestId(`audit-entry-${SENT_AUDIT_ID}`);

    expect(screen.getByTestId(`button-audit-resend-receipt-${SKIPPED_AUDIT_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`button-audit-resend-receipt-${FAILED_AUDIT_ID}`)).toBeInTheDocument();
    expect(
      screen.queryByTestId(`button-audit-resend-receipt-${SENT_AUDIT_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`button-audit-resend-receipt-${PROFILE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
  });

  it("clicking resend POSTs to /levies/:receiptLevyId/charges/:memberId/resend-receipt", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId(`audit-entry-${FAILED_AUDIT_ID}`);

    await user.click(screen.getByTestId(`button-audit-resend-receipt-${FAILED_AUDIT_ID}`));

    await waitFor(() => expect(handler.resendCalls.length).toBe(1));
    const expected = `/api/organizations/${ORG_ID}/members-360/levies/${FAILED_LEVY_ID}/charges/${MEMBER_ID}/resend-receipt`;
    expect(handler.resendCalls[0].url).toBe(expected);
    expect(handler.resendCalls[0].method).toBe("POST");

    // Success toast
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Receipt resent/i),
      }));
    });
  });
});
