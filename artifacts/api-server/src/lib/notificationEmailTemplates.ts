/**
 * Task #1171 — Branded email templates for the 29 notification keys
 * newly wired through the central dispatcher (Task #1005).
 *
 * Task #1358 — Each renderer now reads its strings (subject, subtitle,
 * intro paragraph, closing paragraph, stat-card row labels, CTA labels,
 * plaintext line) from the per-key bundle exposed by
 * `notificationEmailI18n.ts`, keyed by `ctx.recipientLang`. English is
 * the canonical source, with per-field fallback so partial translations
 * still produce a complete, branded email.
 *
 * Each registered key in this module gets a dedicated render helper
 * that emits the same polished, club-branded layout (logo + primary
 * colour header, dark card body, footer with notification key) the
 * older transactional emails (`sendTournamentRecapEmail`,
 * `sendPaymentReceiptEmail`) already use. The dispatcher
 * (`notifyDispatch.ts`) consults `renderNotificationEmail()` whenever
 * a call site doesn't supply its own `emailHtml`, so feature modules
 * no longer have to assemble a one-off string per dispatch site.
 *
 * The renderers are intentionally pure (string in → string out) so
 * tests can snapshot them without touching SMTP or the DB.
 */
import type { EmailBranding } from "./mailer.js";
import { renderBrandedHeaderHtml } from "./mailer.js";
import {
  fmtNotificationEmail,
  getNotificationEmailBundle,
  type CommonBundle,
  type KeyBundle,
} from "./notificationEmailI18n.js";

export interface NotificationEmailContext {
  /** Display name of the recipient, if known. */
  recipientName?: string | null;
  /** Org branding (logo, colours, name) — passed straight to the header. */
  branding?: EmailBranding;
  /** Title from the dispatch payload (used as a fallback heading). */
  title: string;
  /** Body from the dispatch payload (used as a fallback body line). */
  body: string;
  /** Structured payload from the dispatcher's `data` field. */
  data: Record<string, unknown>;
  /**
   * Recipient's preferred language (BCP-47-ish code, e.g. `"en"`,
   * `"es"`, `"hi"`). Resolved by the dispatcher from
   * `appUsersTable.preferredLanguage`. Unknown / unsupported values
   * fall back to English. Task #1358.
   */
  recipientLang?: string | null;
  /**
   * Task #1622 — Optional hook used by `wrap()` to swap the bare CTA
   * `href` for a click-tracking redirect (`/api/r/email/<token>`). The
   * dispatcher injects this with the recipient's user id baked in;
   * tests / preview tooling that render the template directly leave it
   * unset and get unmodified hrefs (so render snapshots stay stable).
   */
  wrapCtaHref?: ((notificationKey: string, href: string) => string) | null;
}

export interface NotificationEmailRendered {
  subject: string;
  html: string;
  text: string;
}

export type NotificationEmailRenderer = (
  ctx: NotificationEmailContext,
) => NotificationEmailRendered;

/* ─── shared helpers ─────────────────────────────────────────────── */

