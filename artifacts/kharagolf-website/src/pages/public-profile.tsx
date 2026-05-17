/**
 * Task #383 — Public player profile page at kharagolf.com/p/<handle>
 * Renders an opt-in profile (handicap journey, recent rounds, achievements,
 * favourite courses) plus SEO meta + schema.org Person/SportsEvent JSON-LD,
 * and deep-link CTAs into the apps.
 */
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import {
  Loader2, Trophy, MapPin, Calendar, ArrowRight, ExternalLink,
  Award, TrendingUp, Smartphone, Globe as GlobeIcon,
  Share2, Copy, Check, QrCode, Users, X, UserPlus, UserCheck, Lock,
} from "lucide-react";
import QRCode from "qrcode";

interface ProfileResponse {
  handle: string;
  displayName: string;
  profileImage: string | null;
  bio: string | null;
  location: string | null;
  homeClub: { name: string; slug: string } | null;
  memberSince: string;
  privacy: {
    showHandicap: boolean;
    showRecentRounds: boolean;
    showAchievements: boolean;
    showFavoriteCourses: boolean;
  };
  currentHandicap: number | null;
  handicapJourney: Array<{ recordedAt: string; handicapIndex: number }>;
  recentRounds: Array<{
    shareToken: string;
    tournamentName: string;
    courseName: string | null;
    startDate: string | null;
    gross: number;
    toPar: number | null;
  }>;
  achievements: Array<{
    badgeType: string;
    badgeLabel: string;
    badgeIcon: string;
    badgeCategory: string;
    badgeDescription?: string | null;
    earnedAt: string;
    metadata?: Record<string, unknown> | null;
  }>;
  badgeCatalog?: Array<{
    type: string;
    label: string;
    icon: string;
    category: string;
    description: string;
  }>;
  badgeProgress?: Record<string, { current: number; target: number }>;
  favoriteCourses: Array<{ courseId: number; name: string; rounds: number }>;
  // Task #1738 — social-graph counts shown on the profile hero so visitors
  // can see how popular this player is at a glance. Always present;
  // backwards-compatible with older API builds via `?? 0` at the read site.
  followerCount?: number;
  followingCount?: number;
  deepLinks: { web: string; mobile: string };
}

