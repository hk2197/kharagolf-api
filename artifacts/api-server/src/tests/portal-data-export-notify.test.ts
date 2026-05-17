/**
 * Integration test: "Your data export is ready" notification round-trip
 * (Task #618).
 *
 * The self-serve POST /api/portal/my-data-export route immediately fulfils
 * the archive and then fires a fan-out notification through
 * `notifyDataRequest({ kind: "completed_export" })`. This test verifies the
 * end-to-end behaviour of that notice:
 *
 *   1. An in-app `member_messages` row is written with the dedicated
 *      "Your data export is ready" subject + a copy of the body.
 *   2. The transactional email is dispatched to the member via the mailer
 *      with `kind: "completed_export"` and (when storage is reachable)
 *      a one-tap signed download URL.
 *   3. The push notification is sent with `kind: "completed_export"` and
 *      includes the same download URL in its data payload, so the mobile
 *      app can route members straight to the download.
 *   4. Per-channel delivery telemetry is persisted on
 *      `member_data_requests` exactly like other privacy notices, so the
 *      controller dashboard can surface it.
 *
 * Mailer + comms are mocked so we can observe the dispatched payloads
 * without hitting real providers. Object storage is mocked to return a
 * deterministic signed URL so we can assert the one-tap CTA threads
 * through both the email and the push payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendDataRequestEmailMock, sendTransactionalPushMock } = vi.hoisted(() => ({
  sendDataRequestEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
  sendTransactionalPushMock: vi.fn(
    async (
      userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    }),
  ),
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendDataRequestEmail: sendDataRequestEmailMock,
  };
});

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => "wa_msg_id"),
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

const SIGNED_URL = "https://storage.example.test/signed-data-export.json?token=abc";

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(relativePath: string): Promise<string> {
      return `/objects/${relativePath}`;
    }
    async getSignedDownloadUrl(): Promise<string> {
      return SIGNED_URL;
    }
    async getObjectEntityFile(): Promise<never> {
      throw new Error("not used in this test");
    }
  },
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text, body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz, error_message text,
      related_entity text, related_entity_id integer
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz, resolved_at timestamptz, notes text, artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      last_notification_kind text, last_notified_at timestamptz,
      last_email_status text, last_email_at timestamptz, last_email_error text,
      last_in_app_message_id integer REFERENCES member_messages(id) ON DELETE SET NULL,
      last_in_app_at timestamptz,
      last_push_status text, last_push_at timestamptz, last_push_error text,
      last_sms_status text, last_sms_at timestamptz, last_sms_error text,
      last_whatsapp_status text, last_whatsapp_at timestamptz, last_whatsapp_error text,
      last_whatsapp_message_id text,
      push_attempts integer NOT NULL DEFAULT 0, sms_attempts integer NOT NULL DEFAULT 0,
      whatsapp_attempts integer NOT NULL DEFAULT 0,
      last_push_retry_at timestamptz, last_sms_retry_at timestamptz,
      last_whatsapp_retry_at timestamptz,
      push_retry_exhausted_at timestamptz, sms_retry_exhausted_at timestamptz,
      whatsapp_retry_exhausted_at timestamptz,
      email_attempts integer NOT NULL DEFAULT 0,
      last_email_retry_at timestamptz, email_retry_exhausted_at timestamptz,
      email_exhaustion_notified_at timestamptz,
      push_exhaustion_notified_at timestamptz,
      sms_exhaustion_notified_at timestamptz,
      whatsapp_exhaustion_notified_at timestamptz
    )`);
  // Defensive ALTERs for older test DBs that pre-date the WhatsApp columns.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_status text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_error text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_message_id text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_exhaustion_notified_at timestamptz`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text, actor_role text,
      entity text NOT NULL, entity_id integer, action text NOT NULL,
      field_changes jsonb, reason text, metadata jsonb,
      ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

let testOrgId: number;
let testMemberId: number;
let testUserId: number;
let actor: TestUser;
let app: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ExportNotify_${ts}`,
    slug: `test-export-notify-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `export-notify-${ts}`,
    username: `export_notify_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Export",
    lastName: "Recipient",
    email: `export-notify-${ts}@example.test`,
    userId: testUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  actor = { id: testUserId, username: `export_notify_${ts}`, role: "player", organizationId: testOrgId };
  app = createTestApp(actor);
});

afterAll(async () => {
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendDataRequestEmailMock.mockClear();
  sendTransactionalPushMock.mockClear();
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined | false = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("POST /portal/my-data-export — completed_export notification", () => {
  it("emails + pushes a one-tap download link and persists per-channel telemetry", async () => {
    const res = await request(app).post("/api/portal/my-data-export").send({});
    expect(res.status).toBe(201);
    const exportId: number = res.body.export.id;
    expect(res.body.export.computedStatus).toBe("ready");

    // The notification fires fire-and-forget; wait for both email AND
    // push to land before asserting on either — they're dispatched in a
    // fan-out and the email mock can resolve before the push promise has
    // even started.
    await waitFor(async () =>
      sendDataRequestEmailMock.mock.calls.length > 0
        && sendTransactionalPushMock.mock.calls.length > 0
        ? true : null,
    );

    // 1) Email dispatched with the dedicated kind + signed download URL.
    const emailCall = sendDataRequestEmailMock.mock.calls[0]![0] as {
      kind: string;
      to: string;
      requestId: number;
      artifactUrl: string | null;
      lang: string | null | undefined;
    };
    expect(emailCall.kind).toBe("completed_export");
    expect(emailCall.requestId).toBe(exportId);
    expect(emailCall.artifactUrl).toBe(SIGNED_URL);
    expect(emailCall.to).toContain("export-notify-");
    // Task #1745 — the recipient's preferred language is forwarded so
    // the mailer can localise the subject + body. Our seed user uses the
    // schema default ("en"), so the prop should land as "en" (or null
    // when the column hasn't been populated yet — both fall back to the
    // English pack inside the mailer).
    expect(emailCall.lang === null || emailCall.lang === undefined || emailCall.lang === "en").toBe(true);

    // 2) Push dispatched with completed_export kind + downloadUrl payload.
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, pushSubject, pushBody, pushPayload] = sendTransactionalPushMock.mock.calls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(recipients).toEqual([testUserId]);
    expect(pushSubject).toContain("Your data export is ready");
    // The push body is trimmed to 200 chars, so the full signed URL may be
    // truncated; the authoritative one-tap target is in the data payload
    // below. We at least assert the body sets the user up for the link.
    // Task #2168 — body wording is now sourced from the same i18n pack
    // the email uses (`bodyWithLinkLead`), so the English copy is the
    // pack literal "Tap the button below to download your archive...".
    expect(pushBody).toContain("Tap the button below to download your archive");
    expect(pushPayload.type).toBe("data_request");
    expect(pushPayload.kind).toBe("completed_export");
    expect(pushPayload.requestId).toBe(exportId);
    expect(pushPayload.downloadUrl).toBe(SIGNED_URL);

    // 3) In-app message persisted with the same subject + body containing the link.
    const inAppMsgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.organizationId, testOrgId),
      eq(memberMessagesTable.clubMemberId, testMemberId),
      eq(memberMessagesTable.channel, "in_app"),
    ));
    const exportMsg = inAppMsgs.find((m) => (m.subject ?? "").includes("Your data export is ready"));
    expect(exportMsg).toBeTruthy();
    expect(exportMsg!.body).toContain(SIGNED_URL);

    // 4) Per-channel telemetry persisted on the data-request row.
    const [row] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, exportId));
    expect(row.lastNotificationKind).toBe("completed_export");
    expect(row.lastEmailStatus).toBe("sent");
    expect(row.lastEmailAt).toBeTruthy();
    expect(row.lastPushStatus).toBe("sent");
    expect(row.lastInAppMessageId).toBe(exportMsg!.id);
    expect(row.lastInAppAt).toBeTruthy();
  });

  it("forwards the recipient's preferredLanguage so the mailer renders the Hindi subject + body", async () => {
    // Task #1745 — flip the seed user to Hindi and re-fire the
    // self-serve export. The email dispatched through `sendDataRequestEmail`
    // should carry `lang: "hi"`, and feeding that exact payload through
    // the real mailer should produce the Hindi subject/heading/CTA.
    await db.update(appUsersTable)
      .set({ preferredLanguage: "hi" })
      .where(eq(appUsersTable.id, testUserId));
    try {
      const res = await request(app).post("/api/portal/my-data-export").send({});
      expect(res.status).toBe(201);
      const exportId: number = res.body.export.id;

      await waitFor(async () => sendDataRequestEmailMock.mock.calls.length > 0 ? true : null);

      const hindiCall = sendDataRequestEmailMock.mock.calls.at(-1)?.[0] as {
        kind: string;
        requestId: number;
        lang: string | null | undefined;
        memberName: string;
        artifactUrl: string | null;
        unsubUrl: string | null;
        branding?: { orgName?: string };
      };
      expect(hindiCall.kind).toBe("completed_export");
      expect(hindiCall.requestId).toBe(exportId);
      expect(hindiCall.lang).toBe("hi");

      // Round-trip the localised payload through the real i18n helper to
      // confirm the mailer would render Hindi copy verbatim from the pack.
      // (The mailer itself is mocked above so we can't snapshot the email
      // HTML directly — calling the helper with the same args is the
      // closest equivalent without re-implementing the switch case.)
      const { translateDataExportEmail } = await import(
        "../lib/dataExportEmailI18n.js"
      );
      const hi = translateDataExportEmail(hindiCall.lang, "completed_export", {
        name: hindiCall.memberName,
        orgName: hindiCall.branding?.orgName ?? "KHARAGOLF",
        ref: hindiCall.requestId,
      });
      // Subject mirrors the Hindi pack literal "आपका डेटा निर्यात तैयार है".
      expect(hi.subject).toContain("आपका डेटा निर्यात तैयार है");
      expect(hi.subject).toContain(`#${exportId}`);
      expect(hi.heading).toBe("आपका डेटा निर्यात डाउनलोड के लिए तैयार है");
      // CTA + opt-out sentence are translated, not English.
      expect(hi.bodyButtonLabel).toBe("⬇ मेरा डेटा संग्रह डाउनलोड करें");
      expect(hi.optOutLinkText).toBe("इस डाउनलोड के बारे में मुझे याद न दिलाएँ");
      expect(hi.htmlLang).toBe("hi");
      expect(hi.dir).toBe("ltr");
    } finally {
      // Restore the schema default ("en"); the column is NOT NULL so we
      // can't reset to null after the test — and other tests in the file
      // assume the recipient is on the English pack.
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, testUserId));
    }
  });

  it("falls back to English when the recipient's preferredLanguage is not in the supported set", async () => {
    // Task #1745 — defensive: an out-of-range code (e.g. legacy "xx" rows
    // or a value that hasn't been added to the supported_language enum
    // yet) must not crash the mailer; it should fall back to English.
    const { translateDataExportEmail } = await import(
      "../lib/dataExportEmailI18n.js"
    );
    const en = translateDataExportEmail("xx-unknown", "completed_export", {
      name: "Export Recipient",
      orgName: "TestOrg",
      ref: 1234,
    });
    expect(en.subject).toBe("Your data export is ready (#1234)");
    expect(en.heading).toBe("Your data export is ready to download");
    expect(en.bodyButtonLabel).toBe("⬇ Download my data archive");
    expect(en.htmlLang).toBe("en");
  });

  it("renders the export_expiring reminder in Arabic with rtl direction", async () => {
    // Task #1745 — the 24h-before reminder must also localise. Arabic is
    // the only RTL pack so it doubles as the regression check that the
    // outer block carries `dir="rtl"`.
    const { translateDataExportEmail } = await import(
      "../lib/dataExportEmailI18n.js"
    );
    const ar = translateDataExportEmail("ar", "export_expiring", {
      name: "Export Recipient",
      orgName: "TestOrg",
      ref: 7777,
    });
    expect(ar.subject).toContain("تذكير");
    expect(ar.subject).toContain("#7777");
    expect(ar.heading).toBe("تصدير بياناتك ينتهي خلال حوالي 24 ساعة");
    // Reminder uses the dedicated "stop reminding me" wording, not the
    // ready-email "don't remind me" copy.
    expect(ar.optOutLinkText).toBe("توقف عن تذكيري بهذا التنزيل");
    expect(ar.dir).toBe("rtl");
    expect(ar.htmlLang).toBe("ar");
  });

  it("localises the push subject/body and in-app message body for completed_export when the recipient prefers Hindi", async () => {
    // Task #2168 — Task #1745 already localised the email subject + body
    // but the push notification and the persisted `member_messages.body`
    // continued to render in English regardless of the recipient's
    // `preferredLanguage`. This test exercises the self-serve export
    // round-trip with a Hindi recipient and asserts that all three
    // surfaces (push subject, push body, in-app body) carry the Hindi
    // pack literals — phrase-for-phrase aligned with the email path.
    await db.update(appUsersTable)
      .set({ preferredLanguage: "hi" })
      .where(eq(appUsersTable.id, testUserId));
    try {
      const res = await request(app).post("/api/portal/my-data-export").send({});
      expect(res.status).toBe(201);
      const exportId: number = res.body.export.id;

      await waitFor(async () =>
        sendDataRequestEmailMock.mock.calls.length > 0
          && sendTransactionalPushMock.mock.calls.length > 0
          ? true : null,
      );

      // 1) Push subject + body localised. The Hindi `subject` template is
      //    "आपका डेटा निर्यात तैयार है ({ref})" and the intro paragraph
      //    opens with "नमस्ते" — both are pack literals so we assert on
      //    them verbatim.
      const [, pushSubject, pushBody] = sendTransactionalPushMock.mock.calls.at(-1)! as [
        number[], string, string, Record<string, unknown>,
      ];
      expect(pushSubject).toContain("आपका डेटा निर्यात तैयार है");
      expect(pushSubject).toContain(`#${exportId}`);
      // The body is trimmed to 200 chars at the call site; the Hindi
      // greeting + first noun from the intro lands well within that
      // window so it's safe to assert on.
      expect(pushBody).toContain("नमस्ते");
      // English fallback strings must not bleed through.
      expect(pushSubject).not.toContain("Your data export is ready");
      expect(pushBody).not.toContain("Tap to download");

      // 2) Persisted in-app message body localised the same way. Subject
      //    starts with "आपका डेटा निर्यात तैयार है" so we look it up by
      //    that prefix (the row also carries `#<id>` in the subject from
      //    the same template, but matching on the leading literal is
      //    enough to disambiguate from any English rows from earlier
      //    tests in the file).
      const inAppMsgs = await db.select().from(memberMessagesTable).where(and(
        eq(memberMessagesTable.organizationId, testOrgId),
        eq(memberMessagesTable.clubMemberId, testMemberId),
        eq(memberMessagesTable.channel, "in_app"),
      ));
      const hiMsg = inAppMsgs.find(
        (m) => (m.subject ?? "").includes("आपका डेटा निर्यात तैयार है")
          && (m.subject ?? "").includes(`#${exportId}`),
      );
      expect(hiMsg).toBeTruthy();
      expect(hiMsg!.body).toContain("नमस्ते");
      // Signed download URL is still embedded on its own line so the
      // mobile in-app inbox can render it as a tappable link.
      expect(hiMsg!.body).toContain(SIGNED_URL);
      // Localised opt-out link text from the Hindi pack must be present.
      expect(hiMsg!.body).toContain("इस डाउनलोड के बारे में मुझे याद न दिलाएँ");
    } finally {
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, testUserId));
    }
  });

  it("localises the push subject/body and in-app message body for export_expiring when the recipient prefers Hindi", async () => {
    // Task #2168 — same coverage as the test above, but for the 24h-before
    // reminder kind. Driven directly through `notifyDataRequest` because
    // the reminder is fired by the cron, not the self-serve route.
    await db.update(appUsersTable)
      .set({ preferredLanguage: "hi" })
      .where(eq(appUsersTable.id, testUserId));
    const [seeded] = await db.insert(memberDataRequestsTable).values({
      clubMemberId: testMemberId,
      organizationId: testOrgId,
      requestType: "export",
      status: "completed",
      requestedAt: new Date(),
      resolvedAt: new Date(),
      artifactUrl: "/objects/exports/test-archive-expiring-hi.json",
      lastNotificationKind: "completed_export",
      // Token used by the reminder path to render the unsub URL — its
      // localised opt-out sentence is what we assert on below.
      expiringReminderUnsubToken: "tok-expiring-hi",
    }).returning();
    try {
      const { notifyDataRequest } = await import("../lib/dataRequestNotify.js");
      const result = await notifyDataRequest({
        organizationId: testOrgId,
        request: seeded,
        kind: "export_expiring",
      });
      expect(result.pushStatus).toBe("sent");
      expect(result.inAppMessageId).toBeTruthy();

      // Push subject + body — Hindi reminder pack literals: subject
      // starts with "अनुस्मारक" ("Reminder"), body intro opens with
      // "नमस्ते" the same way the ready notice does.
      const [, pushSubject, pushBody] = sendTransactionalPushMock.mock.calls.at(-1)! as [
        number[], string, string, Record<string, unknown>,
      ];
      expect(pushSubject).toContain("अनुस्मारक");
      expect(pushSubject).toContain(`#${seeded.id}`);
      expect(pushBody).toContain("नमस्ते");
      expect(pushSubject).not.toContain("Reminder: your data export expires");
      expect(pushBody).not.toContain("Tap to download before it expires");

      // Persisted in-app message body — same Hindi copy. The reminder
      // pack uses the dedicated "stop reminding me about this download"
      // wording rather than the ready-email "don't remind me" copy.
      const [hiMsg] = await db.select().from(memberMessagesTable)
        .where(eq(memberMessagesTable.id, result.inAppMessageId!));
      expect(hiMsg).toBeTruthy();
      expect(hiMsg.body).toContain("नमस्ते");
      expect(hiMsg.body).toContain("इस डाउनलोड के बारे में मुझे याद दिलाना बंद करें");
    } finally {
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, testUserId));
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("re-mints a fresh signed download URL when the email/push retry fires", async () => {
    // Seed a request row in the same `failed`-after-initial-send shape the
    // retry cron picks up. The artifact path is the persisted internal
    // `/objects/...` reference; the retry helper must mint a fresh signed
    // URL from it instead of forwarding that unclickable path.
    //
    // Task #1745 — also flip the recipient to a non-English language so we
    // can assert the retry path threads `lang` through to the mailer (and
    // embeds the matching `lang=` hint in the unsubscribe URL the same
    // way the first-attempt code does).
    await db.update(appUsersTable)
      .set({ preferredLanguage: "fr" })
      .where(eq(appUsersTable.id, testUserId));
    const [seeded] = await db.insert(memberDataRequestsTable).values({
      clubMemberId: testMemberId,
      organizationId: testOrgId,
      requestType: "export",
      status: "completed",
      requestedAt: new Date(),
      resolvedAt: new Date(),
      artifactUrl: "/objects/exports/test-archive.json",
      lastNotificationKind: "completed_export",
      lastEmailStatus: "failed",
      lastEmailAt: new Date(),
      emailAttempts: 1,
      lastPushStatus: "failed",
      lastPushAt: new Date(),
      pushAttempts: 1,
      // Token used by the retry path to render the unsub URL.
      expiringReminderUnsubToken: "tok-retry-fr",
    }).returning();

    const { retryDataRequestEmail, retryDataRequestPush } = await import(
      "../lib/dataRequestNotify.js"
    );

    const emailResult = await retryDataRequestEmail({ request: seeded });
    expect(emailResult?.status).toBe("sent");
    const retriedEmail = sendDataRequestEmailMock.mock.calls.at(-1)?.[0] as {
      kind: string;
      artifactUrl: string | null;
      lang: string | null | undefined;
      unsubUrl: string | null;
    };
    expect(retriedEmail.kind).toBe("completed_export");
    expect(retriedEmail.artifactUrl).toBe(SIGNED_URL);
    // Task #1745 — retry threads the recipient's preferred language into
    // the mailer, mirroring the first-attempt behaviour.
    expect(retriedEmail.lang).toBe("fr");
    // Task #1437 / #1745 — the same `lang=` hint also lands in the
    // unsubscribe URL so the confirmation page loads in French too.
    expect(retriedEmail.unsubUrl).toBeTruthy();
    expect(retriedEmail.unsubUrl).toContain("lang=fr");
    // Restore the schema default so subsequent runs of the suite start
    // from a known state.
    await db.update(appUsersTable)
      .set({ preferredLanguage: "en" })
      .where(eq(appUsersTable.id, testUserId));

    const pushResult = await retryDataRequestPush({ request: seeded });
    expect(pushResult?.status).toBe("sent");
    const retriedPush = sendTransactionalPushMock.mock.calls.at(-1) as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(retriedPush[3].kind).toBe("completed_export");
    expect(retriedPush[3].retry).toBe(true);
    expect(retriedPush[3].downloadUrl).toBe(SIGNED_URL);
  });
});
