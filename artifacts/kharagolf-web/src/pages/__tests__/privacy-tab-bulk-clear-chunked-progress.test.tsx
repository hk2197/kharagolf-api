/**
 * Task #1899 — UI tests for the chunked bulk-clear progress UX added in
 * Task #1536.
 *
 * The runners (PrivacyTab.runBulkRetry / runBulkResolve) split a 500-row
 * sweep into BULK_CHUNK_SIZE = 50 chunks so admins see a "X of N done"
 * progress bar tick across instead of a frozen multi-second spinner. The
 * behaviour is purely client-side, so the existing
 * pending-storage-deletions-admin server tests don't exercise it. These
 * tests pin down:
 *
 *   1. Force-retry: a 200-row sweep fires four sequential POSTs, the
 *      progress text in the toolbar advances "0 → 50 → 100 → 150 → 200
 *      of 200 done", and the success toast / cleared selection only
 *      land once the whole batch finishes.
 *   2. Force-retry mid-batch failure: when the second chunk rejects,
 *      we don't fire the remaining chunks, the un-processed ids stay
 *      selected so a retry only re-sweeps the rest, and the toast names
 *      the partial-progress count.
 *   3. Bulk-resolve: the dialog embeds its own progress bar (so admins
 *      don't have to dismiss the modal to watch the sweep) — covered
 *      end-to-end including a mid-batch failure that keeps the dialog
 *      open with the same reason and only the un-processed selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { PrivacyTab } from "../governance";

const ORG_ID = 42;
const BULK_CHUNK_SIZE = 50;

const CONSENT_HEALTH = {
  totalMembers: 0,
  categories: [],
  accountDeletions: { inGrace: 0, overdue: 0, rows: [] },
  dataExports: { pending: 0, ready: 0, expired: 0, failed: 0, rows: [] },
};

const FAILURES_EMPTY = {
  count: 0,
  totalFailedFiles: 0,
  items: [],
  pendingStorageDeletions: { total: 0, exhausted: 0 },
};

const AUDIT_LOG_EMPTY = {
  count: 0,
  limit: 50,
  items: [],
  actors: [],
  filters: { actorUserId: null, action: null, pathPrefix: null },
};

// 200 stuck rows so the sweep needs four chunks of 50. Ids start at 1000
// so the remainder math after a mid-batch failure is easy to assert.
function makePendingDeletions(count: number) {
  return {
    count,
    onlyExhausted: true,
    items: Array.from({ length: count }, (_, i) => ({
      id: 1000 + i,
      clubMemberId: 9000 + i,
      sourceAuditId: null,
      path: `/objects/stuck-${i}`,
      attempts: 12,
      lastAttemptAt: "2026-04-25T09:00:00.000Z",
      lastError: "TimeoutError: backend unavailable",
      nextAttemptAt: "2026-04-26T09:00:00.000Z",
      createdAt: "2026-04-20T09:00:00.000Z",
      exhausted: true,
      exhaustionNotifiedAt: null,
      memberFirstName: `Member${i}`,
      memberLastName: "Stuck",
      memberNumber: null,
      memberDeleted: false,
    })),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonOk<T>(body: T): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function jsonErr(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

interface BulkCall {
  endpoint: "bulk-retry-now" | "bulk-resolve";
  ids: number[];
  reason: string | null;
  deferred: Deferred<Response>;
}

function installFetch(opts: { rowCount: number }) {
  const calls: BulkCall[] = [];

  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/members-360/consent-health")) {
      return Promise.resolve(jsonOk(CONSENT_HEALTH));
    }
    if (url.includes("/erasures/storage-failures/audit-log")) {
      return Promise.resolve(jsonOk(AUDIT_LOG_EMPTY));
    }
    if (
      url.includes("/erasures/storage-failures/pending/bulk-retry-now") &&
      method === "POST"
    ) {
      const body = JSON.parse(init!.body as string) as { ids: number[] };
      const d = makeDeferred<Response>();
      calls.push({
        endpoint: "bulk-retry-now",
        ids: body.ids,
        reason: null,
        deferred: d,
      });
      return d.promise;
    }
    if (
      url.includes("/erasures/storage-failures/pending/bulk-resolve") &&
      method === "POST"
    ) {
      const body = JSON.parse(init!.body as string) as {
        ids: number[];
        reason: string;
      };
      const d = makeDeferred<Response>();
      calls.push({
        endpoint: "bulk-resolve",
        ids: body.ids,
        reason: body.reason,
        deferred: d,
      });
      return d.promise;
    }
    if (url.includes("/erasures/storage-failures/pending")) {
      return Promise.resolve(jsonOk(makePendingDeletions(opts.rowCount)));
    }
    if (url.includes("/erasures/storage-failures")) {
      return Promise.resolve(jsonOk(FAILURES_EMPTY));
    }
    return Promise.resolve(jsonOk({}));
  });

  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, calls };
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PrivacyTab orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PrivacyTab — chunked bulk-clear progress UX (Task #1536, tests #1899)", () => {
  it("force-retry on 200 rows fires 4 chunked POSTs and ticks the progress text 0 → 50 → 100 → 150 → 200", async () => {
    const harness = installFetch({ rowCount: 200 });
    renderTab();

    // Wait for the bulk toolbar (proves the 200-row pending list has loaded).
    await screen.findByTestId("pending-storage-bulk-toolbar");
    await screen.findByTestId("pending-storage-row-1000");

    // Select all visible — the toolbar count flips to "200 of 200 selected".
    fireEvent.click(screen.getByTestId("pending-storage-bulk-select-all"));
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("200 of 200 selected");
    });

    // Kick off the bulk force-retry.
    fireEvent.click(screen.getByTestId("pending-storage-bulk-force-retry"));

    // First chunk should be in flight immediately.
    await waitFor(() => {
      expect(
        harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
      ).toBe(1);
    });
    expect(harness.calls[0].ids).toHaveLength(BULK_CHUNK_SIZE);
    expect(harness.calls[0].ids[0]).toBe(1000);
    expect(harness.calls[0].ids[BULK_CHUNK_SIZE - 1]).toBe(1049);

    // The retry-flavoured progress block (not the resolve-dialog one) is
    // mounted, and the bulk buttons are disabled while in flight.
    await screen.findByTestId("pending-storage-bulk-progress-retry");
    expect(
      (screen.getByTestId("pending-storage-bulk-force-retry") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("pending-storage-bulk-resolve") as HTMLButtonElement).disabled,
    ).toBe(true);

    // While the first chunk is in flight, the progress text shows the
    // pre-completion state ("0 of 200 done").
    expect(
      screen.getByTestId("pending-storage-bulk-progress-text").textContent,
    ).toBe("0 of 200 done");

    // Walk through all four chunks, asserting the progress text advances
    // by 50 each time and a fresh chunk request goes out before the next
    // tick. The server echoes each chunk's ids back in the `ids` field
    // (matching the real bulk-retry-now contract).
    for (let chunk = 0; chunk < 4; chunk += 1) {
      const call = harness.calls[chunk];
      call.deferred.resolve(jsonOk({ count: call.ids.length, ids: call.ids }));

      const expectedDone = (chunk + 1) * BULK_CHUNK_SIZE;
      if (chunk < 3) {
        // After this chunk lands, the progress text must update before
        // the next chunk goes out. Wait for both signals: the text
        // advances AND the next call is registered.
        await waitFor(() => {
          expect(
            screen.getByTestId("pending-storage-bulk-progress-text").textContent,
          ).toBe(`${expectedDone} of 200 done`);
          expect(
            harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
          ).toBe(chunk + 2);
        });
        // The freshly-issued chunk targets the next 50 ids in order.
        const nextCall = harness.calls[chunk + 1];
        expect(nextCall.ids).toHaveLength(BULK_CHUNK_SIZE);
        expect(nextCall.ids[0]).toBe(1000 + expectedDone);
      }
    }

    // Once the loop unwinds, the progress affordance is torn down,
    // selection clears, and a single success toast lands. The
    // pending-deletions list refetch happens here too — the mock
    // returns the same 200 rows since we don't simulate clearing
    // server-side.
    await waitFor(() => {
      expect(
        screen.queryByTestId("pending-storage-bulk-progress-retry"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("0 of 200 selected");
    });

    // Exactly four chunked POSTs — no extra trailing call.
    expect(
      harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
    ).toBe(4);

    // The success toast names the full completion count.
    const toastCalls = toastMock.mock.calls.map(
      (c) => c[0] as { title?: string; description?: string; variant?: string },
    );
    const success = toastCalls.find((t) =>
      /Force-retry scheduled for 200 row/.test(t.title ?? ""),
    );
    expect(success).toBeTruthy();
    expect(success?.variant).toBeUndefined();
  });

  it("force-retry stops on a mid-batch HTTP failure and leaves the un-processed ids selected with a partial-progress toast", async () => {
    const harness = installFetch({ rowCount: 200 });
    renderTab();

    await screen.findByTestId("pending-storage-bulk-toolbar");
    await screen.findByTestId("pending-storage-row-1000");

    fireEvent.click(screen.getByTestId("pending-storage-bulk-select-all"));
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("200 of 200 selected");
    });

    fireEvent.click(screen.getByTestId("pending-storage-bulk-force-retry"));

    // First chunk lands successfully — progress ticks to 50 and the
    // second chunk goes out.
    await waitFor(() => {
      expect(
        harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
      ).toBe(1);
    });
    harness.calls[0].deferred.resolve(
      jsonOk({ count: harness.calls[0].ids.length, ids: harness.calls[0].ids }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-progress-text").textContent,
      ).toBe("50 of 200 done");
      expect(
        harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
      ).toBe(2);
    });

    // Intercept the second chunk with a 500. The api() helper turns
    // {error: ...} into an Error message; the runner catches it as
    // stoppedError and bails out of the loop without firing chunks 3 & 4.
    harness.calls[1].deferred.resolve(
      jsonErr(500, { error: "object-store unavailable" }),
    );

    // The runner should NOT fire any more chunks after the failure.
    // Wait for the toast to land (proving the loop unwound) and then
    // assert no third chunk was issued.
    await waitFor(() => {
      const partialToast = toastMock.mock.calls.find(
        (c) =>
          /Stopped after 50 of 200 row/.test(
            (c[0] as { title?: string }).title ?? "",
          ),
      );
      expect(partialToast).toBeTruthy();
    });
    expect(
      harness.calls.filter((c) => c.endpoint === "bulk-retry-now").length,
    ).toBe(2);

    // The toast surfaces the un-processed remainder and the underlying
    // server error so the admin knows what to retry.
    const partialToast = toastMock.mock.calls
      .map((c) => c[0] as { title?: string; description?: string; variant?: string })
      .find((t) => /Stopped after 50 of 200 row/.test(t.title ?? ""));
    expect(partialToast?.variant).toBe("destructive");
    expect(partialToast?.description).toMatch(/150 row/);
    expect(partialToast?.description).toMatch(/object-store unavailable/);

    // Selection is now exactly the 150 un-processed ids — the first 50
    // (which succeeded) were dropped, the rest stayed so a follow-up
    // click only re-sweeps the remainder. The visible count stays 200
    // because pendingDeletions.refetch() returns the same fixture.
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("150 of 200 selected");
    });

    // The progress affordance is torn down so the toolbar is interactive
    // again — admin can immediately click "Force retry selected" to
    // sweep the remaining 150.
    expect(
      screen.queryByTestId("pending-storage-bulk-progress-retry"),
    ).not.toBeInTheDocument();
    expect(
      (screen.getByTestId("pending-storage-bulk-force-retry") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("bulk-resolve renders chunked progress inside the dialog and on a mid-batch failure keeps the dialog open with the un-processed selection", async () => {
    const harness = installFetch({ rowCount: 200 });
    renderTab();

    await screen.findByTestId("pending-storage-bulk-toolbar");
    await screen.findByTestId("pending-storage-row-1000");

    // Select everything, then open the bulk-resolve dialog.
    fireEvent.click(screen.getByTestId("pending-storage-bulk-select-all"));
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("200 of 200 selected");
    });
    fireEvent.click(screen.getByTestId("pending-storage-bulk-resolve"));

    const reasonInput = await screen.findByTestId(
      "pending-storage-bulk-resolve-reason",
    );
    fireEvent.change(reasonInput, {
      target: { value: "confirmed deleted via bucket migration on 2026-04-20" },
    });
    fireEvent.click(screen.getByTestId("pending-storage-bulk-resolve-confirm"));

    // First chunk goes out, dialog-side progress block renders with the
    // initial "0 of 200 done" text.
    await waitFor(() => {
      expect(
        harness.calls.filter((c) => c.endpoint === "bulk-resolve").length,
      ).toBe(1);
    });
    await screen.findByTestId("pending-storage-bulk-resolve-progress");
    expect(
      screen.getByTestId("pending-storage-bulk-resolve-progress-text").textContent,
    ).toBe("Marking resolved — 0 of 200 done");
    // The shared reason rides on every chunk request.
    expect(harness.calls[0].reason).toBe(
      "confirmed deleted via bucket migration on 2026-04-20",
    );

    // Resolve chunk 1 — the dialog progress text advances to 50/200 and
    // the second chunk fires.
    harness.calls[0].deferred.resolve(
      jsonOk({ count: harness.calls[0].ids.length, ids: harness.calls[0].ids }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-resolve-progress-text").textContent,
      ).toBe("Marking resolved — 50 of 200 done");
      expect(
        harness.calls.filter((c) => c.endpoint === "bulk-resolve").length,
      ).toBe(2);
    });

    // Mid-batch failure on chunk 2.
    harness.calls[1].deferred.resolve(
      jsonErr(500, { error: "audit insert deadlocked" }),
    );

    // Toast names the partial-progress count and quotes the server
    // error so the admin can act on it.
    await waitFor(() => {
      const partial = toastMock.mock.calls
        .map((c) => c[0] as { title?: string; description?: string; variant?: string })
        .find((t) => /Cleared 50 of 200 row.*then stopped/.test(t.title ?? ""));
      expect(partial).toBeTruthy();
      expect(partial?.variant).toBe("destructive");
      expect(partial?.description).toMatch(/150 row/);
      expect(partial?.description).toMatch(/audit insert deadlocked/);
    });

    // No additional chunks were issued after the failure.
    expect(
      harness.calls.filter((c) => c.endpoint === "bulk-resolve").length,
    ).toBe(2);

    // The dialog is intentionally kept open with the same reason so the
    // admin can immediately re-confirm to sweep just the remainder; the
    // un-processed 150 ids are now the only thing selected.
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-storage-bulk-resolve-dialog"),
      ).toBeInTheDocument();
      expect(
        (screen.getByTestId("pending-storage-bulk-resolve-reason") as HTMLTextAreaElement)
          .value,
      ).toBe("confirmed deleted via bucket migration on 2026-04-20");
      expect(
        screen.getByTestId("pending-storage-bulk-selected-count").textContent,
      ).toBe("150 of 200 selected");
    });

    // The dialog-side progress block is torn down so the modal is
    // interactive again (Cancel / Mark resolved buttons re-enabled).
    expect(
      screen.queryByTestId("pending-storage-bulk-resolve-progress"),
    ).not.toBeInTheDocument();
    expect(
      (screen.getByTestId("pending-storage-bulk-resolve-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
