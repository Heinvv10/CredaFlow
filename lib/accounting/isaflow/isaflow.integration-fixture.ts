/**
 * Real-Postgres fixture for the IsaFlow push ITs: a lender with a consumer
 * loan, every role mapped (stored) to its default code, and months closed one
 * by one, each with a fresh loan so it has lines to push. The fake IsaFlow's
 * chart carries every default code, active.
 */
import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { ACCOUNT_ROLES, DEFAULT_ACCOUNTS } from "../accounts"
import { closePeriod } from "../generate"
import { probeIsaFlow, saveIsaFlowConnection } from "./connection"
import { FakeIsaFlow } from "./fake-isaflow.integration-fixture"

export const IT_KEY = randomBytes(32).toString("base64")
export const IT_TOKEN = "pat_isaflow_it_0123456789abcdef"

export function fakeWithDefaultChart(): FakeIsaFlow {
  const codes = [...new Set(ACCOUNT_ROLES.map((r) => DEFAULT_ACCOUNTS[r].code))]
  return new FakeIsaFlow({ tokens: { [IT_TOKEN]: ["write:journals", "read:reports"] }, accounts: codes.map((code) => ({ code })) })
}

export async function isaflowTenant(db: PrismaClient): Promise<ChargesTenant & { email: string }> {
  const t = await createChargesTenant(db, false)
  await createChargesLoan(db, t)
  await db.accountingAccountMapping.createMany({
    data: ACCOUNT_ROLES.map((role) => ({ tenantId: t.tenantId, role, accountCode: DEFAULT_ACCOUNTS[role].code, accountName: DEFAULT_ACCOUNTS[role].name })),
  })
  await db.accountingSettings.create({ data: { tenantId: t.tenantId, goLiveMonth: "2026-08", mappingConfirmedAt: new Date() } })
  const user = await db.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } })
  return { ...t, email: user.email }
}

/** Closes `periodKey` after adding a loan, so the month has lines. Returns the batch id. */
export async function closeMonth(db: PrismaClient, t: ChargesTenant & { email: string }, periodKey: string, now: Date): Promise<string> {
  await createChargesLoan(db, t)
  const out = await runWithTenant(t.tenantId, () => closePeriod(prisma, { tenantId: t.tenantId, periodKey, userId: t.userId, userEmail: t.email, now }))
  return out.batchId
}

/** The connect route's two halves, as superAdminPolicyWrite runs them: probe IsaFlow, then store in a transaction. */
export async function connectTenant(t: ChargesTenant & { email: string }, fake: FakeIsaFlow, token = IT_TOKEN): Promise<void> {
  const probe = await probeIsaFlow({ baseUrl: fake.url, token })
  await prisma.$transaction((tx) => saveIsaFlowConnection(tx, { tenantId: t.tenantId, actor: { id: t.userId, email: t.email }, ip: null, probe, token }))
}
