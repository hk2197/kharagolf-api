import { useState, useEffect } from 'react';
import { useGetMe, useListTournaments, useCreateTournament, getListTournamentsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Link } from 'wouter';
import { Plus, Search, Calendar, Users, MapPin, MoreVertical, Trophy, BookTemplate, Trash2, FileOutput, Pencil, X, Check, Briefcase, Heart, MessageSquareWarning, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

interface TournamentTemplate {
  id: number; name: string; description: string | null;
  format: string; rounds: number; handicapAllowance: number;
  maxPlayers: number | null; entryFee: string | null; currency: string;
  selfPosting: boolean; markerValidation: boolean;
  tiebreakerMethod: string; leaderboardType: string;
  createdAt: string;
}

// Task #2009 — one summary row per tournament that has a sent post-event
// survey. Tournaments without a sent survey are not returned by the
// `/organizations/:orgId/survey-response-summaries` endpoint.
interface SurveySummary {
  tournamentId: number;
  totalResponses: number;
  eligiblePlayers: number;
  sentAt: string | null;
}

// Task #2009 — engagement threshold below which the survey badge flips
// from neutral to a warning colour. 25% mirrors the example in the
// task brief and matches the "<= bottom quartile" intuition admins
// use elsewhere in the product.
const LOW_SURVEY_RESPONSE_THRESHOLD = 0.25;

const CURRENCIES = [
  { code: 'INR', label: '₹ INR — Indian Rupee' },
  { code: 'USD', label: '$ USD — US Dollar' },
  { code: 'GBP', label: '£ GBP — British Pound' },
  { code: 'EUR', label: '€ EUR — Euro' },
  { code: 'AED', label: 'د.إ AED — UAE Dirham' },
  { code: 'SGD', label: 'S$ SGD — Singapore Dollar' },
  { code: 'AUD', label: 'A$ AUD — Australian Dollar' },
];

const FORMAT_DESC: Record<string, string> = {
  stroke_play: 'Players count every stroke. Lowest total score wins.',
  net_stroke: 'Stroke play with handicap-adjusted net scores.',
  stableford: 'Points awarded per hole (WHS: Eagle 4, Birdie 3, Par 2, Bogey 1). Most points wins.',
  team_stableford: 'Team format — best N players\' Stableford points per hole aggregate for the team.',
  maximum_score: 'Stroke play with a per-hole cap (par + cap). Prevents runaway scores on difficult holes.',
  par_bogey: 'Hole-by-hole: W (net under par), L (net over par), H (net = par). Most wins takes the card.',
  best_ball: 'Each player plays their own ball; team takes the best score on each hole.',
  scramble: 'All players tee off; team selects best shot and all play from there.',
  shamble: 'Scramble off the tee, then each player completes the hole individually.',
  match_play: 'Head-to-head: win each hole to win the match.',
  skins: 'Each hole has a value; win the hole outright to win that skin.',
};

const CUT_POSITIONS = [
  { value: 'top50_ties', label: 'Low 50 + Ties' },
  { value: 'top65_ties', label: 'Low 65 + Ties' },
  { value: 'top70_ties', label: 'Low 70 + Ties' },
  { value: 'top50', label: 'Exactly Top 50' },
  { value: 'top65', label: 'Exactly Top 65' },
  { value: 'top70', label: 'Exactly Top 70' },
];

export default function Tournaments() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'active' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<TournamentTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TournamentTemplate | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState('');
  const [editingTemplateDesc, setEditingTemplateDesc] = useState('');
  const { toast } = useToast();
  
  const { data: tournaments, isLoading } = useListTournaments(orgId, {}, { query: { enabled: !!orgId, queryKey: getListTournamentsQueryKey(orgId) } });

  // Task #2009 — fetch survey-response summaries for every tournament in
  // the org so each card can show a "12 / 48 — 25%" badge and flag
  // tournaments below the low-engagement threshold without N+1 calls.
  const [surveySummaries, setSurveySummaries] = useState<Map<number, SurveySummary>>(new Map());
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    fetch(`/api/organizations/${orgId}/survey-response-summaries`)
      .then(r => r.ok ? r.json() as Promise<SurveySummary[]> : [])
      .then((rows: SurveySummary[]) => {
        if (cancelled) return;
        setSurveySummaries(new Map(rows.map(r => [r.tournamentId, r])));
      })
      .catch(() => { /* silent — the badge just won't render */ });
    return () => { cancelled = true; };
    // Only re-fetch when the org changes; the tournament list updates often
    // (filter/search) and the summaries don't change with those — refetching
    // on every list-data identity change would cause unnecessary requests.
  }, [orgId]);

  useEffect(() => {
    if (!orgId || !showTemplates) return;
    setTemplatesLoading(true);
    fetch(`/api/organizations/${orgId}/tournament-templates`)
      .then(r => r.ok ? r.json() : [])
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  }, [orgId, showTemplates]);

  async function deleteTemplate(id: number) {
    await fetch(`/api/organizations/${orgId}/tournament-templates/${id}`, { method: 'DELETE' });
    setTemplates(prev => prev.filter(t => t.id !== id));
    toast({ title: 'Template deleted' });
  }

  async function saveTemplateEdit(id: number) {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournament-templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingTemplateName, description: editingTemplateDesc || null }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t));
      setEditingTemplateId(null);
      toast({ title: 'Template updated' });
    } catch {
      toast({ title: 'Failed to update template', variant: 'destructive' });
    }
  }
  
  const filteredTournaments = tournaments?.filter(t => {
    if (filter !== 'all' && t.status !== filter) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }) || [];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active': return <Badge className="bg-primary/20 text-primary border-primary/50 animate-pulse">LIVE</Badge>;
      case 'upcoming': return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">UPCOMING</Badge>;
      case 'completed': return <Badge className="bg-slate-500/20 text-slate-300 border-slate-500/30">COMPLETED</Badge>;
      case 'draft': return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">DRAFT</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getFormatDisplay = (format: string) => format.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Tournaments</h1>
          <p className="text-muted-foreground mt-1">Manage events, leagues, and outings.</p>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowTemplates(v => !v)}
            className="border-white/10 text-gray-300 hover:text-white hover:bg-white/5"
          >
            <BookTemplate className="w-4 h-4 mr-2" />
            Templates {templates.length > 0 && !showTemplates ? `(${templates.length})` : ""}
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(34,197,94,0.3)] hover:shadow-[0_0_30px_rgba(34,197,94,0.5)] transition-all">
                <Plus className="w-4 h-4 mr-2" /> New Tournament
              </Button>
            </DialogTrigger>
            <DialogContent className="glass-panel border-white/10 sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle className="text-2xl font-display text-white">Create Tournament</DialogTitle>
              </DialogHeader>
              <CreateTournamentForm orgId={orgId} onSuccess={() => setIsCreateOpen(false)} selectedTemplate={selectedTemplate} onClearTemplate={() => setSelectedTemplate(null)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Templates Panel */}
      {showTemplates && (
        <div className="glass-panel rounded-2xl border border-white/10 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-white text-lg flex items-center gap-2">
              <BookTemplate className="w-5 h-5 text-primary" /> Tournament Templates
            </h2>
            <span className="text-xs text-muted-foreground">{templates.length} template{templates.length !== 1 ? 's' : ''}</span>
          </div>
          {templatesLoading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BookTemplate className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No templates saved yet.</p>
              <p className="text-xs mt-1 opacity-70">Use "Save as Template" from any tournament's settings to save its configuration.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {templates.map(tmpl => (
                <div key={tmpl.id} className="bg-black/30 border border-white/5 rounded-xl p-4 flex flex-col gap-2">
                  {editingTemplateId === tmpl.id ? (
                    <div className="space-y-2">
                      <Input
                        value={editingTemplateName}
                        onChange={e => setEditingTemplateName(e.target.value)}
                        className="bg-black/50 border-white/10 text-white text-sm h-8"
                        placeholder="Template name"
                      />
                      <Input
                        value={editingTemplateDesc}
                        onChange={e => setEditingTemplateDesc(e.target.value)}
                        className="bg-black/50 border-white/10 text-white text-xs h-7"
                        placeholder="Description (optional)"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveTemplateEdit(tmpl.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 text-xs transition-colors"
                        >
                          <Check size={11} /> Save
                        </button>
                        <button
                          onClick={() => setEditingTemplateId(null)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-white/5 text-muted-foreground hover:bg-white/10 text-xs transition-colors"
                        >
                          <X size={11} /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-white text-sm">{tmpl.name}</p>
                        {tmpl.description && <p className="text-xs text-muted-foreground mt-0.5">{tmpl.description}</p>}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => { setEditingTemplateId(tmpl.id); setEditingTemplateName(tmpl.name); setEditingTemplateDesc(tmpl.description ?? ''); }}
                          className="text-gray-500 hover:text-blue-400 transition-colors"
                          title="Edit template"
                        >
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteTemplate(tmpl.id)} className="text-red-500/50 hover:text-red-400 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="text-[10px] border-white/10 text-muted-foreground">
                      {tmpl.format.replace(/_/g, ' ')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] border-white/10 text-muted-foreground">
                      {tmpl.rounds} round{tmpl.rounds !== 1 ? 's' : ''}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] border-white/10 text-muted-foreground">
                      HCP {tmpl.handicapAllowance}%
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-auto border-primary/30 text-primary hover:bg-primary/10 text-xs w-full"
                    onClick={() => { setSelectedTemplate(tmpl); setIsCreateOpen(true); }}
                  >
                    <FileOutput size={12} className="mr-1.5" /> Use Template
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between glass-panel p-2 rounded-2xl">
        <div className="flex gap-2 p-1 bg-black/40 rounded-xl w-full sm:w-auto overflow-x-auto">
          {['all', 'active', 'upcoming', 'completed'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f as any)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                filter === f 
                  ? 'bg-white/10 text-white shadow-sm' 
                  : 'text-muted-foreground hover:text-white hover:bg-white/5'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search tournaments..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-black/40 border-white/5 focus-visible:ring-primary/50 text-white rounded-xl h-10"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3,4].map(i => <div key={i} className="h-64 glass-panel rounded-2xl animate-pulse" />)}
        </div>
      ) : filteredTournaments.length === 0 ? (
        <div className="text-center py-20 glass-panel rounded-3xl border-dashed">
          <Trophy className="w-16 h-16 text-muted-foreground opacity-30 mx-auto mb-4" />
          <h3 className="text-xl font-display text-white mb-2">No tournaments found</h3>
          <p className="text-muted-foreground">Adjust your filters or create a new event.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTournaments.map((t, i) => {
            const summary = surveySummaries.get(t.id);
            const surveyRate = summary && summary.eligiblePlayers > 0
              ? summary.totalResponses / summary.eligiblePlayers
              : null;
            const isLowEngagement = surveyRate !== null && surveyRate < LOW_SURVEY_RESPONSE_THRESHOLD;
            return (
            <motion.div key={t.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <Link href={`/tournaments/${t.id}`}>
                <div
                  data-testid={`tournament-card-${t.id}`}
                  className={`glass-card rounded-2xl p-6 h-full flex flex-col min-w-0 cursor-pointer group ${
                    isLowEngagement ? 'ring-1 ring-amber-500/40 shadow-[0_0_24px_rgba(245,158,11,0.18)]' : ''
                  }`}
                >
                  <div className="flex flex-wrap justify-between items-start gap-2 mb-4">
                    {getStatusBadge(t.status)}
                    <button className="text-muted-foreground hover:text-white p-1 rounded hover:bg-white/10 transition-colors flex-shrink-0">
                      <MoreVertical className="w-5 h-5" />
                    </button>
                  </div>
                  
                  <h3 className="text-xl font-bold text-white mb-2 group-hover:text-primary transition-colors line-clamp-2 min-w-0">
                    {t.name}
                  </h3>

                  {summary && (
                    <SurveyResponseBadge summary={summary} isLow={isLowEngagement} />
                  )}

                  <div className="space-y-2 mt-auto pt-6 min-w-0">
                    <div className="flex items-center text-sm text-muted-foreground min-w-0">
                      <Calendar className="w-4 h-4 mr-2 opacity-70 flex-shrink-0" />
                      <span className="truncate">{t.startDate ? new Date(t.startDate).toLocaleDateString() : 'TBD'}</span>
                    </div>
                    <div className="flex items-center text-sm text-muted-foreground min-w-0">
                      <MapPin className="w-4 h-4 mr-2 opacity-70 flex-shrink-0" />
                      <span className="truncate">{t.courseName || 'No course assigned'}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-4 mt-4 border-t border-white/5">
                      <span className="text-xs font-medium bg-white/5 px-2 py-1 rounded-md text-white truncate">
                        {getFormatDisplay(t.format)}
                      </span>
                      <div className="flex items-center text-sm font-medium text-white flex-shrink-0">
                        <Users className="w-4 h-4 mr-1.5 text-primary" />
                        {t.playerCount} <span className="text-muted-foreground ml-1 font-normal">/ {t.maxPlayers || '∞'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateTournamentForm({ orgId, onSuccess, selectedTemplate, onClearTemplate }: { orgId: number, onSuccess: () => void; selectedTemplate?: TournamentTemplate | null; onClearTemplate?: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);
  const [format, setFormat] = useState(selectedTemplate?.format ?? 'stroke_play');
  const [courseId, setCourseId] = useState<string>('none');
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [currency, setCurrency] = useState(selectedTemplate?.currency ?? 'INR');
  const [tiebreakerMethod, setTiebreakerMethod] = useState(selectedTemplate?.tiebreakerMethod ?? 'countback');
  const [leaderboardType, setLeaderboardType] = useState(selectedTemplate?.leaderboardType ?? 'both');
  const [rounds, setRounds] = useState(selectedTemplate?.rounds ?? 1);
  const [maxPlayers, setMaxPlayers] = useState<string>(selectedTemplate?.maxPlayers ? String(selectedTemplate.maxPlayers) : '');
  const [entryFee, setEntryFee] = useState<string>(selectedTemplate?.entryFee ?? '');
  const [handicapAllowance, setHandicapAllowance] = useState(selectedTemplate?.handicapAllowance ?? 100);
  const [eventType, setEventType] = useState<'standard' | 'corporate' | 'charity'>('standard');
  const [wizMaxScoreCap, setWizMaxScoreCap] = useState('');
  const [wizCutAfterRound, setWizCutAfterRound] = useState('');
  const [wizCutPosition, setWizCutPosition] = useState('top50_ties');
  const [wizStablefordConfig, setWizStablefordConfig] = useState<Record<string, number>>({});

  useEffect(() => {
    if (selectedTemplate) {
      setFormat(selectedTemplate.format);
      setCurrency(selectedTemplate.currency);
      setTiebreakerMethod(selectedTemplate.tiebreakerMethod);
      setLeaderboardType(selectedTemplate.leaderboardType);
      setRounds(selectedTemplate.rounds);
      setMaxPlayers(selectedTemplate.maxPlayers ? String(selectedTemplate.maxPlayers) : '');
      setEntryFee(selectedTemplate.entryFee ?? '');
      setHandicapAllowance(selectedTemplate.handicapAllowance ?? 100);
    }
  }, [selectedTemplate]);

  // Load courses for the org
  useEffect(() => {
    if (!orgId || isNaN(orgId)) return;
    window.fetch(`/api/organizations/${orgId}/courses`)
      .then(r => r.ok ? r.json() : [])
      .then(setCourses)
      .catch(() => {});
  }, [orgId]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId || isNaN(orgId)) {
      toast({ title: 'No organization found', variant: 'destructive' });
      return;
    }
    setIsPending(true);
    const fd = new FormData(e.currentTarget);
    const startDate = fd.get('startDate') as string;
    const endDate = fd.get('endDate') as string;
    const name = fd.get('name') as string;

    try {
      let res: Response;
      if (selectedTemplate?.id) {
        // Use dedicated endpoint so extended config (flights, side games, etc.) is applied
        res = await window.fetch(`/api/organizations/${orgId}/tournaments/from-template/${selectedTemplate.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            courseId: courseId !== 'none' ? parseInt(courseId) : undefined,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          }),
        });
      } else {
        res = await window.fetch(`/api/organizations/${orgId}/tournaments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            format,
            rounds,
            courseId: courseId !== 'none' ? parseInt(courseId) : undefined,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
            maxPlayers: maxPlayers ? parseInt(maxPlayers) : undefined,
            entryFee: entryFee || undefined,
            currency,
            handicapAllowance,
            isPublic: true,
            allowSpectators: true,
            tiebreakerMethod,
            leaderboardType,
            eventType,
            maxScoreCap: wizMaxScoreCap ? parseInt(wizMaxScoreCap) : undefined,
            cutAfterRound: wizCutAfterRound ? parseInt(wizCutAfterRound) : undefined,
            cutPosition: wizCutAfterRound ? wizCutPosition : undefined,
            stablefordPointsConfig: Object.keys(wizStablefordConfig).length > 0 ? wizStablefordConfig : undefined,
          }),
        });
      }
      if (!res.ok) throw new Error(await res.text());
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments`] });
      toast({ title: 'Tournament created!' });
      onSuccess();
    } catch {
      toast({ title: 'Failed to create tournament', variant: 'destructive' });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      {selectedTemplate && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 border border-primary/20 text-sm text-primary">
          <BookTemplate size={14} />
          <span>Using template: <strong>{selectedTemplate.name}</strong></span>
          <button type="button" onClick={onClearTemplate} className="ml-auto text-xs text-muted-foreground hover:text-white">✕ Clear</button>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium text-white">Event Type</label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: 'standard', label: 'Standard', icon: <Trophy size={14} />, color: 'primary' },
            { value: 'corporate', label: 'Corporate', icon: <Briefcase size={14} />, color: 'blue' },
            { value: 'charity', label: 'Charity', icon: <Heart size={14} />, color: 'rose' },
          ].map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setEventType(opt.value as any)}
              className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                eventType === opt.value
                  ? opt.value === 'corporate' ? 'bg-blue-500/20 border-blue-500/50 text-blue-300' :
                    opt.value === 'charity' ? 'bg-rose-500/20 border-rose-500/50 text-rose-300' :
                    'bg-primary/20 border-primary/50 text-primary'
                  : 'bg-black/30 border-white/10 text-muted-foreground hover:text-white hover:bg-white/5'
              }`}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-white">Tournament Name *</label>
        <Input name="name" required placeholder="e.g. Annual Member-Guest" className="bg-black/50 border-white/10 text-white" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Format *</label>
          <Select value={format} onValueChange={v => { setFormat(v); setWizMaxScoreCap(''); setWizCutAfterRound(''); setWizStablefordConfig({}); }}>
            <SelectTrigger className="bg-black/50 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/10 text-white">
              <SelectItem value="stroke_play">Stroke Play</SelectItem>
              <SelectItem value="net_stroke">Net Stroke Play</SelectItem>
              <SelectItem value="stableford">Stableford</SelectItem>
              <SelectItem value="team_stableford">Team Stableford</SelectItem>
              <SelectItem value="maximum_score">Maximum Score</SelectItem>
              <SelectItem value="par_bogey">Par / Bogey</SelectItem>
              <SelectItem value="best_ball">Best Ball</SelectItem>
              <SelectItem value="scramble">Scramble</SelectItem>
              <SelectItem value="match_play">Match Play</SelectItem>
              <SelectItem value="skins">Skins</SelectItem>
              <SelectItem value="shamble">Shamble</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Rounds</label>
          <Input type="number" name="rounds" value={rounds} min={1} max={4}
            onChange={e => setRounds(parseInt(e.target.value) || 1)}
            className="bg-black/50 border-white/10 text-white" />
        </div>
      </div>

      {/* Format description */}
      {FORMAT_DESC[format] && (
        <p className="text-xs text-muted-foreground bg-white/5 rounded-lg px-3 py-2 border border-white/10 -mt-2">
          {FORMAT_DESC[format]}
        </p>
      )}

      {/* Maximum Score cap */}
      {format === 'maximum_score' && (
        <div className="space-y-1.5 bg-white/5 rounded-xl p-3 border border-white/10">
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Max Score Cap (strokes over par per hole)</label>
          <Input
            type="number" min={1} max={10} placeholder="e.g. 3 (cap at par + 3)"
            value={wizMaxScoreCap}
            onChange={e => setWizMaxScoreCap(e.target.value)}
            className="bg-black/50 border-white/10 text-white text-sm"
          />
          <p className="text-xs text-muted-foreground">Each hole score is capped at par + this value before stableford calculation.</p>
        </div>
      )}

      {/* Stableford points config */}
      {(format === 'stableford' || format === 'team_stableford') && (
        <div className="space-y-2 bg-white/5 rounded-xl p-3 border border-white/10">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Points Table <span className="normal-case font-normal">(leave blank for WHS defaults)</span></p>
          <div className="grid grid-cols-3 gap-2">
            {(['eagle', 'birdie', 'par', 'bogey', 'double', 'worse'] as const).map(key => (
              <div key={key} className="space-y-1">
                <label className="text-xs text-muted-foreground capitalize">{key === 'worse' ? 'Triple+' : key}</label>
                <Input
                  type="number" min={0} max={10}
                  placeholder={key === 'eagle' ? '4' : key === 'birdie' ? '3' : key === 'par' ? '2' : key === 'bogey' ? '1' : '0'}
                  value={wizStablefordConfig[key] !== undefined ? String(wizStablefordConfig[key]) : ''}
                  onChange={e => {
                    const val = e.target.value === '' ? undefined : parseInt(e.target.value);
                    setWizStablefordConfig(prev => val !== undefined ? { ...prev, [key]: val } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
                  }}
                  className="bg-black/50 border-white/10 text-white text-sm"
                />
              </div>
            ))}
          </div>
          {format === 'team_stableford' && (
            <div className="pt-1 border-t border-white/10 space-y-1">
              <label className="text-xs text-muted-foreground">Best N players per hole (leave blank = half team)</label>
              <Input
                type="number" min={1} max={8} placeholder="Auto"
                value={wizStablefordConfig['bestOf'] !== undefined ? String(wizStablefordConfig['bestOf']) : ''}
                onChange={e => {
                  const val = e.target.value === '' ? undefined : parseInt(e.target.value);
                  setWizStablefordConfig(prev => val !== undefined ? { ...prev, bestOf: val } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== 'bestOf')));
                }}
                className="bg-black/50 border-white/10 text-white text-sm"
              />
            </div>
          )}
        </div>
      )}

      {/* Cut-line automation for multi-round stroke-play formats */}
      {(format === 'stroke_play' || format === 'net_stroke' || format === 'stableford' || format === 'team_stableford' || format === 'maximum_score' || format === 'par_bogey') && rounds >= 2 && (
        <div className="space-y-2 bg-white/5 rounded-xl p-3 border border-white/10">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Cut Automation <span className="normal-case font-normal">(optional)</span></p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Cut After Round</label>
              <Input
                type="number" min={1} max={rounds - 1} placeholder="None"
                value={wizCutAfterRound}
                onChange={e => setWizCutAfterRound(e.target.value)}
                className="bg-black/50 border-white/10 text-white text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Cut Position</label>
              <Select value={wizCutPosition} onValueChange={setWizCutPosition} disabled={!wizCutAfterRound}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white text-sm h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {CUT_POSITIONS.map(cp => (
                    <SelectItem key={cp.value} value={cp.value}>{cp.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {wizCutAfterRound && <p className="text-xs text-muted-foreground">Cut applied after Round {wizCutAfterRound}. Players who miss cut are marked MC and excluded from subsequent round scoring.</p>}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium text-white">Course</label>
        <Select value={courseId} onValueChange={setCourseId}>
          <SelectTrigger className="bg-black/50 border-white/10 text-white">
            <SelectValue placeholder="Select a course" />
          </SelectTrigger>
          <SelectContent className="bg-card border-white/10 text-white">
            <SelectItem value="none">No course assigned yet</SelectItem>
            {courses.map(c => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Start Date</label>
          <Input type="date" name="startDate" className="bg-black/50 border-white/10 text-white" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">End Date</label>
          <Input type="date" name="endDate" className="bg-black/50 border-white/10 text-white" />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-white">Max Players</label>
        <Input type="number" name="maxPlayers" placeholder="Unlimited" min={2}
          value={maxPlayers} onChange={e => setMaxPlayers(e.target.value)}
          className="bg-black/50 border-white/10 text-white" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Entry Fee <span className="text-muted-foreground font-normal">(optional)</span></label>
          <Input type="number" name="entryFee" placeholder="0.00" min={0} step="0.01"
            value={entryFee} onChange={e => setEntryFee(e.target.value)}
            className="bg-black/50 border-white/10 text-white" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Currency</label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger className="bg-black/50 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/10 text-white">
              {CURRENCIES.map(c => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Tie-Breaker Method</label>
          <Select value={tiebreakerMethod} onValueChange={setTiebreakerMethod}>
            <SelectTrigger className="bg-black/50 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/10 text-white">
              <SelectItem value="countback">Countback (last 9/6/3/1)</SelectItem>
              <SelectItem value="multi_round_countback">Multi-Round Countback</SelectItem>
              <SelectItem value="net_countback">Net Countback</SelectItem>
              <SelectItem value="lower_handicap">Lower Handicap</SelectItem>
              <SelectItem value="no_tiebreaker">No Tie-Breaker</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Leaderboard Type</label>
          <Select value={leaderboardType} onValueChange={setLeaderboardType}>
            <SelectTrigger className="bg-black/50 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/10 text-white">
              <SelectItem value="both">Gross &amp; Net</SelectItem>
              <SelectItem value="gross">Gross Only</SelectItem>
              <SelectItem value="net">Net Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="pt-4 flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onSuccess} className="hover:bg-white/5 text-white">Cancel</Button>
        <Button type="submit" disabled={isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20">
          {isPending ? 'Creating...' : 'Create Tournament'}
        </Button>
      </div>
    </form>
  );
}

function SurveyResponseBadge({ summary, isLow }: { summary: SurveySummary; isLow: boolean }) {
  const { totalResponses, eligiblePlayers } = summary;
  const hasDenominator = eligiblePlayers > 0;
  const pct = hasDenominator ? Math.round((totalResponses / eligiblePlayers) * 100) : null;

  // Two visual states:
  //   • Low engagement (< 25% with a non-zero pool) → amber, with the
  //     warning icon so the card stands out in a wall of cards.
  //   • Everything else → muted neutral chip so admins still see the
  //     denominator without it competing with the title.
  const cls = isLow
    ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
    : 'bg-white/5 text-muted-foreground border-white/10';
  const Icon = isLow ? MessageSquareWarning : MessageSquare;
  const label = hasDenominator
    ? `${totalResponses} / ${eligiblePlayers} — ${pct}%`
    : `${totalResponses} response${totalResponses === 1 ? '' : 's'}`;

  return (
    <div
      data-testid='survey-response-badge'
      data-low-engagement={isLow ? 'true' : 'false'}
      className={`mt-1 inline-flex items-center gap-1.5 self-start px-2 py-1 rounded-md border text-xs font-medium ${cls}`}
      title={isLow ? 'Low survey response rate — consider sending a reminder' : 'Survey response rate'}
    >
      <Icon className='w-3.5 h-3.5' />
      <span>Survey: {label}</span>
      {isLow && <span className='ml-1 uppercase tracking-wide text-[10px] font-bold'>Low</span>}
    </div>
  );
}

