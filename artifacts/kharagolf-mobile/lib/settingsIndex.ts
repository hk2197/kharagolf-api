import type { TFunction } from "i18next";

export interface SettingsIndexEntry {
  /**
   * Stable identifier — also used as the React key in the search results
   * list and as the testID suffix (`row-settings-search-${id}`). Must be
   * unique across the index.
   */
  id: string;
  /** Translated title shown as the primary line of the result row. */
  label: string;
  /**
   * Optional translated subtitle / context line. Surfaced in the result
   * row and also fed into the search match so members can find a row by
   * words in the description (e.g. "wager" → side-game receipts).
   */
  description?: string;
  /**
   * Translated breadcrumb shown in the result row so the member knows
   * which screen the toggle lives on (e.g. "Communications").
   */
  breadcrumb?: string;
  /**
   * Optional locale-agnostic keywords (English-only). Useful for the
   * canonical English term — e.g. members typing "side game" should
   * still find the row even on locales whose label translates "side"
   * differently. Always lowercased on lookup.
   */
  keywords?: string[];
  /** Expo-router pathname to push on tap. */
  href: string;
  /** Optional route params passed to the destination. */
  params?: Record<string, string>;
}

interface BuildOptions {
  /** True when the current member has admin privileges — gates admin-only
   * entries (mirrors the same gate the More tab applies). */
  isAdmin: boolean;
}

/**
 * Build the searchable settings index for the current locale.
 *
 * Two kinds of entries live here:
 *   1. Top-level navigation rows that are also rendered on the More tab
 *      (so a member can search for "wallet" and jump straight to it).
 *   2. Deep-link rows for individual notification toggles inside the
 *      Communications screen — each carries a `focus` param that the
 *      destination uses to scroll to and highlight the matching row
 *      (Task #1495 plumbing). This is the pattern that makes the
 *      side-game receipts toggle (and the rest of the per-event opt-out
 *      switches) discoverable from search.
 *
 * The labels and descriptions resolve through i18next so search matches
 * against the member's locale; the small `keywords` arrays preserve the
 * canonical English term so a search for "side game" works even when
 * the localised label uses different wording.
 */
