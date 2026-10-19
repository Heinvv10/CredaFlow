/**
 * Cancellation evidence is scoped to the loan's own borrower (real migrated
 * Postgres, because a null id in a Prisma filter means "IS NULL", not "no
 * filter"): an individual lessee has no entity, so a filter on the loan's
 * entityId matched every deal-less staff LEGAL_DOCUMENT of every individual.
 *
 *   RUN_ASSET_FINANCE_CANCELLATION_EVIDENCE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/commercial-cancellation-evidence.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { borrowerDocumentWhere, cancellationEvidenceWhere } from "./borrower-document-scope"
import { recordCommercialCancellation } from "./commercial-cancellation"
import { testSetup } from "./lease-servicing.integration-fixture"
import { alignRecoveryFixtureSchedule, cleanupRecoveryFixture, createRecoveryFixture, newLoan, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_CANCELLATION_EVIDENCE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const d = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_CANCELLATION_EVIDENCE_IT=1 is required")
  return db
}

/** A fresh individual client (no entity). */
async function newIndividual(): Promise<string> {
  const token = randomUUID().replaceAll("-", "").slice(0, 10)
  return (await d().client.create({
    data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: `Individual${token}`, email: `individual-${token}@client.invalid`, phone: `0004${token.slice(0, 6)}`,
      idNumber: syntheticSaIdNumber(), popiaConsentGiven: true, addressLine1: "9 Synthetic Road", city: "Johannesburg", postalCode: "2001",
    },
  })).id
}

/** A NON_NCA instalment sale on a fresh company, booked with triggers off, ready to take a cancellation. */
async function entityLoan(): Promise<{ loanId: string; entityId: string }> {
  const loan = await newLoan(d(), fx, "NON_NCA")
  const { applicationId } = await d().loan.findUniqueOrThrow({ where: { id: loan.loanId }, select: { applicationId: true } })
  await testSetup(d(), [`UPDATE "LoanApplication" SET "status" = 'DISBURSED', "approvedAt" = CURRENT_TIMESTAMP, "approvedById" = $2,
    "disbursedAt" = CURRENT_TIMESTAMP, "repaymentMethod" = 'EFT' WHERE "id" = $1`, applicationId, fx.adminA])
  await alignRecoveryFixtureSchedule(d(), loan.loanId)
  return { loanId: loan.loanId, entityId: loan.entityId! }
}

const noDeal = { assetFinanceDeal: null }
const idsFor = async (loan: { entityId: string | null; clientId: string | null }) =>
  (await d().entityDocument.findMany({ where: cancellationEvidenceWhere(fx.tenantId, { ...loan, ...noDeal }), select: { id: true } })).map((r) => r.id)

/** A staff LEGAL_DOCUMENT filed on a borrower (one of entity or client), with no deal. */
const legalDocFor = async (borrower: { clientId: string } | { entityId: string }) => (await d().entityDocument.create({
  data: {
    tenantId: fx.tenantId, ...("clientId" in borrower ? { clientId: borrower.clientId } : { entityId: borrower.entityId }), dealId: null, docType: "LEGAL_DOCUMENT", fileName: `legal-${randomUUID().slice(0, 6)}.pdf`,
    mimeType: "application/pdf", fileSize: 1, storagePath: `/nonexistent/${randomUUID()}.pdf`, contentSha256: "0".repeat(64),
    uploadedByType: "staff", uploadedById: fx.officer,
  },
})).id

const record = (loanId: string, evidenceDocumentId: string) => runWithTenant(fx.tenantId, () => recordCommercialCancellation(
  { tenantId: fx.tenantId, userId: fx.adminA }, loanId,
  { cancelledOn: today(), evidenceDocumentId, basis: "TEST written termination effective on the recorded date", cancellationConfirmed: true },
))

suite.sequential("commercial cancellation evidence is the loan's own borrower's (real Postgres)", () => {
  beforeAll(async () => { fx = await createRecoveryFixture(d(), t) }, 120_000)
  afterAll(async () => {
    if (db) {
      await cleanupRecoveryFixture(db, fx.tenantId)
      await db.$disconnect()
    }
  }, 120_000)

  it("never lists another individual's, or an entity's, deal-less LEGAL_DOCUMENT for an individual lessee", async () => {
    const [a, b] = [await newIndividual(), await newIndividual()]
    const entity = await entityLoan()
    const [aDoc, bDoc, entityDoc] = [await legalDocFor({ clientId: a }), await legalDocFor({ clientId: b }), await legalDocFor({ entityId: entity.entityId })]
    expect(await idsFor({ entityId: null, clientId: b })).toEqual([bDoc])
    expect(await idsFor({ entityId: null, clientId: a })).toEqual([aDoc])
    expect(await idsFor({ entityId: null, clientId: b })).not.toContain(entityDoc)
  })

  it("never lists an individual's deal-less LEGAL_DOCUMENT for an entity lessee", async () => {
    const entity = await entityLoan()
    const [clientDoc, entityDoc] = [await legalDocFor({ clientId: await newIndividual() }), await legalDocFor({ entityId: entity.entityId })]
    const listed = await idsFor({ entityId: entity.entityId, clientId: null })
    expect(listed).toContain(entityDoc)
    expect(listed).not.toContain(clientDoc)
  })

  it("refuses an individual's deal-less LEGAL_DOCUMENT as evidence on an entity's loan, and accepts the entity's own", async () => {
    const entity = await entityLoan()
    const clientDoc = await legalDocFor({ clientId: await newIndividual() })
    expect(await record(entity.loanId, clientDoc)).toMatchObject({ kind: "not_ready" })
    expect(await d().commercialCancellation.count({ where: { loanId: entity.loanId } })).toBe(0)
    expect(await record(entity.loanId, await legalDocFor({ entityId: entity.entityId }))).toMatchObject({ kind: "done", loanId: entity.loanId })
  })

  it("refuses a filter with neither borrower rather than filtering on null", () => {
    expect(() => borrowerDocumentWhere({ entityId: null, clientId: null })).toThrow()
  })
})
