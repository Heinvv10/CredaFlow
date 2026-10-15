/**
 * Shared pieces of the collections-engine integration suites.
 *
 * - createFixture: a synthetic lender with one active FLAT 0% loan, so every
 *   receipt allocates whole. Instalment cents drive the simulated rail
 *   (simulated-scenarios.ts: 01 = NPF). All values synthetic; ids are random
 *   per call so suites share one database without colliding.
 * - flaky: a rail registered as "it-flaky" that behaves like the simulator
 *   but whose collect / createMandate / findInstruction a test can script.
 * - run: one tenant's cron run at a fake instant (cron.ts runTenant).
 */
import { randomInt, randomUUID } from "node:crypto"
import { vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { registerProvider } from "@/lib/integrations/collections/registry"
import { simulatedCollections } from "@/lib/integrations/collections/simulated"
import type { CollectionOutcome, CollectionProvider, InstructionLookup, MandateStatusValue } from "@/lib/integrations/collections/types"
import { runWithTenant } from "@/lib/tenant-scope"
import { runTenant, type CollectionsCronKind, type TenantCollectionsRun } from "./cron"
import { dateOnly, loadEngineContext, type EngineContext } from "./context"
import { createDebitMandate } from "./mandates"
import { refreshMandates } from "./mandate-lifecycle"
import type { CollectionInstructionStatus } from "@prisma/client"

export interface Fixture {
  tenantId: string
  userId: string
  loanId: string
  rows: { id: string; installmentNo: number }[]
}

export const INSTALMENT_1 = 100_000
export const INSTALMENT_2 = 100_001

/** What a test scripts on the "it-flaky" rail; reset with resetFlaky(). */
export const flaky = {
  collectError: null as Error | null,
  createMandateError: null as Error | null,
  findInstruction: null as ((ref: string) => InstructionLookup) | null,
  /** Answer createMandate synchronously with a provider reference (a real-time rail). */
  syncRef: false,
  /** Runs after the provider accepted the mandate, before createMandate returns: a staff cancel racing the call. */
  beforeCreateReturn: null as (() => Promise<void>) | null,
  /** The rail cannot look a mandate up by our reference. */
  noFindMandate: false,
  /** The rail never registers what it was sent. */
  registerNever: false,
  /** Load reports reject every instruction with this error. */
  rejectAll: null as string | null,
  /** Replace fetchResults' answer. */
  outcomes: null as CollectionOutcome[] | null,
  /** The load report leaves out the first instruction of the batch. */
  omitFromLoadReport: false,
  /** getMandateStatus answers this instead of the scripted outcome. */
  mandateStatus: null as MandateStatusValue | null,
  /** findMandate reports the mandate registered but gives no reference. */
  registeredWithoutRef: false,
  calls: { collect: [] as string[][], createMandate: 0, cancelMandate: [] as string[] },
}

export function resetFlaky(): void {
  flaky.collectError = null
  flaky.createMandateError = null
  flaky.findInstruction = null
  flaky.syncRef = false
  flaky.beforeCreateReturn = null
  flaky.noFindMandate = false
  flaky.registerNever = false
  flaky.rejectAll = null
  flaky.outcomes = null
  flaky.omitFromLoadReport = false
  flaky.mandateStatus = null
  flaky.registeredWithoutRef = false
  flaky.calls = { collect: [], createMandate: 0, cancelMandate: [] }
}

const flakyRail: CollectionProvider = {
  ...simulatedCollections,
  id: "it-flaky",
  async createMandate(req, creds) {
    flaky.calls.createMandate++
    // Yield so two concurrent submitters genuinely overlap.
    await new Promise((resolve) => setImmediate(resolve))
    if (flaky.createMandateError) throw flaky.createMandateError
    let handle = await simulatedCollections.createMandate(req, creds)
    if (flaky.syncRef) {
      const registered = await simulatedCollections.findMandate!(req.mandateReference, creds)
      handle = { ...registered!, status: "PENDING_AUTH" }
    }
    if (flaky.beforeCreateReturn) await flaky.beforeCreateReturn()
    return handle
  },
  async cancelMandate(ref, creds) {
    flaky.calls.cancelMandate.push(ref)
    return simulatedCollections.cancelMandate(ref, creds)
  },
  async getBatchLoadReport(batch, creds) {
    if (flaky.rejectAll) return { state: "LOADED", accepted: [], rejected: batch.instructionRefs.map((instructionRef) => ({ instructionRef, error: flaky.rejectAll! })) }
    const report = await simulatedCollections.getBatchLoadReport!(batch, creds)
    if (flaky.omitFromLoadReport && report.state === "LOADED") {
      const [, ...rest] = [...batch.instructionRefs].sort()
      return { state: "LOADED", accepted: rest, rejected: [] }
    }
    return report
  },
  async getMandateStatus(ref, creds) {
    return flaky.mandateStatus ?? simulatedCollections.getMandateStatus(ref, creds)
  },
  async fetchResults(window, creds) {
    return flaky.outcomes ?? simulatedCollections.fetchResults(window, creds)
  },
  async collect(batch, creds) {
    flaky.calls.collect.push(batch.map((i) => i.instructionRef))
    if (flaky.collectError) throw flaky.collectError
    return simulatedCollections.collect(batch, creds)
  },
}
Object.defineProperty(flakyRail, "findMandate", {
  enumerable: true,
  get: () => (flaky.noFindMandate ? undefined
    : async (ref: string, creds: Record<string, string>) => {
      if (flaky.registerNever) return null
      const found = await simulatedCollections.findMandate!(ref, creds)
      return found && flaky.registeredWithoutRef ? { ...found, providerMandateRef: null } : found
    }),
})
Object.defineProperty(flakyRail, "findInstruction", {
  enumerable: true,
  get: () => (flaky.findInstruction ? async (ref: string) => flaky.findInstruction!(ref) : undefined),
})
registerProvider(flakyRail)

export async function createFixture(opts: { provider?: string; instalments?: number[]; dueDates?: string[] } = {}): Promise<Fixture> {
  // Random, not clock-based: the suites run under a fake Date.
  const run = randomUUID().replace(/-/g, "").slice(0, 12)
  const tenantId = `t_ce_${run}`
  const userId = `u_ce_${run}`
  const clientId = `c_ce_${run}`
  const productId = `p_ce_${run}`
  const appId = `a_ce_${run}`
  const loanId = `l_ce_${run}`
  const instalments = opts.instalments ?? [INSTALMENT_1, INSTALMENT_2]
  const total = instalments.reduce((a, b) => a + b, 0)
  const dueDates = opts.dueDates ?? instalments.map((_, i) => `2026-${String(10 + i).padStart(2, "0")}-25`.replace("2026-13", "2027-01"))

  await prisma.tenant.create({ data: { id: tenantId, slug: `ce-it-${run}`, name: "Collections IT Lender" } })
  await prisma.tenantConfig.create({ data: { tenantId, collectionsEngineEnabled: true, collectionProvider: opts.provider ?? "simulated" } })
  await prisma.user.create({
    data: { id: userId, tenantId, email: `ce-admin-${run}@test.invalid`, name: "CE Admin", password: "not-a-real-login-hash", role: "LOAN_ADMIN" },
  })
  await prisma.client.create({
    data: {
      id: clientId, tenantId, idNumber: `9001${String(randomInt(1e9)).padStart(9, "0")}`, firstName: "Synthetic", lastName: "Debtor",
      email: `ce-client-${run}@test.invalid`, phone: "0820000000", bankName: "Test Bank", bankBranchCode: "250655",
      bankAccountNumber: "62000000001", accountType: "CHEQUE", salaryPaymentDay: 25,
    },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId, tenantId, code: `CE${run}`.slice(0, 20), name: "CE Product", productType: "PERSONAL",
      minAmount: 1000, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
    },
  })
  await prisma.loanApplication.create({
    data: { id: appId, tenantId, reference: `CE-APP-${run}`, clientId, productId, appliedAmount: total, appliedTermDays: 90 },
  })
  await prisma.loan.create({
    data: {
      id: loanId, tenantId, reference: `CE-LN-${run}`, applicationId: appId, clientId, productId,
      principal: total, totalInterest: 0, initiationFee: 0, totalRepayable: total, outstandingPrincipal: total,
      startDate: new Date("2026-09-01T10:00:00Z"), maturityDate: new Date(`${dueDates.at(-1)}T10:00:00Z`),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 0,
    },
  })
  const rows: Fixture["rows"] = []
  for (const [i, amount] of instalments.entries()) {
    const id = `s${i + 1}_ce_${run}`
    await prisma.repaymentSchedule.create({
      data: {
        id, tenantId, loanId, installmentNo: i + 1, dueDate: new Date(`${dueDates[i]}T10:00:00Z`),
        principalDue: amount, interestDue: 0, feesDue: 0, totalDue: amount,
      },
    })
    rows.push({ id, installmentNo: i + 1 })
  }
  return { tenantId, userId, loanId, rows }
}

