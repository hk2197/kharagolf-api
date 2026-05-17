/**
 * Regression test for Task #1758 — the public event enquiry endpoint
 * must hand the saved `club_theming` row to the email mailer over the
 * legacy `organizations.logo_url` / `organizations.primary_color`
 * columns.
 *
 * The mailer is mocked so we can assert the exact branding payload
 * that would be passed to the transactional event-enquiry-ack email.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async () => ({
  sendEventEnquiryAck: vi.fn(async () => undefined),
  // The events router imports several mailers — preserve the rest as
  // no-op stubs so other modules importing them do not crash.
  sendEventQuote: vi.fn(async () => undefined),
  sendEventConfirmation: vi.fn(async () => undefined),
  sendEventInvoice: vi.fn(async () => undefined),
  sendEventReminder: vi.fn(async () => undefined),
}));

import { sendEventEnquiryAck } from "../lib/mailer.js";
import { db } from "@workspace/db";
import {
  organizationsTable,
  clubThemingTable,
  eventBookingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

let testOrgId: number;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Org with the LEGACY branding columns populated; the club_theming
  // row should win over these for the enquiry-ack email.
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_EventEnquiryClubTheming_${suffix}`,
    slug: `test-event-enquiry-club-theming-${suffix}`,
    logoUrl: "https://example.com/legacy-events-logo.png",
    primaryColor: "#cccccc",
    isActive: true,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: "#22aa44",
    accentColor: "#001122",
    fontFamily: "Outfit",
    logoUrl: "https://example.com/club-theming-events-logo.png",
    faviconUrl: null,
  });
  invalidateClubThemeCache(testOrgId);
});

afterAll(async () => {
  await db.delete(eventBookingsTable).where(eq(eventBookingsTable.organizationId, testOrgId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

describe("POST /api/public/organizations/:orgId/events/enquiry — club theming precedence (Task #1758)", () => {
  it("hands the saved club_theming logo / primary colour to the enquiry-ack mailer", async () => {
    const ackMock = sendEventEnquiryAck as unknown as ReturnType<typeof vi.fn>;
    ackMock.mockClear();
    const app = createTestApp(); // public endpoint, no auth

    const res = await request(app)
      .post(`/api/public/organizations/${testOrgId}/events/enquiry`)
      .send({
        organiserName: "Test Organiser",
        organiserEmail: "organiser@example.com",
        eventName: "Spring Charity Ball",
        eventType: "wedding",
        eventDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        expectedGuests: 50,
      });

    expect(res.status).toBe(201);
    expect(res.body.bookingId).toBeTypeOf("number");

    // The mailer is invoked fire-and-forget but always before the
    // response in this code path; assert the exact branding payload.
    expect(ackMock).toHaveBeenCalledTimes(1);
    const args = ackMock.mock.calls[0] as unknown[];
    const branding = args[3] as { orgName?: string; logoUrl?: string; primaryColor?: string };
    expect(branding.logoUrl).toBe("https://example.com/club-theming-events-logo.png");
    expect(branding.primaryColor).toBe("#22aa44");
    // orgName still comes from organizations.name, not the theming row
    expect(branding.orgName).toMatch(/^TestOrg_EventEnquiryClubTheming_/);
  });
});
