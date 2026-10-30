import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { checkRateLimit, recordedCallerIp } from "@/lib/rate-limit"
import { statementAiEnabled } from "@/lib/statement-ai/enabled"
import { planOutputs } from "@/lib/statement-ai/generate"
import { ASK_PROMPT_VERSION, askInputHash, normaliseQuestion, QUESTION_MAX } from "@/lib/statement-ai/ask/answer"
import { enqueueQuestion } from "@/lib/statement-ai/worker"
import { checkNoContradiction } from "@/lib/statement-ai/post-check"

/** Questions one officer may ask, and one lender, per window: each costs two model calls. */
const ASK_LIMIT_PER_USER = { limit: 10, windowMs: 10 * 60_000 }
const ASK_LIMIT_PER_TENANT = { limit: 100, windowMs: 60 * 60_000 }

/**
 * POST /api/applications/[id]/statement-ai/ask — body `{ question }`. Queues
 * the question for the background worker and returns at once (202); the
 * answer is polled through GET /api/applications/[id]/statement-ai. Never
 * calls the model. CREDIT_OFFICER and up: READONLY neither reads answers nor asks.
 * The same question on the same rows returns the stored answer, unless it failed or was rejected.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (!(await statementAiEnabled(tenant.id))) return NextResponse.json({ error: "Statement AI is not enabled" }, { status: 404 })
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { question?: unknown } | null
    const question = typeof body?.question === "string" ? normaliseQuestion(body.question) : ""
    if (question.length < 3 || question.length > QUESTION_MAX) {
      return NextResponse.json({ error: `A question is 3 to ${QUESTION_MAX} characters.` }, { status: 400 })
    }
    for (const [key, opts] of [[`statement-ai-ask:user:${guard.user.id}`, ASK_LIMIT_PER_USER], [`statement-ai-ask:tenant:${tenant.id}`, ASK_LIMIT_PER_TENANT]] as const) {
      const rl = await checkRateLimit(key, opts)
      if (!rl.allowed) return NextResponse.json({ error: "Too many questions. Try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } })
    }
    const planned = await planOutputs(tenant.id, id)
    if (!planned) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    if (planned.rows.length === 0) return NextResponse.json({ error: "No reconciled statement has been read for this application." }, { status: 409 })

    const inputHash = askInputHash(question, planned.rows)
    const key = { tenantId: tenant.id, applicationId: id, kind: "ANSWER" as const, flagCode: "", inputHash, promptVersion: ASK_PROMPT_VERSION }
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.statementAiOutput.findUnique({ where: { tenantId_applicationId_kind_flagCode_inputHash_promptVersion: key }, select: { id: true, status: true, text: true } })
      // A stored answer is returned; one that failed or was rejected is asked again.
      // An OK answer the view now hides (the flags changed since) is asked again rather than stuck unavailable.
      const hidden = existing?.status === "OK" && !checkNoContradiction(existing.text, planned.raisedFlagCodes).ok
      if (existing && !hidden && (existing.status === "OK" || existing.status === "PENDING")) return { id: existing.id, status: existing.status }
      const saved = existing
        ? await tx.statementAiOutput.update({ where: { id: existing.id }, data: { status: "PENDING", text: "", rejectReason: null, citations: [], question, askedById: guard.user.id }, select: { id: true, status: true } })
        : await tx.statementAiOutput.create({ data: { ...key, status: "PENDING", question, askedById: guard.user.id }, select: { id: true, status: true } })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        ipAddress: recordedCallerIp(req) ?? undefined,
        action: AuditAction.STATEMENT_AI_QUESTION_ASKED,
        entity: "StatementAiOutput",
        entityId: saved.id,
        newValue: { applicationId: id, questionLength: question.length, retried: !!existing },
      }, tx)
      return saved
    }).catch(async (err: unknown) => {
      // A concurrent ask of the same question won the unique key: use its row.
      if ((err as { code?: unknown })?.code === "P2002") {
        return prisma.statementAiOutput.findUniqueOrThrow({ where: { tenantId_applicationId_kind_flagCode_inputHash_promptVersion: key }, select: { id: true, status: true } })
      }
      throw err
    })
    if (row.status === "PENDING") enqueueQuestion(tenant.id, id, row.id)
    return NextResponse.json({ id: row.id, status: row.status }, { status: row.status === "PENDING" ? 202 : 200 })
  })
}
