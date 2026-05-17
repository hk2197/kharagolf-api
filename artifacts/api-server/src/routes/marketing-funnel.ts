/**
 * Marketing funnel endpoints (Task #382).
 *
 * Public, no-auth endpoints used by the KHARAGOLF marketing website
 * (artifacts/kharagolf-website) to power the conversion funnel:
 *
 *   POST /api/public/roi-calculation   – compute ROI uplift, email lead + sales
 *   GET  /api/public/demo-slots        – list available 30-min demo slots
 *   POST /api/public/demo-booking      – book a slot, send confirmation + sales alert
 *   POST /api/public/funnel-event      – lightweight server-side analytics beacon
 */
import { Router, type IRouter, type Request, type Response } from "express";
import nodemailer from "nodemailer";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const GMAIL_USER = process.env.GMAIL_USER ?? "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? "";
const SALES_TO = GMAIL_USER || "noreply@kharagolf.com";

function escHtml(v: string | number | undefined | null): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendMail(opts: {
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return false;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"KHARAGOLF" <${GMAIL_USER}>`,
      to: opts.to,
      replyTo: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
    });
    return true;
  } catch (err) {
    logger.warn({ err }, "[MARKETING-FUNNEL] Email send failed");
    return false;
  }
}

function brandedHtml(title: string, body: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;">
      <div style="background:#1e4d2b;padding:28px 32px;">
        <h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">
          <span style="color:#fff;">KHARA</span><span style="color:#C9A84C;">GOLF</span>
        </h1>
        <p style="color:#C9A84C;margin:6px 0 0;font-size:11px;letter-spacing:3px;text-transform:uppercase;">${escHtml(title)}</p>
      </div>
      <div style="padding:32px;background:#ffffff;border:1px solid #e5e7eb;">${body}</div>
      <div style="padding:16px 32px;background:#f3f4f6;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">KHARAGOLF — Tournament Operating System for Golf Clubs</p>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// ROI CALCULATOR
// ─────────────────────────────────────────────────────────────────────

type RoiInputs = {
  members?: number;
  tournamentsPerYear?: number;
  hoursPerTournament?: number;
  hourlyRate?: number;
  paperCostPerEvent?: number;
  greenFeeUplift?: number;
};

function computeRoi(input: RoiInputs) {
  const members = Math.max(0, Number(input.members ?? 0));
  const events = Math.max(0, Number(input.tournamentsPerYear ?? 0));
  const hours = Math.max(0, Number(input.hoursPerTournament ?? 8));
  const rate = Math.max(0, Number(input.hourlyRate ?? 800));
  const paperCost = Math.max(0, Number(input.paperCostPerEvent ?? 1500));
  const upliftPct = Math.max(0, Math.min(50, Number(input.greenFeeUplift ?? 8)));

  // KHARAGOLF automates ~70% of tournament admin work.
  const hoursSavedPerEvent = hours * 0.7;
  const staffSavingsAnnual = Math.round(hoursSavedPerEvent * rate * events);
  const paperSavingsAnnual = Math.round(paperCost * events);
  // Member retention uplift: dynamic pricing + visible leaderboards lift play frequency.
  const avgMemberSpend = 18000; // INR / member / year — average for Indian private clubs
  const retentionUplift = Math.round(members * avgMemberSpend * (upliftPct / 100));

  const totalAnnual = staffSavingsAnnual + paperSavingsAnnual + retentionUplift;
  const platformCostAnnual = events <= 4 ? 0 : events <= 24 ? 9999 * 12 : 24999 * 12;
  const netRoi = totalAnnual - platformCostAnnual;
  const roiMultiple = platformCostAnnual > 0 ? +(totalAnnual / platformCostAnnual).toFixed(1) : null;

  return {
    inputs: { members, tournamentsPerYear: events, hoursPerTournament: hours, hourlyRate: rate, paperCostPerEvent: paperCost, greenFeeUplift: upliftPct },
    breakdown: {
      staffSavingsAnnual,
      paperSavingsAnnual,
      retentionUplift,
      hoursSavedPerEvent: +hoursSavedPerEvent.toFixed(1),
      hoursSavedAnnual: +(hoursSavedPerEvent * events).toFixed(1),
    },
    totalAnnual,
    platformCostAnnual,
    netRoi,
    roiMultiple,
    currency: "INR",
  };
}

router.post("/roi-calculation", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as RoiInputs & {
    name?: string;
    email?: string;
    clubName?: string;
  };
  const result = computeRoi(body);

  // If email is provided, send the lead a copy + notify sales.
  const email = (body.email ?? "").trim();
  const name = (body.name ?? "").trim();
  const clubName = (body.clubName ?? "").trim();

  if (email) {
    const fmt = (n: number) => `₹${n.toLocaleString("en-IN")}`;
    const summary = `
      <p style="font-size:14px;color:#374151;margin:0 0 16px;">Hi ${escHtml(name) || "there"},</p>
      <p style="font-size:14px;color:#374151;line-height:1.6;">
        Thanks for using the KHARAGOLF ROI calculator. Based on the numbers you entered for
        <strong>${escHtml(clubName) || "your club"}</strong>, here's what KHARAGOLF could deliver in a typical year:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:24px 0;">
        <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">Staff time recovered</td><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(result.breakdown.staffSavingsAnnual)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">Paper / printing eliminated</td><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(result.breakdown.paperSavingsAnnual)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">Retention &amp; revenue uplift</td><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(result.breakdown.retentionUplift)}</td></tr>
        <tr><td style="padding:14px 0;color:#0A1A0F;font-weight:700;font-size:15px;">Total annual value</td><td style="padding:14px 0;text-align:right;font-weight:800;color:#1e4d2b;font-size:18px;">${fmt(result.totalAnnual)}</td></tr>
        ${result.roiMultiple ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:12px;">Platform investment</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:12px;">${fmt(result.platformCostAnnual)} • ${result.roiMultiple}× return</td></tr>` : ""}
      </table>
      <p style="font-size:14px;color:#374151;line-height:1.6;">
        Want to see exactly how we'd deliver these numbers for your club?
        Reply to this email or
        <a href="${escHtml(process.env.APP_BASE_URL ?? "https://kharagolf.com")}/#demo" style="color:#1e4d2b;font-weight:600;">book a 30-minute walkthrough</a>.
      </p>
    `;
    await sendMail({
      to: email,
      replyTo: GMAIL_USER || undefined,
      subject: `Your KHARAGOLF ROI estimate: ${fmt(result.totalAnnual)}/year`,
      html: brandedHtml("Your ROI Estimate", summary),
    });

    // Sales notification
    const salesBody = `
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:160px;">Name</td><td style="padding:8px 0;font-weight:600;">${escHtml(name) || "—"}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:8px 0;">${escHtml(email)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Club</td><td style="padding:8px 0;">${escHtml(clubName) || "—"}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Members</td><td style="padding:8px 0;">${result.inputs.members}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Tournaments / yr</td><td style="padding:8px 0;">${result.inputs.tournamentsPerYear}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Annual value (calc)</td><td style="padding:8px 0;font-weight:700;color:#1e4d2b;">₹${result.totalAnnual.toLocaleString("en-IN")}</td></tr>
      </table>
    `;
    await sendMail({
      to: SALES_TO,
      replyTo: email,
      subject: `[ROI lead] ${name || email} — ₹${result.totalAnnual.toLocaleString("en-IN")}/yr`,
      html: brandedHtml("New ROI Calculator Lead", salesBody),
    });
  }

  res.json({ ok: true, ...result });
});