function escape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function readNumber(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function greeting(ctx: NotificationEmailContext, common: CommonBundle): string {
  const n = ctx.recipientName?.trim();
  return n && n.length > 0 ? n : common.thereFallback;
}

function clubName(ctx: NotificationEmailContext, common: CommonBundle): string {
  return ctx.branding?.orgName?.trim() || common.clubFallback;
}

interface WrapOpts {
  subtitle?: string;
  /** Inner card content (already-rendered HTML). */
  body: string;
  /** Optional pill / chip strip rendered above the body card. */
  pill?: string;
  /** Optional CTA button to render at the bottom of the card. */
  cta?: { label: string; href: string };
  /** Notification registry key, surfaced in the footer for transparency. */
  notificationKey: string;
}

function wrap(ctx: NotificationEmailContext, opts: WrapOpts): string {
  // Task #1622 — when the dispatcher provides a `wrapCtaHref` hook,
  // route the bare destination URL through it so the email recipient
  // hits our click-tracking redirect first. The hook is identity-by-
  // default for direct render() callers (tests, admin preview), so
  // existing snapshots stay stable.
  const ctaHref = opts.cta && ctx.wrapCtaHref
    ? ctx.wrapCtaHref(opts.notificationKey, opts.cta.href)
    : opts.cta?.href;
  const ctaHtml = opts.cta && ctaHref
    ? `<div style="margin:24px 0 0;"><a href="${escape(ctaHref)}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">${escape(opts.cta.label)}</a></div>`
    : "";
  const pillHtml = opts.pill
    ? `<div style="margin:0 0 16px;color:#4ade80;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${opts.pill}</div>`
    : "";
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
  ${renderBrandedHeaderHtml(ctx.branding, opts.subtitle)}
  <div style="padding:32px 40px;">
    ${pillHtml}
    ${opts.body}
    ${ctaHtml}
  </div>
  <div style="padding:14px 40px 28px;color:#4b5563;font-size:11px;border-top:1px solid rgba(255,255,255,0.05);">
    Notification: <code style="color:#9ca3af;">${escape(opts.notificationKey)}</code>
  </div>
</div>`;
}

function plain(ctx: NotificationEmailContext, common: CommonBundle, ...lines: string[]): string {
  const head = `${common.hi} ${greeting(ctx, common)},`;
  return [head, "", ...lines, "", `${common.signOff} ${clubName(ctx, common)}`].join("\n");
}

function paragraph(html: string): string {
  return `<p style="color:#e5e7eb;line-height:1.6;margin:0 0 12px;font-size:14px;">${html}</p>`;
}

function statCard(rows: Array<{ label: string; value: string; highlight?: boolean }>): string {
  const tr = rows
    .map(
      (r) =>
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">${escape(r.label)}</td><td style="padding:8px 0;text-align:right;color:${r.highlight ? "#4ade80" : "#fff"};font-weight:${r.highlight ? "700" : "600"};font-size:${r.highlight ? "16px" : "14px"};">${escape(r.value)}</td></tr>`,
    )
    .join("");
  return `<div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:16px 20px;margin:0 0 16px;">
    <table style="width:100%;border-collapse:collapse;">${tr}</table>
  </div>`;
}

/**
 * Resolve the (common, key) bundle for the renderer's notification key
 * using `ctx.recipientLang`. Always returns a fully-populated bundle
 * (English fallback applied per-field). Throws only if the key is
 * unknown — that's a programmer error, not a runtime localisation
 * gap.
 */
function bundleFor(
  ctx: NotificationEmailContext,
  notificationKey: string,
): { common: CommonBundle; key: KeyBundle } {
  const b = getNotificationEmailBundle(ctx.recipientLang, notificationKey);
  if (!b) {
    throw new Error(`No i18n bundle registered for notification key "${notificationKey}"`);
  }
  return b;
}

/* ─── renderers ──────────────────────────────────────────────────── */

const r_achievement_unlocked: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "achievement.unlocked");
  const name = readString(ctx.data, "achievementName")
    ?? readString(ctx.data, "name")
    ?? kb.extras?.defaultName ?? "a new achievement";
  const desc = readString(ctx.data, "description") ?? kb.extras?.defaultDescription ?? "Keep playing to unlock the next one.";
  const url = readString(ctx.data, "achievementUrl") ?? readString(ctx.data, "profileUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { name });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    club: escape(clubName(ctx, common)),
  });
  const body =
    paragraph(intro) +
    statCard([{ label: kb.labels?.achievement ?? "Achievement", value: name, highlight: true }]) +
    paragraph(escape(desc));
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { name }), desc, url ? `Open: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "achievement.unlocked",
    }),
  };
};

const r_booking_confirmed: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "booking.confirmed");
  const courseName = readString(ctx.data, "courseName") ?? "the course";
  const teeTime = readString(ctx.data, "teeTime") ?? readString(ctx.data, "startTime") ?? "your scheduled tee time";
  const partySize = readNumber(ctx.data, "partySize");
  const url = readString(ctx.data, "bookingUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
    { label: kb.labels?.teeTime ?? "Tee time", value: teeTime },
  ];
  if (partySize != null) rows.push({ label: kb.labels?.party ?? "Party size", value: String(partySize) });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName, teeTime }), url ? `View booking: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "booking.confirmed",
    }),
  };
};

const r_booking_reminder_24h: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "booking.reminder.24h");
  const courseName = readString(ctx.data, "courseName") ?? "the course";
  const teeTime = readString(ctx.data, "teeTime") ?? "tomorrow";
  const url = readString(ctx.data, "bookingUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body =
    paragraph(intro) +
    statCard([
      { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
      { label: kb.labels?.teeTime ?? "Tee time", value: teeTime },
    ]) +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName, teeTime }), url ? `View booking: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "booking.reminder.24h",
    }),
  };
};

const r_booking_reminder_2h: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "booking.reminder.2h");
  const courseName = readString(ctx.data, "courseName") ?? "the course";
  const teeTime = readString(ctx.data, "teeTime") ?? kb.extras?.defaultTeeTime ?? "in two hours";
  const url = readString(ctx.data, "bookingUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body =
    paragraph(intro) +
    statCard([
      { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
      { label: kb.labels?.teeTime ?? "Tee time", value: teeTime },
    ]) +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName, teeTime }), url ? `View booking: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "booking.reminder.2h",
    }),
  };
};

