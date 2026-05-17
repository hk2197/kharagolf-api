import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  ClipboardList, Plus, Send, BarChart2, Download, Users, CheckCircle2,
  XCircle, Clock, Edit2, Trash2, ChevronRight, Star, MessageSquare,
  ToggleLeft, ToggleRight, Filter, TrendingUp, AlertCircle, RefreshCw,
  GripVertical, ArrowUp, ArrowDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

type QuestionType = 'rating' | 'multiple_choice' | 'free_text' | 'nps';
type SurveyStatus = 'draft' | 'active' | 'closed';
type SurveyTrigger = 'manual' | 'post_round' | 'post_event' | 'post_tournament';

interface Survey {
  id: number;
  title: string;
  description: string | null;
  status: SurveyStatus;
  trigger: SurveyTrigger;
  isAnonymous: boolean;
  targetSegment: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  responseCount: number;
  questionCount: number;
}

interface SurveyQuestion {
  id: number;
  surveyId: number;
  type: QuestionType;
  questionText: string;
  isRequired: boolean;
  sortOrder: number;
  options: string[];
  ratingMin: number;
  ratingMax: number;
}

interface AggregatedResult {
  questionId: number;
  type: QuestionType;
  questionText: string;
  responseCount: number;
  average?: number | null;
  distribution?: Record<number, number>;
  nps?: number | null;
  promoters?: number;
  passives?: number;
  detractors?: number;
  choices?: Record<string, number>;
  texts?: string[];
}

const STATUS_CONFIG: Record<SurveyStatus, { label: string; color: string; icon: React.ElementType }> = {
  draft: { label: 'Draft', color: 'bg-gray-500/10 text-gray-400 border-gray-500/20', icon: Edit2 },
  active: { label: 'Active', color: 'bg-green-500/10 text-green-400 border-green-500/20', icon: CheckCircle2 },
  closed: { label: 'Closed', color: 'bg-red-500/10 text-red-400 border-red-500/20', icon: XCircle },
};

const TRIGGER_LABELS: Record<SurveyTrigger, string> = {
  manual: 'Manual Send',
  post_round: 'After Round',
  post_event: 'After Event',
  post_tournament: 'After Tournament',
};

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  rating: 'Rating Scale',
  multiple_choice: 'Multiple Choice',
  free_text: 'Free Text',
  nps: 'NPS Score',
};

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${BASE}/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });
}

function formatDate(d: string | null | undefined) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function NpsGauge({ nps }: { nps: number | null }) {
  if (nps === null) return <span className="text-muted-foreground text-sm">No data</span>;
  const color = nps >= 50 ? 'text-green-400' : nps >= 0 ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-3">
      <span className={`text-4xl font-bold ${color}`}>{nps > 0 ? '+' : ''}{nps}</span>
      <div>
        <p className="text-xs text-muted-foreground">Net Promoter Score</p>
        <p className="text-xs">{nps >= 50 ? 'Excellent' : nps >= 0 ? 'Good' : 'Needs Improvement'}</p>
      </div>
    </div>
  );
}

function RatingBar({ label, count, total }: { label: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-8 text-right text-muted-foreground">{label}</span>
      <div className="flex-1 bg-white/5 rounded-full h-2">
        <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-muted-foreground">{count}</span>
    </div>
  );
}

// ─── Survey Builder Modal ──────────────────────────────────────────────────────

