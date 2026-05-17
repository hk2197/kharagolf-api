/**
 * UI test (Task #1066) — both "Export history (CSV)" controls on the
 * org-admin Coach Revenue & Payouts screen produce a CSV download with
 * the documented header columns and the expected coach name + masked
 * payout-account details.
 *
 *   - Org-wide button on the Coaches card hits
 *     GET /coach-marketplace/admin/payout-account/history and produces
 *     `payout-account-history-all-coaches-<date>.csv` with rows for every
 *     coach.
 *   - Per-coach button inside the payout-history dialog hits
 *     GET /coach-marketplace/admin/coaches/:proId/payout-account/history
 *     and produces a coach-scoped CSV.
 *
 * The test stubs `URL.createObjectURL` so it can read the Blob the page
 * hands to the browser, then asserts the header row and the body rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

import CoachAdminPage from "../coach-admin";

interface HistoryEntry {
  id: number;
  proId?: number;
  proName?: string | null;
  changeKind: string;
  method: string;
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  payoutAccountId: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  // Task #1222 — added for `admin_reverify` audit rows; null otherwise.
  verificationOutcome: string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

const t0 = "2025-01-10T12:00:00.000Z";
const t1 = "2025-01-11T12:00:00.000Z";
const t2 = "2025-01-12T12:00:00.000Z";

const coachAlpha = {
  proId: 101, displayName: "Coach Alpha", isActive: true, userId: 11,
  isListed: true, revenueSharePct: 80,
  lifetimeGrossPaise: 0, lifetimeNetPayoutPaise: 0,
  deliveredCount: 0, outstandingGrossPaise: 0, outstandingNetPayoutPaise: 0,
  outstandingCount: 0,
};
const coachBravo = {
  proId: 202, displayName: "Coach Bravo", isActive: true, userId: 22,
  isListed: true, revenueSharePct: 70,
  lifetimeGrossPaise: 0, lifetimeNetPayoutPaise: 0,
  deliveredCount: 0, outstandingGrossPaise: 0, outstandingNetPayoutPaise: 0,
  outstandingCount: 0,
};

const alphaCreate: HistoryEntry = {
  id: 1, proId: 101, proName: "Coach Alpha",
  changeKind: "created", method: "upi",
  accountHolderName: "Coach Alpha",
  upiVpaMasked: "co***@upi",
  bankAccountLast4: null, bankIfsc: null,
  payoutAccountId: "fa_alpha_1",
  changedByUserId: 11, changedByRole: "coach", changedByName: "Coach Alpha",
  verificationOutcome: null, verificationReason: null,
  ipAddress: "10.0.0.1", userAgent: "vitest", createdAt: t0,
};
const alphaUpdate: HistoryEntry = {
  id: 2, proId: 101, proName: "Coach Alpha",
  changeKind: "updated", method: "bank_account",
  accountHolderName: "Coach Alpha",
  upiVpaMasked: null, bankAccountLast4: "1234", bankIfsc: "HDFC0000001",
  payoutAccountId: "fa_alpha_2",
  changedByUserId: 99, changedByRole: "admin", changedByName: "Hist Admin",
  verificationOutcome: null, verificationReason: null,
  ipAddress: "10.0.0.2", userAgent: "vitest", createdAt: t1,
};
// Task #1222 — admin re-verify audit row mirrors the saved bank account
// snapshot (no detail change) but carries the verification outcome +
// reason so the CSV makes the compliance trail self-contained.
const alphaReverify: HistoryEntry = {
  id: 4, proId: 101, proName: "Coach Alpha",
  changeKind: "admin_reverify", method: "bank_account",
  accountHolderName: "Coach Alpha",
  upiVpaMasked: null, bankAccountLast4: "1234", bankIfsc: "HDFC0000001",
  payoutAccountId: "fa_alpha_2",
  changedByUserId: 99, changedByRole: "admin", changedByName: "Hist Admin",
  verificationOutcome: "needs_attention",
  verificationReason: "Bank account is no longer accepting transfers",
  ipAddress: "10.0.0.4", userAgent: "vitest", createdAt: "2025-01-13T12:00:00.000Z",
};
const bravoCreate: HistoryEntry = {
  id: 3, proId: 202, proName: "Coach Bravo",
  changeKind: "created", method: "upi",
  accountHolderName: "Coach Bravo",
  upiVpaMasked: "br***@upi",
  bankAccountLast4: null, bankIfsc: null,
  payoutAccountId: "fa_bravo_1",
  changedByUserId: 22, changedByRole: "coach", changedByName: "Coach Bravo",
  verificationOutcome: null, verificationReason: null,
  ipAddress: "10.0.0.3", userAgent: "vitest", createdAt: t2,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as unknown as Response;
}

let capturedBlobs: Array<{ url: string; blob: Blob; filename?: string }>;
let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
let originalAnchorClick: (this: HTMLAnchorElement) => void;

async function readBlobText(blob: Blob): Promise<string> {
  // jsdom's Blob may not implement .text(); fall back to FileReader.
  if (typeof blob.text === "function") {
    return await blob.text();
  }
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.readAsText(blob);
  });
}

beforeEach(() => {
  capturedBlobs = [];

  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = `blob:mock/${++n}`;
    if (obj instanceof Blob) capturedBlobs.push({ url, blob: obj });
    return url;
  };
  URL.revokeObjectURL = () => {};

  // Capture the filename the page assigns and prevent jsdom's anchor click
  // from trying to actually navigate.
  originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.href?.startsWith("blob:mock/")) {
      const match = capturedBlobs.find(b => b.url === this.href);
      if (match) match.filename = this.download;
    }
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/coach-marketplace/admin/coaches/101/payout-account/history")) {
      // Per-coach dialog endpoint — strip proName so the CSV uses the
      // dialog's `fallbackCoachName`. Includes the Task #1222
      // admin-reverify audit row so we can assert the new columns.
      const items = [alphaReverify, alphaUpdate, alphaCreate].map(({ proName: _omit, ...rest }) => rest);
      return jsonResponse({ history: items });
    }
    if (url.startsWith("/api/coach-marketplace/admin/payout-account/history")) {
      // Task #1427 — emulate server-side filtering when the page passes
      // a `changeKind` query param so the test can assert the org-wide
      // CSV honours the new filter dropdown.
      const all = [alphaReverify, bravoCreate, alphaUpdate, alphaCreate];
      const match = /[?&]changeKind=([^&]+)/.exec(url);
      const filtered = match
        ? all.filter(h => h.changeKind === decodeURIComponent(match[1]))
        : all;
      return jsonResponse({ history: filtered });
    }
    if (url === "/api/coach-marketplace/admin/coaches") {
      return jsonResponse({ coaches: [coachAlpha, coachBravo] });
    }
    if (url === "/api/swing-reviews/admin/payouts") {
      return jsonResponse({ payouts: [] });
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

const EXPECTED_HEADER =
  "Timestamp,Coach,Change,Method,Masked details,Account holder," +
  "Payout account ID,Changed by,Role," +
  // Task #1222 — verification outcome/reason columns appended for the
  // admin re-verify audit trail.
  "Verification outcome,Verification reason," +
  "IP";

function parseCsv(text: string): string[][] {
  // Strip BOM, split on CRLF, ignore trailing blank line.
  const cleaned = text.replace(/^\ufeff/, "");
  return cleaned.split("\r\n").filter(l => l.length > 0).map(line => {
    const cells: string[] = [];
    let cur = "";
    let i = 0;
    let inQuotes = false;
    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        if (ch === '"') { inQuotes = false; i++; continue; }
        cur += ch; i++;
      } else {
        if (ch === ',') { cells.push(cur); cur = ""; i++; continue; }
        if (ch === '"') { inQuotes = true; i++; continue; }
        cur += ch; i++;
      }
    }
    cells.push(cur);
    return cells;
  });
}

describe("CoachAdminPage — Task #1066 payout-account history CSV exports", () => {
  it("org-wide 'Export history (CSV)' downloads every coach's audit rows with the documented columns", async () => {
    render(<CoachAdminPage />);

    const button = await screen.findByTestId("button-export-all-history-csv");
    fireEvent.click(button);

    await waitFor(() => expect(capturedBlobs.length).toBe(1));
    const { blob, filename } = capturedBlobs[0];
    expect(blob.type).toMatch(/text\/csv/);
    expect(filename).toMatch(/^payout-account-history-all-coaches-\d{4}-\d{2}-\d{2}\.csv$/);

    const text = await readBlobText(blob);
    const rows = parseCsv(text);

    expect(rows[0].join(",")).toBe(EXPECTED_HEADER);
    expect(rows.length).toBe(1 + 4); // header + 4 history rows (incl. admin_reverify)

    const bodyByCoachAndChange = new Map<string, string[]>();
    for (const r of rows.slice(1)) bodyByCoachAndChange.set(`${r[1]}|${r[2]}`, r);

    const bravo = bodyByCoachAndChange.get("Coach Bravo|created")!;
    expect(bravo).toBeDefined();
    expect(bravo[0]).toBe(t2);                  // Timestamp
    expect(bravo[3]).toBe("upi");               // Method
    expect(bravo[4]).toBe("UPI br***@upi");    // Masked details
    expect(bravo[5]).toBe("Coach Bravo");      // Account holder
    expect(bravo[6]).toBe("fa_bravo_1");        // Payout account ID
    expect(bravo[7]).toBe("Coach Bravo");      // Changed by
    expect(bravo[8]).toBe("coach");            // Role
    expect(bravo[9]).toBe("");                  // Verification outcome (n/a)
    expect(bravo[10]).toBe("");                 // Verification reason (n/a)
    expect(bravo[11]).toBe("10.0.0.3");         // IP

    const alphaUpd = bodyByCoachAndChange.get("Coach Alpha|updated")!;
    expect(alphaUpd).toBeDefined();
    expect(alphaUpd[3]).toBe("bank_account");
    expect(alphaUpd[4]).toBe("Account ****1234 (IFSC HDFC0000001)");
    expect(alphaUpd[7]).toBe("Hist Admin");
    expect(alphaUpd[8]).toBe("admin");
    expect(alphaUpd[9]).toBe("");
    expect(alphaUpd[10]).toBe("");
    expect(alphaUpd[11]).toBe("10.0.0.2");

    const alphaCre = bodyByCoachAndChange.get("Coach Alpha|created")!;
    expect(alphaCre).toBeDefined();
    expect(alphaCre[4]).toBe("UPI co***@upi");

    // Task #1222 — admin_reverify row carries the verification outcome
    // + reason; account snapshot mirrors the saved bank account.
    const alphaRev = bodyByCoachAndChange.get("Coach Alpha|admin_reverify")!;
    expect(alphaRev).toBeDefined();
    expect(alphaRev[3]).toBe("bank_account");
    expect(alphaRev[4]).toBe("Account ****1234 (IFSC HDFC0000001)");
    expect(alphaRev[6]).toBe("fa_alpha_2");
    expect(alphaRev[7]).toBe("Hist Admin");
    expect(alphaRev[8]).toBe("admin");
    expect(alphaRev[9]).toBe("needs_attention");
    expect(alphaRev[10]).toBe("Bank account is no longer accepting transfers");
    expect(alphaRev[11]).toBe("10.0.0.4");
  });

  it("per-coach 'Export history (CSV)' inside the dialog downloads just that coach's rows", async () => {
    render(<CoachAdminPage />);

    fireEvent.click(await screen.findByTestId("button-payout-history-101"));
    // Wait for the dialog to load history (export button enables once items arrive).
    const exportBtn = await screen.findByTestId("button-export-history-csv");
    await waitFor(() => expect(exportBtn).not.toBeDisabled());

    fireEvent.click(exportBtn);

    await waitFor(() => expect(capturedBlobs.length).toBe(1));
    const { blob, filename } = capturedBlobs[0];
    expect(filename).toMatch(/^payout-account-history-coach-alpha-\d{4}-\d{2}-\d{2}\.csv$/);

    const text = await readBlobText(blob);
    const rows = parseCsv(text);

    expect(rows[0].join(",")).toBe(EXPECTED_HEADER);
    expect(rows.length).toBe(1 + 3);

    // All body rows are for Coach Alpha (the dialog supplies it as fallback
    // since the per-coach endpoint omits proName).
    for (const r of rows.slice(1)) expect(r[1]).toBe("Coach Alpha");

    const updateRow = rows.slice(1).find(r => r[2] === "updated")!;
    expect(updateRow[3]).toBe("bank_account");
    expect(updateRow[4]).toBe("Account ****1234 (IFSC HDFC0000001)");
    expect(updateRow[6]).toBe("fa_alpha_2");
    expect(updateRow[7]).toBe("Hist Admin");
    expect(updateRow[8]).toBe("admin");
    expect(updateRow[11]).toBe("10.0.0.2");

    const createRow = rows.slice(1).find(r => r[2] === "created")!;
    expect(createRow[3]).toBe("upi");
    expect(createRow[4]).toBe("UPI co***@upi");

    // Task #1222 — admin re-verify row appears in the per-coach CSV too.
    const reverifyRow = rows.slice(1).find(r => r[2] === "admin_reverify")!;
    expect(reverifyRow).toBeDefined();
    expect(reverifyRow[9]).toBe("needs_attention");
    expect(reverifyRow[10]).toBe("Bank account is no longer accepting transfers");
  });

  // Task #1427 — change-type filter on the per-coach payout-history
  // dialog narrows both the rendered list and the per-coach CSV export
  // down to the selected change kind. Happy path: filter to admin
  // re-verifications.
  // Task #1719 — the dropdown was replaced with one-click chips that
  // also persist the selection in the URL hash, so this test exercises
  // the chip click + asserts the hash side-effect.
  it("dialog change-type filter narrows the list + CSV export to admin re-verifications", async () => {
    window.history.replaceState({}, "", "/coach-admin");

    render(<CoachAdminPage />);

    fireEvent.click(await screen.findByTestId("button-payout-history-101"));

    // Wait for the dialog to load (filter chips + count appear once items arrive).
    const reverifyChip = await screen.findByTestId("chip-history-filter-admin_reverify");
    const count = await screen.findByTestId("text-history-filter-count");
    expect(count.textContent).toBe("3 of 3");

    // The default ("All") chip should start selected; the others should not.
    expect(screen.getByTestId("chip-history-filter-all").getAttribute("aria-selected")).toBe("true");
    expect(reverifyChip.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(reverifyChip);
    expect(reverifyChip.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("chip-history-filter-all").getAttribute("aria-selected")).toBe("false");

    // Chip click mirrors into the URL hash so the deep-link / share works.
    expect(window.location.hash).toBe("#payout-history=admin_reverify");

    // The dialog should now show only the admin_reverify row (id 4).
    expect(await screen.findByTestId("history-row-4")).toBeTruthy();
    expect(screen.queryByTestId("history-row-1")).toBeNull(); // alphaCreate
    expect(screen.queryByTestId("history-row-2")).toBeNull(); // alphaUpdate
    expect(screen.getByTestId("text-history-filter-count").textContent).toBe("1 of 3");

    // Switching back to "All" collapses the hash to the bare deep-link form.
    fireEvent.click(screen.getByTestId("chip-history-filter-all"));
    expect(window.location.hash).toBe("#payout-history");
    fireEvent.click(reverifyChip);
    expect(window.location.hash).toBe("#payout-history=admin_reverify");

    fireEvent.click(screen.getByTestId("button-export-history-csv"));

    await waitFor(() => expect(capturedBlobs.length).toBe(1));
    const { blob, filename } = capturedBlobs[0];
    expect(filename).toMatch(/^payout-account-history-coach-alpha-admin-reverify-\d{4}-\d{2}-\d{2}\.csv$/);

    const text = await readBlobText(blob);
    const rows = parseCsv(text);
    expect(rows[0].join(",")).toBe(EXPECTED_HEADER);
    // Header + the single admin_reverify row only.
    expect(rows.length).toBe(1 + 1);
    const body = rows[1];
    expect(body[1]).toBe("Coach Alpha");
    expect(body[2]).toBe("admin_reverify");
    expect(body[9]).toBe("needs_attention");
    expect(body[10]).toBe("Bank account is no longer accepting transfers");
  });

  // Task #1427 — org-wide CSV export gains a matching change-type
  // filter that is forwarded to the API as `?changeKind=...` so large
  // orgs don't have to download the entire history file just to find
  // the admin re-verifications.
  it("org-wide change-type filter passes ?changeKind to the API and downloads only matching rows", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    render(<CoachAdminPage />);

    const filterSelect = await screen.findByTestId("select-export-history-kind") as HTMLSelectElement;
    fireEvent.change(filterSelect, { target: { value: "admin_reverify" } });
    expect(filterSelect.value).toBe("admin_reverify");

    fireEvent.click(screen.getByTestId("button-export-all-history-csv"));

    await waitFor(() => expect(capturedBlobs.length).toBe(1));

    // The page should have hit the export endpoint with the filter.
    const exportCall = fetchMock.mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.startsWith("/api/coach-marketplace/admin/payout-account/history");
    });
    expect(exportCall).toBeDefined();
    expect(String(exportCall![0])).toContain("changeKind=admin_reverify");

    const { blob, filename } = capturedBlobs[0];
    expect(filename).toMatch(
      /^payout-account-history-all-coaches-admin-reverify-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    const text = await readBlobText(blob);
    const rows = parseCsv(text);
    expect(rows[0].join(",")).toBe(EXPECTED_HEADER);
    // Header + only the alpha admin_reverify row (the mocked fetch
    // emulates the server filter).
    expect(rows.length).toBe(1 + 1);
    expect(rows[1][1]).toBe("Coach Alpha");
    expect(rows[1][2]).toBe("admin_reverify");
    expect(rows[1][9]).toBe("needs_attention");
  });
});
