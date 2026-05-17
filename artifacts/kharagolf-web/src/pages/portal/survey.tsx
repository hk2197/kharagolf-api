import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { ChevronLeft, CheckCircle2, Send, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

interface SurveyQuestion {
  id: string;
  prompt: string;
  type: 'rating' | 'text' | 'boolean';
}

interface SurveyPayload {
  survey: {
    id: number;
    tournamentId: number;
    tournamentName: string | null;
    questions: SurveyQuestion[];
    closesAt: string | null;
    sentAt: string | null;
  };
  closed: boolean;
  alreadySubmitted: boolean;
  submittedAt: string | null;
}

const GOLD = '#C9A84C';

export default function PortalSurveyPage() {
  const params = useParams<{ surveyId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const surveyId = Number(params.surveyId);
  const [data, setData] = useState<SurveyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [thankYou, setThankYou] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (!Number.isFinite(surveyId)) throw new Error('Invalid survey link');
        const res = await fetch(`/api/portal/surveys/${surveyId}`, { credentials: 'include' });
        if (res.status === 401) {
          if (!cancelled) navigate('/portal');
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Could not load survey (${res.status})`);
        if (!cancelled) {
          setData(body);
          if (body.alreadySubmitted) setThankYou(true);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [surveyId, navigate]);

  const questions = data?.survey.questions ?? [];
  const disabled = !data || data.closed || data.alreadySubmitted || submitting || thankYou;

  const closesLabel = useMemo(() => {
    if (!data?.survey.closesAt) return null;
    return new Date(data.survey.closesAt).toLocaleString();
  }, [data?.survey.closesAt]);

  function setAnswer(id: string, value: string | number | boolean) {
    setAnswers(prev => ({ ...prev, [id]: value }));
  }

  async function submit() {
    if (!data) return;
    const filled = Object.entries(answers).filter(([, v]) =>
      v !== '' && v !== null && v !== undefined,
    );
    if (filled.length === 0) {
      toast({ title: 'Please answer at least one question', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/surveys/${surveyId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: Object.fromEntries(filled) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Submission failed (${res.status})`);
      setThankYou(true);
      toast({ title: 'Thanks for the feedback!' });
    } catch (e) {
      toast({ title: 'Could not submit', description: String((e as Error).message), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal')} data-testid="button-back">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Post-event survey</h1>
            {data?.survey.tournamentName && (
              <p className="text-white/60 text-sm" data-testid="text-tournament-name">
                {data.survey.tournamentName}
              </p>
            )}
          </div>
        </div>

        {loading && (
          <Card className="bg-[#111827] border-[#1e2d3d] p-6">
            <p className="text-white/60 text-sm" data-testid="text-loading">Loading survey…</p>
          </Card>
        )}

        {!loading && error && (
          <Card className="bg-[#111827] border-red-500/30 p-6" data-testid="card-error">
            <p className="text-red-300 text-sm">{error}</p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => navigate('/portal')}
              data-testid="button-back-to-portal"
            >
              Back to portal
            </Button>
          </Card>
        )}

        {!loading && !error && data && thankYou && (
          <Card className="bg-[#111827] border-emerald-500/30 p-6 text-center" data-testid="card-thank-you">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-emerald-300" />
            <h2 className="text-xl font-semibold mb-1">Thanks for the feedback!</h2>
            <p className="text-sm text-white/60">
              Your answers have been shared with the organisers.
            </p>
            <Button
              className="mt-5"
              onClick={() => navigate('/portal')}
              style={{ backgroundColor: GOLD, color: '#000' }}
              data-testid="button-done"
            >
              Back to portal
            </Button>
          </Card>
        )}

        {!loading && !error && data && !thankYou && (
          <>
            {data.closed && (
              <Card className="bg-[#111827] border-amber-500/30 p-4 flex items-start gap-2" data-testid="card-closed">
                <Lock className="w-4 h-4 mt-0.5 text-amber-300" />
                <div className="text-sm">
                  <p className="font-medium text-amber-300">This survey is closed</p>
                  <p className="text-white/60">
                    {closesLabel ? `Responses closed ${closesLabel}.` : 'Responses are no longer being accepted.'}
                  </p>
                </div>
              </Card>
            )}
            {!data.closed && closesLabel && (
              <p className="text-xs text-white/50" data-testid="text-closes-at">
                Open until {closesLabel}.
              </p>
            )}

            <Card className="bg-[#111827] border-[#1e2d3d] p-5 space-y-5" data-testid="card-questions">
              {questions.length === 0 && (
                <p className="text-sm text-white/60" data-testid="text-no-questions">
                  This survey has no questions yet.
                </p>
              )}
              {questions.map(q => (
                <div key={q.id} className="space-y-2" data-testid={`question-${q.id}`}>
                  <p className="text-sm font-medium">{q.prompt}</p>
                  {q.type === 'rating' && (
                    <div className="flex items-center gap-2">
                      {[1, 2, 3, 4, 5].map(n => {
                        const selected = answers[q.id] === n;
                        return (
                          <button
                            key={n}
                            type="button"
                            disabled={disabled}
                            onClick={() => setAnswer(q.id, n)}
                            data-testid={`rating-${q.id}-${n}`}
                            className={`w-10 h-10 rounded-full border text-sm font-semibold transition-colors ${
                              selected
                                ? 'border-transparent text-black'
                                : 'border-white/20 text-white/80 hover:border-white/40'
                            }`}
                            style={selected ? { backgroundColor: GOLD } : undefined}
                          >
                            {n}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q.type === 'boolean' && (
                    <div className="flex items-center gap-2">
                      {[
                        { label: 'Yes', value: true },
                        { label: 'No', value: false },
                      ].map(opt => {
                        const selected = answers[q.id] === opt.value;
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={disabled}
                            onClick={() => setAnswer(q.id, opt.value)}
                            data-testid={`boolean-${q.id}-${opt.label.toLowerCase()}`}
                            className={`px-4 py-2 rounded-md border text-sm transition-colors ${
                              selected
                                ? 'border-transparent text-black'
                                : 'border-white/20 text-white/80 hover:border-white/40'
                            }`}
                            style={selected ? { backgroundColor: GOLD } : undefined}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q.type === 'text' && (
                    <Textarea
                      value={(answers[q.id] as string | undefined) ?? ''}
                      onChange={e => setAnswer(q.id, e.target.value)}
                      disabled={disabled}
                      rows={3}
                      maxLength={2000}
                      placeholder="Share your thoughts…"
                      data-testid={`text-${q.id}`}
                      className="bg-black/40 border-white/10 text-white"
                    />
                  )}
                </div>
              ))}

              {questions.length > 0 && (
                <div className="flex justify-end pt-2">
                  <Button
                    onClick={submit}
                    disabled={disabled}
                    data-testid="button-submit"
                    style={{ backgroundColor: GOLD, color: '#000' }}
                  >
                    <Send className="w-4 h-4 mr-2" />
                    {submitting ? 'Sending…' : 'Submit answers'}
                  </Button>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
