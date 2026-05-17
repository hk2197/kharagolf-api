/**
 * Marketing & Email Campaign Tools — Task #116
 * Routes:
 *   GET    /organizations/:orgId/marketing/campaigns
 *   POST   /organizations/:orgId/marketing/campaigns
 *   GET    /organizations/:orgId/marketing/campaigns/:id
 *   PUT    /organizations/:orgId/marketing/campaigns/:id
 *   DELETE /organizations/:orgId/marketing/campaigns/:id
 *   POST   /organizations/:orgId/marketing/campaigns/:id/send
 *   POST   /organizations/:orgId/marketing/campaigns/:id/schedule
 *   GET    /organizations/:orgId/marketing/campaigns/:id/stats
 *   GET    /organizations/:orgId/marketing/segments
 *   POST   /organizations/:orgId/marketing/segments
 *   PUT    /organizations/:orgId/marketing/segments/:id
 *   DELETE /organizations/:orgId/marketing/segments/:id
 *   POST   /organizations/:orgId/marketing/segments/:id/preview
 *   GET    /organizations/:orgId/marketing/drip-series
 *   POST   /organizations/:orgId/marketing/drip-series
 *   PUT    /organizations/:orgId/marketing/drip-series/:id
 *   DELETE /organizations/:orgId/marketing/drip-series/:id
 *   GET    /organizations/:orgId/marketing/suppressions
 *   POST   /organizations/:orgId/marketing/suppressions
 *   DELETE /organizations/:orgId/marketing/suppressions/:id
 *   GET    /organizations/:orgId/marketing/templates
 *   POST   /organizations/:orgId/marketing/templates
 *   PUT    /organizations/:orgId/marketing/templates/:id
 *   DELETE /organizations/:orgId/marketing/templates/:id
 *
 * Public (no auth):
 *   GET  /marketing/track/:token/open   — open pixel
 *   GET  /marketing/track/:token/click  — click redirect
 *   GET  /marketing/unsubscribe/:token  — one-click unsubscribe
 */

import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  marketingCampaignsTable,
  dripSeriesTable,
  memberSegmentsTable,
  campaignRecipientsTable,
  emailSuppressionsTable,
  emailTemplatesMarketingTable,
  appUsersTable,
  orgMembershipsTable,
  organizationsTable,
  clubMembersTable,
  memberAuditLogTable,
  memberMessagesTable,
} from "@workspace/db";
import {
  eq, and, desc, asc, inArray, sql, count as sqlCount, isNull, isNotNull, gte, lte, like, ne,
  type SQL,
} from "drizzle-orm";
import type { Request, Response } from "express";
import { sendBroadcastEmail, fetchPostmarkMessageDetails } from "../lib/mailer";
import { getCachedPostmarkMessageDetails } from "../lib/email/postmarkMessageCache";
import { sendTransactionalEmail } from "../lib/email/adapter";
import { sendPushToUsers, classifyPushDelivery } from "../lib/push";
import { recordMemberAudit } from "../lib/auditMember";
import { notifyMemberOfAdminEmailReplacement } from "../lib/adminEmailReplacementNotify";
import {
  verifyEmailChangeDisputeToken,
  type EmailChangeDisputeTokenError,
  type EmailChangeDisputeTokenPayload,
} from "../lib/email-change-dispute-token";
import { notificationAuditLogTable } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Task #1786 — Notification audit key for the marketing-campaign push
 * fan-out. Registered in `lib/notificationRegistry.ts` so per-recipient
 * push failures show up alongside every other audit-logged notify path
 * in the admin dashboard, and so admins can correlate a push outage
 * back to the specific campaign that lost members.
 */
const MARKETING_CAMPAIGN_PUSH_NOTIFICATION_KEY = "marketing.campaign.push";

/** Lightweight RFC-5322-ish email check — same shape used elsewhere in the
 * codebase. We deliberately keep it permissive (we are not the source of
 * truth for deliverability — the suppression list is). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = Router({ mergeParams: true });
const publicRouter = Router();

/* ─── Auth helpers ─────────────────────────────────────────────────── */
function getUser(req: Request) {
  return req.user as { id: number; username: string; organizationId?: number; role?: string } | undefined;
}

function requireAdmin(req: Request, res: Response): boolean {
  const u = getUser(req);
  if (!u) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  if (!adminRoles.includes(u.role ?? "")) { res.status(403).json({ error: "Forbidden" }); return false; }
  if (u.role !== "super_admin" && (req.params as Record<string, string>).orgId) {
    if (u.organizationId !== parseInt(String((req.params as Record<string, string>).orgId))) {
      res.status(403).json({ error: "Forbidden: org mismatch" });
      return false;
    }
  }
  return true;
}

/* ─── Segment engine ───────────────────────────────────────────────── */
type SegmentRule = { field: string; operator: string; value: string | string[] | number };

async function resolveSegment(orgId: number, rules: SegmentRule[]): Promise<Array<{ id: number; email: string | null; displayName: string | null }>> {
  let conditions: Parameters<typeof and>[0][] = [
    eq(appUsersTable.role, "player"),
    eq(orgMembershipsTable.organizationId, orgId),
  ];

  for (const rule of rules) {
    switch (rule.field) {
      case "membership_tier":
        if (rule.operator === "eq") conditions.push(sql`EXISTS (SELECT 1 FROM club_members cm WHERE cm.user_id = ${appUsersTable.id} AND cm.organization_id = ${orgId} AND cm.membership_tier_id = ${Number(rule.value)})`);
        break;
      case "role":
        if (rule.operator === "eq") conditions.push(eq(appUsersTable.role, String(rule.value) as "player"));
        break;
      default:
        break;
    }
  }

  const rows = await db
    .select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName })
    .from(appUsersTable)
    .innerJoin(orgMembershipsTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(...conditions));

  return rows.filter(r => !!r.email);
}

