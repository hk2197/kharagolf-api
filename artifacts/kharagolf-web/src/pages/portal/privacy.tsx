import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Loader2, Shield, ExternalLink, Eye, EyeOff, Globe, Save, Share2, Copy, Check, Link2, Unlink } from "lucide-react";

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const APPLE_SERVICES_ID = (import.meta.env.VITE_APPLE_SERVICES_ID as string | undefined) ?? "";
const APPLE_REDIRECT_URI = (import.meta.env.VITE_APPLE_REDIRECT_URI as string | undefined) ?? "";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            ux_mode?: "popup" | "redirect";
            auto_select?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
        }) => void;
        signIn: () => Promise<{
          authorization: { id_token: string; code: string; state?: string };
          user?: { name?: { firstName?: string; lastName?: string }; email?: string };
        }>;
      };
    };
  }
}

function loadScriptOnce(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.id = id; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

interface PublicProfileSettings {
  publicHandle: string | null;
  publicProfileEnabled: boolean;
  publicShowHandicap: boolean;
  publicShowRecentRounds: boolean;
  publicShowAchievements: boolean;
  publicShowFavoriteCourses: boolean;
  publicBio: string | null;
  publicLocation: string | null;
}

interface ShareStats {
  total: number;
  byMethod: Record<string, number>;
  // Task #1458 — web vs mobile reach split. Counts only events tagged
  // with a known source after source-tracking shipped, so the totals
  // here may sum to less than `total` for owners with legacy history.
  bySource?: { web: number; mobile: number };
}

interface SocialLink {
  provider: "apple" | "google";
  linkedAt: string;
  lastUsedAt: string;
  legacy?: boolean;
}

interface SocialLinksResponse {
  hasPassword: boolean;
  hasReplitOauth: boolean;
  links: SocialLink[];
}

interface ScorecardRow {
  playerId: number;
  shareToken: string;
  publicHidden: boolean;
  tournamentName: string;
  startDate: string | null;
}

const API = "/api";

async function authFetch(url: string, init?: RequestInit) {
  const token = typeof window !== "undefined" ? localStorage.getItem("portal_jwt") : null;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...init, headers });
}

