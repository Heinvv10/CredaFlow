/**
 * npm run lender:bootstrap-admin -- --tenant <slug> --email <email> [--name <name>] [--dry-run]
 * npm run lender:bootstrap-admin -- --tenant <slug> --email <email> --break-glass [--dry-run]
 *
 * Reads DATABASE_URL. Prints the one-time password and TOTP secret to stdout
 * exactly once and nowhere else; a caller must not capture stdout into a log.
 * Exit 0 done, 2 refused by a guard, 1 any other failure.
 */
import { PrismaClient } from "@prisma/client"
import { parseArgs } from "node:util"
import { operatorId } from "./operator"
import { bootstrapSuperAdmin, BootstrapRefusal, type AdminBootstrapResult } from "./bootstrap-admin"

const USAGE = "usage: lender:bootstrap-admin --tenant <slug> --email <email> [--name <name>] [--break-glass] [--dry-run]"

function render(r: AdminBootstrapResult, tenantSlug: string): string {
  if (r.kind === "dry-run") return `dry-run: would ${r.action === "create" ? "create the first SUPER_ADMIN" : "break-glass reset the SUPER_ADMIN"} ${r.email} in tenant "${tenantSlug}". Nothing written.`
  return [
    `SUPER_ADMIN ${r.kind === "created" ? "created" : "reset (break-glass)"} for tenant "${tenantSlug}".`,
    `  email:                ${r.email}`,
    `  one-time password:    ${r.password}`,
    `  TOTP secret (base32): ${r.totpSecret}`,
    `  otpauth URI:          ${r.otpauthUri}`,
    "Shown once, never stored in clear and not recoverable. Enrol the TOTP secret in an authenticator, sign in, then change the password.",
  ].join("\n")
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" }, email: { type: "string" }, name: { type: "string" },
      "break-glass": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  })
  if (!values.tenant || !values.email) {
    process.stderr.write(`${USAGE}\n`)
    return 1
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write("DATABASE_URL is not set.\n")
    return 1
  }
  const db = new PrismaClient()
  try {
    const result = await bootstrapSuperAdmin(db, {
      tenantSlug: values.tenant, email: values.email, name: values.name,
      mode: values["break-glass"] ? "break-glass" : "bootstrap", dryRun: values["dry-run"],
      operator: operatorId(),
    })
    process.stdout.write(`${render(result, values.tenant)}\n`)
    return 0
  } catch (e) {
    if (e instanceof BootstrapRefusal) {
      process.stderr.write(`REFUSED (${e.code}): ${e.message}\n`)
      return 2
    }
    throw e
  } finally {
    await db.$disconnect()
  }
}

// Explicit exit: importing lib/audit pulls in lib/prisma, whose production keep-alive timer would hold the process open.
main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`lender:bootstrap-admin failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  },
)