const r_booking_cancelled: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "booking.cancelled");
  const courseName = readString(ctx.data, "courseName") ?? "your booking";
  const teeTime = readString(ctx.data, "teeTime");
  const reason = readString(ctx.data, "reason");
  const url = readString(ctx.data, "bookingUrl") ?? readString(ctx.data, "rebookUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
  ];
  if (teeTime) rows.push({ label: kb.labels?.teeTime ?? "Tee time", value: teeTime });
  if (reason) rows.push({ label: kb.labels?.reason ?? "Reason", value: reason });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName }), url ? `View booking: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "booking.cancelled",
    }),
  };
};

const r_booking_waitlist_promoted: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "booking.waitlist.promoted");
  const courseName = readString(ctx.data, "courseName") ?? "your requested course";
  const teeTime = readString(ctx.data, "teeTime");
  const url = readString(ctx.data, "bookingUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
  ];
  if (teeTime) rows.push({ label: kb.labels?.teeTime ?? "Tee time", value: teeTime });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName }), url ? `View booking: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "booking.waitlist.promoted",
    }),
  };
};

const r_caddie_mode_blocked: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "caddie.mode.blocked");
  const reason = readString(ctx.data, "reason") ?? kb.extras?.defaultReason ?? "round mode rules at this club";
  const url = readString(ctx.data, "settingsUrl") ?? readString(ctx.data, "roundUrl") ?? readString(ctx.data, "url");
  const subject = kb.subject;
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body =
    paragraph(intro) +
    statCard([{ label: kb.labels?.reason ?? "Reason", value: reason, highlight: true }]) +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { reason }), url ? `Open: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "caddie.mode.blocked",
    }),
  };
};

const r_coach_review_delivered: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "coach.review.delivered");
  const coach = readString(ctx.data, "coachName") ?? kb.extras?.defaultCoach ?? "Your coach";
  const reviewUrl = readString(ctx.data, "reviewUrl");
  const subject = fmtNotificationEmail(kb.subject, { coach });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    coach: escape(coach),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { coach }), reviewUrl ? `Watch it: ${reviewUrl}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: reviewUrl && kb.ctaLabel ? { label: kb.ctaLabel, href: reviewUrl } : undefined,
      notificationKey: "coach.review.delivered",
    }),
  };
};

const r_course_correction_resolved: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "course.correction.resolved");
  const decision = readString(ctx.data, "decision") ?? "reviewed";
  const fieldName = readString(ctx.data, "fieldName") ?? kb.extras?.defaultField ?? "your reported field";
  const holeNumber = readNumber(ctx.data, "holeNumber");
  const reviewNotes = readString(ctx.data, "reviewNotes");
  const url = readString(ctx.data, "correctionUrl") ?? readString(ctx.data, "courseUrl") ?? readString(ctx.data, "url");
  const verb =
    decision === "accepted" ? (kb.extras?.accepted ?? "accepted")
    : decision === "rejected" ? (kb.extras?.rejected ?? "rejected")
    : decision === "reviewed" ? (kb.extras?.reviewed ?? "reviewed")
    : decision;
  const subject = fmtNotificationEmail(kb.subject, { verb });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.field ?? "Field", value: fieldName, highlight: true },
    { label: kb.labels?.outcome ?? "Outcome", value: verb },
  ];
  if (holeNumber != null) rows.splice(1, 0, { label: kb.labels?.hole ?? "Hole", value: String(holeNumber) });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    club: escape(clubName(ctx, common)),
  });
  const body =
    paragraph(intro) +
    statCard(rows) +
    (reviewNotes ? paragraph(`<em style="color:#9ca3af;">${kb.labels?.reviewerNote ?? "Reviewer note:"}</em> ${escape(reviewNotes)}`) : "") +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      fieldName,
      holePart: holeNumber != null ? ` on hole ${holeNumber}` : "",
      verb,
    }), url ? `View details: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "course.correction.resolved",
    }),
  };
};

const r_handicap_committee_changed: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "handicap.committee.changed");
  const newIndex = readString(ctx.data, "newIndex")
    ?? readString(ctx.data, "indexAfter")
    ?? kb.extras?.defaultIndex ?? "your updated index";
  const previousIndex = readString(ctx.data, "previousIndex") ?? readString(ctx.data, "indexBefore");
  const reason = readString(ctx.data, "reason");
  const url = readString(ctx.data, "handicapUrl") ?? readString(ctx.data, "profileUrl") ?? readString(ctx.data, "url");
  const subject = kb.subject;
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [];
  if (previousIndex) rows.push({ label: kb.labels?.previousIndex ?? "Previous index", value: previousIndex });
  rows.push({ label: kb.labels?.newIndex ?? "New index", value: newIndex, highlight: true });
  if (reason) rows.push({ label: kb.labels?.reason ?? "Reason", value: reason });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    club: escape(clubName(ctx, common)),
  });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      newIndex,
      reasonPart: reason ? `\nReason: ${reason}.` : "",
    }), url ? `View handicap: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "handicap.committee.changed",
    }),
  };
};

