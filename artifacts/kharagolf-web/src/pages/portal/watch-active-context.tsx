import { useEffect, useState } from 'react';
import { Loader2, Wind, Mountain, MapPin, Flag } from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Card } from '@/components/ui/card';

interface ActiveContext {
  active: boolean;
  tournamentId?: number;
  round?: number;
  holeNumber?: number;
  par?: number;
  yardage?: number | null;
  greenLat?: number | null;
  greenLon?: number | null;
  playsLikeYards?: number | null;
  playsLikeWindAdj?: number | null;
  playsLikeElevAdj?: number | null;
  /** Compass bearing player → green (0=N), surfaced for the wind arrow (Task #878). */
  playsLikeBearingDeg?: number | null;
  /** Compass direction the wind is blowing FROM (0=N), for the wind arrow (Task #878). */
  playsLikeWindDirDeg?: number | null;
  holeStrokes?: number;
  toPar?: number;
  holesPlayed?: number;
}

/**
 * Rotation (degrees, clockwise) that an upward-pointing arrow needs so it
 * points in the direction the wind is blowing TOWARD, relative to the
 * player's shot line. `windFrom` is the compass bearing the wind is coming
 * FROM; `bearing` is the player → green compass bearing. The wind blows
 * TOWARD `(windFrom + 180)`; subtracting `bearing` rebases so 0° = pointing
 * up the page (toward the green = tailwind), 180° = pointing down (headwind).
 */
function relativeWindToward(bearing: number, windFrom: number): number {
  const rel = (windFrom + 180) - bearing;
  const mod = rel % 360;
  return mod < 0 ? mod + 360 : mod;
}

function signed(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function toParLabel(diff: number | undefined): string {
  if (diff == null) return 'E';
  if (diff === 0) return 'E';
  return diff > 0 ? `+${diff}` : `${diff}`;
}

/**
 * Web portal mirror of the watch's hole-context view (Task #721).
 *
 * Surfaces the same plays-like breakdown the iOS / Wear OS / Garmin
 * clients now show — headline yardage plus the wind & elevation
 * contributions — so a player (or coach watching from the clubhouse)
 * can see why the number shifts as the player walks. Polls the
 * existing `/api/portal/watch/active-context` endpoint every 15 s,
 * forwarding the browser's current GPS when permission is granted so
 * the wind component is computed against the actual shot line.
 */
export default function WatchActiveContextPage() {
  const [data, setData] = useState<ActiveContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Optional browser GPS — improves wind component fidelity. Failure is
  // expected (denied permission, desktop without GPS) and we fall back to
  // the course-centre approximation server-side.
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {/* permission denied or unavailable — silently continue */},
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const qs = coords ? `?lat=${coords.lat}&lng=${coords.lng}` : '';
        const r = await fetch(`/api/portal/watch/active-context${qs}`, {
          credentials: 'include',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as ActiveContext;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [coords?.lat, coords?.lng]);

  return (
    <div className="min-h-screen bg-[#0B0F14] text-white p-6">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-6">
          <KharaGolfWordmark />
          <span className="text-xs text-gray-400">Watch · Active hole</span>
        </div>

        {loading && !data && (
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {error && !data && (
          <Card className="p-4 bg-red-500/10 border-red-500/30 text-red-200 text-sm">
            Could not load active hole: {error}
          </Card>
        )}

        {data && !data.active && (
          <Card className="p-6 text-center text-gray-400 bg-white/5 border-white/10">
            No active round in progress.
          </Card>
        )}

        {data?.active && (
          <Card className="p-5 bg-white/5 border-white/10 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Flag className="w-4 h-4 text-[#C9A84C]" />
                <span className="text-lg font-semibold">Hole {data.holeNumber}</span>
                <span className="text-sm text-gray-400">Par {data.par}</span>
              </div>
              <span className="text-sm text-gray-300">
                Round {data.round} · {toParLabel(data.toPar)}
              </span>
            </div>

            <div className="flex items-baseline gap-3">
              <MapPin className="w-4 h-4 text-[#C9A84C]" />
              <span className="text-3xl font-bold">{data.yardage ?? '–'}</span>
              <span className="text-sm text-gray-400">yds to green</span>
            </div>

            {data.playsLikeYards != null ? (
              <div className="rounded-md bg-[#FBBF24]/10 border border-[#FBBF24]/30 p-3 space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[#FBBF24] font-semibold">
                    Plays {data.playsLikeYards} yds
                  </span>
                  {data.yardage != null && (
                    <span className="text-xs text-gray-400">
                      ({signed(data.playsLikeYards - data.yardage)} vs straight)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-300">
                  <div className="flex items-center gap-1">
                    <Wind className="w-3 h-3" />
                    {/*
                      Task #878 — small directional arrow rotated relative
                      to the player's shot bearing so head/cross/tail wind
                      is obvious at a glance. Arrow points in the direction
                      the wind is blowing TOWARD (down = headwind, up =
                      tailwind, right = cross from the left, etc.).
                    */}
                    {data.playsLikeBearingDeg != null && data.playsLikeWindDirDeg != null && (
                      <svg
                        viewBox="0 0 12 12"
                        className="w-3 h-3"
                        style={{
                          transform: `rotate(${relativeWindToward(
                            data.playsLikeBearingDeg,
                            data.playsLikeWindDirDeg,
                          )}deg)`,
                        }}
                        aria-label="Wind direction relative to shot"
                      >
                        <path
                          d="M6 1 L9 6 L7 6 L7 11 L5 11 L5 6 L3 6 Z"
                          fill="#FBBF24"
                        />
                      </svg>
                    )}
                    <span>wind {signed(data.playsLikeWindAdj)} y</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Mountain className="w-3 h-3" />
                    <span>elev {signed(data.playsLikeElevAdj)} y</span>
                  </div>
                </div>
                <p className="text-[10px] text-gray-500">
                  Updates as you walk — wind contribution is recomputed against
                  your live position.
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                Plays-like unavailable (weather or elevation not loaded).
              </p>
            )}

            <div className="text-xs text-gray-400">
              Holes played: {data.holesPlayed} · Strokes this hole:{' '}
              {data.holeStrokes ?? 0}
              {coords ? ' · GPS lock' : ' · using course centre'}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
