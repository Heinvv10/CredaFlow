/**
 * Features A and B against Postgres, with the model's HTTP endpoint stubbed
 * (fetch): the lender's switch off means a 404 and nothing generated; on,
 * the GET queues the work, the worker stores post-checked outputs, a figure
 * the facts do not hold is stored REJECTED and never shown, and another
 * tenant can neither read nor trigger them.
 *
 *   RUN_STATEMENT_AI_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/statement-ai/route.integration.test.ts'
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { UserRole } from "@prisma/client"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { prisma } from "@/lib/prisma"
import { createAiFixture, dropAiFixture, sessionFor, type AiFixture } from "@/lib/statement-ai/statement-ai.integration-fixture"
import { resetModelBackoff } from "@/lib/statement-ai/model"
import { drained, enqueueApplication, enqueueClientApplications } from "@/lib/statement-ai/worker"
import { GET } from "./route"

const RUN = process.env.RUN_STATEMENT_AI_IT === "1"
const suite = RUN ? describe : describe.skip

/** The stubbed model: answers a summary prompt with `summary`, an explanation prompt with `explain(code)`. */
const model = { summary: "", explain: (code: string) => `${code} was raised.`, calls: 0 }

function stubModel() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    model.calls++
    const prompt = (JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages[0].content
    const code = prompt.match(/name the flag by its code exactly as given \(([A-Z_]+)\)/)?.[1]
    const content = code ? model.explain(code) : model.summary
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }), { status: 200 })
  }))
}

const get = (f: AiFixture, role: UserRole, applicationId = f.applicationId) => {
  h.session = sessionFor(f, role)
  return GET(new NextRequest(`http://localhost/api/applications/${applicationId}/statement-ai`, { headers: { "x-tenant-slug": f.slug } }), { params: Promise.resolve({ id: applicationId }) })
}

