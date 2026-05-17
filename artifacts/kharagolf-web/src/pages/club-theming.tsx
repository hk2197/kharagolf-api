import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Loader2, Palette, Save, Trash2, Upload } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

interface Theme {
  primaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
}

const EMPTY: Theme = { primaryColor: '', accentColor: '', fontFamily: '', logoUrl: '', faviconUrl: '' };

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(value: string, fallback = '#000000'): string {
  const v = (value || '').trim();
  if (HEX_RE.test(v)) {
    if (v.length === 4) {
      // expand #abc → #aabbcc for native color input compatibility
      return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
    }
    return v.toLowerCase();
  }
  return fallback;
}

export default function ClubThemingPage() {
  const { toast } = useToast();
  const activeOrgId = useActiveOrgId();
  const [theme, setTheme] = useState<Theme>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<null | 'logo' | 'favicon'>(null);

  useEffect(() => {
    if (!activeOrgId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/organizations/${activeOrgId}/theming`, { credentials: 'include' })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ theme: Theme | null }>;
      })
      .then(d => {
        if (cancelled) return;
        const t = d.theme ?? EMPTY;
        setTheme({
          primaryColor: t.primaryColor ?? '',
          accentColor: t.accentColor ?? '',
          fontFamily: t.fontFamily ?? '',
          logoUrl: t.logoUrl ?? '',
          faviconUrl: t.faviconUrl ?? '',
        });
      })
      .catch(e => toast({ title: 'Could not load theme', description: e instanceof Error ? e.message : '', variant: 'destructive' }))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeOrgId, toast]);

  const save = async () => {
    if (!activeOrgId) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/organizations/${activeOrgId}/theming`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryColor: theme.primaryColor || null,
          accentColor: theme.accentColor || null,
          fontFamily: theme.fontFamily || null,
          logoUrl: theme.logoUrl || null,
          faviconUrl: theme.faviconUrl || null,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      toast({ title: 'Theme saved', description: 'Your club theme has been updated.' });
    } catch (e) {
      toast({ title: 'Could not save theme', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  async function uploadImage(file: File, kind: 'logo' | 'favicon'): Promise<string | null> {
    if (!activeOrgId) return null;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Please choose an image file', variant: 'destructive' });
      return null;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'Image is too large (max 5 MB)', variant: 'destructive' });
      return null;
    }
    setUploadingKind(kind);
    try {
      const tokenRes = await fetch(`/api/organizations/${activeOrgId}/theming/upload-url`, {
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

      const regRes = await fetch(`/api/organizations/${activeOrgId}/theming/images`, {
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
    } finally {
      setUploadingKind(null);
    }
  }

  if (!activeOrgId) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-muted-foreground">Select a club to manage theming.</p>
      </div>
    );
  }

  const previewPrimary = normalizeHex(theme.primaryColor ?? '', '#0b3d2a');
  const previewAccent = normalizeHex(theme.accentColor ?? '', '#c9a84c');

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6" data-testid="page-club-theming">
      <div className="flex items-center gap-2">
        <Palette className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-display font-bold text-white">Club theming</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Customize colors, fonts, and logos that apply to your club&apos;s portal experience.
      </p>

      <Card className="glass-panel border-white/10 p-6 space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <ColorField
              label="Primary color"
              value={theme.primaryColor ?? ''}
              fallback="#0b3d2a"
              onChange={v => setTheme(t => ({ ...t, primaryColor: v }))}
              testId="input-primary-color"
            />
            <ColorField
              label="Accent color"
              value={theme.accentColor ?? ''}
              fallback="#c9a84c"
              onChange={v => setTheme(t => ({ ...t, accentColor: v }))}
              testId="input-accent-color"
            />

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Font family</label>
              <Input
                value={theme.fontFamily ?? ''}
                placeholder="Inter, sans-serif"
                onChange={e => setTheme(t => ({ ...t, fontFamily: e.target.value }))}
                data-testid="input-font-family"
              />
            </div>

            <ImageUploadField
              label="Logo"
              value={theme.logoUrl ?? ''}
              onChange={v => setTheme(t => ({ ...t, logoUrl: v }))}
              uploading={uploadingKind === 'logo'}
              onPickFile={(f) => uploadImage(f, 'logo').then(url => { if (url) setTheme(t => ({ ...t, logoUrl: url })); })}
              testIdInput="input-logo-url"
              testIdButton="button-upload-logo"
              testIdRemove="button-remove-logo"
            />
            <ImageUploadField
              label="Favicon"
              value={theme.faviconUrl ?? ''}
              onChange={v => setTheme(t => ({ ...t, faviconUrl: v }))}
              uploading={uploadingKind === 'favicon'}
              onPickFile={(f) => uploadImage(f, 'favicon').then(url => { if (url) setTheme(t => ({ ...t, faviconUrl: url })); })}
              testIdInput="input-favicon-url"
              testIdButton="button-upload-favicon"
              testIdRemove="button-remove-favicon"
              accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/jpeg,image/webp"
            />

            <ThemePreview
              primaryColor={previewPrimary}
              accentColor={previewAccent}
              fontFamily={theme.fontFamily ?? ''}
              logoUrl={theme.logoUrl ?? ''}
            />

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving} data-testid="button-save-theme">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                Save theme
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function ColorField({
  label, value, fallback, onChange, testId,
}: {
  label: string; value: string; fallback: string;
  onChange: (v: string) => void; testId?: string;
}) {
  const colorValue = normalizeHex(value, fallback);
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={colorValue}
          onChange={e => onChange(e.target.value)}
          className="h-10 w-14 cursor-pointer rounded border border-white/10 bg-transparent p-0.5"
          aria-label={`${label} picker`}
          data-testid={`${testId}-picker`}
        />
        <Input
          value={value}
          placeholder={fallback}
          onChange={e => onChange(e.target.value)}
          className="flex-1 font-mono uppercase"
          data-testid={testId}
          maxLength={7}
        />
        <span
          className="h-10 w-10 rounded border border-white/10"
          style={{ backgroundColor: colorValue }}
          aria-hidden
          data-testid={`${testId}-swatch`}
        />
      </div>
      {value && !HEX_RE.test(value.trim()) && (
        <p className="text-xs text-amber-400">Enter a hex color like #0b3d2a (preview uses default).</p>
      )}
    </div>
  );
}

function ImageUploadField({
  label, value, onChange, uploading, onPickFile,
  testIdInput, testIdButton, testIdRemove,
  accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  uploading: boolean;
  onPickFile: (f: File) => void;
  testIdInput?: string;
  testIdButton?: string;
  testIdRemove?: string;
  accept?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-white/10 bg-black/20 overflow-hidden">
          {value ? (
            <img src={value} alt="" className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
          )}
        </div>
        <Input
          value={value}
          placeholder="https://… or upload below"
          onChange={e => onChange(e.target.value)}
          className="flex-1"
          data-testid={testIdInput}
        />
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) onPickFile(f);
            // reset so the same file can be re-selected
            if (inputRef.current) inputRef.current.value = '';
          }}
          data-testid={`${testIdInput}-file`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          data-testid={testIdButton}
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span className="ml-1">Upload</span>
        </Button>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange('')}
            disabled={uploading}
            data-testid={testIdRemove}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ThemePreview({
  primaryColor, accentColor, fontFamily, logoUrl,
}: {
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string;
}) {
  return (
    <div
      className="rounded-lg border border-white/10 bg-black/20 p-4 space-y-3"
      data-testid="theme-preview"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Live preview</div>
      <div
        className="flex items-center gap-3 rounded-md p-3"
        style={{ backgroundColor: primaryColor, fontFamily: fontFamily || undefined }}
      >
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain bg-white/10" />
        ) : (
          <div className="h-8 w-8 rounded bg-white/10" />
        )}
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">Your club, in your colors</div>
          <div className="text-xs text-white/70">Primary surface uses your primary color.</div>
        </div>
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-xs font-semibold text-black"
          style={{ backgroundColor: accentColor }}
          data-testid="preview-accent-button"
        >
          Action
        </button>
      </div>
    </div>
  );
}
