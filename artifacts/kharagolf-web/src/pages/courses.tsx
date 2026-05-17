import { useState, useCallback, useRef, useEffect } from 'react';
import { useGetMe, useListCourses, useCreateCourse } from '@workspace/api-client-react';
import { motion } from 'framer-motion';
import { Map, Plus, Search, X, Loader2, CheckCircle, ChevronRight, Globe, Edit2, Mountain, MapPin, AlertTriangle } from 'lucide-react';
import { Link, useSearch, useLocation } from 'wouter';
import { GreenContourDialog } from '@/components/GreenContourDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';

interface GolfApiSearchResult {
  id: number;
  club_name: string;
  course_name: string;
  location?: { address?: string; city?: string; state?: string; country?: string };
}

interface GhinCourseResult {
  id: string;
  name: string;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

interface CourseImport {
  externalCourseId: string;
  name: string;
  location: string | null;
  holes: number;
  par: number;
  rating: number | null;
  slope: number | null;
  yardage: number | null;
  holeDetails: Array<{
    holeNumber: number;
    par: number;
    handicap: number | null;
    yardageBlue: number | null;
    yardageWhite: number | null;
    yardageRed: number | null;
  }>;
  tees: Array<{ name: string; rating: number; slope: number; yardage: number }>;
}

interface CourseRow { id: number; name: string; location?: string | null; holes: number; par: number; rating?: string | null; slope?: number | null; yardage?: number | null; externalCourseId?: string | null; mapDefaultLat?: string | null; mapDefaultLng?: string | null; mapDefaultZoom?: number | null }

// Task #1558 — Format a remembered mapper centre as a short, human-readable
// "Located near 37.78°N, 122.42°W" string. We deliberately round to two
// decimals (~1km) so admins glancing at the courses list see a coarse
// neighbourhood, not a precise admin marker that could imply a specific
// hole tee box. Returns null when either coordinate is missing or unparsable
// so the caller can render nothing instead of "NaN°N, NaN°W".
// Exported for unit-testing — see `tests/courses-format-map-centre.test.ts`.
export function formatMapCentre(latRaw: string | null | undefined, lngRaw: string | null | undefined): string | null {
  if (latRaw == null || lngRaw == null) return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lng).toFixed(2)}°${ew}`;
}

export default function Courses() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  const { data: courses, isLoading } = useListCourses(orgId, { query: { enabled: !!orgId } });
  const [addOpen, setAddOpen] = useState(false);
  const [editCourse, setEditCourse] = useState<CourseRow | null>(null);
  const [contourCourse, setContourCourse] = useState<CourseRow | null>(null);
  const { toast } = useToast();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const handledCourseIdRef = useRef<string | null>(null);

  // Task #1046 — Deep link from the image library (`/courses?courseId=123`)
  // should auto-open the edit dialog for that course. Wait until the
  // courses list has loaded so we can resolve the id, then clear the
  // query param so re-navigating to the same link works again.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const raw = params.get('courseId');
    if (!raw) { handledCourseIdRef.current = null; return; }
    if (handledCourseIdRef.current === raw) return;
    if (isLoading || !courses) return;
    handledCourseIdRef.current = raw;
    const targetId = Number(raw);
    const match = Number.isFinite(targetId)
      ? (courses as CourseRow[]).find(c => c.id === targetId)
      : undefined;
    if (match) {
      setEditCourse(match);
    } else {
      toast({ title: 'Course not found', description: 'It may have been removed or belongs to another organization.', variant: 'destructive' });
    }
    params.delete('courseId');
    const qs = params.toString();
    setLocation(`/courses${qs ? `?${qs}` : ''}`, { replace: true });
  }, [search, courses, isLoading, toast, setLocation]);

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Course Database</h1>
          <p className="text-muted-foreground mt-1">Manage 18-hole data, pars, and yardages.</p>
        </div>
        <Button
          onClick={() => setAddOpen(true)}
          className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(34,197,94,0.2)]"
        >
          <Plus className="w-4 h-4 mr-2" /> Add Course
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3].map(i => <div key={i} className="h-48 glass-panel rounded-2xl animate-pulse" />)}
        </div>
      ) : courses?.length === 0 ? (
        <div className="text-center py-20 glass-panel rounded-3xl border-dashed">
          <Map className="w-16 h-16 text-muted-foreground opacity-30 mx-auto mb-4" />
          <h3 className="text-xl font-display text-white mb-2">No courses configured</h3>
          <p className="text-muted-foreground mb-6">Add a golf course to start running tournaments.</p>
          <Button onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="w-4 h-4 mr-2" /> Add First Course
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {courses?.map((course, i) => {
            const courseRow = course as CourseRow;
            const mapCentre = formatMapCentre(courseRow.mapDefaultLat, courseRow.mapDefaultLng);
            const mapCentreLat = mapCentre ? Number(courseRow.mapDefaultLat) : null;
            const mapCentreLng = mapCentre ? Number(courseRow.mapDefaultLng) : null;
            const mapCentreZoom = courseRow.mapDefaultZoom ?? 15;
            const osmHref = mapCentre
              ? `https://www.openstreetmap.org/?mlat=${mapCentreLat}&mlon=${mapCentreLng}#map=${mapCentreZoom}/${mapCentreLat}/${mapCentreLng}`
              : null;
            return (
            <motion.div key={course.id} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.1 }}>
              <Card className="glass-card group cursor-pointer overflow-hidden relative">
                <CardContent className="p-6">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500/20 to-blue-500/20 flex items-center justify-center border border-white/10 flex-shrink-0">
                      <Map className="w-6 h-6 text-white/80" />
                    </div>
                    {course.externalCourseId && (
                      <Badge variant="outline" className="text-xs text-primary border-primary/30 bg-primary/10 mt-1">
                        <Globe className="w-3 h-3 mr-1" /> Imported
                      </Badge>
                    )}
                    <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                      {isAdmin && (
                        <Link href={`/courses/${course.id}/mapper`}>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Open course mapper"
                            className="text-muted-foreground hover:text-primary h-8 w-8 p-0"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`button-mapper-${course.id}`}
                          >
                            <MapPin className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Green contour data"
                        className="text-muted-foreground hover:text-primary h-8 w-8 p-0"
                        onClick={(e) => { e.stopPropagation(); setContourCourse(course as CourseRow); }}
                      >
                        <Mountain className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Edit course"
                        className="text-muted-foreground hover:text-white h-8 w-8 p-0"
                        onClick={(e) => { e.stopPropagation(); setEditCourse(course as CourseRow); }}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <h3 className="text-xl font-bold text-white mb-1 group-hover:text-primary transition-colors">{course.name}</h3>
                  <p className="text-sm text-muted-foreground mb-1">{course.location || 'Location not specified'}</p>
                  {/*
                    Task #1558 — Surface the remembered mapper centre saved
                    by Task #1312 so non-mapper admins can tell at a glance
                    where a course is on the map. Renders as a small
                    "Located near …" line with a click-through to OSM, only
                    when the centre is set; otherwise we just show the text
                    address above. Stop propagation so clicking the link
                    doesn't also trigger the card's row-level edit handler.
                  */}
                  {mapCentre && osmHref ? (
                    <a
                      href={osmHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`link-map-centre-${course.id}`}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary mb-4"
                      title="Open on OpenStreetMap"
                    >
                      <MapPin className="w-3 h-3" /> Located near {mapCentre}
                    </a>
                  ) : (
                    <div className="mb-4" />
                  )}

                  {/*
                    Task #1174 — quick "Report an error" link so members and
                    admins viewing the course detail can launch the portal
                    correction form with the course already pre-filled, instead
                    of having to type the course id by hand.
                    Task #1351 — also pass the par the user is currently
                    looking at as `currentValue` so the moderator sees the
                    before/after side-by-side without having to re-derive what
                    the player saw on screen. Falls back to an empty string
                    when the row hasn't loaded a par yet (rare); empty values
                    are dropped by the portal form's trim/validate step.
                  */}
                  <a
                    href={`/portal/course-corrections?courseId=${course.id}&field=par&currentValue=${encodeURIComponent(String(course.par ?? ''))}`}
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`link-report-course-${course.id}`}
                    className="inline-flex items-center gap-1 text-[11px] text-amber-300/80 hover:text-amber-200 mb-4"
                  >
                    <AlertTriangle className="w-3 h-3" /> Report a course data error
                  </a>

                  <div className="grid grid-cols-3 gap-4 border-t border-white/10 pt-4 mt-auto">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Holes</p>
                      <p className="font-display font-semibold text-white">{course.holes}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Par</p>
                      <p className="font-display font-semibold text-white">{course.par}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                        {course.rating ? 'Rating' : 'Yardage'}
                      </p>
                      <p className="font-display font-semibold text-white">
                        {course.rating ? `${course.rating} / ${course.slope ?? '—'}` : (course.yardage || '—')}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
            );
          })}
        </div>
      )}

      <AddCourseDialog open={addOpen} onClose={() => setAddOpen(false)} orgId={orgId} />
      <AddCourseDialog open={!!editCourse} onClose={() => setEditCourse(null)} orgId={orgId} courseToEdit={editCourse} />
      <GreenContourDialog open={!!contourCourse} onClose={() => setContourCourse(null)} orgId={orgId} course={contourCourse} />
    </div>
  );
}

