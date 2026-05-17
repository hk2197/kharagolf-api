/**
 * Task #1160 / #1591 — Holes query with offline cached-bundle fallback.
 *
 * Wraps a `useQuery` against `/tournaments/:id/holes?round=...` so that when
 * the live call rejects mid-round (network drop, server hiccup) the score
 * screen can keep rendering the in-round scorecard by projecting the
 * AsyncStorage-cached course bundle through `bundleToHolesResponse`.
 *
 * Owns its own `usingCachedCourse` boolean so callers can OR it with other
 * cached-source signals (HoleMapSheet, CaddieCard) into the round-level
 * indicator threaded through GpsDistanceRow.
 *
 * Lifted out of `app/(tabs)/score.tsx` so the fallback wiring is unit-
 * testable without mounting the 5.8k-line score screen.
 */
import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchPublic } from "@/utils/api";
import {
  loadCachedCourseBundleForRound,
  bundleToHolesResponse,
  type BundleHolesProjection,
} from "@/utils/courseBundle";

export interface HoleInfo {
  holeNumber: number;
  par: number;
  handicap?: number;
  yardageBlue?: number;
  yardageWhite?: number;
  yardageRed?: number;
  description?: string | null;
  greenFrontLat?: string | null;
  greenFrontLng?: string | null;
  greenCentreLat?: string | null;
  greenCentreLng?: string | null;
  greenBackLat?: string | null;
  greenBackLng?: string | null;
}

export interface HolesResponse {
  holes: HoleInfo[];
  rounds: number;
  courseRating?: number | null;
  courseSlope?: number | null;
  coursePar?: number | null;
  // Wave 1 W1-B — surfaced so the mobile app can pre-cache the offline
  // course bundle (`/organizations/:orgId/courses/:courseId/bundle`) when a
  // round starts.
  courseId?: number | null;
  organizationId?: number | null;
}

/** True after the most recent fetch attempt fell back to the cached bundle. */
export type UseHolesWithCachedFallbackResult =
  UseQueryResult<HolesResponse, Error> & { usingCachedCourse: boolean };

export function useHolesWithCachedFallback(args: {
  tournamentId: number;
  round: number;
}): UseHolesWithCachedFallbackResult {
  const [usingCachedCourse, setUsingCachedCourse] = useState(false);

  const query = useQuery<HolesResponse, Error>({
    queryKey: ["holes", args.tournamentId, args.round],
    queryFn: async (): Promise<HolesResponse> => {
      try {
        const live = await fetchPublic<HolesResponse>(
          `/tournaments/${args.tournamentId}/holes?round=${args.round}`,
        );
        // Successful live refetch clears any stale "saved course"
        // indicator left over from a previous offline window.
        setUsingCachedCourse(false);
        return live;
      } catch (err) {
        // Network drop mid-round — fall back to the cached course bundle
        // the app pre-fetched at round start. We don't know the courseId
        // here, so we look it up via roundContext.
        const bundle = await loadCachedCourseBundleForRound({
          tournamentId: args.tournamentId,
        });
        if (!bundle) throw err;
        setUsingCachedCourse(true);
        return bundleToHolesResponse(bundle);
      }
    },
  });

  return { ...query, usingCachedCourse };
}

// Re-export the projection type so callers can keep referring to it without
// pulling it from the lower-level courseBundle module.
export type { BundleHolesProjection };
