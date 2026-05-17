import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ChevronLeft, AlertTriangle, CheckCircle2, XCircle, Clock, Send, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

interface Correction {
  id: number;
  courseId: number;
  organizationId: number;
  holeNumber: number | null;
  fieldName: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string | null;
  status: 'open' | 'accepted' | 'rejected';
  reviewNotes: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface CourseRow { id: number; name: string }

const GOLD = '#C9A84C';

// Task #1174 — pre-fill the report form from a course/hole detail page deep
// link, e.g. `/portal/course-corrections?courseId=42&hole=7&field=par`. The
// `field` value should match one of the <option>s in the field <select>; if it
// doesn't we fall back to the existing default ('par') so the form stays
// usable. Hole numbers are clamped to 1–18 to avoid silently sending nonsense
// to the API. Once consumed, the params are stripped from the URL with
// `replace: true` so a refresh doesn't re-pin the same selection if the user
// has since changed it.
//
// Task #1351 — also accept `currentValue` so the linking page can pass
// whatever the user is staring at (e.g. "Par 4"), saving the moderator from
// the back-and-forth needed to figure out what was wrong before. We trim the
// value and cap its length so a stray pasted blob can't blow up the form
// state, and we don't whitelist contents — anything the player saw on screen
// is fair game (the moderator will sanity-check it anyway).
//
// Task #1615 — when the linking page provided a `currentValue`, seed the
// "Proposed value" input with that same value so the report turns into a
// one-tap edit instead of a re-type. The vast majority of corrections are a
// single digit change (par 4 → 5, yardage 380 → 385, etc.), and forcing the
// player to retype the whole value just so they can edit one character is the
// reason most reports never get filed. We only seed it on mount; once the
// player starts typing the suggestion is theirs to control.
const VALID_FIELD_NAMES = new Set([
  'par',
  'yardage',
  'handicap',
  'slope',
  'rating',
  'hole_name',
  'other',
]);

const MAX_CURRENT_VALUE_LEN = 120;

export default function PortalCourseCorrectionsPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();

  const [me, setMe] = useState<{ organizationId?: number } | null>(null);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [mine, setMine] = useState<Correction[]>([]);
  const [loading, setLoading] = useState(true);

  // Read pre-fill params eagerly so the form opens with the right values on
  // first paint (no flicker from default → prefilled).
  const initialParams = (() => {
    const params = new URLSearchParams(search);
    const rawCourseId = params.get('courseId') ?? '';
    const rawHole = params.get('hole') ?? '';
    const rawField = params.get('field') ?? '';
    const rawCurrent = params.get('currentValue') ?? '';
    const courseIdNum = Number(rawCourseId);
    const holeNum = Number(rawHole);
    const trimmedCurrent = rawCurrent.trim();
    return {
      courseId: rawCourseId && Number.isFinite(courseIdNum) && courseIdNum > 0 ? String(courseIdNum) : '',
      hole: rawHole && Number.isFinite(holeNum) && holeNum >= 1 && holeNum <= 18 ? String(holeNum) : '',
      field: rawField && VALID_FIELD_NAMES.has(rawField) ? rawField : '',
      currentValue: trimmedCurrent ? trimmedCurrent.slice(0, MAX_CURRENT_VALUE_LEN) : '',
    };
  })();

  const [courseId, setCourseId] = useState<string>(initialParams.courseId);
  const [holeNumber, setHoleNumber] = useState<string>(initialParams.hole);
  const [fieldName, setFieldName] = useState<string>(initialParams.field || 'par');
  const [currentValue, setCurrentValue] = useState<string>(initialParams.currentValue);
  // Task #1615 — seed the suggestion with the current value (when supplied)
  // so the player only edits the digit(s) they want to change, instead of
  // re-typing the value they just looked at on the previous page.
  const [proposedValue, setProposedValue] = useState<string>(initialParams.currentValue);
  const [reason, setReason] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [prefillNotice, setPrefillNotice] = useState<boolean>(
    Boolean(
      initialParams.courseId
        || initialParams.hole
        || initialParams.field
        || initialParams.currentValue,
    )
  );

