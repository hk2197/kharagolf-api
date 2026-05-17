/**
 * Integration tests: Task #438 — custom-domain → mini-site routing.
 *
 * Covers:
 *   1. GET /api/public/clubs/by-host/site
 *      - returns the mini-site for an active org with a matching custom domain
 *      - accepts case + port variations on the Host header
 *      - honours X-Forwarded-Host (including comma-separated lists)
 *      - 404s when org is inactive
 *      - 404s when no org maps to the host
 *      - 404s when the org's site is unpublished
 *   2. GET /api/public/sitemap.xml
 *      - emits https://<customDomain>/ for clubs with a custom domain
 *      - falls back to <base>/clubs/<slug> for clubs without one
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  clubMarketingSitesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = Date.now();
const customDomain = `pinevalley-${stamp}.golf`;
const slugWithDomain = `pinevalley-${stamp}`;
const slugNoDomain = `oakridge-${stamp}`;
const slugInactive = `dormant-${stamp}`;

let orgWithDomainId: number;
let orgNoDomainId: number;
let orgInactiveId: number;

beforeAll(async () => {
  const [a] = await db.insert(organizationsTable).values({
    name: `Pine Valley ${stamp}`,
    slug: slugWithDomain,
    customDomain,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgWithDomainId = a.id;

  const [b] = await db.insert(organizationsTable).values({
    name: `Oak Ridge ${stamp}`,
    slug: slugNoDomain,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgNoDomainId = b.id;

  const [c] = await db.insert(organizationsTable).values({
    name: `Dormant Club ${stamp}`,
    slug: slugInactive,
    customDomain: `dormant-${stamp}.golf`,
    isActive: false,
  }).returning({ id: organizationsTable.id });
  orgInactiveId = c.id;

  // Published mini-sites for both active clubs and the inactive one.
  for (const orgId of [orgWithDomainId, orgNoDomainId, orgInactiveId]) {
    await db.insert(clubMarketingSitesTable).values({
      organizationId: orgId,
      isPublished: true,
      publishedAt: new Date(),
    });
  }
});

afterAll(async () => {
  const ids = [orgWithDomainId, orgNoDomainId, orgInactiveId].filter(Boolean);
  if (ids.length) {
    await db.delete(clubMarketingSitesTable)
      .where(inArray(clubMarketingSitesTable.organizationId, ids));
    await db.delete(organizationsTable)
      .where(inArray(organizationsTable.id, ids));
  }
});

describe("GET /api/public/clubs/by-host/site — custom domain lookup", () => {
  it("returns the mini-site for an active org with a matching custom domain", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", customDomain);
    expect(r.status).toBe(200);
    expect(r.body.organization?.id).toBe(orgWithDomainId);
    expect(r.body.organization?.slug).toBe(slugWithDomain);
    expect(r.body.organization?.customDomain).toBe(customDomain);
    expect(r.body.site).toBeDefined();
  });

  it("accepts case variations on the Host header", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", customDomain.toUpperCase());
    expect(r.status).toBe(200);
    expect(r.body.organization?.id).toBe(orgWithDomainId);
  });

  it("strips the port from the Host header before matching", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", `${customDomain}:8443`);
    expect(r.status).toBe(200);
    expect(r.body.organization?.id).toBe(orgWithDomainId);
  });

  it("prefers X-Forwarded-Host over Host (and tolerates comma-separated lists)", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", "edge-internal.example.com")
      .set("X-Forwarded-Host", `${customDomain.toUpperCase()}:443, internal-lb`);
    expect(r.status).toBe(200);
    expect(r.body.organization?.id).toBe(orgWithDomainId);
  });

  it("returns 404 for an inactive org even when its custom domain matches", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", `dormant-${stamp}.golf`);
    expect(r.status).toBe(404);
  });

  it("returns 404 for an unknown host", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", `no-such-host-${stamp}.example.com`);
    expect(r.status).toBe(404);
  });

  it("Task #663: matches legacy rows whose stored customDomain has stray whitespace + mixed case", async () => {
    // Simulate an old admin save that bypassed normalisation by writing
    // the raw value straight to the column. The by-host lookup must
    // still find this row at request time.
    const messy = `  ${customDomain.toUpperCase()}\t`;
    await db.update(organizationsTable)
      .set({ customDomain: messy })
      .where(eq(organizationsTable.id, orgWithDomainId));
    try {
      const app = createTestApp();
      const r = await request(app)
        .get("/api/public/clubs/by-host/site")
        .set("Host", customDomain);
      expect(r.status).toBe(200);
      expect(r.body.organization?.id).toBe(orgWithDomainId);
    } finally {
      await db.update(organizationsTable)
        .set({ customDomain })
        .where(eq(organizationsTable.id, orgWithDomainId));
    }
  });

  it("returns 404 when the org exists but its mini-site is unpublished", async () => {
    await db.update(clubMarketingSitesTable)
      .set({ isPublished: false })
      .where(eq(clubMarketingSitesTable.organizationId, orgWithDomainId));
    try {
      const app = createTestApp();
      const r = await request(app)
        .get("/api/public/clubs/by-host/site")
        .set("Host", customDomain);
      expect(r.status).toBe(404);
    } finally {
      await db.update(clubMarketingSitesTable)
        .set({ isPublished: true })
        .where(eq(clubMarketingSitesTable.organizationId, orgWithDomainId));
    }
  });
});

describe("GET /api/public/sitemap.xml — custom domain canonicalisation", () => {
  it("emits https://<customDomain>/ for clubs with a custom domain", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/sitemap.xml")
      .set("Host", "kharagolf.com")
      .set("X-Forwarded-Proto", "https");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/xml/);
    expect(r.text).toContain(`<loc>https://${customDomain}</loc>`);
    // Must NOT also emit the path-based URL for the same club on the
    // main marketing host.
    expect(r.text).not.toContain(`<loc>https://kharagolf.com/clubs/${slugWithDomain}</loc>`);
  });

  it("emits the path-based URL for clubs without a custom domain", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/sitemap.xml")
      .set("Host", "kharagolf.com")
      .set("X-Forwarded-Proto", "https");
    expect(r.status).toBe(200);
    expect(r.text).toContain(`<loc>https://kharagolf.com/clubs/${slugNoDomain}</loc>`);
  });

  it("does not list inactive orgs in the sitemap regardless of custom domain", async () => {
    const app = createTestApp();
    const r = await request(app)
      .get("/api/public/sitemap.xml")
      .set("Host", "kharagolf.com");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(`dormant-${stamp}.golf`);
    expect(r.text).not.toContain(`/clubs/${slugInactive}`);
  });
});
