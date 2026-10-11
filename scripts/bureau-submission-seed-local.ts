/**
 * LOCAL-ONLY demo book for the bureau data submission feature.
 *
 * `prisma/seed.ts` seeds the tenant, staff and clients; this adds a small,
 * synthetic loan book that exercises every path of lib/bureau-submission —
 * performing, in arrears, settled early, written off awaiting confirmation,
 * an invalid ID number (held), PO funding (excluded), and a loan opened and a
 * loan closed on the last day of the month (the daily file).
 *
 * REFUSES to run unless DATABASE_URL points at localhost, NODE_ENV is not
 * production, and --i-am-local is passed: a local hostname alone is also true
 * of a tunnel, or of running on a shared or production box. Every person
 * here is invented; the ID numbers are generated.
 *
 *   npx tsx scripts/bureau-submission-seed-local.ts --i-am-local [--month-end YYYY-MM-DD]
 */
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  INSTALMENT,
  createBureauLoan,
  invalidSaId,
  sast,
  type BureauTenant,
} from "@/lib/bureau-submission/bureau.integration-fixture"
import { isDay, isMonthEnd, previousMonthEnd } from "@/lib/bureau-submission/period"

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname
  } catch {
    return ""
  }
})()
if ((host !== "127.0.0.1" && host !== "localhost") || process.env.NODE_ENV === "production" || !process.argv.includes("--i-am-local")) {
  process.stderr.write("Refusing to seed: needs a localhost DATABASE_URL, a non-production NODE_ENV and --i-am-local.\n")
  process.exit(1)
}

/** `days` before the month end, as YYYY-MM-DD. */
function back(monthEnd: string, days: number): string {
  return new Date(new Date(`${monthEnd}T00:00:00.000Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--month-end")
  const monthEnd = index >= 0 ? process.argv[index + 1] : previousMonthEnd(new Date())
  if (!isDay(monthEnd) || !isMonthEnd(monthEnd)) throw new Error("--month-end must be a month end, YYYY-MM-DD")

  const db = new PrismaClient()
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "acme" } })
  const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "admin@acme-lending.example" } })
  const product = async (productType: "PERSONAL" | "MICRO" | "PO_FUNDING") =>
    (await db.loanProduct.findFirstOrThrow({ where: { tenantId: tenant.id, productType } })).id
  const t: BureauTenant = {
    tenantId: tenant.id,
    userId: admin.id,
    products: { PERSONAL: await product("PERSONAL"), MICRO: await product("MICRO"), PO_FUNDING: await product("PO_FUNDING") },
  }
  await db.tenantConfig.update({
    where: { tenantId: tenant.id },
    data: {
      featureBureauSubmission: true,
      bureauSupplierNumber: "TT0109", // Experian's own dummy supplier number
      bureauTradingName: "Acme Lending",
      bureauReportingStartDate: new Date(`${back(monthEnd, 120)}T00:00:00.000Z`),
    },
  })

  const pay = (loanId: string, amount: number, day: string) => runWithTenant(t.tenantId, () =>
    applyManualReceipt(prisma, { loanId, tenantId: t.tenantId, amount, receivedAt: sast(day), capturedById: t.userId }))
  const after = (days: number) => back(monthEnd, -days)

  const performing = await createBureauLoan(db, t, { lastName: "Performing", startDay: back(monthEnd, 45), dueDays: [back(monthEnd, 15), after(15)] })
  await pay(performing.loanId, INSTALMENT, back(monthEnd, 16))
  await createBureauLoan(db, t, { lastName: "Arrears", startDay: back(monthEnd, 110), dueDays: [back(monthEnd, 80), back(monthEnd, 50)] })
  await createBureauLoan(db, t, { lastName: "Micro", productType: "MICRO", startDay: back(monthEnd, 10), dueDays: [after(5), after(20)] })
  const settled = await createBureauLoan(db, t, { lastName: "Settled", startDay: back(monthEnd, 60), dueDays: [back(monthEnd, 29), after(1)] })
  await pay(settled.loanId, 2 * INSTALMENT, back(monthEnd, 20))
  await createBureauLoan(db, t, { lastName: "Badid", idNumber: invalidSaId(), startDay: back(monthEnd, 40), dueDays: [back(monthEnd, 10), after(20)] })
  const writtenOff = await createBureauLoan(db, t, { lastName: "Writeoff", startDay: back(monthEnd, 115), dueDays: [back(monthEnd, 100), back(monthEnd, 70)] })
  await db.loan.update({ where: { id: writtenOff.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast(back(monthEnd, 18)) } })
  await createBureauLoan(db, t, { lastName: "Pofunding", productType: "PO_FUNDING", startDay: back(monthEnd, 30), dueDays: [after(1), after(30)] })
  await createBureauLoan(db, t, { lastName: "Openedlastday", startDay: monthEnd, dueDays: [after(30), after(60)] })
  const closedLastDay = await createBureauLoan(db, t, { lastName: "Closedlastday", startDay: back(monthEnd, 41), dueDays: [back(monthEnd, 10), after(20)] })
  await pay(closedLastDay.loanId, 2 * INSTALMENT, monthEnd)

  process.stdout.write(`${JSON.stringify({ seeded: 9, tenantId: tenant.id, monthEnd })}\n`)
  await db.$disconnect()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
