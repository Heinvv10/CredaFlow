import { prisma } from "@/lib/prisma"

export const AUTOMATED_DECLINES_PAGE_SIZE = 50

export interface AutomatedDeclineRow {
  runId: string
  applicationId: string
  reference: string | null
  /** DECLINED until a person reopens it, then the status it has moved to. */
  status: string
  decidedAt: Date
  reasonCodes: string[]
  riskGrade: string | null
  ruleSet: string
  noticeSent: boolean
}

/**
 * The lender's automated declines, newest first, for staff to review: each is
 * a decision no person took (POPIA s71), and the client may ask for a person to
 * look again (lib/decisioning/human-review.ts). One page at a time.
 */
export async function listAutomatedDeclines(tenantId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ rows: AutomatedDeclineRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, opts.limit ?? AUTOMATED_DECLINES_PAGE_SIZE), 200)
  const runs = await prisma.autoDecisionRun.findMany({
    where: { tenantId, execution: "DECLINED" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { ruleSetVersion: { select: { scopeKey: true, version: true } } },
  })
  const page = runs.slice(0, limit)
  const [applications, config] = await Promise.all([
    prisma.loanApplication.findMany({ where: { tenantId, id: { in: page.map((r) => r.applicationId) } }, select: { id: true, reference: true, status: true } }),
    prisma.decisionEngineConfig.findUnique({ where: { tenantId }, select: { s71SignedOffAt: true, automatedDeclineNotice: true } }),
  ])
  const byId = new Map(applications.map((a) => [a.id, a]))
  return {
    rows: page.map((r) => ({
      runId: r.id,
      applicationId: r.applicationId,
      reference: byId.get(r.applicationId)?.reference ?? null,
      status: byId.get(r.applicationId)?.status ?? "UNKNOWN",
      decidedAt: r.createdAt,
      reasonCodes: Array.isArray(r.reasonCodes) ? (r.reasonCodes as string[]) : [],
      riskGrade: r.riskGrade,
      ruleSet: `${r.ruleSetVersion.scopeKey}:v${r.ruleSetVersion.version}`,
      noticeSent: Boolean(config?.s71SignedOffAt && config.automatedDeclineNotice),
    })),
    nextCursor: runs.length > limit ? page[page.length - 1].id : null,
  }
}
