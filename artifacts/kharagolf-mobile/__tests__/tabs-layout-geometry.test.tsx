/**
 * Task #908 — Snapshot tests for the mobile bottom tab bar geometry.
 *
 * The bottom tab bar was redesigned in Task #902 (height, padding,
 * icon family, label spacing, badge position). These tests pin the
 * layout values so a future tweak to `_layout.tsx` cannot silently
 * regress badge overlap, label clipping, or safe-area handling.
 *
 * Strategy:
 *   - Mock `expo-router` so we can capture `<Tabs screenOptions=... >`
 *     and every `<Tabs.Screen name=... options=... />` declaration
 *     emitted by the real `_layout.tsx`.
 *   - Inspect the captured screen list to verify exactly 4 visible
 *     primary tabs and that every other screen is hidden via
 *     `{ href: null }`.
 *   - Render the captured `tabBarIcon` for the More tab against
 *     several unread counts and assert the badge text + that its
 *     bounding box does not visually overlap the icon glyph.
 *   - Pin label/icon spacing and bar-height math (72 + bottom inset).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Platform } from "react-native";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the layout under test.
// ---------------------------------------------------------------------------

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    tabIconDefault: "#888",
    error: "#ef4444",
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    i18n: { language: "en", changeLanguage: async () => {} },
  }),
}));

vi.mock("expo-blur", () => {
  const React = require("react");
  return {
    BlurView: (props: Record<string, unknown>) =>
      React.createElement("div", { ...props, "data-testid": "blur-view" }),
  };
});

const mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

let mockMoreTotal = 0;
let mockMoreCounts = { notifications: 0, feed: 0, updates: 0, wallet: 0 };
vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({
    total: mockMoreTotal,
    counts: mockMoreCounts,
    refresh: () => {},
    markFeedSeen: async () => {},
    subscribe: () => () => {},
  }),
  useBadgePolling: () => {},
}));

let mockNotifUnreadCount = 0;
vi.mock("@/context/unread", () => ({
  useUnread: () => ({
    notifUnreadCount: mockNotifUnreadCount,
    unreadCount: mockNotifUnreadCount,
    refresh: () => {},
    markAllSeen: async () => {},
  }),
}));

interface CapturedScreen {
  name: string;
  options: Record<string, unknown> | undefined;
}
interface Captured {
  screenOptions?: Record<string, any>;
  screens: CapturedScreen[];
}
const captured: Captured = { screens: [] };

vi.mock("expo-router", () => {
  const React = require("react");
  function Tabs(props: { screenOptions?: Record<string, any>; children?: React.ReactNode }) {
    captured.screenOptions = props.screenOptions;
    return React.createElement(React.Fragment, null, props.children);
  }
  (Tabs as unknown as { Screen: React.FC<CapturedScreen> }).Screen = function Screen(
    props: CapturedScreen,
  ) {
    captured.screens.push({ name: props.name, options: props.options });
    return null;
  };
  return { Tabs };
});

// ---------------------------------------------------------------------------
// Now import the layout (and named exports) under test.
// ---------------------------------------------------------------------------
import TabLayout, {
  ICON_SIZE,
  TAB_BAR_HEIGHT,
  UnreadBadge,
  tabBarLayoutStyles,
} from "../app/(tabs)/_layout";

beforeEach(() => {
  captured.screens = [];
  captured.screenOptions = undefined;
  mockMoreTotal = 0;
  mockMoreCounts = { notifications: 0, feed: 0, updates: 0, wallet: 0 };
  mockNotifUnreadCount = 0;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Visible vs hidden tabs
// ---------------------------------------------------------------------------

describe("(tabs)/_layout — primary tab structure", () => {
  it("declares the documented primary tabs in order and hides every other route", () => {
    render(<TabLayout />);

    const visible = captured.screens.filter(
      s => !s.options || (s.options as { href?: unknown }).href !== null,
    );
    const hidden = captured.screens.filter(
      s => s.options && (s.options as { href?: unknown }).href === null,
    );

    // Task #902 originally shipped 4 primary tabs. A follow-up
    // ("Show notifications in the mobile bottom-tab bar") inserted a
    // dedicated `notifications` tab between leaderboard and more so
    // unread alerts are reachable without opening the More sheet. We
    // pin the *current* tab list — and its exact order — so adding,
    // removing, or reordering any visible tab is caught loudly.
    const visibleNames = visible.map(s => s.name);
    expect(visibleNames).toEqual([
      "index",
      "score",
      "leaderboard",
      "notifications",
      "more",
    ]);

    // All other tab files in app/(tabs)/ must be hidden from the bar.
    const hiddenNames = new Set(hidden.map(s => s.name));
    for (const name of [
      "profile",
      "club",
      "marker",
      "feed",
      "updates",
      "leagues",
      "match-play",
      "rules",
      "range",
      "order",
      "fantasy",
      "shop",
      "junior",
      "stats",
      "lessons",
      "coach",
      "governance",
      "documents",
      "trips",
      "rentals",
      "course-conditions",
      "surveys",
    ]) {
      expect(hiddenNames.has(name)).toBe(true);
    }
    expect(hidden.length).toBeGreaterThanOrEqual(visible.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Bar height (72 + bottom safe-area inset) and label/icon spacing
// ---------------------------------------------------------------------------

describe("(tabs)/_layout — bar geometry & label spacing", () => {
  it("on native, sets bar height to 72 + bottom safe-area inset and reserves the inset as padding", () => {
    // Force the native code path; the test environment defaults to "web"
    // because we resolve `react-native` -> `react-native-web`.
    const original = Platform.OS;
    //                      mutable on react-native-web's plain object.
    Platform.OS = "ios";
    try {
      render(<TabLayout />);
      const tabBarStyle = captured.screenOptions!.tabBarStyle as Record<
        string,
        unknown
      >;

      expect(TAB_BAR_HEIGHT).toBe(72);
      expect(tabBarStyle.height).toBe(TAB_BAR_HEIGHT + mockInsets.bottom);
      expect(tabBarStyle.paddingBottom).toBe(mockInsets.bottom);
      expect(tabBarStyle.paddingTop).toBe(8);
      expect(tabBarStyle.position).toBe("absolute");
      expect(tabBarStyle.borderTopWidth).toBe(1);
    } finally {
      Platform.OS = original;
    }
  });

  it("clamps the safe-area inset to a minimum of 8 so the bar never crowds the home indicator", () => {
    const tinyInsets = { top: 0, bottom: 2, left: 0, right: 0 };
    const originalBottom = mockInsets.bottom;
    mockInsets.bottom = tinyInsets.bottom;
    const originalOS = Platform.OS;
    Platform.OS = "ios";
    try {
      render(<TabLayout />);
      const tabBarStyle = captured.screenOptions!.tabBarStyle as Record<
        string,
        unknown
      >;
      // bottomInset = max(insets.bottom, 8)
      expect(tabBarStyle.paddingBottom).toBe(8);
      expect(tabBarStyle.height).toBe(TAB_BAR_HEIGHT + 8);
    } finally {
      mockInsets.bottom = originalBottom;
      Platform.OS = originalOS;
    }
  });

  it("pins label typography and icon spacing so labels can't clip into the icons", () => {
    render(<TabLayout />);
    const opts = captured.screenOptions!;
    const labelStyle = opts.tabBarLabelStyle as Record<string, unknown>;
    const iconStyle = opts.tabBarIconStyle as Record<string, unknown>;
    const itemStyle = opts.tabBarItemStyle as Record<string, unknown>;

    expect(labelStyle.fontSize).toBe(11);
    expect(labelStyle.marginTop).toBe(4); // gap between icon and label
    expect(labelStyle.marginBottom).toBe(0);
    expect(labelStyle.letterSpacing).toBeCloseTo(0.3);

    expect(iconStyle.marginTop).toBe(0);
    expect(iconStyle.marginBottom).toBe(0);

    expect(itemStyle.paddingTop).toBe(0);
    expect(itemStyle.paddingBottom).toBe(0);
    expect(itemStyle.justifyContent).toBe("center");
  });
});

// ---------------------------------------------------------------------------
// 3. Unread badge — counts 0 / 1 / 12 / 99+, and badge does not overlap
//    the icon glyph
// ---------------------------------------------------------------------------

describe("(tabs)/_layout — unread badge on the More tab", () => {
  it("renders nothing at count 0", () => {
    const { container } = render(<UnreadBadge count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it.each([
    [1, "1"],
    [12, "12"],
    [99, "99"],
    [100, "99+"],
    [4321, "99+"],
  ])("renders count %i as %s", (count, label) => {
    const { container } = render(<UnreadBadge count={count} />);
    expect(container.textContent).toBe(label);
  });

  it("renders the aggregated More-tab badge total inside the icon when any sub-row has unread items", () => {
    // total = notifications + feed + updates + wallet, surfaced from
    // MoreBadgesProvider so the user sees a single roll-up on the tab bar.
    mockMoreTotal = 7;
    mockMoreCounts = { notifications: 3, feed: 2, updates: 1, wallet: 1 };
    render(<TabLayout />);
    const moreTab = captured.screens.find(s => s.name === "more");
    expect(moreTab).toBeTruthy();
    const tabBarIcon = (moreTab!.options as { tabBarIcon?: Function })
      .tabBarIcon;
    expect(typeof tabBarIcon).toBe("function");

    const node = (tabBarIcon as Function)({ color: "#fff", focused: false });
    const { container } = render(node);
    expect(container.textContent).toContain("7");
  });

  it("hides the More-tab badge when the aggregated total is zero", () => {
    mockMoreTotal = 0;
    render(<TabLayout />);
    const moreTab = captured.screens.find(s => s.name === "more");
    const tabBarIcon = (moreTab!.options as { tabBarIcon?: Function })
      .tabBarIcon as Function;
    const { container } = render(tabBarIcon({ color: "#fff", focused: false }));
    expect(container.textContent).toBe("");
  });

  it("caps the More-tab badge label at '99+' when the aggregated total exceeds 99", () => {
    mockMoreTotal = 250;
    render(<TabLayout />);
    const moreTab = captured.screens.find(s => s.name === "more");
    const tabBarIcon = (moreTab!.options as { tabBarIcon?: Function })
      .tabBarIcon as Function;
    const { container } = render(tabBarIcon({ color: "#fff", focused: false }));
    expect(container.textContent).toBe("99+");
  });

  it("anchors the badge above and to the right of the icon container without occluding the glyph", () => {
    const wrap = tabBarLayoutStyles.badgeWrap as {
      top: number; right: number;
    };
    const badge = tabBarLayoutStyles.badge as {
      minWidth: number; height: number;
    };
    const iconContainer = tabBarLayoutStyles.iconContainer as {
      width: number; height: number;
    };

    // Badge must hang above the container's top-right corner.
    expect(wrap.top).toBeLessThan(0);
    expect(wrap.right).toBeLessThan(0);
    expect(badge.minWidth).toBeGreaterThanOrEqual(16);
    expect(badge.height).toBeGreaterThanOrEqual(16);

    // Compute the badge's bounding box in container-local coordinates.
    const badgeBox = {
      left: iconContainer.width - (badge.minWidth + wrap.right),
      right: iconContainer.width - wrap.right,
      top: wrap.top,
      bottom: wrap.top + badge.height,
    };

    // The icon glyph is centered inside the icon container at ICON_SIZE.
    const iconBox = {
      left: (iconContainer.width - ICON_SIZE) / 2,
      right: (iconContainer.width + ICON_SIZE) / 2,
      top: (iconContainer.height - ICON_SIZE) / 2,
      bottom: (iconContainer.height + ICON_SIZE) / 2,
    };

    // The badge sits in the upper-right; its center must be outside the
    // icon's bounding box (otherwise it would sit on top of the glyph).
    const badgeCenter = {
      x: (badgeBox.left + badgeBox.right) / 2,
      y: (badgeBox.top + badgeBox.bottom) / 2,
    };
    const inside =
      badgeCenter.x >= iconBox.left &&
      badgeCenter.x <= iconBox.right &&
      badgeCenter.y >= iconBox.top &&
      badgeCenter.y <= iconBox.bottom;
    expect(inside).toBe(false);

    // And the area shared between the two boxes must be a small fraction
    // of the icon — a regression that drags the badge back over the glyph
    // (e.g. removing the negative top/right offsets) would balloon this
    // ratio well past the 5% threshold.
    const overlapW = Math.max(
      0,
      Math.min(badgeBox.right, iconBox.right) -
        Math.max(badgeBox.left, iconBox.left),
    );
    const overlapH = Math.max(
      0,
      Math.min(badgeBox.bottom, iconBox.bottom) -
        Math.max(badgeBox.top, iconBox.top),
    );
    const overlapArea = overlapW * overlapH;
    const iconArea = ICON_SIZE * ICON_SIZE;
    expect(overlapArea / iconArea).toBeLessThan(0.05);
  });

  it("styles the badge text with a tight line-height that doesn't push the digits out of the pill", () => {
    const text = tabBarLayoutStyles.badgeText as {
      fontSize: number; lineHeight: number;
    };
    const badge = tabBarLayoutStyles.badge as { height: number };
    expect(text.lineHeight).toBeLessThanOrEqual(badge.height);
    expect(text.fontSize).toBeLessThanOrEqual(text.lineHeight);
  });
});
