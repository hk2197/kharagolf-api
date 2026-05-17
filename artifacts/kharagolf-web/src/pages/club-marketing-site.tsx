/**
 * Task #369 — Marketing Site Builder (admin editor).
 *
 * Lets org admins choose theme/hero/copy, toggle and reorder sections,
 * curate the gallery, edit SEO metadata and publish/unpublish the public
 * mini-site at /clubs/<slug>.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Loader2, Globe, Eye, EyeOff, Save, Trash2, Plus, ArrowUp, ArrowDown, ExternalLink, Upload, Check, RefreshCw, Monitor, Smartphone, Image as ImageIcon, Library, ArrowRight, ArrowLeft, AlertTriangle } from 'lucide-react';
import { useLocation } from 'wouter';
import { ImageCropDialog, type CropKind } from '@/components/ImageCropDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const apiUrl = (p: string) => `${BASE_URL}/api${p}`;

const SECTION_LABELS: Record<string, string> = {
  hero: 'Hero banner',
  about: 'About / Welcome',
  tournaments: 'Upcoming tournaments',
  lessons: 'Lessons & coaching',
  tee_times: 'Book a tee time',
  fb: 'Food & Beverage',
  gallery: 'Photo gallery',
  services: 'Services & amenities',
  contact: 'Contact details',
};

const ALL_SECTIONS = ['hero','about','tournaments','lessons','tee_times','fb','gallery','services','contact'];

/**
 * Task #437 — Visual descriptors for the four built-in themes. Used by
 * the editor to render mini hero "thumbnails" so admins know what each
 * theme looks like before picking it.
 */
const THEME_OPTIONS: Array<{
  id: string;
  label: string;
  description: string;
  hero: string;
  body: string;
  accent: string;
  ctaBg: string;
  ctaText: string;
  font: string;
}> = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Deep emerald — traditional, country-club feel.',
    hero: 'bg-emerald-900 text-white',
    body: 'bg-stone-50',
    accent: 'text-emerald-700',
    ctaBg: 'bg-white',
    ctaText: 'text-gray-900',
    font: 'font-serif',
  },
  {
    id: 'modern',
    label: 'Modern',
    description: 'Gradient hero, crisp white sections.',
    hero: 'bg-gradient-to-br from-emerald-700 via-emerald-900 to-black text-white',
    body: 'bg-white',
    accent: 'text-emerald-600',
    ctaBg: 'bg-white',
    ctaText: 'text-gray-900',
    font: 'font-sans',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Light, editorial, lots of whitespace.',
    hero: 'bg-white text-gray-900 border-b',
    body: 'bg-white',
    accent: 'text-gray-900',
    ctaBg: 'bg-gray-900',
    ctaText: 'text-white',
    font: 'font-sans',
  },
  {
    id: 'bold',
    label: 'Bold',
    description: 'Black hero with amber accents — high contrast.',
    hero: 'bg-black text-white',
    body: 'bg-zinc-50',
    accent: 'text-amber-500',
    ctaBg: 'bg-amber-500',
    ctaText: 'text-black',
    font: 'font-sans',
  },
];