/* ─── Campaign sender ──────────────────────────────────────────────── */
async function dispatchCampaign(campaign: typeof marketingCampaignsTable.$inferSelect, org: { name: string; logoUrl: string | null; primaryColor: string | null }) {
  const orgId = campaign.organizationId;

  let recipients: Array<{ id: number; email: string | null; displayName: string | null }> = [];
  if (campaign.segmentId) {
    const seg = await db.query.memberSegmentsTable.findFirst({ where: eq(memberSegmentsTable.id, campaign.segmentId) });
    if (seg) recipients = await resolveSegment(orgId, seg.rules as SegmentRule[]);
  } else {
    recipients = await db
      .select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName })
      .from(appUsersTable)
      .innerJoin(orgMembershipsTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(appUsersTable.role, "player")));
  }

  const suppressedRows = await db.select({ email: emailSuppressionsTable.email }).from(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  const suppressedSet = new Set(suppressedRows.map(r => r.email.toLowerCase()));
  const eligible = recipients.filter(r => r.email && !suppressedSet.has(r.email.toLowerCase()));

  let sent = 0;
  // Task #1786 — per-campaign push delivery counters bumped by the
  // recipient loop below. Mirrors `classifyPushDelivery`'s sent /
  // failed / no_address rule (Task #1070): only canonical "sent" and
  // "failed" outcomes are counted; "no_address" (recipient has no
  // Expo token registered) is benign and would otherwise inflate the
  // failure rate on every campaign that targets non-app users.
  let pushSent = 0;
  let pushFailed = 0;
  const channels = campaign.channels ?? ["email"];
  const branding = { orgName: org.name, logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined };

  for (const r of eligible) {
    if (!r.email) continue;
    const token = crypto.randomBytes(20).toString("hex");
    const abVariant = campaign.subjectVariantB ? (Math.random() < 0.5 ? "a" : "b") : "a";
    const subject = (abVariant === "b" && campaign.subjectVariantB) ? campaign.subjectVariantB : (campaign.subject ?? `Message from ${org.name}`);

    await db.insert(campaignRecipientsTable).values({
      campaignId: campaign.id,
      userId: r.id,
      email: r.email,
      name: r.displayName,
      abVariant,
      sentAt: new Date(),
      trackingToken: token,
    }).onConflictDoNothing();

    if (channels.includes("email")) {
      try {
        const baseUrl = process.env.APP_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
        const unsubLink = `${baseUrl}/api/marketing/unsubscribe/${token}`;
        const bodyWithTracking = (campaign.bodyHtml || "") +
          `<p style="font-size:11px;color:#666;margin-top:32px;"><a href="${unsubLink}" style="color:#666;">Unsubscribe</a></p>` +
          `<img src="${baseUrl}/api/marketing/track/${token}/open" width="1" height="1" style="display:none;" />`;
        // Task #1310 — pass campaignId + flow="campaign" so the
        // Postmark bounce webhook can attribute any resulting
        // suppression back to *this* campaign and surface a clickable
        // link in the Suppressions tab.
        await sendBroadcastEmail(r.email, r.displayName ?? "Member", subject, bodyWithTracking, org.name, {
          ...branding,
          campaignId: campaign.id,
          // Task #1555 — when the campaign was built from a saved
          // template, forward its id so the Postmark bounce webhook
          // can attribute the resulting suppression back to the
          // template and admins can click straight through to the
          // editor. `null` (no source template) silently omits the
          // metadata field.
          ...(campaign.templateId !== null && campaign.templateId !== undefined
            ? { templateId: campaign.templateId }
            : {}),
          flow: "campaign",
        });
        sent++;
      } catch { /* log and continue */ }
    }

    if (channels.includes("push") && r.id) {
      // Task #1786 — classify the per-recipient push delivery result
      // through `classifyPushDelivery` (the canonical sent / failed /
      // no_address mapping shared with every other notify path) and
      // bump the campaign-scoped counters so a broken push pipeline
      // (Expo down, all tokens invalid, batch rejected) surfaces on
      // the campaign stats page instead of being silently swallowed
      // by the previous bare `try { ... } catch { /* ignore */ }`.
      // Failed deliveries also write a per-recipient row to
      // `notification_audit_log` so admins can pin down WHICH members
      // were missed (auditRequired registry entry — see
      // `notificationRegistry.ts → "marketing.campaign.push"`).
      const pushBody = campaign.bodyText ?? campaign.bodyHtml?.replace(/<[^>]+>/g, "").slice(0, 180) ?? "";
      try {
        const result = await sendPushToUsers(
          [r.id],
          subject,
          pushBody,
          { campaignId: String(campaign.id) },
        );
        const status = classifyPushDelivery(result);
        if (status === "sent") {
          pushSent++;
        } else if (status === "failed") {
          pushFailed++;
          try {
            await db.insert(notificationAuditLogTable).values({
              notificationKey: MARKETING_CAMPAIGN_PUSH_NOTIFICATION_KEY,
              userId: r.id,
              channel: "push",
              status: "failed",
              reason: "push_provider_failed",
              payload: {
                organizationId: orgId,
                campaignId: campaign.id,
                attempted: result.attempted,
                sent: result.sent,
                failed: result.failed,
                invalid: result.invalid,
              },
            });
          } catch (auditErr) {
            logger.warn({ err: auditErr, campaignId: campaign.id, userId: r.id }, "[marketing] campaign push audit insert failed");
          }
        }
        // status === "no_address" → benign, do not bump either counter.
      } catch (err) {
        // Even an exception thrown out of `sendPushToUsers` is a
        // delivery failure as far as the campaign stats are concerned;
        // record it the same way the classified branch does.
        pushFailed++;
        logger.warn({ err, campaignId: campaign.id, userId: r.id }, "[marketing] campaign push threw");
        try {
          await db.insert(notificationAuditLogTable).values({
            notificationKey: MARKETING_CAMPAIGN_PUSH_NOTIFICATION_KEY,
            userId: r.id,
            channel: "push",
            status: "failed",
            reason: "push_threw",
            payload: {
              organizationId: orgId,
              campaignId: campaign.id,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch (auditErr) {
          logger.warn({ err: auditErr, campaignId: campaign.id, userId: r.id }, "[marketing] campaign push audit insert failed");
        }
      }
    }
  }

  await db.update(marketingCampaignsTable).set({
    status: "sent",
    sentAt: new Date(),
    totalSent: sent,
    // Task #1786 — surface the per-campaign push delivery counters on
    // the persisted row so the stats endpoint can read them back in a
    // single SELECT (no recompute against `notification_audit_log`).
    totalPushSent: pushSent,
    totalPushFailed: pushFailed,
    updatedAt: new Date(),
  }).where(eq(marketingCampaignsTable.id, campaign.id));
}

/* ═══════════════════════════════════════════════════════════════
   CAMPAIGNS
   ═══════════════════════════════════════════════════════════════ */

router.get("/campaigns", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rows = await db.select().from(marketingCampaignsTable)
    .where(eq(marketingCampaignsTable.organizationId, orgId))
    .orderBy(desc(marketingCampaignsTable.createdAt));
  res.json(rows);
});

/**
 * Task #1555 — resolve and authorise a `templateId` field from the
 * campaign create/update payload. Returns:
 *   - undefined when the field was omitted (caller must NOT touch the
 *     existing column — used by PUT to honour partial updates).
 *   - null when the field was explicitly cleared (e.g. `null`, `""`).
 *   - a positive integer when the template exists and is either owned
 *     by `orgId` or is a global template (`is_global=true`).
 *   - an Error string when the field was provided but invalid (bad id,
 *     unknown template, owned by another org).
 *
 * We mirror the org-ownership check the Postmark webhook does on the
 * way back in (defence in depth) so a stale or forged templateId can't
 * smuggle a cross-org reference into `marketing_campaigns`.
 */
async function resolveCampaignTemplateId(
  orgId: number,
  raw: unknown,
): Promise<{ templateId: number | null } | { error: string }> {
  if (raw === undefined) return { templateId: null }; // unused by POST; PUT branches on undefined separately
  if (raw === null || raw === "") return { templateId: null };
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: "templateId must be a positive integer" };
  }
  const tpl = await db.query.emailTemplatesMarketingTable.findFirst({
    where: eq(emailTemplatesMarketingTable.id, n),
  });
  if (!tpl) return { error: "templateId not found" };
  if (!tpl.isGlobal && tpl.organizationId !== orgId) {
    return { error: "templateId is not visible to this organization" };
  }
  return { templateId: n };
}

router.post("/campaigns", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const u = getUser(req)!;
  const {
    name, subject, subjectVariantB, previewText, bodyHtml, bodyText,
    channels, status, type, scheduledAt, segmentId, dripSeriesId, dripDelayDays, dripOrder,
    templateId,
  } = req.body;

  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  // Task #1555 — validate + authorise the optional templateId before
  // we persist; reject forged cross-org references with a 400.
  const tplResult = await resolveCampaignTemplateId(orgId, templateId);
  if ("error" in tplResult) { res.status(400).json({ error: tplResult.error }); return; }

  const [row] = await db.insert(marketingCampaignsTable).values({
    organizationId: orgId,
    name,
    subject: subject ?? null,
    subjectVariantB: subjectVariantB ?? null,
    previewText: previewText ?? null,
    bodyHtml: bodyHtml ?? "",
    bodyText: bodyText ?? null,
    channels: channels ?? ["email"],
    status: status ?? "draft",
    type: type ?? "one_off",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    segmentId: segmentId ?? null,
    dripSeriesId: dripSeriesId ?? null,
    dripDelayDays: dripDelayDays ?? 0,
    dripOrder: dripOrder ?? 0,
    templateId: tplResult.templateId,
    createdByUserId: u.id,
  }).returning();
  res.status(201).json(row);
});

router.get("/campaigns/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const row = await db.query.marketingCampaignsTable.findFirst({
    where: and(eq(marketingCampaignsTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(marketingCampaignsTable.organizationId, orgId)),
  });
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.put("/campaigns/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const {
    name, subject, subjectVariantB, previewText, bodyHtml, bodyText,
    channels, status, type, scheduledAt, segmentId, dripSeriesId, dripDelayDays, dripOrder,
    templateId,
  } = req.body;

  // Task #1555 — only touch `template_id` when the field was actually
  // provided (partial-update semantics). When provided, validate and
  // authorise via `resolveCampaignTemplateId` so we reject forged
  // cross-org refs the same way POST does.
  let templateUpdate: { templateId: number | null } | null = null;
  if (templateId !== undefined) {
    const tplResult = await resolveCampaignTemplateId(orgId, templateId);
    if ("error" in tplResult) { res.status(400).json({ error: tplResult.error }); return; }
    templateUpdate = { templateId: tplResult.templateId };
  }

  const [updated] = await db.update(marketingCampaignsTable).set({
    ...(name !== undefined && { name }),
    ...(subject !== undefined && { subject }),
    ...(subjectVariantB !== undefined && { subjectVariantB }),
    ...(previewText !== undefined && { previewText }),
    ...(bodyHtml !== undefined && { bodyHtml }),
    ...(bodyText !== undefined && { bodyText }),
    ...(channels !== undefined && { channels }),
    ...(status !== undefined && { status }),
    ...(type !== undefined && { type }),
    ...(scheduledAt !== undefined && { scheduledAt: scheduledAt ? new Date(scheduledAt) : null }),
    ...(segmentId !== undefined && { segmentId }),
    ...(dripSeriesId !== undefined && { dripSeriesId }),
    ...(dripDelayDays !== undefined && { dripDelayDays }),
    ...(dripOrder !== undefined && { dripOrder }),
    ...(templateUpdate ?? {}),
    updatedAt: new Date(),
  }).where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.organizationId, orgId))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/campaigns/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(marketingCampaignsTable).where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.organizationId, orgId)));
  res.json({ ok: true });
});

router.post("/campaigns/:id/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const campaign = await db.query.marketingCampaignsTable.findFirst({
    where: and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.organizationId, orgId)),
  });
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  if (campaign.status === "sent") { res.status(400).json({ error: "Campaign already sent" }); return; }

  const org = await db.query.organizationsTable.findFirst({ where: eq(organizationsTable.id, orgId) });
  if (!org) { res.status(404).json({ error: "Org not found" }); return; }

  await db.update(marketingCampaignsTable).set({ status: "sending", updatedAt: new Date() }).where(eq(marketingCampaignsTable.id, id));

  dispatchCampaign(campaign, org).catch(console.error);
  res.json({ ok: true, message: "Campaign dispatch started" });
});

