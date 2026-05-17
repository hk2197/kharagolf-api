import { useState } from 'react';
import { useParams } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Shield, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

interface PeerReviewInfo {
  expired: boolean;
  alreadyResponded: boolean;
  invitedAt: string;
  respondedAt: string | null;
  recommendation: 'confirm' | 'dispute' | 'insufficient_info' | null;
  comment: string | null;
  case: {
    kind: string;
    status: string;
    details: string | null;
    periodLabel: string | null;
    subjectName: string | null;
    orgName: string | null;
  };
}

const KIND_LABEL: Record<string, string> = {
  anomalous: 'Anomalous Score Review',
  not_posted: 'Score Not Posted',
  exceptional: 'Exceptional Score Review',
  annual: 'Annual Handicap Review',
};

type Recommendation = 'confirm' | 'dispute' | 'insufficient_info';

export default function PeerReviewPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { toast } = useToast();
  const [recommendation, setRecommendation] = useState<Recommendation | ''>('');
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const infoQ = useQuery<PeerReviewInfo>({
    queryKey: ['peer-review', token],
    queryFn: async () => {
      const r = await fetch(`/api/public/peer-review/${token}`);
      if (!r.ok) throw new Error((await r.json()).error || 'Invalid or expired link');
      return r.json();
    },
    retry: false,
    enabled: !!token,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/public/peer-review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recommendation, comment }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed to submit');
      return r.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      toast({ title: 'Thank you', description: 'Your peer review has been recorded.' });
    },
    onError: (e: Error) => toast({ title: 'Submit failed', description: e.message, variant: 'destructive' }),
  });

  if (infoQ.isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (infoQ.isError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-3">
            <AlertCircle className="h-10 w-10 mx-auto text-red-500" />
            <p className="font-medium">Link is invalid or expired</p>
            <p className="text-sm text-muted-foreground">{(infoQ.error as Error).message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  const info = infoQ.data!;
  const alreadyResponded = info.alreadyResponded || info.expired || submitted;

  return (
    <div className="min-h-screen bg-muted/30 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Shield className="h-7 w-7 text-blue-500" />
          <h1 className="text-2xl font-semibold">Handicap Peer Review</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{KIND_LABEL[info.case.kind] || info.case.kind}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Player:</span> <strong>{info.case.subjectName ?? '—'}</strong></p>
            <p><span className="text-muted-foreground">Club:</span> {info.case.orgName ?? '—'}</p>
            {info.case.periodLabel && (
              <p><span className="text-muted-foreground">Period:</span> {info.case.periodLabel}</p>
            )}
            {info.case.details && (
              <div className="p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">{info.case.details}</div>
            )}
            <p className="text-xs text-muted-foreground">
              Invited {new Date(info.invitedAt).toLocaleString()}
              {info.respondedAt && ` · Responded ${new Date(info.respondedAt).toLocaleString()}`}
            </p>
          </CardContent>
        </Card>

        {info.expired && !info.alreadyResponded ? (
          <Card>
            <CardContent className="pt-6 text-center space-y-2">
              <AlertCircle className="h-10 w-10 mx-auto text-amber-500" />
              <p className="font-medium">This invitation has expired</p>
              <p className="text-xs text-muted-foreground">
                Please contact the handicap committee to request a new invitation.
              </p>
            </CardContent>
          </Card>
        ) : alreadyResponded ? (
          <Card>
            <CardContent className="pt-6 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 mx-auto text-green-500" />
              <p className="font-medium">Your response has been recorded</p>
              {info.recommendation && (
                <p className="text-sm text-muted-foreground">
                  Recommendation: <strong>{info.recommendation.replace('_', ' ')}</strong>
                </p>
              )}
              {info.comment && (
                <p className="text-sm italic text-muted-foreground">"{info.comment}"</p>
              )}
              <p className="text-xs text-muted-foreground">
                You can close this page. The committee has been notified.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your peer perspective</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Do you agree with the committee's concern? <span className="text-red-500">*</span></label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { v: 'confirm', label: 'Confirm', icon: CheckCircle2, cls: 'text-green-600 border-green-300' },
                    { v: 'dispute', label: 'Dispute', icon: XCircle, cls: 'text-red-600 border-red-300' },
                    { v: 'insufficient_info', label: 'Need more info', icon: AlertCircle, cls: 'text-gray-600 border-gray-300' },
                  ] as const).map(opt => (
                    <Button
                      key={opt.v}
                      type="button"
                      variant={recommendation === opt.v ? 'default' : 'outline'}
                      className={recommendation === opt.v ? '' : opt.cls}
                      onClick={() => setRecommendation(opt.v)}
                    >
                      <opt.icon className="h-4 w-4 mr-1.5" /> {opt.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Comments <span className="text-red-500">*</span></label>
                <Textarea
                  rows={5}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Share your perspective. The committee will read your comment as part of their review."
                />
              </div>
              <Button
                className="w-full"
                disabled={submit.isPending || !recommendation || !comment.trim()}
                onClick={() => submit.mutate()}
              >
                {submit.isPending ? 'Submitting…' : 'Submit Peer Review'}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Your response is recorded in the case audit log and visible to the committee.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
