/**
 * Behavioural proof for the lead-conversion link-state rules and the
 * rolling-deploy compatibility trigger Lead_complete_legacy_website_conversion.
 *
 * Run only against a throwaway PostgreSQL database migrated with the baseline:
 *
 *   RUN_LEAD_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/crm/lead-conversion-migration.integration.test.ts
 */
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_LEAD_MIGRATION_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

function sql(value: string): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the lead migration integration test")
  return execFileSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", value],
    { encoding: "utf8" },
  ).trim()
}

suite("lead conversion migration", () => {
  const tenantId = `tenant_lead_migration_${token}`
  const clientId = `client_lead_migration_${token}`
  const productId = `product_lead_migration_${token}`
  const websiteApplicationId = `application_website_${token}`
  const websiteLeadId = `lead_website_${token}`
  const staffLeadId = `lead_staff_${token}`

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('${tenantId}', 'lead-migration-${token}', 'Lead migration test', CURRENT_TIMESTAMP);

      INSERT INTO "Client" (
        "id", "tenantId", "reference", "idNumber", "firstName", "lastName",
        "email", "phone", "updatedAt"
      ) VALUES (
        '${clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Migration',
        'Client', 'migration-${token}@test.invalid', '+27820000000', CURRENT_TIMESTAMP
      );

      INSERT INTO "LoanProduct" (
        "id", "tenantId", "code", "name", "productType", "minAmount",
        "maxAmount", "minTermDays", "maxTermDays", "interestRatePm",
        "interestModel"
      ) VALUES (
        '${productId}', '${tenantId}', 'MIG-${token}', 'Migration product',
        'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL'
      );
    `)
  })

  it("atomically completes the old website writer from one exact submission audit", () => {
    sql(`
      INSERT INTO "Lead" (
        "id", "tenantId", "firstName", "lastName", "phone", "status", "tags", "updatedAt"
      ) VALUES (
        '${websiteLeadId}', '${tenantId}', 'Rolling', 'Website', '+27820000002',
        'NEW', ARRAY[]::TEXT[], CURRENT_TIMESTAMP
      );

      INSERT INTO "LoanApplication" (
        "id", "tenantId", "reference", "clientId", "productId",
        "appliedAmount", "appliedTermDays", "status", "updatedAt"
      ) VALUES (
        '${websiteApplicationId}', '${tenantId}', 'APP-WEB-${token}',
        '${clientId}', '${productId}', 600000, 30, 'SUBMITTED', CURRENT_TIMESTAMP
      );

      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId", "newValue"
      ) VALUES (
        'audit-website-${token}', '${tenantId}', 'website-system',
        'APPLICATION_SUBMITTED_BY_CLIENT', 'LoanApplication', '${websiteApplicationId}',
        jsonb_build_object(
          'source', 'website_apply',
          'leadId', '${websiteLeadId}',
          'clientId', '${clientId}'
        )
      );

      UPDATE "Lead"
      SET "status" = 'QUALIFIED', "convertedToClientId" = '${clientId}',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${websiteLeadId}';
    `)

    expect(sql(`
      SELECT concat_ws('|', "status"::text, "convertedToClientId",
        "convertedToApplicationId", "conversionRecoveryRequired"::text)
      FROM "Lead"
      WHERE "id" = '${websiteLeadId}';
    `)).toBe(`CONVERTED|${clientId}|${websiteApplicationId}|false`)
    expect(sql(`
      SELECT count(*)
      FROM "AuditLog"
      WHERE "entity" = 'Lead'
        AND "entityId" = '${websiteLeadId}'
        AND "action" = 'LEAD_CONVERTED'
        AND "newValue" ->> 'source' = 'migrate_before_deploy_website_compatibility';
    `)).toBe("1")
  })

  it("keeps one Lead per converted application in a tenant", () => {
    expect(sql(`
      SELECT count(*)
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'Lead_tenantId_convertedToApplicationId_key';
    `)).toBe("1")
  })

  it("still fails the old staff writer closed instead of leaving a partial conversion", () => {
    sql(`
      INSERT INTO "Lead" (
        "id", "tenantId", "firstName", "lastName", "phone", "status", "tags", "updatedAt"
      ) VALUES (
        '${staffLeadId}', '${tenantId}', 'Rolling', 'Staff', '+27820000003',
        'QUALIFIED', ARRAY[]::TEXT[], CURRENT_TIMESTAMP
      );
    `)

    if (!databaseUrl) throw new Error("DATABASE_URL is required for the lead migration integration test")
    const rejected = spawnSync(
      "psql",
      [
        "--no-psqlrc",
        "--dbname",
        databaseUrl,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        `
      UPDATE "Lead"
      SET "status" = 'CONVERTED', "convertedToClientId" = '${clientId}',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${staffLeadId}';
        `,
      ],
      { encoding: "utf8" },
    )
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain("Lead_conversion_link_state_check")

    expect(sql(`
      SELECT concat_ws('|', "status"::text,
        coalesce("convertedToClientId", 'NULL'),
        coalesce("convertedToApplicationId", 'NULL'))
      FROM "Lead"
      WHERE "id" = '${staffLeadId}';
    `)).toBe("QUALIFIED|NULL|NULL")
  })
})
