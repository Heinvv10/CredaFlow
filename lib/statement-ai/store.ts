/**
 * Writes an output and its audit row together. Every output is recorded,
 * shown or not: who asked, what it was made from and why a rejected one was
 * rejected (never its text: the audit log is not a second copy of model prose).
 */
import { Prisma, type StatementAiKind, type StatementAiStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

export interface OutputRecord {
  tenantId: string
  applicationId: string
  kind: StatementAiKind
  flagCode: string
  inputHash: string
  promptVersion: string
  status: StatementAiStatus
  rejectReason?: string
  text: string
  citations: unknown
}

export async function storeOutput(o: OutputRecord): Promise<void> {
  const data = {
    status: o.status,
    rejectReason: o.rejectReason ?? null,
    text: o.text,
    citations: o.citations as Prisma.InputJsonValue,
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.statementAiOutput.upsert({
      where: { tenantId_applicationId_kind_flagCode_inputHash_promptVersion: { tenantId: o.tenantId, applicationId: o.applicationId, kind: o.kind, flagCode: o.flagCode, inputHash: o.inputHash, promptVersion: o.promptVersion } },
      update: data,
      create: { tenantId: o.tenantId, applicationId: o.applicationId, kind: o.kind, flagCode: o.flagCode, inputHash: o.inputHash, promptVersion: o.promptVersion, ...data },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: o.tenantId,
      action: AuditAction.STATEMENT_AI_OUTPUT_RECORDED,
      entity: "StatementAiOutput",
      entityId: row.id,
      newValue: { applicationId: o.applicationId, kind: o.kind, flagCode: o.flagCode || null, status: o.status, rejectReason: o.rejectReason ?? null, inputHash: o.inputHash, promptVersion: o.promptVersion },
    }, tx)
  })
}
