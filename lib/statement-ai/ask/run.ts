/**
 * Feature C in the background: an asked question (a PENDING StatementAiOutput)
 * is answered by the worker, never by the route that took it. The rows are
 * loaded for the row's own tenant and application only.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { planOutputs } from "../generate"
import { askModel } from "../model"
import { answerQuestion, type Answered } from "./answer"

async function finish(tenantId: string, id: string, applicationId: string, a: Pick<Answered, "status" | "text" | "rejectReason" | "citations"> | { status: "FAILED"; text: ""; rejectReason: string; citations: [] }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Only a question still waiting: a re-ask that reset it is the newer request.
    const done = await tx.statementAiOutput.updateMany({
      where: { id, tenantId, status: "PENDING" },
      data: { status: a.status, text: a.text, rejectReason: a.rejectReason ?? null, citations: a.citations as object[] },
    })
    if (done.count === 0) return
    await logAuditStrict({
      tenantId,
      action: AuditAction.STATEMENT_AI_OUTPUT_RECORDED,
      entity: "StatementAiOutput",
      entityId: id,
      newValue: { applicationId, kind: "ANSWER", status: a.status, rejectReason: a.rejectReason ?? null, queries: a.citations.length },
    }, tx)
  })
}

export async function runQuestion(tenantId: string, applicationId: string, outputId: string): Promise<void> {
  const row = await prisma.statementAiOutput.findFirst({
    where: { id: outputId, tenantId, applicationId, kind: "ANSWER", status: "PENDING" },
    select: { id: true, question: true },
  })
  if (!row?.question) return
  const planned = await planOutputs(tenantId, applicationId)
  if (!planned || planned.rows.length === 0) {
    await finish(tenantId, row.id, applicationId, { status: "FAILED", text: "", rejectReason: "no statement rows to read", citations: [] })
    return
  }
  try {
    const answered = await answerQuestion(
      { question: row.question, rows: planned.rows, raisedFlagCodes: planned.raisedFlagCodes },
      async (prompt, maxTokens, schema) => (await askModel({ tenantId, applicationId, kind: "ANSWER", prompt, maxTokens, schema })).content,
    )
    await finish(tenantId, row.id, applicationId, answered)
  } catch (err) {
    if (!(err instanceof VlmUnavailableError)) throw err
    // The officer sees "unavailable" and may ask again; the row is not left polling.
    await finish(tenantId, row.id, applicationId, { status: "FAILED", text: "", rejectReason: "model unavailable", citations: [] })
  }
}