// ─────────────────────────────────────────────────────────────────────
// DEMO SLOTS + BOOKING
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns available 30-min demo slots for the next ~14 weekdays.
 * The slots are returned as ISO UTC timestamps; the client renders them
 * in the visitor's timezone for display. Times correspond to 10:00–17:00 IST
 * (KHARAGOLF business hours), Mon–Fri.
 */
router.get("/demo-slots", (_req: Request, res: Response) => {
  const slots: { startUtc: string; endUtc: string }[] = [];
  const now = new Date();
  const ISTOffsetMs = 5.5 * 60 * 60 * 1000;

  for (let day = 1; day <= 21 && slots.length < 60; day++) {
    const d = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
    // Business hours: 10:00, 11:00, 14:00, 15:00, 16:00 IST
    const istHours = [10, 11, 14, 15, 16];
    const istMidnightUtcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ISTOffsetMs;
    // Compute weekday in IST
    const istDate = new Date(istMidnightUtcMs + ISTOffsetMs);
    const dow = istDate.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) continue;
    for (const h of istHours) {
      const startMs = istMidnightUtcMs + h * 60 * 60 * 1000;
      if (startMs <= now.getTime() + 12 * 60 * 60 * 1000) continue; // 12h notice
      slots.push({
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(startMs + 30 * 60 * 1000).toISOString(),
      });
    }
  }
  res.json({ slots, businessTimezone: "Asia/Kolkata" });
});