const r_handicap_exceptional_score: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "handicap.exceptional.score");
  const differential = readString(ctx.data, "differential") ?? kb.extras?.defaultDifferential ?? "an exceptional differential";
  const reduction = readString(ctx.data, "reduction") ?? kb.extras?.defaultReduction ?? "a downward reduction";
  const url = readString(ctx.data, "handicapUrl") ?? readString(ctx.data, "explainerUrl") ?? readString(ctx.data, "url");
  const subject = kb.subject;
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body =
    paragraph(intro) +
    statCard([
      { label: kb.labels?.differential ?? "Differential", value: differential, highlight: true },
      { label: kb.labels?.adjustment ?? "Adjustment", value: reduction },
    ]) +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { differential, reduction }), url ? `View handicap: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "handicap.exceptional.score",
    }),
  };
};

const r_highlight_ready: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "highlight.ready");
  const url = readString(ctx.data, "highlightUrl") ?? readString(ctx.data, "url");
  const subject = kb.subject;
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, kb.text, url ? `Watch: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "highlight.ready",
    }),
  };
};

const r_leaderboard_position_change: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "leaderboard.position.change");
  const oldPos = readNumber(ctx.data, "previousPosition");
  const newPos = readNumber(ctx.data, "newPosition") ?? readNumber(ctx.data, "position");
  const tournamentName = readString(ctx.data, "tournamentName") ?? kb.extras?.defaultTournament ?? "the leaderboard";
  const url = readString(ctx.data, "leaderboardUrl") ?? readString(ctx.data, "tournamentUrl") ?? readString(ctx.data, "url");
  const directionKey: "movedUp" | "slipped" | "steady" | "moved" =
    oldPos != null && newPos != null
      ? (newPos < oldPos ? "movedUp" : newPos > oldPos ? "slipped" : "steady")
      : "moved";
  const direction = kb.extras?.[directionKey] ?? directionKey;
  const directionCap = direction.length > 0
    ? direction.charAt(0).toUpperCase() + direction.slice(1)
    : direction;
  const subject = fmtNotificationEmail(kb.subject, { direction, DirectionCap: directionCap, tournament: tournamentName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [];
  if (oldPos != null) rows.push({ label: kb.labels?.was ?? "Was", value: `T${oldPos}` });
  if (newPos != null) rows.push({ label: kb.labels?.now ?? "Now", value: `T${newPos}`, highlight: true });
  rows.push({ label: kb.labels?.tournament ?? "Tournament", value: tournamentName });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    direction,
  });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { direction, tournament: tournamentName }), url ? `View leaderboard: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "leaderboard.position.change",
    }),
  };
};

const r_league_standings_updated: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "league.standings.updated");
  const leagueName = readString(ctx.data, "leagueName") ?? kb.extras?.defaultLeague ?? "your league";
  const position = readNumber(ctx.data, "position");
  const url = readString(ctx.data, "standingsUrl") ?? readString(ctx.data, "leagueUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { league: leagueName });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    league: escape(leagueName),
  });
  const body =
    paragraph(intro) +
    (position != null ? statCard([{ label: kb.labels?.yourPosition ?? "Your position", value: `#${position}`, highlight: true }]) : "") +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      league: leagueName,
      positionPart: position != null ? ` — you are now #${position}` : "",
    }), url ? `View standings: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "league.standings.updated",
    }),
  };
};

const r_marker_share_requested: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "marker.share.requested");
  // Accept the common aliases real dispatch sites tend to use
  // (`fromName`, `requestedBy`) so we don't fall back to the generic
  // "A playing partner" wording when callers pick a different field
  // name for the requester.
  const requester =
    readString(ctx.data, "requesterName")
    ?? readString(ctx.data, "fromName")
    ?? readString(ctx.data, "requestedBy")
    ?? readString(ctx.data, "playerName")
    ?? kb.extras?.defaultRequester ?? "A playing partner";
  const url = readString(ctx.data, "markerUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { requester });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    requester: escape(requester),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { requester }), url ? `Open: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "marker.share.requested",
    }),
  };
};

