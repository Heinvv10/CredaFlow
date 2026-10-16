/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_COUNTERSIGN_AFTER_MANDATE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/countersign-after-mandate.integration.test.ts
 *
 * The portal lets the borrower sign the debit mandate as soon as they have
 * signed the agreement, before the provider countersigns. The signed-mandate
 * authority guard froze the countersignature columns too, so the provider could
 * then never countersign (HTTP 500 on the Fair Score audit, 2026-10-16). The
 * countersignature may now be recorded once, NULL to value, after the mandate;
 * everything else the guard freezes stays frozen.
 */
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { createApprovedPasqV3Application } from "@/lib/compliance/pasq-v3-application.integration-fixture"

const suite = process.env.RUN_COUNTERSIGN_AFTER_MANDATE_IT === "1" ? describe : describe.skip

const MANDATE_FROZEN = /Signed debit-mandate authority is immutable outside an explicit return to review/

/** Agreement and mandate signed by the borrower; no countersignature yet. */
async function signedBeforeCountersign(label: string) {
  const scenario = await createApprovedPasqV3Application(
    label, "ACCEPTED", true, "DEFERRED", false, null, {}, "DEBIT_ORDER", true, true,
  )
  const row = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: scenario.applicationId, tenantId: scenario.tenantId },
    select: { agreementSignedAt: true, debitMandateSignedAt: true, agreementCountersignedAt: true },
  })
  expect(row.agreementSignedAt).not.toBeNull()
  expect(row.debitMandateSignedAt).not.toBeNull()
  expect(row.agreementCountersignedAt).toBeNull()
  return scenario
}

function update(
  scenario: { tenantId: string; applicationId: string },
  data: Parameters<typeof prisma.loanApplication.update>[0]["data"],
) {
  return prisma.loanApplication.update({
    where: { id: scenario.applicationId, tenantId: scenario.tenantId },
    data,
    select: { agreementCountersignedAt: true },
  })
}

suite("provider countersignature after the borrower signed the debit mandate", () => {
  it("records the countersignature once after the mandate is signed", async () => {
    const scenario = await signedBeforeCountersign("cs_after_mandate")
    const written = await update(scenario, scenario.countersign)
    expect(written.agreementCountersignedAt?.toISOString())
      .toBe(scenario.countersign.agreementCountersignedAt.toISOString())
  })

  it("refuses a second countersignature", async () => {
    const scenario = await signedBeforeCountersign("cs_twice")
    await update(scenario, scenario.countersign)
    await expect(update(scenario, {
      agreementCountersignedAt: new Date(scenario.countersign.agreementCountersignedAt.getTime() + 60_000),
    })).rejects.toThrow(/immutable/)
    await expect(update(scenario, {
      agreementCountersignedByName: "Someone Else",
    })).rejects.toThrow(/immutable/)
  })

  it("still refuses a change to the signed mandate, before and after the countersignature", async () => {
    const scenario = await signedBeforeCountersign("cs_mandate_tamper")
    await expect(update(scenario, { debitMandateSignedByIp: "198.51.100.7" })).rejects.toThrow(MANDATE_FROZEN)
    await update(scenario, scenario.countersign)
    await expect(update(scenario, { debitMandateSignedByIp: "198.51.100.7" })).rejects.toThrow(MANDATE_FROZEN)
  })

  it("refuses a countersignature written together with another frozen field", async () => {
    const scenario = await signedBeforeCountersign("cs_with_tamper")
    await expect(update(scenario, {
      ...scenario.countersign,
      decisionReason: "Rewritten alongside the countersignature",
    })).rejects.toThrow(MANDATE_FROZEN)
    await expect(update(scenario, {
      ...scenario.countersign,
      debitMandateSignatureData: "A different customer signature",
    })).rejects.toThrow()
  })
})
