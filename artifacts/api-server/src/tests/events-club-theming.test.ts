/**
 * Regression test for Task #2194 — event quote / confirmation / invoice /
 * enquiry-ack emails (`routes/events.ts`) must honour the saved
 * `club_theming` row over the legacy `organizations.logo_url` /
 * `organizations.primary_color` columns.
 *
 * Background: Task #1758 routed every event email through
 * `resolveOrgBranding(orgId, org)` so admins who only customised branding
 * via the club-theming UI get those visuals on outgoing transactional
 * emails. This file locks that behaviour in for two representative paths
 * — the public enquiry-ack (no auth) and the admin status PATCH that
 * fires the "quote sent" email — so a future refactor that drops back to
 * reading the legacy columns trips a CI regression.
 *
 * Mirrors `broadcast-overlay-club-theming.test.ts` (Task #1758).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendEventEnquiryAck: vi.fn(async () => undefined),
    sendEventQuote: vi.fn(async () => undefined),
    sendEventConfirmation: vi.fn(async () => undefined),
    sendEventInvoice: vi.fn(async () => undefined),
    sendEventReminder: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubThemingTable,
  eventBookingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";
import {
  sendEventEnquiryAck,
  sendEventQuote,
} from "../lib/mailer.js";

const enquiryAckMock = vi.mocked(sendEventEnquiryAck);
const quoteMock = vi.mocked(sendEventQuote);

const LEGACY_LOGO = "https://example.com/events-legacy-logo.png";
const LEGACY_COLOR = "#aaaaaa";
const THEMED_LOGO = "https://example.com/events-club-theming-logo.png";
const THEMED_COLOR = "#bada55";

let testOrgId: number;
let bookingId: number;
let admin: TestUser;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Org carries the LEGACY branding columns. The club_theming row should
  // override these for every event email helper.
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_EventsClubTheming_${suffix}`,
    slug: `test-events-ct-${suffix}`,
    logoUrl: LEGACY_LOGO,
    primaryColor: LEGACY_COLOR,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: THEMED_COLOR,
    accentColor: "#112233",
    fontFamily: "Outfit",
    logoUrl: THEMED_LOGO,
    faviconUrl: null,
  });
  invalidateClubThemeCache(testOrgId);

  // Pre-existing booking used by the admin "status -> quote_sent" path.
  const [booking] = await db.insert(eventBookingsTable).values({
    organizationId: testOrgId,
    status: "enquiry",
    organiserName: "Asha Singh",
    organiserEmail: "asha@example.com",
    eventName: "Anniversary Dinner",
    eventDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }).returning({ id: eventBookingsTable.id });
  bookingId = booking.id;

  admin = {
    id: 1,
    username: "events_super_admin",
    role: "super_admin",
  };
});

afterAll(async () => {
  await db.delete(eventBookingsTable).where(eq(eventBookingsTable.organizationId, testOrgId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  enquiryAckMock.mockClear();
  quoteMock.mockClear();
});

describe("Task #2194 — event email branding honours club_theming over legacy organizations.* columns", () => {
  it("public enquiry-ack uses the saved club_theming logo / primary colour", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/organizations/${testOrgId}/events/enquiry`)
      .send({
        organiserName: "Asha Singh",
        organiserEmail: "asha+enquiry@example.com",
        eventName: "Garden Wedding",
        eventDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      });

    expect(res.status).toBe(201);
    expect(enquiryAckMock).toHaveBeenCalledTimes(1);

    const branding = enquiryAckMock.mock.calls[0][3];
    expect(branding?.logoUrl).toBe(THEMED_LOGO);
    expect(branding?.primaryColor).toBe(THEMED_COLOR);
    // Defensive: the legacy columns must NOT win when a club_theming row exists.
    expect(branding?.logoUrl).not.toBe(LEGACY_LOGO);
    expect(branding?.primaryColor).not.toBe(LEGACY_COLOR);
  });

  it("admin status PATCH (quote_sent) sends the quote email with club_theming branding", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .patch(`/api/organizations/${testOrgId}/events/bookings/${bookingId}/status`)
      .send({ status: "quote_sent" });

    expect(res.status).toBe(200);
    expect(quoteMock).toHaveBeenCalledTimes(1);

    const branding = quoteMock.mock.calls[0][3];
    expect(branding?.logoUrl).toBe(THEMED_LOGO);
    expect(branding?.primaryColor).toBe(THEMED_COLOR);
    expect(branding?.logoUrl).not.toBe(LEGACY_LOGO);
    expect(branding?.primaryColor).not.toBe(LEGACY_COLOR);
  });
});