function setMeta(name: string, content: string, attr: "name" | "property" = "name") {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLinkRel(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function setJsonLd(id: string, data: unknown) {
  let el = document.head.querySelector<HTMLScriptElement>(`script[data-jsonld="${id}"]`);
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.setAttribute("data-jsonld", id);
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

function fmtToPar(toPar: number | null): string {
  if (toPar === null) return "";
  if (toPar === 0) return "E";
  return toPar > 0 ? `+${toPar}` : String(toPar);
}

export default function PublicProfilePage() {
  const [, params] = useRoute<{ handle: string }>("/p/:handle");
  const handle = params?.handle?.toLowerCase();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<"not-found" | "error" | null>(null);
  const [loading, setLoading] = useState(true);
  // Task #1095 — when the signed-in viewer is the owner of this public
  // profile, show per-badge share counts under each unlocked badge as
  // social-proof. Map keyed by badgeType → total share count.
  const [ownerBadgeShareCounts, setOwnerBadgeShareCounts] = useState<Record<string, number> | null>(null);
  // Task #2152 — modal state for the new clickable follower / following
  // stats. `null` = closed, "followers" / "following" = which list is open.
  const [followsModal, setFollowsModal] = useState<"followers" | "following" | null>(null);
  // Viewer's signed-in identity (best-effort) — used to (a) show a
  // Follow/Following button next to each row in the modal, and (b) hide
  // the button on rows pointing at the viewer themselves. `undefined`
  // = still loading, `null` = not signed in.
  const [viewer, setViewer] = useState<{ id: number } | null | undefined>(undefined);
  // IDs the viewer follows so each row in the modal hydrates with the
  // correct "Following" / "Follow" state without flashing.
  const [viewerFolloweeIds, setViewerFolloweeIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    fetch(`/api/public/p/${encodeURIComponent(handle)}`)
      .then(async r => {
        if (r.status === 404) { setError("not-found"); return null; }
        if (!r.ok) { setError("error"); return null; }
        return r.json();
      })
      .then((j: ProfileResponse | null) => { if (j) setData(j); })
      .catch(() => setError("error"))
      .finally(() => setLoading(false));
  }, [handle]);

  // Task #1095 — Best-effort owner detection: fetch the caller's portal
  // identity and, if their publicHandle matches the profile being viewed,
  // load per-badge share stats. Silently noop for logged-out visitors or
  // visitors viewing someone else's profile.
  // Task #2152 — also stash the viewer's id + the set of users they
  // follow so the new follower / following modal can render a
  // Follow / Following button next to each row.
  useEffect(() => {
    if (!handle) return;
    // Reset on handle change so navigating from your own profile to
    // someone else's never leaks the previous owner's share counts.
    setOwnerBadgeShareCounts(null);
    setViewer(undefined);
    setViewerFolloweeIds(new Set());
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch("/api/portal/me", { credentials: "include" });
        if (!meRes.ok) {
          if (!cancelled) setViewer(null);
          return;
        }
        const me = await meRes.json();
        if (cancelled) return;
        const meId = typeof me?.id === "number" ? me.id : null;
        setViewer(meId !== null ? { id: meId } : null);
        // Pre-load the viewer's followee ids in the background so the
        // FollowButton on each row hydrates without flashing "Follow"
        // first when the modal opens. Uses the existing back-compat
        // /portal/follows endpoint (returns { followeeIds: number[] }).
        if (meId !== null) {
          fetch("/api/portal/follows", { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then((j: { followeeIds: number[] } | null) => {
              if (cancelled || !j) return;
              setViewerFolloweeIds(new Set(j.followeeIds ?? []));
            })
            .catch(() => { /* non-essential */ });
        }
        if (typeof me?.publicHandle !== "string" || me.publicHandle.toLowerCase() !== handle) return;
        const statsRes = await fetch("/api/portal/me/badge-share-stats", { credentials: "include" });
        if (!statsRes.ok) return;
        const stats = await statsRes.json();
        if (cancelled) return;
        const map: Record<string, number> = {};
        for (const b of stats?.badges ?? []) {
          if (b && typeof b.badgeType === "string" && typeof b.total === "number") {
            map[b.badgeType] = b.total;
          }
        }
        setOwnerBadgeShareCounts(map);
      } catch {
        if (!cancelled) setViewer(null);
        /* ignore — owner indicator is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  useEffect(() => {
    if (!data) return;
    const url = `${window.location.origin}/p/${data.handle}`;
    const title = `${data.displayName} — KHARAGOLF`;
    const desc = data.bio?.trim() || `${data.displayName}'s public golf profile — recent rounds, handicap journey & achievements on KHARAGOLF.`;
    const img = data.profileImage || `${window.location.origin}/favicon.svg`;

    document.title = title;
    setMeta("description", desc);
    setMeta("og:type", "profile", "property");
    setMeta("og:title", title, "property");
    setMeta("og:description", desc, "property");
    setMeta("og:url", url, "property");
    setMeta("og:image", img, "property");
    setMeta("profile:username", data.handle, "property");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", title);
    setMeta("twitter:description", desc);
    setMeta("twitter:image", img);
    setLinkRel("canonical", url);

    setJsonLd("person", {
      "@context": "https://schema.org",
      "@type": "Person",
      name: data.displayName,
      url,
      image: img,
      identifier: data.handle,
      description: desc,
      memberOf: data.homeClub ? { "@type": "Organization", name: data.homeClub.name } : undefined,
      address: data.location ? { "@type": "PostalAddress", addressLocality: data.location } : undefined,
    });

    if (data.recentRounds.length) {
      setJsonLd("rounds", data.recentRounds.slice(0, 5).map(r => ({
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        name: r.tournamentName,
        sport: "Golf",
        startDate: r.startDate ?? undefined,
        location: r.courseName ? { "@type": "Place", name: r.courseName } : undefined,
        competitor: { "@type": "Person", name: data.displayName },
        url: `${window.location.origin}/scorecard/${r.shareToken}`,
      })));
    }
  }, [data]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (error === "not-found" || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">Profile not found</h1>
        <p className="text-muted-foreground mb-6">This player either hasn't published a public profile, or the handle is incorrect.</p>
        <Link href="/" className="text-emerald-600 underline">Return home</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-gray-900">
      {/* Top bar */}
      <header className="px-6 py-4 border-b bg-white flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight">KHARAGOLF</Link>
        <div className="text-xs text-muted-foreground">Public player profile</div>
      </header>

      {/* Hero */}
      <section className="bg-gradient-to-br from-emerald-800 to-emerald-950 text-white px-6 py-12">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-start gap-6">
          {data.profileImage ? (
            <img
              src={data.profileImage}
              alt={data.displayName}
              className="w-24 h-24 rounded-full object-cover border-4 border-white/20"
              data-testid="profile-avatar"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-emerald-700 flex items-center justify-center text-3xl font-bold border-4 border-white/20">
              {data.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1">
            <h1 className="text-3xl md:text-4xl font-bold" data-testid="profile-name">{data.displayName}</h1>
            <div className="text-emerald-200 text-sm mt-1">@{data.handle}</div>
            {data.bio && <p className="mt-3 max-w-2xl text-emerald-50/90">{data.bio}</p>}
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-emerald-100/90">
              {data.location && <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" />{data.location}</span>}
              {data.homeClub && (
                <Link href={`/clubs/${data.homeClub.slug}`} className="inline-flex items-center gap-1.5 hover:underline">
                  <Trophy className="w-4 h-4" />{data.homeClub.name}
                </Link>
              )}
              <span className="inline-flex items-center gap-1.5"><Calendar className="w-4 h-4" />Member since {new Date(data.memberSince).getFullYear()}</span>
            </div>
            {/* Task #1738 — followers / following counts so visitors can see
                how popular this player is at a glance.
                Task #2152 — counts are now clickable buttons that open a
                paginated list modal of the actual users. Privacy controls
                are honoured server-side: members who haven't opened a
                public profile appear as redacted "Private member" rows. */}
            <div className="mt-4 flex items-center gap-5 text-sm">
              <button
                type="button"
                onClick={() => setFollowsModal("followers")}
                className="inline-flex items-baseline gap-1.5 rounded-md px-1 -mx-1 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 transition"
                data-testid="profile-followers"
                aria-label={`View followers (${(data.followerCount ?? 0).toLocaleString()})`}
              >
                <Users className="w-4 h-4 text-emerald-200 self-center" />
                <span className="text-lg font-semibold text-white">{(data.followerCount ?? 0).toLocaleString()}</span>
                <span className="text-emerald-100/90">{(data.followerCount ?? 0) === 1 ? "follower" : "followers"}</span>
              </button>
              <button
                type="button"
                onClick={() => setFollowsModal("following")}
                className="inline-flex items-baseline gap-1.5 rounded-md px-1 -mx-1 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 transition"
                data-testid="profile-following"
                aria-label={`View who ${data.displayName} follows (${(data.followingCount ?? 0).toLocaleString()})`}
              >
                <span className="text-lg font-semibold text-white">{(data.followingCount ?? 0).toLocaleString()}</span>
                <span className="text-emerald-100/90">following</span>
              </button>
            </div>
          </div>

          {data.privacy.showHandicap && data.currentHandicap !== null && (
            <div className="bg-white/10 rounded-lg px-5 py-3 backdrop-blur-sm">
              <div className="text-xs uppercase tracking-wide text-emerald-200">Handicap Index</div>
              <div className="text-3xl font-bold" data-testid="profile-handicap">{data.currentHandicap.toFixed(1)}</div>
            </div>
          )}
        </div>
      </section>

      {/* Share */}
      <ShareProfileSection handle={data.handle} displayName={data.displayName} />

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        {/* Handicap journey */}
        {data.privacy.showHandicap && data.handicapJourney.length > 0 && (
          <section data-testid="section-handicap">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><TrendingUp className="w-5 h-5 text-emerald-600" />Handicap journey</h2>
            <div className="bg-white rounded-lg border p-5">
              <HandicapSparkline points={data.handicapJourney} />
              <div className="text-xs text-muted-foreground mt-3">
                {data.handicapJourney.length} record{data.handicapJourney.length === 1 ? "" : "s"} ·
                {" "}from {data.handicapJourney[0]!.handicapIndex.toFixed(1)} to {data.handicapJourney[data.handicapJourney.length - 1]!.handicapIndex.toFixed(1)}
              </div>
            </div>
          </section>
        )}

        {/* Recent rounds */}
        {data.privacy.showRecentRounds && data.recentRounds.length > 0 && (
          <section data-testid="section-rounds">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><Calendar className="w-5 h-5 text-emerald-600" />Recent rounds</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {data.recentRounds.map(r => (
                <a
                  key={r.shareToken}
                  href={`/scorecard/${r.shareToken}`}
                  className="block bg-white rounded-lg border p-4 hover:shadow-md transition"
                  data-testid={`round-${r.shareToken}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.tournamentName}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {r.courseName ?? "Course"} ·{" "}
                        {r.startDate ? new Date(r.startDate).toLocaleDateString() : "—"}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-bold leading-none">{r.gross}</div>
                      {r.toPar !== null && <div className={`text-xs font-medium ${r.toPar < 0 ? "text-emerald-600" : r.toPar > 0 ? "text-amber-600" : "text-gray-500"}`}>{fmtToPar(r.toPar)}</div>}
                    </div>
                  </div>
                  <div className="mt-3 inline-flex items-center gap-1 text-xs text-emerald-700">View scorecard <ArrowRight className="w-3 h-3" /></div>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Achievements / Badges catalog */}
        {data.privacy.showAchievements && (data.badgeCatalog?.length ?? 0) > 0 && (
          <BadgesCatalogSection
            catalog={data.badgeCatalog!}
            earned={data.achievements}
            progress={data.badgeProgress ?? {}}
            handle={data.handle}
            displayName={data.displayName}
            ownerBadgeShareCounts={ownerBadgeShareCounts}
          />
        )}

        {/* Favorite courses */}
        {data.privacy.showFavoriteCourses && data.favoriteCourses.length > 0 && (
          <section data-testid="section-favorites">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><Trophy className="w-5 h-5 text-emerald-600" />Favourite courses</h2>
            <ul className="bg-white rounded-lg border divide-y">
              {data.favoriteCourses.map(c => (
                <li key={c.courseId} className="px-4 py-3 flex items-center justify-between">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-sm text-muted-foreground">{c.rounds} round{c.rounds === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Empty state */}
        {!data.privacy.showHandicap && !data.privacy.showRecentRounds && !data.privacy.showAchievements && !data.privacy.showFavoriteCourses && (
          <div className="text-center py-12 text-muted-foreground">
            <p>This player has chosen not to share any public stats yet.</p>
          </div>
        )}

        {/* Deep links */}
        <section className="bg-white border rounded-lg p-6 mt-12">
          <h3 className="font-semibold mb-3">Open in KHARAGOLF</h3>
          <div className="flex flex-wrap gap-3">
            <a href={data.deepLinks.mobile} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm" data-testid="cta-mobile">
              <Smartphone className="w-4 h-4" />Open in app
            </a>
            <a href={data.deepLinks.web} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm" data-testid="cta-web">
              <GlobeIcon className="w-4 h-4" />Open on web<ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </section>
      </main>

      {/* Task #2152 — paginated followers / following modal. */}
      {followsModal && (
        <FollowsListModal
          handle={data.handle}
          ownerDisplayName={data.displayName}
          mode={followsModal}
          viewerId={viewer && viewer.id ? viewer.id : null}
          initiallyFollowedIds={viewerFolloweeIds}
          onClose={() => setFollowsModal(null)}
          onFollowChange={(targetId, isFollowing) => {
            setViewerFolloweeIds(prev => {
              const next = new Set(prev);
              if (isFollowing) next.add(targetId); else next.delete(targetId);
              return next;
            });
          }}
        />
      )}

      <footer className="px-6 py-8 border-t text-center text-xs text-muted-foreground bg-white">
        © {new Date().getFullYear()} KHARAGOLF. Profiles are user opt-in and respect per-section privacy controls.
      </footer>
    </div>
  );
}

type CatalogBadge = { type: string; label: string; icon: string; category: string; description: string };
type EarnedBadge = { badgeType: string; earnedAt: string };

const CATEGORY_LABELS: Record<string, string> = {
  milestone: "Milestones",
  scoring: "Scoring",
  consistency: "Consistency",
  social: "Social",
  seasonal: "Seasonal",
};

// Task #926 — fire a single share-tracking event so admins can see which
// badges drive the most viral traffic. Best-effort: never blocks the share
// flow if the analytics POST fails (network, ad-blocker, etc.).
function trackBadgeShare(handle: string, badgeType: string, method: "copy" | "web_share" | "native_share") {
  try {
    void fetch(`/api/public/p/${encodeURIComponent(handle)}/badge/${encodeURIComponent(badgeType)}/share-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, source: "web" }),
      keepalive: true,
    }).catch(() => { /* ignore — analytics only */ });
  } catch { /* ignore */ }
}

async function shareBadge(handle: string, badge: CatalogBadge, displayName: string): Promise<"shared" | "copied" | "failed"> {
  const url = `${window.location.origin}/p/${handle}/badge/${encodeURIComponent(badge.type)}`;
  const text = `I just unlocked the “${badge.label}” ${badge.icon} badge on KHARAGOLF!`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  if (canShare) {
    try {
      await navigator.share({ title: `${displayName} — ${badge.label}`, text, url });
      trackBadgeShare(handle, badge.type, "native_share");
      return "shared";
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return "failed";
      // fall through to copy
    }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    trackBadgeShare(handle, badge.type, "copy");
    return "copied";
  } catch {
    return "failed";
  }
}

function BadgeShareButton({ handle, badge, displayName }: { handle: string; badge: CatalogBadge; displayName: string }) {
  const [state, setState] = useState<"idle" | "shared" | "copied" | "failed">("idle");
  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const r = await shareBadge(handle, badge, displayName);
    setState(r);
    window.setTimeout(() => setState("idle"), 2000);
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`badge-share-${badge.type}`}
      className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800"
      aria-label={`Share ${badge.label} badge`}
    >
      {state === "copied" ? <><Check className="w-3 h-3" />Link copied</> :
       state === "shared" ? <><Check className="w-3 h-3" />Shared</> :
       state === "failed" ? <>Try again</> :
       <><Share2 className="w-3 h-3" />Share</>}
    </button>
  );
}

function BadgesCatalogSection({ catalog, earned, progress, handle, displayName, ownerBadgeShareCounts }: {
  catalog: CatalogBadge[];
  earned: EarnedBadge[];
  progress: Record<string, { current: number; target: number }>;
  handle: string;
  displayName: string;
  // Task #1095 — present only when the signed-in viewer owns this profile.
  ownerBadgeShareCounts: Record<string, number> | null;
}) {
  const earnedMap = new Map<string, string>();
  for (const e of earned) {
    if (!earnedMap.has(e.badgeType)) earnedMap.set(e.badgeType, e.earnedAt);
  }
  const unlockedCount = catalog.filter(b => earnedMap.has(b.type)).length;

  // Group by category in catalog declaration order
  const grouped = new Map<string, CatalogBadge[]>();
  for (const b of catalog) {
    if (!grouped.has(b.category)) grouped.set(b.category, []);
    grouped.get(b.category)!.push(b);
  }

  return (
    <section data-testid="section-achievements">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Award className="w-5 h-5 text-emerald-600" />Badges
        </h2>
        <div className="text-sm text-muted-foreground" data-testid="badges-progress">
          {unlockedCount} of {catalog.length} unlocked
        </div>
      </div>
      <div className="space-y-6">
        {[...grouped.entries()].map(([category, badges]) => (
          <div key={category}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {CATEGORY_LABELS[category] ?? category}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {badges.map(b => {
                const earnedAt = earnedMap.get(b.type) ?? null;
                const isUnlocked = earnedAt !== null;
                const tooltip = isUnlocked
                  ? `${b.description} · Earned ${new Date(earnedAt!).toLocaleDateString()}`
                  : `${b.description} (locked)`;
                return (
                  <div
                    key={b.type}
                    title={tooltip}
                    data-testid={`badge-${b.type}`}
                    data-unlocked={isUnlocked ? "true" : "false"}
                    className={
                      "flex items-start gap-2 rounded-lg border p-3 text-sm transition " +
                      (isUnlocked
                        ? "bg-white border-emerald-200"
                        : "bg-stone-100 border-stone-200 opacity-70")
                    }
                  >
                    <span
                      aria-hidden
                      className={"text-xl leading-none shrink-0 " + (isUnlocked ? "" : "grayscale")}
                    >
                      {b.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={"font-medium truncate " + (isUnlocked ? "text-gray-900" : "text-gray-500")}>
                        {b.label}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {b.description}
                      </div>
                      {isUnlocked && (
                        <>
                          <div className="text-[11px] text-emerald-700 mt-1">
                            Earned {new Date(earnedAt!).toLocaleDateString()}
                          </div>
                          {/* Task #1095 — owner-only per-badge share count */}
                          {ownerBadgeShareCounts && (() => {
                            const n = ownerBadgeShareCounts[b.type] ?? 0;
                            return (
                              <div
                                className="text-[11px] text-muted-foreground mt-1"
                                data-testid={`badge-share-count-${b.type}`}
                                title="How many times you've shared this badge"
                              >
                                Shared {n} {n === 1 ? "time" : "times"}
                              </div>
                            );
                          })()}
                          <BadgeShareButton handle={handle} badge={b} displayName={displayName} />
                        </>
                      )}
                      {!isUnlocked && progress[b.type] && (() => {
                        const p = progress[b.type]!;
                        const pct = p.target > 0
                          ? Math.max(0, Math.min(100, Math.round((p.current / p.target) * 100)))
                          : 0;
                        const shown = Math.min(p.current, p.target);
                        return (
                          <div className="mt-1.5" data-testid={`badge-progress-${b.type}`}>
                            <div className="text-[11px] text-gray-600">
                              {shown} of {p.target}
                            </div>
                            <div
                              className="mt-1 h-1.5 rounded-full bg-stone-200 overflow-hidden"
                              role="progressbar"
                              aria-valuemin={0}
                              aria-valuemax={p.target}
                              aria-valuenow={shown}
                              aria-label={`${b.label} progress: ${shown} of ${p.target}`}
                            >
                              <div
                                className="h-full bg-emerald-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Task #929 — Only display the social-proof badge once a profile has been
// shared at least this many times. Keeps brand-new / unshared profiles from
// showing a sad "Shared 0 times" indicator.
const SHARE_COUNT_MIN_DISPLAY = 3;

function formatShareCount(n: number): string {
  if (n === 1) return "Shared once";
  return `Shared ${n.toLocaleString()} times`;
}

// Task #1083 — fire a single share-tracking event so visitor-driven shares
// from the public profile page itself feed into the social-proof counter.
// Best-effort: never blocks the share flow if the analytics POST fails
// (network, ad-blocker, rate limit, etc.).
function trackProfileShare(handle: string, method: "copy" | "web_share" | "native_share" | "qr_open") {
  try {
    void fetch(`/api/public/p/${encodeURIComponent(handle)}/share-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, source: "web" }),
      keepalive: true,
    }).catch(() => { /* ignore — analytics only */ });
  } catch { /* ignore */ }
}

function ShareProfileSection({ handle, displayName }: { handle: string; displayName: string }) {
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [shareCount, setShareCount] = useState<number | null>(null);
  const refetchTimerRef = useRef<number | null>(null);
  const profileUrl = typeof window !== "undefined"
    ? `${window.location.origin}/p/${handle}`
    : `/p/${handle}`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // Task #1082 — keep the social-proof badge in sync with reality. The count
  // is fetched on mount and re-fetched after every successful share that
  // originates from this same page (copy / native share / QR open). A small
  // optimistic bump is applied immediately so the badge updates instantly
  // even before the server-side counter lands.
  const refetchShareCount = useCallback(() => {
    if (!handle) return;
    fetch(`/api/public/p/${encodeURIComponent(handle)}/share-stats`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { total: number } | null) => {
        if (j && typeof j.total === "number") setShareCount(j.total);
      })
      .catch(() => { /* social proof is non-essential — fail silently */ });
  }, [handle]);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;
    fetch(`/api/public/p/${encodeURIComponent(handle)}/share-stats`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { total: number } | null) => {
        if (!cancelled && j && typeof j.total === "number") setShareCount(j.total);
      })
      .catch(() => { /* social proof is non-essential — fail silently */ });
    return () => { cancelled = true; };
  }, [handle]);

  useEffect(() => () => {
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
  }, []);

  function bumpShareCountOptimistic() {
    setShareCount(prev => (prev === null ? prev : prev + 1));
    // Re-sync with the server shortly after so any concurrent share-event
    // writes (e.g. from the authenticated portal) are reflected too. The
    // timer is tracked so it can be cleared on unmount.
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      refetchShareCount();
    }, 800);
  }

  useEffect(() => {
    if (!showQr || qrDataUrl) return;
    QRCode.toDataURL(profileUrl, { margin: 1, width: 220, color: { dark: "#064e3b", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch(() => setShareError("Could not generate QR code."));
  }, [showQr, qrDataUrl, profileUrl]);

  async function copy() {
    setShareError(null);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(profileUrl);
      } else {
        const ta = document.createElement("textarea");
        ta.value = profileUrl;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      trackProfileShare(handle, "copy");
      bumpShareCountOptimistic();
    } catch {
      setShareError("Could not copy link.");
    }
  }

  async function nativeShare() {
    setShareError(null);
    try {
      await navigator.share({
        title: `${displayName} (@${handle}) on KHARAGOLF`,
        text: `Check out ${displayName}'s golf profile on KHARAGOLF.`,
        url: profileUrl,
      });
      trackProfileShare(handle, "native_share");
      bumpShareCountOptimistic();
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        setShareError("Share was cancelled or failed.");
      }
    }
  }

  function toggleQr() {
    setShowQr(prev => {
      const next = !prev;
      // Treat opening the QR panel as a share intent — re-sync the badge
      // and log the analytics event so visitor-driven QR opens count.
      if (next) {
        trackProfileShare(handle, "qr_open");
        bumpShareCountOptimistic();
      }
      return next;
    });
  }

  return (
    <section className="bg-white border-b" data-testid="share-profile-section">
      <div className="max-w-4xl mx-auto px-6 py-4 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
          <Share2 className="w-4 h-4 text-emerald-600" />
          <span>Share this profile with friends and fans.</span>
          {shareCount !== null && shareCount >= SHARE_COUNT_MIN_DISPLAY && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-0.5 text-xs font-medium"
              data-testid="share-count-badge"
              title="How many times this profile has been shared"
            >
              <TrendingUp className="w-3 h-3" />
              {formatShareCount(shareCount)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-900 text-white text-sm hover:opacity-90"
            data-testid="share-copy"
          >
            {copied ? <><Check className="w-3.5 h-3.5" />Copied!</> : <><Copy className="w-3.5 h-3.5" />Copy link</>}
          </button>
          {canShare && (
            <button
              type="button"
              onClick={nativeShare}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-600 text-emerald-700 text-sm hover:bg-emerald-50"
              data-testid="share-native"
            >
              <Share2 className="w-3.5 h-3.5" />Share…
            </button>
          )}
          <button
            type="button"
            onClick={toggleQr}
            aria-expanded={showQr}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm hover:bg-gray-50"
            data-testid="share-qr-toggle"
          >
            <QrCode className="w-3.5 h-3.5" />{showQr ? "Hide QR" : "QR code"}
          </button>
        </div>
      </div>
      {showQr && (
        <div className="max-w-4xl mx-auto px-6 pb-5 -mt-1 flex flex-col items-center sm:items-start gap-2" data-testid="share-qr-panel">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code for ${profileUrl}`} className="w-40 h-40 border rounded-md" data-testid="share-qr-image" />
          ) : (
            <div className="w-40 h-40 border rounded-md flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
          <div className="text-xs text-muted-foreground break-all">{profileUrl}</div>
        </div>
      )}
      {shareError && (
        <div className="max-w-4xl mx-auto px-6 pb-3 text-xs text-red-700" data-testid="share-error">{shareError}</div>
      )}
    </section>
  );
}

function HandicapSparkline({ points }: { points: Array<{ recordedAt: string; handicapIndex: number }> }) {
  if (points.length < 2) {
    return <div className="text-sm text-muted-foreground">Not enough history yet to chart.</div>;
  }
  const W = 600, H = 80, pad = 8;
  const xs = points.map((_, i) => pad + (i * (W - pad * 2)) / (points.length - 1));
  const vals = points.map(p => p.handicapIndex);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = Math.max(0.5, max - min);
  const ys = vals.map(v => H - pad - ((v - min) / range) * (H - pad * 2));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${ys[i]!.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" role="img" aria-label="Handicap trend">
      <path d={path} fill="none" stroke="#059669" strokeWidth={2} />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r={2.5} fill="#059669" />
      ))}
    </svg>
  );
}

// Task #2152 — Modal that lists who follows / is followed-by the
// public profile owner. Loads a single page at a time from the new
// public endpoints and offers a "Load more" button to advance until
// `total` is reached. When the viewer is signed in, each non-private
// row shows an inline Follow/Following toggle that calls the
// authenticated /api/portal/follows mutation endpoints.
interface FollowsListRow {
  userId: number;
  displayName: string | null;
  profileImage: string | null;
  publicHandle: string | null;
  isPrivate: boolean;
  followedAt: string;
}

const FOLLOWS_PAGE_SIZE = 50;

function FollowsListModal({
  handle,
  ownerDisplayName,
  mode,
  viewerId,
  initiallyFollowedIds,
  onClose,
  onFollowChange,
}: {
  handle: string;
  ownerDisplayName: string;
  mode: "followers" | "following";
  viewerId: number | null;
  initiallyFollowedIds: Set<number>;
  onClose: () => void;
  onFollowChange: (targetId: number, isFollowing: boolean) => void;
}) {
  const [rows, setRows] = useState<FollowsListRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const title = mode === "followers"
    ? `People who follow ${ownerDisplayName}`
    : `People ${ownerDisplayName} follows`;

  const loadPage = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/public/p/${encodeURIComponent(handle)}/${mode}?limit=${FOLLOWS_PAGE_SIZE}&offset=${nextOffset}`;
      const r = await fetch(url);
      if (r.status === 429) {
        setError("Too many requests — please wait a moment and try again.");
        return;
      }
      if (!r.ok) {
        setError("Could not load the list right now.");
        return;
      }
      const j = await r.json() as { items: FollowsListRow[]; total: number; limit: number; offset: number };
      setRows(prev => nextOffset === 0 ? j.items : [...prev, ...j.items]);
      setTotal(j.total);
      setOffset(nextOffset + j.items.length);
    } catch {
      setError("Could not load the list right now.");
    } finally {
      setLoading(false);
    }
  }, [handle, mode]);

  useEffect(() => {
    setRows([]);
    setTotal(null);
    setOffset(0);
    loadPage(0);
  }, [loadPage]);

  // Close on escape for keyboard users.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasMore = total !== null && offset < total;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={`follows-modal-${mode}`}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:max-w-md max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h2 className="font-semibold text-gray-900 text-base">{title}</h2>
            {total !== null && (
              <p className="text-xs text-muted-foreground">
                {total.toLocaleString()} {total === 1 ? "person" : "people"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"
            aria-label="Close"
            data-testid="follows-modal-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {rows.length === 0 && !loading && !error && (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {mode === "followers"
                ? `${ownerDisplayName} doesn't have any followers yet.`
                : `${ownerDisplayName} isn't following anyone yet.`}
            </div>
          )}
          {error && (
            <div className="px-6 py-6 text-center text-sm text-red-700" data-testid="follows-modal-error">
              {error}
            </div>
          )}
          <ul className="divide-y">
            {rows.map((row, idx) => (
              <FollowsListRowItem
                key={`${row.userId}-${idx}`}
                row={row}
                viewerId={viewerId}
                isFollowing={initiallyFollowedIds.has(row.userId)}
                onFollowChange={onFollowChange}
              />
            ))}
          </ul>
          {hasMore && (
            <div className="p-3 border-t flex justify-center">
              <button
                type="button"
                onClick={() => loadPage(offset)}
                disabled={loading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md border hover:bg-gray-50 disabled:opacity-50"
                data-testid="follows-modal-load-more"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Load more
              </button>
            </div>
          )}
          {loading && rows.length === 0 && (
            <div className="px-6 py-8 flex justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FollowsListRowItem({
  row,
  viewerId,
  isFollowing: initialFollowing,
  onFollowChange,
}: {
  row: FollowsListRow;
  viewerId: number | null;
  isFollowing: boolean;
  onFollowChange: (targetId: number, isFollowing: boolean) => void;
}) {
  if (row.isPrivate) {
    return (
      <li
        className="flex items-center gap-3 px-5 py-3"
        data-testid={`follows-row-private-${row.userId}`}
      >
        <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
          <Lock className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-700">Private member</div>
          <div className="text-xs text-muted-foreground">This member hasn't opened a public profile.</div>
        </div>
      </li>
    );
  }

  const isSelf = viewerId !== null && viewerId === row.userId;
  const initials = (row.displayName ?? row.publicHandle ?? "?")
    .split(/\s+/)
    .map(s => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <li
      className="flex items-center gap-3 px-5 py-3"
      data-testid={`follows-row-${row.userId}`}
    >
      <Link
        href={`/p/${row.publicHandle}`}
        className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-90"
      >
        {row.profileImage ? (
          <img
            src={row.profileImage}
            alt=""
            className="w-10 h-10 rounded-full object-cover bg-gray-100"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-sm font-semibold">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">
            {row.displayName}
          </div>
          {row.publicHandle && (
            <div className="text-xs text-muted-foreground truncate">@{row.publicHandle}</div>
          )}
        </div>
      </Link>
      {viewerId !== null && !isSelf && (
        <FollowToggleButton
          targetUserId={row.userId}
          initialFollowing={initialFollowing}
          onChange={(next) => onFollowChange(row.userId, next)}
        />
      )}
    </li>
  );
}

function FollowToggleButton({
  targetUserId,
  initialFollowing,
  onChange,
}: {
  targetUserId: number;
  initialFollowing: boolean;
  onChange: (isFollowing: boolean) => void;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  // Keep in sync if the parent's pre-loaded set updates after the row
  // has already mounted (e.g. /portal/follows lands while the modal is
  // already open).
  useEffect(() => {
    setFollowing(initialFollowing);
  }, [initialFollowing]);

  async function toggle(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !following;
    // Optimistic flip — revert if the request fails.
    setFollowing(next);
    try {
      const r = await fetch(`/api/portal/follows/${targetUserId}`, {
        method: next ? "POST" : "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        setFollowing(!next);
        return;
      }
      onChange(next);
    } catch {
      setFollowing(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className={
        following
          ? "inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border border-emerald-600 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-60"
          : "inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-full bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
      }
      data-testid={`follows-row-toggle-${targetUserId}`}
      aria-pressed={following}
    >
      {busy
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : following
          ? <UserCheck className="w-3 h-3" />
          : <UserPlus className="w-3 h-3" />}
      {following ? "Following" : "Follow"}
    </button>
  );
}
