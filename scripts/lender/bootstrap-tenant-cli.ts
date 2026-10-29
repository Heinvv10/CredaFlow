/**
 * npm run lender:bootstrap-tenant -- --config <lender.json> [--dry-run]
 *
 * Validates the file against the app's own identity and colour schemas, then
 * creates the Tenant + TenantConfig and the default document/message
 * templates. Reads DATABASE_URL. --dry-run validates and checks the database
 * but writes nothing.
 * Exit 0 done, 2 invalid file or refused by a guard, 1 any other failure.
 */
import { PrismaClient } from "@prisma/client"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { operatorId } from "./operator"
import { bootstrapTenant, TenantBootstrapRefusal } from "./bootstrap-tenant"
import { parseTenantConfig } from "./tenant-config"
import { loadActiveJurisdiction } from "@/lib/jurisdiction/load.server"

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, "dry-run": { type: "boolean", default: false } },
    strict: true,
  })
  if (!values.config) {
    process.stderr.write("usage: lender:bootstrap-tenant --config <lender.json> [--dry-run]\n")
    return 1
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(values.config, "utf8"))
  } catch (e) {
    process.stderr.write(`Cannot read ${values.config} as JSON: ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write("DATABASE_URL is not set.\n")
    return 1
  }
  // The file is validated under the instance's jurisdiction (Lesotho phones and
  // registration numbers differ from South African ones).
  const db = new PrismaClient()
  try {
    await loadActiveJurisdiction(db as never)
    const parsed = parseTenantConfig(raw)
    if (!parsed.ok) {
      process.stderr.write(`INVALID ${values.config}:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}\n`)
      return 2
    }
    const result = await bootstrapTenant(db, parsed.config, {
      dryRun: values["dry-run"],
      operator: operatorId(),
      seedTemplates: async (tenantId, brand) => {
        const { seedDocumentTemplates } = await import("../../prisma/seed-document-templates")
        const { seedDefaultMessageTemplates } = await import("@/lib/messaging/default-templates")
        await seedDocumentTemplates(tenantId)
        await seedDefaultMessageTemplates(db, tenantId, brand)
      },
    })
    process.stdout.write(`tenant "${parsed.config.slug}": ${result.status}${result.tenantId ? ` (id ${result.tenantId})` : ""}\n`)
    return 0
  } catch (e) {
    if (e instanceof TenantBootstrapRefusal) {
      process.stderr.write(`REFUSED (${e.code}): ${e.message}\n`)
      return 2
    }
    throw e
  } finally {
    await db.$disconnect()
  }
}

// Explicit exit: lib/prisma (pulled in by lib/audit) starts a keep-alive timer in production.
main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`lender:bootstrap-tenant failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  },
)