  async function refresh() {
    setLoading(true);
    try {
      const meRes = await fetch('/api/portal/me', { credentials: 'include' });
      if (!meRes.ok) { navigate('/portal'); return; }
      const meData = await meRes.json();
      setMe(meData);
      const orgId = meData.organizationId;
      if (orgId) {
        const [coursesRes, mineRes] = await Promise.all([
          fetch(`/api/organizations/${orgId}/courses`, { credentials: 'include' }),
          fetch(`/api/portal/course-corrections/mine`, { credentials: 'include' }),
        ]);
        if (coursesRes.ok) {
          const cd = await coursesRes.json();
          setCourses(Array.isArray(cd) ? cd : (cd.courses ?? []));
        }
        if (mineRes.ok) {
          const md = await mineRes.json();
          setMine(Array.isArray(md) ? md : (md.corrections ?? []));
        }
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  // Strip the deep-link params from the URL once consumed, so a refresh or
  // back-navigation doesn't keep clobbering whatever the user has tweaked.
  useEffect(() => {
    if (!search) return;
    const params = new URLSearchParams(search);
    if (
      params.has('courseId')
      || params.has('hole')
      || params.has('field')
      || params.has('currentValue')
    ) {
      params.delete('courseId');
      params.delete('hole');
      params.delete('field');
      params.delete('currentValue');
      const qs = params.toString();
      navigate(`/portal/course-corrections${qs ? `?${qs}` : ''}`, { replace: true });
    }
    // Only run once on mount; we want the user's subsequent edits to win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (!me?.organizationId) { toast({ title: 'Not signed in', variant: 'destructive' }); return; }
    if (!courseId || !fieldName || !proposedValue.trim()) {
      toast({ title: 'Course, field name, and proposed value are required', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/course-corrections', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: Number(courseId),
          organizationId: me.organizationId,
          holeNumber: holeNumber ? Number(holeNumber) : null,
          fieldName,
          currentValue: currentValue || null,
          proposedValue,
          reason: reason || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Submission failed');
      toast({ title: 'Report submitted — your club will review it shortly.' });
      setHoleNumber(''); setCurrentValue(''); setProposedValue(''); setReason('');
      // Optimistically prepend the returned correction so the user sees status immediately
      if (data.correction) setMine(m => [data.correction, ...m]);
    } catch (e) {
      toast({ title: 'Could not submit', description: String((e as Error).message), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  const courseLabel = (id: number) => courses.find(c => c.id === id)?.name ?? `Course #${id}`;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal')} data-testid="button-back">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Report a Course Data Error</h1>
            <p className="text-white/50 text-sm">Spotted wrong par, yardage, slope, or hole info? Tell your club.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={refresh} data-testid="button-refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <Card className="bg-[#111827] border-[#1e2d3d] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold" style={{ color: GOLD }}>New Report</h2>
            {prefillNotice && (
              <span
                data-testid="prefill-notice"
                className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-0.5"
              >
                Pre-filled from the page you came from — adjust if needed.
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-white/60">Course</span>
              <select
                value={courseId}
                onChange={e => setCourseId(e.target.value)}
                data-testid="select-course"
                className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white"
              >
                <option value="">Select a course…</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-white/60">Hole # (optional)</span>
              <Input
                type="number"
                min={1}
                max={18}
                value={holeNumber}
                onChange={e => setHoleNumber(e.target.value)}
                placeholder="e.g. 7"
                data-testid="input-hole"
                className="bg-black/40 border-white/10 text-white"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-white/60">Field</span>
              <select
                value={fieldName}
                onChange={e => setFieldName(e.target.value)}
                data-testid="select-field"
                className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white"
              >
                <option value="par">Par</option>
                <option value="yardage">Yardage</option>
                <option value="handicap">Stroke index / handicap</option>
                <option value="slope">Slope</option>
                <option value="rating">Course rating</option>
                <option value="hole_name">Hole name</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-white/60">Current value (what you see)</span>
              <Input
                value={currentValue}
                onChange={e => setCurrentValue(e.target.value)}
                placeholder="e.g. 4"
                data-testid="input-current"
                className="bg-black/40 border-white/10 text-white"
              />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs text-white/60">Proposed value (what it should be)</span>
              <Input
                value={proposedValue}
                onChange={e => setProposedValue(e.target.value)}
                placeholder="e.g. 5"
                data-testid="input-proposed"
                className="bg-black/40 border-white/10 text-white"
              />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs text-white/60">Reason / context (optional)</span>
              <Textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                placeholder="Tell us what you saw and where (a photo of the scorecard helps)"
                data-testid="input-reason"
                className="bg-black/40 border-white/10 text-white"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={submit}
              disabled={submitting}
              data-testid="button-submit"
              style={{ backgroundColor: GOLD, color: '#000' }}
            >
              <Send className="w-4 h-4 mr-2" />
              {submitting ? 'Sending…' : 'Submit report'}
            </Button>
          </div>
        </Card>

        <Card className="bg-[#111827] border-[#1e2d3d] p-5">
          <h2 className="font-semibold mb-3" style={{ color: GOLD }}>My Reports</h2>
          {mine.length === 0 ? (
            <p className="text-sm text-white/50">You haven't submitted any reports yet.</p>
          ) : (
            <ul className="space-y-2">
              {mine.map(c => (
                <li
                  key={c.id}
                  data-testid={`correction-row-${c.id}`}
                  className="rounded-md border border-white/10 bg-black/30 p-3"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{courseLabel(c.courseId)}</span>
                      {c.holeNumber != null && (
                        <Badge variant="outline" className="border-white/20 text-white/70">
                          Hole {c.holeNumber}
                        </Badge>
                      )}
                      <Badge variant="outline" className="border-white/20 text-white/70">{c.fieldName}</Badge>
                    </div>
                    {c.status === 'accepted' && (
                      <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30">
                        <CheckCircle2 className="w-3 h-3 mr-1" /> Accepted
                      </Badge>
                    )}
                    {c.status === 'rejected' && (
                      <Badge className="bg-red-500/20 text-red-300 border-red-500/30">
                        <XCircle className="w-3 h-3 mr-1" /> Rejected
                      </Badge>
                    )}
                    {c.status === 'open' && (
                      <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30">
                        <Clock className="w-3 h-3 mr-1" /> Pending review
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-white/60 mt-1">
                    {c.currentValue ? <>Was <strong>{c.currentValue}</strong>, </> : null}
                    Suggested: <strong>{c.proposedValue}</strong>
                  </p>
                  {c.reason && <p className="text-xs text-white/50 mt-1">{c.reason}</p>}
                  {c.reviewNotes && (
                    <p className="text-xs text-blue-300 mt-1 flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 mt-0.5" />
                      Reviewer note: {c.reviewNotes}
                    </p>
                  )}
                  <p className="text-[10px] text-white/40 mt-1">
                    Submitted {new Date(c.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
