/**
 * Component test: web portal Notifications tab per-event email opt-out
 * i18n coverage (Task #1743).
 *
 * The other component tests in this folder
 * (`portal-comm-prefs-coach-payout-toggle.test.tsx`,
 * `portal-comm-prefs-whatsapp.test.tsx`,
 * `portal-comm-prefs-reset-key-prefs.test.tsx`) only exercise the toggle
 * wiring against the default English UI: they assert via `data-testid`
 * and never re-read the rendered label text. As a result a future
 * refactor that re-hardcodes any of the per-event opt-out strings
 * directly in JSX (instead of going through `t('emailOptOuts.*')`)
 * would still pass every existing test even though the row would no
 * longer translate.
 *
 * This fixture closes that gap. It boots the real i18n bundles, switches
 * the active language to Hindi, renders `PortalCommPrefs`, and asserts
 * for every visible per-event opt-out row that:
 *
 *   1. The row's label and description render the Hindi translation
 *      sourced from `src/i18n/locales/hi/portal.json`.
 *   2. The row does NOT render the English source from
 *      `src/i18n/locales/en/portal.json`.
 *
 * Reverting any label to a literal English string would re-introduce
 * the English copy under the Hindi locale and trip both assertions.
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
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// Stub `useGetMe` so the controller-only "Stuck erasure cleanup digest"
// row and the super-admin-only "Weekly silent-failure alerts CSV" row
// stay hidden — the visible-to-a-player set is exactly the surface the
// task description points at.
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "player" } }),
}));

// Boot the real i18n resources so `useTranslation('portal')` resolves
// against the Hindi bundle below instead of falling back to the bare
// key. `PortalCommPrefs.tsx` does not import `../i18n` itself — only
// `main.tsx` does — so test bundles otherwise see an uninitialised i18n
// instance.
import i18n from "../i18n";
import enPortal from "../i18n/locales/en/portal.json";
import hiPortal from "../i18n/locales/hi/portal.json";

import { PortalCommPrefs } from "../pages/portal/PortalCommPrefs";

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/my-comm-prefs")) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-key-prefs")) {
    return new Response(JSON.stringify({ digestMode: false, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-preferences") && method === "GET") {
    return new Response(
      JSON.stringify({
        notifySideGameReceipts: true,
        notifyManualEntryAlerts: true,
        notifyCoachPayoutAccountChanges: true,
        notifyAdminPayoutReverify: true,
        notifyDataExportExpiring: true,
        notifyWalletRefundDigestFailed: true,
        notifySideGameReceiptDigestFailed: true,
        // Task #1762 — three new admin per-event opt-outs for the
        // Task #1444 levy/reminders digest-failed alerts. Mirror the
        // wallet/side-game refund digest entries above so the i18n
        // assertions cover the full visible-to-a-player surface.
        notifyLevyLedgerDigestFailed: true,
        notifyLevyLedgerOrgDigestFailed: true,
        notifyLevyRemindersDigestFailed: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeAll(async () => {
  await i18n.changeLanguage("hi");
});

afterAll(async () => {
  // Restore the default so we don't leak Hindi state into other tests
  // that share this file's i18n module instance.
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

// The opt-out rows visible to a player (the role this fixture mocks).
// The controller-only `erasureStorage*` rows and the super-admin-only
// `silentAlertsDigest*` row are intentionally excluded — they are gated
// in the JSX itself and asserting on hidden rows would be a false
// positive against translation regressions.
const VISIBLE_OPT_OUT_ROWS: Array<{
  testId: string;
  labelKey: keyof typeof enPortal.emailOptOuts;
  descKey: keyof typeof enPortal.emailOptOuts;
}> = [
  {
    testId: "row-notify-manual-entry-alerts",
    labelKey: "manualEntryLabel",
    descKey: "manualEntryDesc",
  },
  {
    testId: "row-notify-coach-payout-account-changes",
    labelKey: "coachPayoutLabel",
    descKey: "coachPayoutDesc",
  },
  {
    testId: "row-notify-admin-payout-reverify",
    labelKey: "adminPayoutReverifyLabel",
    descKey: "adminPayoutReverifyDesc",
  },
  {
    testId: "row-notify-data-export-expiring",
    labelKey: "dataExportExpiringLabel",
    descKey: "dataExportExpiringDesc",
  },
  {
    testId: "row-notify-wallet-refund-digest-failed",
    labelKey: "walletRefundDigestFailedLabel",
    descKey: "walletRefundDigestFailedDesc",
  },
  {
    testId: "row-notify-side-game-receipt-digest-failed",
    labelKey: "sideGameReceiptDigestFailedLabel",
    descKey: "sideGameReceiptDigestFailedDesc",
  },
  // Task #1762 — three new admin per-event opt-outs for the Task #1444
  // levy/reminders digest-failed alerts. Like the wallet/side-game
  // refund digest rows above they are not role-gated, so a player sees
  // them and the Hindi i18n assertions cover them too.
  {
    testId: "row-notify-levy-ledger-digest-failed",
    labelKey: "levyLedgerDigestFailedLabel",
    descKey: "levyLedgerDigestFailedDesc",
  },
  {
    testId: "row-notify-levy-ledger-org-digest-failed",
    labelKey: "levyLedgerOrgDigestFailedLabel",
    descKey: "levyLedgerOrgDigestFailedDesc",
  },
  {
    testId: "row-notify-levy-reminders-digest-failed",
    labelKey: "levyRemindersDigestFailedLabel",
    descKey: "levyRemindersDigestFailedDesc",
  },
  // Task #2154 — surfaced player-facing per-event mute for the
  // "you closed the gap" coaching push. Visible to every role (the
  // dispatcher only fans out to players, but the row stays rendered
  // regardless), so the i18n coverage runs against the player fixture.
  // The super-admin-only `exhaustionAdminDigestFailed*` row is gated in
  // the JSX itself and therefore intentionally excluded from this list,
  // matching the silent-alerts-digest comment above.
  {
    testId: "row-notify-coaching-tip-closed",
    labelKey: "coachingTipClosedLabel",
    descKey: "coachingTipClosedDesc",
  },
  {
    testId: "row-notify-side-game-receipts",
    labelKey: "sideGameReceiptsLabel",
    descKey: "sideGameReceiptsDesc",
  },
];

describe("PortalCommPrefs — per-event opt-out i18n coverage (Task #1743)", () => {
  it("renders the opt-out section header in the active language (hi)", async () => {
    render(<PortalCommPrefs />);

    // Wait for the section to mount before reading any text from it.
    await screen.findByTestId("row-notify-manual-entry-alerts");

    // Sanity: the Hindi bundle actually has translated copy for the
    // section header. If a future PR ships a new opt-out without
    // translating these, this assertion fails before the per-row
    // assertions do.
    expect(hiPortal.emailOptOuts.sectionTitle).not.toBe(
      enPortal.emailOptOuts.sectionTitle,
    );
    expect(hiPortal.emailOptOuts.sectionDescription).not.toBe(
      enPortal.emailOptOuts.sectionDescription,
    );

    expect(
      screen.getByText(hiPortal.emailOptOuts.sectionTitle),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hiPortal.emailOptOuts.sectionDescription),
    ).toBeInTheDocument();

    // And the English source for the header is NOT in the document — a
    // hardcoded literal would re-introduce it under the Hindi locale.
    expect(
      screen.queryByText(enPortal.emailOptOuts.sectionTitle),
    ).toBeNull();
    expect(
      screen.queryByText(enPortal.emailOptOuts.sectionDescription),
    ).toBeNull();
  });

  it.each(VISIBLE_OPT_OUT_ROWS)(
    "renders the Hindi translation (not the English source) for $labelKey",
    async ({ testId, labelKey, descKey }) => {
      render(<PortalCommPrefs />);

      const row = await screen.findByTestId(testId);
      // Wait until the controlled toggle has finished hydrating from the
      // GET so we're asserting against the post-effect render.
      await waitFor(() =>
        expect(row.querySelector('[role="switch"]')).not.toBeNull(),
      );

      const enLabel = enPortal.emailOptOuts[labelKey];
      const enDesc = enPortal.emailOptOuts[descKey];
      const hiLabel = hiPortal.emailOptOuts[labelKey];
      const hiDesc = hiPortal.emailOptOuts[descKey];

      // Sanity: the locale file actually has translated copy for this
      // row. Catches the case where a new opt-out ships without an entry
      // in `hi/portal.json` (i18next would silently fall back to en).
      expect(hiLabel).toBeDefined();
      expect(hiDesc).toBeDefined();
      expect(hiLabel).not.toBe(enLabel);
      expect(hiDesc).not.toBe(enDesc);

      // The row renders its translated label and description...
      expect(within(row).getByText(hiLabel)).toBeInTheDocument();
      expect(within(row).getByText(hiDesc)).toBeInTheDocument();

      // ...and crucially NOT the English source. A future commit that
      // re-hardcodes the label as a string literal would re-introduce
      // the English copy under the Hindi locale and trip this assertion
      // — exactly the regression class the task description calls out.
      expect(within(row).queryByText(enLabel)).toBeNull();
      expect(within(row).queryByText(enDesc)).toBeNull();
    },
  );
});
