/**
 * Feature C against Postgres, with the model's HTTP endpoint stubbed: the
 * route only queues (the model is asked by the worker after it returns), a
 * READONLY user reads answers but cannot ask, the lender's switch off is a
 * 404, the tools read only the asking tenant's application's rows, and a
 * model that is down leaves a FAILED answer an officer may ask again.
 *
 *   RUN_STATEMENT_AI_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/statement-ai/ask/route.integration.test.ts'
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { UserRole } from "@prisma/client"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { prisma } from "@/lib/prisma"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { createAiFixture, dropAiFixture, sessionFor, type AiFixture } from "@/lib/statement-ai/statement-ai.integration-fixture"
import { resetModelBackoff } from "@/lib/statement-ai/model"
import { drained } from "@/lib/statement-ai/worker"
import { POST } from "./route"
import { GET } from "../route"

const RUN = process.env.RUN_STATEMENT_AI_IT === "1"
const suite = RUN ? describe : describe.skip

/** The stubbed model: a plan for a planning prompt (the answer is written by code); `down` answers 503. */
const model = { plan: "", down: false, calls: 0 }
function stubModel() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    model.calls++
    if (model.down) return new Response("down", { status: 503 })
    const prompt = (JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages[0].content
    const content = prompt.startsWith("You plan read-only queries") ? model.plan : '{"claims": ["coverage"]}'
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 500, completion_tokens: 30 } }), { status: 200 })
  }))
}

const ask = (f: AiFixture, role: UserRole, question: string, applicationId = f.applicationId, slug = f.slug) => {
  h.session = sessionFor(f, role)
  return POST(new NextRequest(`http://localhost/api/applications/${applicationId}/statement-ai/ask`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant-slug": slug }, body: JSON.stringify({ question }),
  }), { params: Promise.resolve({ id: applicationId }) })
}
const view = async (f: AiFixture, role: UserRole) => {
  h.session = sessionFor(f, role)
  return (await GET(new NextRequest(`http://localhost/api/applications/${f.applicationId}/statement-ai`, { headers: { "x-tenant-slug": f.slug } }), { params: Promise.resolve({ id: f.applicationId }) })).json()
}

