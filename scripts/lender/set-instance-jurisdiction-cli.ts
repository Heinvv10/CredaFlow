/**
 * npm run lender:set-jurisdiction -- --jurisdiction LS --currency LSL --reason "<why>"
 *
 * Sets the jurisdiction and currency this instance (this database) serves, the
 * one every lender on it must share. An operator action, audited, and refused
 * once any loan application or loan exists. Run it BEFORE onboarding lenders:
 * it also moves existing lender configs to the new value. Reads DATABASE_URL.
 * Exit 0 done, 2 refused, 1 any other failure.
 */
import { PrismaClient } from "@prisma/client"
import { parseArgs } from "node:util"
import { operatorId } from "./operator"
import { setInstanceJurisdiction } from "@/lib/jurisdiction/instance-write"

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { jurisdiction: { type: "string" }, currency: { type: "string" }, reason: { type: "string" } },
    strict: true,
  })
  if (!values.jurisdiction || !values.currency || !values.reason) {
    process.stderr.write('usage: lender:set-jurisdiction --jurisdiction ZA|LS --currency ZAR|LSL --reason "<why>"\n')
    return 1
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write("DATABASE_URL is not set.\n")
    return 1
  }
  const db = new PrismaClient()
  try {
    const result = await setInstanceJurisdiction(db, { jurisdiction: values.jurisdiction, currency: values.currency, reason: values.reason, actor: operatorId() })
    if (!result.ok) {
      process.stderr.write(`REFUSED: ${result.error}\n`)
      return 2
    }
    process.stdout.write(`instance jurisdiction: ${result.jurisdiction}/${result.currency}${result.changed ? " (changed)" : " (unchanged)"}\n`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`lender:set-jurisdiction failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  },
)
