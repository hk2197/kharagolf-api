/**
 * Component test: Rejection delivery breakdown surfaced to staff (Task #397).
 *
 * Task #345 added per-channel delivery chips to:
 *   1. The toast staff sees right after rejecting a document from the
 *      pending-documents queue, and
 *   2. The persisted "Notification delivery" chip row inside the rejection
 *      callout on Member 360, so staff can re-check what went out per channel
 *      after navigating away from the queue.
 *
 * This file mounts the relevant components against mocked endpoints and
 * verifies:
 *
 *   - Rejecting from <DocumentsPendingPage /> renders per-channel chips
 *     (in-app/email/push/SMS/WhatsApp) inside the toast description with the
 *     correct sent/failed/skipped statuses returned by the API.
 *   - The same rejection persists its delivery breakdown to sessionStorage so
 *     the Member 360 <DocumentsTab /> rejection callout renders the
 *     "Notification delivery" chip row when staff opens the member afterwards.
 *   - A provider-not-configured channel response renders as a neutral
 *     `skipped` chip rather than a red `failed` chip in both surfaces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "org_admin" } }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgContext: () => ({
    activeOrgId: 42,
    isOrgOverridden: false,
    setActiveOrg: () => {},
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Imported AFTER the mocks above so the modules pick up the mocked deps.
import DocumentsPendingPage from "../documents-pending";
import { DocumentsTab } from "../member-360";
import {
  RejectionDeliveryChips,
  type RejectionNotification,
} from "@/components/RejectionDeliveryChips";

const ORG_ID = 42;
const MEMBER_ID = 555;
const DOC_ID = 9999;

interface PendingDoc {
  id: number;
  clubMemberId: number;
  documentType: string;
  title: string;
  fileUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  expiresAt: string | null;
  uploadedByUserId: number | null;
  uploadedByDisplayName: string | null;
  uploadedByUsername: string | null;
  uploadedByEmail: string | null;
  createdAt: string;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
}

const PENDING_DOC: PendingDoc = {
  id: DOC_ID,
  clubMemberId: MEMBER_ID,
  documentType: "id_proof",
  title: "Driver's License",
  fileUrl: "https://example.com/dl.pdf",
  mimeType: "application/pdf",
  fileSize: 12345,
  expiresAt: null,
  uploadedByUserId: null,
  uploadedByDisplayName: null,
  uploadedByUsername: null,
  uploadedByEmail: null,
  createdAt: new Date().toISOString(),
  memberFirstName: "Mary",
  memberLastName: "Member",
  memberNumber: "M001",
};

// Mixed-status response: in-app + email succeed, push fails, SMS is provider-
// not-configured (must collapse to neutral `skipped`), WhatsApp opted-out.
const REJECT_NOTIFICATION: RejectionNotification = {
  inAppMessageId: 7,
  emailStatus: "sent",
  pushStatus: "failed",
  pushError: "fcm token expired",
  smsStatus: "skipped",
  smsError: "provider_not_configured",
  whatsappStatus: "opted_out",
};

interface PendingFetchState {
  /** Body returned for the next reject PATCH. */
  rejectResponse: { id: number; notification: RejectionNotification };
  /** Captured PATCH bodies so we can assert the reason was forwarded. */
  rejectRequests: Array<{ url: string; body: unknown }>;
}