router.post("/campaigns/:id/schedule", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { scheduledAt } = req.body;
  if (!scheduledAt) { res.status(400).json({ error: "scheduledAt is required" }); return; }

  const [updated] = await db.update(marketingCampaignsTable).set({
    scheduledAt: new Date(scheduledAt),
    status: "scheduled",
    updatedAt: new Date(),
  }).where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.organizationId, orgId))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.get("/campaigns/:id/stats", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const campaign = await db.query.marketingCampaignsTable.findFirst({
    where: and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.organizationId, orgId)),
  });
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }

  const recipientsCount = await db.select({ c: sqlCount() }).from(campaignRecipientsTable).where(eq(campaignRecipientsTable.campaignId, id));
  const openedCount = await db.select({ c: sqlCount() }).from(campaignRecipientsTable).where(and(eq(campaignRecipientsTable.campaignId, id), isNotNull(campaignRecipientsTable.openedAt)));
  const clickedCount = await db.select({ c: sqlCount() }).from(campaignRecipientsTable).where(and(eq(campaignRecipientsTable.campaignId, id), isNotNull(campaignRecipientsTable.clickedAt)));
  const unsubCount = await db.select({ c: sqlCount() }).from(campaignRecipientsTable).where(and(eq(campaignRecipientsTable.campaignId, id), isNotNull(campaignRecipientsTable.unsubscribedAt)));

  const total = Number(recipientsCount[0]?.c ?? 0);
  const opened = Number(openedCount[0]?.c ?? 0);
  const clicked = Number(clickedCount[0]?.c ?? 0);
  const unsub = Number(unsubCount[0]?.c ?? 0);

  // Task #1786 — surface the per-campaign push delivery counters so
  // the campaign stats page can show a "Push delivered: X / Y · N
  // failed" line and admins can see at a glance when the push fan-out
  // dropped members. Read directly off the campaign row (the
  // dispatcher's `dispatchCampaign` writes them at the end of the
  // recipient loop) so the stats render is a single SELECT without
  // having to recompute from `notification_audit_log`.
  const pushSent = campaign.totalPushSent ?? 0;
  const pushFailed = campaign.totalPushFailed ?? 0;
  const pushAttempted = pushSent + pushFailed;

  res.json({
    campaign,
    stats: {
      totalSent: total,
      totalOpened: opened,
      totalClicked: clicked,
      totalUnsubscribed: unsub,
      openRate: total > 0 ? Math.round((opened / total) * 100) : 0,
      clickRate: total > 0 ? Math.round((clicked / total) * 100) : 0,
      unsubscribeRate: total > 0 ? Math.round((unsub / total) * 100) : 0,
      // Task #1786 — push delivery stats surfaced alongside email
      // stats. `pushAttempted` is sent + failed (i.e. recipients we
      // actually tried to deliver to AND classified — `no_address`
      // outcomes are intentionally excluded so the failure rate is not
      // diluted by recipients who simply have no app installed).
      totalPushSent: pushSent,
      totalPushFailed: pushFailed,
      totalPushAttempted: pushAttempted,
      pushFailureRate: pushAttempted > 0 ? Math.round((pushFailed / pushAttempted) * 100) : 0,
    },
  });
});

/* ═══════════════════════════════════════════════════════════════
   SEGMENTS
   ═══════════════════════════════════════════════════════════════ */

router.get("/segments", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rows = await db.select().from(memberSegmentsTable)
    .where(eq(memberSegmentsTable.organizationId, orgId))
    .orderBy(asc(memberSegmentsTable.name));
  res.json(rows);
});

router.post("/segments", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, description, rules } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  const recipients = await resolveSegment(orgId, rules ?? []);
  const [row] = await db.insert(memberSegmentsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    rules: rules ?? [],
    estimatedCount: recipients.length,
  }).returning();
  res.status(201).json(row);
});

router.put("/segments/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { name, description, rules } = req.body;

  const recipients = await resolveSegment(orgId, rules ?? []);
  const [updated] = await db.update(memberSegmentsTable).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(rules !== undefined && { rules }),
    estimatedCount: recipients.length,
    updatedAt: new Date(),
  }).where(and(eq(memberSegmentsTable.id, id), eq(memberSegmentsTable.organizationId, orgId))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/segments/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await db.delete(memberSegmentsTable).where(and(eq(memberSegmentsTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(memberSegmentsTable.organizationId, orgId)));
  res.json({ ok: true });
});

router.post("/segments/:id/preview", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seg = await db.query.memberSegmentsTable.findFirst({
    where: and(eq(memberSegmentsTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(memberSegmentsTable.organizationId, orgId)),
  });
  if (!seg) { res.status(404).json({ error: "Not found" }); return; }
  const recipients = await resolveSegment(orgId, seg.rules as SegmentRule[]);
  res.json({ count: recipients.length, sample: recipients.slice(0, 10).map(r => ({ email: r.email, name: r.displayName })) });
});

/* ═══════════════════════════════════════════════════════════════
   DRIP SERIES
   ═══════════════════════════════════════════════════════════════ */

router.get("/drip-series", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const series = await db.select().from(dripSeriesTable)
    .where(eq(dripSeriesTable.organizationId, orgId))
    .orderBy(asc(dripSeriesTable.name));

  const result = await Promise.all(series.map(async (s) => {
    const steps = await db.select().from(marketingCampaignsTable)
      .where(and(eq(marketingCampaignsTable.dripSeriesId, s.id), eq(marketingCampaignsTable.organizationId, orgId)))
      .orderBy(asc(marketingCampaignsTable.dripOrder));
    return { ...s, steps };
  }));
  res.json(result);
});

router.post("/drip-series", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, description, trigger, isActive } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const [row] = await db.insert(dripSeriesTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    trigger: trigger ?? "new_member",
    isActive: isActive ?? true,
  }).returning();
  res.status(201).json(row);
});

