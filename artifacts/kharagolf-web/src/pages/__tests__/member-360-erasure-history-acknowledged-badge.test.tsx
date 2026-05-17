/**
 * Task #2243 — UI smoke test for the green "Acknowledged · {reviewer}"
 * badge on the per-member privacy panel's erasure-history card.
 *
 * Task #1795 surfaced the badge on the org-wide stuck-cleanup dashboard
 * (governance.tsx). This test pins down the same treatment on the
 * per-member panel: when the latest audit row is a
 * `controller_acknowledgement`, the failure row it points at must render
 * the badge with a tooltip carrying the reviewer name + free-text note,
 * so a controller viewing one member can tell the row was waived without
 * cross-referencing the audit log.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { ErasureHistoryCard } from "../member-360";

type Entry = {
  auditId: number;
  completedAt: string;
  dataRequestId: number | null;
  source: string | null;
  mediaTablesPurged: Record<string, number>;
  totalMediaRowsPurged: number;
  playerRowsScrubbed: number | null;
  mediaRowsScrubbed: number | null;
  objectStorageFilesDeleted: number | null;
  objectStorageFilesMissing: number | null;
  objectStorageFilesFailed: number | null;
  objectStorageDisabled: boolean | null;
  acknowledgedAuditId: number | null;
  acknowledgementNote: string | null;
  actorName: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  // Minimal Response shim that satisfies member-360.tsx's `j()` helper —
  // it reads `headers.get('content-length')` to short-circuit empty bodies
  // before falling through to `.text()` + JSON.parse.
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: "OK",
    headers: { get: () => null } as unknown as Headers,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function installFetch(entries: Entry[]) {
  const fetchSpy = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/erasure-history")) {
      return jsonResponse({ entries });
    }
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ErasureHistoryCard base="/api/organizations/42/members-360/9001" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ErasureHistoryCard — acknowledged-row badge (Task #2243)", () => {
  it("marks the failure row with the green Acknowledged badge when the latest entry is a controller acknowledgement", async () => {
    // Latest row (entries[0]) is the acknowledgement; entries[1] is the
    // failure row it acknowledged. The badge belongs on the failure row.
    installFetch([
      {
        auditId: 5002,
        completedAt: "2026-04-30T10:00:00.000Z",
        dataRequestId: 42,
        source: "controller_acknowledgement",
        mediaTablesPurged: {},
        totalMediaRowsPurged: 0,
        playerRowsScrubbed: 0,
        mediaRowsScrubbed: 0,
        objectStorageFilesDeleted: 0,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 1,
        objectStorageDisabled: false,
        acknowledgedAuditId: 5001,
        acknowledgementNote: "files retained on legal hold per ticket #1234",
        actorName: "Reg U. Lator",
      },
      {
        auditId: 5001,
        completedAt: "2026-04-29T09:00:00.000Z",
        dataRequestId: 42,
        source: "cron",
        mediaTablesPurged: { media: 3 },
        totalMediaRowsPurged: 3,
        playerRowsScrubbed: 0,
        mediaRowsScrubbed: 0,
        objectStorageFilesDeleted: 2,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 1,
        objectStorageDisabled: false,
        acknowledgedAuditId: null,
        acknowledgementNote: null,
        actorName: "system",
      },
    ]);

    renderCard();

    // The failure row (auditId=5001) carries the Acknowledged badge with
    // the reviewer name in the visible label.
    const badge = await screen.findByTestId(
      "erasure-history-acknowledged-5001",
    );
    expect(badge.textContent).toMatch(/Acknowledged · Reg U\. Lator/);

    // Tooltip carries the reviewer + acknowledgement timestamp + note so
    // controllers see triage context on hover.
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain("Acknowledged by Reg U. Lator");
    expect(title).toContain("on ");
    expect(title).toContain(
      "— files retained on legal hold per ticket #1234",
    );

    // The acknowledgement row itself (auditId=5002) must NOT also render
    // the badge — only the failure row it pointed at does.
    expect(
      screen.queryByTestId("erasure-history-acknowledged-5002"),
    ).not.toBeInTheDocument();

    // The failure row's container marks itself acknowledged so the deep
    // link / styling hooks line up with the org-wide dashboard contract.
    const failureRow = screen.getByTestId("erasure-history-entry-5001");
    expect(failureRow.getAttribute("data-acknowledged")).toBe("true");
  });

  it("omits the Acknowledged badge when the latest entry is a normal cron row", async () => {
    // Failure-only history: the latest row is the cron erasure, so there
    // is nothing to acknowledge yet and no badge should render.
    installFetch([
      {
        auditId: 6001,
        completedAt: "2026-04-29T09:00:00.000Z",
        dataRequestId: 77,
        source: "cron",
        mediaTablesPurged: { media: 2 },
        totalMediaRowsPurged: 2,
        playerRowsScrubbed: 0,
        mediaRowsScrubbed: 0,
        objectStorageFilesDeleted: 1,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 1,
        objectStorageDisabled: false,
        acknowledgedAuditId: null,
        acknowledgementNote: null,
        actorName: "system",
      },
    ]);

    renderCard();

    // Wait for the row to render before asserting the badge is absent.
    const failureRow = await screen.findByTestId(
      "erasure-history-entry-6001",
    );
    expect(failureRow.getAttribute("data-acknowledged")).toBe("false");
    expect(
      screen.queryByTestId("erasure-history-acknowledged-6001"),
    ).not.toBeInTheDocument();
  });

  it("renders the badge without the reviewer suffix when the actorName is missing (older acknowledgements predate actor capture)", async () => {
    // Older acknowledgements may have a null actorName. The badge should
    // still appear — just with the bare "Acknowledged" label and a
    // graceful fallback in the tooltip.
    installFetch([
      {
        auditId: 7002,
        completedAt: "2026-04-30T10:00:00.000Z",
        dataRequestId: 88,
        source: "controller_acknowledgement",
        mediaTablesPurged: {},
        totalMediaRowsPurged: 0,
        playerRowsScrubbed: 0,
        mediaRowsScrubbed: 0,
        objectStorageFilesDeleted: 0,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 1,
        objectStorageDisabled: false,
        acknowledgedAuditId: 7001,
        acknowledgementNote: null,
        actorName: null,
      },
      {
        auditId: 7001,
        completedAt: "2026-04-29T09:00:00.000Z",
        dataRequestId: 88,
        source: "cron",
        mediaTablesPurged: { media: 1 },
        totalMediaRowsPurged: 1,
        playerRowsScrubbed: 0,
        mediaRowsScrubbed: 0,
        objectStorageFilesDeleted: 0,
        objectStorageFilesMissing: 0,
        objectStorageFilesFailed: 1,
        objectStorageDisabled: false,
        acknowledgedAuditId: null,
        acknowledgementNote: null,
        actorName: "system",
      },
    ]);

    renderCard();

    const badge = await screen.findByTestId(
      "erasure-history-acknowledged-7001",
    );
    // Bare "Acknowledged" with no " · {reviewer}" suffix.
    expect(badge.textContent?.trim()).toBe("Acknowledged");
    // Tooltip falls back to the generic phrasing.
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain("Acknowledged by a controller");
    // No trailing em-dash note when the controller didn't supply one.
    expect(title).not.toContain("—");
  });
});
