/**
 * Helpers for the recovery end-to-end suite (RUN_ASSET_FINANCE_RECOVERY_IT):
 * the routes the other recovery fixtures do not cover (a cost decision, the
 * surrender request, the loan write-off), a loan booked for a given
 * settlement, the audit counter, and cleanup of the files the routes store.
 * Every value is synthetic. Not a test file.
 */
import { unlink } from "node:fs/promises"
import type { ContractType, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { POST as decideCostRoute } from "@/app/api/asset-finance/recoveries/[id]/costs/[costId]/decide/route"
import { POST as surrenderRequestRoute } from "@/app/api/asset-finance/loans/[loanId]/surrender/route"
import { PATCH as writeOffRoute } from "@/app/api/loans/[id]/write-off/route"
import type { DealFixture } from "./deal.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { recordFixtureCommercialCancellation, alignRecoveryFixtureSchedule, newLoan, type RecoveryLoan } from "./recovery.integration-fixture"
import { cleanupLegalFixture } from "./legal-matter.integration-fixture"
import { disburseApplication } from "./recovery-sale.integration-fixture"

export interface Answer { status: number; body: Record<string, unknown> }
export const answer = async (response: Response): Promise<Answer> => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })

export function e2eRoutes(host: string) {
  const req = (path: string, method: "POST" | "PATCH", body: unknown) => new NextRequest(`http://${host}${path}`, {
    method, headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return {
    requestSurrender: async (loanId: string, assetCondition: string) =>
      answer(await surrenderRequestRoute(req(`/api/asset-finance/loans/${loanId}/surrender`, "POST", { assetCondition }), { params: Promise.resolve({ loanId }) })),
    decideCost: async (id: string, costId: string, decision: "APPROVED" | "REJECTED") =>
      answer(await decideCostRoute(req(`/api/asset-finance/recoveries/${id}/costs/${costId}/decide`, "POST", { decision }), { params: Promise.resolve({ id, costId }) })),
    writeOff: async (loanId: string, body: { action: "request" | "approve" | "reject"; reason?: string; confirm?: boolean }) =>
      answer(await writeOffRoute(req(`/api/loans/${loanId}/write-off`, "PATCH", body), { params: Promise.resolve({ id: loanId }) })),
  }
}

/** An asset-finance loan whose settlement is exactly `settlementCents` (no schedule, no interest) and whose unpaid cash price is R1 000 000. */
export async function bookE2eLoan(
  db: PrismaClient, fx: DealFixture, regime: "NCA" | "NON_NCA", settlementCents: number, contractType: ContractType = "INSTALMENT_SALE",
): Promise<RecoveryLoan> {
  const loan = await newLoan(db, fx, regime, contractType)
  await testSetup(db, [`UPDATE "Loan" SET "principal" = $1, "totalInterest" = 0, "totalRepayable" = $1, "outstandingPrincipal" = 100000000 WHERE "id" = $2`, settlementCents, loan.loanId])
  await disburseApplication(db, fx, loan)
  await alignRecoveryFixtureSchedule(db, loan.loanId)
  await recordFixtureCommercialCancellation(db, fx, loan.loanId)
  return loan
}

/** How many audit rows of this action the lender has; a write adds exactly its own. */
export const auditCount = (db: PrismaClient, tenantId: string, action: string) => db.auditLog.count({ where: { tenantId, action } })

/** Removes the files the routes stored (notices, evidence, refund bank letters), then the rows. */
export async function cleanupE2e(db: PrismaClient, tenantId: string): Promise<void> {
  const [recoveries, surrenders, documents] = await Promise.all([
    db.recovery.findMany({ where: { tenantId }, select: { valuationNoticePath: true, finalNoticePath: true } }),
    db.surrenderRequest.findMany({ where: { tenantId }, select: { valuationNoticePath: true, finalNoticePath: true } }),
    db.entityDocument.findMany({ where: { tenantId }, select: { storagePath: true } }),
  ])
  const paths = [...recoveries, ...surrenders].flatMap((row) => [row.valuationNoticePath, row.finalNoticePath]).concat(documents.map((d) => d.storagePath))
  await Promise.all(paths.filter((path): path is string => !!path && path.startsWith(process.cwd())).map((path) => unlink(path).catch(() => undefined)))
  await cleanupLegalFixture(db, tenantId)
}
