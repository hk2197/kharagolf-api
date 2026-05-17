/**
 * Task #2025 — UI test for the search + category/channel filters on the
 * Notification template registry panel (channels admin tab).
 *
 * Verifies that:
 *   1. Typing in the search box narrows the visible rows (matches against
 *      key, category, and description) and the count badge updates to
 *      "X of Y".
 *   2. Toggling a category chip restricts the list to keys in that
 *      category. Toggling a channel chip restricts to keys whose
 *      defaultChannels include the chosen channel.
 *   3. Pressing "/" while the channels section is mounted focuses the
 *      search box (and does NOT hijack "/" while the admin is already
 *      typing in another input — important so existing inputs still work).
 *   4. The "Clear filters" button restores the full list.
 *   5. When the active filter set excludes every key, the empty-state
 *      message renders with a clear-filters fallback.
 *
 * Companion to admin-notification-template-preview.test.tsx (Task #1631)
 * which exercises the per-row "Preview template" action against the same
 * panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin", preferredLanguage: "en" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import SettingsPage from "../admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ORG = {
  id: 42,
  name: "Pine Valley",
  slug: "pinevalley",
  description: null,
  logoUrl: null,
  primaryColor: "#1e4d2b",
  customDomain: null,
  subscriptionTier: "enterprise",
  isActive: true,
  contactEmail: null,
  contactPhone: null,
  address: null,
  website: null,
  defaultLanguage: "en",
};

// Mix of categories and default channels so each filter axis can be
// independently exercised:
//   handicap  → email (description mentions "handicap committee")
//   handicap  → push  (description mentions "handicap profile")
//   tee       → email + push
//   tee       → push  only
//   social    → email + sms (description mentions "follower")
const REGISTERED_ENTRIES = [
  {
    key: "handicap.committee.changed",
    category: "handicap",
    description: "The handicap committee changed your index.",
    defaultChannels: ["email"],
    auditRequired: true,
  },
  {
    key: "handicap.profile.updated",
    category: "handicap",
    description: "Your handicap profile was updated.",
    defaultChannels: ["push"],
    auditRequired: false,
  },
  {
    key: "booking.confirmed",
    category: "tee",
    description: "Tee-time booking confirmed.",
    defaultChannels: ["email", "push"],
    auditRequired: false,
  },
  {
    key: "booking.reminder.2h",
    category: "tee",
    description: "Tee-time reminder, 2 hours before.",
    defaultChannels: ["push"],
    auditRequired: false,
  },
  {
    key: "social.follower.added",
    category: "social",
    description: "Someone followed you on the feed.",
    defaultChannels: ["email", "sms"],
    auditRequired: false,
  },
];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/organizations/42")) return jsonResponse(ORG);
      if (url.endsWith("/api/admin/channel-status")) {
        return jsonResponse({
          channels: {
            email: { active: false, provider: null, setupInstructions: null },
            push: { active: false, provider: null, setupInstructions: null },
            sms: { active: false, provider: null, setupInstructions: null },
            whatsapp: { active: false, provider: null, setupInstructions: null },
          },
          payments: {
            stripe: {
              baseCurrency: "USD",
              usesStripe: false,
              secretKeyConfigured: false,
              webhookSecretConfigured: false,
              webhookEndpoint: "/api/stripe/webhook",
              warning: false,
              setupInstructions: null,
            },
          },
        });
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: REGISTERED_ENTRIES });
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: null, email: null },
          defaults: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: 0, fallbackEmail: null },
        });
      }
      // Other admin queries the channels card fires read deeply nested
      // shapes that would crash on `{}`. Return 404 so each query's
      // `if (!r.ok) throw` keeps `data` undefined and those UI blocks
      // simply don't render.
      if (url.startsWith("/api/admin/")) return jsonResponse({ error: "n/a" }, 404);
      return jsonResponse({}, 200);
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

async function switchToChannelsSection() {
  const buttons = await screen.findAllByRole("button");
  const channelsButton = buttons.find(b => /channel/i.test(b.textContent ?? ""));
  if (!channelsButton) throw new Error("Could not find a channels-section sidebar button");
  fireEvent.click(channelsButton);
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Notification template registry filters (Task #2025)", () => {
  it("renders the search box, category chips, and channel chips with all rows visible by default", async () => {
    renderPage();
    await switchToChannelsSection();

    // All five rows are rendered initially and the count badge shows
    // the unfiltered total.
    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);
    for (const e of REGISTERED_ENTRIES) {
      expect(screen.getByTestId(`row-registry-key-${e.key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("5");

    // One chip per distinct category and per distinct default channel.
    expect(screen.getByTestId("chip-notification-registry-category-handicap")).toBeInTheDocument();
    expect(screen.getByTestId("chip-notification-registry-category-tee")).toBeInTheDocument();
    expect(screen.getByTestId("chip-notification-registry-category-social")).toBeInTheDocument();
    expect(screen.getByTestId("chip-notification-registry-channel-email")).toBeInTheDocument();
    expect(screen.getByTestId("chip-notification-registry-channel-push")).toBeInTheDocument();
    expect(screen.getByTestId("chip-notification-registry-channel-sms")).toBeInTheDocument();

    // Search box is present and empty; no clear-filters button yet.
    const search = screen.getByTestId("input-notification-registry-search") as HTMLInputElement;
    expect(search.value).toBe("");
    expect(screen.queryByTestId("button-notification-registry-clear-filters")).not.toBeInTheDocument();
  });

  it("narrows the list as the admin types into the search box (matches key, category and description)", async () => {
    renderPage();
    await switchToChannelsSection();

    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);
    const search = screen.getByTestId("input-notification-registry-search") as HTMLInputElement;

    fireEvent.change(search, { target: { value: "handicap" } });

    await waitFor(() => {
      expect(screen.getByTestId("row-registry-key-handicap.committee.changed")).toBeInTheDocument();
      expect(screen.getByTestId("row-registry-key-handicap.profile.updated")).toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-booking.confirmed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-booking.reminder.2h")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-social.follower.added")).not.toBeInTheDocument();
    });

    // Badge reports "matches of total" while a filter is active.
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("2 of 5");

    // Description-text matches as well — "follower" is only in the
    // description for social.follower.added.
    fireEvent.change(search, { target: { value: "follower" } });
    await waitFor(() => {
      expect(screen.getByTestId("row-registry-key-social.follower.added")).toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-handicap.committee.changed")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("1 of 5");
  });

  it("filters by category chip and by channel chip independently", async () => {
    renderPage();
    await switchToChannelsSection();

    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);

    // Category: tee → only the two booking.* rows remain.
    fireEvent.click(screen.getByTestId("chip-notification-registry-category-tee"));
    await waitFor(() => {
      expect(screen.getByTestId("row-registry-key-booking.confirmed")).toBeInTheDocument();
      expect(screen.getByTestId("row-registry-key-booking.reminder.2h")).toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-handicap.committee.changed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-social.follower.added")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("2 of 5");

    // Click again to deselect → list returns to all 5.
    fireEvent.click(screen.getByTestId("chip-notification-registry-category-tee"));
    await waitFor(() => {
      expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("5");
    });

    // Channel: push → keys whose defaultChannels include "push"
    // (handicap.profile.updated, booking.confirmed, booking.reminder.2h).
    fireEvent.click(screen.getByTestId("chip-notification-registry-channel-push"));
    await waitFor(() => {
      expect(screen.getByTestId("row-registry-key-handicap.profile.updated")).toBeInTheDocument();
      expect(screen.getByTestId("row-registry-key-booking.confirmed")).toBeInTheDocument();
      expect(screen.getByTestId("row-registry-key-booking.reminder.2h")).toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-handicap.committee.changed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-social.follower.added")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("3 of 5");
  });

  it("renders the empty state when filters exclude every key, with a clear-filters fallback", async () => {
    renderPage();
    await switchToChannelsSection();

    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);

    // social + push has no overlap → empty.
    fireEvent.click(screen.getByTestId("chip-notification-registry-category-social"));
    fireEvent.click(screen.getByTestId("chip-notification-registry-channel-push"));

    await waitFor(() => {
      expect(screen.getByTestId("empty-notification-registry")).toBeInTheDocument();
      expect(screen.queryByTestId("list-notification-registry")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("0 of 5");

    // Empty-state has its own clear-filters button.
    fireEvent.click(screen.getByTestId("button-notification-registry-empty-clear"));
    await waitFor(() => {
      expect(screen.queryByTestId("empty-notification-registry")).not.toBeInTheDocument();
      expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("5");
    });
  });

  it("Clear filters button resets search + chips", async () => {
    renderPage();
    await switchToChannelsSection();

    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);

    const search = screen.getByTestId("input-notification-registry-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "handicap" } });
    fireEvent.click(screen.getByTestId("chip-notification-registry-channel-email"));

    await waitFor(() => {
      // handicap + email → only handicap.committee.changed.
      expect(screen.getByTestId("row-registry-key-handicap.committee.changed")).toBeInTheDocument();
      expect(screen.queryByTestId("row-registry-key-handicap.profile.updated")).not.toBeInTheDocument();
      expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("1 of 5");
    });

    fireEvent.click(screen.getByTestId("button-notification-registry-clear-filters"));

    await waitFor(() => {
      expect(search.value).toBe("");
      expect(screen.getByTestId("badge-notification-registry-count").textContent?.trim()).toBe("5");
      expect(screen.getByTestId("row-registry-key-social.follower.added")).toBeInTheDocument();
    });

    // The chip should no longer appear pressed (aria-pressed=false).
    expect(
      screen.getByTestId("chip-notification-registry-channel-email").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("focuses the search box when the admin presses '/' (and ignores '/' while typing in another input)", async () => {
    renderPage();
    await switchToChannelsSection();

    const search = await screen.findByTestId("input-notification-registry-search") as HTMLInputElement;
    expect(document.activeElement).not.toBe(search);

    // Press "/" outside any input → focuses the registry search box.
    fireEvent.keyDown(window, { key: "/" });
    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });

    // Now type "/" while focused inside another <input>: the shortcut
    // must NOT hijack the keystroke. We use the search input itself as
    // the "other" input here (it is an INPUT element, so the shortcut
    // handler should bail). Confirm the shortcut handler does not call
    // preventDefault by sending the event with a target that is an INPUT
    // and verifying the input keeps focus and value unchanged.
    search.blur();
    // Mount a second input and focus it.
    const otherInput = document.createElement("input");
    document.body.appendChild(otherInput);
    otherInput.focus();
    expect(document.activeElement).toBe(otherInput);

    // Dispatch the keydown from the focused input. The shortcut handler
    // should detect target.tagName === "INPUT" and bail out, leaving
    // focus on otherInput.
    fireEvent.keyDown(otherInput, { key: "/" });
    expect(document.activeElement).toBe(otherInput);

    document.body.removeChild(otherInput);
  });

  it("keeps the existing per-row Preview template / View audit actions on filtered rows", async () => {
    renderPage();
    await switchToChannelsSection();

    await screen.findByTestId(`row-registry-key-${REGISTERED_ENTRIES[0].key}`);

    fireEvent.click(screen.getByTestId("chip-notification-registry-category-tee"));

    const row = await screen.findByTestId("row-registry-key-booking.confirmed");
    // Both actions still exist on the visible row — filters must not
    // alter the row contents, just which rows render.
    expect(within(row).getByTestId("button-registry-preview-template-booking.confirmed")).toBeInTheDocument();
    expect(within(row).getByTestId("link-registry-view-audit-booking.confirmed")).toBeInTheDocument();
  });
});
