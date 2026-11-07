-- The lender's public-website photos (hero, per-product, community band), a JSON document validated by
-- lib/config/website-imagery-schema.ts. Additive and nullable: NULL leaves the website exactly as it was.
ALTER TABLE "TenantConfig" ADD COLUMN     "websiteImagery" JSONB;
