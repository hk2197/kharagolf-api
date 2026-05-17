/**
 * UI test: "Bounced again on <date>" sub-line on Member 360 audit timeline
 * (Task #1928).
 *
 * Mounts <AuditTab /> with a mocked fetch that returns three audit rows:
 *   - a reenable row whose API payload includes a `subsequentBounce`
 *     summary → the timeline must render a tagged "Bounced again on
 *     <date>" annotation with hover detail (reason + bounceType +
 *     description).
 *   - a reenable_with_replacement row with no follow-up bounce →
 *     `subsequentBounce: null` → no annotation rendered.
 *   - a profile row → no annotation rendered (sanity check).
 *
 * Regression guard: if the AuditTab dropped the subsequentBounce branch
 * or moved its data-testid, this test would fail and admins would lose
 * the inline visibility into whether their re-enable fix actually stuck.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { AuditTab } from "../member-360";

const ORG_ID = 9;
const MEMBER_ID = 17;
const BASE = `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}`;

const REBOUNCE_AUDIT_ID = 7001;
const CLEAN_REENABLE_AUDIT_ID = 7002;
const PROFILE_AUDIT_ID = 7003;

const reenableAt = "2026-01-10T10:00:00Z";
const bounceAt = "2026-01-12T08:30:00Z";

interface AuditFixture {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  fieldChanges: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  ipAddress: string | null;
  linkedLevyId: number | null;
  linkedChargeId: number | null;
  linkedDataRequestId: number | null;
  linkedDataRequestType: string | null;
  receiptLevyId: number | null;
  receiptStatus: "sent" | "skipped" | "failed" | null;
  receiptReason: string | null;
  receiptKind: "payment" | "partial_payment" | "refund" | "waiver" | null;
  receiptAmount: string | null;
  receiptAt: string | null;
  subsequentBounce?: {
    email: string;
    at: string;
    reason: string;
    bounceType: string | null;
    description: string | null;
  } | null;
}

function fixtures(): AuditFixture[] {
  return [
    {
      id: REBOUNCE_AUDIT_ID,
      entity: "email_suppression",
      entityId: 555,
      action: "reenable_with_replacement",
      actorName: "Alex Admin",
      actorRole: "org_admin",
      reason: "Re-enabled after bounce — replaced suppressed address",
      fieldChanges: null,
      metadata: { oldEmail: "typo@exmaple.com", replacementEmail: "fixed@example.com" },
      createdAt: reenableAt,
      ipAddress: null,
      linkedLevyId: null, linkedChargeId: null,
      linkedDataRequestId: null, linkedDataRequestType: null,
      receiptLevyId: null, receiptStatus: null,
      receiptReason: null, receiptKind: null, receiptAmount: null, receiptAt: null,
      subsequentBounce: {
        email: "fixed@example.com",
        at: bounceAt,
        reason: "bounced",
        bounceType: "HardBounce",
        description: "Mailbox is full",
      },
    },
    {
      id: CLEAN_REENABLE_AUDIT_ID,
      entity: "email_suppression",
      entityId: 556,
      action: "reenable",
      actorName: "Alex Admin",
      actorRole: "org_admin",
      reason: "Re-enabled after bounce",
      fieldChanges: null,
      metadata: { oldEmail: "ok@example.com" },
      createdAt: "2026-01-09T12:00:00Z",
      ipAddress: null,
      linkedLevyId: null, linkedChargeId: null,
      linkedDataRequestId: null, linkedDataRequestType: null,
      receiptLevyId: null, receiptStatus: null,
      receiptReason: null, receiptKind: null, receiptAmount: null, receiptAt: null,
      subsequentBounce: null,
    },
    {
      id: PROFILE_AUDIT_ID,
      entity: "profile",
      entityId: 1,
      action: "update",
      actorName: "Alex Admin",
      actorRole: "org_admin",
      reason: "profile updated",
      fieldChanges: null,
      metadata: null,
      createdAt: "2026-01-08T08:00:00Z",
      ipAddress: null,
      linkedLevyId: null, linkedChargeId: null,
      linkedDataRequestId: null, linkedDataRequestType: null,
      receiptLevyId: null, receiptStatus: null,
      receiptReason: null, receiptKind: null, receiptAmount: null, receiptAt: null,
      subsequentBounce: null,
    },
  ];
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audit-log")) {
      return new Response(JSON.stringify(fixtures()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
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
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AuditTab /> — subsequentBounce indicator", () => {
  it("renders 'Bounced again on <date>' under the re-enable row when a follow-up bounce arrived", async () => {
    renderTab();
    await screen.findByTestId(`audit-entry-${REBOUNCE_AUDIT_ID}`);

    const indicator = screen.getByTestId(`audit-subsequent-bounce-${REBOUNCE_AUDIT_ID}`);
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/Bounced again on/i);
    // Bounce type is appended after the date for a quick scan.
    expect(indicator).toHaveTextContent(/HardBounce/);
    // Date is rendered using the locale; the year must be present at minimum.
    expect(indicator).toHaveTextContent(/2026/);
  });

  it("encodes the bounce reason / bounceType / description in the hover tooltip", async () => {
    renderTab();
    await screen.findByTestId(`audit-entry-${REBOUNCE_AUDIT_ID}`);

    const indicator = screen.getByTestId(`audit-subsequent-bounce-${REBOUNCE_AUDIT_ID}`);
    const tip = indicator.getAttribute("title") ?? "";
    expect(tip).toMatch(/Address: fixed@example.com/);
    expect(tip).toMatch(/Bounce type: HardBounce/);
    expect(tip).toMatch(/Reason: bounced/);
    expect(tip).toMatch(/Mailbox is full/);
  });

  it("does NOT render the indicator on a re-enable row whose subsequentBounce is null", async () => {
    renderTab();
    await screen.findByTestId(`audit-entry-${CLEAN_REENABLE_AUDIT_ID}`);

    expect(
      screen.queryByTestId(`audit-subsequent-bounce-${CLEAN_REENABLE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the indicator on unrelated entities", async () => {
    renderTab();
    await screen.findByTestId(`audit-entry-${PROFILE_AUDIT_ID}`);

    expect(
      screen.queryByTestId(`audit-subsequent-bounce-${PROFILE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
  });
});