function AddCourseDialog({ open, onClose, orgId, courseToEdit }: { open: boolean; onClose: () => void; orgId: number; courseToEdit?: CourseRow | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEditing = !!courseToEdit;

  type HoleRow = { holeNumber: number; par: string; handicap: string; yardageBlue: string; yardageWhite: string; yardageRed: string; greenFrontLat: string; greenFrontLng: string; greenCentreLat: string; greenCentreLng: string; greenBackLat: string; greenBackLng: string };

  const makeDefaultHoles = (count: number): HoleRow[] =>
    Array.from({ length: count }, (_, i) => ({
      holeNumber: i + 1,
      par: '4',
      handicap: String(i + 1),
      yardageBlue: '',
      yardageWhite: '',
      yardageRed: '',
      greenFrontLat: '',
      greenFrontLng: '',
      greenCentreLat: '',
      greenCentreLng: '',
      greenBackLat: '',
      greenBackLng: '',
    }));

  // Form fields
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [holes, setHoles] = useState('18');
  const [par, setPar] = useState('72');
  const [yardage, setYardage] = useState('');
  const [rating, setRating] = useState('');
  const [slope, setSlope] = useState('');
  const [externalCourseId, setExternalCourseId] = useState<string | null>(null);
  const [holeDetailsForm, setHoleDetailsForm] = useState<HoleRow[] | null>(null);
  const [gpsVisible, setGpsVisible] = useState(false);

  // Lookup state
  const [searchQuery, setSearchQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [searchResults, setSearchResults] = useState<GolfApiSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState<number | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [lookupReady, setLookupReady] = useState<boolean | null>(null);
  const searchRef = useRef<NodeJS.Timeout | null>(null);

  // GHIN search state
  const [searchSource, setSearchSource] = useState<'golfcourseapi' | 'ghin'>('golfcourseapi');
  const [ghinSearchResults, setGhinSearchResults] = useState<GhinCourseResult[] | null>(null);
  const [ghinDetailLoading, setGhinDetailLoading] = useState<string | null>(null);

  // Pre-check that GOLF_COURSE_API_KEY is configured when the dialog opens
  useEffect(() => {
    if (!open || !orgId) return;
    fetch(`/api/organizations/${orgId}/courses/lookup/status`, { credentials: 'include' })
      .then(r => r.json())
      .then((d: { configured: boolean }) => setLookupReady(d.configured))
      .catch(() => setLookupReady(false));
  }, [open, orgId]);

  // Pre-populate form when editing an existing course
  useEffect(() => {
    if (!open || !courseToEdit) return;
    setName(courseToEdit.name);
    setLocation(courseToEdit.location ?? '');
    setHoles(String(courseToEdit.holes ?? 18));
    setPar(String(courseToEdit.par ?? 72));
    setRating(courseToEdit.rating ?? '');
    setSlope(String(courseToEdit.slope ?? ''));
    setYardage(String(courseToEdit.yardage ?? ''));
    setExternalCourseId(courseToEdit.externalCourseId ?? null);
    // Fetch existing hole data from course detail endpoint
    fetch(`/api/organizations/${orgId}/courses/${courseToEdit.id}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((data: { holeDetails?: Array<{ holeNumber: number; par: number; handicap?: number | null; yardageBlue?: number | null; yardageWhite?: number | null; yardageRed?: number | null }> } | null) => {
        const holes = data?.holeDetails;
        if (holes && holes.length > 0) {
          setHoleDetailsForm(holes.map(h => ({
            holeNumber: h.holeNumber,
            par: String(h.par),
            handicap: String(h.handicap ?? ''),
            yardageBlue: String(h.yardageBlue ?? ''),
            yardageWhite: String(h.yardageWhite ?? ''),
            yardageRed: String(h.yardageRed ?? ''),
            greenFrontLat: '', greenFrontLng: '',
            greenCentreLat: '', greenCentreLng: '',
            greenBackLat: '', greenBackLng: '',
          })));
        }
      })
      .catch(() => null);
  }, [open, courseToEdit, orgId]);

  const { mutate: createCourse, isPending } = useCreateCourse({
    mutation: {
      onSuccess: () => {
        toast({ title: `${name} added successfully!` });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/courses`] });
        resetAndClose();
      },
      onError: () => toast({ title: 'Failed to add course', variant: 'destructive' }),
    }
  });

  const resetAndClose = () => {
    setName(''); setLocation(''); setHoles('18'); setPar('72'); setYardage('');
    setRating(''); setSlope(''); setExternalCourseId(null); setHoleDetailsForm(null);
    setSearchQuery(''); setCountryFilter(''); setSearchResults(null); setSearchLoading(false);
    setDetailLoading(null); setNotConfigured(false); setGpsVisible(false); setLookupReady(null);
    setSearchSource('golfcourseapi'); setGhinSearchResults(null); setGhinDetailLoading(null);
    onClose();
  };

  const handleGhinSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.trim().length < 3) { setGhinSearchResults(null); return; }
    setSearchLoading(true);
    try {
      const params = new URLSearchParams({ q });
      if (countryFilter.trim()) params.set('country', countryFilter.trim());
      const res = await fetch(`/api/organizations/${orgId}/courses/lookup/ghin?${params.toString()}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'NO_CREDENTIALS') toast({ title: 'GHIN credentials not configured', variant: 'destructive' });
        else toast({ title: data.error ?? 'GHIN search failed', variant: 'destructive' });
        setGhinSearchResults(null);
      } else {
        setGhinSearchResults(data.courses ?? []);
      }
    } catch {
      toast({ title: 'Failed to search GHIN', variant: 'destructive' });
    } finally {
      setSearchLoading(false);
    }
  }, [orgId, toast, countryFilter]);

  const handleSelectGhinCourse = useCallback(async (result: GhinCourseResult) => {
    setGhinDetailLoading(result.id);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/lookup/ghin/detail/${result.id}`, { credentials: 'include' });
      const rawJson = await res.json() as CourseImport | { error: string };
      if (!res.ok) { toast({ title: (rawJson as { error: string }).error ?? 'Failed to fetch GHIN details', variant: 'destructive' }); return; }
      const data = rawJson as CourseImport;
      setName(data.name ?? '');
      setLocation(data.location ?? '');
      setHoles(String(data.holes ?? 18));
      setPar(String(data.par ?? 72));
      setYardage(data.yardage ? String(data.yardage) : '');
      setRating(data.rating ? String(data.rating) : '');
      setSlope(data.slope ? String(data.slope) : '');
      setExternalCourseId(data.externalCourseId);
      if (data.holeDetails?.length) {
        setHoleDetailsForm(data.holeDetails.map(h => ({
          holeNumber: h.holeNumber,
          par: String(h.par ?? 4),
          handicap: h.handicap != null ? String(h.handicap) : '',
          yardageBlue: h.yardageBlue != null ? String(h.yardageBlue) : '',
          yardageWhite: h.yardageWhite != null ? String(h.yardageWhite) : '',
          yardageRed: h.yardageRed != null ? String(h.yardageRed) : '',
          greenFrontLat: '', greenFrontLng: '',
          greenCentreLat: '', greenCentreLng: '',
          greenBackLat: '', greenBackLng: '',
        })));
      } else {
        setHoleDetailsForm(makeDefaultHoles(data.holes ?? 18));
      }
      setGhinSearchResults(null);
      setSearchQuery('');
      toast({ title: `GHIN data imported for ${data.name}` });
    } catch {
      toast({ title: 'Failed to load GHIN course details', variant: 'destructive' });
    } finally {
      setGhinDetailLoading(null);
    }
  }, [orgId, toast]);

  const updateHole = (holeNumber: number, field: keyof HoleRow, value: string) => {
    setHoleDetailsForm(prev => prev?.map(h => h.holeNumber === holeNumber ? { ...h, [field]: value } : h) ?? null);
  };

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.trim().length < 3) { setSearchResults(null); return; }
    setSearchLoading(true);
    setNotConfigured(false);
    try {
      const params = new URLSearchParams({ q });
      if (countryFilter.trim()) params.set('country', countryFilter.trim());
      const res = await fetch(`/api/organizations/${orgId}/courses/lookup?${params.toString()}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (data.notConfigured) { setNotConfigured(true); setSearchResults(null); }
      else if (res.ok) { setSearchResults(data.courses ?? []); }
      else { toast({ title: data.error ?? 'Search failed', variant: 'destructive' }); }
    } catch {
      toast({ title: 'Failed to search courses', variant: 'destructive' });
    } finally {
      setSearchLoading(false);
    }
  }, [orgId, toast, countryFilter]);

  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    if (searchRef.current) clearTimeout(searchRef.current);
    if (searchSource === 'ghin') {
      searchRef.current = setTimeout(() => handleGhinSearch(val), 600);
    } else {
      searchRef.current = setTimeout(() => handleSearch(val), 600);
    }
  };

  const handleSelectCourse = useCallback(async (result: GolfApiSearchResult) => {
    setDetailLoading(result.id);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/lookup/detail/${result.id}`, {
        credentials: 'include',
      });
      const rawJson = await res.json() as CourseImport | { error: string };
      if (!res.ok) { toast({ title: (rawJson as { error: string }).error ?? 'Failed to fetch course details', variant: 'destructive' }); return; }
      const data = rawJson as CourseImport;

      // Pre-fill all form fields
      setName(data.name ?? '');
      setLocation(data.location ?? '');
      setHoles(String(data.holes ?? 18));
      setPar(String(data.par ?? 72));
      setYardage(data.yardage ? String(data.yardage) : '');
      setRating(data.rating ? String(data.rating) : '');
      setSlope(data.slope ? String(data.slope) : '');
      setExternalCourseId(data.externalCourseId);
      if (data.holeDetails && data.holeDetails.length > 0) {
        setHoleDetailsForm(data.holeDetails.map(h => ({
          holeNumber: h.holeNumber,
          par: String(h.par ?? 4),
          handicap: h.handicap != null ? String(h.handicap) : '',
          yardageBlue: h.yardageBlue != null ? String(h.yardageBlue) : '',
          yardageWhite: h.yardageWhite != null ? String(h.yardageWhite) : '',
          yardageRed: h.yardageRed != null ? String(h.yardageRed) : '',
          greenFrontLat: '', greenFrontLng: '',
          greenCentreLat: '', greenCentreLng: '',
          greenBackLat: '', greenBackLng: '',
        })));
      } else {
        setHoleDetailsForm(makeDefaultHoles(data.holes ?? 18));
      }
      setSearchResults(null);
      setSearchQuery('');

      toast({ title: `Course data imported for ${data.name}` });
    } catch {
      toast({ title: 'Failed to load course details', variant: 'destructive' });
    } finally {
      setDetailLoading(null);
    }
  }, [orgId, toast]);

  const [isSaving, setIsSaving] = useState(false);

  const buildHoleDetails = () => holeDetailsForm?.map(h => ({
    holeNumber: h.holeNumber,
    par: parseInt(h.par) || 4,
    handicap: h.handicap !== '' ? parseInt(h.handicap) : undefined,
    yardageBlue: h.yardageBlue !== '' ? parseInt(h.yardageBlue) : undefined,
    yardageWhite: h.yardageWhite !== '' ? parseInt(h.yardageWhite) : undefined,
    yardageRed: h.yardageRed !== '' ? parseInt(h.yardageRed) : undefined,
    greenFrontLat: h.greenFrontLat !== '' ? h.greenFrontLat : undefined,
    greenFrontLng: h.greenFrontLng !== '' ? h.greenFrontLng : undefined,
    greenCentreLat: h.greenCentreLat !== '' ? h.greenCentreLat : undefined,
    greenCentreLng: h.greenCentreLng !== '' ? h.greenCentreLng : undefined,
    greenBackLat: h.greenBackLat !== '' ? h.greenBackLat : undefined,
    greenBackLng: h.greenBackLng !== '' ? h.greenBackLng : undefined,
  }));

  const handleCreate = () => {
    if (!name.trim()) { toast({ title: 'Course name is required', variant: 'destructive' }); return; }
    if (isEditing && courseToEdit) {
      setIsSaving(true);
      fetch(`/api/organizations/${orgId}/courses/${courseToEdit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim() || undefined,
          holes: parseInt(holes) || 18,
          par: parseInt(par) || 72,
          yardage: yardage ? parseInt(yardage) : undefined,
          rating: rating ? parseFloat(rating) : undefined,
          slope: slope ? parseInt(slope) : undefined,
          externalCourseId: externalCourseId ?? undefined,
          holeDetails: buildHoleDetails() ?? undefined,
        }),
      })
        .then(async r => {
          if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? 'Update failed'); }
          toast({ title: 'Course updated successfully' });
          queryClient.invalidateQueries({ queryKey: ['listCourses', orgId] });
          resetAndClose();
        })
        .catch(e => toast({ title: e.message, variant: 'destructive' }))
        .finally(() => setIsSaving(false));
      return;
    }
    createCourse({
      orgId,
      data: {
        name: name.trim(),
        location: location.trim() || undefined,
        holes: parseInt(holes) || 18,
        par: parseInt(par) || 72,
        yardage: yardage ? parseInt(yardage) : undefined,
        rating: rating ? parseFloat(rating) : undefined,
        slope: slope ? parseInt(slope) : undefined,
        externalCourseId: externalCourseId ?? undefined,
        holeDetails: buildHoleDetails() ?? undefined,
      },
    });
  };

  const isImported = !!externalCourseId;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && resetAndClose()}>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
            <Map className="w-5 h-5 text-primary" /> {isEditing ? 'Edit Golf Course' : 'Add Golf Course'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* ── Course Lookup ─────────────────────────────── */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-white">Look up from database</span>
              {lookupReady === true && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 font-semibold">API Active</span>
              )}
            </div>

            {/* Source toggle */}
            {!isImported && (
              <div className="flex gap-1 bg-black/30 rounded-lg p-1">
                <button
                  onClick={() => { setSearchSource('golfcourseapi'); setGhinSearchResults(null); setSearchQuery(''); setSearchResults(null); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition-all ${searchSource === 'golfcourseapi' ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}
                >
                  <Globe className="w-3 h-3" /> GolfCourseAPI
                </button>
                <button
                  onClick={() => { setSearchSource('ghin'); setSearchResults(null); setSearchQuery(''); setGhinSearchResults(null); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition-all ${searchSource === 'ghin' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-white'}`}
                >
                  <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 border text-[10px] px-1 py-0 rounded">GHIN</Badge> USGA GHIN
                </button>
              </div>
            )}

            {isImported ? (
              <div className="flex items-center gap-2 text-sm text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                <span>Course data imported — fields pre-filled below. You can still edit anything.</span>
                <button
                  onClick={() => { setExternalCourseId(null); setHoleDetailsForm(null); }}
                  className="ml-auto text-muted-foreground hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={e => handleSearchInput(e.target.value)}
                    placeholder={searchSource === 'ghin' ? 'Search GHIN course database…' : 'Search by course or club name…'}
                    className="bg-black/50 border-white/10 text-white pl-9 pr-9"
                  />
                  {searchLoading && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                  )}
                  {searchQuery && !searchLoading && (
                    <button
                      onClick={() => { setSearchQuery(''); setSearchResults(null); setGhinSearchResults(null); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <Input
                  value={countryFilter}
                  onChange={e => setCountryFilter(e.target.value)}
                  placeholder="Country (optional, e.g. ZA, US, GB)"
                  className="bg-black/50 border-white/10 text-white text-xs h-8"
                />

                {notConfigured && searchSource === 'golfcourseapi' && (
                  <div className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                    GolfCourseAPI requires a <strong>GOLF_COURSE_API_KEY</strong>. Sign up free at{' '}
                    <a href="https://golfcourseapi.com" target="_blank" rel="noopener noreferrer" className="underline">golfcourseapi.com</a>.
                    Or switch to GHIN above, or enter course details manually below.
                  </div>
                )}

                {/* GolfCourseAPI results */}
                {searchSource === 'golfcourseapi' && searchResults !== null && (
                  <div className="space-y-1 max-h-52 overflow-y-auto">
                    {searchResults.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-3">No courses found. Enter details manually below.</p>
                    ) : searchResults.map(r => {
                      const loc = [r.location?.city, r.location?.state, r.location?.country].filter(Boolean).join(', ');
                      const isLoading = detailLoading === r.id;
                      return (
                        <button
                          key={r.id}
                          onClick={() => handleSelectCourse(r)}
                          disabled={detailLoading !== null}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-black/30 hover:bg-primary/10 border border-white/5 hover:border-primary/30 text-left transition-colors group"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate group-hover:text-primary transition-colors">{r.course_name || r.club_name}</p>
                            {loc && <p className="text-xs text-muted-foreground">{loc}</p>}
                          </div>
                          {isLoading
                            ? <Loader2 className="w-4 h-4 text-muted-foreground animate-spin flex-shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 group-hover:text-primary" />
                          }
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* GHIN results */}
                {searchSource === 'ghin' && ghinSearchResults !== null && (
                  <div className="space-y-1 max-h-52 overflow-y-auto">
                    {ghinSearchResults.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-3">No GHIN courses found. Try a different search.</p>
                    ) : ghinSearchResults.map(r => {
                      const loc = [r.city, r.state, r.country].filter(Boolean).join(', ');
                      const isLoading = ghinDetailLoading === r.id;
                      return (
                        <button
                          key={r.id}
                          onClick={() => handleSelectGhinCourse(r)}
                          disabled={ghinDetailLoading !== null}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-black/30 hover:bg-blue-500/10 border border-white/5 hover:border-blue-500/30 text-left transition-colors group"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-white truncate group-hover:text-blue-300 transition-colors">{r.name}</p>
                              <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 border text-[10px] px-1 py-0 shrink-0">GHIN</Badge>
                            </div>
                            {loc && <p className="text-xs text-muted-foreground">{loc}</p>}
                          </div>
                          {isLoading
                            ? <Loader2 className="w-4 h-4 text-muted-foreground animate-spin flex-shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 group-hover:text-blue-400" />
                          }
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Manual form ───────────────────────────────── */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Course Name *</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pebble Beach Golf Links" className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Location</label>
            <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Pebble Beach, CA" className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Holes</label>
              <Select value={holes} onValueChange={setHoles}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  <SelectItem value="9">9 Holes</SelectItem>
                  <SelectItem value="18">18 Holes</SelectItem>
                  <SelectItem value="27">27 Holes</SelectItem>
                  <SelectItem value="36">36 Holes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Course Par</label>
              <Input type="number" value={par} onChange={e => setPar(e.target.value)} min={27} max={80} className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Yardage</label>
              <Input type="number" value={yardage} onChange={e => setYardage(e.target.value)} placeholder="6800" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Course Rating</label>
              <Input type="number" value={rating} onChange={e => setRating(e.target.value)} placeholder="72.4" step="0.1" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Slope</label>
              <Input type="number" value={slope} onChange={e => setSlope(e.target.value)} placeholder="133" min={55} max={155} className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          {/* ── Hole-by-Hole Data ─────────────────────────── */}
          {holeDetailsForm ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-primary uppercase tracking-wider">
                  Hole Data — {holeDetailsForm.length} holes (all fields editable)
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setGpsVisible(v => !v)}
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                  >
                    <span className="text-base">📍</span> {gpsVisible ? 'Hide GPS' : 'Add GPS Coords'}
                  </button>
                  <button
                    onClick={() => setHoleDetailsForm(null)}
                    className="text-xs text-muted-foreground hover:text-white"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {/* Compact editable grid: hole per row */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left pb-1 pr-1 w-6">H</th>
                      <th className="text-center pb-1 px-1">Par</th>
                      <th className="text-center pb-1 px-1">HCP</th>
                      <th className="text-center pb-1 px-1">Blue</th>
                      <th className="text-center pb-1 px-1">White</th>
                      <th className="text-center pb-1 px-1">Red</th>
                      {gpsVisible && <>
                        <th className="text-center pb-1 px-1 text-blue-400">Front Lat</th>
                        <th className="text-center pb-1 px-1 text-blue-400">Front Lng</th>
                        <th className="text-center pb-1 px-1 text-primary">Centre Lat</th>
                        <th className="text-center pb-1 px-1 text-primary">Centre Lng</th>
                        <th className="text-center pb-1 px-1 text-orange-400">Back Lat</th>
                        <th className="text-center pb-1 px-1 text-orange-400">Back Lng</th>
                      </>}
                      {/* Task #1174 — per-hole "Report" deep link column */}
                      {courseToEdit && <th className="text-center pb-1 px-1 w-8" aria-label="Report"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {holeDetailsForm.map(h => (
                      <tr key={h.holeNumber} className="border-t border-white/5">
                        <td className="py-0.5 pr-1 text-muted-foreground font-medium">{h.holeNumber}</td>
                        {(['par', 'handicap', 'yardageBlue', 'yardageWhite', 'yardageRed'] as const).map(field => (
                          <td key={field} className="py-0.5 px-1">
                            <input
                              type="number"
                              value={h[field]}
                              onChange={e => updateHole(h.holeNumber, field, e.target.value)}
                              min={field === 'par' ? 3 : 1}
                              max={field === 'par' ? 6 : 999}
                              placeholder={field === 'par' ? '4' : '—'}
                              className="w-full bg-black/40 border border-white/10 rounded text-white text-center text-xs px-1 py-0.5 focus:outline-none focus:border-primary/50"
                              style={{ minWidth: field === 'par' || field === 'handicap' ? 36 : 48 }}
                            />
                          </td>
                        ))}
                        {gpsVisible && (['greenFrontLat', 'greenFrontLng', 'greenCentreLat', 'greenCentreLng', 'greenBackLat', 'greenBackLng'] as const).map(field => (
                          <td key={field} className="py-0.5 px-1">
                            <input
                              type="text"
                              value={h[field]}
                              onChange={e => updateHole(h.holeNumber, field, e.target.value)}
                              placeholder={field.endsWith('Lat') ? '28.6139' : '77.2090'}
                              className="w-full bg-black/40 border border-white/10 rounded text-white text-center text-xs px-1 py-0.5 focus:outline-none focus:border-primary/50"
                              style={{ minWidth: 72 }}
                            />
                          </td>
                        ))}
                        {/*
                          Task #1174 — only show the per-hole report link when
                          editing an existing course (during create the course
                          id doesn't exist yet so the deep link can't be built).
                          Default the field param to `par` since that's the
                          most common correction; the portal form lets the
                          reporter switch fields before submitting.
                          Task #1351 — pass the per-hole par the editor is
                          looking at as `currentValue` so the moderator can
                          confirm the before/after at a glance. `h.par` is a
                          string in the form state, so we pass it through as-is
                          after URI-encoding.
                        */}
                        {courseToEdit && (
                          <td className="py-0.5 px-1 text-center">
                            <a
                              href={`/portal/course-corrections?courseId=${courseToEdit.id}&hole=${h.holeNumber}&field=par&currentValue=${encodeURIComponent(h.par ?? '')}`}
                              title={`Report an error on hole ${h.holeNumber}`}
                              data-testid={`link-report-hole-${h.holeNumber}`}
                              className="inline-flex items-center justify-center text-amber-300/70 hover:text-amber-200"
                            >
                              <AlertTriangle className="w-3 h-3" />
                            </a>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {gpsVisible && (
                <p className="text-xs text-muted-foreground">
                  GPS coordinates for the front, centre, and back of each green. Used for distance-to-pin calculations on the mobile app.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                No hole data — will be auto-generated on save. Import a course above or add manually.
              </p>
              <button
                onClick={() => setHoleDetailsForm(makeDefaultHoles(parseInt(holes) || 18))}
                className="text-xs text-primary hover:underline ml-3 flex-shrink-0"
              >
                Add hole data
              </button>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="ghost" onClick={resetAndClose} className="hover:bg-white/5 text-white">Cancel</Button>
            <Button onClick={handleCreate} disabled={isPending || isSaving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {(isPending || isSaving) ? (isEditing ? 'Saving...' : 'Creating...') : (isEditing ? 'Save Changes' : 'Create Course')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