router.post("/demo-booking", async (req: Request, res: Response) => {
  const {
    name,
    email,
    clubName,
    phone,
    timezone,
    startUtc,
    interest,
    message,
  } = (req.body ?? {}) as Record<string, string | undefined>;

  if (!name || !email || !startUtc) {
    res.status(400).json({ error: "name, email and startUtc are required" });
    return;
  }
  const start = new Date(startUtc);
  if (isNaN(start.getTime())) {
    res.status(400).json({ error: "Invalid startUtc" });
    return;
  }
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  // Render the time in the lead's timezone for the confirmation email.
  const tz = timezone || "Asia/Kolkata";
  const fmtDate = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch {
      return d.toISOString();
    }
  };

  const safeName = escHtml(name);
  const safeEmail = escHtml(email);
  const safeClub = escHtml(clubName);
  const safePhone = escHtml(phone);
  const safeInterest = escHtml(interest);
  const safeMessage = escHtml(message);
  const whenLead = escHtml(fmtDate(start));
  const whenIst = escHtml(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(start),
  );

  // ICS attachment so the lead can add it to their calendar.
  const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KHARAGOLF//Demo Booking//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${start.getTime()}-${email}@kharagolf.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:KHARAGOLF Platform Demo`,
    `DESCRIPTION:30-minute walkthrough of KHARAGOLF for ${name}${clubName ? ` (${clubName})` : ""}.`,
    `ORGANIZER;CN=KHARAGOLF:mailto:${GMAIL_USER || "demos@kharagolf.com"}`,
    `ATTENDEE;CN=${name};RSVP=TRUE:mailto:${email}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  // Lead confirmation
  const confirmBody = `
    <p style="font-size:14px;color:#374151;margin:0 0 16px;">Hi ${safeName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;">
      Your KHARAGOLF demonstration is confirmed. We've blocked 30 minutes for
      you — a calendar invite is attached.
    </p>
    <div style="margin:24px 0;padding:20px;background:#f3f4f6;border-left:4px solid #C9A84C;">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;">Your time</div>
      <div style="font-size:16px;font-weight:600;color:#0A1A0F;">${whenLead}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:10px;">KHARAGOLF time: ${whenIst}</div>
    </div>
    <p style="font-size:14px;color:#374151;line-height:1.6;">
      A member of our team will email you the meeting link 24 hours before the
      session. If you need to reschedule, just reply to this email.
    </p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin-top:24px;">
      In the meantime, you can preview the platform here:
      <a href="${escHtml(process.env.APP_BASE_URL ?? "https://kharagolf.com")}" style="color:#1e4d2b;font-weight:600;">kharagolf.com</a>
    </p>
  `;

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"KHARAGOLF" <${GMAIL_USER}>`,
        to: email,
        replyTo: GMAIL_USER,
        subject: "Your KHARAGOLF demo is confirmed",
        html: brandedHtml("Demo Confirmation", confirmBody),
        icalEvent: { method: "REQUEST", content: ics },
      });
    } catch (err) {
      logger.warn({ err }, "[DEMO-BOOKING] Lead email failed");
    }
  }

  // Sales alert
  const salesBody = `
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:140px;">Name</td><td style="padding:8px 0;font-weight:600;">${safeName}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:8px 0;">${safeEmail}</td></tr>
      ${clubName ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Club</td><td style="padding:8px 0;">${safeClub}</td></tr>` : ""}
      ${phone ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>` : ""}
      ${interest ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Interest</td><td style="padding:8px 0;">${safeInterest}</td></tr>` : ""}
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Lead time</td><td style="padding:8px 0;">${whenLead}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">IST</td><td style="padding:8px 0;font-weight:600;">${whenIst}</td></tr>
    </table>
    ${message ? `<div style="margin-top:20px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;"><p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${safeMessage}</p></div>` : ""}
  `;
  await sendMail({
    to: SALES_TO,
    replyTo: email,
    subject: `[Demo booked] ${name}${clubName ? ` — ${clubName}` : ""}`,
    html: brandedHtml("New Demo Booking", salesBody),
  });

  res.json({ ok: true, startUtc: start.toISOString(), endUtc: end.toISOString() });
});

// ─────────────────────────────────────────────────────────────────────
// FUNNEL ANALYTICS BEACON
// ─────────────────────────────────────────────────────────────────────

router.post("/funnel-event", (req: Request, res: Response) => {
  const { event, properties } = (req.body ?? {}) as { event?: string; properties?: Record<string, unknown> };
  if (!event || typeof event !== "string") {
    res.status(400).json({ error: "event required" });
    return;
  }
  logger.info(
    {
      event,
      properties: properties ?? {},
      ua: req.get("user-agent") ?? null,
      referer: req.get("referer") ?? null,
    },
    "[FUNNEL]",
  );
  res.json({ ok: true });
});

export default router;
