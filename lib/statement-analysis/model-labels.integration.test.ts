/**
 * Model labels against a migrated database (the model itself mocked): the
 * background read stores them on the tenant's own StatementAnalysis row, the
 * JSON round-trips, and the checks' facts and the insights use them.
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/statement-analysis/model-labels.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { loadApplicationFacts, statementSnapshot } from "@/lib/credit-checks/load-facts"
import { applicationStatementInsights } from "@/lib/credit-checks/statement-insights"
import { syntheticStatement } from "./fixtures/dataset"
import { buildCapitecStatement } from "./fixtures/synthetic"
import { MODEL_LABELS } from "./model-labels"
import { ensureStatementAnalysis, readStatementInBackground } from "./persist"

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("model labels against Postgres", () => {
  const tenants = [`tenant_labels_a_${token}`, `tenant_labels_b_${token}`]
  const id = (kind: string, t: number) => `${kind}_labels_${t}_${token}`
  const dir = mkdtempSync(join(tmpdir(), "cf-labels-it-"))
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"labels": {"SYNTH ZOLA TRADING": "FOOD"}}' } }] }), { status: 200 }))

  beforeAll(async () => {
    const statement = syntheticStatement({ bank: "CAPITEC", start: "2026-07-01" })
    for (const m of ["07", "08", "09"]) statement.transactions.push({ date: `2026-${m}-10`, description: "Card Purchase: SYNTH ZOLA TRADING", category: "Groceries", amountCents: -40_000 })
    statement.transactions.sort((a, b) => a.date.localeCompare(b.date))
    const pdf = Buffer.from(await buildCapitecStatement(statement))
    const storagePath = join(dir, "statement.pdf")
    writeFileSync(storagePath, pdf)
    for (const [t, tenantId] of tenants.entries()) {
      await prisma.tenant.create({ data: { id: tenantId, slug: `labels-${t}-${token}`, name: "Labels test" } })
      await prisma.client.create({
        data: {
          id: id("client", t), tenantId, reference: `CLI-${t}-${token}`, idNumber: `ID-${t}-${token}`, firstName: "Thabo", lastName: "Tester",
          email: `client-${t}-${token}@test.invalid`, phone: "+27820000000", monthlyIncome: 1_845_000, popiaConsentGiven: true,
        },
      })
      await prisma.loanProduct.create({
        data: { id: id("product", t), tenantId, code: `LB-${t}-${token}`, name: "Labels product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
      })
      await prisma.loanApplication.create({
        data: { id: id("app", t), tenantId, reference: `APP-${t}-${token}`, clientId: id("client", t), productId: id("product", t), appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date("2026-10-05T08:00:00Z") },
      })
      await prisma.clientDocument.create({
        data: {
          id: id("doc", t), tenantId, clientId: id("client", t), docType: "BANK_STATEMENT", fileUrl: "", fileName: "statement.pdf",
          mimeType: "application/pdf", storagePath, contentSha256: sha256DocumentBytes(pdf), extractionStatus: "done", uploadedByType: "staff",
        },
      })
    }
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    vi.stubGlobal("fetch", fetchMock)
    MODEL_LABELS.enabled = true
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    MODEL_LABELS.enabled = false
    for (const tenantId of tenants) {
      await prisma.statementAnalysis.deleteMany({ where: { tenantId } })
      await prisma.clientDocument.deleteMany({ where: { tenantId } })
      await prisma.loanApplication.deleteMany({ where: { tenantId } })
      await prisma.loanProduct.deleteMany({ where: { tenantId } })
      await prisma.client.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it("stores the labels on the tenant's own read, and no other tenant's", async () => {
    // Tenant B has a read of the same bytes, unlabelled: a read outside the queue never labels.
    expect(await ensureStatementAnalysis({ tenantId: tenants[1], documentId: id("doc", 1), allowVlm: false })).toMatchObject({ state: "read" })
    expect(fetchMock).not.toHaveBeenCalled()
    const done = new Promise<void>((resolve) => readStatementInBackground(tenants[0], id("doc", 0), { onRead: async () => resolve() }))
    await done

    const [a] = await prisma.statementAnalysis.findMany({ where: { tenantId: tenants[0] } })
    expect(a.modelCategories).toEqual({ "SYNTH ZOLA TRADING": "FOOD" })
    expect(a.modelCategoriesVersion).toBe("synthetic-model|labels-p3x3a")
    expect(a.modelCategoriesAt).toBeInstanceOf(Date)
    // The model saw the masked key alone.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body).messages[0].content).toContain('["SYNTH ZOLA TRADING"]')
    const b = await prisma.statementAnalysis.findMany({ where: { tenantId: tenants[1] } })
    expect(b.every((r) => r.modelCategories === null)).toBe(true)
  })

  it("puts the labels' time in the approval's statement snapshot", async () => {
    const [a] = await prisma.statementAnalysis.findMany({ where: { tenantId: tenants[0] } })
    const snap = (t: number) => statementSnapshot(prisma, { tenantId: tenants[t], clientId: id("client", t), since: new Date(0) })
    expect(await snap(0)).toEqual([`${id("doc", 0)}:${a.id}:${a.modelCategoriesAt!.toISOString()}`])
    const [b] = await prisma.statementAnalysis.findMany({ where: { tenantId: tenants[1] } })
    expect(await snap(1)).toEqual([`${id("doc", 1)}:${b.id}`])
  })

  it("feeds the checks' facts and the insights, marked model-assigned", async () => {
    const loaded = await loadApplicationFacts(tenants[0], id("app", 0), { persistedOnly: true })
    expect(loaded!.facts.statements[0].modelLabels).toEqual({ "SYNTH ZOLA TRADING": "FOOD" })
    const r = await applicationStatementInsights(tenants[0], id("app", 0))
    expect(r!.insights.modelAssigned.rowCount).toBe(3)
    expect(r!.insights.modelAssigned.rows.every((row) => row.description === "Card Purchase: SYNTH ZOLA TRADING" && row.category === "FOOD")).toBe(true)
    expect(r!.insights.statements[0].modelLabelled).toBe(true)
    const other = await applicationStatementInsights(tenants[1], id("app", 1))
    expect(other!.insights.modelAssigned.rowCount).toBe(0)
  })
})
