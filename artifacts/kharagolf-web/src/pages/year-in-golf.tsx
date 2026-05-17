import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Share2, Download, Bell, BellOff, Loader2, Trophy, Flag, Activity, Users, Award, TrendingUp, MapPin, Target, Film, Link as LinkIcon, Eye, Copy as CopyIcon, Smartphone, Bot, HelpCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const BASE_URL = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type Period = "year" | "q1" | "q2" | "q3" | "q4";

// Task #1509 — response shape of `GET /api/portal/me/recap-share-stats`
// (defined in `artifacts/api-server/src/routes/portal.ts`).
type RecapShareSourceKey = "copy" | "web_share" | "native_share" | "qr_open" | "crawler" | "unknown";
type RecapShareAssetKey = "card_png" | "og";
interface RecapShareStats {
  total: number;
  totalsByAsset: Record<RecapShareAssetKey, number>;
  totalsBySource: Record<RecapShareSourceKey, number>;
  byPeriod: Array<{
    year: number;
    period: string;
    total: number;
    byAsset: Record<RecapShareAssetKey, number>;
    bySource: Record<RecapShareSourceKey, number>;
  }>;
}

interface Recap {
  user: { id: number; displayName: string | null };
  window: { year: number; period: Period; label: string; startsAt: string; endsAt: string };
  totals: { rounds: number; holes: number; courses: number; partners: number; achievementsUnlocked: number };
  bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null;
  longestDrive: { distanceYards: number; club: string | null; courseName: string | null; recordedAt: string | null } | null;
  lowestHoleScore: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null;
  mostImproved: { metric: string; previousValue: number; currentValue: number; deltaLabel: string } | null;
  topCourses: { courseId: number; courseName: string; rounds: number }[];
  topPartners: { name: string; roundsTogether: number }[];
  achievements: { badgeType: string; badgeLabel: string; badgeIcon: string; earnedAt: string }[];
  handicapJourney: { startIndex: number | null; endIndex: number | null; deltaLabel: string; points: { recordedAt: string; index: number }[] };
}

const CHAPTER_GRADIENTS: Record<string, string> = {
  cover: "from-emerald-700 to-emerald-900",
  rounds: "from-blue-600 to-blue-900",
  bestRound: "from-violet-600 to-violet-900",
  longestDrive: "from-orange-600 to-orange-900",
  lowestHole: "from-cyan-600 to-cyan-900",
  courses: "from-green-600 to-green-900",
  partners: "from-rose-600 to-rose-900",
  achievements: "from-amber-500 to-amber-800",
  handicap: "from-purple-600 to-purple-900",
  improved: "from-emerald-500 to-emerald-800",
  share: "from-zinc-800 to-zinc-950",
};