router.put("/drip-series/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, description, trigger, isActive } = req.body;
  const [updated] = await db.update(dripSeriesTable).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(trigger !== undefined && { trigger }),
    ...(isActive !== undefined && { isActive }),
    updatedAt: new Date(),
  }).where(and(eq(dripSeriesTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(dripSeriesTable.organizationId, orgId))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/drip-series/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await db.update(marketingCampaignsTable).set({ dripSeriesId: null }).where(eq(marketingCampaignsTable.dripSeriesId, parseInt(String((req.params as Record<string, string>).id))));
  await db.delete(dripSeriesTable).where(and(eq(dripSeriesTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(dripSeriesTable.organizationId, orgId)));
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════
   SUPPRESSION-SOURCE BREAKDOWN — Task #1557 / #1943
   ═══════════════════════════════════════════════════════════════ */

/**
 * GET /organizations/:orgId/marketing/bounce-sources
 *
 * Returns a per-source count of suppressions in the last `days` (default 30)
 * so the marketing dashboard can render a "Bounces by source" or "Spam
 * complaints by source" chart at a glance. Builds on the
 * `triggered_by_campaign_id` / `triggered_by_flow` columns persisted by
 * Task #1310 — without them every entry would collapse into a single bucket.
 *
 * Query params:
 *   days   — window in days (1..365), default 30
 *   reason — 'bounced' (default) | 'spam_complaint' (Task #1943). Unknown
 *            values fall back to 'bounced' so a typo can't silently widen
 *            the scope. Unsubscribes / manual entries aren't deliverability
 *            signal so they're intentionally not exposed here; admins who
 *            want them should use the Suppressions tab instead.
 *
 * Response shape:
 *   {
 *     windowDays: number,            // window actually applied (clamped 1..365)
 *     reason: 'bounced' | 'spam_complaint', // reason actually queried
 *     total: number,                 // total suppressions of `reason` in the window
 *     sources: Array<{
 *       key: string,                 // "campaign:<id>" | "flow:<name>" | "none"
 *       label: string,               // human-readable name (campaign name, flow label, etc.)
 *       campaignId: number | null,
 *       flow: string | null,
 *       count: number,
 *     }>,                            // sorted desc by count, top 5 + "none" bucket
 *     truncated: boolean,            // true if there were >5 named sources
 *   }
 */
router.get("/bounce-sources", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  // Parse + clamp window. Anything outside 1..365 falls back to 30 so a typo
  // can't accidentally request a multi-year scan against a hot table.
  const rawDays = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : NaN;
  const windowDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? rawDays : 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Task #1943 — accept `reason=spam_complaint` so the dashboard can render
  // a sibling "Spam complaints by source" chart with the same grouping +
  // attribution code. Anything outside the allowlist falls back to bounces
  // (the historical default) so existing callers keep working.
  const allowedReasons = new Set(["bounced", "spam_complaint"]);
  const reason: "bounced" | "spam_complaint" =
    typeof req.query.reason === "string" && allowedReasons.has(req.query.reason)
      ? (req.query.reason as "bounced" | "spam_complaint")
      : "bounced";

  // Group counts in a single round-trip. The COALESCE on flow keeps the
  // group key non-null so rows where both attributions are null collapse
  // into a single "no source recorded" bucket.
  const rows = await db
    .select({
      campaignId: emailSuppressionsTable.triggeredByCampaignId,
      flow: emailSuppressionsTable.triggeredByFlow,
      campaignName: marketingCampaignsTable.name,
      count: sqlCount(),
    })
    .from(emailSuppressionsTable)
    .leftJoin(marketingCampaignsTable, and(
      eq(marketingCampaignsTable.id, emailSuppressionsTable.triggeredByCampaignId),
      eq(marketingCampaignsTable.organizationId, orgId),
    ))
    .where(and(
      eq(emailSuppressionsTable.organizationId, orgId),
      eq(emailSuppressionsTable.reason, reason),
      gte(emailSuppressionsTable.createdAt, since),
    ))
    .groupBy(
      emailSuppressionsTable.triggeredByCampaignId,
      emailSuppressionsTable.triggeredByFlow,
      marketingCampaignsTable.name,
    );

  type Bucket = { key: string; label: string; campaignId: number | null; flow: string | null; count: number };
  const named: Bucket[] = [];
  let noneCount = 0;
  let total = 0;

  for (const r of rows) {
    const c = Number(r.count ?? 0);
    total += c;
    if (r.campaignId != null) {
      named.push({
        key: `campaign:${r.campaignId}`,
        label: r.campaignName ?? `Campaign #${r.campaignId}`,
        campaignId: r.campaignId,
        flow: null,
        count: c,
      });
    } else if (r.flow) {
      named.push({
        key: `flow:${r.flow}`,
        label: r.flow,
        campaignId: null,
        flow: r.flow,
        count: c,
      });
    } else {
      noneCount += c;
    }
  }

  named.sort((a, b) => b.count - a.count);
  const topNamed = named.slice(0, 5);
  const truncated = named.length > topNamed.length;

  const sources: Bucket[] = [...topNamed];
  if (noneCount > 0) {
    sources.push({
      key: "none",
      label: "No source recorded",
      campaignId: null,
      flow: null,
      count: noneCount,
    });
  }

  res.json({ windowDays, reason, total, sources, truncated });
});

/* ═══════════════════════════════════════════════════════════════
   SUPPRESSIONS (unsubscribe list)
   ═══════════════════════════════════════════════════════════════ */

router.get("/suppressions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  // Optional filter by reason category. Accepts the same vocabulary the
  // Postmark webhook writes: "bounced", "spam_complaint", "unsubscribed",
  // "manual". Unknown values fall through to no filter so the endpoint
  // stays forwards-compatible.
  const allowedReasons = new Set(["bounced", "spam_complaint", "unsubscribed", "manual"]);
  const reasonFilter = typeof req.query.reason === "string" && allowedReasons.has(req.query.reason)
    ? req.query.reason
    : null;

  // Task #1310 — optional source filter. Accepts:
  //   campaign:<id>  → suppressions whose triggered_by_campaign_id = id
  //   flow:<name>    → suppressions whose triggered_by_flow = name
  //   template:<id>  → (Task #1555) suppressions whose triggered_by_template_id = id
  //   none           → suppressions with no recorded source (legacy / manual)
  // Anything else (including absent) returns all rows.
  const sourceParam = typeof req.query.source === "string" ? req.query.source : "";
  const conditions: SQL[] = [eq(emailSuppressionsTable.organizationId, orgId)];
  if (reasonFilter) conditions.push(eq(emailSuppressionsTable.reason, reasonFilter));
  if (sourceParam.startsWith("campaign:")) {
    const id = parseInt(sourceParam.slice("campaign:".length), 10);
    if (Number.isFinite(id) && id > 0) {
      conditions.push(eq(emailSuppressionsTable.triggeredByCampaignId, id));
    }
  } else if (sourceParam.startsWith("flow:")) {
    const flow = sourceParam.slice("flow:".length).trim();
    if (flow) conditions.push(eq(emailSuppressionsTable.triggeredByFlow, flow));
  } else if (sourceParam.startsWith("template:")) {
    // Task #1555 — drill into "every bounce caused by this template"
    // (across every campaign that used it). Same shape as the campaign
    // filter so admins get a consistent UX.
    const id = parseInt(sourceParam.slice("template:".length), 10);
    if (Number.isFinite(id) && id > 0) {
      conditions.push(eq(emailSuppressionsTable.triggeredByTemplateId, id));
    }
  } else if (sourceParam === "none") {
    conditions.push(isNull(emailSuppressionsTable.triggeredByCampaignId));
    conditions.push(isNull(emailSuppressionsTable.triggeredByFlow));
    // Task #1555 — "no source recorded" must also exclude template-only
    // attributions (a transactional template send with no campaign).
    conditions.push(isNull(emailSuppressionsTable.triggeredByTemplateId));
  }

  // Left-join the originating campaign so the UI can render a friendly
  // name without a follow-up fetch. The join is org-scoped to avoid
  // accidentally surfacing another org's campaign name even if a stale
  // campaign id slipped through (defence in depth — the webhook already
  // refuses to write a cross-org FK).
  // Task #1555 — also left-join the originating template (when set).
  // Templates can be `is_global=true` (organization_id IS NULL) AND visible
  // to every org, so the join condition is "id matches AND (template
  // belongs to this org OR is global)" — same defence-in-depth rule the
  // webhook applies on the way in.
  const rows = await db
    .select({
      id: emailSuppressionsTable.id,
      organizationId: emailSuppressionsTable.organizationId,
      email: emailSuppressionsTable.email,
      reason: emailSuppressionsTable.reason,
      bounceType: emailSuppressionsTable.bounceType,
      messageId: emailSuppressionsTable.messageId,
      description: emailSuppressionsTable.description,
      triggeredByCampaignId: emailSuppressionsTable.triggeredByCampaignId,
      triggeredByFlow: emailSuppressionsTable.triggeredByFlow,
      triggeredByCampaignName: marketingCampaignsTable.name,
      triggeredByTemplateId: emailSuppressionsTable.triggeredByTemplateId,
      triggeredByTemplateName: emailTemplatesMarketingTable.name,
      createdAt: emailSuppressionsTable.createdAt,
    })
    .from(emailSuppressionsTable)
    .leftJoin(marketingCampaignsTable, and(
      eq(marketingCampaignsTable.id, emailSuppressionsTable.triggeredByCampaignId),
      eq(marketingCampaignsTable.organizationId, orgId),
    ))
    .leftJoin(emailTemplatesMarketingTable, and(
      eq(emailTemplatesMarketingTable.id, emailSuppressionsTable.triggeredByTemplateId),
      // Either the template belongs to this org or it is a global template.
      // We can't express OR(eq, eq, isNull) cleanly with `or()` here without
      // bringing it into the import surface; keep the predicate readable by
      // delegating to a small SQL fragment.
      sql`(${emailTemplatesMarketingTable.organizationId} = ${orgId} OR ${emailTemplatesMarketingTable.isGlobal} = true)`,
    ))
    .where(and(...conditions))
    .orderBy(desc(emailSuppressionsTable.createdAt));

  // Task #1548 — surface "Re-bounced after re-enable" signal. If a row was
  // deleted via the re-enable flow within the last 14 days but a new bounce
  // for the same address (or its replacement) has since arrived, the
  // suppression we're about to return represents a *failed* recovery
  // attempt. Tag those rows so the UI can warn admins their previous fix
  // didn't stick. We intentionally read all reenable audits in this window
  // (one cheap indexed scan by org+createdAt) and join in JS — both because
  // metadata is JSONB (no useful index) and because the result set is tiny
  // in practice (re-enables are rare admin actions).
  type ReenableSummary = {
    at: string;
    actorName: string | null;
    actorRole: string | null;
    actorUserId: number | null;
    action: string;
    replacementEmail: string | null;
  };
  const recentReenables = new Map<string, ReenableSummary>();
  if (rows.length > 0) {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const auditRows = await db
      .select({
        action: memberAuditLogTable.action,
        createdAt: memberAuditLogTable.createdAt,
        actorName: memberAuditLogTable.actorName,
        actorRole: memberAuditLogTable.actorRole,
        actorUserId: memberAuditLogTable.actorUserId,
        metadata: memberAuditLogTable.metadata,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "email_suppression"),
        inArray(memberAuditLogTable.action, ["reenable", "reenable_with_replacement"]),
        gte(memberAuditLogTable.createdAt, cutoff),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    // Build a lookup of suppressionEmail → suppression createdAt so we
    // only attribute audit rows that *predate* the new bounce. Otherwise
    // an admin re-enabling an address that hasn't bounced again would
    // still light up the badge (false positive).
    const suppressionCreatedAtByEmail = new Map<string, Date>();
    for (const r of rows) {
      const k = r.email.toLowerCase();
      const created = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
      // Keep the most recent createdAt if duplicates somehow appear (per-org
      // unique constraint should prevent this, but be defensive).
      const existing = suppressionCreatedAtByEmail.get(k);
      if (!existing || created.getTime() > existing.getTime()) {
        suppressionCreatedAtByEmail.set(k, created);
      }
    }
    for (const ar of auditRows) {
      const md = (ar.metadata ?? {}) as { oldEmail?: unknown; replacementEmail?: unknown };
      const candidates: string[] = [];
      if (typeof md.oldEmail === "string" && md.oldEmail) candidates.push(md.oldEmail.toLowerCase());
      if (typeof md.replacementEmail === "string" && md.replacementEmail) candidates.push(md.replacementEmail.toLowerCase());
      const auditAt = ar.createdAt instanceof Date ? ar.createdAt : new Date(ar.createdAt as unknown as string);
      for (const email of candidates) {
        const supCreated = suppressionCreatedAtByEmail.get(email);
        if (!supCreated) continue;
        // Audit must predate the suppression — otherwise the suppression
        // existed before the re-enable attempt (which would be the same
        // row being re-deleted, not a re-bounce).
        if (auditAt.getTime() > supCreated.getTime()) continue;
        // auditRows is desc; first match wins (most recent re-enable).
        if (recentReenables.has(email)) continue;
        recentReenables.set(email, {
          at: auditAt.toISOString(),
          actorName: ar.actorName ?? null,
          actorRole: ar.actorRole ?? null,
          actorUserId: ar.actorUserId ?? null,
          action: ar.action,
          replacementEmail: typeof md.replacementEmail === "string" && md.replacementEmail ? md.replacementEmail.toLowerCase() : null,
        });
      }
    }
  }

  const enriched = rows.map(r => ({
    ...r,
    recentReenable: recentReenables.get(r.email.toLowerCase()) ?? null,
  }));
  res.json(enriched);
});

router.post("/suppressions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { email, reason } = req.body;
  if (!email) { res.status(400).json({ error: "email is required" }); return; }
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    reason: reason ?? "manual",
  }).onConflictDoNothing().returning();
  res.status(201).json(row ?? { ok: true });
});

router.delete("/suppressions/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await db.delete(emailSuppressionsTable).where(and(eq(emailSuppressionsTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(emailSuppressionsTable.organizationId, orgId)));
  res.json({ ok: true });
});

/**
 * Task #1556 — fetch the rendered Postmark message (HTML + plain text +
 * headers) that produced this suppression so an admin can preview the
 * exact email that bounced without leaving the dashboard.
 *
 * Guards:
 *   - Admin role required (handled by `requireAdmin`).
 *   - Suppression must belong to this org and have a non-null `messageId`
 *     — we deliberately refuse to forward an arbitrary MessageID to
 *     Postmark, even from an admin, to avoid turning the endpoint into a
 *     general-purpose Postmark message browser scoped only by server token.
 *   - Postmark's outbound retention is ~45 days on most plans, so older
 *     bounces will surface a 404 with `error: "message_not_available"`
 *     and the UI will explain the retention window.
 */
