import { useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import {
  type OverlayType,
  type OverlayTheme,
  type OverlayState,
  type OverlayStateBundle,
  type OverlayLeaderboard,
  type OverlayGroup,
  type OverlayPlayerCard,
  type OverlayHole,
  type OverlaySponsor,
  type OverlaySponsorList,
  isSponsorPosition,
} from "@/lib/overlay-types";

const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

function useQuery() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

function fmtToPar(n: number | null | undefined) {
  if (n == null || n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

/* ────────────────────────────────────────────────────────── */

function LeaderboardOverlay({ tournamentId, theme, limit }: { tournamentId: string; theme: OverlayTheme; limit: number }) {
  const [data, setData] = useState<OverlayLeaderboard | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/leaderboard?limit=${limit}`);
      if (r.ok && !cancelled) setData((await r.json()) as OverlayLeaderboard);
    }
    load();
    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard/stream`);
    sse.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "leaderboard_update") load();
      } catch { /* ignore non-JSON keep-alives */ }
    };
    sse.onerror = () => { /* keep retrying */ };
    return () => { cancelled = true; sse.close(); };
  }, [tournamentId, limit]);

  if (!data) return null;

  return (
    <div
      className="rounded-xl shadow-2xl overflow-hidden"
      style={{
        background: "rgba(8,12,20,0.85)",
        border: `2px solid ${theme.accentColor}`,
        backdropFilter: "blur(8px)",
        minWidth: 480,
        maxWidth: 560,
      }}
    >
      <div className="px-5 py-3 flex items-center gap-3" style={{ background: theme.primaryColor }}>
        {theme.logoUrl && <img src={theme.logoUrl} alt="" className="h-8 w-auto" />}
        <div className="flex-1">
          <div className="text-white font-bold text-lg leading-tight uppercase tracking-wide">{data.tournamentName}</div>
          <div className="text-white/70 text-xs">Leaderboard · Par {data.coursePar ?? "—"}</div>
        </div>
      </div>
      <table className="w-full text-white">
        <tbody>
          {data.entries.map((e) => (
            <tr key={e.playerId} className="border-b border-white/10 last:border-0">
              <td className="px-3 py-2 font-bold w-12 text-center" style={{ color: theme.accentColor }}>{e.positionDisplay || e.position}</td>
              <td className="px-2 py-2 text-sm">{e.playerName}</td>
              <td className="px-2 py-2 text-sm text-white/60 text-right">{e.thru}</td>
              <td className="px-3 py-2 font-bold w-14 text-right">{fmtToPar(e.scoreToPar)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LowerThird({ theme, text }: { theme: OverlayTheme; text: string | null }) {
  if (!text) return null;
  return (
    <div
      className="rounded-md shadow-2xl overflow-hidden flex items-stretch"
      style={{ background: "rgba(8,12,20,0.92)", borderLeft: `6px solid ${theme.accentColor}`, minWidth: 480 }}
    >
      {theme.logoUrl && (
        <div className="flex items-center px-3" style={{ background: theme.primaryColor }}>
          <img src={theme.logoUrl} alt="" className="h-10 w-auto" />
        </div>
      )}
      <div className="px-5 py-3 text-white text-2xl font-semibold tracking-wide">{text}</div>
    </div>
  );
}

function CurrentGroup({ tournamentId, theme, groupId }: { tournamentId: string; theme: OverlayTheme; groupId: number | null }) {
  const [data, setData] = useState<OverlayGroup | null>(null);
  useEffect(() => {
    if (!groupId) { setData(null); return; }
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/group/${groupId}`);
      if (r.ok && !cancelled) setData((await r.json()) as OverlayGroup);
    }
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [tournamentId, groupId]);

  if (!groupId || !data) return null;

  return (
    <div className="rounded-xl shadow-2xl overflow-hidden" style={{ background: "rgba(8,12,20,0.88)", border: `2px solid ${theme.accentColor}`, minWidth: 520 }}>
      <div className="px-4 py-2 text-white text-sm font-bold uppercase tracking-wider" style={{ background: theme.primaryColor }}>
        Now on Course · Round {data.round} · Tee {data.startingHole ?? "—"}
      </div>
      <div className="divide-y divide-white/10">
        {data.players.map((p) => (
          <div key={p.playerId} className="px-4 py-2 flex items-center gap-3 text-white">
            <div className="w-10 text-center font-bold" style={{ color: theme.accentColor }}>{p.positionDisplay ?? "—"}</div>
            <div className="flex-1">
              <div className="font-semibold">{p.playerName}</div>
              <div className="text-xs text-white/60">HCP {p.handicapIndex ?? "—"}{p.flight ? ` · ${p.flight}` : ""}</div>
            </div>
            <div className="text-right">
              <div className="font-bold text-lg">{fmtToPar(p.scoreToPar)}</div>
              <div className="text-xs text-white/60">Thru {p.thru ?? "—"}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerCard({ tournamentId, theme, playerId }: { tournamentId: string; theme: OverlayTheme; playerId: number | null }) {
  const [data, setData] = useState<OverlayPlayerCard | null>(null);
  useEffect(() => {
    if (!playerId) { setData(null); return; }
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/player/${playerId}`);
      if (r.ok && !cancelled) setData((await r.json()) as OverlayPlayerCard);
    }
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [tournamentId, playerId]);

  if (!playerId || !data) return null;
  const initials = data.playerName.split(" ").map((s) => s[0]).slice(0, 2).join("");

  return (
    <div className="rounded-xl shadow-2xl overflow-hidden flex" style={{ background: "rgba(8,12,20,0.92)", border: `2px solid ${theme.accentColor}`, minWidth: 460 }}>
      {data.profileImage ? (
        <img src={data.profileImage} alt="" className="w-28 h-28 object-cover" />
      ) : (
        <div className="w-28 h-28 flex items-center justify-center text-white text-3xl font-bold" style={{ background: theme.primaryColor }}>
          {initials}
        </div>
      )}
      <div className="flex-1 p-4 text-white">
        <div className="text-2xl font-bold">{data.playerName}</div>
        <div className="text-xs text-white/60 mb-2">
          {data.flight ?? ""}{data.handicapIndex != null ? ` · HCP ${data.handicapIndex}` : ""}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-xs uppercase text-white/50">Pos</div>
            <div className="font-bold text-xl" style={{ color: theme.accentColor }}>{data.positionDisplay ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-white/50">To Par</div>
            <div className="font-bold text-xl">{fmtToPar(data.scoreToPar)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-white/50">Thru</div>
            <div className="font-bold text-xl">{data.thru ?? "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HoleOverlay({ tournamentId, theme, holeNumber }: { tournamentId: string; theme: OverlayTheme; holeNumber: number | null }) {
  const [data, setData] = useState<OverlayHole | null>(null);
  useEffect(() => {
    if (!holeNumber) { setData(null); return; }
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/hole/${holeNumber}`);
      if (r.ok && !cancelled) setData((await r.json()) as OverlayHole);
    }
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [tournamentId, holeNumber]);

  if (!holeNumber || !data) return null;
  const s = data.stats;

  const cells: Array<[string, number]> = [
    ["Eagle", s.eagles],
    ["Birdie", s.birdies],
    ["Par", s.pars],
    ["Bogey", s.bogeys],
    ["Dbl+", s.doublePlus],
  ];

  return (
    <div className="rounded-xl shadow-2xl overflow-hidden" style={{ background: "rgba(8,12,20,0.92)", border: `2px solid ${theme.accentColor}`, minWidth: 420 }}>
      <div className="px-5 py-3 flex items-center gap-4" style={{ background: theme.primaryColor }}>
        <div className="text-white text-5xl font-extrabold leading-none">{data.holeNumber}</div>
        <div className="text-white">
          <div className="text-xs uppercase tracking-wider opacity-75">Hole</div>
          <div className="font-bold">Par {data.par} · {data.yardage ?? "—"} yds</div>
        </div>
      </div>
      <div className="p-4 text-white grid grid-cols-5 gap-2 text-center">
        {cells.map(([label, val]) => (
          <div key={label}>
            <div className="text-xs text-white/60 uppercase">{label}</div>
            <div className="font-bold text-xl">{val}</div>
          </div>
        ))}
      </div>
      {s.avgStrokes != null && (
        <div className="px-4 pb-3 text-white/70 text-xs text-center">Field average: <span className="text-white font-semibold">{s.avgStrokes}</span></div>
      )}
    </div>
  );
}

function SponsorBug({ tournamentId, theme, sponsorId }: { tournamentId: string; theme: OverlayTheme; sponsorId: number | null }) {
  const [sponsors, setSponsors] = useState<OverlaySponsor[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/sponsor`);
      if (r.ok && !cancelled) {
        const d = (await r.json()) as OverlaySponsorList;
        setSponsors(d.sponsors);
      }
    }
    load();
  }, [tournamentId]);

  useEffect(() => {
    if (sponsorId) return; // pinned — no rotation
    const t = setInterval(() => setIdx((i) => (sponsors.length ? (i + 1) % sponsors.length : 0)), 8000);
    return () => clearInterval(t);
  }, [sponsors.length, sponsorId]);

  if (!sponsors.length) return null;
  const sponsor: OverlaySponsor = sponsorId
    ? sponsors.find((s) => s.id === sponsorId) ?? sponsors[0]
    : sponsors[idx % sponsors.length];

  return (
    <div className="rounded-md shadow-2xl flex items-center gap-3 px-3 py-2" style={{ background: "rgba(8,12,20,0.85)", border: `1px solid ${theme.accentColor}` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color: theme.accentColor }}>Brought to you by</div>
      {sponsor.logoUrl ? (
        <img src={sponsor.logoUrl} alt={sponsor.name} className="h-8 w-auto" />
      ) : (
        <div className="text-white font-bold">{sponsor.name}</div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */

function SafeAreaGuides({ size }: { size: "1080" | "4k" }) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="absolute" style={{ top: "3.5%", left: "3.5%", right: "3.5%", bottom: "3.5%", border: "2px dashed rgba(255,165,0,0.55)" }} />
      <div className="absolute" style={{ top: "5%", left: "5%", right: "5%", bottom: "5%", border: "2px dashed rgba(0,200,255,0.55)" }} />
      <div className="absolute top-1 right-2 text-xs font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>
        safe-area: {size === "4k" ? "2160p" : "1080p"}
      </div>
    </div>
  );
}

function positionStyle(pos: OverlayTheme["sponsorPosition"]): React.CSSProperties {
  switch (pos) {
    case "top-left": return { top: 24, left: 24 };
    case "top-right": return { top: 24, right: 24 };
    case "bottom-left": return { bottom: 24, left: 24 };
    case "bottom-right":
    default: return { bottom: 24, right: 24 };
  }
}

function isOverlayType(v: string | null): v is OverlayType {
  return v === "leaderboard" || v === "lower-third" || v === "current-group" ||
         v === "player-card" || v === "hole" || v === "sponsor-bug";
}

export default function OverlayPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const q = useQuery();

  const typeParam = q.get("type");
  const onlyType: OverlayType | null = isOverlayType(typeParam) ? typeParam : null;
  const safeParamRaw = q.get("safe");
  const safeSize: "1080" | "4k" = safeParamRaw === "4k" ? "4k" : "1080";

  const [bundle, setBundle] = useState<OverlayStateBundle | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await fetch(`${baseUrl}/api/public/overlays/${tournamentId}/state`);
      if (r.ok && !cancelled) setBundle((await r.json()) as OverlayStateBundle);
    }
    load();
    const sse = new EventSource(`${baseUrl}/api/public/overlays/${tournamentId}/stream`);
    sse.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string };
        if (msg.type === "overlay_state") load();
      } catch { /* ignore */ }
    };
    sse.onerror = () => { /* auto-retry */ };
    return () => { cancelled = true; sse.close(); };
  }, [tournamentId]);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => { document.body.style.background = prev; };
  }, []);

  if (!bundle || !tournamentId) {
    return <div style={{ background: "transparent" }} />;
  }

  const s = bundle.state;
  const theme = s.theme;

  const sponsorParam = q.get("sponsorPosition");
  const themeOverride: OverlayTheme = {
    logoUrl: q.get("logo") ?? theme.logoUrl,
    primaryColor: q.get("primary") ?? theme.primaryColor,
    accentColor: q.get("accent") ?? theme.accentColor,
    sponsorPosition: sponsorParam && isSponsorPosition(sponsorParam) ? sponsorParam : theme.sponsorPosition,
    showSafeArea: theme.showSafeArea || !!safeParamRaw,
  };

  if (onlyType) {
    const node = renderOverlay(onlyType, tournamentId, themeOverride, s);
    return (
      <div className="relative min-h-screen p-6 flex items-end" style={{ background: "transparent" }}>
        {themeOverride.showSafeArea && <SafeAreaGuides size={safeSize} />}
        {node}
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen" style={{ background: "transparent" }}>
      {themeOverride.showSafeArea && <SafeAreaGuides size={safeSize} />}

      {s.active["leaderboard"] && (
        <div className="absolute" style={{ top: 24, right: 24 }}>
          <LeaderboardOverlay tournamentId={tournamentId} theme={themeOverride} limit={s.leaderboardLimit} />
        </div>
      )}
      {s.active["current-group"] && (
        <div className="absolute" style={{ top: 24, left: 24 }}>
          <CurrentGroup tournamentId={tournamentId} theme={themeOverride} groupId={s.currentGroupId} />
        </div>
      )}
      {s.active["player-card"] && (
        <div className="absolute" style={{ bottom: 120, left: 24 }}>
          <PlayerCard tournamentId={tournamentId} theme={themeOverride} playerId={s.currentPlayerId} />
        </div>
      )}
      {s.active["hole"] && (
        <div className="absolute" style={{ bottom: 120, right: 24 }}>
          <HoleOverlay tournamentId={tournamentId} theme={themeOverride} holeNumber={s.currentHole} />
        </div>
      )}
      {s.active["lower-third"] && (
        <div className="absolute" style={{ bottom: 36, left: "50%", transform: "translateX(-50%)" }}>
          <LowerThird theme={themeOverride} text={s.lowerThirdText} />
        </div>
      )}
      {s.active["sponsor-bug"] && (
        <div className="absolute" style={positionStyle(themeOverride.sponsorPosition)}>
          <SponsorBug tournamentId={tournamentId} theme={themeOverride} sponsorId={s.currentSponsorId} />
        </div>
      )}
    </div>
  );
}

function renderOverlay(type: OverlayType, tournamentId: string, theme: OverlayTheme, s: OverlayState) {
  switch (type) {
    case "leaderboard": return <LeaderboardOverlay tournamentId={tournamentId} theme={theme} limit={s.leaderboardLimit} />;
    case "lower-third": return <LowerThird theme={theme} text={s.lowerThirdText} />;
    case "current-group": return <CurrentGroup tournamentId={tournamentId} theme={theme} groupId={s.currentGroupId} />;
    case "player-card": return <PlayerCard tournamentId={tournamentId} theme={theme} playerId={s.currentPlayerId} />;
    case "hole": return <HoleOverlay tournamentId={tournamentId} theme={theme} holeNumber={s.currentHole} />;
    case "sponsor-bug": return <SponsorBug tournamentId={tournamentId} theme={theme} sponsorId={s.currentSponsorId} />;
  }
}