suite("GET /api/applications/[id]/statement-ai against Postgres", () => {
  let on: AiFixture
  let off: AiFixture
  const env = { url: process.env.VLM_API_URL, model: process.env.VLM_MODEL }

  beforeAll(async () => {
    process.env.VLM_API_URL = "http://vlm.test"
    process.env.VLM_MODEL = "stub-model"
    on = await createAiFixture({ featureStatementAi: true, label: "aion" })
    off = await createAiFixture({ featureStatementAi: false, label: "aioff" })
    // A raised flag on the on-tenant's application, with evidence rows, as the checks store it.
    await prisma.applicationCheckFlag.create({
      data: {
        tenantId: on.tenantId, applicationId: on.applicationId, check: "RISK_BEHAVIOUR", code: "GAMBLING", fingerprint: `fp_${on.applicationId}`,
        summary: "Betting of R1 500.00 a month, 8.1% of income.",
        evidence: { documentId: on.documentId, analysisId: on.analysisId, transactionIndexes: [2, 8, 14], monthlyCents: 150_000, monthlyIncomeCents: 1_845_000 },
      },
    })
  })
  afterAll(async () => {
    process.env.VLM_API_URL = env.url
    process.env.VLM_MODEL = env.model
    if (on) await dropAiFixture(on)
    if (off) await dropAiFixture(off)
  })
  beforeEach(() => {
    model.calls = 0
    resetModelBackoff()
    stubModel()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("flag off: 404, and nothing is generated, stored or metered", async () => {
    expect((await get(off, "LOAN_ADMIN")).status).toBe(404)
    // Nor does a statement read landing (the upload and checks paths enqueue directly).
    enqueueApplication(off.tenantId, off.applicationId)
    await enqueueClientApplications(off.tenantId, off.clientId)
    await drained()
    expect(model.calls).toBe(0)
    expect(await prisma.statementAiOutput.count({ where: { tenantId: off.tenantId } })).toBe(0)
    expect(await prisma.statementAiUsage.count({ where: { tenantId: off.tenantId } })).toBe(0)
  })

  it("flag on: the GET queues, the worker stores, and a later GET shows only what passed the post-check", async () => {
    model.summary = "The 1 statement covers 2026-07 to 2026-09. Rent to SYNTH RENTALS came to R19 500.00. GAMBLING was raised."
    // A wrong threshold: R1 500.00 is an evidence figure, not the policy's 5% of income.
    model.explain = (code) => `${code}: betting is above the policy threshold of R1 500.00 a month.`
    const first = await get(on, "LOAN_ADMIN")
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ summary: null, explanations: [], pending: 2, modelAvailable: true })
    await drained()
    const rows = await prisma.statementAiOutput.findMany({ where: { tenantId: on.tenantId }, orderBy: { kind: "asc" } })
    expect(rows.map((r) => [r.kind, r.flagCode, r.status])).toEqual([["SUMMARY", "", "OK"], ["FLAG_EXPLANATION", "GAMBLING", "REJECTED"]])
    expect(rows[1].rejectReason).toMatch(/threshold other than policy/)
    // Summary once; the rejected explanation asked twice.
    expect(model.calls).toBe(3)
    expect(await prisma.statementAiUsage.count({ where: { tenantId: on.tenantId } })).toBe(3)
    expect(await prisma.auditLog.count({ where: { tenantId: on.tenantId, action: "STATEMENT_AI_OUTPUT_RECORDED" } })).toBe(2)

    // READONLY reads answers only: the summary and explanations restate the insights (CREDIT_OFFICER and up).
    const readonly = await (await get(on, "READONLY")).json()
    expect(readonly).toMatchObject({ summary: null, explanations: [], answers: [] })
    const second = await (await get(on, "CREDIT_OFFICER")).json()
    expect(second.pending).toBe(0)
    expect(second.summary).toMatchObject({ status: "OK", stale: false, text: expect.stringContaining("R19 500.00") })
    expect(second.explanations).toEqual([expect.objectContaining({ flagCode: "GAMBLING", status: "REJECTED", text: null, citations: null })])
    expect(JSON.stringify(second)).not.toContain("policy threshold of R1 500.00")
    // Viewed outputs cite the statement: each GET logs the access.
    expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, action: "statement_ai" } })).toBe(3)
    await drained()
    expect(model.calls).toBe(3)
  })

  it("shows an output as stale once the facts change, and queues the new one", async () => {
    await prisma.applicationCheckFlag.create({
      data: {
        tenantId: on.tenantId, applicationId: on.applicationId, check: "RISK_BEHAVIOUR", code: "RETURNED_DEBIT", fingerprint: `fp2_${on.applicationId}`,
        summary: "1 debit was returned unpaid.", evidence: { documentId: on.documentId, analysisId: on.analysisId, transactionIndexes: [1], occurrences: 1 },
      },
    })
    model.summary = "GAMBLING and RETURNED_DEBIT were raised."
    const body = await (await get(on, "CREDIT_OFFICER")).json()
    expect(body.summary).toMatchObject({ status: "OK", stale: true })
    // The new summary and RETURNED_DEBIT's explanation; GAMBLING's facts did not change.
    expect(body.pending).toBe(2)
    await drained()
    const after = await (await get(on, "CREDIT_OFFICER")).json()
    expect(after.summary).toMatchObject({ status: "OK", stale: false, text: "GAMBLING and RETURNED_DEBIT were raised." })
  })

  it("cross-tenant: another lender with Statement AI on can neither read nor trigger them", async () => {
    const other = await createAiFixture({ featureStatementAi: true, label: "aiother" })
    try {
      // Its LOAN_ADMIN asks for the first lender's application under its own host: not found.
      expect((await get(other, "LOAN_ADMIN", on.applicationId)).status).toBe(404)
      // Under the first lender's host, its session is refused outright.
      h.session = sessionFor(other, "LOAN_ADMIN")
      const crossed = await GET(new NextRequest(`http://localhost/api/applications/${on.applicationId}/statement-ai`, { headers: { "x-tenant-slug": on.slug } }), { params: Promise.resolve({ id: on.applicationId }) })
      expect(crossed.status).toBe(403)
      await drained()
      expect(await prisma.statementAiOutput.count({ where: { tenantId: other.tenantId } })).toBe(0)
      expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, accessorId: other.userIds.LOAN_ADMIN } })).toBe(0)
    } finally {
      await dropAiFixture(other)
    }
  })
})
