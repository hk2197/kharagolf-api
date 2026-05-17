import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import {
  Zap, Trophy, Users, BarChart3, Crown, Star, Shield, ArrowUpRight, AlertCircle, CheckCircle, Sliders,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface TierLimits {
  maxActiveTournaments: number | null;
  maxMembers: number | null;
  maxLeagues: number | null;
  whiteLabel: boolean;
  sponsorLogos: boolean;
  customDomain: boolean;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  marketplace?: boolean;
  aiRulesAssistant?: boolean;
  whsScoring?: boolean;
  duesBilling?: boolean;
  shopLockerAccess?: boolean;
  mobileApp?: boolean;
}

interface PlanStatus {
  tier: string;
  isActive: boolean;
  hasActiveOverride?: boolean;
  limits: TierLimits;
  usage: {
    activeTournaments: number;
    members: number;
    leagues: number;
  };
  tierDisplay: {
    label: string;
    priceMonthly: number;
    currency: string;
    description: string;
  };
}

const TIER_ICONS: Record<string, React.ReactNode> = {
  free: <Shield className="w-4 h-4" />,
  starter: <Zap className="w-4 h-4" />,
  pro: <Star className="w-4 h-4" />,
  enterprise: <Crown className="w-4 h-4" />,
};

const TIER_COLORS: Record<string, string> = {
  free: 'text-muted-foreground',
  starter: 'text-blue-400',
  pro: 'text-primary',
  enterprise: 'text-purple-400',
};

function UsageBar({ label, icon, current, max }: {
  label: string;
  icon: React.ReactNode;
  current: number;
  max: number | null;
}) {
  if (max === null) {
    return (
      <div className="flex items-center gap-3 py-2">
        <span className="text-muted-foreground">{icon}</span>
        <div className="flex-1">
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-primary flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Unlimited</span>
          </div>
        </div>
      </div>
    );
  }

  const pct = Math.min(100, Math.round((current / max) * 100));
  const isWarning = pct >= 80;
  const isCritical = pct >= 100;

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <div className="flex-1">
        <div className="flex items-center justify-between text-sm mb-1.5">
          <span className="text-muted-foreground">{label}</span>
          <span className={isCritical ? 'text-red-400 font-medium' : isWarning ? 'text-yellow-400' : 'text-white'}>
            {current} / {max}
          </span>
        </div>
        <Progress
          value={pct}
          className={`h-1.5 ${isCritical ? '[&>div]:bg-red-400' : isWarning ? '[&>div]:bg-yellow-400' : '[&>div]:bg-primary'}`}
        />
      </div>
    </div>
  );
}

