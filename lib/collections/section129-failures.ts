import { prisma } from "@/lib/prisma"

export type Section129Failure = { failedAt: Date; reason: string }

/**
 * Per loan, the latest Section 129 issuance when it ended FAILED (known not
 * sent), with the reason recorded on it (markSection129KnownNotSent). A later
 * attempt of any other outcome hides it. One query for the whole queue.
 */
export async function latestSection129Failures(
  tenantId: string,
  loanIds: readonly string[],
): Promise<Map<string, Section129Failure>> {
  if (loanIds.length === 0) return new Map()
  const records = await prisma.complianceRecord.findMany({
    where: { tenantId, type: "SECTION_129_NOTICE", referenceId: { in: [...loanIds] } },
    orderBy: { createdAt: "desc" },
    select: { referenceId: true, data: true, createdAt: true },
  })
  const failures = new Map<string, Section129Failure>()
  const seen = new Set<string>()
  for (const record of records) {
    if (!record.referenceId || seen.has(record.referenceId)) continue
    seen.add(record.referenceId)
    const data = record.data as { lifecycle?: unknown; failureReason?: unknown; failedAt?: unknown } | null
    if (data?.lifecycle !== "FAILED") continue
    failures.set(record.referenceId, {
      failedAt: typeof data.failedAt === "string" ? new Date(data.failedAt) : record.createdAt,
      reason: typeof data.failureReason === "string" && data.failureReason.trim() ? data.failureReason : "No reason was recorded.",
    })
  }
  return failures
}