suite("POST /api/applications/[id]/statement-ai/ask against Postgres", () => {
  let a: AiFixture
  let b: AiFixture
  let off: AiFixture
  const env = { url: process.env.VLM_API_URL, model: process.env.VLM_MODEL }

  beforeAll(async () => {
    process.env.VLM_API_URL = "http://vlm.test"
    process.env.VLM_MODEL = "stub-model"
    a = await createAiFixture({ featureStatementAi: true, label: "aska" })
    // Tenant B's client pays a payee tenant A's never does.
    b = await createAiFixture({
      featureStatementAi: true, label: "askb",
      transactions: [{ date: "2026-08-02", description: "Card Purchase: OTHERLENDER SECRET SHOP", amountCents: -99_900, balanceCents: null, page: 1 }],
    })
    off = await createAiFixture({ featureStatementAi: false, label: "askoff" })
  })
  afterAll(async () => {
    process.env.VLM_API_URL = env.url
    process.env.VLM_MODEL = env.model
    for (const f of [a, b, off]) if (f) await dropAiFixture(f)
  })
  beforeEach(() => {
    _resetRateLimitStore()
    resetModelBackoff()
    Object.assign(model, { down: false, calls: 0 })
    stubModel()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("flag off: 404, nothing stored", async () => {
    expect((await ask(off, "LOAN_ADMIN", "How much rent was paid?")).status).toBe(404)
    expect(await prisma.statementAiOutput.count({ where: { tenantId: off.tenantId } })).toBe(0)
  })

  it("READONLY cannot ask", async () => {
    expect((await ask(a, "READONLY", "How much rent was paid?")).status).toBe(403)
    expect(await prisma.statementAiOutput.count({ where: { tenantId: a.tenantId, kind: "ANSWER" } })).toBe(0)
  })

  it("queues the question without asking the model, then the worker answers with its citations", async () => {
    model.plan = '{"queries":[{"id":"q1","tool":"sum","filter":{"direction":"out","payee":"SYNTH RENTALS"}}]}'
    const res = await ask(a, "CREDIT_OFFICER", "How much rent was paid to SYNTH RENTALS?")
    expect(res.status).toBe(202)
    const { id, status } = await res.json()
    expect(status).toBe("PENDING")
    // The route returned before the model was asked: the call happens in the worker.
    expect(model.calls).toBe(0)
    await drained()
    const row = await prisma.statementAiOutput.findFirstOrThrow({ where: { id, tenantId: a.tenantId } })
    expect(row).toMatchObject({ tenantId: a.tenantId, kind: "ANSWER", status: "OK", askedById: a.userIds.CREDIT_OFFICER, text: '[q1] Total for money out to "SYNTH RENTALS": R19 500.00, from 3 rows.' })
    expect(row.citations).toMatchObject([{ id: "q1", tool: "sum", result: { total: "R19 500.00", rowCount: 3 }, matchedRows: 3, rows: [{ ref: "S1-R5" }, { ref: "S1-R11" }, { ref: "S1-R17" }] }])
    expect(await prisma.statementAiUsage.count({ where: { tenantId: a.tenantId, kind: "ANSWER" } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: "STATEMENT_AI_QUESTION_ASKED", entityId: id } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: "STATEMENT_AI_OUTPUT_RECORDED", entityId: id } })).toBe(1)

    // READONLY reads the answer and how it was computed.
    const seen = await view(a, "READONLY")
    expect(seen.answers).toEqual([expect.objectContaining({ id, status: "OK", question: "How much rent was paid to SYNTH RENTALS?", stale: false, citations: expect.any(Array) })])

    // The same question again returns the stored answer; the model is not asked.
    const again = await ask(a, "LOAN_ADMIN", "how much rent was paid to SYNTH RENTALS?")
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ id, status: "OK" })
    await drained()
    // (The view queued the summary; the question itself was not asked again.)
    expect(await prisma.statementAiUsage.count({ where: { tenantId: a.tenantId, kind: "ANSWER" } })).toBe(1)
  })

  it("never reads another tenant's rows: a payee only tenant B has is unknown to tenant A's question", async () => {
    model.plan = '{"queries":[{"id":"q1","tool":"sum","filter":{"payee":"OTHERLENDER SECRET SHOP"}}]}'
    const { id } = await (await ask(a, "LOAN_ADMIN", "How much went to OTHERLENDER SECRET SHOP?")).json()
    await drained()
    expect(await prisma.statementAiOutput.findFirstOrThrow({ where: { id, tenantId: a.tenantId } })).toMatchObject({ status: "REJECTED", rejectReason: expect.stringMatching(/payee the statement does not have/), text: "" })
    // And tenant B's officer cannot ask about tenant A's application at all.
    expect((await ask(b, "LOAN_ADMIN", "How much rent?", a.applicationId)).status).toBe(404)
    expect((await ask(b, "LOAN_ADMIN", "How much rent?", a.applicationId, a.slug)).status).toBe(403)
    expect(await prisma.statementAiOutput.count({ where: { applicationId: a.applicationId, tenantId: b.tenantId } })).toBe(0)
  })

  it("a model that is down leaves FAILED, and asking again re-queues it", async () => {
    model.down = true
    const { id } = await (await ask(a, "LOAN_ADMIN", "How many payments to SYNTH RENTALS?")).json()
    await drained()
    expect(await prisma.statementAiOutput.findFirstOrThrow({ where: { id, tenantId: a.tenantId } })).toMatchObject({ status: "FAILED", rejectReason: "model unavailable" })
    model.down = false
    resetModelBackoff()
    model.plan = '{"queries":[{"id":"q1","tool":"count","filter":{"payee":"SYNTH RENTALS"}}]}'
    const retried = await ask(a, "LOAN_ADMIN", "How many payments to SYNTH RENTALS?")
    expect(await retried.json()).toEqual({ id, status: "PENDING" })
    await drained()
    expect(await prisma.statementAiOutput.findFirstOrThrow({ where: { id, tenantId: a.tenantId } })).toMatchObject({ status: "OK", text: '[q1] Rows for all rows with "SYNTH RENTALS": 3.' })
  })

  it("never overwrites an answer finished elsewhere while this one was working", async () => {
    model.plan = '{"queries":[{"id":"q1","tool":"count","filter":{"payee":"SYNTH RENTALS"}}]}'
    const res = await ask(a, "LOAN_ADMIN", "How many rent payments were there?")
    const { id } = await res.json()
    // While the worker waits on the model, the row is finished by another request (a re-ask that won).
    vi.stubGlobal("fetch", vi.fn(async () => {
      await prisma.statementAiOutput.updateMany({ where: { id, tenantId: a.tenantId }, data: { status: "OK", text: "finished elsewhere" } })
      return new Response(JSON.stringify({ choices: [{ message: { content: model.plan } }] }), { status: 200 })
    }))
    await drained()
    expect(await prisma.statementAiOutput.findFirstOrThrow({ where: { id, tenantId: a.tenantId } })).toMatchObject({ status: "OK", text: "finished elsewhere" })
    expect(await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: "STATEMENT_AI_OUTPUT_RECORDED", entityId: id } })).toBe(0)
  })

  it("rate-limits an officer's questions", async () => {
    model.plan = '{"queries":[]}'
    const codes = []
    for (let i = 0; i < 11; i++) codes.push((await ask(a, "LOAN_ADMIN", `Question number ${i}?`)).status)
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true)
    expect(codes[10]).toBe(429)
    await drained()
  })
})