const r_match_scheduled: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "match.scheduled");
  const opponent = readString(ctx.data, "opponentName") ?? kb.extras?.defaultOpponent ?? "your opponent";
  const teeTime = readString(ctx.data, "teeTime")
    ?? readString(ctx.data, "startTime")
    ?? kb.extras?.defaultTeeTime ?? "TBC";
  const courseName = readString(ctx.data, "courseName");
  const url = readString(ctx.data, "matchUrl") ?? readString(ctx.data, "bracketUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { opponent });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.opponent ?? "Opponent", value: opponent, highlight: true },
    { label: kb.labels?.teeTime ?? "Tee time", value: teeTime },
  ];
  if (courseName) rows.push({ label: kb.labels?.course ?? "Course", value: courseName });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { opponent, teeTime }), url ? `View match: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "match.scheduled",
    }),
  };
};

const r_match_result_recorded: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "match.result.recorded");
  const opponent = readString(ctx.data, "opponentName") ?? kb.extras?.defaultOpponent ?? "your opponent";
  const result = readString(ctx.data, "result") ?? kb.extras?.defaultResult ?? "the result";
  const score = readString(ctx.data, "score");
  const url = readString(ctx.data, "matchUrl") ?? readString(ctx.data, "bracketUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { opponent });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.opponent ?? "Opponent", value: opponent },
    { label: kb.labels?.result ?? "Result", value: result, highlight: true },
  ];
  if (score) rows.push({ label: kb.labels?.score ?? "Score", value: score });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      opponent,
      result,
      scorePart: score ? ` (${score})` : "",
    }), url ? `View match: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "match.result.recorded",
    }),
  };
};

const r_post_round_results: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "post.round.results");
  const courseName = readString(ctx.data, "courseName") ?? "your course";
  const gross = readString(ctx.data, "grossScore") ?? readNumber(ctx.data, "grossScore")?.toString();
  const net = readString(ctx.data, "netScore") ?? readNumber(ctx.data, "netScore")?.toString();
  const stableford = readString(ctx.data, "stableford") ?? readNumber(ctx.data, "stableford")?.toString();
  const url = readString(ctx.data, "roundUrl") ?? readString(ctx.data, "scorecardUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName },
  ];
  if (gross) rows.push({ label: kb.labels?.gross ?? "Gross", value: gross, highlight: true });
  if (net) rows.push({ label: kb.labels?.net ?? "Net", value: net });
  if (stableford) rows.push({ label: kb.labels?.stableford ?? "Stableford", value: stableford });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  const grossPrefix = kb.extras?.grossPrefix ?? "gross";
  const netPrefix = kb.extras?.netPrefix ?? "net";
  const resultsPosted = kb.extras?.resultsPosted ?? "results posted";
  const scoreSummary = [gross && `${grossPrefix} ${gross}`, net && `${netPrefix} ${net}`].filter(Boolean).join(", ") || resultsPosted;
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { course: courseName, scoreSummary }), url ? `View round: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "post.round.results",
    }),
  };
};

const r_post_event_survey: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "post.event.survey");
  const tournamentName = readString(ctx.data, "tournamentName") ?? readString(ctx.data, "eventName") ?? kb.extras?.defaultTournament ?? kb.extras?.defaultEvent ?? "the tournament";
  const surveyUrl = readString(ctx.data, "surveyUrl") ?? readString(ctx.data, "url");
  // Task #2012 — when an admin fires the follow-up nudge for players
  // who haven't submitted, the dispatch site sets `data.isReminder`
  // so this renderer can swap in the reminder copy localised in
  // `notificationEmailI18n.ts` (subject/closing/text). The non-reminder
  // strings are used as the fallback so partially-translated languages
  // and direct-render callers (tests / preview) keep working.
  const isReminder = ctx.data["isReminder"] === true;
  const subjectTpl = isReminder ? (kb.reminderSubject ?? kb.subject) : kb.subject;
  const closingStr = isReminder ? (kb.reminderClosing ?? kb.closing) : kb.closing;
  const textTpl = isReminder ? (kb.reminderText ?? kb.text) : kb.text;
  const vars = { tournament: tournamentName, event: tournamentName };
  const subject = fmtNotificationEmail(subjectTpl, vars);
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    tournament: escape(tournamentName),
    event: escape(tournamentName),
  });
  const body = paragraph(intro) + paragraph(closingStr);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(textTpl, vars), surveyUrl ? `Open the survey: ${surveyUrl}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: surveyUrl && kb.ctaLabel ? { label: kb.ctaLabel, href: surveyUrl } : undefined,
      notificationKey: "post.event.survey",
    }),
  };
};

