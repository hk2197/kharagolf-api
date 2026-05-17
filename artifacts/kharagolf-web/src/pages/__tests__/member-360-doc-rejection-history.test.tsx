/**
 * Component test: Member 360 DocumentsTab collapses repeat document rejections
 * (Task #339).
 *
 * The staff Documents tab on Member 360 mirrors the mobile member view by
 * collapsing repeat rejected uploads of the same `documentType` into a single
 * "Past rejections · <type> (N)" toggle anchored under the active (or most
 * recent) document of that type. The grouping only applies in the default
 * "All" filter — the explicit "Rejected" filter must list every rejection
 * inline so staff can scan them directly.
 *
 * This test mounts <DocumentsTab /> against a mocked /documents endpoint and
 * verifies:
 *
 *   1. With an active (verified/pending) doc plus several rejections of the
 *      same type, the active doc renders inline and the rejections collapse
 *      under a "Past rejections" toggle. Expanding shows each historical
 *      rejection with its rejecter, date, and reason.
 *   2. For a type with rejections only, the most recent rejection becomes the
 *      primary inline row and the older ones collapse under a "Past
 *      rejections" toggle.
 *   3. Switching to the "Rejected" filter lists every rejection inline (no
 *      grouping toggles), so staff can scan the full rejection log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DocumentsTab } from "../member-360";

const BASE = "/api/organizations/1/members-360/2";

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
  isRejected?: boolean;
  rejectedAt?: string | null;
  rejectedByUserId?: number | null;
  rejectionReason?: string | null;
  rejectedByDisplayName?: string | null;
  rejectedByUsername?: string | null;
  rejectedByEmail?: string | null;
  withdrawnRejection?: null;
}

const ACTIVE_ID_PROOF: DocFixture = {
  id: 9001,
  documentType: "id_proof",
  title: "Passport (current)",
  fileUrl: "https://example.com/passport.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-15T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
};

const REJ_ID_PROOF_NEW: DocFixture = {
  id: 9101,
  documentType: "id_proof",
  title: "Passport v2 (rejected)",
  fileUrl: "https://example.com/passport-v2.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-10T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-11T10:00:00.000Z",
  rejectedByUserId: 8,
  rejectedByDisplayName: "Sam Staff",
  rejectionReason: "Photo page was blurry — please re-scan.",
};

const REJ_ID_PROOF_MID: DocFixture = {
  id: 9102,
  documentType: "id_proof",
  title: "Passport v1 (rejected)",
  fileUrl: "https://example.com/passport-v1.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-05T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-06T10:00:00.000Z",
  rejectedByUserId: 8,
  rejectedByDisplayName: "Sam Staff",
  rejectionReason: "Wrong document type uploaded.",
};

const REJ_ID_PROOF_OLD: DocFixture = {
  id: 9103,
  documentType: "id_proof",
  title: "Passport v0 (rejected)",
  fileUrl: "https://example.com/passport-v0.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-01T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-02T10:00:00.000Z",
  rejectedByUserId: 9,
  rejectedByDisplayName: "Olivia Ops",
  rejectionReason: "Expired document.",
};

const REJ_ADDRESS_NEW: DocFixture = {
  id: 9201,
  documentType: "address_proof",
  title: "Utility bill (rejected, latest)",
  fileUrl: "https://example.com/util-2.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-12T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-13T10:00:00.000Z",
  rejectedByUserId: 8,
  rejectedByDisplayName: "Sam Staff",
  rejectionReason: "Bill is older than 90 days.",
};

const REJ_ADDRESS_OLD: DocFixture = {
  id: 9202,
  documentType: "address_proof",
  title: "Utility bill (rejected, older)",
  fileUrl: "https://example.com/util-1.pdf",
  isVerified: false,
  expiresAt: null,
  createdAt: "2026-04-03T10:00:00.000Z",
  uploadedByUserId: 50,
  uploadedByDisplayName: "Mary Member",
  uploadedByUsername: "mary",
  uploadedByEmail: "mary@example.com",
  isRejected: true,
  rejectedAt: "2026-04-04T10:00:00.000Z",
  rejectedByUserId: 9,
  rejectedByDisplayName: "Olivia Ops",
  rejectionReason: "Name on bill did not match member.",
};

const ALL_DOCS: DocFixture[] = [
  ACTIVE_ID_PROOF,
  REJ_ID_PROOF_NEW,
  REJ_ID_PROOF_MID,
  REJ_ID_PROOF_OLD,
  REJ_ADDRESS_NEW,
  REJ_ADDRESS_OLD,
];

function installFetch(docs: DocFixture[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(`${BASE}/documents`)) {
      return new Response(JSON.stringify(docs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/documents\/\d+\/versions$/.test(url)) {
      // DocVersionsList queries this per-document; return an empty list so
      // it doesn't pollute the rendered output or surface a fetch error.
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentsTab base={BASE} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installFetch(ALL_DOCS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Member 360 DocumentsTab — repeat-rejection grouping", () => {
  it("collapses repeat rejections of the same type under the active doc and expands them on click", async () => {
    const user = userEvent.setup();
    renderTab();

    // Active id_proof renders inline as its own primary row.
    await screen.findByTestId(`doc-row-${ACTIVE_ID_PROOF.id}`);

    // The three repeat id_proof rejections must NOT render as inline rows —
    // they belong inside the collapsed "Past rejections" group.
    expect(screen.queryByTestId(`doc-row-${REJ_ID_PROOF_NEW.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`doc-row-${REJ_ID_PROOF_MID.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`doc-row-${REJ_ID_PROOF_OLD.id}`)).not.toBeInTheDocument();

    // The collapsed "Past rejections" toggle for id_proof shows the count
    // (all three rejections, since the primary is the active doc).
    const idProofToggle = await screen.findByTestId("doc-history-toggle-id_proof");
    expect(idProofToggle).toHaveTextContent(/Past rejections · id proof \(3\)/i);

    // The history rows must not be rendered until the group is expanded.
    expect(screen.queryByTestId(`doc-history-row-${REJ_ID_PROOF_NEW.id}`)).not.toBeInTheDocument();

    await user.click(idProofToggle);

    // After expanding, every historical rejection is visible with its
    // rejecter, date, and reason.
    const newRow = await screen.findByTestId(`doc-history-row-${REJ_ID_PROOF_NEW.id}`);
    const midRow = await screen.findByTestId(`doc-history-row-${REJ_ID_PROOF_MID.id}`);
    const oldRow = await screen.findByTestId(`doc-history-row-${REJ_ID_PROOF_OLD.id}`);

    expect(within(newRow).getByText("Sam Staff")).toBeInTheDocument();
    expect(within(newRow).getByText(/Photo page was blurry/i)).toBeInTheDocument();
    expect(within(newRow).getByText(
      new Date(REJ_ID_PROOF_NEW.rejectedAt!).toLocaleString(),
      { exact: false },
    )).toBeInTheDocument();

    expect(within(midRow).getByText("Sam Staff")).toBeInTheDocument();
    expect(within(midRow).getByText(/Wrong document type/i)).toBeInTheDocument();

    expect(within(oldRow).getByText("Olivia Ops")).toBeInTheDocument();
    expect(within(oldRow).getByText(/Expired document/i)).toBeInTheDocument();
  });

  it("uses the most recent rejection as the primary row when a type has no active doc and collapses older rejections", async () => {
    renderTab();

    // address_proof has zero active docs, so the most recent rejection
    // surfaces as the primary inline row (so staff can act on it).
    await screen.findByTestId(`doc-row-${REJ_ADDRESS_NEW.id}`);
    // The older rejection must NOT render as an inline doc row.
    expect(screen.queryByTestId(`doc-row-${REJ_ADDRESS_OLD.id}`)).not.toBeInTheDocument();

    // The "Past rejections" toggle reports the remaining (older) rejection.
    const addrToggle = await screen.findByTestId("doc-history-toggle-address_proof");
    expect(addrToggle).toHaveTextContent(/Past rejections · address proof \(1\)/i);

    // Sanity: the older rejection is only present as a collapsible history
    // row, not as a top-level doc row.
    expect(screen.queryByTestId(`doc-history-row-${REJ_ADDRESS_OLD.id}`)).not.toBeInTheDocument();
  });

  it("lists every rejection inline (no grouping) when the Rejected filter is active", async () => {
    const user = userEvent.setup();
    renderTab();

    // Wait for initial render before switching filters.
    await screen.findByTestId(`doc-row-${ACTIVE_ID_PROOF.id}`);

    await user.click(screen.getByTestId("doc-filter-rejected"));

    // All five rejections (3 id_proof + 2 address_proof) must render inline.
    await screen.findByTestId(`doc-row-${REJ_ID_PROOF_NEW.id}`);
    expect(screen.getByTestId(`doc-row-${REJ_ID_PROOF_MID.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`doc-row-${REJ_ID_PROOF_OLD.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`doc-row-${REJ_ADDRESS_NEW.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`doc-row-${REJ_ADDRESS_OLD.id}`)).toBeInTheDocument();

    // The active (non-rejected) doc must NOT appear under this filter.
    expect(screen.queryByTestId(`doc-row-${ACTIVE_ID_PROOF.id}`)).not.toBeInTheDocument();

    // Critically: no "Past rejections" grouping toggles render under the
    // explicit Rejected filter — staff should see every rejection inline.
    expect(screen.queryByTestId("doc-history-id_proof")).not.toBeInTheDocument();
    expect(screen.queryByTestId("doc-history-toggle-id_proof")).not.toBeInTheDocument();
    expect(screen.queryByTestId("doc-history-address_proof")).not.toBeInTheDocument();
    expect(screen.queryByTestId("doc-history-toggle-address_proof")).not.toBeInTheDocument();
  });
});