router.get("/suppressions/:id/message", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const suppression = await db.query.emailSuppressionsTable.findFirst({
    where: and(
      eq(emailSuppressionsTable.id, id),
      eq(emailSuppressionsTable.organizationId, orgId),
    ),
  });
  if (!suppression) { res.status(404).json({ error: "Suppression not found" }); return; }
  if (!suppression.messageId) {
    res.status(404).json({
      error: "no_message_id",
      message: "This suppression has no Postmark MessageID recorded — it predates Task #1138 or was added manually.",
    }); return;
  }

  // Task #1937 — funnel through the in-memory cache so repeated opens of
  // the same suppression dialog don't keep hammering Postmark's outbound
  // messages API (rate limited, 500–1500ms per call) for an immutable
  // body. `?refresh=1` or `?refresh=true` forces a fresh fetch for
  // debugging / hand-fixing a stale cached entry; any other value (or no
  // value) goes through the cache.
  const refreshParam = (req.query as Record<string, string | undefined>).refresh;
  const refresh = refreshParam === "1" || refreshParam === "true";
  const result = await getCachedPostmarkMessageDetails(suppression.messageId, { refresh });
  // Always advertise cache status so admins (and the test suite) can tell a
  // hit from a miss. Failures are reported as MISS — they were never cached.
  res.setHeader("X-Cache", result.cacheStatus);
  if (!result.ok) {
    const code = result.status === 404 ? "message_not_available" : "postmark_lookup_failed";
    res.status(result.status).json({
      error: code,
      message: result.status === 404
        ? "Postmark no longer has this message body. Outbound bodies are retained for ~45 days on most plans."
        : result.error,
      messageId: suppression.messageId,
    }); return;
  }

  res.json({
    suppression: {
      id: suppression.id,
      email: suppression.email,
      reason: suppression.reason,
      bounceType: suppression.bounceType,
      messageId: suppression.messageId,
    },
    message: result.details,
  });
});

/**
 * Re-enable a previously suppressed address — Task #1311.
 *
 * Lets admins act on the bounce description surfaced by Task #1138 (e.g.
 * "BadMailbox") in a single click instead of "delete suppression then hope
 * the user re-subscribes". When a `replacementEmail` is supplied we also
 * patch the matching club_members / app_users rows so the corrected address
 * actually receives future mail.
 *
 * The frontend calls this twice: first without `confirmed` (preview) so we
 * report which member/user rows would be touched, then with `confirmed: true`
 * once the admin has reviewed the impact. When no replacement is supplied the
 * action is just a guarded version of DELETE /suppressions/:id and runs in a
 * single call.
 *
 * Body: { replacementEmail?: string | null, confirmed?: boolean }
 */
router.post("/suppressions/:id/reenable", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const suppression = await db.query.emailSuppressionsTable.findFirst({
    where: and(
      eq(emailSuppressionsTable.id, id),
      eq(emailSuppressionsTable.organizationId, orgId),
    ),
  });
  if (!suppression) { res.status(404).json({ error: "Suppression not found" }); return; }

  // Bounce-class only — the recovery flow only makes sense when the address
  // failed to deliver (BadMailbox, HardBounce, etc.). Spam complaints are an
  // explicit user signal we must not silently bypass; unsubscribes and manual
  // adds already have a "delete suppression" affordance. Mirrors the UI gate
  // (`s.reason === 'bounced'`) so admins can't accidentally reach this via a
  // direct API call either.
  if (suppression.reason !== "bounced") {
    res.status(409).json({
      error: "Only bounced suppressions can be re-enabled. Use DELETE /suppressions/:id for unsubscribes, spam complaints, or manual entries.",
      reason: suppression.reason,
    }); return;
  }

  const rawReplacement = typeof req.body?.replacementEmail === "string"
    ? req.body.replacementEmail.trim()
    : "";
  const replacementEmail = rawReplacement ? rawReplacement.toLowerCase() : null;
  const confirmed = req.body?.confirmed === true;
  const oldEmail = suppression.email.toLowerCase();

  if (replacementEmail) {
    if (!EMAIL_RE.test(replacementEmail)) {
      res.status(400).json({ error: "replacementEmail is not a valid email address" }); return;
    }
    if (replacementEmail === oldEmail) {
      res.status(400).json({ error: "replacementEmail is identical to the suppressed address" }); return;
    }
    // Don't silently re-enable into another already-suppressed address.
    const conflict = await db.query.emailSuppressionsTable.findFirst({
      where: and(
        eq(emailSuppressionsTable.organizationId, orgId),
        eq(emailSuppressionsTable.email, replacementEmail),
      ),
    });
    if (conflict && conflict.id !== id) {
      res.status(409).json({
        error: "replacementEmail is itself on the suppression list",
        conflictId: conflict.id,
      }); return;
    }
  }

  // Find the linked member(s) / user(s) by case-insensitive email match,
  // org-scoped for club_members and (for app_users) cross-org but limited to
  // accounts that have a membership in this org.
  const matchedMembers = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    userId: clubMembersTable.userId,
  })
    .from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, orgId),
      sql`lower(${clubMembersTable.email}) = ${oldEmail}`,
    ));

  const matchedUsers = await db.select({
    id: appUsersTable.id,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
  })
    .from(appUsersTable)
    .innerJoin(orgMembershipsTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      sql`lower(${appUsersTable.email}) = ${oldEmail}`,
    ));

  // Preview step — replacement supplied but caller hasn't confirmed yet.
  if (replacementEmail && !confirmed) {
    res.json({
      requiresConfirmation: true,
      suppression: { id: suppression.id, email: suppression.email, reason: suppression.reason, bounceType: suppression.bounceType },
      replacementEmail,
      matchedMembers: matchedMembers.map(m => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), email: m.email })),
      matchedUsers: matchedUsers.map(u => ({ id: u.id, displayName: u.displayName, email: u.email })),
    }); return;
  }

  // Apply the change atomically so we never end up with patched member emails
  // but a still-active suppression (or vice versa) if the DB hiccups halfway.
  let updatedMemberIds: number[] = [];
  let updatedUserIds: number[] = [];
  await db.transaction(async (tx) => {
    if (replacementEmail) {
      if (matchedMembers.length) {
        const ids = matchedMembers.map(m => m.id);
        await tx.update(clubMembersTable)
          .set({ email: replacementEmail, updatedAt: new Date() })
          .where(and(
            eq(clubMembersTable.organizationId, orgId),
            inArray(clubMembersTable.id, ids),
          ));
        updatedMemberIds = ids;
      }
      if (matchedUsers.length) {
        const ids = matchedUsers.map(u => u.id);
        await tx.update(appUsersTable)
          .set({ email: replacementEmail, updatedAt: new Date() })
          .where(inArray(appUsersTable.id, ids));
        updatedUserIds = ids;
      }
    }

    await tx.delete(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.id, id), eq(emailSuppressionsTable.organizationId, orgId)));
  });

  // Audit-log so we can trace who re-enabled which address. We write one
  // audit row per linked member when there is a replacement (so Member 360
  // shows the email change), plus one org-level row for the suppression
  // removal itself when nothing was linked.
  //
  // Task #1932 — capture each per-member audit row id so we can bake it
  // into the dispute deep link sent to the affected user. The map is
  // keyed by `app_users.id` because that's the dimension the notify
  // helper iterates over below; a member with no linked app user has
  // no inbox to notify and thus needs no token.
  const memberAuditIdByUserId = new Map<number, number>();
  try {
    if (replacementEmail && matchedMembers.length) {
      for (const m of matchedMembers) {
        const auditId = await recordMemberAudit({
          req,
          organizationId: orgId,
          clubMemberId: m.id,
          entity: "email_suppression",
          entityId: suppression.id,
          action: "reenable_with_replacement",
          changes: { email: { from: oldEmail, to: replacementEmail } },
          reason: `Re-enabled after ${suppression.reason}${suppression.bounceType ? ` (${suppression.bounceType})` : ""} — replaced suppressed address with corrected one`,
          metadata: {
            suppressionReason: suppression.reason,
            bounceType: suppression.bounceType,
            description: suppression.description,
            messageId: suppression.messageId,
            oldEmail,
            replacementEmail,
            updatedMemberIds,
            updatedUserIds,
          },
        });
        if (auditId != null && m.userId != null) {
          memberAuditIdByUserId.set(m.userId, auditId);
        }
      }
    } else {
      await recordMemberAudit({
        req,
        organizationId: orgId,
        clubMemberId: null,
        entity: "email_suppression",
        entityId: suppression.id,
        action: replacementEmail ? "reenable_with_replacement" : "reenable",
        changes: replacementEmail ? { email: { from: oldEmail, to: replacementEmail } } : undefined,
        reason: replacementEmail
          ? `Re-enabled ${oldEmail} with replacement ${replacementEmail} (no linked member found)`
          : `Re-enabled ${oldEmail} after ${suppression.reason}${suppression.bounceType ? ` (${suppression.bounceType})` : ""}`,
        metadata: {
          suppressionReason: suppression.reason,
          bounceType: suppression.bounceType,
          description: suppression.description,
          messageId: suppression.messageId,
          oldEmail,
          replacementEmail,
        },
      });
    }
  } catch (err) {
    // Audit failures must never block the primary operation.
    console.error("[marketing] suppression reenable audit failed", err);
  }

  // Task #1549 — notify the affected member(s) at the NEW address that
  // their contact email was overwritten by an admin. Best-effort: every
  // failure is logged inside the helper, never thrown, so a delivery
  // glitch can't roll back the already-committed suppression removal +
  // email rewrite. Self-actions short-circuit inside the helper.
  if (replacementEmail && updatedUserIds.length > 0) {
    const actor = req.user
      ? {
          id: req.user.id,
          displayName: req.user.displayName ?? null,
          email: req.user.email ?? null,
        }
      : null;
    if (actor) {
      await Promise.all(
        updatedUserIds.map((affectedUserId) =>
          notifyMemberOfAdminEmailReplacement({
            organizationId: orgId,
            affectedUserId,
            actor,
            previousEmail: oldEmail,
            newEmail: replacementEmail,
            // Task #1932 — bind the dispute deep link to the exact
            // per-member audit row so a successful "this wasn't me"
            // press can later be linked back to this re-enable in the
            // audit trail.
            originalAuditId: memberAuditIdByUserId.get(affectedUserId) ?? null,
          }).catch((err) => {
            console.error(
              "[marketing] suppression reenable notify failed",
              { affectedUserId, err },
            );
          }),
        ),
      );
    }
  }

  res.json({
    ok: true,
    removedSuppressionId: suppression.id,
    replacementEmail,
    updatedMemberIds,
    updatedUserIds,
  });
});