let state: PendingFetchState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/documents/pending")) {
      return new Response(
        JSON.stringify({ count: 1, documents: [PENDING_DOC], uploaders: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      method === "PATCH" &&
      url.endsWith(
        `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}/documents/${DOC_ID}/reject`,
      )
    ) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      state.rejectRequests.push({ url, body });
      return new Response(JSON.stringify(state.rejectResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function renderQueue() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentsPendingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  state = { rejectResponse: { id: DOC_ID, notification: REJECT_NOTIFICATION }, rejectRequests: [] };
  installFetch();
  if (typeof window !== "undefined") window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Renders the JSX captured from the most recent `toast()` description so we
 *  can assert chip nodes inside it. The pending-queue's reject toast renders a
 *  <RejectionDeliveryChips /> inside `description`, so this lets us locate
 *  the chips even though the Toaster itself is not mounted in the test. */
function renderToastDescription() {
  const lastCall = toastMock.mock.calls.find(
    (call) => call[0]?.title === "Document rejected",
  );
  expect(lastCall, "rejection toast was emitted").toBeTruthy();
  const description = lastCall![0].description as ReactNode;
  return render(<div data-testid="rendered-toast">{description}</div>);
}

describe("Pending-queue rejection — per-channel delivery chips in the toast", () => {
  it("renders sent/failed/skipped chips for every channel after a successful reject", async () => {
    const user = userEvent.setup();
    renderQueue();

    // Wait for the queue row to load before clicking Reject.
    await screen.findByText("Driver's License");

    await user.click(screen.getByTestId(`button-reject-${DOC_ID}`));
    await user.type(
      screen.getByTestId("textarea-reject-reason"),
      "Photo is blurry — please re-upload.",
    );
    await user.click(screen.getByTestId("button-confirm-reject"));

    // The rejection PATCH was issued with the typed reason.
    await waitFor(() => expect(state.rejectRequests.length).toBe(1));
    expect(state.rejectRequests[0].body).toEqual({
      reason: "Photo is blurry — please re-upload.",
    });

    // The success toast was emitted with our expected title and a JSX
    // description containing the per-channel chips.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Document rejected" }),
      );
    });

    // Render the captured description so we can query chip nodes inside it.
    const { getByTestId } = renderToastDescription();
    const prefix = `toast-rej-${DOC_ID}`;
    const chipRow = getByTestId(`${prefix}-chips`);

    // In-app: succeeded (the helper persisted a member_messages row).
    expect(within(chipRow).getByTestId(`${prefix}-inapp`)).toHaveTextContent(
      /In-app: sent/i,
    );

    // Email: succeeded.
    const emailChip = within(chipRow).getByTestId(`${prefix}-email`);
    expect(emailChip).toHaveTextContent(/Email: sent/i);
    expect(emailChip).toHaveAttribute("data-status", "sent");

    // Push: failed — must surface as red `failed` chip with the channel error.
    const pushChip = within(chipRow).getByTestId(`${prefix}-push`);
    expect(pushChip).toHaveTextContent(/Push: failed/i);
    expect(pushChip).toHaveAttribute("data-status", "failed");
    expect(pushChip.className).toMatch(/text-red-300/);

    // SMS: provider not configured → must collapse to neutral `skipped`.
    const smsChip = within(chipRow).getByTestId(`${prefix}-sms`);
    expect(smsChip).toHaveTextContent(/SMS: skipped/i);
    expect(smsChip).toHaveAttribute("data-status", "skipped");
    expect(smsChip.className).not.toMatch(/text-red-300/);
    expect(smsChip.className).toMatch(/text-white\/60/);

    // WhatsApp: opted-out → neutral chip, not red.
    const waChip = within(chipRow).getByTestId(`${prefix}-whatsapp`);
    expect(waChip).toHaveTextContent(/WhatsApp: opted out/i);
    expect(waChip).toHaveAttribute("data-status", "opted_out");
    expect(waChip.className).not.toMatch(/text-red-300/);
  });

  it("persists the delivery breakdown to sessionStorage so Member 360 can recover it", async () => {
    const user = userEvent.setup();
    renderQueue();

    await screen.findByText("Driver's License");
    await user.click(screen.getByTestId(`button-reject-${DOC_ID}`));
    await user.type(screen.getByTestId("textarea-reject-reason"), "needs fix");
    await user.click(screen.getByTestId("button-confirm-reject"));

    await waitFor(() => expect(state.rejectRequests.length).toBe(1));

    // The pending-queue handler calls recordDocRejectionDelivery() so the
    // Member 360 callout chip can re-hydrate this on the next page load.
    await waitFor(() => {
      const raw = window.sessionStorage.getItem("kg.docRejectionDelivery.v1");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed[String(DOC_ID)]?.notification).toMatchObject({
        emailStatus: "sent",
        pushStatus: "failed",
        smsStatus: "skipped",
        smsError: "provider_not_configured",
        whatsappStatus: "opted_out",
      });
    });
  });
});

// --- Member 360 rejection callout — persisted "Notification delivery" row ---

interface DocFixture {
  id: number;
  documentType: string;
  title: string;
  fileUrl: string;
  isVerified: boolean;
  expiresAt: string | null;
  createdAt: string;
  uploadedByUserId: number | null;
  uploadedByDisplayName: string | null;
  uploadedByUsername: string | null;
  uploadedByEmail: string | null;
  isRejected: boolean;
  rejectedAt: string | null;
  rejectedByUserId: number | null;
  rejectionReason: string | null;
  rejectedByDisplayName: string | null;
}