const r_recap_year_ready: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "recap.year.ready");
  const year = readNumber(ctx.data, "year") ?? new Date().getFullYear();
  const url = readString(ctx.data, "recapUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { year: String(year) });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    year: String(year),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { year: String(year) }), url ? `Open: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "recap.year.ready",
    }),
  };
};

const r_scoring_event_eagle: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "scoring.event.eagle");
  const courseName = readString(ctx.data, "courseName") ?? "your course";
  const holeNumber = readNumber(ctx.data, "holeNumber");
  const score = readString(ctx.data, "score") ?? kb.extras?.defaultScore ?? "an eagle";
  const url = readString(ctx.data, "highlightUrl") ?? readString(ctx.data, "roundUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName },
  ];
  if (holeNumber != null) rows.push({ label: kb.labels?.hole ?? "Hole", value: String(holeNumber) });
  rows.push({ label: kb.labels?.score ?? "Score", value: score, highlight: true });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    score: escape(score),
    club: escape(clubName(ctx, common)),
  });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      course: courseName,
      holePart: holeNumber != null ? `, hole ${holeNumber}` : "",
    }), url ? `View highlight: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "scoring.event.eagle",
    }),
  };
};

const r_scoring_event_hole_in_one: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "scoring.event.hole_in_one");
  const courseName = readString(ctx.data, "courseName") ?? "your course";
  const holeNumber = readNumber(ctx.data, "holeNumber");
  const club = readString(ctx.data, "club");
  const distance = readString(ctx.data, "distance");
  const url = readString(ctx.data, "highlightUrl") ?? readString(ctx.data, "roundUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { course: courseName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: kb.labels?.course ?? "Course", value: courseName, highlight: true },
  ];
  if (holeNumber != null) rows.push({ label: kb.labels?.hole ?? "Hole", value: String(holeNumber) });
  if (club) rows.push({ label: kb.labels?.club ?? "Club", value: club });
  if (distance) rows.push({ label: kb.labels?.distance ?? "Distance", value: distance });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body = paragraph(intro) + statCard(rows) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      course: courseName,
      holePart: holeNumber != null ? `, hole ${holeNumber}` : "",
    }), url ? `View highlight: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "scoring.event.hole_in_one",
    }),
  };
};

const r_tournament_cut_applied: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "tournament.cut.applied");
  const tournamentName = readString(ctx.data, "tournamentName") ?? kb.extras?.defaultTournament ?? "the tournament";
  const throughRound = readNumber(ctx.data, "throughRound") ?? 2;
  const madeCut = ctx.data["madeCut"];
  // Survivors get sent to their round-3 grouping; eliminated players
  // (or the generic "cut applied" path) land on the public
  // leaderboard. Pick the alias order to match that intent so the CTA
  // label and the href stay consistent.
  const url = madeCut === true
    ? (readString(ctx.data, "groupingUrl")
      ?? readString(ctx.data, "leaderboardUrl")
      ?? readString(ctx.data, "tournamentUrl")
      ?? readString(ctx.data, "url"))
    : (readString(ctx.data, "leaderboardUrl")
      ?? readString(ctx.data, "groupingUrl")
      ?? readString(ctx.data, "tournamentUrl")
      ?? readString(ctx.data, "url"));
  const status =
    madeCut === true ? (kb.extras?.statusMade ?? "MADE THE CUT")
    : madeCut === false ? (kb.extras?.statusMissed ?? "MISSED THE CUT")
    : (kb.extras?.statusGeneric ?? "CUT APPLIED");
  const closingByStatus =
    madeCut === true ? (kb.extras?.closingMade ?? "")
    : madeCut === false ? (kb.extras?.closingMissed ?? "")
    : (kb.extras?.closingGeneric ?? "");
  const subject = fmtNotificationEmail(kb.subject, { tournament: tournamentName, round: String(throughRound) });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    tournament: escape(tournamentName),
    round: String(throughRound),
  });
  const roundLabelPrefix = kb.extras?.roundLabelPrefix ?? "Round";
  const body =
    paragraph(intro) +
    statCard([
      { label: kb.labels?.status ?? "Status", value: status, highlight: true },
      { label: kb.labels?.round ?? "Round", value: `${roundLabelPrefix} ${throughRound}` },
    ]) +
    paragraph(fmtNotificationEmail(kb.closing, { closingByStatus }));
  const ctaLabel = madeCut === true ? (kb.labels?.viewGrouping ?? "View grouping") : (kb.labels?.viewLeaderboard ?? "View leaderboard");
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      tournament: tournamentName,
      round: String(throughRound),
      status,
    }), url ? `${ctaLabel}: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url ? { label: ctaLabel, href: url } : undefined,
      notificationKey: "tournament.cut.applied",
    }),
  };
};

const r_tournament_tee_published: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "tournament.tee.published");
  const tournamentName = readString(ctx.data, "tournamentName") ?? kb.extras?.defaultTournament ?? "your tournament";
  const teeTime = readString(ctx.data, "teeTime");
  const startingHole = readString(ctx.data, "startingHole");
  const url = readString(ctx.data, "teeSheetUrl") ?? readString(ctx.data, "tournamentUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { tournament: tournamentName });
  const rows: Array<{ label: string; value: string; highlight?: boolean }> = [];
  if (teeTime) rows.push({ label: kb.labels?.yourTeeTime ?? "Your tee time", value: teeTime, highlight: true });
  if (startingHole) rows.push({ label: kb.labels?.startingHole ?? "Starting hole", value: startingHole });
  rows.push({ label: kb.labels?.tournament ?? "Tournament", value: tournamentName });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    tournament: escape(tournamentName),
  });
  const body =
    paragraph(intro) +
    (rows.length > 0 ? statCard(rows) : "") +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, {
      tournament: tournamentName,
      teeTimePart: teeTime ? ` — you tee off ${teeTime}` : "",
    }), url ? `View tee sheet: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "tournament.tee.published",
    }),
  };
};