/**
 * Task #1936 — re-send the bounced message to a corrected address.
 *
 * Builds on Task #1556 (preview the bounced body) and Task #1311 (re-enable
 * a suppressed address). After the admin has either fixed the recipient
 * (replacement email) or re-enabled the suppression in the same dialog,
 * this endpoint pulls the original Postmark payload back down and re-sends
 * it through the existing transactional mailer so they don't have to copy
 * the body into a fresh send by hand.
 *
 * Body: { to: string }  — the corrected recipient address.
 *
 * Gating ("enabled only when the suppression has been re-enabled (or when
 * a replacement email was supplied)"):
 *   - When the suppression row still exists (not yet re-enabled), the
 *     destination MUST differ from the bounced recipient — otherwise we
 *     return 409 (`still_suppressed`) and instruct the admin to re-enable
 *     first.
 *   - When the suppression has already been re-enabled (and therefore
 *     deleted), we recover the original message id and recipient from the
 *     audit row written by /reenable so the admin can still resend in the
 *     same open dialog.
 *
 * Failure modes surfaced verbatim:
 *   - 404 `message_not_available` when Postmark has aged out the body
 *     (~45 days on most plans), mirroring GET /:id/message.
 *   - 409 `target_suppressed` when the destination is itself on the org's
 *     suppression list (must be re-enabled first).
 *   - 502 `send_failed` when the active provider rejects the resend, with
 *     the provider's raw error string for the toast.
 */
router.post("/suppressions/:id/message/resend", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const rawTo = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  if (!rawTo) {
    res.status(400).json({ error: "to is required" });
    return;
  }
  const toEmail = rawTo.toLowerCase();
  if (!EMAIL_RE.test(toEmail)) {
    res.status(400).json({ error: "to is not a valid email address" });
    return;
  }

  // Resolve the message id and original recipient. Prefer the live
  // suppression row; fall back to the most recent audit row written by
  // /reenable so a still-open preview dialog can resend after re-enable
  // has already deleted the suppression.
  let originalEmail: string | null = null;
  let messageId: string | null = null;
  let suppressionStillActive = false;

  const suppression = await db.query.emailSuppressionsTable.findFirst({
    where: and(
      eq(emailSuppressionsTable.id, id),
      eq(emailSuppressionsTable.organizationId, orgId),
    ),
  });

  if (suppression) {
    if (suppression.reason !== "bounced") {
      res.status(409).json({
        error: "Only bounced suppressions support resend. Use the normal send flow for unsubscribes, spam complaints or manual entries.",
        reason: suppression.reason,
      });
      return;
    }
    if (!suppression.messageId) {
      res.status(409).json({
        error: "no_message_id",
        message: "This suppression has no Postmark MessageID recorded — there is no original payload to resend.",
      });
      return;
    }
    suppressionStillActive = true;
    originalEmail = suppression.email.toLowerCase();
    messageId = suppression.messageId;
  } else {
    // Suppression deleted (likely re-enabled). Recover from the audit
    // trail — recordMemberAudit stores `messageId` + `oldEmail` in metadata
    // for both the `reenable` and `reenable_with_replacement` actions.
    const [recentAudit] = await db.select({
      metadata: memberAuditLogTable.metadata,
      action: memberAuditLogTable.action,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, id),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt))
      .limit(1);

    if (!recentAudit) {
      res.status(404).json({ error: "Suppression not found" });
      return;
    }
    const md = recentAudit.metadata as Record<string, unknown> | null;
    const auditMessageId = typeof md?.messageId === "string" ? md.messageId : null;
    const auditOldEmail = typeof md?.oldEmail === "string" ? md.oldEmail : null;
    if (!auditMessageId) {
      res.status(409).json({
        error: "no_message_id",
        message: "Original Postmark MessageID was not recorded for this re-enabled suppression — there is no payload to resend.",
      });
      return;
    }
    messageId = auditMessageId;
    originalEmail = auditOldEmail;
  }

  // Gate: when the suppression is still active, the destination must be
  // different from the bounced address. Otherwise the send would be
  // suppressed by `findSuppressionReason()` inside the adapter and the
  // admin would see a confusing "ok" with nothing actually delivered.
  if (suppressionStillActive && toEmail === originalEmail) {
    res.status(409).json({
      error: "still_suppressed",
      message: "Re-enable the address (or supply a different replacement) before resending — the original recipient is still on the suppression list.",
    });
    return;
  }

  // Refuse to resend into another already-suppressed address. The adapter
  // would short-circuit anyway, but admins deserve a loud, actionable
  // error instead of a silent "delivered" toast.
  const targetSuppression = await db.query.emailSuppressionsTable.findFirst({
    where: and(
      eq(emailSuppressionsTable.organizationId, orgId),
      sql`lower(${emailSuppressionsTable.email}) = ${toEmail}`,
    ),
  });
  if (targetSuppression && targetSuppression.id !== id) {
    res.status(409).json({
      error: "target_suppressed",
      message: "The destination address is itself on the suppression list — re-enable it first.",
      conflictId: targetSuppression.id,
    });
    return;
  }

  const lookup = await fetchPostmarkMessageDetails(messageId);
  if (!lookup.ok) {
    const code = lookup.status === 404 ? "message_not_available" : "postmark_lookup_failed";
    res.status(lookup.status).json({
      error: code,
      message: lookup.status === 404
        ? "Postmark no longer has the original message body. Outbound bodies are retained for ~45 days on most plans."
        : lookup.error,
      messageId,
    });
    return;
  }
  const details = lookup.details;

  // Build the resend metadata: stamp it as an admin resend (so the bounce
  // webhook can attribute any *new* bounce back to this action) and carry
  // through the original campaign/template/flow tags so the suppression
  // chain stays intact in the dashboard.
  const actor = req.user as { id?: number; email?: string; displayName?: string } | undefined;
  const resendMetadata: Record<string, string> = {
    flow: "admin_message_resend",
    orgId: String(orgId),
    resentFromMessageId: details.messageId,
  };
  if (actor?.id !== undefined) resendMetadata.resendActorUserId = String(actor.id);
  if (originalEmail) resendMetadata.originalRecipient = originalEmail;
  if (details.metadata) {
    for (const [k, v] of Object.entries(details.metadata)) {
      // Reserved keys above (flow / orgId / resentFromMessageId / etc.) win
      // so attribution to *this* resend isn't clobbered by stale metadata.
      if (!(k in resendMetadata)) resendMetadata[k] = String(v);
    }
  }

  const result = await sendTransactionalEmail({
    to: toEmail,
    from: details.from || undefined,
    subject: details.subject || "(no subject)",
    html: details.htmlBody ?? "",
    text: details.textBody ?? undefined,
    organizationId: orgId,
    metadata: resendMetadata,
    tags: details.tag ? [details.tag] : undefined,
  });

  if (!result.ok) {
    res.status(502).json({
      error: "send_failed",
      message: result.error ?? "The email provider rejected the resend.",
      provider: result.provider,
    });
    return;
  }
  if (result.suppressed) {
    // Defensive — the explicit gates above should have caught this. Surface
    // it loudly rather than returning a deceptive 200.
    res.status(409).json({
      error: "target_suppressed",
      message: "The destination address became suppressed between the gate check and the send — re-enable it and try again.",
    });
    return;
  }

  // Tag the audit row to the linked member (when there is one) so the
  // resend shows on Member 360, mirroring how /reenable threads through.
  let auditMemberId: number | null = null;
  if (originalEmail) {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        sql`lower(${clubMembersTable.email}) = ${originalEmail}`,
      ))
      .limit(1);
    auditMemberId = member?.id ?? null;
  }
  if (auditMemberId === null && toEmail !== originalEmail) {
    const [memberByNew] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        sql`lower(${clubMembersTable.email}) = ${toEmail}`,
      ))
      .limit(1);
    auditMemberId = memberByNew?.id ?? null;
  }

  try {
    await recordMemberAudit({
      req,
      organizationId: orgId,
      clubMemberId: auditMemberId,
      entity: "email_suppression",
      entityId: id,
      action: "resend_bounced_message",
      reason: originalEmail && originalEmail !== toEmail
        ? `Re-sent the bounced message originally addressed to ${originalEmail} to ${toEmail}`
        : `Re-sent the bounced message to ${toEmail}`,
      metadata: {
        messageId: details.messageId,
        originalRecipient: originalEmail,
        resentTo: toEmail,
        subject: details.subject,
        provider: result.provider,
        providerMessageId: result.messageId ?? null,
        suppressionWasActive: suppressionStillActive,
      },
    });
  } catch (err) {
    // Audit failures must never block the primary operation.
    console.error("[marketing] suppression message resend audit failed", err);
  }

  res.json({
    ok: true,
    resentTo: toEmail,
    provider: result.provider,
    messageId: result.messageId ?? null,
    originalMessageId: details.messageId,
  });
});

/* ═══════════════════════════════════════════════════════════════
   EMAIL TEMPLATES
   ═══════════════════════════════════════════════════════════════ */

router.get("/templates", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rows = await db.select().from(emailTemplatesMarketingTable)
    .where(sql`${emailTemplatesMarketingTable.organizationId} = ${orgId} OR ${emailTemplatesMarketingTable.isGlobal} = true`)
    .orderBy(asc(emailTemplatesMarketingTable.name));
  res.json(rows);
});

router.post("/templates", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, category, bodyHtml, bodyText } = req.body;
  if (!name || !bodyHtml) { res.status(400).json({ error: "name and bodyHtml are required" }); return; }
  const [row] = await db.insert(emailTemplatesMarketingTable).values({
    organizationId: orgId,
    name,
    category: category ?? "general",
    bodyHtml,
    bodyText: bodyText ?? null,
    isGlobal: false,
  }).returning();
  res.status(201).json(row);
});

