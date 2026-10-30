/**
 * npm run lender:set-exit-date -- --tenant <slug> --loan <reference> --date <yyyy-mm-dd> --reason "<why>"
 *
 * Fills the missing closed / written-off date of a loan the IFRS 9 close refused (IFRS9_EXIT_UNDATED). Reads DATABASE_URL.
 * Exit 0 done, 2 refused by a guard, 1 any other failure.
 */
import { PrismaClient } from "@prisma/client"
import { parseArgs } from "node:util"
import { operatorId } from "./operator"
import { ExitDateRefusal, setLoanExitDate } from "./set-exit-date"

const USAGE = 'usage: lender:set-exit-date --tenant <slug> --loan <reference> --date <yyyy-mm-dd> --reason "<why>"'

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { tenant: { type: "string" }, loan: { type: "string" }, date: { type: "string" }, reason: { type: "string" } }, strict: true })
  if (!values.tenant || !values.loan || !values.date || !values.reason) {
    process.stderr.write(`${USAGE}\n`)
    return 1
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write("DATABASE_URL is not set.\n")
    return 1
  }
  const db = new PrismaClient()
  try {
    const r = await setLoanExitDate(db, { tenantSlug: values.tenant, loanReference: values.loan, date: values.date, reason: values.reason, operator: operatorId() })
    process.stdout.write(`${values.loan}: ${r.field} set to ${r.date}. Close the month again.\n`)
    return 0
  } catch (e) {
    if (e instanceof ExitDateRefusal) {
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
    process.stderr.write(`lender:set-exit-date failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  },
)
