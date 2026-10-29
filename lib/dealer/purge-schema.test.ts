import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The draft purge is only as complete as two hand lists in migration
// 20261022100000_dealer_followups: the columns guardDealerPurgedParty
// overwrites, and the text-only links dealerPurgeTextLinks reads. These hold
// both against the Prisma schema, so a column added later fails here until
// someone decides whether it is personal data or a link.
const ROOT = process.cwd()
const MIGRATION = readFileSync(path.join(ROOT, "prisma/migrations/20261022100000_dealer_followups/migration.sql"), "utf8")
const SCHEMA = readdirSync(path.join(ROOT, "prisma/schema")).filter((f) => f.endsWith(".prisma"))
  .map((f) => readFileSync(path.join(ROOT, "prisma/schema", f), "utf8")).join("\n")
// The text-only links are read from the latest migration that redefines dealerPurgeTextLinks.
const LINKS_SQL = readdirSync(path.join(ROOT, "prisma/migrations")).sort().reverse()
  .map((d) => path.join(ROOT, "prisma/migrations", d, "migration.sql"))
  .filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8"))
  .find((sql) => sql.includes('CREATE OR REPLACE FUNCTION "dealerPurgeTextLinks"')) ?? ""
const MODELS = new Set([...SCHEMA.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]))

function body(model: string): string {
  const match = new RegExp(`^model ${model} \\{([\\s\\S]*?)\\n\\}`, "m").exec(SCHEMA)
  if (!match) throw new Error(`model ${model} not found`)
  return match[1]
}

/** The model's own columns: scalars and enums, not relations or back-relations. */
function columns(model: string): string[] {
  return body(model).split("\n").flatMap((line) => {
    const field = /^\s+(\w+)\s+(\w+)(\[\]|\?)?/.exec(line)
    if (!field || line.includes("@relation") || MODELS.has(field[2])) return []
    return [field[1]]
  })
}

function erased(model: string): Set<string> {
  const section = model === "Client"
    ? MIGRATION.slice(MIGRATION.indexOf(`IF TG_TABLE_NAME = 'Client' THEN\n    NEW."idNumber"`), MIGRATION.indexOf("  ELSE\n    NEW.\"legalName\""))
    : MIGRATION.slice(MIGRATION.indexOf("  ELSE\n    NEW.\"legalName\""), MIGRATION.indexOf("CREATE TRIGGER \"Client_a_dealer_purge\""))
  return new Set([...section.matchAll(/NEW\."(\w+)" :=/g)].map((m) => m[1]))
}

// Kept on purpose: keys and provenance, dates and flags that carry no identity,
// and staff status notes (a dealer draft has none; SLICE5-FOLLOWUPS.md part D known limitations).
const KEPT: Record<string, string[]> = {
  Client: [
    "id", "tenantId", "reference", "branchId", "popiaConsentGiven", "popiaConsentAt", "kycVerifiedAt", "kycVerifiedById", "kycVerificationMethod",
    "kycManualRejectionActive", "kycManualRejectionAt", "kycManualRejectionById", "kycManualRejectionReason", "kycManualRejectionResolvedAt",
    "kycManualRejectionResolvedById", "kycManualRejectionResolutionReason", "amlScreeningStatus", "amlScreeningAt", "kycStatus", "blacklisted",
    "blacklistReason", "deceasedAt", "deceasedReason", "riskLevel", "riskFlagNote", "riskFlaggedAt", "riskFlaggedById", "createdAt", "updatedAt",
    "referralCount", "referredFromId", "referralCodeId", "createdByDealerId", "dealerContactVerifiedAt", "dealerContactVerifiedById", "dealerPurgedAt",
  ],
  BusinessEntity: ["id", "tenantId", "type", "createdById", "createdByDealerId", "dealerPurgedAt", "createdAt", "updatedAt"],
}

// Columns that name a person or business by id without a foreign key, and are not a link to keep it by.
// AutoDecisionDue.clientId is a short-lived rate-limit counter, pruned after 30 days by the digital-decisions sweep.
const NOT_LINKS = ["AutoDecisionDue.clientId", "AuditLog.entityId", "CreditDecisionRecord.sourceEntityId", "WebhookEvent.entityId", "WebhookOutboxFailure.entityId",
  // OAuth / SAML identifiers of an identity provider or API client, not a person (lib/sso, lib/lender-api/oauth).
  "OauthClient.clientId", "SsoConnection.oidcClientId", "SsoConnection.samlEntityId", "SsoConnection.samlIdpEntityId"]

describe("dealer draft purge against the schema", () => {
  it.each(["Client", "BusinessEntity"])("decides every %s column: overwritten or kept on purpose", (model) => {
    const overwritten = erased(model)
    expect(overwritten.size).toBeGreaterThan(5)
    const undecided = columns(model).filter((c) => !overwritten.has(c) && !KEPT[model].includes(c))
    expect(undecided).toEqual([])
    expect([...overwritten, ...KEPT[model]].filter((c) => !columns(model).includes(c))).toEqual([])
  })

  it("lists every id column that names a person or business without a foreign key", () => {
    const found: string[] = []
    for (const model of MODELS) {
      const text = body(model)
      for (const [, column] of text.matchAll(/^\s+(\w*(?:[cC]lientId|[eE]ntityId))\s+String/gm)) {
        if (!new RegExp(`fields:\\s*\\[[^\\]]*\\b${column}\\b`).test(text)) found.push(`${model}.${column}`)
      }
    }
    const listed = [...LINKS_SQL.matchAll(/\('(?:Client|BusinessEntity)', '(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}.${m[2]}`)
    expect(found.filter((c) => !listed.includes(c) && !NOT_LINKS.includes(c)).sort()).toEqual([])
    expect([...listed, ...NOT_LINKS].filter((c) => !found.includes(c))).toEqual([])
  })
})
