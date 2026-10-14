/**
 * With TenantConfig.collectionsEngineEnabled off, every engine entry point
 * stops after reading the flag: no other table is read or written and no
 * provider is called. A recording prisma double fails the test on any other
 * access, so "dark" is proven rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { calls, responses } = vi.hoisted(() => ({
  calls: [] as { op: string; args: unknown }[],
  responses: new Map<string, unknown>(),
}))

vi.mock("@/lib/prisma", () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, op) => async (args: unknown) => {
      calls.push({ op: `${name}.${String(op)}`, args })
      return responses.get(`${name}.${String(op)}`) ?? null
    },
  })
  return { prisma: new Proxy({}, { get: (_t, name) => model(String(name)) }) }
})

const providerCalls = vi.hoisted(() => [] as string[])
vi.mock("@/lib/integrations/collections/registry", () => ({
  getCollectionProvider: () => new Proxy({}, { get: (_t, m) => { providerCalls.push(String(m)); return async () => null } }),
}))

import { runCollectionsCron } from "./cron"
import { loadEngineContext } from "./context"
import { cancelDebitMandate, createDebitMandate } from "./mandates"
import { loadBatchList, loadLoanCollectionsView } from "./view.server"
import { LoanCollectionsPanel } from "@/components/collections-engine/LoanCollectionsPanel"

const ops = () => calls.map((c) => c.op)
const actor = { userId: "u1", userEmail: "staff@example.test" }
const loan = { id: "loan-1", applicationId: "app-1", status: "ACTIVE", clientId: "c1", client: { salaryPaymentDay: 25 } }

beforeEach(() => {
  calls.length = 0
  providerCalls.length = 0
  responses.clear()
  responses.set("tenantConfig.findMany", [])
  responses.set("tenantConfig.findUnique", { collectionsEngineEnabled: false, collectionProvider: "simulated" })
})

describe("collections engine with the flag off", () => {
  it.each(["SUBMIT", "RESULTS"] as const)("the %s cron reads only the enabled-tenant list", async (kind) => {
    const run = await runCollectionsCron(kind, new Date("2026-10-20T06:00:00Z"))
    expect(run).toEqual({ ok: true, kind, perTenant: [] })
    expect(ops()).toEqual(["tenantConfig.findMany"])
    expect(calls[0].args).toMatchObject({ where: { collectionsEngineEnabled: true, collectionProvider: { not: null } } })
    expect(providerCalls).toEqual([])
  })

  it("has no engine context, also when enabled without a provider", async () => {
    expect(await loadEngineContext("t1", new Date())).toBeNull()
    responses.set("tenantConfig.findUnique", { collectionsEngineEnabled: true, collectionProvider: null })
    expect(await loadEngineContext("t1", new Date())).toBeNull()
    expect(ops()).toEqual(["tenantConfig.findUnique", "tenantConfig.findUnique"])
  })

  it("refuses to create or cancel a mandate before touching the loan or the provider", async () => {
    await expect(createDebitMandate("t1", actor, { loanId: "loan-1", authType: "TT1", debitDay: 25, trackingDays: 3 }))
      .rejects.toMatchObject({ name: "MandateError", code: "FLAG_OFF" })
    await expect(cancelDebitMandate("t1", actor, "m1", "client asked"))
      .rejects.toMatchObject({ name: "MandateError", code: "FLAG_OFF" })
    expect(ops()).toEqual(["tenantConfig.findUnique", "tenantConfig.findUnique"])
    expect(providerCalls).toEqual([])
  })

  it("gives the UI nothing to render, so the loan page is unchanged", async () => {
    expect(await loadLoanCollectionsView("t1", loan)).toBeNull()
    expect(await loadBatchList("t1")).toBeNull()
    expect(await LoanCollectionsPanel({ tenantId: "t1", loan, canManage: true })).toBeNull()
    expect(ops()).toEqual(["tenantConfig.findUnique", "tenantConfig.findUnique", "tenantConfig.findUnique"])
  })

  it("does render once the flag is on (the double above is not vacuous)", async () => {
    responses.set("tenantConfig.findUnique", { collectionsEngineEnabled: true, collectionProvider: "simulated" })
    responses.set("debitMandate.findMany", [])
    const view = await loadLoanCollectionsView("t1", { ...loan, clientId: null, client: null })
    expect(view).toMatchObject({ provider: "simulated", mandates: [], liveMandate: null, canCreate: false })
    expect(ops()).toEqual(["tenantConfig.findUnique", "debitMandate.findMany"])
  })
})