router.put("/templates/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, category, bodyHtml, bodyText } = req.body;
  const [updated] = await db.update(emailTemplatesMarketingTable).set({
    ...(name !== undefined && { name }),
    ...(category !== undefined && { category }),
    ...(bodyHtml !== undefined && { bodyHtml }),
    ...(bodyText !== undefined && { bodyText }),
    updatedAt: new Date(),
  }).where(and(eq(emailTemplatesMarketingTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(emailTemplatesMarketingTable.organizationId, orgId))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/templates/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await db.delete(emailTemplatesMarketingTable).where(and(eq(emailTemplatesMarketingTable.id, parseInt(String((req.params as Record<string, string>).id))), eq(emailTemplatesMarketingTable.organizationId, orgId)));
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════
   PUBLIC TRACKING ENDPOINTS (no auth)
   ═══════════════════════════════════════════════════════════════ */

publicRouter.get("/track/:token/open", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  await db.update(campaignRecipientsTable)
    .set({ openedAt: new Date() })
    .where(and(eq(campaignRecipientsTable.trackingToken, token), isNull(campaignRecipientsTable.openedAt)));

  const row = await db.query.campaignRecipientsTable.findFirst({ where: eq(campaignRecipientsTable.trackingToken, token) });
  if (row) {
    await db.update(marketingCampaignsTable).set({ totalOpened: sql`${marketingCampaignsTable.totalOpened} + 1` }).where(eq(marketingCampaignsTable.id, row.campaignId));
  }

  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set("Content-Type", "image/gif").set("Cache-Control", "no-store").send(pixel);
});

publicRouter.get("/track/:token/click", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  const url = req.query.url as string;
  await db.update(campaignRecipientsTable)
    .set({ clickedAt: new Date() })
    .where(and(eq(campaignRecipientsTable.trackingToken, token), isNull(campaignRecipientsTable.clickedAt)));

  const row = await db.query.campaignRecipientsTable.findFirst({ where: eq(campaignRecipientsTable.trackingToken, token) });
  if (row) {
    await db.update(marketingCampaignsTable).set({ totalClicked: sql`${marketingCampaignsTable.totalClicked} + 1` }).where(eq(marketingCampaignsTable.id, row.campaignId));
  }

  res.redirect(url && /^https?:\/\//.test(url) ? url : "/");
});

publicRouter.get("/unsubscribe/:token", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  const row = await db.query.campaignRecipientsTable.findFirst({ where: eq(campaignRecipientsTable.trackingToken, token) });
  if (!row || !row.email) {
    res.status(404).send("<h2>Invalid unsubscribe link</h2>");
    return;
  }

  const campaign = await db.query.marketingCampaignsTable.findFirst({ where: eq(marketingCampaignsTable.id, row.campaignId) });
  if (!campaign) { { res.status(404).send("<h2>Campaign not found</h2>"); return; } }

  await db.update(campaignRecipientsTable).set({ unsubscribedAt: new Date() }).where(eq(campaignRecipientsTable.trackingToken, token));
  await db.insert(emailSuppressionsTable).values({
    organizationId: campaign.organizationId,
    email: row.email.toLowerCase(),
    reason: "unsubscribed",
  }).onConflictDoNothing();
  await db.update(marketingCampaignsTable).set({ totalUnsubscribed: sql`${marketingCampaignsTable.totalUnsubscribed} + 1` }).where(eq(marketingCampaignsTable.id, campaign.id));

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Unsubscribed</title><style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a0a;color:#fff;margin:0;}
      .box{text-align:center;padding:40px;max-width:480px;}
      h1{font-size:24px;margin-bottom:12px;}
      p{color:#9ca3af;line-height:1.6;}
    </style></head>
    <body><div class="box">
      <h1>You have been unsubscribed</h1>
      <p>You will no longer receive marketing emails from this club. If this was a mistake, please contact the club directly.</p>
    </div></body>
    </html>
  `);
});

/* ═══════════════════════════════════════════════════════════════
   TASK #1932 — SELF-SERVICE EMAIL-CHANGE DISPUTE / REVERT
   (public, token-only — no session required)
   ═══════════════════════════════════════════════════════════════
   When `POST /suppressions/:id/reenable` overwrites a member's contact
   email, `notifyMemberOfAdminEmailReplacement` sends them an in-app
   inbox row (and an email) containing a single-use deep link to
   `/portal/email-change-dispute/<token>` on the web app. The web page
   calls these three endpoints to (1) describe the change, (2) record a
   dispute (admin-mediated revert), or (3) trigger a safe automatic
   revert when nothing has changed since.

   The token itself proves the caller is the affected member (it was
   delivered to a mailbox only they can receive at). All three handlers
   re-validate the token, refuse if the change has already been
   actioned, and write audit rows whose metadata links back to the
   original `email_suppression` `reenable_with_replacement` audit row
   so a reviewer can follow the timeline as a single linked story. */

interface DisputeContext {
  payload: EmailChangeDisputeTokenPayload;
  originalAudit: typeof memberAuditLogTable.$inferSelect;
  affectedUser: {
    id: number;
    email: string | null;
    displayName: string | null;
    username: string | null;
  };
  org: { id: number; name: string };
}

type DisputeBlocker =
  | { ok: false; status: number; code: string; message: string }
  | { ok: true; ctx: DisputeContext };

async function loadDisputeContext(rawToken: string): Promise<DisputeBlocker> {
  const verified = verifyEmailChangeDisputeToken(rawToken);
  if (!verified.ok) {
    const codeMap: Record<EmailChangeDisputeTokenError, { status: number; message: string }> = {
      malformed: { status: 400, message: "Dispute link is malformed." },
      bad_signature: { status: 400, message: "Dispute link signature is invalid." },
      expired: { status: 410, message: "This dispute link has expired (links are valid for 30 days)." },
      unsupported_version: { status: 400, message: "This dispute link is no longer supported." },
    };
    const m = codeMap[verified.error];
    return { ok: false, status: m.status, code: verified.error, message: m.message };
  }
  const { payload } = verified;

  const [originalAudit] = await db.select().from(memberAuditLogTable)
    .where(eq(memberAuditLogTable.id, payload.a)).limit(1);
  if (
    !originalAudit ||
    originalAudit.organizationId !== payload.o ||
    originalAudit.entity !== "email_suppression" ||
    originalAudit.action !== "reenable_with_replacement"
  ) {
    return { ok: false, status: 404, code: "audit_not_found", message: "The original change referenced by this link no longer exists." };
  }

  const [affectedUser] = await db.select({
    id: appUsersTable.id,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
  }).from(appUsersTable).where(eq(appUsersTable.id, payload.u)).limit(1);
  if (!affectedUser) {
    return { ok: false, status: 404, code: "user_not_found", message: "The account referenced by this link no longer exists." };
  }

  const [org] = await db.select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, payload.o)).limit(1);
  if (!org) {
    return { ok: false, status: 404, code: "org_not_found", message: "The organization referenced by this link no longer exists." };
  }

  return { ok: true, ctx: { payload, originalAudit, affectedUser, org } };
}

/** Has the member already disputed or reverted this exact change? */
async function findPriorMemberAction(
  organizationId: number,
  originalAuditId: number,
): Promise<typeof memberAuditLogTable.$inferSelect | null> {
  // We can't index into jsonb cheaply with drizzle's typed query; filter
  // in JS over the (small) per-suppression result set instead. There is
  // at most a handful of audit rows per email_suppression entityId.
  const candidates = await db.select().from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, organizationId),
      eq(memberAuditLogTable.entity, "email_suppression"),
      inArray(memberAuditLogTable.action, [
        "email_change_disputed",
        "email_change_reverted_by_member",
      ]),
    ));
  for (const row of candidates) {
    const md = row.metadata as Record<string, unknown> | null;
    if (md && md.originalAuditId === originalAuditId) return row;
  }
  return null;
}

/**
 * Compute the current dispute status for a context.
 *
 * - `pending`: nothing acted on, member can still dispute or revert
 * - `already_actioned`: the member has already pressed dispute or revert
 * - `no_longer_applicable`: someone (admin, member, integration) changed
 *    the user's email again after the original change, so reverting to
 *    the previous address would clobber a newer setting we know nothing
 *    about. We refuse to act and tell the member to reach an admin.
 */
function computeStatus(
  ctx: DisputeContext,
  prior: typeof memberAuditLogTable.$inferSelect | null,
): { status: "pending" | "already_actioned" | "no_longer_applicable"; canRevert: boolean; reason?: string } {
  if (prior) {
    return {
      status: "already_actioned",
      canRevert: false,
      reason: prior.action === "email_change_reverted_by_member"
        ? "This change has already been reverted using this link."
        : "This change has already been disputed using this link — an admin has been notified.",
    };
  }
  const currentEmail = (ctx.affectedUser.email ?? "").trim().toLowerCase();
  const expectedNew = ctx.payload.n.trim().toLowerCase();
  if (currentEmail !== expectedNew) {
    return {
      status: "no_longer_applicable",
      canRevert: false,
      reason: "The contact email on this account has changed again since this notice was sent. Please contact your club admin to sort it out.",
    };
  }
  return { status: "pending", canRevert: true };
}

async function fetchActorContact(actorUserId: number | null): Promise<{ name: string | null; email: string | null }> {
  if (actorUserId == null) return { name: null, email: null };
  const [u] = await db.select({
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
    email: appUsersTable.email,
  }).from(appUsersTable).where(eq(appUsersTable.id, actorUserId)).limit(1);
  if (!u) return { name: null, email: null };
  return { name: u.displayName ?? u.username ?? null, email: u.email ?? null };
}

async function notifyAdminsOfDispute(opts: {
  organizationId: number;
  originalAuditId: number;
  affectedUser: { id: number; displayName: string | null; username: string | null };
  previousEmail: string;
  newEmail: string;
  action: "disputed" | "reverted";
}): Promise<void> {
  // Fan out an in-app inbox row to every member who has a club_members
  // anchor in this org AND has an org_memberships role that grants
  // admin-style access to email suppressions. Mirrors the role list
  // used by `coachPayoutNotify.ts` so we reach the same set of humans
  // who would see other operational alerts.
  try {
    const adminRows = await db
      .select({
        userId: orgMembershipsTable.userId,
        clubMemberId: clubMembersTable.id,
      })
      .from(orgMembershipsTable)
      .innerJoin(clubMembersTable, and(
        eq(clubMembersTable.organizationId, orgMembershipsTable.organizationId),
        eq(clubMembersTable.userId, orgMembershipsTable.userId),
      ))
      .where(and(
        eq(orgMembershipsTable.organizationId, opts.organizationId),
        inArray(orgMembershipsTable.role, [
          "org_admin",
          "treasurer",
          "membership_secretary",
          "committee_member",
          "competition_secretary",
        ]),
      ));
    if (adminRows.length === 0) return;
    const memberLabel = (opts.affectedUser.displayName ?? opts.affectedUser.username ?? `user #${opts.affectedUser.id}`).toString().trim();
    const subject = opts.action === "reverted"
      ? `${memberLabel} reverted an admin-driven contact-email change`
      : `${memberLabel} disputed an admin-driven contact-email change`;
    const body = [
      opts.action === "reverted"
        ? `${memberLabel} used the self-service link in their notice to revert the contact email back to ${opts.previousEmail}.`
        : `${memberLabel} marked the contact-email change to ${opts.newEmail} as unexpected via the self-service link in their notice.`,
      `Previous: ${opts.previousEmail}`,
      `New: ${opts.newEmail}`,
      `Original re-enable audit row: #${opts.originalAuditId}.`,
      "Open Member 360 → Audit trail to review the linked entries and follow up.",
    ].join("\n\n");
    const seen = new Set<number>();
    for (const row of adminRows) {
      if (row.clubMemberId == null) continue;
      if (seen.has(row.clubMemberId)) continue;
      seen.add(row.clubMemberId);
      await db.insert(memberMessagesTable).values({
        organizationId: opts.organizationId,
        clubMemberId: row.clubMemberId,
        senderUserId: null,
        channel: "in_app",
        subject,
        body,
        status: "sent",
        relatedEntity: opts.action === "reverted"
          ? "email_change_reverted_by_member"
          : "email_change_disputed",
        relatedEntityId: opts.originalAuditId,
      });
    }
  } catch (err) {
    // Notification failures must never block the primary action.
    logger.warn(
      { err, organizationId: opts.organizationId, originalAuditId: opts.originalAuditId },
      "[marketing] dispute admin notify failed",
    );
  }
}

publicRouter.get("/email-change-dispute/:token", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  const ctxResult = await loadDisputeContext(token);
  if (!ctxResult.ok) {
    res.status(ctxResult.status).json({ ok: false, code: ctxResult.code, message: ctxResult.message });
    return;
  }
  const { ctx } = ctxResult;
  const prior = await findPriorMemberAction(ctx.payload.o, ctx.payload.a);
  const status = computeStatus(ctx, prior);
  const actor = await fetchActorContact(ctx.originalAudit.actorUserId);
  res.json({
    ok: true,
    status: status.status,
    canRevert: status.canRevert,
    reason: status.reason ?? null,
    info: {
      orgName: ctx.org.name,
      adminName: ctx.originalAudit.actorName ?? actor.name ?? "An administrator",
      adminEmail: actor.email,
      previousEmail: ctx.payload.p,
      newEmail: ctx.payload.n,
      changedAt: ctx.originalAudit.createdAt,
    },
  });
});

publicRouter.post("/email-change-dispute/:token/dispute", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  const ctxResult = await loadDisputeContext(token);
  if (!ctxResult.ok) {
    res.status(ctxResult.status).json({ ok: false, code: ctxResult.code, message: ctxResult.message });
    return;
  }
  const { ctx } = ctxResult;
  const prior = await findPriorMemberAction(ctx.payload.o, ctx.payload.a);
  if (prior) {
    res.status(409).json({
      ok: false,
      code: "already_actioned",
      message: "This change has already been disputed or reverted.",
      priorAction: prior.action,
    });
    return;
  }

  // Anchor the new audit row to the affected member's club_members row
  // so it shows up in the Member 360 timeline next to the original
  // re-enable. Falling back to a clubMember-less row when no membership
  // exists is acceptable — Member 360 just won't render it, but the
  // org-level audit still has the linkage.
  const [member] = await db.select({ id: clubMembersTable.id })
    .from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, ctx.payload.o),
      eq(clubMembersTable.userId, ctx.payload.u),
    ))
    .limit(1);
  const auditId = await recordMemberAudit({
    req,
    organizationId: ctx.payload.o,
    clubMemberId: member?.id ?? null,
    entity: "email_suppression",
    entityId: ctx.originalAudit.entityId ?? null,
    action: "email_change_disputed",
    reason: "Member followed the self-service dispute link from the admin email-replacement notice",
    metadata: {
      originalAuditId: ctx.payload.a,
      previousEmail: ctx.payload.p,
      newEmail: ctx.payload.n,
      affectedUserId: ctx.payload.u,
      source: "self_service_dispute_link",
    },
  });

  await notifyAdminsOfDispute({
    organizationId: ctx.payload.o,
    originalAuditId: ctx.payload.a,
    affectedUser: ctx.affectedUser,
    previousEmail: ctx.payload.p,
    newEmail: ctx.payload.n,
    action: "disputed",
  });

  res.json({ ok: true, action: "dispute_recorded", auditId, originalAuditId: ctx.payload.a });
});

