/**
 * A boundary row flag through recompute against a migrated database: raised
 * on a lone Discovery statement, still OPEN once the account's previous
 * statement arrives and agrees (which goes on its evidence), and the
 * agreement gone again when that statement is deleted.
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/credit-checks/statement-chain.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { balances } from "@/lib/statement-analysis/fixtures/synthetic"
import { buildStatement } from "@/lib/statement-analysis/fixtures/synthetic-banks"
import { recomputeApplicationFlags } from "./recompute"

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("boundary rows chained across statements, against Postgres", () => {
  const tenantId = `tenant_chain_${token}`
  const clientId = `client_chain_${token}`
  const appId = `app_chain_${token}`
  const userId = `user_chain_${token}`
  const julyDoc = `doc_chain_jul_${token}`
  const aprilDoc = `doc_chain_apr_${token}`
  const dir = mkdtempSync(join(tmpdir(), "cf-chain-it-"))
  const april = syntheticStatement({ bank: "DISCOVERY", start: "2026-04-01" })
  const july = { ...syntheticStatement({ bank: "DISCOVERY", start: "2026-07-01" }), openingCents: balances(april).at(-1)! }

  const name = (id: string | undefined) => (id === aprilDoc ? "apr" : id === julyDoc ? "jul" : "-")
  /** Each boundary flag as "doc CODE status neighbour". */
  const boundary = async () =>
    (await prisma.applicationCheckFlag.findMany({ where: { tenantId, applicationId: appId, code: { in: ["FIRST_ROW_UNVERIFIED", "LAST_ROW_UNVERIFIED"] } } }))
      .map((f) => {
        const e = f.evidence as { documentId: string; chainedWith?: { documentId: string } }
        return `${name(e.documentId)} ${f.code} ${f.status} ${name(e.chainedWith?.documentId)}`
      }).sort()

  async function upload(id: string, pdf: Uint8Array) {
    const storagePath = join(dir, `${id}.pdf`)
    writeFileSync(storagePath, pdf)
    await prisma.clientDocument.create({
      data: {
        id, tenantId, clientId, docType: "BANK_STATEMENT", fileUrl: "", fileName: `${id}.pdf`,
        mimeType: "application/pdf", storagePath, contentSha256: sha256DocumentBytes(Buffer.from(pdf)), extractionStatus: "done",
      },
    })
  }

  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: tenantId, slug: `chain-${token}`, name: "Chain test" } })
    await prisma.user.create({ data: { id: userId, tenantId, email: `officer-${token}@test.invalid`, password: "x", role: "LOAN_ADMIN" } })
    await prisma.client.create({
      data: {
        id: clientId, tenantId, reference: `CLI-${token}`, idNumber: `ID-${token}`, firstName: "Thabo", lastName: "Tester",
        email: `client-${token}@test.invalid`, phone: "+27820000000", monthlyIncome: 1_845_000,
      },
    })
    await prisma.loanProduct.create({
      data: { id: `product_${token}`, tenantId, code: `CH-${token}`, name: "Chain product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
    })
    await prisma.loanApplication.create({
      data: { id: appId, tenantId, reference: `APP-${token}`, clientId, productId: `product_${token}`, appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date("2026-10-05T08:00:00Z") },
    })
    await upload(julyDoc, await buildStatement("DISCOVERY", july))
  })

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } })
    // Flags are records the database refuses to delete; the test's own rows go with its guard lifted.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
      prisma.$executeRawUnsafe(`DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${tenantId}'`),
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
    ])
    await prisma.statementAnalysis.deleteMany({ where: { tenantId } })
    await prisma.clientDocument.deleteMany({ where: { tenantId } })
    await prisma.loanApplication.deleteMany({ where: { tenantId } })
    await prisma.loanProduct.deleteMany({ where: { tenantId } })
    await prisma.client.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    rmSync(dir, { recursive: true, force: true })
  })

  it("raises both boundary rows of a lone statement whose bank prints neither balance", async () => {
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(await boundary()).toEqual(["jul FIRST_ROW_UNVERIFIED OPEN -", "jul LAST_ROW_UNVERIFIED OPEN -"])
  })

  it("keeps the first row OPEN once the previous statement arrives and agrees, naming it on the evidence", async () => {
    await upload(aprilDoc, await buildStatement("DISCOVERY", april))
    await recomputeApplicationFlags(tenantId, appId, { userId })
    // The client uploaded both statements: agreement helps the officer compare, it closes nothing.
    expect(await boundary()).toEqual([
      "apr FIRST_ROW_UNVERIFIED OPEN -", "apr LAST_ROW_UNVERIFIED OPEN jul", "jul FIRST_ROW_UNVERIFIED OPEN apr", "jul LAST_ROW_UNVERIFIED OPEN -",
    ])
    const flag = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "FIRST_ROW_UNVERIFIED", evidence: { path: ["documentId"], equals: julyDoc } } })
    expect((flag.evidence as { chainedWith: unknown }).chainedWith)
      .toEqual({ documentId: aprilDoc, periodStart: "2026-04-01", periodEnd: "2026-06-30", closingCents: july.openingCents })
    expect(await prisma.applicationCheckFlag.count({ where: { tenantId, status: "SUPERSEDED" } })).toBe(0)
  })

  it("drops the agreement from the evidence when the statement it named is deleted", async () => {
    await prisma.clientDocument.update({ where: { id: aprilDoc, tenantId }, data: { deletedAt: new Date() } })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    // April's own flags stay for an officer: deleting a statement never closes a finding.
    expect(await boundary()).toEqual([
      "apr FIRST_ROW_UNVERIFIED OPEN -", "apr LAST_ROW_UNVERIFIED OPEN jul", "jul FIRST_ROW_UNVERIFIED OPEN -", "jul LAST_ROW_UNVERIFIED OPEN -",
    ])
  })
})
