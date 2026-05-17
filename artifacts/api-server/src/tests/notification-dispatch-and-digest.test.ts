/**
 * Task #1005 — Central notification dispatch helper, digest mode, and
 * admin template preview.
 *
 * Verifies that:
 *   - dispatchNotification asserts the registry, sends a push, and
 *     calls the email callback for users who have not opted into digest
 *     mode.
 *   - When a user has digestMode = true and the spec is digestable, no
 *     push/email fires; instead a row is enqueued in
 *     notification_digest_queue.
 *   - runNotificationDigest drains the queue, sends one summary email
 *     per user, and marks the rows delivered.
 *   - previewNotificationTemplate renders the canned template for a
 *     registered key and returns null for unknown keys.
 *   - Audit-required keys write rows to notification_audit_log.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  userNotificationPrefsTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
  notificationTypeRegistryTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import {
  dispatchNotification,
  previewNotificationTemplate,
  _clearSpecCacheForTests,
} from "../lib/notifyDispatch.js";
import { runNotificationDigest } from "../lib/notificationDigest.js";
import {
  CTA_EXPECTATIONS,
  EXPECTED_BRANDED_KEYS,
  type BrandedNotificationKey,
} from "./_fixtures/notificationEmailExpectations.js";

const pushMock = vi.mocked(sendPushToUsers);

let orgId: number;
let userImmediateId: number;
let userDigestId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1005-${ts}`, slug: `t1005-${ts}`, contactEmail: `t1005-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1005_a_${ts}`,
    username: `t1005_a_${ts}`,
    email: `t1005a_${ts}@example.test`,
    displayName: "Immediate User",
    role: "player",
    organizationId: orgId,
  }).returning();
  userImmediateId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1005_b_${ts}`,
    username: `t1005_b_${ts}`,
    email: `t1005b_${ts}@example.test`,
    displayName: "Digest User",
    role: "player",
    organizationId: orgId,
  }).returning();
  userDigestId = u2.id;

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  await db.delete(notificationDigestQueueTable).where(inArray(notificationDigestQueueTable.userId, [userImmediateId, userDigestId]));
  await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, [userImmediateId, userDigestId]));
  await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, [userImmediateId, userDigestId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userImmediateId, userDigestId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  pushMock.mockClear();
  await db.delete(notificationDigestQueueTable).where(inArray(notificationDigestQueueTable.userId, [userImmediateId, userDigestId]));
  await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, [userImmediateId, userDigestId]));
  await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, [userImmediateId, userDigestId]));
  _clearSpecCacheForTests();
});

describe("Task #1005 — notification dispatch + digest + preview", () => {
  it("dispatches push and email immediately for users without digest mode", async () => {
    const emailCalls: Array<{ uid: number; subject: string }> = [];
    const result = await dispatchNotification(
      "highlight.ready",
      [userImmediateId],
      {
        title: "Reel ready",
        body: "Your highlight reel is ready to share.",
        emailHtml: "<p>Reel ready</p>",
      },
      {
        sendEmail: async (uid, subject) => {
          emailCalls.push({ uid, subject });
          return true;
        },
      },
    );

    expect(result.recipients).toHaveLength(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]?.[0]).toEqual([userImmediateId]);
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].uid).toBe(userImmediateId);

    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userImmediateId));
    expect(queued).toHaveLength(0);
  });

  // Task #1621 — guard rail for the deep-link CTA contract: when a
  // dispatch site supplies the renderer's preferred URL alias in
  // `payload.data` (and does NOT override `emailHtml`), the branded
  // template must surface that URL as the CTA href in the rendered
  // email — both the HTML the dispatcher hands to the mailer callback
  // AND the plain-text fallback for non-HTML clients.
  //
  // Per-template alias logic is exhaustively covered in
  // `notification-email-templates.test.ts`. This block instead
  // exercises the *propagation path* through the dispatcher for a
  // representative sample of alias names, derived from the canonical
  // shared `CTA_EXPECTATIONS` map so a CTA-alias rename in the renderer
  // is picked up here automatically.
  type PropagationCase = {
    key: BrandedNotificationKey;
    urlField: string;
    url: string;
    ctaLabel: string;
    extraData?: Record<string, unknown>;
  };
  const URL_PROPAGATION_CASES: ReadonlyArray<PropagationCase> = (
    [
      ["booking.confirmed", "https://app.example.com/portal/bookings/8421", { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40" }],
      ["booking.waitlist.promoted", "https://app.example.com/portal/bookings/9001", { courseName: "Ocean Course", teeTime: "08:40" }],
      ["course.correction.resolved", "https://app.example.com/portal/course-corrections/12", { decision: "accepted", fieldName: "Hole 3 yardage", holeNumber: 3 }],
      ["tournament.cut.applied", "https://app.example.com/portal/tournaments/55/grouping", { tournamentName: "Spring Open", throughRound: 2, madeCut: true, leaderboardUrl: "https://app.example.com/leaderboard/55" }],
      ["post.event.survey", "https://app.example.com/portal/surveys/123", { tournamentName: "Spring Open" }],
    ] as const
  ).map(([key, url, extraData]) => {
    const expectation = CTA_EXPECTATIONS[key as BrandedNotificationKey];
    return {
      key: key as BrandedNotificationKey,
      urlField: expectation.urlField,
      url,
      ctaLabel: expectation.label,
      extraData,
    };
  });

  it.each(URL_PROPAGATION_CASES)(
    "propagates $urlField from data through to the rendered email for $key",
    async ({ key, urlField, url, ctaLabel, extraData }) => {
      const captured: Array<{ uid: number; subject: string; html: string; text?: string }> = [];
      const data: Record<string, unknown> = { ...(extraData ?? {}), [urlField]: url };
      await dispatchNotification(
        key,
        [userImmediateId],
        {
          title: "Test dispatch",
          body: "Test body for URL propagation.",
          // No `emailHtml` override — force the dispatcher to use the
          // branded renderer so the URL propagation contract runs.
          data,
        },
        {
          sendEmail: async (uid, subject, html, text) => {
            captured.push({ uid, subject, html, text });
            return true;
          },
        },
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].uid).toBe(userImmediateId);
      // CTA button is rendered with the supplied URL as its href, and
      // the renderer's canonical CTA label appears alongside it.
      expect(captured[0].html).toContain(`href="${url}"`);
      expect(captured[0].html).toContain(ctaLabel);
      // Plain-text branch carries the same link so non-HTML clients
      // still get a click target.
      expect(captured[0].text).toBeDefined();
      expect(captured[0].text!).toContain(url);
    },
  );

  // Task #1621 — companion guard rail covering the codebase side of the
  // contract: every actual `dispatchNotification(...)` call site that
  // dispatches one of the 29 branded keys must populate the renderer's
  // preferred URL alias in `payload.data`. Failing this assertion means
  // a new dispatch site shipped without a CTA URL and the resulting
  // emails will silently fall back to the no-CTA layout in production.
  //
  // Source-of-truth wiring:
  //   - The set of branded keys + their aliases comes from the shared
  //     `CTA_EXPECTATIONS` / `EXPECTED_BRANDED_KEYS` fixture (one update
  //     site for both this test and the templates test).
  //   - The set of files to scan is discovered dynamically by walking
  //     `artifacts/api-server/src/{lib,routes}/**/*.ts`, so a new
  //     dispatch site in any future file is included automatically.
  //   - Tests, fixtures, and the dispatcher / renderer / coverage-doc
  //     modules are excluded because their `dispatchNotification(`
  //     mentions are definitions or examples, not real call sites.
  it("every branded-key dispatch site in the codebase passes its URL alias", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const srcRoot = path.resolve(__dirname, "..");

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push(...(await walk(abs)));
        } else if (e.isFile() && abs.endsWith(".ts")) {
          out.push(abs);
        }
      }
      return out;
    }

    const candidateDirs = ["lib", "routes"].map(d => path.join(srcRoot, d));
    const allFiles = (await Promise.all(candidateDirs.map(walk))).flat();
    // Files where `dispatchNotification(` appears as a definition or
    // documentation rather than a real call site.
    const SKIP_RE =
      /(?:notifyDispatch|notificationDispatchCoverage|notificationEmailTemplates|notificationRegistry|mailer)\.ts$/;
    const callSiteFiles = allFiles.filter(f => !SKIP_RE.test(f));

    // Match `dispatchNotification("key", …` (allow optional whitespace
    // / `await` prefix). The key is captured for branded-vs-non-branded
    // routing.
    const callRe = /dispatchNotification\(\s*["']([a-z0-9_.]+)["']/g;

    let inspectedBrandedSites = 0;
    const dispatchedBrandedKeys = new Set<string>();
    const findings: string[] = [];

    for (const abs of callSiteFiles) {
      const rel = path.relative(srcRoot, abs);
      const src = await fs.readFile(abs, "utf8");
      let m: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((m = callRe.exec(src)) !== null) {
        const key = m[1];
        // Non-branded keys (digest-failure fallbacks etc.) deliberately
        // use the no-CTA layout — no URL alias required.
        if (!(key in CTA_EXPECTATIONS)) continue;
        const expectation = CTA_EXPECTATIONS[key as BrandedNotificationKey];
        const aliases = [expectation.urlField, ...(expectation.altUrlFields ?? [])];
        dispatchedBrandedKeys.add(key);
        inspectedBrandedSites++;

        // Find the payload object literal: scan from the matched key
        // forward, skip past the opening `(`, then track top-level
        // commas to locate the 3rd argument (`payload`).
        let i = m.index;
        while (i < src.length && src[i] !== "(") i++;
        if (src[i] !== "(") continue;
        i++; // step past `(`
        let depth = 1;
        let commaCount = 0;
        let payloadBody: string | null = null;
        while (i < src.length && depth > 0 && payloadBody === null) {
          const ch = src[i];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          else if (ch === "," && depth === 1) commaCount++;
          else if (ch === "{" && depth === 1 && commaCount === 2) {
            // Scan forward for the matching `}`.
            let bd = 1;
            let j = i + 1;
            while (j < src.length && bd > 0) {
              const c = src[j];
              if (c === "{") bd++;
              else if (c === "}") bd--;
              j++;
            }
            payloadBody = src.slice(i, j);
            break;
          }
          i++;
        }
        if (payloadBody === null) {
          findings.push(`${rel}: could not parse payload for dispatchNotification("${key}")`);
          continue;
        }
        const hasAnyAlias = aliases.some(a =>
          new RegExp(`(^|[\\s,{])${a}\\s*[:,}]`).test(payloadBody!),
        );
        if (!hasAnyAlias) {
          findings.push(
            `${rel}: dispatchNotification("${key}") must populate one of [${aliases.join(", ")}] in its payload so the branded email renders its CTA button.`,
          );
        }
      }
    }

    expect(findings, findings.join("\n")).toEqual([]);
    // Sanity-check: we actually scanned something (catches a future
    // accidental over-broad SKIP_RE that hides every dispatch site).
    expect(inspectedBrandedSites).toBeGreaterThan(0);
    // Every branded key found in the codebase must be in the canonical
    // expected-keys list — protects against scope drift where someone
    // dispatches a key that isn't actually registered in the renderer.
    for (const k of dispatchedBrandedKeys) {
      expect(EXPECTED_BRANDED_KEYS).toContain(k);
    }
  });

  it("queues into the digest table for users with digestMode=true on a digestable key", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userDigestId, digestMode: true,
    });

    const sendEmail = vi.fn(async () => true);
    const result = await dispatchNotification(
      "highlight.ready",
      [userDigestId],
      { title: "Reel ready", body: "Your reel is ready.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(result.digestable).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();

    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userDigestId));
    expect(queued).toHaveLength(1);
    expect(queued[0].notificationKey).toBe("highlight.ready");
  });

  it("sends immediately even with digestMode=true when the spec is non-digestable", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userDigestId, digestMode: true,
    });

    const sendEmail = vi.fn(async () => true);
    await dispatchNotification(
      "booking.confirmed", // non-digestable
      [userDigestId],
      { title: "Booked", body: "Confirmed.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userDigestId));
    expect(queued).toHaveLength(0);
  });

  it("audits dispatch when the registry spec marks the key as auditRequired", async () => {
    // marshal.pace.alert is auditRequired in SEED_TYPES.
    await dispatchNotification(
      "marshal.pace.alert",
      [userImmediateId],
      { title: "Pace alert", body: "Group is behind pace.", emailHtml: "<p>x</p>" },
      { sendEmail: async () => true },
    );
    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, userImmediateId));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every(a => a.notificationKey === "marshal.pace.alert")).toBe(true);
  });

  it("runNotificationDigest drains the queue and marks rows delivered", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userDigestId, digestMode: true,
    });
    await dispatchNotification(
      "highlight.ready",
      [userDigestId],
      { title: "Reel one", body: "First reel.", emailHtml: "<p>x</p>" },
      { sendEmail: async () => true },
    );
    await dispatchNotification(
      "social.follow.new",
      [userDigestId],
      { title: "New follower", body: "Someone followed you.", emailHtml: "<p>x</p>" },
      { sendEmail: async () => true },
    );

    // Pre-condition: 2 queued rows, undelivered.
    const before = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userDigestId));
    expect(before).toHaveLength(2);
    expect(before.every(r => r.deliveredAt == null)).toBe(true);

    // Stub out the actual mailer to avoid calling SMTP in tests.
    const mailerMod = await import("../lib/mailer.js");
    const sendSpy = vi.spyOn(mailerMod, "sendDigestSummaryEmail").mockResolvedValue(undefined);

    const result = await runNotificationDigest();
    expect(result.usersProcessed).toBeGreaterThanOrEqual(1);
    expect(sendSpy).toHaveBeenCalled();
    expect(result.rowsDelivered).toBeGreaterThanOrEqual(2);

    const after = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userDigestId));
    expect(after.every(r => r.deliveredAt != null)).toBe(true);

    sendSpy.mockRestore();
  });

  it("runNotificationDigest skips users who already received a digest in the last ~20h", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userDigestId, digestMode: true,
    });

    // Pre-existing delivered row, stamped recently — should suppress
    // any new digest send to this user.
    await db.insert(notificationDigestQueueTable).values({
      userId: userDigestId,
      notificationKey: "highlight.ready",
      title: "Already-sent reel",
      body: "From an earlier run.",
      data: {},
      deliveredAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
    });

    // New undelivered row arrives after that.
    await dispatchNotification(
      "highlight.ready",
      [userDigestId],
      { title: "New reel", body: "Body.", emailHtml: "<p>x</p>" },
      { sendEmail: async () => true },
    );

    const mailerMod = await import("../lib/mailer.js");
    const sendSpy = vi.spyOn(mailerMod, "sendDigestSummaryEmail").mockResolvedValue(undefined);

    const result = await runNotificationDigest();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(result.rowsSkipped).toBeGreaterThanOrEqual(1);

    // The new row remains undelivered for the next eligible run.
    const stillQueued = await db.select().from(notificationDigestQueueTable)
      .where(and(eq(notificationDigestQueueTable.userId, userDigestId), isNull(notificationDigestQueueTable.deliveredAt)));
    expect(stillQueued.length).toBeGreaterThanOrEqual(1);

    sendSpy.mockRestore();
  });

  it("previewNotificationTemplate renders a branded sample for a registered key", async () => {
    // Task #1648 — branded keys go through the i18n renderer, so the
    // sample subject comes from the per-key bundle (in English by
    // default) and the HTML carries the branded "Notification: <key>"
    // footer instead of the old generic <h2> wrapper.
    // Task #2024 — the sample's `data` payload (in
    // `notificationSamples.ts`) supplies the placeholders the renderer
    // reads (`decision`, `fieldName`, `holeNumber`, …) so the preview
    // matches the real wording the dispatcher emits, not a generic
    // `[Sample] {description}` body.
    const preview = await previewNotificationTemplate("course.correction.resolved");
    expect(preview).not.toBeNull();
    expect(preview!.key).toBe("course.correction.resolved");
    expect(preview!.branded).toBe(true);
    expect(preview!.lang).toBe("en");
    expect(preview!.availableLanguages).toContain("en");
    expect(preview!.availableLanguages).toContain("es");
    expect(preview!.availableLanguages.length).toBe(21);
    expect(preview!.sample.title).toBe("Your course correction was accepted");
    expect(preview!.sample.html).toContain("course.correction.resolved");
    // The realistic sample payload surfaces the actual hole / field
    // values from `notificationSamples.ts` rather than a generic
    // `[Sample]` placeholder body.
    expect(preview!.sample.html).toContain("Hole 7 yardage marker");
    expect(preview!.sample.body).not.toContain("[Sample]");
    // Task #2051 — English IS the canonical source, so the preview
    // is "native" (not a fallback) by definition.
    expect(preview!.translationStatus).toBe("native");
  });

  it("previewNotificationTemplate re-renders branded templates in the requested language", async () => {
    // Task #1648 — passing `lang` swaps the per-key bundle so admins can
    // sanity-check translations before they reach players.
    // Task #2024 — `decision: "accepted"` in the sample payload routes
    // to each language's `extras.accepted` verb, so the rendered subject
    // changes per locale (e.g. "aceptada" / "acceptée").
    const es = await previewNotificationTemplate("course.correction.resolved", "es");
    expect(es).not.toBeNull();
    expect(es!.branded).toBe(true);
    expect(es!.lang).toBe("es");
    expect(es!.sample.title).toBe("Tu corrección del campo fue aceptada");
    expect(es!.sample.html).toContain("Hola");

    const fr = await previewNotificationTemplate("course.correction.resolved", "fr");
    expect(fr!.lang).toBe("fr");
    expect(fr!.sample.title).toBe("Votre correction de parcours a été acceptée");

    // Task #2051 — both Spanish and French ship a real translation
    // pack for this key, so the preview is "native" (not the silent
    // English fallback the warning banner is meant to flag).
    expect(es!.translationStatus).toBe("native");
    expect(fr!.translationStatus).toBe("native");
  });

  it("previewNotificationTemplate falls back to English for unsupported languages", async () => {
    // Mirrors `resolveNotificationEmailLang`'s contract — junk values
    // collapse to "en" rather than 500ing.
    const preview = await previewNotificationTemplate("course.correction.resolved", "xx-not-real");
    expect(preview).not.toBeNull();
    expect(preview!.lang).toBe("en");
    expect(preview!.sample.title).toBe("Your course correction was accepted");
  });

  it("previewNotificationTemplate uses the generic English wrapper for keys without a branded renderer", async () => {
    // Task #1648 — non-branded keys keep the simple wrapper (with
    // <h2>), report `branded: false`, and still include the supported
    // language list so the client can decide whether to render a picker.
    // `payment.received` is registered in the dispatcher but has no
    // entry in `NOTIFICATION_EMAIL_TEMPLATES`.
    // Task #2024 — non-branded keys still pull a realistic title /
    // body from `notificationSamples.ts` instead of the old
    // `[Sample] {description}` placeholder, so the wrapper renders a
    // copy that matches the real wording the dispatcher emits.
    const preview = await previewNotificationTemplate("payment.received");
    expect(preview).not.toBeNull();
    expect(preview!.branded).toBe(false);
    expect(preview!.sample.html).toContain("<h2");
    expect(preview!.availableLanguages.length).toBe(21);
    expect(preview!.sample.title).toBe("Payment received: ₹4,500");
    expect(preview!.sample.body).not.toContain("[Sample]");
    expect(preview!.sample.body).toContain("Spring Open entry fee");
    expect(preview!.sample.html).toContain("Spring Open entry fee");
  });

  it("previewNotificationTemplate returns null for unknown keys", async () => {
    const preview = await previewNotificationTemplate("does.not.exist");
    expect(preview).toBeNull();
  });

  // Task #2024 — every registered notification key must ship a sample
  // in `notificationSamples.ts` so the admin "Preview template" dialog
  // shows realistic copy. The registry's static cross-check throws at
  // module load if a SEED_TYPES key is missing, but that only catches
  // in-tree misses — this assertion broadens the contract to every key
  // hydrated from the DB (including any future feature module that
  // calls `register()` in its startup hook).
  it("every registered notification key has a sample payload", async () => {
    const { listRegistered } = await import("../lib/notificationRegistry.js");
    const { getNotificationSample } = await import("../lib/notificationSamples.js");
    const missing = listRegistered().filter(k => !getNotificationSample(k));
    expect(
      missing,
      `Notification keys missing samples in notificationSamples.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // Task #2024 — orphan-sample guard: every entry in
  // `notificationSamples.ts` must correspond to a registered key. Stops
  // the samples file growing out of sync as keys are renamed or
  // retired.
  it("the samples map has no orphan keys", async () => {
    const { listRegistered } = await import("../lib/notificationRegistry.js");
    const { listSampleKeys } = await import("../lib/notificationSamples.js");
    const registered = new Set(listRegistered());
    const orphans = listSampleKeys().filter(k => !registered.has(k));
    expect(
      orphans,
      `Sample entries with no registry key: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("dispatchNotification throws for unregistered keys", async () => {
    await expect(
      dispatchNotification("nope.fake.key", [userImmediateId], { title: "x", body: "y" }),
    ).rejects.toThrow(/unregistered notification key/);
  });

  // Task #1240 — regression guard: when the recipient has no Expo
  // tokens registered, `sendPushToUsers` returns
  // { attempted: 1, sent: 0, failed: 0, invalid: 0 }, which
  // `classifyPushDelivery` maps to "no_address". The dispatcher MUST
  // surface that as a `skipped` channel (not `failed`) so absent device
  // tokens do not pollute failure-rate alerting (Task #1070 contract).
  it("classifies a no-token recipient as channel=skipped, not failed", async () => {
    pushMock.mockImplementationOnce(async (uids: number[]) => ({
      attempted: uids.length, sent: 0, failed: 0, invalid: 0,
    }));
    const result = await dispatchNotification(
      "booking.confirmed", // non-digestable, defaultChannels include push
      [userImmediateId],
      { title: "Booked", body: "Confirmed." },
    );
    const recipient = result.recipients.find(r => r.userId === userImmediateId);
    expect(recipient).toBeDefined();
    const pushChannel = recipient!.channels.find(c => c.channel === "push");
    expect(pushChannel).toBeDefined();
    expect(pushChannel!.status).toBe("skipped");
    expect(pushChannel!.reason).toBe("no_device_token");
  });

  // Task #1429 — per-event opt-out wins over both digestMode and the
  // per-channel push/email path. Mirrors the contract enforced by
  // `coachPayoutAccountChangeNotify` for its bespoke admin alert: a
  // recipient who set the per-event flag false must receive no push,
  // no email, and no digest enqueue, but MUST still get an audit row
  // with reason=`event_opted_out` so the dispatch trail explains why
  // they got nothing.
  it("short-circuits per-event opt-out to audit-only even with digestMode=true", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userImmediateId,
      digestMode: true,
      notifyWalletRefundDigestFailed: false,
    });

    const sendEmail = vi.fn(async () => true);
    const result = await dispatchNotification(
      "wallet.refund.digest.failed",
      [userImmediateId],
      { title: "Refund job paused", body: "Auto-refunds paused on club X.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    // No push, no email, no digest — single audit-only `skipped` channel.
    expect(pushMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userImmediateId));
    expect(queued).toHaveLength(0);

    const recipient = result.recipients.find(r => r.userId === userImmediateId);
    expect(recipient).toBeDefined();
    expect(recipient!.channels).toHaveLength(1);
    expect(recipient!.channels[0]).toMatchObject({
      channel: "skipped",
      status: "skipped",
      reason: "event_opted_out",
    });

    // Audit row written even though the spec is not auditRequired.
    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, userImmediateId));
    expect(audits.length).toBe(1);
    expect(audits[0]).toMatchObject({
      notificationKey: "wallet.refund.digest.failed",
      channel: "skipped",
      reason: "event_opted_out",
    });
  });

  // Task #1429 — parity check for the second mapped key. The two new
  // admin-only opt-outs share one code path (PER_EVENT_OPT_OUT_COLUMNS),
  // so a regression on one would surface here too — but having the test
  // mention `side_game.receipt.digest.failed` by name makes the lookup
  // table's coverage explicit and survives anyone refactoring the map
  // into something less obviously parallel.
  it("short-circuits side_game.receipt.digest.failed opt-out the same way", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userImmediateId,
      digestMode: true,
      notifySideGameReceiptDigestFailed: false,
    });

    const sendEmail = vi.fn(async () => true);
    const result = await dispatchNotification(
      "side_game.receipt.digest.failed",
      [userImmediateId],
      { title: "Receipts paused", body: "Side-game receipts paused on club X.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );

    expect(pushMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    const queued = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, userImmediateId));
    expect(queued).toHaveLength(0);

    const recipient = result.recipients.find(r => r.userId === userImmediateId);
    expect(recipient!.channels).toEqual([
      { channel: "skipped", status: "skipped", reason: "event_opted_out" },
    ]);

    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, userImmediateId));
    expect(audits.length).toBe(1);
    expect(audits[0].notificationKey).toBe("side_game.receipt.digest.failed");
    expect(audits[0].reason).toBe("event_opted_out");
  });

  // Task #2207 — end-to-end coverage for the three admin-alert keys
  // wired into `PER_EVENT_OPT_OUT_COLUMNS` by Task #1444 / #1762:
  //   - `levy.ledger.digest.failed`        → notifyLevyLedgerDigestFailed
  //   - `levy.ledger.org.digest.failed`    → notifyLevyLedgerOrgDigestFailed
  //   - `levy.reminders.digest.failed`     → notifyLevyRemindersDigestFailed
  //
  // Until this test landed, the dispatcher's `event_opted_out`
  // short-circuit for these three keys was only covered indirectly
  // via the wallet/side-game refund parity tests above. A regression
  // where one of the three is dropped from
  // `PER_EVENT_OPT_OUT_COLUMNS` (but still appears in the portal UI)
  // would silently turn the toggle into a no-op: the user thinks
  // they've muted the alert, but the dispatcher still pushes / emails
  // because `eventOptIn` defaults to `true` for unmapped keys. Naming
  // each key and prefs column explicitly here means a missing entry
  // in the dispatcher map will fail this test rather than ship.
  type LevyOptOutCase = {
    key: string;
    field:
      | "notifyLevyLedgerDigestFailed"
      | "notifyLevyLedgerOrgDigestFailed"
      | "notifyLevyRemindersDigestFailed";
  };
  const LEVY_OPT_OUT_CASES: ReadonlyArray<LevyOptOutCase> = [
    { key: "levy.ledger.digest.failed", field: "notifyLevyLedgerDigestFailed" },
    { key: "levy.ledger.org.digest.failed", field: "notifyLevyLedgerOrgDigestFailed" },
    { key: "levy.reminders.digest.failed", field: "notifyLevyRemindersDigestFailed" },
  ];

  it.each(LEVY_OPT_OUT_CASES)(
    "short-circuits $key opt-out via $field to audit-only with reason=event_opted_out",
    async ({ key, field }) => {
      await db.insert(userNotificationPrefsTable).values({
        userId: userImmediateId,
        // digestMode=true ensures the per-event opt-out wins over the
        // digest-enqueue path too, mirroring the wallet/side-game
        // parity tests above.
        digestMode: true,
        [field]: false,
      });

      const sendEmail = vi.fn(async () => true);
      const result = await dispatchNotification(
        key,
        [userImmediateId],
        { title: "Levy alert", body: "A levy job needs attention.", emailHtml: "<p>x</p>" },
        { sendEmail },
      );

      // No push, no email, no digest enqueue.
      expect(pushMock).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      const queued = await db.select().from(notificationDigestQueueTable)
        .where(eq(notificationDigestQueueTable.userId, userImmediateId));
      expect(queued).toHaveLength(0);

      // Single audit-only `skipped` channel with the canonical reason.
      const recipient = result.recipients.find(r => r.userId === userImmediateId);
      expect(recipient).toBeDefined();
      expect(recipient!.channels).toEqual([
        { channel: "skipped", status: "skipped", reason: "event_opted_out" },
      ]);

      // Audit row written even though these keys are not auditRequired
      // in the registry seed — the dispatcher forces the row so
      // administrators can prove the alert was suppressed by user
      // choice rather than lost.
      const audits = await db.select().from(notificationAuditLogTable)
        .where(eq(notificationAuditLogTable.userId, userImmediateId));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        notificationKey: key,
        channel: "skipped",
        reason: "event_opted_out",
      });
    },
  );

  // Task #1429 — keys NOT in the per-event opt-out map are unaffected
  // by the new `notify*` columns even when the user has them disabled
  // (the column belongs to a different key).
  it("ignores per-event opt-out columns for keys that aren't mapped to them", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: userImmediateId,
      // Set the wallet-refund opt-out OFF, but dispatch a different key —
      // delivery should proceed normally on push + email channels.
      notifyWalletRefundDigestFailed: false,
    });

    const sendEmail = vi.fn(async () => true);
    await dispatchNotification(
      "highlight.ready",
      [userImmediateId],
      { title: "Reel ready", body: "Your reel is ready.", emailHtml: "<p>x</p>" },
      { sendEmail },
    );
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  // Task #1240 — regression guard: a real provider error (failed > 0,
  // sent = 0) MUST classify as `failed` so it shows up in alerting.
  it("classifies a provider failure as channel=failed", async () => {
    pushMock.mockImplementationOnce(async (uids: number[]) => ({
      attempted: uids.length, sent: 0, failed: uids.length, invalid: 0,
    }));
    const result = await dispatchNotification(
      "booking.confirmed",
      [userImmediateId],
      { title: "Booked", body: "Confirmed." },
    );
    const pushChannel = result.recipients[0].channels.find(c => c.channel === "push");
    expect(pushChannel?.status).toBe("failed");
    expect(pushChannel?.reason).toBe("push_provider_failed");
  });
});
