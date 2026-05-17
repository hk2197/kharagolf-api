import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Webhook, Plus, Trash2, Edit2, ToggleLeft, ToggleRight,
  RefreshCw, Play, ChevronDown, ChevronUp, Eye, EyeOff,
  Copy, CheckCircle2, XCircle, Clock, AlertTriangle,
  Shield, Zap, Code2, ExternalLink,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Label } from '@/components/ui/label';

interface WebhookEndpoint {
  id: number;
  organizationId: number;
  name: string;
  url: string;
  secret: string;
  subscribedEvents: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryLog {
  id: number;
  endpointId: number;
  eventType: string;
  payload: Record<string, unknown>;
  statusCode: number | null;
  responseTimeMs: number | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  deliveredAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const ALL_EVENTS = [
  { value: 'player.registered', label: 'Player Registered', desc: 'Fired when a player registers for a tournament' },
  { value: 'player.checked_in', label: 'Player Checked In', desc: 'Fired when a player checks in on event day' },
  { value: 'score.submitted', label: 'Score Submitted', desc: 'Fired when a hole score is submitted' },
  { value: 'score.updated', label: 'Score Updated', desc: 'Fired when a previously submitted score is corrected' },
  { value: 'tournament.published', label: 'Tournament Published', desc: 'Fired when a tournament is made live' },
  { value: 'tournament.completed', label: 'Tournament Completed', desc: 'Fired when results are finalised' },
  { value: 'league.round_completed', label: 'League Round Completed', desc: 'Fired when a league round is scored and standings updated' },
  { value: 'payment.received', label: 'Payment Received', desc: 'Fired when an entry fee payment is confirmed' },
  { value: 'handicap.updated', label: 'Handicap Updated', desc: 'Fired when a player handicap override is set' },
  { value: 'member.joined', label: 'Member Joined', desc: 'Fired when a member is added to the organisation' },
  { value: 'member.removed', label: 'Member Removed', desc: 'Fired when a member is removed from the organisation' },
];

function api(path: string, opts?: RequestInit) {
  return fetch(path, { credentials: 'include', ...opts });
}

function StatusBadge({ log }: { log: DeliveryLog }) {
  if (log.deliveredAt) {
    return <Badge className="bg-green-100 text-green-800 gap-1"><CheckCircle2 className="h-3 w-3" />{log.statusCode}</Badge>;
  }
  if (log.statusCode) {
    return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />{log.statusCode}</Badge>;
  }
  return <Badge variant="secondary" className="gap-1"><AlertTriangle className="h-3 w-3" />Error</Badge>;
}

function DeliveryLogRow({ log }: { log: DeliveryLog }) {
  const [expanded, setExpanded] = useState(false);
  const [showPayload, setShowPayload] = useState(false);

  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge log={log} />
          <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{log.eventType}</span>
          {log.responseTimeMs != null && (
            <span className="text-xs text-muted-foreground">{log.responseTimeMs}ms</span>
          )}
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {log.attemptCount} attempt{log.attemptCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-muted-foreground hidden md:inline">
            {log.createdAt ? new Date(log.createdAt).toLocaleString() : '—'}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-2 pt-1 border-t">
          {log.errorMessage && (
            <div className="text-xs text-destructive bg-destructive/10 rounded p-2">{log.errorMessage}</div>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowPayload(p => !p)}>
              {showPayload ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
              {showPayload ? 'Hide' : 'Show'} Payload
            </Button>
          </div>
          {showPayload && (
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-48 font-mono">
              {JSON.stringify(log.payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface EndpointFormProps {
  orgId: number;
  existing?: WebhookEndpoint;
  onClose: () => void;
  onSaved: () => void;
}

function EndpointForm({ orgId, existing, onClose, onSaved }: EndpointFormProps) {
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [events, setEvents] = useState<string[]>(existing?.subscribedEvents ?? []);
  const [saving, setSaving] = useState(false);

  const toggleEvent = (evt: string) => {
    setEvents(prev => prev.includes(evt) ? prev.filter(e => e !== evt) : [...prev, evt]);
  };

  const selectAll = () => setEvents(ALL_EVENTS.map(e => e.value));
  const clearAll = () => setEvents([]);

  const save = async () => {
    if (!name.trim() || !url.trim()) {
      toast({ title: 'Name and URL are required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const method = existing ? 'PUT' : 'POST';
      const path = existing
        ? `/api/organizations/${orgId}/webhooks/${existing.id}`
        : `/api/organizations/${orgId}/webhooks`;
      const res = await api(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, subscribedEvents: events }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Save failed');
      }
      toast({ title: existing ? 'Webhook updated' : 'Webhook created' });
      onSaved();
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Accounting System" className="mt-1" />
      </div>
      <div>
        <Label>Endpoint URL</Label>
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-system.example.com/webhook" className="mt-1" />
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label>Events to subscribe</Label>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={selectAll}>All</Button>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={clearAll}>None</Button>
          </div>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto border rounded-lg p-3">
          {ALL_EVENTS.map(evt => (
            <div key={evt.value} className="flex items-start gap-2">
              <Checkbox
                id={evt.value}
                checked={events.includes(evt.value)}
                onCheckedChange={() => toggleEvent(evt.value)}
                className="mt-0.5"
              />
              <label htmlFor={evt.value} className="cursor-pointer flex-1">
                <div className="text-sm font-medium">{evt.label}</div>
                <div className="text-xs text-muted-foreground">{evt.desc}</div>
              </label>
            </div>
          ))}
        </div>
        {events.length === 0 && (
          <p className="text-xs text-amber-600 mt-1">Select at least one event to receive deliveries.</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create webhook'}
        </Button>
      </DialogFooter>
    </div>
  );
}

interface EndpointCardProps {
  ep: WebhookEndpoint;
  orgId: number;
  onRefresh: () => void;
}

function EndpointCard({ ep, orgId, onRefresh }: EndpointCardProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showLogs, setShowLogs] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: logs } = useQuery<DeliveryLog[]>({
    queryKey: [`/api/organizations/${orgId}/webhooks/${ep.id}/logs`],
    queryFn: () => api(`/api/organizations/${orgId}/webhooks/${ep.id}/logs`).then(r => r.json()),
    enabled: showLogs,
    refetchInterval: showLogs ? 10_000 : false,
  });

  const toggle = async () => {
    const res = await api(`/api/organizations/${orgId}/webhooks/${ep.id}/toggle`, { method: 'PATCH' });
    if (res.ok) { onRefresh(); toast({ title: ep.isActive ? 'Webhook deactivated' : 'Webhook activated' }); }
  };

  const regenerateSecret = async () => {
    const res = await api(`/api/organizations/${orgId}/webhooks/${ep.id}/regenerate-secret`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      await qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/webhooks`] });
      onRefresh();
      toast({ title: 'Secret regenerated', description: 'Update your endpoint to use the new secret.' });
      void data;
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api(`/api/organizations/${orgId}/webhooks/${ep.id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        toast({ title: `Test delivered (${data.statusCode})`, description: `Response time: ${data.responseTimeMs}ms` });
      } else {
        toast({ title: `Test failed (${data.statusCode ?? 'network error'})`, description: data.error, variant: 'destructive' });
      }
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/webhooks/${ep.id}/logs`] });
    } finally {
      setTesting(false);
    }
  };

  const deleteEndpoint = async () => {
    const res = await api(`/api/organizations/${orgId}/webhooks/${ep.id}`, { method: 'DELETE' });
    if (res.ok) { onRefresh(); toast({ title: 'Webhook deleted' }); }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(ep.secret);
    toast({ title: 'Secret copied to clipboard' });
  };

  const lastDelivery = logs?.[0];
  const recentSuccess = logs?.slice(0, 5).some(l => l.deliveredAt);

  return (
    <>
      <Card className={ep.isActive ? '' : 'opacity-60'}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base">{ep.name}</CardTitle>
                <Badge variant={ep.isActive ? 'default' : 'secondary'}>
                  {ep.isActive ? 'Active' : 'Inactive'}
                </Badge>
                {lastDelivery && (
                  <Badge variant={recentSuccess ? 'outline' : 'destructive'} className="text-xs">
                    {recentSuccess ? 'Healthy' : 'Failing'}
                  </Badge>
                )}
              </div>
              <a
                href={ep.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:underline flex items-center gap-1 mt-0.5 truncate"
              >
                {ep.url}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggle} title={ep.isActive ? 'Deactivate' : 'Activate'}>
                {ep.isActive ? <ToggleRight className="h-4 w-4 text-green-600" /> : <ToggleLeft className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(true)} title="Edit">
                <Edit2 className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} title="Delete">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center gap-1 mb-1.5">
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Signing Secret</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono flex-1 truncate">
                {showSecret ? ep.secret : '••••••••••••••••••••••••••••••••'}
              </code>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowSecret(s => !s)}>
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copySecret}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={regenerateSecret} title="Regenerate secret">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Verify incoming requests using the <code className="text-xs">X-KharaGolf-Signature</code> header (HMAC-SHA256).
            </p>
          </div>

          {ep.subscribedEvents.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Subscribed Events ({ep.subscribedEvents.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {ep.subscribedEvents.map(evt => (
                  <Badge key={evt} variant="outline" className="text-xs font-mono">{evt}</Badge>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={sendTest} disabled={testing}>
              <Play className="h-3.5 w-3.5 mr-1" />
              {testing ? 'Sending…' : 'Test'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLogs(s => !s)}
              className="gap-1"
            >
              <Code2 className="h-3.5 w-3.5" />
              {showLogs ? 'Hide' : 'Delivery'} Logs
              {logs && <Badge variant="secondary" className="h-4 text-xs px-1 ml-0.5">{logs.length}</Badge>}
            </Button>
            {lastDelivery && (
              <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(lastDelivery.createdAt).toLocaleDateString()}
              </span>
            )}
          </div>

          {showLogs && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Recent Deliveries</span>
                <span className="text-xs text-muted-foreground">Last 50</span>
              </div>
              {!logs ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : logs.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">
                  No deliveries yet. Use the Test button to send a sample payload.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {logs.map(log => <DeliveryLogRow key={log.id} log={log} />)}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Webhook</DialogTitle>
          </DialogHeader>
          <EndpointForm
            orgId={orgId}
            existing={ep}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); onRefresh(); }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Webhook</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{ep.name}</strong>? This will also remove all delivery logs.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setConfirmDelete(false); deleteEndpoint(); }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function WebhooksPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: endpoints, isLoading } = useQuery<WebhookEndpoint[]>({
    queryKey: [`/api/organizations/${orgId}/webhooks`],
    queryFn: () => api(`/api/organizations/${orgId}/webhooks`).then(r => r.json()),
    enabled: !!orgId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/webhooks`] });

  if (!orgId) return null;

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Webhook className="h-6 w-6" />
            Webhooks
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Push events to external systems — accounting software, CRM, national handicap bodies, and more.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Endpoint
        </Button>
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="py-4">
          <div className="flex gap-3">
            <Shield className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-800">Signature verification</p>
              <p className="text-amber-700 mt-0.5">
                Every delivery includes a <code className="text-xs bg-amber-100 px-1 rounded">X-KharaGolf-Signature</code> header
                containing <code className="text-xs bg-amber-100 px-1 rounded">sha256=&lt;hmac&gt;</code> computed over the JSON body
                using your endpoint's secret. Verify this on your server before trusting the payload.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading webhooks…</div>
      ) : !endpoints || endpoints.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent>
            <Webhook className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No webhooks configured</p>
            <p className="text-muted-foreground text-sm mt-1 mb-4">
              Register an endpoint to start receiving real-time event notifications.
            </p>
            <Button onClick={() => setCreating(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add your first webhook
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {endpoints.map(ep => (
            <EndpointCard key={ep.id} ep={ep} orgId={orgId} onRefresh={refresh} />
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Webhook Endpoint</DialogTitle>
          </DialogHeader>
          <EndpointForm
            orgId={orgId}
            onClose={() => setCreating(false)}
            onSaved={() => { setCreating(false); refresh(); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
