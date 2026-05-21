import { Router, type Request, type Response } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db } from "@workspace/db";
import { organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getEffectivePlanConfig } from "../lib/planConfigLoader";
import type { SubscriptionTier } from "../lib/subscriptionTiers";
import { TIER_DISPLAY } from "../lib/subscriptionTiers";
import type { AuthUser } from "@workspace/api-zod";

const router = Router();

// Task #362 — governing-body wording is selected per club. The R&A and USGA
// publish a unified set of Rules of Golf since 2019 but use slightly different
// administrative language and Model Local Rule numbering, so we steer the
// assistant accordingly. Local rules (if the club has documented any) are
// injected verbatim so answers respect them.
function buildRulesSystemPrompt(opts: {
  governingBody: "rna" | "usga";
  clubName: string | null;
  localRulesContent: string | null;
}): string {
  const bodyLabel = opts.governingBody === "usga" ? "USGA" : "R&A";
  const handicapSystem = opts.governingBody === "usga" ? "USGA / WHS" : "WHS (R&A)";
  const base = `You are an expert golf rules assistant. Apply the **${bodyLabel}** wording of the Rules of Golf (2023 edition, jointly written with ${opts.governingBody === "usga" ? "the R&A" : "the USGA"}) when answering. Use ${bodyLabel} phrasing, Model Local Rule references, and committee-procedure language.

You have comprehensive knowledge of:
- The Rules of Golf (${bodyLabel} 2023 edition)
- Local Rules and Model Local Rules
- Etiquette and recommendations
- Handicapping (${handicapSystem})
- Common tournament situations

Provide accurate, clear, and concise answers. When relevant:
- Reference the specific Rule number (e.g., Rule 14.3b)
- Distinguish between stroke play and match play differences
- Note when Local Rules may override
- Use practical examples to illustrate

If a situation is ambiguous, explain the most common interpretation and note any controversy.
Keep responses focused and player-friendly. Avoid legal jargon. Use short paragraphs.`;

  const trimmed = (opts.localRulesContent ?? "").trim();
  if (!trimmed) return base;
  const clubLabel = opts.clubName ? ` for ${opts.clubName}` : "";
  return `${base}

---
The following Local Rules${clubLabel} are in force at the player's club and OVERRIDE the corresponding default Rule when they apply. Always check whether a player's question is covered by these Local Rules before quoting the default Rule, and cite the Local Rule by name when it applies:

${trimmed}
---`;
}

// POST /api/rules/ask - SSE streaming AI Rules Assistant answer
//
// Security model:
//   - Requires authentication (401 for unauthenticated requests).
//   - Org identity resolved EXCLUSIVELY from the trusted session — body params
//     are never used for entitlement decisions (prevents spoofing).
//   - If the session user belongs to an org, the org's effective plan is checked (fail-closed).
//   - Users without an org affiliation (e.g. platform admins, individual users) are allowed.
router.post("/rules/ask", async (req: Request, res: Response) => {
  // Require authentication
  const sessionUser = req.user as AuthUser | undefined;
  if (!sessionUser) {
    res.status(401).json({
      error: "Authentication required. Please log in to use the AI Rules Assistant.",
    });
    return;
  }

  const { question, history } = req.body as {
    question: string;
    history?: { role: "user" | "assistant"; content: string }[];
  };

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "Question is required." });
    return;
  }

  // Resolve org from session ONLY (never from untrusted body input)
  const orgId: number | null = sessionUser.organizationId ?? null;

  // Task #362 — per-club governing-body wording + local rules. Defaults to
  // R&A wording with no local rules for users without an org affiliation.
  let orgRulesContext: {
    governingBody: "rna" | "usga";
    clubName: string | null;
    localRulesContent: string | null;
  } = { governingBody: "rna", clubName: null, localRulesContent: null };

  // Gate access when session user belongs to an org
  if (orgId !== null) {
    try {
      const [org] = await db
        .select({
          name: organizationsTable.name,
          subscriptionTier: organizationsTable.subscriptionTier,
          subscriptionStatus: organizationsTable.subscriptionStatus,
          rulesGoverningBody: organizationsTable.rulesGoverningBody,
          localRulesContent: organizationsTable.localRulesContent,
        })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, orgId));

      if (!org) {
        // Org referenced in session not found — deny (fail-closed)
        res.status(402).json({
          error: "Organisation not found. Cannot verify AI Rules Assistant entitlement.",
          featureGate: { type: "feature_gate", feature: "aiRulesAssistant" },
        });
        return;
      }

      orgRulesContext = {
        governingBody: (org.rulesGoverningBody ?? "rna") as "rna" | "usga",
        clubName: org.name ?? null,
        localRulesContent: org.localRulesContent ?? null,
      };

      const tier = org.subscriptionTier as SubscriptionTier;
      const lapsed = tier !== "free" && (org.subscriptionStatus === "past_due" || org.subscriptionStatus === "cancelled");
      const effectiveTier: SubscriptionTier = lapsed ? "free" : tier;
      const { config } = await getEffectivePlanConfig(effectiveTier, orgId);

      if (!config.aiRulesAssistant) {
        res.status(402).json({
          error: `AI Rules Assistant is not available on your ${TIER_DISPLAY[effectiveTier].label} plan.`,
          featureGate: {
            type: "feature_gate",
            feature: "aiRulesAssistant",
            currentTier: tier,
            requiredTier: "pro",
            message: `Upgrade to ${TIER_DISPLAY["pro"].label} to unlock the AI Rules Assistant.`,
          },
        });
        return;
      }
    } catch {
      // Entitlement lookup failed — deny fail-closed for org-affiliated users
      res.status(402).json({
        error: "Unable to verify AI Rules Assistant plan entitlement. Please try again later.",
        featureGate: { type: "feature_gate", feature: "aiRulesAssistant" },
      });
      return;
    }
  }
  // Authenticated users without org affiliation (platform admins etc.) are allowed through

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const systemPrompt = buildRulesSystemPrompt(orgRulesContext);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...(history ?? []).slice(-8),
      { role: "user", content: question.trim() },
    ];

    if (!openai) {
      throw new Error("OpenAI integrations are not initialized (AI_INTEGRATIONS_OPENAI_API_KEY/BASE_URL missing)");
    }
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      max_completion_tokens: 8192,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

export default router;