const r_wearable_reauth_required: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "wearable.reauth.required");
  const provider = readString(ctx.data, "provider") ?? kb.extras?.defaultProvider ?? "your wearable";
  const url = readString(ctx.data, "reauthUrl") ?? readString(ctx.data, "settingsUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { provider });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    provider: escape(provider),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { provider }), url ? `Re-authorise: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: fmtNotificationEmail(kb.ctaLabel, { provider }), href: url } : undefined,
      notificationKey: "wearable.reauth.required",
    }),
  };
};

const r_interclub_qualified: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "interclub.qualified");
  const eventName = readString(ctx.data, "eventName") ?? kb.extras?.defaultEvent ?? "the inter-club final";
  const url = readString(ctx.data, "eventUrl") ?? readString(ctx.data, "confirmUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { event: eventName });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    event: escape(eventName),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { event: eventName }), url ? `Confirm spot: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "interclub.qualified",
    }),
  };
};

const r_streak_milestone: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "streak.milestone");
  // Accept `streakLabel` and `streakType` as aliases for the streak
  // name, and `days` / `count` / `streakLength` as aliases for the
  // milestone counter, so common payload shapes from streak-tracking
  // jobs render meaningful copy without further plumbing.
  const streakName =
    readString(ctx.data, "streakName")
    ?? readString(ctx.data, "streakLabel")
    ?? readString(ctx.data, "streakType")
    ?? kb.extras?.defaultStreak ?? "Your streak";
  const milestoneRaw =
    readString(ctx.data, "milestone")
    ?? readString(ctx.data, "days")
    ?? readString(ctx.data, "count")
    ?? readString(ctx.data, "streakLength");
  const milestone = milestoneRaw ?? kb.extras?.defaultMilestone ?? "a new milestone";
  const url = readString(ctx.data, "streakUrl") ?? readString(ctx.data, "profileUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { streak: streakName, milestone });
  const intro = fmtNotificationEmail(kb.intro, { recipient: escape(greeting(ctx, common)) });
  const body =
    paragraph(intro) +
    statCard([
      { label: kb.labels?.streak ?? "Streak", value: streakName },
      { label: kb.labels?.milestone ?? "Milestone", value: milestone, highlight: true },
    ]) +
    paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { streak: streakName, milestone }), url ? `View streak: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "streak.milestone",
    }),
  };
};

const r_near_miss: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "near.miss");
  // Accept `eventName` / `achievementName` as aliases for the badge
  // and `missedBy` / `delta` as aliases for the gap, so dispatch sites
  // that describe a near-miss in terms of a tournament finish (rather
  // than an unlocked badge) still render specific copy.
  const badgeName =
    readString(ctx.data, "badgeName")
    ?? readString(ctx.data, "achievementName")
    ?? readString(ctx.data, "eventName")
    ?? kb.extras?.defaultBadge ?? "a badge";
  const gap =
    readString(ctx.data, "gap")
    ?? readString(ctx.data, "missedBy")
    ?? readString(ctx.data, "delta")
    ?? kb.extras?.defaultGap ?? "a hair";
  const url = readString(ctx.data, "roundUrl") ?? readString(ctx.data, "profileUrl") ?? readString(ctx.data, "url");
  const subject = fmtNotificationEmail(kb.subject, { badge: badgeName, gap });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    gap: escape(gap),
    badge: escape(badgeName),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { badge: badgeName, gap }), url ? `View round: ${url}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: url && kb.ctaLabel ? { label: kb.ctaLabel, href: url } : undefined,
      notificationKey: "near.miss",
    }),
  };
};

