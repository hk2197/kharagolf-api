/**
 * Component test: web portal "Suppressed notifications" page
 * (`/portal/notification-audit`) i18n coverage (Task #2222).
 *
 * `PortalNotificationAudit` renders five user-visible string surfaces
 * via `t('notificationAudit.*')`:
 *
 *   1. The page heading and intro paragraph.
 *   2. The "Open notification settings" deep-link CTA in the header.
 *   3. The two `kind` badges that classify each row — `userMuted`
 *      ("You muted this") and `systemSuppressed` ("System suppressed").
 *   4. The "Re-enable in settings" link rendered on user-muted rows.
 *   5. The reason label rendered next to each row's machine-readable
 *      reason code.
 *
 * The sibling `portal-notification-audit.test.tsx` exercises the
 * fetch wiring and DOM-level affordances against the bare i18n keys
 * (the test env there does not initialize i18next, so the component
 * renders the literal `notificationAudit.errors.signedOut` string).
 * That suite would happily pass even if every visible string above
 * were re-hardcoded as an English literal in JSX, because none of
 * its assertions look at the translated copy.
 *
 * This fixture closes that gap. It boots the real i18n bundles,
 * switches the active language to Hindi, mounts the audit page with
 * a fetch mock that returns one user-muted row plus one
 * system-suppressed row, and asserts that:
 *
 *   1. Each translated string renders the Hindi value sourced from
 *      `src/i18n/locales/hi/portal.json` (catches any new translation
 *      regression, e.g. a deleted Hindi entry that silently falls back
 *      to English via i18next's default-locale resolver).
 *   2. The English source for the same key is NOT in the document
 *      (catches a future commit that re-hardcodes the label as a
 *      string literal — exactly the regression class the
 *      portal-comm-prefs-email-opt-out-i18n test already guards for
 *      the per-event opt-out rows).
 *
 * The badge assertions are the headline coverage: the task description
 * explicitly calls out the new `notificationAudit.kind.*` badges as the
 * surface the existing `portal-comm-prefs-email-opt-out-i18n` test
 * cannot reach (that suite never renders the audit page).
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "../i18n";
import enPortal from "../i18n/locales/en/portal.json";
import hiPortal from "../i18n/locales/hi/portal.json";

interface AuditEntry {
  id: number;
  notificationKey: string;
  category: string | null;
  description: string | null;
  channel: string;
  status: string;
  reason: string | null;
  kind: "user_muted" | "system_suppressed";
  payload: Record<string, unknown>;
  createdAt: string;
}
interface AuditResponse {
  entries: AuditEntry[];
  windowDays: number;
  limit: number;
  hasMore: boolean;
  nextBefore: string | null;
}

const MUTED_ROW: AuditEntry = {
  id: 11,
  notificationKey: "privacy.erasure.storage_failures.controller_digest",
  category: "privacy_admin",
  description: "Stuck-erasure cleanup digest",
  channel: "email",
  status: "skipped",
  reason: "event_opted_out",
  kind: "user_muted",
  payload: {},
  createdAt: "2026-04-15T12:00:00.000Z",
};
const SYSTEM_ROW: AuditEntry = {
  id: 22,
  notificationKey: "billing.invoice.failure",
  category: "billing",
  description: "Invoice failure alert",
  channel: "email",
  status: "skipped",
  reason: "no_address",
  kind: "system_suppressed",
  payload: {},
  createdAt: "2026-04-14T08:00:00.000Z",
};

const firstPage: AuditResponse = {
  entries: [MUTED_ROW, SYSTEM_ROW],
  windowDays: 30,
  limit: 50,
  hasMore: false,
  nextBefore: null,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.includes("/api/portal/notification-audit")) {
    return new Response(JSON.stringify(firstPage), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeAll(async () => {
  // The audit page itself does not import `../i18n` (only `main.tsx`
  // does), so we boot the bundle here exactly the way the production
  // app does and switch to Hindi for the duration of this file.
  await i18n.changeLanguage("hi");
});

afterAll(async () => {
  // Restore the default so we don't leak Hindi state into other tests
  // that share this i18n module instance (sibling tests in this folder
  // run against the bare keys and expect en).
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function loadPage() {
  const mod = await import("../pages/portal/notification-audit");
  return mod.PortalNotificationAudit;
}

describe("PortalNotificationAudit — Hindi i18n coverage (Task #2222)", () => {
  it("Hindi bundle defines every notificationAudit string the page renders", () => {
    // Drift guard: every assertion below compares against
    // `hiPortal.notificationAudit.*`. If any of these were missing,
    // i18next would silently fall back to English and the per-string
    // `not.toBe(English)` assertions would still fail — but the failure
    // would point at the rendered DOM, not at the locale file. Pin the
    // shape here so the first failure is loud and obvious.
    const hi = hiPortal.notificationAudit;
    expect(hi.heading).toBeTruthy();
    expect(hi.intro).toBeTruthy();
    expect(hi.openCommPrefs).toBeTruthy();
    expect(hi.reenable).toBeTruthy();
    expect(hi.reasonLabel).toBeTruthy();
    expect(hi.kind.userMuted).toBeTruthy();
    expect(hi.kind.systemSuppressed).toBeTruthy();

    const en = enPortal.notificationAudit;
    expect(hi.heading).not.toBe(en.heading);
    expect(hi.intro).not.toBe(en.intro);
    expect(hi.openCommPrefs).not.toBe(en.openCommPrefs);
    expect(hi.reenable).not.toBe(en.reenable);
    expect(hi.reasonLabel).not.toBe(en.reasonLabel);
    expect(hi.kind.userMuted).not.toBe(en.kind.userMuted);
    expect(hi.kind.systemSuppressed).not.toBe(en.kind.systemSuppressed);
  });

  it("renders the heading, intro and 'open settings' CTA in Hindi", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // Wait for the first row to mount before reading any text — until
    // then the loading card is on screen and our header strings
    // wouldn't have been compared yet.
    await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);

    const heading = screen.getByTestId("heading-notification-audit");
    expect(heading.textContent).toBe(hiPortal.notificationAudit.heading);
    expect(heading.textContent).not.toBe(enPortal.notificationAudit.heading);

    expect(
      screen.getByText(hiPortal.notificationAudit.intro),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(enPortal.notificationAudit.intro),
    ).toBeNull();

    const cta = screen.getByTestId("link-comm-prefs");
    expect(cta.textContent ?? "").toContain(
      hiPortal.notificationAudit.openCommPrefs,
    );
    expect(cta.textContent ?? "").not.toContain(
      enPortal.notificationAudit.openCommPrefs,
    );
  });

  it("translates the user-muted badge label (and not the English source)", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    const badge = await screen.findByTestId(`badge-kind-${MUTED_ROW.id}`);
    await waitFor(() => {
      expect(badge.textContent ?? "").toContain(
        hiPortal.notificationAudit.kind.userMuted,
      );
    });
    expect(badge.textContent ?? "").not.toContain(
      enPortal.notificationAudit.kind.userMuted,
    );
  });

  it("translates the system-suppressed badge label (and not the English source)", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    const badge = await screen.findByTestId(`badge-kind-${SYSTEM_ROW.id}`);
    await waitFor(() => {
      expect(badge.textContent ?? "").toContain(
        hiPortal.notificationAudit.kind.systemSuppressed,
      );
    });
    expect(badge.textContent ?? "").not.toContain(
      enPortal.notificationAudit.kind.systemSuppressed,
    );
  });

  it("translates the 'Re-enable in settings' link on user-muted rows", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // Re-enable button only renders for user-muted rows by design — a
    // system-suppressed row cannot be fixed by flipping a settings
    // toggle, so the same i18n assertion has to land on the muted row.
    const reenableBtn = await screen.findByTestId(`btn-reenable-${MUTED_ROW.id}`);
    expect(reenableBtn.textContent ?? "").toContain(
      hiPortal.notificationAudit.reenable,
    );
    expect(reenableBtn.textContent ?? "").not.toContain(
      enPortal.notificationAudit.reenable,
    );
  });

  it("translates the reason label rendered next to each row's reason code", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    const mutedRow = await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);
    // The label is rendered as `${t(reasonLabel)}: <reasonCode>` where
    // the reason code lives in its own <span>, so the parent div is
    // the only node whose textContent contains both halves of the
    // string. Assert via substring containment so colon / spacing
    // tweaks don't make the test brittle, but still pin that the
    // translated copy (not the English source) is what's actually
    // shown alongside the reason code.
    const rowText = mutedRow.textContent ?? "";
    expect(rowText).toContain(hiPortal.notificationAudit.reasonLabel);
    expect(rowText).toContain("event_opted_out");
    expect(rowText).not.toContain(
      `${enPortal.notificationAudit.reasonLabel}: event_opted_out`,
    );
  });
});