const REJECTED_DOC: DocFixture = {
  id: DOC_ID,
  documentType: "id_proof",
  title: "Driver's License",
  fileUrl: "https://example.com/dl.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-15T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-15T11:00:00.000Z",
  rejectedByUserId: 8,
  rejectionReason: "Photo is blurry — please re-upload.",
  rejectedByDisplayName: "Sam Staff",
};

const TAB_BASE = `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}`;

function installDocsTabFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(`${TAB_BASE}/documents`)) {
      return new Response(JSON.stringify([REJECTED_DOC]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/documents\/\d+\/versions$/.test(url)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function renderDocsTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentsTab base={TAB_BASE} />
    </QueryClientProvider>,
  );
}

describe("Member 360 rejection callout — persisted delivery chips", () => {
  it("renders the 'Notification delivery' chip row when sessionStorage has the breakdown", async () => {
    // Simulate the staff session having just rejected this doc from the queue.
    window.sessionStorage.setItem(
      "kg.docRejectionDelivery.v1",
      JSON.stringify({
        [String(DOC_ID)]: {
          notification: REJECT_NOTIFICATION,
          rejectedAt: new Date().toISOString(),
        },
      }),
    );
    installDocsTabFetch();
    renderDocsTab();

    // Rejection callout for the doc must render.
    const callout = await screen.findByTestId(`doc-rejection-${DOC_ID}`);
    // The persisted breakdown header is rendered inside the callout.
    expect(within(callout).getByText(/Notification delivery/i)).toBeInTheDocument();

    const prefix = `doc-rejection-delivery-${DOC_ID}`;
    const chipRow = within(callout).getByTestId(`${prefix}-chips`);

    // Same channels as captured at rejection time.
    expect(within(chipRow).getByTestId(`${prefix}-inapp`)).toHaveTextContent(
      /In-app: sent/i,
    );
    expect(within(chipRow).getByTestId(`${prefix}-email`)).toHaveTextContent(
      /Email: sent/i,
    );

    // Provider-not-configured SMS surfaces as a neutral `skipped` chip in the
    // persisted callout too — never red `failed`.
    const smsChip = within(chipRow).getByTestId(`${prefix}-sms`);
    expect(smsChip).toHaveAttribute("data-status", "skipped");
    expect(smsChip).toHaveTextContent(/SMS: skipped/i);
    expect(smsChip.className).not.toMatch(/text-red-300/);

    const pushChip = within(chipRow).getByTestId(`${prefix}-push`);
    expect(pushChip).toHaveAttribute("data-status", "failed");
    expect(pushChip.className).toMatch(/text-red-300/);
  });

  it("renders nothing in the callout when sessionStorage has no breakdown for this doc", async () => {
    // No sessionStorage seed — staff arrived from a fresh tab without ever
    // running the rejection in this session, so the chip row must stay hidden.
    installDocsTabFetch();
    renderDocsTab();

    const callout = await screen.findByTestId(`doc-rejection-${DOC_ID}`);
    expect(within(callout).queryByText(/Notification delivery/i)).not.toBeInTheDocument();
    expect(
      within(callout).queryByTestId(`doc-rejection-delivery-${DOC_ID}-chips`),
    ).not.toBeInTheDocument();
  });
});

// --- Direct unit coverage for the provider-not-configured neutral styling ---

describe("RejectionDeliveryChips — provider-not-configured styling", () => {
  it("renders provider-not-configured channels as neutral skipped, never red failed", () => {
    const notification: RejectionNotification = {
      inAppMessageId: 1,
      emailStatus: "sent",
      pushStatus: "sent",
      // Both SMS and WhatsApp are reported with status='skipped' + the
      // sentinel error 'provider_not_configured' in dev environments.
      smsStatus: "skipped",
      smsError: "provider_not_configured",
      whatsappStatus: "skipped",
      whatsappError: "provider_not_configured",
    };
    render(
      <RejectionDeliveryChips notification={notification} testIdPrefix="pnc" />,
    );
    const sms = screen.getByTestId("pnc-sms");
    const wa = screen.getByTestId("pnc-whatsapp");
    for (const chip of [sms, wa]) {
      expect(chip).toHaveTextContent(/skipped/i);
      expect(chip).toHaveAttribute("data-status", "skipped");
      expect(chip.className).not.toMatch(/text-red-300/);
      expect(chip.className).not.toMatch(/bg-red-500/);
      // Neutral white tone, matching the rest of the inactive chips.
      expect(chip.className).toMatch(/text-white\/60/);
    }
  });
});
