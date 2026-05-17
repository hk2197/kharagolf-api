import { router } from "expo-router";
import { Linking } from "react-native";

/**
 * Routes a tapped push-notification payload to the correct in-app screen.
 *
 * Extracted from `app/_layout.tsx` so it can be unit-tested without
 * mounting the full root layout. The push payload (data) is expected to
 * carry:
 *   type        — string discriminator (see cases below)
 *   tournamentId — number (when related to a specific tournament)
 *   leagueId     — number (when related to a specific league)
 *   orderId      — string/number (when related to a shop order)
 */
export function handleNotificationData(data: Record<string, unknown> | undefined) {
  const type = data?.type as string | undefined;
  const tournamentId = data?.tournamentId as number | undefined;
  const leagueId = data?.leagueId as number | undefined;

  // Handicap committee case update — deep-link to the player's handicap profile.
  if (type === "handicap_case_update") {
    const url = typeof data?.url === "string" ? (data.url as string) : "";
    const HANDICAP_ROUTES = ["/handicap-profile", "/notifications"] as const;
    const target = HANDICAP_ROUTES.find((r) => url === r || url.startsWith(`${r}/`) || url.startsWith(`${r}?`));
    router.push((target ?? "/handicap-profile") as never);
    return;
  }

  // Peer-review deep link: extract the token from `token` or from the `url` field.
  if (type === "handicap_peer_review") {
    let token = data?.token as string | undefined;
    if (!token && typeof data?.url === "string") {
      const m = (data.url as string).match(/\/peer-review\/([^/?#]+)/);
      if (m) {
        try { token = decodeURIComponent(m[1]); } catch { token = m[1]; }
      }
    }
    if (token) {
      router.push(`/peer-review/${encodeURIComponent(token)}` as never);
      return;
    }
  }

  // Wearable disconnected — sign-in expired on Whoop/Google Fit/etc.
  if (type === "wearable_disconnected") {
    router.push("/(tabs)/profile");
    return;
  }

  // Privacy / data-request notification — Tasks #618/#778. The export-ready
  // notice ships a one-tap signed `downloadUrl` in its data payload; when
  // present we open it directly so the member doesn't have to find the
  // archive manually. Any other data-request notice (or a missing/invalid
  // URL) falls back to the in-app Privacy screen.
  if (type === "data_request") {
    const downloadUrl = typeof data?.downloadUrl === "string" ? (data.downloadUrl as string) : "";
    if (downloadUrl && /^https:\/\//i.test(downloadUrl)) {
      Linking.openURL(downloadUrl).catch(() => {
        router.push("/portal-privacy" as never);
      });
      return;
    }
    router.push("/portal-privacy" as never);
    return;
  }

  // Round-robin tie-break required (Task #899) — deep-link to the bracket.
  if (type === "round_robin_tie_break_required") {
    const matchId = data?.matchId;
    if (tournamentId) {
      router.push({
        pathname: "/(tabs)/match-play",
        params: {
          tournamentId: String(tournamentId),
          ...(matchId != null ? { focusMatchId: String(matchId) } : {}),
        },
      });
    } else {
      router.push("/(tabs)/match-play");
    }
    return;
  }

  // Coach payout paid (Task #968) — drop the coach into the Coach Workspace
  // tab where the new payout row appears. The server payload (Task #774)
  // ships `deepLink: "/coach/earnings"`; we honour that path but route to the
  // existing Expo screen which renders the earnings card under the
  // `tab=coach` param.
  if (type === "coach_payout_paid") {
    const payoutId = data?.payoutId;
    router.push({
      pathname: "/(tabs)/coach",
      params: {
        tab: "coach",
        ...(payoutId != null ? { focusPayoutId: String(payoutId) } : {}),
      },
    });
    return;
  }

  // Task #1739 / #2160 — someone new started following the recipient.
  // The dispatch payload ships `followerId` (and `followerName` for the
  // body); when present we deep-link straight to the follower's public
  // profile via the `/member/[userId]` resolver, which transparently
  // redirects to `/profile/<handle>` if the player has a reserved,
  // opted-in public handle (see app/member/[userId].tsx). When the id
  // is missing or not a finite number we fall back to the My Follows
  // screen so the recipient still has a useful destination — matching
  // the original Task #1739 behaviour.
  if (type === "social_follow_new") {
    const rawFollowerId = data?.followerId;
    const followerId = typeof rawFollowerId === "number"
      ? rawFollowerId
      : typeof rawFollowerId === "string" ? Number(rawFollowerId) : NaN;
    if (Number.isFinite(followerId) && followerId > 0) {
      const followerName = typeof data?.followerName === "string"
        ? (data.followerName as string)
        : "";
      router.push({
        pathname: "/member/[userId]",
        params: {
          userId: String(followerId),
          ...(followerName ? { displayName: followerName } : {}),
        },
      });
      return;
    }
    router.push("/my-follows" as never);
    return;
  }

  // Task #2106 — admin re-subscribed the recipient to a previously-silenced
  // email category (round-robin tie-break alerts or bounced-reminders
  // schedule-change digests). Task #1693 ships this push with
  // `deepLink: "/my-360/communications"` so the recipient can re-silence the
  // email in one tap; deep-link straight to the notification preferences
  // screen, mirroring how other admin-driven types (e.g. `coach_payout_paid`)
  // are routed.
  if (
    type === "tie_break_email_admin_resubscribe"
    || type === "bounced_digest_schedule_admin_resubscribe"
  ) {
    router.push("/my-360/communications" as never);
    return;
  }

  // Task #2111 — feed-post fan-out push. Drop the recipient on the Feed
  // tab; when the originating post id is in the payload (Task #1697), it
  // is forwarded as `focusPostId` so the Feed screen can scroll/highlight
  // the row. The same data shape is used by the in-app notifications
  // inbox row's `handleOpenFeedPost` so both entry points behave the same.
  if (type === "feed_post") {
    const postId = data?.postId;
    const orgId = data?.orgId;
    router.push({
      pathname: "/(tabs)/feed",
      params: {
        ...(postId != null ? { focusPostId: String(postId) } : {}),
        ...(orgId != null ? { orgId: String(orgId) } : {}),
      },
    });
    return;
  }

  // Highlight reel render finished — deep-link to the highlights screen.
  if (type === "highlight_render_complete") {
    const reelId = data?.reelId;
    router.push(reelId != null
      ? { pathname: "/highlights", params: { reelId: String(reelId) } }
      : "/highlights"
    );
    return;
  }

  switch (type) {
    case "results_published":
    case "leaderboard_update":
      router.push(tournamentId
        ? { pathname: "/(tabs)/leaderboard", params: { tournamentId: String(tournamentId) } }
        : "/(tabs)/leaderboard"
      );
      break;
    case "tee_time_assigned":
    case "reminder_24h":
    case "reminder_1h":
    case "score_approved":
    case "score_rejected":
      router.push(tournamentId
        ? { pathname: "/(tabs)/score", params: { tournamentId: String(tournamentId) } }
        : "/(tabs)/score"
      );
      break;
    case "league_update":
    case "league_standings":
      router.push(leagueId
        ? { pathname: "/(tabs)/leaderboard", params: { leagueId: String(leagueId) } }
        : "/(tabs)/leaderboard"
      );
      break;
    case "shop_order":
    case "payment_confirmed":
    case "order_status_update":
      router.push("/(tabs)/club");
      break;
    // Task #2040 — daily "you closed the gap" coaching push. Deep-links
    // to the stats tab with the relevant club key so the proximity-by-club
    // card scrolls into view and the matching row is briefly highlighted.
    case "coaching_gap_closed": {
      const clubKey = typeof data?.clubKey === "string" ? (data.clubKey as string) : undefined;
      router.push(
        clubKey
          ? { pathname: "/(tabs)/stats", params: { focusClub: clubKey } }
          : "/(tabs)/stats"
      );
      return;
    }

    case "announcement":
    case "broadcast":
    case "invitation_received":
    default:
      router.push("/(tabs)/index");
      break;
  }
}
