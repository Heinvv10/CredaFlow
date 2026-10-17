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

/** The stubbed model: answers the summary prompt (the only one A and B make) with `summary`. */
const model = { summary: "", calls: 0 }

function stubModel() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    model.calls++
    return new Response(JSON.stringify({ choices: [{ message: { content: model.summary } }], usage: { prompt_tokens: 900, completion_tokens: 20 } }), { status: 200 })
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

  it("flag on: the GET queues the summary, the worker stores it, and explanations need no model", async () => {
    // Not a claims list first: asked once more.
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      model.calls++
      const content = ++n === 1 ? "Everything looks fine." : '{"claims": ["payees", "flags"]}'
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 20 } }), { status: 200 })
    }))
    const first = await get(on, "LOAN_ADMIN")
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body).toMatchObject({ summary: null, pending: 1, modelAvailable: true })
    // B is written by code at once, from the flag's own facts.
    expect(body.explanations).toEqual([expect.objectContaining({ flagCode: "GAMBLING", status: "OK", text: expect.stringContaining("GAMBLING (RISK_BEHAVIOUR)") })])
    await drained()
    const rows = await prisma.statementAiOutput.findMany({ where: { tenantId: on.tenantId } })
    expect(rows.map((r) => [r.kind, r.status])).toEqual([["SUMMARY", "OK"]])
    expect(rows[0].text).toMatch(/^Largest payees by money out: SYNTH RENTALS R19 500.00/)
    expect(model.calls).toBe(2)
    expect(await prisma.statementAiUsage.count({ where: { tenantId: on.tenantId } })).toBe(2)
    expect(await prisma.auditLog.count({ where: { tenantId: on.tenantId, action: "STATEMENT_AI_OUTPUT_RECORDED" } })).toBe(1)

    // READONLY reads answers only: the summary and explanations restate the insights (CREDIT_OFFICER and up).
    const readonly = await (await get(on, "READONLY")).json()
    expect(readonly).toMatchObject({ summary: null, explanations: [], answers: [] })
    const second = await (await get(on, "CREDIT_OFFICER")).json()
    expect(second.pending).toBe(0)
    expect(second.summary).toMatchObject({ status: "OK", stale: false, text: expect.stringContaining("Flags raised by the credit checks: GAMBLING") })
    // Viewed outputs cite the statement: each GET logs the access.
    expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, action: "statement_ai" } })).toBe(3)
    await drained()
    expect(model.calls).toBe(2)
  })

  it("shows the summary as stale once the facts change, and queues the new one", async () => {
    await prisma.applicationCheckFlag.create({
      data: {
        tenantId: on.tenantId, applicationId: on.applicationId, check: "RISK_BEHAVIOUR", code: "RETURNED_DEBIT", fingerprint: `fp2_${on.applicationId}`,
        summary: "1 debit was returned unpaid.", evidence: { documentId: on.documentId, analysisId: on.analysisId, transactionIndexes: [1], occurrences: 1 },
      },
    })
    model.summary = '{"claims": ["flags"]}'
    const body = await (await get(on, "CREDIT_OFFICER")).json()
    expect(body.summary).toMatchObject({ status: "OK", stale: true })
    expect(body.pending).toBe(1)
    expect(body.explanations.map((e: { flagCode: string }) => e.flagCode)).toEqual(["GAMBLING", "RETURNED_DEBIT"])
    await drained()
    const after = await (await get(on, "CREDIT_OFFICER")).json()
    expect(after.summary).toMatchObject({ status: "OK", stale: false, text: expect.stringMatching(/GAMBLING .*RETURNED_DEBIT/) })
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
