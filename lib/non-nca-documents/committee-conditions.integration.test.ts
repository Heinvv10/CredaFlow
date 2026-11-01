/**
 * F9 on the KEY_FACTS path: in a Lesotho instance the database refuses the signature and the payout over an open committee condition
 * (real Postgres, its own throwaway database: the jurisdiction is a fact of the instance). Run with RUN_DB_IT=1.
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createApprovedApplication, disburse, issueBoth, signData, type KeyFactsFixture } from "./gate.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const OPEN = /conditions must all be cleared/
const CONDITION = "Obtain a signed employer letter before disbursement"

suite("committee conditions on a KEY_FACTS application (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  /** An approved case carrying one condition. Under a matrix this is written by lib/approval/chain.ts; the rule reads only what it leaves. */
  async function approvedCaseWithCondition(fx: KeyFactsFixture) {
    const { tenantId } = fx.tenant
    const approver = (await db().user.findFirstOrThrow({ where: { tenantId, role: { in: ["ADMIN", "SUPER_ADMIN", "LOAN_ADMIN"] } }, select: { id: true } })).id
    const caseId = `case-${randomUUID()}`
    await db().approvalCase.create({ data: { id: caseId, tenantId, applicationId: fx.applicationId, requiredLevels: 1, levelsSnapshot: [{ level: 1, name: "Level 1", role: "LOAN_ADMIN", slaHours: 24, committee: false }] } })
    await db().approvalStep.create({ data: { tenantId, caseId, applicationId: fx.applicationId, level: 1, approverId: approver, via: "ROLE", conditions: [CONDITION] } })
    await db().approvalCase.update({ where: { id: caseId }, data: { status: "APPROVED", completedAt: new Date() } })
    return { caseId, approver }
  }

  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }) }, 240_000)
  afterAll(() => fresh?.drop())

  it("an open condition refuses the borrower's signature; its clearance lets the signature through", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    const { caseId, approver } = await approvedCaseWithCondition(fx)
    const sign = () => db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    await expect(sign()).rejects.toThrow(OPEN)
    await db().approvalConditionClearance.create({ data: { tenantId: fx.tenant.tenantId, caseId, applicationId: fx.applicationId, conditionIndex: 0, condition: CONDITION, note: "Letter on file", clearedById: approver } })
    await sign()
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })).agreementSignedAt).not.toBeNull()
  })

  it("an open condition refuses the payout of a signed key-facts application", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    await approvedCaseWithCondition(fx)
    await expect(disburse(db(), fx)).rejects.toThrow(OPEN)
  })
})
