/**
 * Feature B in the credit checks panel, against Postgres: a lender with
 * Statement AI on gets each open flag's explanation in that flag's own row of
 * the checks GET; with it off the response carries none; READONLY is refused
 * both routes; another lender reaches none of it; the Statement AI GET no
 * longer repeats the explanations. The model's endpoint is stubbed (fetch):
 * the checks GET queues the summary in the background.
 *
 *   RUN_STATEMENT_AI_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/checks/statement-ai.integration.test.ts'
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
import { drained } from "@/lib/statement-ai/worker"
import { GET as checksGET } from "./route"
import { GET as aiGET } from "../statement-ai/route"

const RUN = process.env.RUN_STATEMENT_AI_IT === "1"
const suite = RUN ? describe : describe.skip

type Flag = { id: string; code: string; check: string; status: string; explanation?: string }

function call(route: typeof checksGET, path: string, f: AiFixture, role: UserRole, applicationId = f.applicationId, slug = f.slug) {
  h.session = sessionFor(f, role)
  const req = new NextRequest(`http://localhost/api/applications/${applicationId}/${path}`, { headers: { "x-tenant-slug": slug } })
  return route(req, { params: Promise.resolve({ id: applicationId }) })
}
const checks = (f: AiFixture, role: UserRole, applicationId?: string, slug?: string) => call(checksGET, "checks", f, role, applicationId, slug)
const ai = (f: AiFixture, role: UserRole) => call(aiGET, "statement-ai", f, role)

async function raiseGambling(f: AiFixture) {
  await prisma.applicationCheckFlag.create({
    data: {
      tenantId: f.tenantId, applicationId: f.applicationId, check: "RISK_BEHAVIOUR", code: "GAMBLING", fingerprint: `fp_${f.applicationId}`,
      summary: "Betting of R1 500.00 a month, 8.1% of income.",
      evidence: { documentId: f.documentId, analysisId: f.analysisId, transactionIndexes: [2, 8, 14], monthlyCents: 150_000, monthlyIncomeCents: 1_845_000 },
    },
  })
}

suite("Statement AI flag explanations in GET /api/applications/[id]/checks against Postgres", () => {
  let on: AiFixture
  let off: AiFixture
  const env = { url: process.env.VLM_API_URL, model: process.env.VLM_MODEL }

  beforeAll(async () => {
    process.env.VLM_API_URL = "http://vlm.test"
    process.env.VLM_MODEL = "stub-model"
    on = await createAiFixture({ featureStatementAi: true, label: "chkon" })
    off = await createAiFixture({ featureStatementAi: false, label: "chkoff" })
    await raiseGambling(on)
    await raiseGambling(off)
  })
  afterAll(async () => {
    await drained()
    process.env.VLM_API_URL = env.url
    process.env.VLM_MODEL = env.model
    if (on) await dropAiFixture(on)
    if (off) await dropAiFixture(off)
  })
  beforeEach(() => {
    resetModelBackoff()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"claims": ["flags"]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })))
  })
  afterEach(async () => {
    await drained()
    vi.unstubAllGlobals()
  })

  it("flag on: each open flag's explanation is in its own row, saying neither its code, its check nor its rows", async () => {
    const res = await checks(on, "LOAN_ADMIN")
    expect(res.status).toBe(200)
    const { flags } = (await res.json()) as { flags: Flag[] }
    const gambling = flags.find((f) => f.code === "GAMBLING")!
    expect(gambling.explanation).toMatch(/^Betting and lottery spend per month is compared with the client's monthly income\. /)
    expect(gambling.explanation).toContain("Policy threshold: betting of at least 5% of monthly income.")
    expect(gambling.explanation).toContain("Evidence: amount a month R1 500.00; monthly income R18 450.00.")
    for (const f of flags.filter((x) => x.explanation)) {
      expect(f.explanation).not.toContain(f.code)
      expect(f.explanation).not.toContain(f.check)
      expect(f.explanation).not.toMatch(/S\d+-R\d+|Evidence rows/)
    }
    // Only open flags are explained.
    expect(flags.filter((f) => f.status !== "OPEN" && f.explanation)).toEqual([])
    // The checks GET logs its evidence as before, and writes no Statement AI access of its own.
    expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, action: "statement_ai" } })).toBe(0)
    expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, action: "credit_check_evidence" } })).toBeGreaterThan(0)
  })

  it("explains each open flag in its own row: two of one code apart, none for a superseded flag or a code with no spec", async () => {
    const f = await createAiFixture({ featureStatementAi: true, label: "chkrows" })
    try {
      const flag = (code: string, fp: string, monthlyCents: number) => prisma.applicationCheckFlag.create({
        data: {
          tenantId: f.tenantId, applicationId: f.applicationId, check: "RISK_BEHAVIOUR", code, fingerprint: `${fp}_${f.applicationId}`, summary: "Synthetic.",
          evidence: { documentId: f.documentId, analysisId: f.analysisId, transactionIndexes: [2], monthlyCents, monthlyIncomeCents: 1_845_000 },
        },
      })
      const a = await flag("GAMBLING", "a", 150_000)
      const b = await flag("GAMBLING", "b", 777_700)
      // Raised OPEN, then superseded, as the recompute does (the database allows no other way in).
      const gone = await flag("GAMBLING", "c", 333_300)
      await prisma.applicationCheckFlag.updateMany({ where: { id: gone.id, tenantId: f.tenantId }, data: { status: "SUPERSEDED" } })
      const nospec = await flag("ZZZ_NO_SPEC", "d", 100)
      const { flags } = (await (await checks(f, "LOAN_ADMIN")).json()) as { flags: Flag[] }
      const of = (id: string) => flags.find((x) => x.id === id)!
      expect(of(a.id).explanation).toContain("amount a month R1 500.00")
      expect(of(b.id).explanation).toContain("amount a month R7 777.00")
      expect(of(gone.id).status).toBe("SUPERSEDED")
      expect(of(gone.id)).not.toHaveProperty("explanation")
      expect(of(nospec.id)).not.toHaveProperty("explanation")
    } finally {
      await drained()
      await dropAiFixture(f)
    }
  })

  it("flag off: the same flags, and no explanation on any of them", async () => {
    const res = await checks(off, "LOAN_ADMIN")
    expect(res.status).toBe(200)
    const { flags } = (await res.json()) as { flags: Flag[] }
    expect(flags.map((f) => f.code)).toContain("GAMBLING")
    expect(flags.filter((f) => "explanation" in f)).toEqual([])
    expect((await ai(off, "LOAN_ADMIN")).status).toBe(404)
  })

  it("READONLY: both routes refuse, with Statement AI on", async () => {
    expect((await checks(on, "READONLY")).status).toBe(403)
    expect((await ai(on, "READONLY")).status).toBe(403)
  })

  it("the Statement AI GET no longer repeats the explanations", async () => {
    const res = await ai(on, "CREDIT_OFFICER")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).not.toHaveProperty("explanations")
    expect(JSON.stringify(body)).not.toContain("Betting and lottery spend per month")
  })

  it("cross-tenant: another lender with Statement AI on reaches no explanation", async () => {
    const other = await createAiFixture({ featureStatementAi: true, label: "chkother" })
    try {
      // Under its own host, the first lender's application is not found.
      expect((await checks(other, "LOAN_ADMIN", on.applicationId)).status).toBe(404)
      // Under the first lender's host, its session is refused outright.
      expect((await checks(other, "LOAN_ADMIN", on.applicationId, on.slug)).status).toBe(403)
      expect(await prisma.documentAccessLog.count({ where: { documentId: on.documentId, accessorId: other.userIds.LOAN_ADMIN } })).toBe(0)
    } finally {
      await drained()
      await dropAiFixture(other)
    }
  })
})
