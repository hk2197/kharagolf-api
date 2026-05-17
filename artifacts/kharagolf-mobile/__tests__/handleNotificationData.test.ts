/**
 * Unit test for the push-notification deep-link router that backs the
 * "data export ready" tap (Tasks #618 / #778 / #923).
 *
 * Verifies the three branches of the `data_request` case:
 *   1. valid https `downloadUrl` -> Linking.openURL with that URL.
 *   2. missing `downloadUrl`     -> router.push("/portal-privacy").
 *   3. non-https / junk URL      -> router.push("/portal-privacy")
 *                                    (does NOT call Linking.openURL).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { routerMock, linkingMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn() },
  linkingMock: { openURL: vi.fn(() => Promise.resolve()) },
}));

vi.mock("expo-router", () => ({ router: routerMock }));
vi.mock("react-native", () => ({ Linking: linkingMock }));

import { handleNotificationData } from "@/utils/handleNotificationData";

beforeEach(() => {
  routerMock.push.mockReset();
  linkingMock.openURL.mockReset();
  linkingMock.openURL.mockReturnValue(Promise.resolve());
});

describe("handleNotificationData — data_request branch", () => {
  it("opens the signed download URL via Linking when a valid https URL is supplied", () => {
    const url = "https://exports.kharagolf.example/archive/abc123.zip?sig=xyz";
    handleNotificationData({ type: "data_request", downloadUrl: url });

    expect(linkingMock.openURL).toHaveBeenCalledTimes(1);
    expect(linkingMock.openURL).toHaveBeenCalledWith(url);
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("falls back to the in-app Privacy screen when downloadUrl is missing", () => {
    handleNotificationData({ type: "data_request" });

    expect(linkingMock.openURL).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/portal-privacy");
  });

  it("falls back to the Privacy screen and does NOT open a non-https URL", () => {
    for (const bad of [
      "http://insecure.example/archive.zip",
      "javascript:alert(1)",
      "ftp://example.com/file",
      "not a url at all",
      "",
    ]) {
      routerMock.push.mockReset();
      linkingMock.openURL.mockReset();

      handleNotificationData({ type: "data_request", downloadUrl: bad });

      expect(linkingMock.openURL).not.toHaveBeenCalled();
      expect(routerMock.push).toHaveBeenCalledTimes(1);
      expect(routerMock.push).toHaveBeenCalledWith("/portal-privacy");
    }
  });

  it("falls back to the Privacy screen when downloadUrl is not a string", () => {
    handleNotificationData({ type: "data_request", downloadUrl: 12345 as unknown as string });

    expect(linkingMock.openURL).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith("/portal-privacy");
  });
});

describe("handleNotificationData — social_follow_new branch (Task #1739 / #2160)", () => {
  it("deep-links to the follower's public profile via /member/[userId] when followerId is present", () => {
    handleNotificationData({
      type: "social_follow_new",
      followerId: 42,
      followerName: "Alice Anderson",
      url: "/my-follows",
    });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    // The /member/[userId] resolver transparently redirects to
    // /profile/<handle> when the follower has a reserved, opted-in
    // public handle, otherwise renders the private member card.
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/member/[userId]",
      params: { userId: "42", displayName: "Alice Anderson" },
    });
    expect(linkingMock.openURL).not.toHaveBeenCalled();
  });

  it("accepts a string-encoded followerId (some push platforms stringify numeric data fields)", () => {
    handleNotificationData({
      type: "social_follow_new",
      followerId: "57",
      followerName: "Bob Brown",
    });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/member/[userId]",
      params: { userId: "57", displayName: "Bob Brown" },
    });
  });

  it("omits displayName when the payload has no followerName", () => {
    handleNotificationData({ type: "social_follow_new", followerId: 7 });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/member/[userId]",
      params: { userId: "7" },
    });
  });

  it("falls back to the My Follows screen when followerId is missing", () => {
    handleNotificationData({
      type: "social_follow_new",
      followerName: "Carol Carter",
    });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/my-follows");
    expect(linkingMock.openURL).not.toHaveBeenCalled();
  });

  it("falls back to the My Follows screen when followerId is not a finite positive number", () => {
    for (const bad of [0, -1, NaN, Infinity, "not-a-number", null, undefined, {}]) {
      routerMock.push.mockReset();
      handleNotificationData({
        type: "social_follow_new",
        followerId: bad as unknown as number,
      });
      expect(routerMock.push).toHaveBeenCalledTimes(1);
      expect(routerMock.push).toHaveBeenCalledWith("/my-follows");
    }
  });
});

describe("handleNotificationData — coach_payout_paid branch (Task #968)", () => {
  it("opens the coach workspace earnings tab and forwards focusPayoutId when the payout-paid push is tapped", () => {
    handleNotificationData({
      type: "coach_payout_paid",
      payoutId: 42,
      organizationId: 7,
      amountPaise: 12500,
      reference: "PAY-XYZ",
      deepLink: "/coach/earnings",
    });

    expect(linkingMock.openURL).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    // Task #1116 — payoutId is forwarded as `focusPayoutId` so the workspace
    // tab can highlight + scroll to the matching payout row.
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/coach",
      params: { tab: "coach", focusPayoutId: "42" },
    });
  });

  it("omits focusPayoutId when the payload has no payoutId", () => {
    handleNotificationData({ type: "coach_payout_paid" });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/coach",
      params: { tab: "coach" },
    });
  });

  it("does not fall through to the default branch", () => {
    handleNotificationData({ type: "coach_payout_paid" });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).not.toHaveBeenCalledWith("/(tabs)/index");
  });
});
