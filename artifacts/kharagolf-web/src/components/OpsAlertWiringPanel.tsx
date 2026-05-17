import type { ReactElement } from 'react';
import { Check, X, AlertCircle, Loader2, BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shared, sanitized chat-channel configuration shape used by every
 * `OPS_ALERT_*` flow (Task #2057). Booleans only — never carries the
 * webhook URL or routing key, so a UI render of this struct can't
 * accidentally leak credentials into a screenshot or browser console.
 */
export interface OpsAlertChatTargetsStatus {
  slackConfigured: boolean;
  pagerDutyConfigured: boolean;
}

/**
 * Per-channel result of a "Send test page" call. `attempted` is false
 * when the channel wasn't configured at all (no env var set). When
 * `attempted` is true, `ok` reflects whether the underlying sender
 * resolved successfully; `error` carries the error message on failure.
 *
 * Mirrors the server-side `WatchGpsOpsAlertChatTestResult` channel
 * shape so every per-flow response can use the same FE renderer.
 */
export interface OpsAlertWiringTestChannelResult {
  configured: boolean;
  attempted: boolean;
  ok: boolean;
  error: string | null;
}

export interface OpsAlertWiringTestResult {
  targets: OpsAlertChatTargetsStatus;
  slack: OpsAlertWiringTestChannelResult;
  pagerDuty: OpsAlertWiringTestChannelResult;
}

export interface OpsAlertWiringPanelProps {
  /** Sanitized status from the server. When undefined the panel
   *  renders nothing — keeps the call site free of conditionals. */
  chatTargets: OpsAlertChatTargetsStatus | null | undefined;
  /** Short label for the alert flow (e.g. "Spike alert"). */
  label: string;
  /** Human-readable name of the flow's dedicated Slack env var, used
   *  in the tooltip + the "no channels configured" copy so an admin
   *  can copy the env var name straight out of the UI. */
  slackEnvVar: string;
  /** Human-readable name of the flow's dedicated PagerDuty env var. */
  pagerDutyEnvVar: string;
  /** Triggered when the admin clicks "Send test page". */
  onSendTestPage: () => void;
  /** Whether the test-page mutation is in flight. */
  isSending: boolean;
  /**
   * Stable test-id prefix so each panel instance gets unique data-testids
   * (e.g. `panel-watch-ops-alert-wiring`). Mirrors the watch-GPS panel
   * naming so existing E2E tests keep working when that panel is
   * migrated onto this shared component.
   */
  testIdPrefix: string;
}

/**
 * Shared render of the "Slack ✓ / PagerDuty ✗" wiring badges plus a
 * "Send test page" button (Task #2057). Originally inlined on the
 * watch-GPS panel (Task #1653); extracted here so the badge-share
 * rollup, manual-entry alert health, and notify-retry exhaustion
 * dashboards can mount the exact same pattern without copy-paste, and
 * so any future ops-alert flow inherits the same UI for free.
 *
 * Renders nothing when `chatTargets` is missing — useful while the
 * outer query is still loading, and also for the (unusual) case where
 * a deploy intentionally hides the wiring badges from the UI by
 * omitting the field from the API response.
 */
export function OpsAlertWiringPanel({
  chatTargets,
  label,
  slackEnvVar,
  pagerDutyEnvVar,
  onSendTestPage,
  isSending,
  testIdPrefix,
}: OpsAlertWiringPanelProps): ReactElement | null {
  if (!chatTargets) return null;
  const noneConfigured =
    !chatTargets.slackConfigured && !chatTargets.pagerDutyConfigured;
  return (
    <div
      className="flex items-center justify-between gap-3 flex-wrap mb-4 rounded-lg border border-border bg-card/60 px-3 py-2"
      data-testid={`panel-${testIdPrefix}-wiring`}
    >
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-muted-foreground font-medium">{label}:</span>
        <span
          className={`flex items-center gap-1 ${
            chatTargets.slackConfigured
              ? 'text-emerald-400'
              : 'text-muted-foreground'
          }`}
          data-testid={`status-${testIdPrefix}-slack`}
          title={
            chatTargets.slackConfigured
              ? `${slackEnvVar} is set`
              : `${slackEnvVar} is not set`
          }
        >
          {chatTargets.slackConfigured ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <X className="w-3.5 h-3.5" />
          )}
          Slack
        </span>
        <span
          className={`flex items-center gap-1 ${
            chatTargets.pagerDutyConfigured
              ? 'text-emerald-400'
              : 'text-muted-foreground'
          }`}
          data-testid={`status-${testIdPrefix}-pagerduty`}
          title={
            chatTargets.pagerDutyConfigured
              ? `${pagerDutyEnvVar} is set`
              : `${pagerDutyEnvVar} is not set`
          }
        >
          {chatTargets.pagerDutyConfigured ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <X className="w-3.5 h-3.5" />
          )}
          PagerDuty
        </span>
        {noneConfigured && (
          <span
            className="text-amber-400 flex items-center gap-1"
            data-testid={`status-${testIdPrefix}-none`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            No chat channels configured — a real alert will only warn-log
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={isSending || noneConfigured}
        onClick={onSendTestPage}
        data-testid={`button-${testIdPrefix}-test-page`}
        title={
          noneConfigured
            ? 'Set the Slack webhook or PagerDuty routing key first'
            : 'Fire a clearly-labelled test page through the same Slack / PagerDuty senders the real alert uses'
        }
      >
        {isSending ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        ) : (
          <BellRing className="w-3.5 h-3.5 mr-1.5" />
        )}
        Send test page
      </Button>
    </div>
  );
}
