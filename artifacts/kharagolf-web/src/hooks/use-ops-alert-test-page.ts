import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import type {
  OpsAlertWiringTestResult,
  OpsAlertChatTargetsStatus,
} from '@/components/OpsAlertWiringPanel';

export interface UseOpsAlertTestPageMutationOpts {
  /**
   * Absolute API path of the per-flow `/test-ops-alert-chat` endpoint
   * (e.g. `/api/super-admin/badge-share-rollup/test-ops-alert-chat`).
   * Required so each call site picks the right per-flow handler — the
   * shared hook never assumes a default.
   */
  endpoint: string;
  /**
   * Query key (or keys) to invalidate on a successful test send so the
   * surrounding panel re-fetches its `chatTargets` and reflects any
   * env-var change ops just made before clicking the button. Optional:
   * pass nothing if the panel doesn't fetch chatTargets via react-query
   * (no-op fallback keeps the call site simple).
   */
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  /**
   * Names of the dedicated env vars surfaced in the "no chat channels
   * configured" toast so an admin can copy them straight out of the
   * toast. The shared `OPS_ALERT_*` fallback pair is always mentioned
   * by the toast in addition.
   */
  slackEnvVar: string;
  pagerDutyEnvVar: string;
}

/**
 * Shared mutation + toast wiring for "Send test page" buttons across
 * every ops-alert wiring panel (Task #2057). Pulls together the four
 * pieces every call site used to copy-paste:
 *   1. the POST → `OpsAlertWiringTestResult` round-trip,
 *   2. invalidating the panel's query so the chat-targets badge
 *      reflects the latest env-var state,
 *   3. parsing the per-channel result into a single toast that names
 *      every channel that was attempted (`Slack ✓ · PagerDuty ✗ (404)`),
 *   4. distinguishing the three end states the original watch-GPS
 *      mutation introduced (Task #1653) — no channels configured /
 *      all attempted channels OK / partial failure — each with its
 *      own toast variant so the admin sees the right urgency.
 *
 * Returns the same `useMutation` result shape callers already destructure,
 * so a panel can pass `.isPending` straight through to the shared
 * `OpsAlertWiringPanel` and call `.mutate()` from its onClick.
 */
export function useOpsAlertTestPageMutation(opts: UseOpsAlertTestPageMutationOpts) {
  const { endpoint, invalidateQueryKeys, slackEnvVar, pagerDutyEnvVar } = opts;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return useMutation<OpsAlertWiringTestResult, Error, void>({
    mutationFn: async () => {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `Failed to send test page (${r.status})`);
      }
      return r.json() as Promise<OpsAlertWiringTestResult>;
    },
    onSuccess: (data) => {
      if (invalidateQueryKeys) {
        for (const key of invalidateQueryKeys) {
          queryClient.invalidateQueries({ queryKey: key as readonly unknown[] });
        }
      }
      const attempts: string[] = [];
      if (data.slack.attempted) {
        attempts.push(
          data.slack.ok ? 'Slack ✓' : `Slack ✗ (${data.slack.error ?? 'unknown error'})`,
        );
      }
      if (data.pagerDuty.attempted) {
        attempts.push(
          data.pagerDuty.ok
            ? 'PagerDuty ✓'
            : `PagerDuty ✗ (${data.pagerDuty.error ?? 'unknown error'})`,
        );
      }
      const anyAttempted = data.slack.attempted || data.pagerDuty.attempted;
      const allOk =
        anyAttempted &&
        (!data.slack.attempted || data.slack.ok) &&
        (!data.pagerDuty.attempted || data.pagerDuty.ok);
      if (!anyAttempted) {
        toast({
          title: 'No ops chat channels configured',
          description: `Set ${slackEnvVar} and/or ${pagerDutyEnvVar} (or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY pair), then try again.`,
          variant: 'destructive',
        });
      } else if (allOk) {
        toast({
          title: 'Test page sent',
          description: `${attempts.join(' · ')}. Confirm it arrived in the channel(s).`,
        });
      } else {
        toast({
          title: 'Test page partially failed',
          description: attempts.join(' · '),
          variant: 'destructive',
        });
      }
    },
    onError: (err: Error) => {
      toast({ title: 'Test page failed', description: err.message, variant: 'destructive' });
    },
  });
}

// Re-export the panel types so call sites only import from one place
// when they wire both the hook and the panel together.
export type { OpsAlertWiringTestResult, OpsAlertChatTargetsStatus };