function ThemeThumbnail({
  opt,
  selected,
  onSelect,
  heroTitle,
  heroSubtitle,
  ctaLabel,
  heroImageUrl,
  brandPrimary,
  brandAccent,
  brandFont,
}: {
  opt: typeof THEME_OPTIONS[number];
  selected: boolean;
  onSelect: () => void;
  heroTitle: string;
  heroSubtitle: string;
  ctaLabel: string;
  heroImageUrl: string | null;
  // Task #584 — Brand overrides previewed live in the picker so admins
  // can immediately see the customised theme alongside the defaults.
  brandPrimary: string | null;
  brandAccent: string | null;
  brandFont: string | null;
}) {
  // Hero image always wins; otherwise brandPrimary overrides theme bg.
  const heroStyle: React.CSSProperties = heroImageUrl
    ? {
        backgroundImage: `linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.55)), url(${heroImageUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'white',
      }
    : (brandPrimary ? { backgroundColor: brandPrimary, color: 'white' } : {});
  if (brandFont) heroStyle.fontFamily = brandFont;
  const accentStyle = brandAccent ? { color: brandAccent } : undefined;
  const fontStyle = brandFont ? { fontFamily: brandFont } : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`theme-card-${opt.id}`}
      aria-pressed={selected}
      className={`text-left rounded-lg border-2 overflow-hidden transition shadow-sm hover:shadow-md ${
        selected ? 'border-emerald-600 ring-2 ring-emerald-200' : 'border-gray-200'
      }`}
    >
      {/* Mini hero */}
      <div
        className={`relative px-3 py-5 ${opt.hero} ${opt.font}`}
        style={heroStyle}
      >
        <div className="text-[11px] font-semibold leading-tight truncate" style={fontStyle}>{heroTitle || 'Your club name'}</div>
        <div className="text-[9px] opacity-90 leading-tight truncate mt-0.5">{heroSubtitle || 'A short tagline'}</div>
        <div className={`inline-block mt-2 text-[8px] px-1.5 py-0.5 rounded ${opt.ctaBg} ${opt.ctaText} font-medium`}>
          {ctaLabel || 'Book a tee time'}
        </div>
        {selected && (
          <div className="absolute top-1 right-1 bg-emerald-600 text-white rounded-full w-4 h-4 flex items-center justify-center">
            <Check className="w-3 h-3" />
          </div>
        )}
      </div>
      {/* Mini body */}
      <div className={`${opt.body} px-3 py-2`}>
        <div className={`text-[10px] font-semibold ${opt.accent}`} style={{ ...accentStyle, ...fontStyle }}>About</div>
        <div className="mt-1 space-y-0.5">
          <div className="h-1 rounded bg-gray-300/70 w-full" />
          <div className="h-1 rounded bg-gray-300/70 w-5/6" />
          <div className="h-1 rounded bg-gray-300/70 w-2/3" />
        </div>
      </div>
      {/* Caption */}
      <div className="px-3 py-2 border-t bg-white">
        <div className="text-sm font-medium">{opt.label}</div>
        <div className="text-[11px] text-muted-foreground leading-snug">{opt.description}</div>
      </div>
    </button>
  );
}

interface Site {
  id: number;
  organizationId: number;
  theme: string;
  heroImageUrl: string | null;
  heroTitle: string | null;
  heroSubtitle: string | null;
  heroCtaLabel: string | null;
  heroCtaHref: string | null;
  aboutMarkdown: string | null;
  servicesMarkdown: string | null;
  galleryImages: Array<{ url: string; caption?: string | null }>;
  sectionOrder: string[];
  enabledSections: Record<string, boolean>;
  seoTitle: string | null;
  seoDescription: string | null;
  seoOgImageUrl: string | null;
  // Task #584 — per-site brand overrides (null = use theme default).
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  brandHeadingFont: string | null;
  // Task #666 — marketing-specific logo + favicon overrides (null = fall
  // back to the org logo / platform default favicon).
  logoImageUrl: string | null;
  faviconUrl: string | null;
  // Task #1467 / Task #1807 — Original external URL the rehosted cache
  // was sourced from, plus the timestamps and any error message left
  // behind by the periodic refresh job. Surfaced in the editor so
  // admins can spot a stale cached copy and fix or remove the source
  // URL before it goes stale on disk. Null on direct uploads / internal
  // /objects/... paths (no upstream to track).
  logoSourceUrl: string | null;
  logoSourceLastRefreshedAt: string | null;
  logoSourceLastRefreshError: string | null;
  faviconSourceUrl: string | null;
  faviconSourceLastRefreshedAt: string | null;
  faviconSourceLastRefreshError: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  cacheVersion: number;
  // Task #1799 — Total bytes (and object count) currently stored under
  // marketing-cache/<orgId>/. Server returns null when the storage
  // backend is briefly unavailable (UI then renders "—").
  marketingCacheUsage: { totalBytes: number; objectCount: number } | null;
}

/**
 * Task #1799 — Format a byte count as a short human-friendly string
 * (e.g. 0 → "0 B", 850 → "850 B", 1536 → "1.5 KB", 1_234_567 → "1.2 MB").
 * Used to render the marketing-cache "X KB used" hint in the admin UI.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Task #1807 — Plain-language formatter for the marketing-image refresh
 * status. The periodic refresh job (Task #1467) re-downloads each
 * `*SourceUrl` and writes back `sourceLastRefreshedAt` (always) and
 * `sourceLastRefreshError` (NULL on success, the verifier error text on
 * failure). The cached copy is preserved either way — these timestamps
 * just tell the admin whether the cache is going stale.
 *
 * The hostname comes from the source URL itself (rather than the error
 * text) so we can render "Couldn't refresh from cdn.example.com" even
 * for opaque verifier errors that don't mention the host.
 */
function formatHostFromUrl(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}
function formatSourceRefreshDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Task #1807 — Refresh-status panel rendered under each logo / favicon
 * input. Three render modes:
 *   1. No source URL (direct upload, internal /objects/... path, or
 *      legacy row): nothing to show, return null.
 *   2. Source URL set, no failure: show the original URL the cache was
 *      seeded from + last successful refresh time. Lets admins confirm
 *      the cache is current and gives them a one-click "Clear source"
 *      to drop back to a direct upload.
 *   3. Source URL set, last refresh failed: same as (2) but with the
 *      plain-language error rendered in destructive styling
 *      ("Couldn't refresh from cdn.example.com — host returned HTTP 503
 *      on Apr 27, 2026"). The cached image is preserved on failure, so
 *      the message is informational — admins can replace the URL via
 *      the input above to retry, or clear it to fall back.
 */
function SourceRefreshStatus({
  kind,
  sourceUrl,
  lastRefreshedAt,
  lastRefreshError,
  onClear,
}: {
  kind: 'logo' | 'favicon';
  sourceUrl: string | null;
  lastRefreshedAt: string | null;
  lastRefreshError: string | null;
  onClear: () => void;
}) {
  const { t } = useTranslation('admin');
  if (!sourceUrl) return null;
  const host = formatHostFromUrl(sourceUrl);
  const when = formatSourceRefreshDate(lastRefreshedAt);
  const failed = !!lastRefreshError;
  return (
    <div
      className={`mt-2 rounded border px-3 py-2 text-xs ${
        failed
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-muted bg-muted/30 text-muted-foreground'
      }`}
      data-testid={`${kind}-source-status`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{t('marketingSiteRefresh.originalSource')}</span>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline truncate max-w-full"
          data-testid={`${kind}-source-url`}
          title={sourceUrl}
        >
          {sourceUrl}
        </a>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto underline hover:no-underline"
          data-testid={`button-clear-${kind}-source`}
        >
          {t('marketingSiteRefresh.clearSource')}
        </button>
      </div>
      {failed ? (
        <div
          className="mt-1 flex items-start gap-1.5"
          data-testid={`${kind}-source-error`}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {when
              ? t('marketingSiteRefresh.refreshFailedWithDate', { host, error: lastRefreshError, when })
              : t('marketingSiteRefresh.refreshFailed', { host, error: lastRefreshError })}
          </span>
        </div>
      ) : when ? (
        <div className="mt-1" data-testid={`${kind}-source-last-refreshed`}>
          {t('marketingSiteRefresh.lastRefreshed', { when })}
        </div>
      ) : (
        <div className="mt-1" data-testid={`${kind}-source-last-refreshed`}>
          {t('marketingSiteRefresh.notRefreshedYet')}
        </div>
      )}
    </div>
  );
}

const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Inter, system-ui, sans-serif', label: 'Inter (sans)' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia (serif)' },
  { value: "'Playfair Display', Georgia, serif", label: 'Playfair Display (display serif)' },
  { value: 'Montserrat, system-ui, sans-serif', label: 'Montserrat (sans)' },
  { value: "'Roboto Slab', Georgia, serif", label: 'Roboto Slab (slab)' },
  { value: "'Bebas Neue', Impact, sans-serif", label: 'Bebas Neue (display)' },
  { value: "'Courier New', monospace", label: 'Courier New (mono)' },
];

/**
 * Task #437 — Embedded live-preview pane.
 *
 * Issues a short-lived preview token from the API and loads
 *   <marketingOrigin>/clubs/<slug>?preview=<token>
 * inside an iframe. The pane refreshes automatically whenever the
 * site is saved (signalled via `cacheVersion`) or the admin toggles
 * desktop / mobile widths. A "Refresh" button forces a re-issue of
 * the token (e.g. after the 1-hour TTL).
 */
function PreviewPane({
  orgId,
  orgSlug,
  cacheVersion,
  marketingOrigin,
}: {
  orgId: number;
  orgSlug: string;
  cacheVersion: number;
  marketingOrigin: string;
}) {
  const { toast } = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  // Bumped on every save (cacheVersion change) and manual refresh —
  // appended to the iframe URL to bust any caching.
  const [refreshKey, setRefreshKey] = useState(0);

  async function fetchToken() {
    if (!orgId) return;
    setLoadingToken(true);
    try {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/preview-token`), {
        method: 'POST', credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setToken(j.token);
      setRefreshKey(k => k + 1);
    } catch {
      toast({ title: 'Could not start preview', variant: 'destructive' });
    } finally {
      setLoadingToken(false);
    }
  }

  // Refresh the iframe whenever the saved cacheVersion changes — i.e.
  // every time the admin clicks Save. We don't re-issue the token here;
  // it's still valid for 1 hour.
  useEffect(() => {
    if (token) setRefreshKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion]);

  const previewUrl = useMemo(() => {
    if (!token || !orgSlug) return null;
    const base = `${marketingOrigin}/clubs/${orgSlug}`;
    // refreshKey bumps the URL so the iframe reloads even when nothing
    // else (slug, token) changed.
    return `${base}?preview=${encodeURIComponent(token)}&v=${refreshKey}`;
  }, [token, orgSlug, marketingOrigin, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Live preview</CardTitle>
            <CardDescription>
              See how the public site will look with your current saved changes — even before you publish.
              Changes appear after each Save.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {token && (
              <>
                <div className="flex border rounded overflow-hidden">
                  <Button
                    type="button"
                    variant={device === 'desktop' ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-none"
                    onClick={() => setDevice('desktop')}
                    data-testid="preview-device-desktop"
                    aria-label="Desktop width"
                  ><Monitor className="w-4 h-4" /></Button>
                  <Button
                    type="button"
                    variant={device === 'mobile' ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-none"
                    onClick={() => setDevice('mobile')}
                    data-testid="preview-device-mobile"
                    aria-label="Mobile width"
                  ><Smartphone className="w-4 h-4" /></Button>
                </div>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={fetchToken} disabled={loadingToken}
                  data-testid="button-refresh-preview"
                >
                  {loadingToken ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                  Refresh
                </Button>
                {previewUrl && (
                  <Button asChild variant="outline" size="sm">
                    <a href={previewUrl} target="_blank" rel="noreferrer" data-testid="link-open-preview">
                      <ExternalLink className="w-4 h-4 mr-1" />Open in new tab
                    </a>
                  </Button>
                )}
              </>
            )}
            {!token && (
              <Button
                type="button" onClick={fetchToken} disabled={loadingToken || !orgSlug}
                data-testid="button-open-preview"
              >
                {loadingToken ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Eye className="w-4 h-4 mr-1" />}
                Open preview
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!token ? (
          <div className="border rounded-lg p-8 text-center text-sm text-muted-foreground bg-muted/30">
            Click <strong>Open preview</strong> to render your unpublished draft inline. The preview link
            stays valid for one hour.
          </div>
        ) : !orgSlug ? (
          <div className="border rounded-lg p-8 text-center text-sm text-muted-foreground">
            Club slug not available — preview disabled.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden bg-gray-100" data-testid="preview-frame-container">
            <div className="mx-auto bg-white" style={{ width: device === 'mobile' ? 390 : '100%', maxWidth: '100%' }}>
              <iframe
                key={refreshKey}
                src={previewUrl ?? undefined}
                title="Marketing site preview"
                className="w-full"
                style={{ height: 720, border: 0 }}
                data-testid="preview-iframe"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ClubMarketingSitePage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const [site, setSite] = useState<Site | null>(null);
  const [orgSlug, setOrgSlug] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    Promise.all([
      fetch(apiUrl(`/organizations/${orgId}/marketing-site`), { credentials: 'include' }).then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(apiUrl(`/organizations/${orgId}`), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ]).then(([s, org]) => {
      // Guard against the API returning an error object instead of a site row.
      if (!s || typeof s.id !== 'number') throw new Error('invalid site response');
      setSite(s as Site);
      if (org?.slug) setOrgSlug(org.slug);
    }).catch(() => toast({ title: 'Failed to load site', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [orgId, toast]);

  const orderedSections = useMemo(() => {
    if (!site) return [] as string[];
    const order = site.sectionOrder ?? [];
    return [...order, ...ALL_SECTIONS.filter(s => !order.includes(s))];
  }, [site]);

  if (loading || !site) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  function updateField<K extends keyof Site>(key: K, value: Site[K]) {
    setSite(s => s ? { ...s, [key]: value } : s);
  }
  function toggleSection(id: string) {
    setSite(s => s ? { ...s, enabledSections: { ...s.enabledSections, [id]: !s.enabledSections[id] } } : s);
  }
  function moveSection(id: string, dir: -1 | 1) {
    setSite(s => {
      if (!s) return s;
      const order = [...orderedSections];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return s;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...s, sectionOrder: order };
    });
  }
  function addGalleryImage() {
    setSite(s => s ? { ...s, galleryImages: [...s.galleryImages, { url: '', caption: '' }] } : s);
  }
  function updateGalleryImage(i: number, key: 'url' | 'caption', val: string) {
    setSite(s => {
      if (!s) return s;
      const next = [...s.galleryImages];
      next[i] = { ...next[i], [key]: val };
      return { ...s, galleryImages: next };
    });
  }
  function removeGalleryImage(i: number) {
    setSite(s => s ? { ...s, galleryImages: s.galleryImages.filter((_, idx) => idx !== i) } : s);
  }

  async function uploadImage(file: File): Promise<string | null> {
    if (!orgId) return null;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Please choose an image file', variant: 'destructive' });
      return null;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'Image is too large (max 10 MB)', variant: 'destructive' });
      return null;
    }
    try {
      const tokenRes = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/upload-url`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, size: file.size }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        toast({ title: err.error ?? 'Could not start upload', variant: 'destructive' });
        return null;
      }
      const { uploadURL, objectPath, uploadToken } = await tokenRes.json();

      const putRes = await fetch(uploadURL, {
        method: 'PUT', body: file, headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) {
        toast({ title: 'Upload failed', variant: 'destructive' });
        return null;
      }

      const regRes = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/images`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectPath, uploadToken }),
      });
      if (!regRes.ok) {
        const err = await regRes.json().catch(() => ({}));
        toast({ title: err.error ?? 'Could not register image', variant: 'destructive' });
        return null;
      }
      const { url } = await regRes.json();
      return url as string;
    } catch {
      toast({ title: 'Upload failed', variant: 'destructive' });
      return null;
    }
  }

  async function save() {
    if (!site || !orgId) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/marketing-site`), {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: site.theme,
          heroImageUrl: site.heroImageUrl, heroTitle: site.heroTitle, heroSubtitle: site.heroSubtitle,
          heroCtaLabel: site.heroCtaLabel, heroCtaHref: site.heroCtaHref,
          aboutMarkdown: site.aboutMarkdown, servicesMarkdown: site.servicesMarkdown,
          galleryImages: site.galleryImages.filter(g => g.url.trim() !== ''),
          sectionOrder: orderedSections,
          enabledSections: site.enabledSections,
          seoTitle: site.seoTitle, seoDescription: site.seoDescription, seoOgImageUrl: site.seoOgImageUrl,
          // Task #584 — send overrides as null when blank so the API resets
          // them back to the chosen theme defaults.
          brandPrimaryColor: site.brandPrimaryColor || null,
          brandAccentColor: site.brandAccentColor || null,
          brandHeadingFont: site.brandHeadingFont || null,
          // Task #666 — empty string clears back to org logo / platform favicon.
          logoImageUrl: site.logoImageUrl || null,
          faviconUrl: site.faviconUrl || null,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      const updated = await res.json();
      setSite(updated);
      toast({ title: 'Saved', description: 'Marketing site updated.' });
    } catch (e) {
      toast({ title: 'Save failed', variant: 'destructive' });
    } finally { setSaving(false); }
  }

  async function togglePublish() {
    if (!site || !orgId) return;
    const action = site.isPublished ? 'unpublish' : 'publish';
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/${action}`), {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setSite(updated);
      toast({ title: site.isPublished ? 'Site unpublished' : 'Site is live' });
    } catch {
      toast({ title: 'Failed', variant: 'destructive' });
    } finally { setSaving(false); }
  }

  // The marketing site lives in a different artifact (kharagolf-website),
  // typically on a different host in production. Resolve to an absolute
  // URL via VITE_MARKETING_SITE_URL when set; fall back to a relative
  // path for local/single-host setups.
  const marketingOrigin = (import.meta.env.VITE_MARKETING_SITE_URL ?? '').replace(/\/$/, '');
  const publicUrl = orgSlug ? `${marketingOrigin}/clubs/${orgSlug}` : null;

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Globe className="w-6 h-6" />Marketing Site</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure your club's public mini-site. Cache version: {site.cacheVersion}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {site.isPublished
            ? <Badge className="bg-green-600">Live</Badge>
            : <Badge variant="secondary">Draft</Badge>}
          {publicUrl && site.isPublished && (
            <Button asChild variant="outline" size="sm">
              <a href={publicUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="w-4 h-4 mr-1" />View public site
              </a>
            </Button>
          )}
          <Button onClick={togglePublish} disabled={saving} variant={site.isPublished ? 'outline' : 'default'}>
            {site.isPublished ? <><EyeOff className="w-4 h-4 mr-1" />Unpublish</> : <><Eye className="w-4 h-4 mr-1" />Publish</>}
          </Button>
          <Button onClick={save} disabled={saving} data-testid="button-save-site">
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}Save
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>
            Pick a visual style for the public site. Each thumbnail uses your hero copy and
            image so you can see how the live site will look.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="theme-picker">
            {THEME_OPTIONS.map(opt => (
              <ThemeThumbnail
                key={opt.id}
                opt={opt}
                selected={site.theme === opt.id}
                onSelect={() => updateField('theme', opt.id)}
                heroTitle={site.heroTitle ?? ''}
                heroSubtitle={site.heroSubtitle ?? ''}
                ctaLabel={site.heroCtaLabel ?? ''}
                heroImageUrl={site.heroImageUrl}
                brandPrimary={site.brandPrimaryColor}
                brandAccent={site.brandAccentColor}
                brandFont={site.brandHeadingFont}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Task #584 — Brand overrides: layered on top of the chosen theme. */}
      <Card data-testid="brand-overrides-card">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Brand overrides</CardTitle>
              <CardDescription>
                Match your existing brand by overriding the theme's primary color,
                accent color, or heading font. Leave blank to use the theme defaults.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="button-reset-brand"
              onClick={() => {
                updateField('brandPrimaryColor', null);
                updateField('brandAccentColor', null);
                updateField('brandHeadingFont', null);
              }}
              disabled={!site.brandPrimaryColor && !site.brandAccentColor && !site.brandHeadingFont}
            >
              Reset to theme defaults
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Primary color</Label>
              <p className="text-xs text-muted-foreground mb-1">
                Used as the hero background when no hero image is set.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  data-testid="input-brand-primary-color"
                  value={site.brandPrimaryColor ?? '#065f46'}
                  onChange={e => updateField('brandPrimaryColor', e.target.value)}
                  className="h-9 w-12 rounded border cursor-pointer"
                  aria-label="Primary color picker"
                />
                <Input
                  value={site.brandPrimaryColor ?? ''}
                  onChange={e => updateField('brandPrimaryColor', e.target.value || null)}
                  placeholder="#065f46 (leave blank for theme default)"
                  data-testid="input-brand-primary-hex"
                />
                {site.brandPrimaryColor && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateField('brandPrimaryColor', null)}
                    data-testid="button-clear-brand-primary"
                    aria-label="Clear primary color override"
                  ><Trash2 className="w-4 h-4" /></Button>
                )}
              </div>
            </div>
            <div>
              <Label>Accent color</Label>
              <p className="text-xs text-muted-foreground mb-1">
                Used for section headings and highlights.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  data-testid="input-brand-accent-color"
                  value={site.brandAccentColor ?? '#047857'}
                  onChange={e => updateField('brandAccentColor', e.target.value)}
                  className="h-9 w-12 rounded border cursor-pointer"
                  aria-label="Accent color picker"
                />
                <Input
                  value={site.brandAccentColor ?? ''}
                  onChange={e => updateField('brandAccentColor', e.target.value || null)}
                  placeholder="#047857 (leave blank for theme default)"
                  data-testid="input-brand-accent-hex"
                />
                {site.brandAccentColor && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateField('brandAccentColor', null)}
                    data-testid="button-clear-brand-accent"
                    aria-label="Clear accent color override"
                  ><Trash2 className="w-4 h-4" /></Button>
                )}
              </div>
            </div>
          </div>
          <div>
            <Label>Heading font</Label>
            <p className="text-xs text-muted-foreground mb-1">
              Applied to the hero title and section headings on the public site.
            </p>
            <div className="flex items-center gap-2">
              <select
                value={site.brandHeadingFont ?? ''}
                onChange={e => updateField('brandHeadingFont', e.target.value || null)}
                data-testid="select-brand-heading-font"
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
                style={site.brandHeadingFont ? { fontFamily: site.brandHeadingFont } : undefined}
              >
                <option value="">Theme default</option>
                {FONT_OPTIONS.map(f => (
                  <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                    {f.label}
                  </option>
                ))}
              </select>
              {site.brandHeadingFont && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => updateField('brandHeadingFont', null)}
                  data-testid="button-clear-brand-font"
                  aria-label="Clear heading font override"
                ><Trash2 className="w-4 h-4" /></Button>
              )}
            </div>
            {site.brandHeadingFont && (
              <div
                className="mt-2 rounded border bg-muted/30 px-3 py-2 text-xl"
                style={{ fontFamily: site.brandHeadingFont, color: site.brandAccentColor ?? undefined }}
                data-testid="brand-font-preview"
              >
                The quick brown fox jumps over the lazy dog
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <PreviewPane
        orgId={orgId!}
        orgSlug={orgSlug}
        cacheVersion={site.cacheVersion}
        marketingOrigin={marketingOrigin}
      />

      {/* Task #666 — Marketing-specific logo & favicon overrides. */}
      <Card data-testid="branding-assets-card">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Logo & favicon</CardTitle>
              <CardDescription>
                Upload a marketing-specific logo (shown in the public site header)
                and favicon (the small icon shown in the browser tab). Leave blank
                to fall back to your club's logo and the platform default favicon.
              </CardDescription>
              {/* Task #1799 — Show admins how much storage their cached
                  marketing logos / favicons currently occupy. Helps spot
                  the case where the same external URL keeps re-saving
                  with slightly different bytes (e.g. CDN re-encodes) and
                  piles up under marketing-cache/<orgId>/. */}
              <p
                className="text-xs text-muted-foreground mt-2"
                data-testid="text-marketing-cache-usage"
              >
                Cached image storage:{' '}
                {site.marketingCacheUsage
                  ? `${formatBytes(site.marketingCacheUsage.totalBytes)} used` +
                    ` (${site.marketingCacheUsage.objectCount} ` +
                    `${site.marketingCacheUsage.objectCount === 1 ? 'file' : 'files'})`
                  : '—'}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="button-reset-branding-assets"
              onClick={() => {
                updateField('logoImageUrl', null);
                updateField('faviconUrl', null);
              }}
              disabled={!site.logoImageUrl && !site.faviconUrl}
            >
              Reset to defaults
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Marketing logo</Label>
            <p className="text-xs text-muted-foreground mb-1">
              Used in the public site header instead of your club's generic logo.
              Square images work best (e.g. 256×256 PNG).
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={site.logoImageUrl ?? ''}
                onChange={e => updateField('logoImageUrl', e.target.value || null)}
                placeholder="Upload an image or paste a URL (https://…)"
                data-testid="input-logo-image-url"
              />
              <ImageUploadButton
                label="Upload"
                testId="button-upload-logo"
                cropKind="gallery"
                onUpload={async (file) => {
                  const url = await uploadImage(file);
                  if (url) updateField('logoImageUrl', url);
                }}
              />
              <LibraryPickerButton
                orgId={orgId!}
                label="Library"
                testId="button-library-logo"
                onSelect={(url) => updateField('logoImageUrl', url)}
              />
              {site.logoImageUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => updateField('logoImageUrl', null)}
                  data-testid="button-clear-logo"
                  aria-label="Clear marketing logo"
                ><Trash2 className="w-4 h-4" /></Button>
              )}
            </div>
            {site.logoImageUrl && (
              <img
                src={site.logoImageUrl}
                alt="Marketing logo preview"
                className="mt-2 h-16 w-16 rounded border object-cover"
                data-testid="logo-preview"
              />
            )}
            <SourceRefreshStatus
              kind="logo"
              sourceUrl={site.logoSourceUrl}
              lastRefreshedAt={site.logoSourceLastRefreshedAt}
              lastRefreshError={site.logoSourceLastRefreshError}
              onClear={() => updateField('logoImageUrl', null)}
            />
          </div>
          <div>
            <Label>Favicon</Label>
            <p className="text-xs text-muted-foreground mb-1">
              Shown in the browser tab. PNG, ICO, or SVG work best — use a small
              square (e.g. 32×32 or 64×64) for sharpest rendering.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={site.faviconUrl ?? ''}
                onChange={e => updateField('faviconUrl', e.target.value || null)}
                placeholder="Upload an image or paste a URL (https://…/favicon.png)"
                data-testid="input-favicon-url"
              />
              <ImageUploadButton
                label="Upload"
                testId="button-upload-favicon"
                cropKind="gallery"
                accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico,.svg"
                onUpload={async (file) => {
                  const url = await uploadImage(file);
                  if (url) updateField('faviconUrl', url);
                }}
              />
              <LibraryPickerButton
                orgId={orgId!}
                label="Library"
                testId="button-library-favicon"
                onSelect={(url) => updateField('faviconUrl', url)}
              />
              {site.faviconUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => updateField('faviconUrl', null)}
                  data-testid="button-clear-favicon"
                  aria-label="Clear favicon"
                ><Trash2 className="w-4 h-4" /></Button>
              )}
            </div>
            {site.faviconUrl && (
              <img
                src={site.faviconUrl}
                alt="Favicon preview"
                className="mt-2 h-8 w-8 rounded border object-contain bg-white"
                data-testid="favicon-preview"
              />
            )}
            <SourceRefreshStatus
              kind="favicon"
              sourceUrl={site.faviconSourceUrl}
              lastRefreshedAt={site.faviconSourceLastRefreshedAt}
              lastRefreshError={site.faviconSourceLastRefreshError}
              onClear={() => updateField('faviconUrl', null)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hero</CardTitle>
          <CardDescription>Top-of-page banner, headline and call-to-action.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Hero image</Label>
            <div className="flex items-center gap-2">
              <Input value={site.heroImageUrl ?? ''} onChange={e => updateField('heroImageUrl', e.target.value)} placeholder="Upload an image or paste a URL (https://…)" data-testid="input-hero-image-url" />
              <ImageUploadButton
                label="Upload"
                testId="button-upload-hero"
                cropKind="hero"
                onUpload={async (file) => {
                  const url = await uploadImage(file);
                  if (url) updateField('heroImageUrl', url);
                }}
              />
              <LibraryPickerButton
                orgId={orgId!}
                label="Library"
                testId="button-library-hero"
                onSelect={(url) => updateField('heroImageUrl', url)}
              />
            </div>
            {site.heroImageUrl && (
              <img src={site.heroImageUrl} alt="" className="mt-2 max-h-32 rounded border object-cover" />
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><Label>Headline</Label>
              <Input value={site.heroTitle ?? ''} onChange={e => updateField('heroTitle', e.target.value)} /></div>
            <div><Label>Subtitle</Label>
              <Input value={site.heroSubtitle ?? ''} onChange={e => updateField('heroSubtitle', e.target.value)} /></div>
            <div><Label>CTA label</Label>
              <Input value={site.heroCtaLabel ?? ''} onChange={e => updateField('heroCtaLabel', e.target.value)} placeholder="Book a tee time" /></div>
            <div><Label>CTA URL</Label>
              <Input value={site.heroCtaHref ?? ''} onChange={e => updateField('heroCtaHref', e.target.value)} placeholder="/marketplace?org=…" /></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Copy</CardTitle>
          <CardDescription>About blurb and (optional) services description. Plain text or markdown.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div><Label>About</Label>
            <Textarea rows={5} value={site.aboutMarkdown ?? ''} onChange={e => updateField('aboutMarkdown', e.target.value)} /></div>
          <div><Label>Services & amenities</Label>
            <Textarea rows={4} value={site.servicesMarkdown ?? ''} onChange={e => updateField('servicesMarkdown', e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sections</CardTitle>
          <CardDescription>Toggle and reorder the sections that appear on the public site.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {orderedSections.map((id, i) => (
              <div key={id} className="flex items-center gap-3 border rounded p-2">
                <div className="flex flex-col">
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveSection(id, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="w-3 h-3" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveSection(id, 1)} disabled={i === orderedSections.length - 1} aria-label="Move down"><ArrowDown className="w-3 h-3" /></Button>
                </div>
                <div className="flex-1">
                  <div className="font-medium">{SECTION_LABELS[id] ?? id}</div>
                  <div className="text-xs text-muted-foreground">{id}</div>
                </div>
                <Switch checked={site.enabledSections[id] !== false} onCheckedChange={() => toggleSection(id)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gallery</CardTitle>
          <CardDescription>Upload photos or paste image URLs to show in the gallery section.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {site.galleryImages.map((g, i) => (
            <div key={i} className="flex items-center gap-2" data-testid={`gallery-row-${i}`}>
              {g.url ? (
                <img src={g.url} alt="" className="w-16 h-16 rounded border object-cover" />
              ) : (
                <div className="w-16 h-16 rounded border bg-muted flex items-center justify-center text-muted-foreground text-xs">no image</div>
              )}
              <Input className="flex-1" placeholder="Image URL" value={g.url} onChange={e => updateGalleryImage(i, 'url', e.target.value)} />
              <Input className="flex-1" placeholder="Caption (optional)" value={g.caption ?? ''} onChange={e => updateGalleryImage(i, 'caption', e.target.value)} />
              <ImageUploadButton
                label=""
                testId={`button-upload-gallery-${i}`}
                cropKind="gallery"
                onUpload={async (file) => {
                  const url = await uploadImage(file);
                  if (url) updateGalleryImage(i, 'url', url);
                }}
              />
              <LibraryPickerButton
                orgId={orgId!}
                label=""
                testId={`button-library-gallery-${i}`}
                onSelect={(url) => updateGalleryImage(i, 'url', url)}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeGalleryImage(i)} aria-label="Remove"><Trash2 className="w-4 h-4 text-destructive" /></Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={addGalleryImage}><Plus className="w-4 h-4 mr-1" />Add image</Button>
            <ImageUploadButton
              label="Upload new image"
              testId="button-upload-gallery-new"
              cropKind="gallery"
              onUpload={async (file) => {
                const url = await uploadImage(file);
                if (url) {
                  setSite(s => s ? { ...s, galleryImages: [...s.galleryImages, { url, caption: '' }] } : s);
                }
              }}
            />
            <LibraryPickerButton
              orgId={orgId!}
              label="Choose from library"
              testId="button-library-gallery-new"
              onSelect={(url) => {
                setSite(s => s ? { ...s, galleryImages: [...s.galleryImages, { url, caption: '' }] } : s);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SEO</CardTitle>
          <CardDescription>Page title, meta description and Open Graph image. Defaults are derived from your club details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div><Label>SEO title</Label>
            <Input value={site.seoTitle ?? ''} onChange={e => updateField('seoTitle', e.target.value)} /></div>
          <div><Label>Meta description</Label>
            <Textarea rows={3} value={site.seoDescription ?? ''} onChange={e => updateField('seoDescription', e.target.value)} /></div>
          <div>
            <Label>OG image</Label>
            <div className="flex items-center gap-2">
              <Input value={site.seoOgImageUrl ?? ''} onChange={e => updateField('seoOgImageUrl', e.target.value)} placeholder="Upload an image or paste a URL (https://…/og.jpg)" data-testid="input-og-image-url" />
              <ImageUploadButton
                label="Upload"
                testId="button-upload-og"
                cropKind="og"
                onUpload={async (file) => {
                  const url = await uploadImage(file);
                  if (url) updateField('seoOgImageUrl', url);
                }}
              />
              <LibraryPickerButton
                orgId={orgId!}
                label="Library"
                testId="button-library-og"
                onSelect={(url) => updateField('seoOgImageUrl', url)}
              />
            </div>
            {site.seoOgImageUrl && (
              <img src={site.seoOgImageUrl} alt="" className="mt-2 max-h-32 rounded border object-cover" />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Task #579 — Image library picker.
 *
 * Opens a dialog showing every previously uploaded marketing-site
 * image for the current club. Picking one passes its public URL back
 * to the caller without re-uploading anything. Admins can also
 * delete images from the library here to clear out unused photos.
 */
interface LibraryImageUsage {
  kind: string;
  label: string;
  /**
   * Task #900 — `data-testid` of an element on the same page that the
   * picker should scroll to and highlight when the admin clicks the
   * usage in the detail panel. Set for hero/og/logo/favicon/gallery.
   */
  targetTestId?: string;
  /**
   * Task #900 — Set when the editor section lives on a different admin
   * page (e.g. course pages live under /courses?courseId=…). Picker
   * navigates here instead of scrolling.
   */
  href?: string;
  courseId?: number;
}
interface LibraryImage {
  id: number;
  objectPath: string;
  url: string;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  /**
   * Task #749 — Spots on the public site that currently reference this
   * image (hero, OG, logo, favicon, gallery slot, course pages). Empty
   * array means the image is uploaded but unused.
   */
  usage: LibraryImageUsage[];
}

/**
 * Task #900 — When an admin clicks a usage row in the detail panel,
 * close the picker, scroll the target element into view, and briefly
 * pulse a ring around it so they can spot the field they're meant to
 * edit. Falls back gracefully when the element isn't on the page yet
 * (e.g. gallery row that has since been removed).
 */
function flashUsageTarget(testId: string) {
  // Wait a tick so the dialog has finished closing and the target
  // (which may have been hidden behind the modal scroll lock) is
  // measurable.
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const HIGHLIGHT = ['ring-2', 'ring-emerald-500', 'ring-offset-2', 'rounded'];
    el.classList.add(...HIGHLIGHT);
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    window.setTimeout(() => el.classList.remove(...HIGHLIGHT), 2000);
  }, 50);
}

function LibraryPickerButton({
  orgId, onSelect, label, testId,
}: {
  orgId: number;
  onSelect: (url: string) => void;
  label: string;
  testId?: string;
}) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  /**
   * Task #900 — When set, the picker shows a side detail panel for
   * this image listing every spot it's used, with deep links to the
   * editor section that uses it. Clicking the thumbnail again (or
   * picking a different one) updates this; the original "select this
   * image" action moves to the panel's primary CTA.
   */
  const [detailId, setDetailId] = useState<number | null>(null);

  /**
   * Task #1398 — When set, the picker shows a styled in-app confirm
   * dialog warning the admin that this image is still referenced on the
   * marketing site, with a clickable list of every spot. Replaces the
   * old plain-text window.confirm so the usage labels can be rendered
   * as links into the editor instead of bullet text.
   *
   * Task #1682 — The same dialog is also used for unused images (no
   * usage list rendered) so the delete experience is uniform whether
   * or not the image is referenced.
   */
  const [pendingDelete, setPendingDelete] = useState<LibraryImage | null>(null);

  async function loadLibrary() {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/library`), {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as LibraryImage[];
      setImages(j);
    } catch {
      toast({ title: 'Could not load image library', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void loadLibrary();
    else setDetailId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orgId]);

  /**
   * Task #900 — Jump straight to the editor section that uses the
   * image. Closes the picker first so the target isn't hidden behind
   * the modal, then either navigates (course pages) or scrolls/flashes
   * the same-page section.
   */
  function jumpToUsage(usage: LibraryImageUsage) {
    setOpen(false);
    if (usage.href) {
      setLocation(usage.href);
      return;
    }
    if (usage.targetTestId) {
      flashUsageTarget(usage.targetTestId);
    }
  }

  const detailImage = detailId === null
    ? null
    : images.find(i => i.id === detailId) ?? null;

  async function performDelete(id: number) {
    setDeletingId(id);
    try {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketing-site/library/${id}`), {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
      setImages(imgs => imgs.filter(i => i.id !== id));
    } catch {
      toast({ title: 'Could not delete image', variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  }

  function deleteImage(id: number) {
    const img = images.find(i => i.id === id);
    if (!img) return;
    // Task #1398 / Task #1682 — Always open the styled in-app confirm
    // dialog (instead of window.confirm) so the delete experience is
    // uniform. When the image is in use the dialog also renders every
    // affected spot as a clickable link into the editor section that
    // uses it; when the image is unused the dialog just confirms the
    // delete with no usage list.
    setPendingDelete(img);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={label ? 'default' : 'icon'}
        onClick={() => setOpen(true)}
        data-testid={testId}
        aria-label={label || 'Choose from library'}
      >
        <Library className={`w-4 h-4 ${label ? 'mr-1' : ''}`} />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={detailImage ? 'max-w-5xl' : 'max-w-3xl'}>
          <DialogHeader>
            <DialogTitle>Image library</DialogTitle>
            <DialogDescription>
              Reuse a photo you (or another admin) uploaded before — no need
              to re-upload. Click a thumbnail to see where it's used and
              jump straight to the editor section that references it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4" style={{
            gridTemplateColumns: detailImage ? 'minmax(0, 1fr) 320px' : '1fr',
          }}>
            <div className="min-h-[260px] max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
              </div>
            ) : images.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
                <ImageIcon className="w-8 h-8 mb-2 opacity-40" />
                No images uploaded yet. Use <strong className="mx-1">Upload</strong> to add one — it'll show up here next time.
              </div>
            ) : (
              <div
                className={`grid gap-3 ${detailImage
                  ? 'grid-cols-2 sm:grid-cols-3'
                  : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'}`}
                data-testid="library-grid"
              >
                {images.map(img => {
                  // Defensive: older API responses may omit `usage` —
                  // treat a missing array as "no known usage" rather
                  // than crashing the picker.
                  const usage = img.usage ?? [];
                  const inUse = usage.length > 0;
                  const usageTitle = inUse
                    ? `In use:\n${usage.map(u => `• ${u.label}`).join('\n')}`
                    : 'Not currently used on your site';
                  const isSelected = detailId === img.id;
                  return (
                  <div
                    key={img.id}
                    className={`group relative border rounded-md overflow-hidden bg-muted ${
                      isSelected ? 'ring-2 ring-emerald-500' : ''
                    }`}
                    data-testid={`library-image-${img.id}`}
                  >
                    {/*
                      Task #900 — Clicking the thumbnail now opens the
                      detail panel instead of immediately selecting the
                      image. The panel has a "Use this image" button to
                      perform the original select action, and a list of
                      every spot the image is used with deep-links into
                      the editor.
                    */}
                    <button
                      type="button"
                      onClick={() => setDetailId(img.id)}
                      className="block w-full aspect-square focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      aria-label="Show image details"
                      aria-pressed={isSelected}
                      data-testid={`library-select-${img.id}`}
                    >
                      <img
                        src={img.url}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover transition group-hover:scale-105"
                      />
                    </button>
                    {inUse && (
                      <Badge
                        variant="secondary"
                        className="absolute top-1 left-1 bg-emerald-600 text-white hover:bg-emerald-600 text-[10px] px-1.5 py-0 h-5"
                        title={usageTitle}
                        data-testid={`library-inuse-badge-${img.id}`}
                      >
                        <Check className="w-3 h-3 mr-0.5" />
                        In use{usage.length > 1 ? ` · ${usage.length}` : ''}
                      </Badge>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void deleteImage(img.id); }}
                      disabled={deletingId === img.id}
                      className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition disabled:opacity-100"
                      aria-label="Delete from library"
                      data-testid={`library-delete-${img.id}`}
                    >
                      {deletingId === img.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                    {inUse && (
                      <div
                        className="px-2 py-1 text-[10px] text-muted-foreground bg-background/90 border-t truncate"
                        title={usageTitle}
                        data-testid={`library-usage-${img.id}`}
                      >
                        {usage.map(u => u.label).join(', ')}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            </div>
            {detailImage && (
              <aside
                className="border rounded-md p-3 bg-muted/30 flex flex-col max-h-[60vh] overflow-y-auto"
                data-testid="library-detail-panel"
                aria-label="Image details"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-sm font-semibold">Image details</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 -mt-1 -mr-1"
                    onClick={() => setDetailId(null)}
                    aria-label="Close details"
                    data-testid="library-detail-close"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </div>
                <img
                  src={detailImage.url}
                  alt=""
                  className="w-full max-h-40 object-contain rounded border bg-background mb-3"
                />
                <Button
                  type="button"
                  className="mb-3 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={() => { onSelect(detailImage.url); setOpen(false); }}
                  data-testid={`library-use-${detailImage.id}`}
                >
                  <Check className="w-4 h-4 mr-1" /> Use this image
                </Button>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Used in {detailImage.usage.length === 0
                    ? 'no spots yet'
                    : `${detailImage.usage.length} ${detailImage.usage.length === 1 ? 'spot' : 'spots'}`}
                </div>
                {detailImage.usage.length === 0 ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="library-detail-empty"
                  >
                    This image isn't referenced anywhere on your marketing
                    site. It's safe to delete if you no longer need it.
                  </p>
                ) : (
                  <ul
                    className="space-y-1 text-sm"
                    data-testid="library-detail-usage-list"
                  >
                    {detailImage.usage.map((u, i) => (
                      <li key={`${u.kind}-${i}`}>
                        <button
                          type="button"
                          onClick={() => jumpToUsage(u)}
                          className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded border bg-background hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500"
                          data-testid={`library-detail-usage-${i}`}
                        >
                          <span className="truncate">{u.label}</span>
                          {u.href
                            ? <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />
                            : <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-60" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/*
        Task #1398 / Task #1682 — Styled in-app confirm for deleting a
        library image. Replaces window.confirm so the experience is
        uniform across in-use and unused images. When the image is still
        referenced on the site, the affected spots are rendered as a
        real list with deep-links into the editor section that uses the
        image; for unused images the dialog simply confirms the delete.
      */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
      >
        <AlertDialogContent data-testid="library-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this image?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && (pendingDelete.usage ?? []).length > 0
                ? 'This image is currently used on your site. Deleting it will leave the spots below without an image until you replace it.'
                : 'Remove this image from your library? This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDelete && (pendingDelete.usage ?? []).length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Used in {pendingDelete.usage.length} {pendingDelete.usage.length === 1 ? 'spot' : 'spots'}
              </div>
              <ul
                className="space-y-1 text-sm max-h-60 overflow-y-auto"
                data-testid="library-delete-confirm-usage-list"
              >
                {pendingDelete.usage.map((u, i) => (
                  <li key={`${u.kind}-${i}`}>
                    <button
                      type="button"
                      onClick={() => {
                        // Closing the confirm cancels the delete; jumping
                        // to the usage takes the admin straight to the
                        // editor section so they can fix it first.
                        setPendingDelete(null);
                        jumpToUsage(u);
                      }}
                      className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded border bg-background hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      data-testid={`library-delete-confirm-usage-${i}`}
                    >
                      <span className="truncate">{u.label}</span>
                      {u.href
                        ? <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />
                        : <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-60" />}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="library-delete-confirm-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = pendingDelete?.id;
                setPendingDelete(null);
                if (id !== undefined) void performDelete(id);
              }}
              data-testid="library-delete-confirm-confirm"
            >
              Delete image
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ImageUploadButton({
  onUpload, label, testId, cropKind, accept,
}: {
  onUpload: (file: File) => Promise<void>;
  label: string;
  testId?: string;
  /**
   * Task #578 — When set, the picked file is shown in a crop dialog and
   * the cropped/resized File is what gets passed to onUpload.
   */
  cropKind: CropKind;
  /**
   * Task #666 — Optional override for the file picker's accept list, so
   * favicon uploads can include ICO/SVG files that the API allows.
   */
  accept?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  function resetInput() {
    if (ref.current) ref.current.value = '';
  }

  async function runUpload(file: File) {
    setBusy(true);
    try { await onUpload(file); }
    finally {
      setBusy(false);
      resetInput();
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept ?? "image/jpeg,image/png,image/gif,image/webp"}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          // Animated GIFs cannot be cropped without losing animation, so
          // upload them as-is. All other supported types open the cropper.
          if (file.type === 'image/gif') {
            void runUpload(file);
          } else {
            setPendingFile(file);
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size={label ? 'default' : 'icon'}
        disabled={busy}
        onClick={() => ref.current?.click()}
        data-testid={testId}
        aria-label={label || 'Upload image'}
      >
        {busy
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Upload className={`w-4 h-4 ${label ? 'mr-1' : ''}`} />}
        {label}
      </Button>
      <ImageCropDialog
        open={pendingFile !== null}
        file={pendingFile}
        kind={cropKind}
        onCancel={() => { setPendingFile(null); resetInput(); }}
        onConfirm={async (cropped) => {
          setPendingFile(null);
          await runUpload(cropped);
        }}
      />
    </>
  );
}
