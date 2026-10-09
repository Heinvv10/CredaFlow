import { describe, expect, it } from "vitest"
import { baselineIndexSql, readBaselineSql } from "../db-baseline.test-helpers"

const baseline = readBaselineSql()
const dispatchStateEnum = baseline.match(/^CREATE TYPE "MessageDispatchState" AS ENUM \([^;]*\);/m)?.[0] ?? ""
const messageTable = baseline.match(/^CREATE TABLE "Message" \([\s\S]*?^\);/m)?.[0] ?? ""

describe("message dispatch-control schema", () => {
  it("has explicit attempt, lease, provider-evidence, and reconciliation fields", () => {
    expect(dispatchStateEnum).not.toBe("")
    for (const state of [
      "DISPATCHING",
      "ACCEPTED",
      "SIMULATED",
      "DEFINITELY_REJECTED",
      "AMBIGUOUS",
      "RECONCILED_SENT",
      "RECONCILED_SIMULATED",
      "RECONCILED_NOT_SENT",
    ]) {
      expect(dispatchStateEnum).toContain(`'${state}'`)
    }
    expect(messageTable).not.toBe("")
    for (const column of [
      "idempotencyKey",
      "dispatchToken",
      "dispatchState",
      "dispatchAttempt",
      "dispatchStartedAt",
      "dispatchLeaseExpiresAt",
      "dispatchCompletedAt",
      "dispatchProviderMessageId",
      "dispatchProviderAcceptedAt",
      "dispatchEvidenceReference",
    ]) {
      expect(messageTable).toContain(`"${column}" `)
    }
  })

  it("enforces one business reservation per tenant and one globally unique attempt token", () => {
    expect(baselineIndexSql("Message_dispatchToken_key")).toBe(
      'CREATE UNIQUE INDEX "Message_dispatchToken_key" ON "Message"("dispatchToken");',
    )
    expect(baselineIndexSql("Message_tenantId_idempotencyKey_key")).toBe(
      'CREATE UNIQUE INDEX "Message_tenantId_idempotencyKey_key" ON "Message"("tenantId", "idempotencyKey");',
    )
  })
})
