/**
 * Consent gating for feature endpoints (Task #469).
 *
 * The portal exposes `memberHasConsent(memberId, consentType)` which reads the
 * latest decision from `member_consents`. Feature endpoints (GPS sharing,
 * photo/video uploads, AI caddie suggestions) must call this before processing
 * a request so that withdrawing consent in the privacy centre actually blocks
 * the activity on the backend.
 *
 * Defaults follow DPDP §6: when no decision has been recorded, optional
 * consents are treated as denied. However, if the authenticated user has no
 * club membership at all, no consent record applies — those users are not
 * gated by this module.
 */
import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, clubMembersTable, appUsersTable, memberConsentsTable } from "@workspace/db";

export type ConsentCategory = "gps" | "photo" | "video" | "ai" | "social" | "marketing" | "directory" | "third_party_share" | "scores" | "health_wellness";

const CONSENT_PROMPTS: Partial<Record<ConsentCategory, string>> = {
  gps: "Live location sharing is turned off in your privacy settings. Enable GPS consent to use this feature.",
  photo: "Photo uploads are turned off in your privacy settings. Enable photo consent to upload images.",
  video: "Video uploads are turned off in your privacy settings. Enable video consent to upload swing videos and clips.",
  ai: "AI caddie suggestions are turned off in your privacy settings. Enable AI consent to receive personalised recommendations.",
};

async function loadOwnMember(userId: number): Promise<{ id: number } | null> {
  const [user] = await db.select({ organizationId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
  const conditions = [eq(clubMembersTable.userId, userId)];
  if (user?.organizationId) conditions.push(eq(clubMembersTable.organizationId, user.organizationId));
  const [m] = await db.select({ id: clubMembersTable.id })
    .from(clubMembersTable).where(and(...conditions)).limit(1);
  return m ?? null;
}

/**
 * Returns true when the user is allowed to use a feature gated on `category`.
 * Allows the request when:
 *   - the user has no club membership (no consent record applies), OR
 *   - the latest decision for this category is `granted = true`.
 * Denies otherwise (including absence-of-decision for an existing member).
 */
export async function userHasConsent(userId: number, category: ConsentCategory): Promise<boolean> {
  const member = await loadOwnMember(userId);
  if (!member) return true;
  const [latest] = await db.select({ granted: memberConsentsTable.granted })
    .from(memberConsentsTable)
    .where(and(
      eq(memberConsentsTable.clubMemberId, member.id),
      eq(memberConsentsTable.consentType, category),
    ))
    .orderBy(desc(memberConsentsTable.grantedAt))
    .limit(1);
  return latest?.granted ?? false;
}

/**
 * Express helper: write a 403 with a structured `consentRequired` payload
 * when the user has withdrawn (or never granted) the requested consent.
 * Returns `true` when the request may proceed, `false` when the response has
 * already been sent.
 */
export async function requireConsent(
  req: Request,
  res: Response,
  category: ConsentCategory,
): Promise<boolean> {
  const userId = (req.user as { id?: number } | undefined)?.id;
  if (typeof userId !== "number") {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const ok = await userHasConsent(userId, category);
  if (ok) return true;
  res.status(403).json({
    error: CONSENT_PROMPTS[category] ?? `Consent required: ${category}`,
    code: "CONSENT_REQUIRED",
    consentRequired: { category, message: CONSENT_PROMPTS[category] ?? `Consent required: ${category}` },
  });
  return false;
}