export const at = (iso: string) => vi.setSystemTime(new Date(iso))

/** Inside the tenant's frame, as the cron route and the API routes run the engine. */
export const inTenant = <T>(fx: Fixture, fn: () => Promise<T>): Promise<T> => runWithTenant(fx.tenantId, fn)

export async function run(fx: Fixture, kind: CollectionsCronKind): Promise<TenantCollectionsRun> {
  return inTenant(fx, () => runTenant(kind, fx.tenantId, new Date()))
}

export async function ctxOf(fx: Fixture): Promise<EngineContext> {
  return (await loadEngineContext(fx.tenantId, new Date()))!
}

export const instructionsOf = (fx: Fixture) => prisma.collectionInstruction.findMany({
  where: { tenantId: fx.tenantId }, orderBy: [{ actionDate: "asc" }, { installmentNo: "asc" }, { presentmentNo: "asc" }],
})
export const paymentsOf = (fx: Fixture) => prisma.payment.findMany({ where: { tenantId: fx.tenantId, loanId: fx.loanId } })
export const day = (d: Date) => d.toISOString().slice(0, 10)

/** A mandate created by staff and authorised, with nothing planned yet. */
export async function activeMandate(fx: Fixture): Promise<string> {
  const m = await inTenant(fx, () => createDebitMandate(fx.tenantId, { userId: fx.userId, userEmail: "ce-admin@test.invalid" }, {
    loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3, maxAmountCents: 150_000,
  }, new Date()))
  await inTenant(fx, async () => refreshMandates(await ctxOf(fx)))
  return m.id
}

/** An instruction written directly, as a run that crashed half-way would have left it. */
export async function insertInstruction(fx: Fixture, mandateId: string, o: {
  row: number; presentmentNo?: number; status?: CollectionInstructionStatus; actionDate: string; amountCents: number
}) {
  const r = fx.rows[o.row - 1]
  return prisma.collectionInstruction.create({
    data: {
      tenantId: fx.tenantId, mandateId, loanId: fx.loanId, repaymentScheduleId: r.id, installmentNo: r.installmentNo,
      presentmentNo: o.presentmentNo ?? 1, amountCents: o.amountCents, actionDate: dateOnly(o.actionDate), trackingDays: 3,
      instructionRef: `CI${randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase()}`, status: o.status ?? "PENDING",
    },
  })
}
