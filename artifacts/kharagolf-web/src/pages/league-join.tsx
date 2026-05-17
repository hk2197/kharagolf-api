import { useState, useEffect } from 'react';
import { useSearch } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Users, AlertCircle, Loader2, Lock, FileText, Download } from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { PriceWithFx } from '@/components/PriceWithFx';
import { usePreAuthOrgBranding } from '@/lib/theme/usePreAuthOrgBranding';
import { useOrgTheme } from '@/lib/theme/useOrgTheme';

const BASE_URL_LEAGUE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

const LEAGUE_DOC_CATEGORY_LABELS: Record<string, string> = {
  local_rules: 'Local Rules', pace_of_play: 'Pace of Play', policy: 'Policy',
  general: 'General', results: 'Results', notice: 'Notice',
};

function LeaguePublicDocuments({ leagueId }: { leagueId: number }) {
  const [docs, setDocs] = useState<Array<{ documentId: number; title: string; category: string; filename: string | null }>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`${BASE_URL_LEAGUE}/api/public/leagues/${leagueId}/documents`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { setDocs(d); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [leagueId]);

  if (!loaded || docs.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="w-4 h-4 text-emerald-500" /> League Documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {docs.map(doc => (
          <a
            key={doc.documentId}
            href={`${BASE_URL_LEAGUE}/api/public/leagues/${leagueId}/documents/${doc.documentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors group"
          >
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium">{doc.title}</p>
                {doc.filename && <p className="text-xs text-muted-foreground">{doc.filename}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {LEAGUE_DOC_CATEGORY_LABELS[doc.category] ?? doc.category}
              </Badge>
              <Download className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
            </div>
          </a>
        ))}
      </CardContent>
    </Card>
  );
}

interface InviteInfo {
  organizationId: number;
  leagueId: number | null;
  tournamentId: number | null;
  recipientName: string | null;
  leagueName: string | null;
  leagueMembersOnly: boolean;
  leagueEntryFee: string | null;
  leagueMemberEntryFee: string | null;
  leagueCurrency: string | null;
  tournamentName: string | null;
  orgName: string | null;
  expiresAt: string;
}

export default function LeagueJoin() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const inviteToken = params.get('invite') ?? '';
  const orgIdParam = params.get('orgId') ?? '';

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [handicap, setHandicap] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Task #2188 — Render the inviting club's saved logo + name in the
  // header slot once the invite resolves to an organization id, falling
  // back to the URL slug heuristic before the invite loads (so an
  // `?org=<slug>` link or vanity domain still brands the page) and
  // finally to the default KHARAGOLF mark when nothing is in scope.
  const orgBranding = usePreAuthOrgBranding({ orgId: inviteInfo?.organizationId ?? null });
  useOrgTheme(orgBranding?.branding ?? null);

  useEffect(() => {
    if (!inviteToken) {
      setError('No invitation token provided.');
      setLoading(false);
      return;
    }
    fetch(`/api/public/invitations/${encodeURIComponent(inviteToken)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Invitation not found or has expired.');
        }
        return res.json();
      })
      .then((data: InviteInfo) => {
        setInviteInfo(data);
        if (data.recipientName) {
          const parts = data.recipientName.trim().split(' ');
          setFirstName(parts[0] ?? '');
          setLastName(parts.slice(1).join(' ') ?? '');
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [inviteToken]);

  const [membersOnlyBlocked, setMembersOnlyBlocked] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteInfo?.leagueId) return;
    setSubmitting(true);
    setSubmitError(null);
    setMembersOnlyBlocked(false);
    try {
      const orgId = inviteInfo.organizationId || parseInt(orgIdParam);
      const res = await fetch(`/api/public/orgs/${orgId}/leagues/${inviteInfo.leagueId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim() || undefined,
          handicapIndex: handicap ? parseFloat(handicap) : undefined,
          inviteToken,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 403 && data.membersOnly) {
          setMembersOnlyBlocked(true);
          return;
        }
        throw new Error(data.error || 'Failed to join league. Please try again.');
      }
      setSuccess(true);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-3" />
            <h2 className="text-lg font-semibold mb-2">Invitation Unavailable</h2>
            <p className="text-muted-foreground text-sm">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">You're In!</h2>
            <p className="text-muted-foreground">
              Welcome to <span className="text-foreground font-semibold">{inviteInfo?.leagueName}</span>.
              {inviteInfo?.orgName && <> Organised by {inviteInfo.orgName}.</>}
            </p>
            <p className="text-sm text-muted-foreground mt-3">
              Check your email for further details from your league organiser.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3 mb-1">
              {orgBranding?.logoUrl ? (
                <img
                  src={orgBranding.logoUrl}
                  alt={orgBranding.name ? `${orgBranding.name} logo` : 'Club logo'}
                  className="w-10 h-10 object-contain rounded-xl"
                  data-testid="league-join-org-logo"
                />
              ) : (
                <img src="/logo.png" alt="KharaGolf" className="w-10 h-10 object-contain rounded-xl" />
              )}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {orgBranding?.name ?? inviteInfo?.orgName ?? <KharaGolfWordmark />}
                </p>
                <CardTitle className="text-lg leading-tight">
                  {inviteInfo?.leagueName ?? 'League Invitation'}
                </CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="w-4 h-4" />
              <span>You've been invited to join this league</span>
            </div>
            {inviteInfo?.leagueMembersOnly && (
              <div className="flex items-center gap-2 mt-2">
                <Badge variant="outline" className="border-amber-500 text-amber-600 text-xs gap-1">
                  <Lock className="w-3 h-3" /> Members Only
                </Badge>
                {inviteInfo.leagueMemberEntryFee && inviteInfo.leagueEntryFee ? (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div>Member fee: <PriceWithFx orgId={inviteInfo.organizationId} amount={inviteInfo.leagueMemberEntryFee} currency={inviteInfo.leagueCurrency ?? 'INR'} bookedClassName="font-medium text-foreground" /></div>
                    <div className="opacity-60">Standard: <PriceWithFx orgId={inviteInfo.organizationId} amount={inviteInfo.leagueEntryFee} currency={inviteInfo.leagueCurrency ?? 'INR'} showDisclosure={false} disclosureOnHover /></div>
                  </div>
                ) : inviteInfo.leagueMemberEntryFee ? (
                  <span className="text-xs text-muted-foreground">Member fee: <PriceWithFx orgId={inviteInfo.organizationId} amount={inviteInfo.leagueMemberEntryFee} currency={inviteInfo.leagueCurrency ?? 'INR'} bookedClassName="font-medium text-foreground" /></span>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Invitation expires {new Date(inviteInfo?.expiresAt ?? '').toLocaleDateString()}
            </p>
          </CardContent>
        </Card>

        {inviteInfo?.leagueId && (
          <LeaguePublicDocuments leagueId={inviteInfo.leagueId} />
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">First Name *</label>
                  <Input
                    value={firstName}
                    onChange={e => setFirstName(e.target.value)}
                    placeholder="First"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Last Name *</label>
                  <Input
                    value={lastName}
                    onChange={e => setLastName(e.target.value)}
                    placeholder="Last"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <Input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Handicap Index</label>
                <Input
                  type="number"
                  step="0.1"
                  min="-10"
                  max="54"
                  value={handicap}
                  onChange={e => setHandicap(e.target.value)}
                  placeholder="e.g. 12.4"
                />
              </div>

              {membersOnlyBlocked && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm dark:bg-amber-900/20 dark:border-amber-700/50 dark:text-amber-300">
                  <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Members Only League</p>
                    <p className="text-xs mt-0.5">You need an active club membership to join. Please <a href="/portal" className="underline font-medium">sign in to the Player Portal</a> first, then return to this page.</p>
                  </div>
                </div>
              )}

              {submitError && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {submitError}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={submitting || !firstName || !lastName}>
                {submitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Joining…</>
                ) : (
                  'Accept Invitation & Join League'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
