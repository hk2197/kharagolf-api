import { useState, useEffect } from 'react';
import { useGetLeaderboard } from '@workspace/api-client-react';
import type { Leaderboard } from '@workspace/api-client-react/src/generated/api.schemas';

export function useLiveLeaderboard(orgId: number | undefined, tournamentId: number | undefined) {
  const enabled = !!(orgId && tournamentId);
  const { data: initialData, isLoading, error } = useGetLeaderboard(
    orgId as number, 
    tournamentId as number, 
    {}, 
    { query: { enabled } }
  );
  
  const [liveData, setLiveData] = useState<Leaderboard | undefined>(initialData);
  const [isConnected, setIsConnected] = useState(false);

  // Sync initial data when loaded
  useEffect(() => {
    if (initialData) setLiveData(initialData);
  }, [initialData]);

  // Establish SSE connection
  useEffect(() => {
    if (!enabled) return;

    let sse: EventSource | null = null;
    let reconnectTimer: number;

    const connect = () => {
      sse = new EventSource(`/api/sse/leaderboard/${tournamentId}`);
      
      sse.onopen = () => setIsConnected(true);
      
      sse.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'leaderboard_update') {
            setLiveData((prev: Leaderboard | undefined) => {
              if (!prev) return prev;
              const payload = msg.data as Record<string, unknown> | null;
              const entries = Array.isArray(payload) ? payload : (payload?.entries ?? prev.entries);
              const extra: Record<string, unknown> = {};
              if (!Array.isArray(payload)) {
                if (payload?.leaderboardType != null) extra.leaderboardType = payload.leaderboardType;
                if (payload?.tiebreakerMethod != null) extra.tiebreakerMethod = payload.tiebreakerMethod;
                if (payload?.teamEntries != null) extra.teamEntries = payload.teamEntries;
                if (payload?.isTeamFormat != null) extra.isTeamFormat = payload.isTeamFormat;
                if (payload?.netEntries != null) extra.netEntries = payload.netEntries;
                if (payload?.stablefordEntries != null) extra.stablefordEntries = payload.stablefordEntries;
                if (payload?.availableViews != null) extra.availableViews = payload.availableViews;
              }
              return { ...prev, ...extra, entries, lastUpdated: new Date().toISOString() } as Leaderboard;
            });
          }
        } catch (err) {
          console.error('[SSE] Failed to parse message', err);
        }
      };
      
      sse.onerror = () => {
        setIsConnected(false);
        sse?.close();
        // Auto-reconnect with backoff
        reconnectTimer = window.setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      if (sse) sse.close();
      clearTimeout(reconnectTimer);
    };
  }, [tournamentId, enabled]);

  return { 
    data: liveData || initialData, 
    isLoading, 
    error, 
    isConnected 
  };
}