const r_verified_handicap_expiring: NotificationEmailRenderer = (ctx) => {
  const { common, key: kb } = bundleFor(ctx, "verified.handicap.expiring");
  const expiresOn = readString(ctx.data, "expiresOn")
    ?? readString(ctx.data, "expiresAt")
    ?? kb.extras?.defaultExpires ?? "soon";
  const renewUrl = readString(ctx.data, "renewUrl");
  const subject = fmtNotificationEmail(kb.subject, { expires: expiresOn });
  const intro = fmtNotificationEmail(kb.intro, {
    recipient: escape(greeting(ctx, common)),
    expires: escape(expiresOn),
  });
  const body = paragraph(intro) + paragraph(kb.closing);
  return {
    subject,
    text: plain(ctx, common, fmtNotificationEmail(kb.text, { expires: expiresOn }), renewUrl ? `Renew: ${renewUrl}` : ""),
    html: wrap(ctx, {
      subtitle: kb.subtitle,
      body,
      cta: renewUrl && kb.ctaLabel ? { label: kb.ctaLabel, href: renewUrl } : undefined,
      notificationKey: "verified.handicap.expiring",
    }),
  };
};

/* ─── registry ───────────────────────────────────────────────────── */

export const NOTIFICATION_EMAIL_TEMPLATES: Record<string, NotificationEmailRenderer> = {
  "achievement.unlocked": r_achievement_unlocked,
  "booking.confirmed": r_booking_confirmed,
  "booking.reminder.24h": r_booking_reminder_24h,
  "booking.reminder.2h": r_booking_reminder_2h,
  "booking.cancelled": r_booking_cancelled,
  "booking.waitlist.promoted": r_booking_waitlist_promoted,
  "caddie.mode.blocked": r_caddie_mode_blocked,
  "coach.review.delivered": r_coach_review_delivered,
  "course.correction.resolved": r_course_correction_resolved,
  "handicap.committee.changed": r_handicap_committee_changed,
  "handicap.exceptional.score": r_handicap_exceptional_score,
  "highlight.ready": r_highlight_ready,
  "leaderboard.position.change": r_leaderboard_position_change,
  "league.standings.updated": r_league_standings_updated,
  "marker.share.requested": r_marker_share_requested,
  "match.scheduled": r_match_scheduled,
  "match.result.recorded": r_match_result_recorded,
  "post.event.survey": r_post_event_survey,
  "post.round.results": r_post_round_results,
  "recap.year.ready": r_recap_year_ready,
  "scoring.event.eagle": r_scoring_event_eagle,
  "scoring.event.hole_in_one": r_scoring_event_hole_in_one,
  "tournament.cut.applied": r_tournament_cut_applied,
  "tournament.tee.published": r_tournament_tee_published,
  "wearable.reauth.required": r_wearable_reauth_required,
  "interclub.qualified": r_interclub_qualified,
  "streak.milestone": r_streak_milestone,
  "near.miss": r_near_miss,
  "verified.handicap.expiring": r_verified_handicap_expiring,
};

/** Snapshot the registered keys (sorted) — used by tests and admin tooling. */
export function listBrandedNotificationKeys(): string[] {
  return Object.keys(NOTIFICATION_EMAIL_TEMPLATES).sort();
}

/**
 * Look up a branded renderer for `key` and produce subject/html/text.
 * Returns `null` when the key has no dedicated template (the dispatcher
 * then falls back to the generic `sendNotificationEmail` wrapper).
 */
export function renderNotificationEmail(
  key: string,
  ctx: NotificationEmailContext,
): NotificationEmailRendered | null {
  const renderer = NOTIFICATION_EMAIL_TEMPLATES[key];
  if (!renderer) return null;
  return renderer(ctx);
}
