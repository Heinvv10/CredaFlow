/**
 * A throwaway Kenyan database with two lenders, each with one active loan, and
 * signed simulated callbacks for either, for the RUN_DB_IT mobile-money suites.
 * The breaker's repro cases (KE-4 review) run on it.
 */
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ingestMobileMoneyCallback, type MobileMoneyDb } from "./c2b-ingest"
import { signSimulatedCallback, simulatedMpesa } from "./providers/simulated"
import type { SignedCallback } from "./types"

export const IT_SECRET = "it-mpesa-secret"
export const PHONE = "254712345678"

export type FixtureLoan = Awaited<ReturnType<typeof createChargesLoan>> & { reference: string }

export interface MobileMoneyFixture {
  fresh: ThrowawayDb
  db: MobileMoneyDb
  A: FixtureLoan
  B: FixtureLoan
  /** Another loan, in A's lender. */
  loan: (opts?: { chargesOn?: boolean }) => Promise<FixtureLoan>
  /** A body signed for `tenantId`, as the simulated provider signs it. */
  signed: (tenantId: string, body: Record<string, unknown>) => SignedCallback
  deliver: (tenantId: string, signed: SignedCallback) => ReturnType<typeof ingestMobileMoneyCallback>
  paybill: (tenantId: string, transId: string, billRef: string, amount?: string) => SignedCallback
  payments: (loanId: string) => Promise<number>
}

export async function createMobileMoneyFixture(): Promise<MobileMoneyFixture> {
  const fresh = await createThrowawayDb({ instance: { jurisdiction: "KE", currency: "KES" } })
  const withReference = async (made: Awaited<ReturnType<typeof createChargesLoan>>): Promise<FixtureLoan> => ({
    ...made, reference: (await fresh.db.loan.findUniqueOrThrow({ where: { id: made.loanId } })).reference,
  })
  const A = await withReference(await createChargesLoan(fresh.db, await createChargesTenant(fresh.db, false)))
  const B = await withReference(await createChargesLoan(fresh.db, await createChargesTenant(fresh.db, false)))
  const db = fresh.db as unknown as MobileMoneyDb
  const signed = (tenantId: string, body: Record<string, unknown>): SignedCallback => {
    const rawBody = JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000)
    return { rawBody, headers: new Headers({ "x-simulated-timestamp": String(ts), "x-simulated-signature": signSimulatedCallback(rawBody, IT_SECRET, ts, tenantId) }) }
  }
  return {
    fresh, db, A, B, signed,
    loan: async (opts = {}) => withReference(await createChargesLoan(fresh.db,
      opts.chargesOn ? await createChargesTenant(fresh.db, true) : { tenantId: A.tenantId, userId: A.userId, productId: A.productId })),
    deliver: (tenantId, s) => {
      const callback = simulatedMpesa.parseCallback({ ...s, tenantId })
      if (!callback) throw new Error("the simulated callback did not verify")
      return ingestMobileMoneyCallback(db, { tenantId, provider: simulatedMpesa, callback })
    },
    paybill: (tenantId, transId, billRef, amount = "500.00") =>
      signed(tenantId, { type: "C2B", transId, billRef, amount, msisdn: PHONE, transTime: new Date().toISOString() }),
    payments: (loanId) => fresh.db.payment.count({ where: { loanId } }),
  }
}