export default function YearInGolfPage() {
  const { t, i18n } = useTranslation("portal");
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [period, setPeriod] = useState<Period>("year");
  const qc = useQueryClient();

  const { data: recap, isLoading, error, refetch } = useQuery<Recap>({
    queryKey: ["year-in-golf", year, period],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/year-in-golf?year=${year}&period=${period}`, { credentials: "include" });
      if (!res.ok) throw new Error(t("yearInGolf.errors.loadFailed", { status: res.status }));
      return res.json();
    },
  });

  const { data: pref } = useQuery<{ pushEnabled: boolean }>({
    queryKey: ["year-in-golf-pref"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/year-in-golf/preferences`, { credentials: "include" });
      if (!res.ok) throw new Error("pref fetch failed");
      return res.json();
    },
  });

  const { data: publicProfile } = useQuery<{ publicHandle: string | null; publicProfileEnabled: boolean }>({
    queryKey: ["year-in-golf-public-profile"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/me/public-profile`, { credentials: "include" });
      if (!res.ok) throw new Error("public profile fetch failed");
      return res.json();
    },
  });

  // Task #1509 — surface the recap-share-stats endpoint (Task #1281)
  // back to the player so they can see how often their public recap
  // link has been opened. We only fetch when the player actually has
  // a public profile, since players without one cannot accumulate
  // open counts and we don't want to send a useless request.
  const publicProfileEnabled = !!(publicProfile?.publicHandle && publicProfile?.publicProfileEnabled);
  const { data: shareStats } = useQuery<RecapShareStats>({
    queryKey: ["year-in-golf-share-stats"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/me/recap-share-stats`, { credentials: "include" });
      if (!res.ok) throw new Error("share stats fetch failed");
      return res.json();
    },
    enabled: publicProfileEnabled,
  });

  // Task #1281 — `via=<source>` is appended at click time (not baked
  // into the visible URL) so the recap share-stats endpoint can
  // attribute hits back to the share button that produced them (copy
  // vs Web Share API). Direct hits with no `via=` param fall through
  // to crawler/UA detection on the server.
  const publicShareUrl = useMemo(() => {
    if (!publicProfile?.publicHandle || !publicProfile?.publicProfileEnabled) return null;
    return `${window.location.origin}/api/public/recap/${publicProfile.publicHandle}/og?year=${year}&period=${period}`;
  }, [publicProfile, year, period]);
  const withVia = (url: string, via: "copy" | "web_share") => `${url}&via=${via}`;

  const togglePref = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch(`${BASE_URL}/api/portal/year-in-golf/preferences`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushEnabled: next }),
      });
      if (!res.ok) throw new Error("pref save failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["year-in-golf-pref"] }),
  });

  const handleShare = async () => {
    if (!recap) return;
    const text = recap.bestRound
      ? t("yearInGolf.shareText.withBest", { label: recap.window.label, rounds: recap.totals.rounds, courses: recap.totals.courses, gross: recap.bestRound.gross })
      : t("yearInGolf.shareText.withoutBest", { label: recap.window.label, rounds: recap.totals.rounds, courses: recap.totals.courses });
    // Prefer the public OG share link (rich preview with og:image) when the
    // player has a reserved handle and an enabled public profile. Otherwise
    // fall back to the current page URL so users without a public profile
    // can still share. When the public URL is used the Web Share path is
    // tagged `via=web_share` and the clipboard path `via=copy` so the
    // recap share-stats endpoint can attribute hits (Task #1281).
    const shareUrl = publicShareUrl ? withVia(publicShareUrl, "web_share") : window.location.href;
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: t("yearInGolf.shareText.title", { label: recap.window.label }), text, url: shareUrl }); return; } catch { /* user cancelled */ }
    }
    const fallbackUrl = publicShareUrl ? withVia(publicShareUrl, "copy") : window.location.href;
    try { await navigator.clipboard.writeText(`${text} ${fallbackUrl}`); alert(t("yearInGolf.alerts.linkCopied")); } catch { /* ignore */ }
  };

  const handleCopyShareLink = async () => {
    if (!publicShareUrl) {
      alert(t("yearInGolf.alerts.needPublicHandle"));
      return;
    }
    // Task #1281 — tag with `via=copy` so a clipboard-driven share is
    // counted distinctly from a native-share fan-out on the server.
    try { await navigator.clipboard.writeText(withVia(publicShareUrl, "copy")); alert(t("yearInGolf.alerts.publicLinkCopied")); } catch { /* ignore */ }
  };

  const handleDownload = () => {
    // Server-rendered shareable card (PNG) — works in all browsers and gives
    // a high-quality, social-friendly image rather than a print preview.
    const url = `/api/portal/year-in-golf/card.png?year=${year}&period=${period}&chapter=0`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `year-in-golf-${year}-${period}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleVideo = () => {
    // Stream the server-rendered short MP4 slideshow of all chapters.
    const url = `/api/portal/year-in-golf/video.mp4?year=${year}&period=${period}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const periods: { key: Period; label: string }[] = useMemo(() => ([
    { key: "year", label: t("yearInGolf.periods.year") },
    { key: "q1", label: t("yearInGolf.periods.q1") },
    { key: "q2", label: t("yearInGolf.periods.q2") },
    { key: "q3", label: t("yearInGolf.periods.q3") },
    { key: "q4", label: t("yearInGolf.periods.q4") },
  ]), [t, i18n.language]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t("yearInGolf.title")}</h1>
            <p className="text-zinc-400 text-sm mt-1">{t("yearInGolf.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setYear(y => y - 1)}><ChevronLeft className="w-4 h-4" /></Button>
            <span className="text-2xl font-bold min-w-[80px] text-center">{year}</span>
            <Button variant="outline" size="sm" onClick={() => setYear(y => y + 1)}><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </header>

        <div className="flex flex-wrap gap-2 mb-6">
          {periods.map(p => (
            <Button
              key={p.key}
              variant={period === p.key ? "default" : "outline"}
              size="sm"
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleShare} disabled={!recap}>
              <Share2 className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.share")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyShareLink}
              disabled={!publicShareUrl}
              title={publicShareUrl ? t("yearInGolf.tooltips.copyLinkEnabled") : t("yearInGolf.tooltips.copyLinkDisabled")}
            >
              <LinkIcon className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.copyLink")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleDownload} disabled={!recap}>
              <Download className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.saveImage")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleVideo} disabled={!recap}>
              <Film className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.video")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => togglePref.mutate(!(pref?.pushEnabled ?? true))}
              disabled={togglePref.isPending}
              title={t("yearInGolf.tooltips.togglePush")}
            >
              {pref?.pushEnabled === false ? <BellOff className="w-4 h-4 mr-1" /> : <Bell className="w-4 h-4 mr-1" />}
              {pref?.pushEnabled === false ? t("yearInGolf.actions.pushOff") : t("yearInGolf.actions.pushOn")}
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-24 gap-2 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" /> {t("yearInGolf.loading")}
          </div>
        )}
        {error && (
          <div className="text-center py-24">
            <p className="text-red-400 mb-4">{(error as Error).message}</p>
            <Button onClick={() => refetch()}>{t("yearInGolf.actions.retry")}</Button>
          </div>
        )}

        {recap && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <ChapterCard tone="cover" title={t("yearInGolf.chapters.cover.title")} eyebrow={t("yearInGolf.chapters.cover.eyebrow", { label: recap.window.label })}>
              <BigStat value={recap.totals.rounds.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.cover.rounds")} />
              <p className="text-zinc-200/80 text-sm mt-3">{t("yearInGolf.chapters.cover.intro", { name: recap.user.displayName ?? t("yearInGolf.chapters.cover.defaultName"), label: recap.window.label })}</p>
            </ChapterCard>

            <ChapterCard tone="rounds" title={t("yearInGolf.chapters.totalHoles.title")} eyebrow={t("yearInGolf.chapters.totalHoles.eyebrow")} icon={<Activity className="w-4 h-4" />}>
              <BigStat value={recap.totals.holes.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.totalHoles.holes")} />
              <p className="text-zinc-200/80 text-sm mt-3">{t("yearInGolf.chapters.totalHoles.across", { count: recap.totals.courses })}</p>
            </ChapterCard>

            <ChapterCard tone="bestRound" title={t("yearInGolf.chapters.bestRound.title")} eyebrow={t("yearInGolf.chapters.bestRound.eyebrow")} icon={<Trophy className="w-4 h-4" />}>
              {recap.bestRound ? (
                <>
                  <BigStat value={recap.bestRound.gross.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.bestRound.strokes")} />
                  {recap.bestRound.courseName && <p className="text-zinc-200/80 text-sm mt-3">{recap.bestRound.courseName}</p>}
                  {recap.bestRound.playedAt && <p className="text-zinc-200/60 text-xs mt-1">{fmtDate(recap.bestRound.playedAt, i18n.language)}</p>}
                </>
              ) : <Empty>{t("yearInGolf.chapters.bestRound.empty")}</Empty>}
            </ChapterCard>

            <ChapterCard tone="longestDrive" title={t("yearInGolf.chapters.longestDrive.title")} eyebrow={t("yearInGolf.chapters.longestDrive.eyebrow")} icon={<Target className="w-4 h-4" />}>
              {recap.longestDrive ? (
                <>
                  <BigStat value={recap.longestDrive.distanceYards.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.longestDrive.yards")} />
                  {recap.longestDrive.club && <p className="text-zinc-200/80 text-sm mt-3">{t("yearInGolf.chapters.longestDrive.withClub", { club: recap.longestDrive.club })}</p>}
                  {recap.longestDrive.courseName && <p className="text-zinc-200/60 text-xs mt-1">{recap.longestDrive.courseName}</p>}
                </>
              ) : <Empty>{t("yearInGolf.chapters.longestDrive.empty")}</Empty>}
            </ChapterCard>

            <ChapterCard tone="lowestHole" title={t("yearInGolf.chapters.lowestHole.title")} eyebrow={t("yearInGolf.chapters.lowestHole.eyebrow")} icon={<Flag className="w-4 h-4" />}>
              {recap.lowestHoleScore ? (
                <>
                  <BigStat value={recap.lowestHoleScore.strokes.toLocaleString(i18n.language)} label={recap.lowestHoleScore.par != null ? t("yearInGolf.chapters.lowestHole.onPar", { par: recap.lowestHoleScore.par }) : t("yearInGolf.chapters.lowestHole.strokes")} />
                  <p className="text-zinc-200/80 text-sm mt-3">{t("yearInGolf.chapters.lowestHole.holePrefix", { number: recap.lowestHoleScore.holeNumber })}{recap.lowestHoleScore.courseName ? ` • ${recap.lowestHoleScore.courseName}` : ""}</p>
                  {recap.lowestHoleScore.playedAt && <p className="text-zinc-200/60 text-xs mt-1">{fmtDate(recap.lowestHoleScore.playedAt, i18n.language)}</p>}
                </>
              ) : <Empty>{t("yearInGolf.chapters.lowestHole.empty")}</Empty>}
            </ChapterCard>

            <ChapterCard tone="courses" title={t("yearInGolf.chapters.courses.title")} eyebrow={t("yearInGolf.chapters.courses.eyebrow")} icon={<MapPin className="w-4 h-4" />}>
              <BigStat value={recap.totals.courses.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.courses.unit", { count: recap.totals.courses })} />
              <ul className="mt-4 space-y-1">
                {recap.topCourses.slice(0, 4).map(c => (
                  <li key={c.courseId} className="flex justify-between text-sm text-zinc-100/90">
                    <span className="truncate mr-2">{c.courseName}</span>
                    <span className="font-semibold">{c.rounds.toLocaleString(i18n.language)}</span>
                  </li>
                ))}
              </ul>
            </ChapterCard>

            <ChapterCard tone="partners" title={t("yearInGolf.chapters.partners.title")} eyebrow={t("yearInGolf.chapters.partners.eyebrow")} icon={<Users className="w-4 h-4" />}>
              <BigStat value={recap.totals.partners.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.partners.unit", { count: recap.totals.partners })} />
              <ul className="mt-4 space-y-1">
                {recap.topPartners.slice(0, 4).map(p => (
                  <li key={p.name} className="flex justify-between text-sm text-zinc-100/90">
                    <span className="truncate mr-2">{p.name}</span>
                    <span className="font-semibold">{p.roundsTogether.toLocaleString(i18n.language)}×</span>
                  </li>
                ))}
                {recap.topPartners.length === 0 && <Empty>{t("yearInGolf.chapters.partners.empty")}</Empty>}
              </ul>
            </ChapterCard>

            <ChapterCard tone="achievements" title={t("yearInGolf.chapters.achievements.title")} eyebrow={t("yearInGolf.chapters.achievements.eyebrow")} icon={<Award className="w-4 h-4" />}>
              <BigStat value={recap.totals.achievementsUnlocked.toLocaleString(i18n.language)} label={t("yearInGolf.chapters.achievements.unlocked")} />
              <div className="mt-4 flex flex-wrap gap-2">
                {recap.achievements.slice(0, 6).map(a => (
                  <Badge key={a.badgeType} variant="secondary" className="bg-white/15 text-white border-white/20">
                    <span className="mr-1">{a.badgeIcon}</span>{a.badgeLabel}
                  </Badge>
                ))}
                {recap.achievements.length === 0 && <Empty>{t("yearInGolf.chapters.achievements.empty")}</Empty>}
              </div>
            </ChapterCard>

            <ChapterCard tone="handicap" title={t("yearInGolf.chapters.handicap.title")} eyebrow={t("yearInGolf.chapters.handicap.eyebrow")} icon={<TrendingUp className="w-4 h-4" />}>
              {recap.handicapJourney.points.length > 0 ? (
                <>
                  <BigStat value={recap.handicapJourney.endIndex?.toFixed(1) ?? "—"} label={t("yearInGolf.chapters.handicap.currentIndex")} />
                  <p className="text-zinc-200/80 text-sm mt-3">{recap.handicapJourney.deltaLabel || "—"}</p>
                  {recap.handicapJourney.startIndex != null && (
                    <p className="text-zinc-200/60 text-xs mt-1">{t("yearInGolf.chapters.handicap.startedAt", { value: recap.handicapJourney.startIndex.toFixed(1) })}</p>
                  )}
                </>
              ) : <Empty>{t("yearInGolf.chapters.handicap.empty")}</Empty>}
            </ChapterCard>

            <ChapterCard tone="improved" title={t("yearInGolf.chapters.improved.title")} eyebrow={t("yearInGolf.chapters.improved.eyebrow")}>
              {recap.mostImproved ? (
                <>
                  <p className="text-zinc-100/90 text-sm">{recap.mostImproved.metric}</p>
                  <BigStat value={`${recap.mostImproved.previousValue} → ${recap.mostImproved.currentValue}`} label={recap.mostImproved.deltaLabel} />
                </>
              ) : <Empty>{t("yearInGolf.chapters.improved.empty")}</Empty>}
            </ChapterCard>

            <ChapterCard tone="share" title={t("yearInGolf.chapters.share.title")} eyebrow={t("yearInGolf.chapters.share.eyebrow")}>
              <p className="text-zinc-100/90 text-sm">{t("yearInGolf.chapters.share.intro", { label: recap.window.label })}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={handleShare}><Share2 className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.share")}</Button>
                <Button variant="outline" onClick={handleDownload}><Download className="w-4 h-4 mr-1" /> {t("yearInGolf.actions.saveOrPrint")}</Button>
              </div>
              {publicProfileEnabled && (
                <RecapShareStatsPanel stats={shareStats ?? null} />
              )}
            </ChapterCard>
          </div>
        )}
      </div>
    </div>
  );
}

function ChapterCard({ tone, title, eyebrow, icon, children }: { tone: keyof typeof CHAPTER_GRADIENTS; title: string; eyebrow: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Card className={`bg-gradient-to-br ${CHAPTER_GRADIENTS[tone]} border-0 text-white overflow-hidden`}>
        <CardContent className="p-6 min-h-[260px] flex flex-col">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-white/70">
            {icon}
            <span>{eyebrow}</span>
          </div>
          <h3 className="text-xl font-bold mt-1">{title}</h3>
          <div className="flex-1 mt-3">{children}</div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function BigStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-5xl font-extrabold leading-none">{value}</div>
      <div className="text-white/80 text-sm font-semibold mt-1">{label}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-white/70 text-sm italic mt-2">{children}</p>;
}

function fmtDate(iso: string, lang?: string): string {
  return new Date(iso).toLocaleDateString(lang, { month: "short", day: "numeric", year: "numeric" });
}

// Task #1509 — small "Your recap has been opened N times" stat with a
// popover breakdown. Only rendered when the player has a public
// profile (the parent gates the render); inside, a 0-total still
// renders a friendly empty state so people learn the panel exists
// before any shares roll in.
const SHARE_SOURCE_ICONS: Record<RecapShareSourceKey, React.ReactNode> = {
  copy: <CopyIcon className="w-3.5 h-3.5" />,
  web_share: <Share2 className="w-3.5 h-3.5" />,
  native_share: <Smartphone className="w-3.5 h-3.5" />,
  qr_open: <LinkIcon className="w-3.5 h-3.5" />,
  crawler: <Bot className="w-3.5 h-3.5" />,
  unknown: <HelpCircle className="w-3.5 h-3.5" />,
};

function RecapShareStatsPanel({ stats }: { stats: RecapShareStats | null }) {
  const { t, i18n } = useTranslation("portal");
  // While loading we render a slim placeholder so the share card
  // doesn't visibly jump when the data arrives.
  if (!stats) {
    return (
      <div className="mt-4 rounded-md border border-white/15 bg-black/20 px-3 py-2 text-xs text-white/70 flex items-center gap-2">
        <Eye className="w-3.5 h-3.5" /> {t("yearInGolf.shareStats.loading")}
      </div>
    );
  }
  const total = stats.total ?? 0;
  const sourceEntries = (Object.entries(stats.totalsBySource) as [RecapShareSourceKey, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="mt-4 rounded-md border border-white/15 bg-black/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-white/90">
          <Eye className="w-4 h-4" />
          <span>
            {total === 0
              ? t("yearInGolf.shareStats.empty")
              : <>{t("yearInGolf.shareStats.openedTimesPrefix")} <span className="font-bold">{total.toLocaleString(i18n.language)}</span> {t("yearInGolf.shareStats.openedTimesSuffix", { count: total })}</>}
          </span>
        </div>
        {total > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-white hover:bg-white/10">
                {t("yearInGolf.actions.breakdown")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <RecapShareStatsBreakdown stats={stats} sourceEntries={sourceEntries} />
            </PopoverContent>
          </Popover>
        )}
      </div>
      {total > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sourceEntries.slice(0, 3).map(([key, n]) => (
            <Badge key={key} variant="secondary" className="bg-white/15 text-white border-white/20 font-normal">
              <span className="mr-1 inline-flex items-center">{SHARE_SOURCE_ICONS[key]}</span>
              {t(`yearInGolf.shareStats.sources.${key}`)} · {n.toLocaleString(i18n.language)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function RecapShareStatsBreakdown({
  stats,
  sourceEntries,
}: {
  stats: RecapShareStats;
  sourceEntries: [RecapShareSourceKey, number][];
}) {
  const { t, i18n } = useTranslation("portal");
  const periods = stats.byPeriod.filter(p => p.total > 0).slice(0, 4);
  const periodLabel = (period: string): string => {
    const key = `yearInGolf.periods.${period}`;
    const translated = t(key);
    return translated === key ? period : translated;
  };
  return (
    <div className="text-sm">
      <div className="font-semibold mb-2">{t("yearInGolf.shareStats.heading")}</div>
      <div className="text-xs text-muted-foreground mb-2">
        {t("yearInGolf.shareStats.total")} <span className="font-semibold text-foreground">{stats.total.toLocaleString(i18n.language)}</span>
      </div>
      <ul className="space-y-1">
        {sourceEntries.map(([key, n]) => (
          <li key={key} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              {SHARE_SOURCE_ICONS[key]}
              {t(`yearInGolf.shareStats.sources.${key}`)}
            </span>
            <span className="tabular-nums font-medium">{n.toLocaleString(i18n.language)}</span>
          </li>
        ))}
      </ul>
      {periods.length > 0 && (
        <>
          <div className="mt-3 pt-2 border-t border-border font-semibold text-xs uppercase tracking-wide text-muted-foreground">
            {t("yearInGolf.shareStats.byPeriod")}
          </div>
          <ul className="mt-1 space-y-1">
            {periods.map(p => (
              <li key={`${p.year}-${p.period}`} className="flex items-center justify-between gap-2 text-xs">
                <span>{p.year} · {periodLabel(p.period)}</span>
                <span className="tabular-nums font-medium">{p.total.toLocaleString(i18n.language)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