function PlanPopoverContent({ plan, onNavigate }: { plan: PlanStatus; onNavigate: () => void }) {
  const allUnlimited =
    plan.limits.maxActiveTournaments === null &&
    plan.limits.maxMembers === null &&
    plan.limits.maxLeagues === null;

  const isAtLimit = !allUnlimited && (
    (plan.limits.maxActiveTournaments !== null && plan.usage.activeTournaments >= plan.limits.maxActiveTournaments) ||
    (plan.limits.maxMembers !== null && plan.usage.members >= plan.limits.maxMembers) ||
    (plan.limits.maxLeagues !== null && plan.usage.leagues >= plan.limits.maxLeagues)
  );

  return (
    <div className="w-64 bg-card border border-white/10 rounded-xl shadow-2xl p-3 space-y-1">
      <div className="flex items-center justify-between pb-1 border-b border-white/5 mb-1">
        <div className="flex items-center gap-2">
          <span className={TIER_COLORS[plan.tier]}>{TIER_ICONS[plan.tier]}</span>
          <span className="text-sm font-semibold text-white">{(plan.tierDisplay?.label ?? plan.tier)} Plan</span>
          {plan.hasActiveOverride && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5">
              <Sliders className="w-2.5 h-2.5" /> Custom
            </span>
          )}
        </div>
        {!plan.isActive && (
          <span className="text-xs text-red-400 flex items-center gap-0.5">
            <AlertCircle className="w-3 h-3" /> Suspended
          </span>
        )}
      </div>

      {allUnlimited && !plan.hasActiveOverride ? (
        <div className="flex items-center gap-2 py-2 text-sm text-primary">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span>All features included</span>
        </div>
      ) : (
        <>
          <UsageBar
            label="Tournaments"
            icon={<Trophy className="w-4 h-4" />}
            current={plan.usage.activeTournaments}
            max={plan.limits.maxActiveTournaments}
          />
          <UsageBar
            label="Members"
            icon={<Users className="w-4 h-4" />}
            current={plan.usage.members}
            max={plan.limits.maxMembers}
          />
          <UsageBar
            label="Leagues"
            icon={<BarChart3 className="w-4 h-4" />}
            current={plan.usage.leagues}
            max={plan.limits.maxLeagues}
          />
        </>
      )}

      {isAtLimit && (
        <div className="p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 mt-1">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-red-400 font-medium">Plan limit reached</p>
            <p className="text-xs text-muted-foreground">Upgrade to continue growing your club.</p>
          </div>
        </div>
      )}

      {plan.tier !== 'enterprise' && (
        <button
          onClick={onNavigate}
          className="w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold transition-colors"
        >
          Upgrade Plan <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/** Compact single-row plan strip for expanded sidebar */
export function PlanStrip({ orgId }: { orgId: number | undefined }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: plan } = useQuery<PlanStatus>({
    queryKey: [`/api/organizations/${orgId}/plan`],
    queryFn: () => fetch(`/api/organizations/${orgId}/plan`).then(r => r.json()),
    enabled: !!orgId,
    staleTime: 60000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (!plan || !plan.tierDisplay) return null;

  const isSuspended = !plan.isActive;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group"
      >
        <span className={`relative flex-shrink-0 ${TIER_COLORS[plan.tier]}`}>
          {TIER_ICONS[plan.tier]}
          {isSuspended && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 border border-card" />
          )}
        </span>
        <span className="text-sm text-white flex-1 text-left truncate">
          {(plan.tierDisplay?.label ?? plan.tier)} Plan
        </span>
        {plan.tier !== 'enterprise' && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); navigate('/admin#billing'); }}
            className="text-[11px] text-emerald-300 hover:text-emerald-200 flex items-center gap-0.5 flex-shrink-0"
          >
            Upgrade <ArrowUpRight className="w-3 h-3" />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 z-50">
          <PlanPopoverContent plan={plan} onNavigate={() => { navigate('/admin#billing'); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

/** Plan icon-only for collapsed sidebar */
export function PlanStripCollapsed({ orgId }: { orgId: number | undefined }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: plan } = useQuery<PlanStatus>({
    queryKey: [`/api/organizations/${orgId}/plan`],
    queryFn: () => fetch(`/api/organizations/${orgId}/plan`).then(r => r.json()),
    enabled: !!orgId,
    staleTime: 60000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (!plan || !plan.tierDisplay) return null;

  const isSuspended = !plan.isActive;
  const tooltipLabel = `${(plan.tierDisplay?.label ?? plan.tier)} Plan${isSuspended ? ' (Suspended)' : ''}`;

  return (
    <div ref={ref} className="relative flex justify-center">
      <button
        title={tooltipLabel}
        onClick={() => setOpen(o => !o)}
        className={`relative group flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/5 transition-colors ${TIER_COLORS[plan.tier]}`}
      >
        {TIER_ICONS[plan.tier]}
        {isSuspended && (
          <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500 border border-card" />
        )}
        <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md bg-black/90 border border-white/10 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
          {tooltipLabel}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-full ml-2 mb-0 z-50">
          <PlanPopoverContent plan={plan} onNavigate={() => { navigate('/admin#billing'); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

export function PlanUsageCard() {
  const { data: user } = useGetMe();
  const [, navigate] = useLocation();
  const orgId = user?.organizationId;

  const { data: plan } = useQuery<PlanStatus>({
    queryKey: [`/api/organizations/${orgId}/plan`],
    queryFn: () => fetch(`/api/organizations/${orgId}/plan`).then(r => r.json()),
    enabled: !!orgId,
    staleTime: 60000,
  });

  if (!plan || !plan.tierDisplay) return null;

  const allUnlimited =
    plan.limits.maxActiveTournaments === null &&
    plan.limits.maxMembers === null &&
    plan.limits.maxLeagues === null;

  const noActiveOverride = !plan.hasActiveOverride;

  const isAtLimit = !allUnlimited && (
    (plan.limits.maxActiveTournaments !== null && plan.usage.activeTournaments >= plan.limits.maxActiveTournaments) ||
    (plan.limits.maxMembers !== null && plan.usage.members >= plan.limits.maxMembers) ||
    (plan.limits.maxLeagues !== null && plan.usage.leagues >= plan.limits.maxLeagues)
  );

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={TIER_COLORS[plan.tier]}>{TIER_ICONS[plan.tier]}</span>
          <span className="text-sm font-semibold text-white">{(plan.tierDisplay?.label ?? plan.tier)} Plan</span>
          {plan.hasActiveOverride && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5">
              <Sliders className="w-2.5 h-2.5" /> Custom
            </span>
          )}
          {!plan.isActive && (
            <span className="text-xs text-red-400 flex items-center gap-0.5">
              <AlertCircle className="w-3 h-3" /> Suspended
            </span>
          )}
        </div>
        {plan.tier !== 'enterprise' && (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-emerald-300 hover:text-emerald-200 h-6 px-2"
            onClick={() => navigate('/admin#billing')}
          >
            Upgrade <ArrowUpRight className="w-3 h-3 ml-0.5" />
          </Button>
        )}
      </div>

      {allUnlimited && noActiveOverride ? (
        <div className="flex items-center gap-2 py-1 text-sm text-primary">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span>All features included</span>
        </div>
      ) : (
        <>
          <UsageBar
            label="Tournaments"
            icon={<Trophy className="w-4 h-4" />}
            current={plan.usage.activeTournaments}
            max={plan.limits.maxActiveTournaments}
          />
          <UsageBar
            label="Members"
            icon={<Users className="w-4 h-4" />}
            current={plan.usage.members}
            max={plan.limits.maxMembers}
          />
          <UsageBar
            label="Leagues"
            icon={<BarChart3 className="w-4 h-4" />}
            current={plan.usage.leagues}
            max={plan.limits.maxLeagues}
          />
        </>
      )}

      {isAtLimit && (
        <div className="p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 mt-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-red-400 font-medium">Plan limit reached</p>
            <p className="text-xs text-muted-foreground">Upgrade to continue growing your club.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline upgrade prompt shown when an API returns a featureGate error
export function UpgradePrompt({ message, currentTier, requiredTier, onDismiss }: {
  message: string;
  currentTier?: string;
  requiredTier?: string;
  onDismiss?: () => void;
}) {
  const [, navigate] = useLocation();

  const requiredLabel: Record<string, string> = {
    free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise',
  };

  return (
    <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm text-amber-400 font-medium mb-1">Plan Limit Reached</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        {requiredTier && (
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" onClick={() => navigate('/admin#billing')} className="bg-amber-500 hover:bg-amber-600 text-black font-semibold text-xs h-7">
              Upgrade to {requiredLabel[requiredTier] ?? requiredTier}
            </Button>
            {onDismiss && (
              <Button size="sm" variant="ghost" onClick={onDismiss} className="text-xs h-7 text-muted-foreground">
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