publicRouter.post("/email-change-dispute/:token/revert", async (req, res) => {
  const token = (req.params as Record<string, string>).token;
  const ctxResult = await loadDisputeContext(token);
  if (!ctxResult.ok) {
    res.status(ctxResult.status).json({ ok: false, code: ctxResult.code, message: ctxResult.message });
    return;
  }
  const { ctx } = ctxResult;
  const prior = await findPriorMemberAction(ctx.payload.o, ctx.payload.a);
  if (prior) {
    res.status(409).json({
      ok: false,
      code: "already_actioned",
      message: "This change has already been disputed or reverted.",
      priorAction: prior.action,
    });
    return;
  }

  const status = computeStatus(ctx, null);
  if (!status.canRevert) {
    res.status(409).json({
      ok: false,
      code: status.status,
      message: status.reason ?? "This change can no longer be reverted from this link.",
    });
    return;
  }

  // Refuse to clobber: if the previous address now belongs to a
  // different active app_user we'd violate the implicit uniqueness of
  // contact emails per org. Bounce to admin instead.
  const previousEmail = ctx.payload.p.toLowerCase();
  const conflict = await db.select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(and(
      sql`lower(${appUsersTable.email}) = ${previousEmail}`,
      ne(appUsersTable.id, ctx.payload.u),
    ))
    .limit(1);
  if (conflict.length > 0) {
    res.status(409).json({
      ok: false,
      code: "previous_email_taken",
      message: "The previous email address now belongs to another account on this club. Please contact your admin.",
    });
    return;
  }

  // Apply the revert atomically. The `app_users` update is gated on the
  // current email still matching the token's `n` value so a concurrent
  // legitimate email change between the pre-check (`computeStatus`) and
  // here cannot be clobbered — a TOCTOU window exists otherwise. If the
  // gated update returns zero rows we abort and tell the member to
  // reach an admin (same `no_longer_applicable` shape the GET endpoint
  // returns).
  const newEmailLower = ctx.payload.n.toLowerCase();
  let revertedUserRows = 0;
  try {
    await db.transaction(async (tx) => {
      const updated = await tx.update(appUsersTable)
        .set({ email: ctx.payload.p, updatedAt: new Date() })
        .where(and(
          eq(appUsersTable.id, ctx.payload.u),
          sql`lower(${appUsersTable.email}) = ${newEmailLower}`,
        ))
        .returning({ id: appUsersTable.id });
      revertedUserRows = updated.length;
      if (revertedUserRows === 0) {
        // Roll the transaction back so the club_members write below
        // never happens against a user row we no longer own.
        throw new Error("__revert_aborted_email_changed__");
      }
      await tx.update(clubMembersTable)
        .set({ email: ctx.payload.p, updatedAt: new Date() })
        .where(and(
          eq(clubMembersTable.organizationId, ctx.payload.o),
          eq(clubMembersTable.userId, ctx.payload.u),
          sql`lower(${clubMembersTable.email}) = ${newEmailLower}`,
        ));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__revert_aborted_email_changed__") {
      res.status(409).json({
        ok: false,
        code: "no_longer_applicable",
        message: "The contact email on this account has changed again since this notice was sent. Please contact your club admin to sort it out.",
      });
      return;
    }
    throw err;
  }

  const [member] = await db.select({ id: clubMembersTable.id })
    .from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, ctx.payload.o),
      eq(clubMembersTable.userId, ctx.payload.u),
    ))
    .limit(1);
  const auditId = await recordMemberAudit({
    req,
    organizationId: ctx.payload.o,
    clubMemberId: member?.id ?? null,
    entity: "email_suppression",
    entityId: ctx.originalAudit.entityId ?? null,
    action: "email_change_reverted_by_member",
    changes: { email: { from: ctx.payload.n, to: ctx.payload.p } },
    reason: "Member used the self-service link to revert an admin-driven contact-email change",
    metadata: {
      originalAuditId: ctx.payload.a,
      previousEmail: ctx.payload.p,
      newEmail: ctx.payload.n,
      affectedUserId: ctx.payload.u,
      source: "self_service_dispute_link",
    },
  });

  await notifyAdminsOfDispute({
    organizationId: ctx.payload.o,
    originalAuditId: ctx.payload.a,
    affectedUser: ctx.affectedUser,
    previousEmail: ctx.payload.p,
    newEmail: ctx.payload.n,
    action: "reverted",
  });

  res.json({
    ok: true,
    action: "reverted",
    restoredEmail: ctx.payload.p,
    auditId,
    originalAuditId: ctx.payload.a,
  });
});

export default router;
export { publicRouter as marketingPublicRouter };