export function buildSettingsIndex(
  t: TFunction,
  options: BuildOptions = { isAdmin: false },
): SettingsIndexEntry[] {
  const navT = t as unknown as (key: string, opts?: object) => string;
  const profileT = t as unknown as (
    key: string,
    opts?: object,
  ) => string;
  const moreItem = (key: string) => navT(`moreItems.${key}`);
  const navBreadcrumb = navT("more");
  const commsBreadcrumb = navT("moreItems.notifications");

  const entries: SettingsIndexEntry[] = [
    // ── More-tab destinations (account, compete, practice, etc.) ─────
    {
      id: "profile",
      label: moreItem("profile"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/profile",
    },
    {
      id: "club",
      label: moreItem("club"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/club",
    },
    {
      id: "notifications",
      label: moreItem("notifications"),
      breadcrumb: navBreadcrumb,
      href: "/notifications",
    },
    {
      id: "wallet",
      label: moreItem("wallet"),
      breadcrumb: navBreadcrumb,
      href: "/wallet",
    },
    {
      id: "leagues",
      label: moreItem("leagues"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/leagues",
    },
    {
      id: "match-play",
      label: moreItem("matchPlay"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/match-play",
    },
    {
      id: "fantasy",
      label: moreItem("fantasy"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/fantasy",
    },
    {
      id: "feed",
      label: moreItem("feed"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/feed",
    },
    {
      id: "updates",
      label: moreItem("updates"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/updates",
    },
    {
      id: "range",
      label: moreItem("range"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/range",
    },
    {
      id: "lessons",
      label: moreItem("lessons"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/lessons",
    },
    {
      id: "coach",
      label: moreItem("coach"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/coach",
    },
    {
      id: "stats",
      label: moreItem("stats"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/stats",
    },
    {
      id: "junior",
      label: moreItem("junior"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/junior",
    },
    {
      id: "marker",
      label: moreItem("marker"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/marker",
    },
    {
      id: "course-conditions",
      label: moreItem("courseConditions"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/course-conditions",
    },
    {
      id: "rentals",
      label: moreItem("rentals"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/rentals",
    },
    {
      id: "trips",
      label: moreItem("trips"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/trips",
    },
    {
      id: "shop",
      label: moreItem("shop"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/shop",
    },
    {
      id: "orders",
      label: moreItem("orders"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/order",
    },
    {
      id: "rules",
      label: moreItem("rules"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/rules",
    },
    {
      id: "governance",
      label: moreItem("governance"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/governance",
    },
    {
      id: "documents",
      label: moreItem("documents"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/documents",
    },
    {
      id: "surveys",
      label: moreItem("surveys"),
      breadcrumb: navBreadcrumb,
      href: "/(tabs)/surveys",
    },
    // ── Communications screen — per-event email opt-outs ─────────────
    // Each row deep-links into `/my-360/communications` with a `focus`
    // query param. The destination screen reads that param, scrolls to
    // the matching row and briefly highlights it (Task #1495 pattern).
    {
      id: "comms-side-game-receipts",
      label: profileT("commPrefs.emailOptOuts.sideGameReceiptsLabel"),
      description: profileT("commPrefs.emailOptOuts.sideGameReceiptsDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["side game", "receipt", "wager", "skins", "payment"],
      href: "/my-360/communications",
      params: { focus: "sideGameReceipts" },
    },
    {
      id: "comms-data-export-expiring",
      label: profileT("commPrefs.emailOptOuts.dataExportExpiringLabel"),
      description: profileT("commPrefs.emailOptOuts.dataExportExpiringDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["data export", "expiring", "download", "privacy"],
      href: "/my-360/communications",
    },
    {
      id: "comms-manual-entry",
      label: profileT("commPrefs.emailOptOuts.manualEntryLabel"),
      description: profileT("commPrefs.emailOptOuts.manualEntryDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["manual entry", "data quality", "tournament director"],
      href: "/my-360/communications",
    },
    {
      id: "comms-coach-payout",
      label: profileT("commPrefs.emailOptOuts.coachPayoutLabel"),
      description: profileT("commPrefs.emailOptOuts.coachPayoutDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["coach", "payout", "stripe"],
      href: "/my-360/communications",
    },
    {
      id: "comms-admin-payout-reverify",
      label: profileT("commPrefs.emailOptOuts.adminPayoutReverifyLabel"),
      description: profileT("commPrefs.emailOptOuts.adminPayoutReverifyDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["payout", "verify", "verification", "admin"],
      href: "/my-360/communications",
    },
    {
      id: "comms-erasure-storage-digest",
      label: profileT("commPrefs.emailOptOuts.erasureStorageDigestLabel"),
      description: profileT("commPrefs.emailOptOuts.erasureStorageDigestDesc"),
      breadcrumb: commsBreadcrumb,
      keywords: ["erasure", "cleanup", "controller", "digest", "storage"],
      href: "/my-360/communications",
    },
  ];

  if (options.isAdmin) {
    entries.push({
      id: "club-settings",
      label: moreItem("clubSettings"),
      breadcrumb: navBreadcrumb,
      href: "/club-admin/club-settings",
    });
  }

  return entries;
}

/**
 * Normalise a string for case- and punctuation-insensitive token matching.
 * Lowercases, replaces every non-letter / non-digit character (using
 * Unicode property escapes so it works across scripts) with a space, then
 * collapses runs of whitespace.
 */
function normalise(input: string): string {
  return input
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filter the index against a free-form query. Every whitespace-separated
 * token in the query must appear somewhere in the haystack (label +
 * description + keywords). Tokens match anywhere inside a haystack token,
 * so "rec" matches "receipts" and "side game" matches "Side-game payment
 * receipts".
 */
export function filterSettingsIndex(
  index: SettingsIndexEntry[],
  query: string,
): SettingsIndexEntry[] {
  const normQuery = normalise(query);
  if (!normQuery) return [];
  const tokens = normQuery.split(" ");
  return index.filter(entry => {
    const haystack = [
      entry.label,
      entry.description ?? "",
      entry.breadcrumb ?? "",
      ...(entry.keywords ?? []),
    ]
      .map(normalise)
      .join(" ");
    return tokens.every(tok => haystack.includes(tok));
  });
}
