/**
 * Task #750 — Backfill the marketing-site image library.
 *
 * The `club_marketing_site_images` tracking table only gets populated as
 * admins upload new images going forward. Photos uploaded before the
 * library was introduced still live in object storage and on the live
 * mini-site, but they don't appear in the "Choose from library" picker
 * because no row was ever inserted for them.
 *
 * This one-shot script walks every `club_marketing_sites` row and inserts
 * a library row for every image URL referenced by the site config:
 *   - heroImageUrl
 *   - seoOgImageUrl
 *   - logoImageUrl
 *   - faviconUrl
 *   - every entry in galleryImages[]
 *
 * Insertion is idempotent: the table has a unique index on
 * (organization_id, object_path), so re-running the script is a no-op
 * for already-tracked images. Object paths are derived from the URL by
 * stripping the `/api/storage` prefix when present; URLs that don't
 * match that shape (e.g. third-party CDN links) are stored verbatim as
 * the object_path so they still de-duplicate correctly across runs.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @workspace/scripts run \
 *     backfill-marketing-site-images
 *
 * Pass `--dry-run` to see what would be inserted without writing.
 */

import { db, clubMarketingSitesTable, clubMarketingSiteImagesTable } from "@workspace/db";

const DRY_RUN = process.argv.includes("--dry-run");

function deriveObjectPath(url: string): string {
  const marker = "/api/storage";
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    return url.slice(idx + marker.length) || url;
  }
  return url;
}

type Candidate = { organizationId: number; objectPath: string; url: string };

async function main() {
  const sites = await db
    .select({
      organizationId: clubMarketingSitesTable.organizationId,
      heroImageUrl: clubMarketingSitesTable.heroImageUrl,
      seoOgImageUrl: clubMarketingSitesTable.seoOgImageUrl,
      logoImageUrl: clubMarketingSitesTable.logoImageUrl,
      faviconUrl: clubMarketingSitesTable.faviconUrl,
      galleryImages: clubMarketingSitesTable.galleryImages,
    })
    .from(clubMarketingSitesTable);

  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const site of sites) {
    const urls: string[] = [];
    for (const u of [site.heroImageUrl, site.seoOgImageUrl, site.logoImageUrl, site.faviconUrl]) {
      if (typeof u === "string" && u.trim() !== "") urls.push(u.trim());
    }
    if (Array.isArray(site.galleryImages)) {
      for (const g of site.galleryImages) {
        if (g && typeof g.url === "string" && g.url.trim() !== "") {
          urls.push(g.url.trim());
        }
      }
    }
    for (const url of urls) {
      const objectPath = deriveObjectPath(url);
      const key = `${site.organizationId}\u0000${objectPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ organizationId: site.organizationId, objectPath, url });
    }
  }

  console.log(
    `[backfill] scanned ${sites.length} marketing sites, found ${candidates.length} unique image references`,
  );

  if (DRY_RUN) {
    for (const c of candidates) {
      console.log(`  [dry-run] org=${c.organizationId} ${c.objectPath}`);
    }
    console.log("[backfill] dry-run complete; no rows written.");
    return;
  }

  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const result = await db
      .insert(clubMarketingSiteImagesTable)
      .values(chunk.map(c => ({
        organizationId: c.organizationId,
        objectPath: c.objectPath,
        url: c.url,
        contentType: null,
        sizeBytes: null,
        uploadedByUserId: null,
      })))
      .onConflictDoNothing({
        target: [
          clubMarketingSiteImagesTable.organizationId,
          clubMarketingSiteImagesTable.objectPath,
        ],
      })
      .returning({ id: clubMarketingSiteImagesTable.id });
    inserted += result.length;
  }

  const skipped = candidates.length - inserted;
  console.log(
    `[backfill] inserted ${inserted} new library rows, skipped ${skipped} that already existed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