export default function PortalPrivacyPage() {
  const [settings, setSettings] = useState<PublicProfileSettings | null>(null);
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([]);
  const [shareStats, setShareStats] = useState<ShareStats | null>(null);
  const [socialLinks, setSocialLinks] = useState<SocialLinksResponse | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [linking, setLinking] = useState<null | "google" | "apple">(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const googleLinkBtnRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function refreshShareStats() {
    try {
      const r = await authFetch(`${API}/portal/me/public-profile/share-stats`);
      if (r.ok) setShareStats(await r.json());
    } catch { /* swallow */ }
  }

  useEffect(() => {
    Promise.all([
      authFetch(`${API}/portal/me/public-profile`).then(r => r.ok ? r.json() : null),
      authFetch(`${API}/portal/me/public-scorecards`).then(r => r.ok ? r.json() : []),
      authFetch(`${API}/portal/me/public-profile/share-stats`).then(r => r.ok ? r.json() : null),
      authFetch(`${API}/portal/me/social-links`).then(r => r.ok ? r.json() : null),
    ])
      .then(([s, sc, st, sl]) => { setSettings(s); setScorecards(sc ?? []); setShareStats(st); setSocialLinks(sl); })
      .catch(() => setError("Failed to load privacy settings"))
      .finally(() => setLoading(false));
  }, []);

  async function unlinkProvider(provider: "apple" | "google") {
    setLinkError(null);
    setUnlinking(provider);
    try {
      const res = await authFetch(`${API}/portal/me/social-links/${provider}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 409 && j.error === "last_login_method") {
          setLinkError(j.detail ?? "Set a password before removing your last sign-in method.");
        } else {
          setLinkError(j.error ?? "Failed to unlink provider.");
        }
        return;
      }
      const refreshed = await authFetch(`${API}/portal/me/social-links`).then(r => r.ok ? r.json() : null);
      setSocialLinks(refreshed);
    } finally {
      setUnlinking(null);
    }
  }

  // POST the freshly-issued provider token at /api/portal/me/social-links/:provider
  // to attach it to the *current* session's user (never to whoever the
  // token's email maps to). Mirrors the verifier reuse pattern in
  // routes/wave3.ts.
  //
  // Task #1735: map the API's stable `error` codes to actionable copy so
  // players understand WHY the link failed (expired token vs. unverified
  // email vs. server misconfig) instead of seeing a generic "Could not
  // link". Codes are documented in routes/wave3.ts.
  function linkErrorMessageFor(provider: "apple" | "google", code: string | undefined, detail: string | undefined): string {
    const label = provider === "apple" ? "Apple" : "Google";
    switch (code) {
      case "provider_already_linked":
        return detail ?? `This ${provider === "apple" ? "Apple ID" : "Google account"} is already linked to a different KHARAGOLF account.`;
      case "token_required":
        return detail ?? (provider === "apple"
          ? "Apple didn't return a sign-in token. Try again and choose \"Share My Email\" when prompted."
          : "Google didn't return a sign-in token. Please try linking again.");
      case "token_invalid":
        return detail ?? `We couldn't verify your ${label} sign-in. The token may have expired — please try again.`;
      case "email_not_verified":
        return detail ?? `Your ${label} email isn't verified yet. Verify it with ${label}, then try linking again.`;
      case "provider_not_configured":
        return detail ?? `${label} sign-in isn't set up on this server. Please contact KHARAGOLF support.`;
      default:
        return detail ?? `Could not link ${label}. Please try again.`;
    }
  }

  async function postLink(provider: "apple" | "google", body: Record<string, unknown>) {
    setLinkError(null);
    setLinking(provider);
    try {
      const res = await authFetch(`${API}/portal/me/social-links/${provider}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string; detail?: string }));
        setLinkError(linkErrorMessageFor(provider, j.error, j.detail));
        return;
      }
      const refreshed = await authFetch(`${API}/portal/me/social-links`).then(r => r.ok ? r.json() : null);
      setSocialLinks(refreshed);
    } catch {
      setLinkError(`We couldn't reach KHARAGOLF to link ${provider === "apple" ? "Apple" : "Google"}. Check your connection and try again.`);
    } finally {
      setLinking(null);
    }
  }

  async function handleAppleLink() {
    if (!window.AppleID) return;
    setLinkError(null);
    try {
      const data = await window.AppleID.auth.signIn();
      const fullName = data.user?.name
        ? { givenName: data.user.name.firstName, familyName: data.user.name.lastName }
        : undefined;
      await postLink("apple", {
        identityToken: data.authorization.id_token,
        fullName,
      });
    } catch (err) {
      // Task #1735: previously this branch swallowed Apple's SDK rejection
      // silently — the player clicked "Link Apple", a popup opened and
      // closed, and nothing on the page changed. Now we surface what
      // happened. Apple's JS SDK rejects with
      //   { error: "popup_closed_by_user" }
      //   { error: "user_cancelled_authorize" }
      //   { error: "popup_blocked_by_browser" }
      // and other internal codes; we map the user-visible ones and fall
      // through with a generic "didn't complete" message for the rest so
      // players always get feedback.
      const code = (err as { error?: string } | null | undefined)?.error;
      if (code === "popup_closed_by_user" || code === "user_cancelled_authorize") {
        setLinkError("Apple sign-in was cancelled. Try again when you're ready.");
      } else if (code === "popup_blocked_by_browser") {
        setLinkError("Your browser blocked the Apple sign-in popup. Allow popups for this site and try again.");
      } else {
        setLinkError(
          code
            ? `Apple sign-in didn't complete (${code}). Please try again.`
            : "Apple sign-in didn't complete. Please try again.",
        );
      }
    }
  }

  // Render the Google "Link" button only once we know Google isn't already
  // linked (the GIS SDK doesn't expose a clean "deinit", so we don't want
  // to render it just to immediately hide it after the linked-accounts
  // fetch returns).
  const googleLinked = socialLinks?.links.some(l => l.provider === "google") ?? false;
  const appleLinked = socialLinks?.links.some(l => l.provider === "apple") ?? false;

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    if (!socialLinks) return;
    if (googleLinked) return;
    let cancelled = false;
    loadScriptOnce("https://accounts.google.com/gsi/client", "google-gsi-script")
      .then(() => {
        if (cancelled || !window.google || !googleLinkBtnRef.current) return;
        // Re-initialize with the *link* callback. Calling initialize again
        // is documented as supported by GIS and just replaces the previous
        // callback; it lets the same SDK script power both the login and
        // privacy screens.
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            // Task #1735: previously we silently dropped any callback that
            // arrived without a credential. GIS's renderButton flow doesn't
            // fire the callback on user-cancelled popups (the SDK has no
            // notification channel for that on the standard button), but if
            // we ever do receive an empty credential — e.g. the SDK changes
            // behavior, or a future opt-in surfaces a no-credential
            // notification — we now tell the player something went wrong
            // instead of leaving them staring at an unchanged screen.
            if (response.credential) {
              setLinkError(null);
              void postLink("google", { idToken: response.credential });
            } else {
              setLinkError(
                "Google sign-in didn't complete. Please try linking again, or refresh the page if the issue continues.",
              );
            }
          },
          ux_mode: "popup",
        });
        window.google.accounts.id.renderButton(googleLinkBtnRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: googleLinkBtnRef.current.clientWidth || 320,
        });
      })
      .catch(() => { /* network error — button just won't render */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socialLinks, googleLinked]);

  useEffect(() => {
    if (!APPLE_SERVICES_ID) return;
    loadScriptOnce(
      "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js",
      "apple-auth-script",
    )
      .then(() => {
        if (!window.AppleID) return;
        window.AppleID.auth.init({
          clientId: APPLE_SERVICES_ID,
          scope: "name email",
          redirectURI: APPLE_REDIRECT_URI || window.location.origin + "/portal/privacy",
          usePopup: true,
        });
      })
      .catch(() => { /* ignore */ });
  }, []);

  async function save(patch: Partial<PublicProfileSettings>) {
    if (!settings) return;
    setSaving(true);
    setError(null);
    const res = await authFetch(`${API}/portal/me/public-profile`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Failed to save");
    } else {
      const updated = await res.json();
      setSettings(updated);
      setSavedAt(new Date());
    }
    setSaving(false);
  }

  async function toggleScorecard(playerId: number, hidden: boolean) {
    const res = await authFetch(`${API}/portal/me/public-scorecards/${playerId}`, {
      method: "PATCH",
      body: JSON.stringify({ publicHidden: hidden }),
    });
    if (res.ok) {
      setScorecards(prev => prev.map(s => s.playerId === playerId ? { ...s, publicHidden: hidden } : s));
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (!settings) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold mb-2">Sign in required</h1>
        <Link href="/portal" className="text-emerald-600 underline">Go to portal</Link>
      </div>
    );
  }

  const profileUrl = settings.publicHandle
    ? `${window.location.protocol}//${window.location.host.replace(/:\d+$/, "")}/p/${settings.publicHandle}`
    : null;

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-6" data-testid="portal-privacy-page">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Shield className="w-6 h-6 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold">Public profile & privacy</h1>
            <p className="text-sm text-muted-foreground">Control your opt-in public profile and shareable scorecards.</p>
          </div>
        </div>

        {error && <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>}
        {savedAt && !error && <div className="mb-4 p-3 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">Saved · {savedAt.toLocaleTimeString()}</div>}

        {/* Handle reservation */}
        <section className="bg-white border rounded-lg p-5 mb-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Globe className="w-4 h-4" />Profile handle</h2>
          <p className="text-sm text-muted-foreground mb-3">Your public profile lives at <code>kharagolf.com/p/&lt;handle&gt;</code>. Handles are 3–30 characters, lowercase letters/numbers/dashes/underscores.</p>
          <HandleEditor
            current={settings.publicHandle}
            onSave={(h) => save({ publicHandle: h })}
            disabled={saving}
          />
          {profileUrl && (
            <div className="mt-3 text-sm">
              <a href={profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 hover:underline" data-testid="profile-link">
                {profileUrl} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
        </section>

        {/* Share profile */}
        {settings.publicProfileEnabled && profileUrl && (
          <section className="bg-white border rounded-lg p-5 mb-5" data-testid="share-section">
            <h2 className="font-semibold mb-3 flex items-center gap-2"><Share2 className="w-4 h-4" />Share my profile</h2>
            <p className="text-sm text-muted-foreground mb-3">Promote your profile to friends and on social.</p>
            <ShareControls profileUrl={profileUrl} handle={settings.publicHandle ?? ""} stats={shareStats} onShared={refreshShareStats} />
          </section>
        )}

        {/* Profile toggle */}
        <section className="bg-white border rounded-lg p-5 mb-5">
          <ToggleRow
            label="Public profile"
            description="Make your profile discoverable at kharagolf.com/p/<handle>. Off by default."
            checked={settings.publicProfileEnabled}
            onChange={(v) => save({ publicProfileEnabled: v })}
            disabled={saving || !settings.publicHandle}
            testId="toggle-profile-enabled"
          />
          {!settings.publicHandle && (
            <p className="text-xs text-amber-700 mt-2">Reserve a handle above before turning your profile on.</p>
          )}
        </section>

        {/* Per-section privacy */}
        <section className="bg-white border rounded-lg p-5 mb-5">
          <h2 className="font-semibold mb-3">Section visibility</h2>
          <div className="divide-y">
            <ToggleRow
              label="Show handicap journey"
              description="Display your handicap index history on your public profile."
              checked={settings.publicShowHandicap}
              onChange={(v) => save({ publicShowHandicap: v })}
              disabled={saving}
              testId="toggle-handicap"
            />
            <ToggleRow
              label="Show recent rounds"
              description="List your most recent shareable scorecards on your profile."
              checked={settings.publicShowRecentRounds}
              onChange={(v) => save({ publicShowRecentRounds: v })}
              disabled={saving}
              testId="toggle-rounds"
            />
            <ToggleRow
              label="Show achievements"
              description="Display badges and milestones you've earned."
              checked={settings.publicShowAchievements}
              onChange={(v) => save({ publicShowAchievements: v })}
              disabled={saving}
              testId="toggle-achievements"
            />
            <ToggleRow
              label="Show favourite courses"
              description="Display the courses where you've played most often."
              checked={settings.publicShowFavoriteCourses}
              onChange={(v) => save({ publicShowFavoriteCourses: v })}
              disabled={saving}
              testId="toggle-favorites"
            />
          </div>
        </section>

        {/* Bio + location */}
        <section className="bg-white border rounded-lg p-5 mb-5">
          <h2 className="font-semibold mb-3">About you</h2>
          <BioEditor
            bio={settings.publicBio}
            location={settings.publicLocation}
            onSave={(bio, location) => save({ publicBio: bio, publicLocation: location })}
            disabled={saving}
          />
        </section>

        <section className="bg-white border rounded-lg p-5 mb-5" data-testid="linked-accounts-section">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Link2 className="w-4 h-4" />Linked accounts</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Sign-in shortcuts for Apple and Google. Removing a link won't sign you out, but you won't be able to use that provider until you link it again.
          </p>
          {linkError && (
            <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2" data-testid="linked-accounts-error">{linkError}</div>
          )}
          {socialLinks === null ? (
            <p className="text-sm text-muted-foreground">Couldn't load linked accounts.</p>
          ) : (
            <>
              {socialLinks.links.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="no-linked-accounts">You haven't linked Apple or Google yet — link one below to skip the password next time.</p>
              ) : (
                <ul className="divide-y">
                  {socialLinks.links.map((link) => {
                    const others = socialLinks.links.filter(l => l.provider !== link.provider).length;
                    const safeToUnlink = socialLinks.hasPassword || socialLinks.hasReplitOauth || others > 0;
                    const label = link.provider === "apple" ? "Apple" : "Google";
                    return (
                      <li key={link.provider} className="py-3 flex items-center justify-between gap-3" data-testid={`linked-${link.provider}`}>
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{label}</div>
                          <div className="text-xs text-muted-foreground">
                            {link.legacy
                              ? "Linked before tracking began"
                              : `Linked ${new Date(link.linkedAt).toLocaleDateString()} · last used ${new Date(link.lastUsedAt).toLocaleDateString()}`}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => unlinkProvider(link.provider)}
                          disabled={!safeToUnlink || unlinking === link.provider}
                          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          title={safeToUnlink ? `Unlink ${label}` : "Set a password or link another provider before removing this one."}
                          data-testid={`unlink-${link.provider}`}
                        >
                          {unlinking === link.provider
                            ? <><Loader2 className="w-3 h-3 animate-spin" />Unlinking…</>
                            : <><Unlink className="w-3 h-3" />Unlink</>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* "Add a link" affordances — one button per provider that
                  isn't already in `socialLinks.links`. We hide the section
                  entirely when both providers are linked AND when no
                  provider is server-side configured. */}
              {(!googleLinked || !appleLinked) && (GOOGLE_CLIENT_ID || APPLE_SERVICES_ID) && (
                <div className="mt-4 pt-4 border-t" data-testid="link-account-section">
                  <p className="text-xs text-muted-foreground mb-3">Link another provider to add a one-tap sign-in:</p>
                  <div className="space-y-3">
                    {!googleLinked && GOOGLE_CLIENT_ID && (
                      <div data-testid="link-google-row" className="relative">
                        {/* Keep the GIS container mounted at all times so a
                            failed attempt remains clickable for retry —
                            unmounting it would require re-running
                            renderButton, which the deps-based effect won't
                            re-trigger. The overlay just dims it during the
                            in-flight POST. */}
                        <div ref={googleLinkBtnRef} className="w-full flex justify-center min-h-[40px]" />
                        {linking === "google" && (
                          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground bg-white/80 rounded">
                            <Loader2 className="w-3 h-3 animate-spin" /> Linking Google…
                          </div>
                        )}
                      </div>
                    )}
                    {!appleLinked && APPLE_SERVICES_ID && (
                      <button
                        type="button"
                        onClick={handleAppleLink}
                        disabled={linking !== null}
                        data-testid="link-apple-button"
                        className="w-full h-10 rounded-md bg-black text-white text-sm font-medium flex items-center justify-center gap-2 hover:bg-black/90 disabled:opacity-60"
                        aria-label="Link Apple"
                      >
                        {linking === "apple" ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
                              <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
                            </svg>
                            <span>Link Apple</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section className="bg-white border rounded-lg p-5 mb-5">
          <h2 className="font-semibold mb-3">Hide individual scorecards</h2>
          <p className="text-sm text-muted-foreground mb-3">Even when shared, hidden scorecards return 404 and are excluded from your public profile.</p>
          {scorecards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shareable scorecards yet.</p>
          ) : (
            <ul className="divide-y">
              {scorecards.map(sc => (
                <li key={sc.playerId} className="py-2.5 flex items-center justify-between gap-3" data-testid={`sc-${sc.playerId}`}>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{sc.tournamentName}</div>
                    <div className="text-xs text-muted-foreground">
                      {sc.startDate ? new Date(sc.startDate).toLocaleDateString() : "—"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleScorecard(sc.playerId, !sc.publicHidden)}
                    className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border ${sc.publicHidden ? "bg-red-50 text-red-800 border-red-200" : "bg-emerald-50 text-emerald-800 border-emerald-200"}`}
                  >
                    {sc.publicHidden ? <><EyeOff className="w-3 h-3" />Hidden</> : <><Eye className="w-3 h-3" />Visible</>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="text-center mt-6">
          <Link href="/portal" className="text-sm text-muted-foreground hover:underline">← Back to portal</Link>
        </div>
      </div>
    </div>
  );
}

function trackShare(method: "copy" | "web_share" | "native_share" | "qr_open") {
  // Best-effort: never block the UI on analytics. Returns a promise that
  // resolves once the POST settles so callers can sequence a stats refresh
  // after the event is persisted (without blocking initial UI feedback).
  return authFetch(`${API}/portal/me/profile-share-events`, {
    method: "POST",
    body: JSON.stringify({ method, source: "web" }),
    keepalive: true,
  }).catch(() => { /* swallow */ });
}

function ShareControls({ profileUrl, handle, stats, onShared }: { profileUrl: string; handle: string; stats: ShareStats | null; onShared: () => void }) {
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

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
      void trackShare("copy").then(() => onShared());
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareError("Could not copy link.");
    }
  }

  async function nativeShare() {
    setShareError(null);
    try {
      await navigator.share({
        title: handle ? `@${handle} on KHARAGOLF` : "My KHARAGOLF profile",
        text: "Check out my golf profile on KHARAGOLF.",
        url: profileUrl,
      });
      void trackShare("web_share").then(() => onShared());
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        setShareError("Share was cancelled or failed.");
      }
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-gray-900 text-white text-sm hover:opacity-90"
          data-testid="share-copy"
        >
          {copied ? <><Check className="w-3.5 h-3.5" />Copied!</> : <><Copy className="w-3.5 h-3.5" />Copy link</>}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={nativeShare}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-emerald-600 text-emerald-700 text-sm hover:bg-emerald-50"
            data-testid="share-native"
          >
            <Share2 className="w-3.5 h-3.5" />Share…
          </button>
        )}
      </div>
      {shareError && <p className="text-xs text-red-700 mt-2">{shareError}</p>}
      {stats && (
        <div className="mt-3 text-xs text-muted-foreground" data-testid="share-stats">
          <div className="font-medium text-gray-800">
            {stats.total === 0
              ? "No shares yet — be the first to spread the word!"
              : `${stats.total} ${stats.total === 1 ? "share" : "shares"} so far`}
          </div>
          {stats.total > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>Copy link: {stats.byMethod.copy ?? 0}</span>
              <span>Web share: {stats.byMethod.web_share ?? 0}</span>
              <span>Native share: {stats.byMethod.native_share ?? 0}</span>
              <span>QR code: {stats.byMethod.qr_open ?? 0}</span>
            </div>
          )}
          {/* Task #1458 — Web vs mobile reach split. Only render when at
              least one tagged source is present so owners with only
              legacy/null-source history aren't shown a meaningless
              "0 web · 0 mobile" row. */}
          {stats.bySource && (stats.bySource.web > 0 || stats.bySource.mobile > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="share-source-split">
              <span className="text-gray-700">Where shares come from:</span>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 text-[11px]"
                data-testid="share-source-web"
              >
                Web {stats.bySource.web}
              </span>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-0.5 text-[11px]"
                data-testid="share-source-mobile"
              >
                Mobile {stats.bySource.mobile}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label, description, checked, onChange, disabled, testId,
}: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <div className="py-3 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        data-testid={testId}
        className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? "bg-emerald-600" : "bg-gray-300"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function HandleEditor({ current, onSave, disabled }: { current: string | null; onSave: (h: string | null) => void; disabled?: boolean }) {
  const [val, setVal] = useState(current ?? "");
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center bg-gray-50 border rounded-md px-2 text-sm text-muted-foreground">@</div>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value.toLowerCase())}
        placeholder="your-handle"
        className="flex-1 px-3 py-2 border rounded-md text-sm"
        data-testid="handle-input"
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => onSave(val.trim() || null)}
        disabled={disabled || val === (current ?? "")}
        className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-gray-900 text-white text-sm hover:opacity-90 disabled:opacity-50"
        data-testid="handle-save"
      >
        <Save className="w-3 h-3" />Save
      </button>
    </div>
  );
}

function BioEditor({ bio, location, onSave, disabled }: { bio: string | null; location: string | null; onSave: (b: string | null, l: string | null) => void; disabled?: boolean }) {
  const [b, setB] = useState(bio ?? "");
  const [l, setL] = useState(location ?? "");
  const dirty = (b !== (bio ?? "")) || (l !== (location ?? ""));
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">Location</label>
        <input
          type="text"
          value={l}
          maxLength={120}
          onChange={(e) => setL(e.target.value)}
          placeholder="e.g. Mumbai, India"
          className="w-full px-3 py-2 border rounded-md text-sm"
          data-testid="location-input"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">Short bio</label>
        <textarea
          value={b}
          maxLength={500}
          onChange={(e) => setB(e.target.value)}
          placeholder="Tell visitors a little about your golf journey…"
          className="w-full px-3 py-2 border rounded-md text-sm min-h-[80px]"
          data-testid="bio-input"
        />
        <div className="text-xs text-muted-foreground mt-1">{b.length}/500</div>
      </div>
      <button
        type="button"
        onClick={() => onSave(b.trim() || null, l.trim() || null)}
        disabled={disabled || !dirty}
        className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-gray-900 text-white text-sm hover:opacity-90 disabled:opacity-50"
        data-testid="bio-save"
      >
        <Save className="w-3 h-3" />Save
      </button>
    </div>
  );
}