function SurveyBuilderModal({
  orgId,
  surveyId,
  onClose,
}: {
  orgId: number;
  surveyId: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newQ, setNewQ] = useState<{ type: QuestionType; questionText: string; isRequired: boolean; options: string[]; ratingMin: number; ratingMax: number }>({
    type: 'rating', questionText: '', isRequired: true, options: [], ratingMin: 1, ratingMax: 5,
  });
  const [optionInput, setOptionInput] = useState('');
  const [adding, setAdding] = useState(false);

  const { data } = useQuery({
    queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}`],
    queryFn: () => apiFetch(`/organizations/${orgId}/surveys/${surveyId}`),
  });

  const survey: (Survey & { questions?: SurveyQuestion[] }) | undefined = data;
  const questions: SurveyQuestion[] = (data as { questions?: SurveyQuestion[] })?.questions ?? [];

  const addQuestion = useMutation({
    mutationFn: (body: object) => apiFetch(`/organizations/${orgId}/surveys/${surveyId}/questions`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}`] });
      setNewQ({ type: 'rating', questionText: '', isRequired: true, options: [], ratingMin: 1, ratingMax: 5 });
      setOptionInput('');
      setAdding(false);
      toast({ title: 'Question added' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteQuestion = useMutation({
    mutationFn: (qId: number) => apiFetch(`/organizations/${orgId}/surveys/${surveyId}/questions/${qId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}`] }),
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const moveQuestion = async (qId: number, dir: 'up' | 'down') => {
    const idx = questions.findIndex(q => q.id === qId);
    if (dir === 'up' && idx === 0) return;
    if (dir === 'down' && idx === questions.length - 1) return;
    const newOrder = [...questions];
    const swap = dir === 'up' ? idx - 1 : idx + 1;
    [newOrder[idx], newOrder[swap]] = [newOrder[swap], newOrder[idx]];
    await apiFetch(`/organizations/${orgId}/surveys/${surveyId}/questions/reorder`, {
      method: 'POST',
      body: JSON.stringify({ order: newOrder.map(q => q.id) }),
    });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}`] });
  };

  const handleAddOption = () => {
    if (!optionInput.trim()) return;
    setNewQ(q => ({ ...q, options: [...q.options, optionInput.trim()] }));
    setOptionInput('');
  };

  const handleSubmitQuestion = () => {
    if (!newQ.questionText.trim()) return;
    const payload: Record<string, unknown> = {
      type: newQ.type,
      questionText: newQ.questionText,
      isRequired: newQ.isRequired,
      sortOrder: questions.length,
    };
    if (newQ.type === 'rating') { payload.ratingMin = newQ.ratingMin; payload.ratingMax = newQ.ratingMax; }
    if (newQ.type === 'multiple_choice') payload.options = newQ.options;
    addQuestion.mutate(payload);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            Survey Builder — {(survey as Survey | undefined)?.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {questions.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-6">No questions yet. Add your first question below.</p>
          ) : (
            <div className="space-y-2">
              {questions.map((q, idx) => (
                <div key={q.id} className="flex items-start gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="flex flex-col gap-1">
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveQuestion(q.id, 'up')} disabled={idx === 0}>
                      <ArrowUp className="w-3 h-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveQuestion(q.id, 'down')} disabled={idx === questions.length - 1}>
                      <ArrowDown className="w-3 h-3" />
                    </Button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-xs">{QUESTION_TYPE_LABELS[q.type]}</Badge>
                      {q.isRequired && <Badge variant="outline" className="text-xs text-yellow-400 border-yellow-400/20">Required</Badge>}
                    </div>
                    <p className="text-sm text-white">{q.questionText}</p>
                    {q.type === 'multiple_choice' && q.options.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">Options: {q.options.join(', ')}</p>
                    )}
                    {q.type === 'rating' && (
                      <p className="text-xs text-muted-foreground mt-1">Scale: {q.ratingMin}–{q.ratingMax}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-400 hover:text-red-300 h-7 w-7"
                    onClick={() => deleteQuestion.mutate(q.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Separator />

          {adding ? (
            <div className="space-y-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
              <h4 className="text-sm font-medium">New Question</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select value={newQ.type} onValueChange={v => setNewQ(q => ({ ...q, type: v as QuestionType, options: [] }))}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(QUESTION_TYPE_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Required?</Label>
                  <Select value={newQ.isRequired ? 'yes' : 'no'} onValueChange={v => setNewQ(q => ({ ...q, isRequired: v === 'yes' }))}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Question Text</Label>
                <Textarea
                  placeholder="Enter your question..."
                  value={newQ.questionText}
                  onChange={e => setNewQ(q => ({ ...q, questionText: e.target.value }))}
                  className="min-h-[60px] text-sm"
                />
              </div>
              {newQ.type === 'rating' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Min</Label>
                    <Input type="number" value={newQ.ratingMin} onChange={e => setNewQ(q => ({ ...q, ratingMin: parseInt(e.target.value) }))} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max</Label>
                    <Input type="number" value={newQ.ratingMax} onChange={e => setNewQ(q => ({ ...q, ratingMax: parseInt(e.target.value) }))} className="h-8 text-sm" />
                  </div>
                </div>
              )}
              {newQ.type === 'multiple_choice' && (
                <div className="space-y-2">
                  <Label className="text-xs">Options</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add option..."
                      value={optionInput}
                      onChange={e => setOptionInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddOption(); } }}
                      className="h-8 text-sm flex-1"
                    />
                    <Button size="sm" variant="outline" onClick={handleAddOption}>Add</Button>
                  </div>
                  {newQ.options.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {newQ.options.map((o, i) => (
                        <Badge key={i} variant="secondary" className="text-xs cursor-pointer" onClick={() => setNewQ(q => ({ ...q, options: q.options.filter((_, j) => j !== i) }))}>
                          {o} ×
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSubmitQuestion} disabled={addQuestion.isPending || !newQ.questionText.trim()}>
                  {addQuestion.isPending ? 'Adding...' : 'Add Question'}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="w-full" onClick={() => setAdding(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Question
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Results Modal ─────────────────────────────────────────────────────────────

function ResultsModal({
  orgId,
  surveyId,
  surveyTitle,
  onClose,
}: {
  orgId: number;
  surveyId: number;
  surveyTitle: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<'charts' | 'responses' | 'rate'>('charts');

  const { data: resultsData, isLoading } = useQuery({
    queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}/results`],
    queryFn: () => apiFetch(`/organizations/${orgId}/surveys/${surveyId}/results`),
  });

  const { data: rateData } = useQuery({
    queryKey: [`/api/organizations/${orgId}/surveys/${surveyId}/response-rate`],
    queryFn: () => apiFetch(`/organizations/${orgId}/surveys/${surveyId}/response-rate`),
    enabled: tab === 'rate',
  });

  const handleExport = async () => {
    const url = `${BASE}/api/organizations/${orgId}/surveys/${surveyId}/results/export`;
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('Export failed');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `survey-${surveyId}-results.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: unknown) {
      toast({ title: 'Export failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    }
  };

  const results = resultsData as {
    survey: Survey;
    totalResponses: number;
    aggregated: AggregatedResult[];
    responses: {
      id: number;
      respondentName: string;
      completedAt: string;
      items: {
        questionId: number;
        questionText?: string;
        questionType?: string;
        ratingValue?: number | null;
        choiceValue?: string | null;
        textValue?: string | null;
        npsScore?: number | null;
      }[];
    }[];
  } | undefined;

  const rate = rateData as { totalMembers: number; responded: number; pending: number; responseRate: number; pendingList: { name: string; email: string | null; memberNumber: string | null }[] } | undefined;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-primary" />
              Results — {surveyTitle}
            </DialogTitle>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="w-4 h-4 mr-1" />
              Export CSV
            </Button>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={v => setTab(v as 'charts' | 'responses' | 'rate')}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-muted-foreground">{results?.totalResponses ?? 0} total responses</p>
              <TabsList>
                <TabsTrigger value="charts">Charts</TabsTrigger>
                <TabsTrigger value="responses">Responses</TabsTrigger>
                <TabsTrigger value="rate">Response Rate</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="charts" className="space-y-4 mt-0">
              {(!results?.aggregated || results.aggregated.length === 0) ? (
                <p className="text-center text-muted-foreground py-8">No responses yet.</p>
              ) : (
                results.aggregated.map((a) => (
                  <Card key={a.questionId} className="bg-white/5 border-white/10">
                    <CardHeader className="pb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{QUESTION_TYPE_LABELS[a.type]}</Badge>
                        <span className="text-xs text-muted-foreground">{a.responseCount} response{a.responseCount !== 1 ? 's' : ''}</span>
                      </div>
                      <CardTitle className="text-sm font-medium">{a.questionText}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {a.type === 'rating' && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Star className="w-4 h-4 text-yellow-400" />
                            <span className="text-2xl font-bold text-yellow-400">{a.average ?? '—'}</span>
                            <span className="text-sm text-muted-foreground">/ 5 avg</span>
                          </div>
                          {a.distribution && Object.entries(a.distribution).reverse().map(([v, c]) => (
                            <RatingBar key={v} label={v} count={c} total={a.responseCount} />
                          ))}
                        </div>
                      )}
                      {a.type === 'nps' && (
                        <div className="space-y-3">
                          <NpsGauge nps={a.nps ?? null} />
                          <div className="grid grid-cols-3 gap-2 text-center text-xs">
                            <div className="p-2 rounded-lg bg-green-500/10">
                              <p className="text-green-400 font-bold text-lg">{a.promoters ?? 0}</p>
                              <p className="text-muted-foreground">Promoters (9-10)</p>
                            </div>
                            <div className="p-2 rounded-lg bg-yellow-500/10">
                              <p className="text-yellow-400 font-bold text-lg">{a.passives ?? 0}</p>
                              <p className="text-muted-foreground">Passives (7-8)</p>
                            </div>
                            <div className="p-2 rounded-lg bg-red-500/10">
                              <p className="text-red-400 font-bold text-lg">{a.detractors ?? 0}</p>
                              <p className="text-muted-foreground">Detractors (0-6)</p>
                            </div>
                          </div>
                        </div>
                      )}
                      {a.type === 'multiple_choice' && a.choices && (
                        <div className="space-y-2">
                          {Object.entries(a.choices).map(([choice, c]) => (
                            <RatingBar key={choice} label={choice} count={c} total={a.responseCount} />
                          ))}
                        </div>
                      )}
                      {a.type === 'free_text' && (
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {(a.texts ?? []).length === 0 ? (
                            <p className="text-sm text-muted-foreground">No responses</p>
                          ) : (
                            (a.texts ?? []).map((t, i) => (
                              <p key={i} className="text-sm p-2 rounded-lg bg-white/5 border border-white/10">{t}</p>
                            ))
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="responses" className="mt-0">
              {(!results?.responses || results.responses.length === 0) ? (
                <p className="text-center text-muted-foreground py-8">No responses yet.</p>
              ) : (
                <div className="space-y-3">
                  {results.responses.map(r => (
                    <div key={r.id} className="p-3 rounded-lg bg-white/5 border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">{r.respondentName}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(r.completedAt)}</span>
                      </div>
                      <div className="space-y-1.5">
                        {r.items.map(item => (
                          <div key={item.questionId} className="text-xs">
                            <span className="text-muted-foreground">{item.questionText}: </span>
                            <span className="text-white">
                              {item.questionType === 'rating' ? `${item.ratingValue}/5` :
                                item.questionType === 'nps' ? `${item.npsScore}/10` :
                                  item.questionType === 'multiple_choice' ? item.choiceValue :
                                    item.textValue}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="rate" className="mt-0">
              {rate ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <Card className="bg-white/5 border-white/10 text-center p-4">
                      <p className="text-2xl font-bold text-primary">{rate.responseRate}%</p>
                      <p className="text-xs text-muted-foreground">Response Rate</p>
                    </Card>
                    <Card className="bg-white/5 border-white/10 text-center p-4">
                      <p className="text-2xl font-bold text-green-400">{rate.responded}</p>
                      <p className="text-xs text-muted-foreground">Responded</p>
                    </Card>
                    <Card className="bg-white/5 border-white/10 text-center p-4">
                      <p className="text-2xl font-bold text-yellow-400">{rate.pending}</p>
                      <p className="text-xs text-muted-foreground">Pending</p>
                    </Card>
                  </div>
                  {rate.pendingList.length > 0 && (
                    <div>
                      <p className="text-sm font-medium mb-2 text-muted-foreground">Pending Members</p>
                      <div className="space-y-1 max-h-60 overflow-y-auto">
                        {rate.pendingList.map((m, i) => (
                          <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-white/5 text-sm">
                            <span>{m.name}</span>
                            <span className="text-muted-foreground text-xs">{m.memberNumber ?? m.email ?? ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Survey Modal ───────────────────────────────────────────────────────

function CreateSurveyModal({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: number;
  onClose: () => void;
  onCreated: (survey: Survey) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: '', description: '', trigger: 'manual' as SurveyTrigger, isAnonymous: false, targetSegment: '' });

  const create = useMutation({
    mutationFn: (body: object) => apiFetch(`/organizations/${orgId}/surveys`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data: { survey: Survey }) => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys`] });
      toast({ title: 'Survey created' });
      onCreated(data.survey);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    create.mutate({ ...form, targetSegment: form.targetSegment || null });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Survey</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label>Survey Title *</Label>
            <Input placeholder="e.g. Post-Round Satisfaction Survey" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea placeholder="Brief description for members..." value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="min-h-[60px]" />
          </div>
          <div className="space-y-1">
            <Label>Trigger</Label>
            <Select value={form.trigger} onValueChange={v => setForm(f => ({ ...f, trigger: v as SurveyTrigger }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setForm(f => ({ ...f, isAnonymous: !f.isAnonymous }))}>
              {form.isAnonymous ? <ToggleRight className="w-8 h-8 text-primary" /> : <ToggleLeft className="w-8 h-8 text-muted-foreground" />}
            </button>
            <div>
              <p className="text-sm font-medium">Anonymous Responses</p>
              <p className="text-xs text-muted-foreground">Member identities will not be stored</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !form.title.trim()}>
              {create.isPending ? 'Creating...' : 'Create Survey'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Send Survey Modal ─────────────────────────────────────────────────────────

function SendSurveyModal({
  orgId,
  survey,
  onClose,
}: {
  orgId: number;
  survey: Survey;
  onClose: () => void;
}) {
  const { toast } = useToast();

  const send = useMutation({
    mutationFn: () => apiFetch(`/organizations/${orgId}/surveys/${survey.id}/send`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (data: { sentTo: number }) => {
      toast({ title: 'Survey sent', description: `Sent to ${data.sentTo} members` });
      onClose();
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Send Survey</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This will mark the survey as sent to all active members of your club.
          </p>
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
            <p className="text-sm font-medium">{survey.title}</p>
            <p className="text-xs text-muted-foreground mt-1">{survey.questionCount} question{survey.questionCount !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => send.mutate()} disabled={send.isPending}>
            <Send className="w-4 h-4 mr-2" />
            {send.isPending ? 'Sending...' : 'Send to All Members'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── NPS Trend ────────────────────────────────────────────────────────────────

function NpsTrendCard({ orgId }: { orgId: number }) {
  const { data } = useQuery({
    queryKey: [`/api/organizations/${orgId}/surveys/nps-trend`],
    queryFn: () => apiFetch(`/organizations/${orgId}/surveys/nps-trend`),
  });

  const trend = (data as { trend: { month: string; nps: number | null; total: number }[] } | undefined)?.trend ?? [];

  if (trend.length === 0) return null;

  const latest = trend[trend.length - 1];

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          NPS Trend
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <NpsGauge nps={latest.nps} />
          <div className="flex-1 flex items-end gap-1 h-12">
            {trend.map((t, i) => {
              const h = t.nps !== null ? Math.max(4, ((t.nps + 100) / 200) * 48) : 4;
              const color = t.nps !== null && t.nps >= 50 ? 'bg-green-400' : t.nps !== null && t.nps >= 0 ? 'bg-yellow-400' : 'bg-red-400';
              return <div key={i} className={`flex-1 rounded-t ${color} opacity-80`} style={{ height: h }} title={`${t.month}: NPS ${t.nps}`} />;
            })}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Last {trend.length} month{trend.length !== 1 ? 's' : ''} · {latest.total} response{latest.total !== 1 ? 's' : ''} this month</p>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function SurveysPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = (activeOrgId ?? user?.organizationId) as number | undefined;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [builderSurveyId, setBuilderSurveyId] = useState<number | null>(null);
  const [resultsSurvey, setResultsSurvey] = useState<Survey | null>(null);
  const [sendSurvey, setSendSurvey] = useState<Survey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: [`/api/organizations/${orgId}/surveys`, statusFilter],
    queryFn: () => apiFetch(`/organizations/${orgId}/surveys${statusFilter !== 'all' ? `?status=${statusFilter}` : ''}`),
    enabled: !!orgId,
  });

  const surveys: Survey[] = (data as { surveys?: Survey[] } | undefined)?.surveys ?? [];

  const publish = useMutation({
    mutationFn: (id: number) => apiFetch(`/organizations/${orgId}/surveys/${id}/publish`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys`] }); toast({ title: 'Survey published' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const close = useMutation({
    mutationFn: (id: number) => apiFetch(`/organizations/${orgId}/surveys/${id}/close`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys`] }); toast({ title: 'Survey closed' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteSurvey = useMutation({
    mutationFn: (id: number) => apiFetch(`/organizations/${orgId}/surveys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/surveys`] }); toast({ title: 'Survey deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const stats = useMemo(() => ({
    total: surveys.length,
    active: surveys.filter(s => s.status === 'active').length,
    totalResponses: surveys.reduce((sum, s) => sum + s.responseCount, 0),
  }), [surveys]);

  if (!orgId) return <div className="p-8 text-center text-muted-foreground">Please select an organization.</div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ClipboardList className="w-7 h-7 text-primary" />
            Member Feedback & Surveys
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Build surveys, collect member feedback, and analyze results</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Survey
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-white/5 border-white/10">
          <CardContent className="pt-4">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">Total Surveys</p>
          </CardContent>
        </Card>
        <Card className="bg-white/5 border-white/10">
          <CardContent className="pt-4">
            <p className="text-2xl font-bold text-green-400">{stats.active}</p>
            <p className="text-xs text-muted-foreground">Active Surveys</p>
          </CardContent>
        </Card>
        <Card className="bg-white/5 border-white/10">
          <CardContent className="pt-4">
            <p className="text-2xl font-bold text-primary">{stats.totalResponses}</p>
            <p className="text-xs text-muted-foreground">Total Responses</p>
          </CardContent>
        </Card>
      </div>

      {/* NPS Trend */}
      {orgId && <NpsTrendCard orgId={orgId} />}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-muted-foreground" />
        {['all', 'draft', 'active', 'closed'].map(s => (
          <Button
            key={s}
            variant={statusFilter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(s)}
            className="capitalize"
          >
            {s === 'all' ? 'All Surveys' : STATUS_CONFIG[s as SurveyStatus]?.label ?? s}
          </Button>
        ))}
      </div>

      {/* Survey List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : surveys.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No surveys yet. Create your first survey to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {surveys.map(survey => {
            const cfg = STATUS_CONFIG[survey.status];
            const StatusIcon = cfg.icon;
            return (
              <Card key={survey.id} className="bg-white/5 border-white/10 hover:border-white/20 transition-colors">
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold text-white text-sm">{survey.title}</h3>
                        <Badge variant="outline" className={`text-xs ${cfg.color}`}>
                          <StatusIcon className="w-3 h-3 mr-1" />
                          {cfg.label}
                        </Badge>
                        <Badge variant="outline" className="text-xs text-muted-foreground border-white/10">
                          {TRIGGER_LABELS[survey.trigger]}
                        </Badge>
                        {survey.isAnonymous && (
                          <Badge variant="outline" className="text-xs text-purple-400 border-purple-400/20">Anonymous</Badge>
                        )}
                      </div>
                      {survey.description && (
                        <p className="text-xs text-muted-foreground mb-2 line-clamp-1">{survey.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" />
                          {survey.questionCount} question{survey.questionCount !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {survey.responseCount} response{survey.responseCount !== 1 ? 's' : ''}
                        </span>
                        {survey.publishedAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Published {formatDate(survey.publishedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {survey.status === 'draft' && (
                        <>
                          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setBuilderSurveyId(survey.id)}>
                            <Edit2 className="w-3.5 h-3.5 mr-1" />
                            Build
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-green-400" onClick={() => publish.mutate(survey.id)} disabled={publish.isPending}>
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                            Publish
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400" onClick={() => deleteSurvey.mutate(survey.id)} disabled={deleteSurvey.isPending}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      )}
                      {survey.status === 'active' && (
                        <>
                          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setBuilderSurveyId(survey.id)}>
                            <Edit2 className="w-3.5 h-3.5 mr-1" />
                            Questions
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-blue-400" onClick={() => setSendSurvey(survey)}>
                            <Send className="w-3.5 h-3.5 mr-1" />
                            Send
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setResultsSurvey(survey)}>
                            <BarChart2 className="w-3.5 h-3.5 mr-1" />
                            Results
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-red-400" onClick={() => close.mutate(survey.id)} disabled={close.isPending}>
                            <XCircle className="w-3.5 h-3.5 mr-1" />
                            Close
                          </Button>
                        </>
                      )}
                      {survey.status === 'closed' && (
                        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setResultsSurvey(survey)}>
                          <BarChart2 className="w-3.5 h-3.5 mr-1" />
                          Results
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showCreate && orgId && (
        <CreateSurveyModal
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={(survey) => { setShowCreate(false); setBuilderSurveyId(survey.id); }}
        />
      )}
      {builderSurveyId && orgId && (
        <SurveyBuilderModal
          orgId={orgId}
          surveyId={builderSurveyId}
          onClose={() => setBuilderSurveyId(null)}
        />
      )}
      {resultsSurvey && orgId && (
        <ResultsModal
          orgId={orgId}
          surveyId={resultsSurvey.id}
          surveyTitle={resultsSurvey.title}
          onClose={() => setResultsSurvey(null)}
        />
      )}
      {sendSurvey && orgId && (
        <SendSurveyModal
          orgId={orgId}
          survey={sendSurvey}
          onClose={() => setSendSurvey(null)}
        />
      )}
    </div>
  );
}
