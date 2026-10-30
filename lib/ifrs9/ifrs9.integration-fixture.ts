/** Shared harness for the IFRS 9 integration suites (RUN_IFRS9_IT). Not a test file. */
import { PrismaClient } from "@prisma/client"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { executeRun } from "./run"
import { replaceParameters, saveSettings } from "./store"
import { DEFAULT_SETTINGS, type EclParameter, type Ifrs9Settings } from "./types"

export const RUN = process.env.RUN_IFRS9_IT === "1"
export const db = new PrismaClient()
export const actorOf = (t: ChargesTenant) => ({ id: t.userId, email: "ifrs9-it@test.invalid" })
export const at = (iso: string) => new Date(`${iso}T12:00:00+02:00`)
/** The month-end job's moment: ten minutes to midnight on the month's last day. */
export const monthEnd = (iso: string) => new Date(`${iso}T23:50:00+02:00`)
export const ymd = (d: Date) => d.toISOString().slice(0, 10)

export const PARAMETERS: EclParameter[] = [
  { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 },
  { scopeKey: "DEFAULT", stage: 2, pdBps: 1500, lgdBps: 5000 },
  { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
]

export type Lender = ChargesTenant & { loanId: string }

export async function lender(): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  const loan = await createChargesLoan(db, tenant)
  // R2 000 over two instalments: R1 000 + R100 interest + R69 fees due 1 Sep 2026, R1 000 + R50 interest due 1 Dec 2027.
  await db.repaymentSchedule.updateMany({ where: { loanId: loan.loanId }, data: { principalDue: 100_000, interestDue: 10_000, feesDue: 6_900, totalDue: 116_900 } })
  await db.repaymentSchedule.create({
    data: { tenantId: tenant.tenantId, loanId: loan.loanId, installmentNo: 2, dueDate: new Date("2027-12-01T10:00:00+02:00"), principalDue: 100_000, interestDue: 5_000, feesDue: 0, totalDue: 105_000 },
  })
  return { ...tenant, loanId: loan.loanId }
}

export const asTenant = <T>(t: ChargesTenant, fn: () => Promise<T>) => runWithTenant(t.tenantId, fn)
export const configure = (t: ChargesTenant, over: Partial<Ifrs9Settings> = {}) =>
  asTenant(t, async () => {
    await saveSettings(prisma, t.tenantId, { ...DEFAULT_SETTINGS, enabled: true, ...over }, actorOf(t))
    await replaceParameters(prisma, t.tenantId, PARAMETERS, actorOf(t))
  })
export const monthly = (t: ChargesTenant, periodKey: string, now: Date, extra: { supersede?: { runId: string; reason: string }; lateReason?: string } = {}) =>
  asTenant(t, () => executeRun(t.tenantId, { kind: "MONTHLY", periodKey, now, actor: actorOf(t), ...extra }))
export const onDemand = (t: ChargesTenant, now: Date) => asTenant(t, () => executeRun(t.tenantId, { kind: "ON_DEMAND", now, actor: actorOf(t) }))
export const snapshotOf = (runId: string, loanId: string) => db.ifrs9LoanSnapshot.findUniqueOrThrow({ where: { runId_loanId: { runId, loanId } } })
