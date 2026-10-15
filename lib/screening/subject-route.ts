import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { readSubjectScreening } from "./gate"
import { runScreening } from "./run"
import { screeningStateMessage } from "./state"
import { subjectWhere } from "./subject"
import type { SubjectRef } from "./types"

/**
 * The bodies of the per-subject screening routes (a client, or a business
 * entity): read the state and latest run, or screen now. The routes own the
 * role guard and the "is this subject the tenant's" check.
 */
export async function subjectScreeningResponse(tenantId: string, ref: SubjectRef): Promise<NextResponse> {
  const current = await readSubjectScreening(tenantId, ref)
  const checks = current.runId
    ? await prisma.screeningCheck.findMany({
        where: { tenantId, runId: current.runId, ...subjectWhere(ref) },
        orderBy: { type: "asc" },
        select: {
          id: true, type: true, result: true, matches: true, simulated: true, provider: true,
          trigger: true, errorCode: true, decision: true, decisionReason: true,
          reviewedById: true, reviewedAt: true, carriedFromCheckId: true, createdAt: true,
        },
      })
    : []
  return NextResponse.json({ state: current.state, message: screeningStateMessage(current.state), runAt: current.runAt, checks })
}

/** Screen the subject now (MANUAL, audited by runScreening). A provider failure is recorded and surfaced, never retried silently. */
export async function screenSubjectNow(tenantId: string, ref: SubjectRef, actor: { id: string; email: string }): Promise<NextResponse> {
  const ran = await runScreening({ tenantId, subject: ref, trigger: "MANUAL", actor })
  if (!ran.configured) {
    return NextResponse.json({ error: screeningStateMessage({ state: "NOT_CONFIGURED" }) }, { status: 409 })
  }
  return NextResponse.json(
    {
      runId: ran.runId,
      state: ran.state,
      message: screeningStateMessage(ran.state),
      ...(ran.providerError ? { providerError: ran.providerError } : {}),
    },
    { status: ran.providerError ? 502 : 200 },
  )
}
