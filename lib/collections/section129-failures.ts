import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type Section129Failure = { failedAt: Date; reason: string }

type Row = { referenceId: string; createdAt: Date; lifecycle: string | null; failureReason: string | null; failedAt: string | null }

/**
 * Per loan, the latest Section 129 issuance when it ended FAILED (known not
 * sent), with the reason recorded on it (markSection129KnownNotSent). A later
 * attempt of any other outcome hides it. One query for the whole queue, and
 * only the three fields shown: the record's borrower snapshot (name, ID
 * number, address) is never read.
 */
export async function latestSection129Failures(
  tenantId: string,
  loanIds: readonly string[],
): Promise<Map<string, Section129Failure>> {
  if (loanIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT DISTINCT ON ("referenceId")
      "referenceId",
      "createdAt",
      "data" ->> 'lifecycle' AS "lifecycle",
      "data" ->> 'failureReason' AS "failureReason",
      "data" ->> 'failedAt' AS "failedAt"
    FROM "ComplianceRecord"
    WHERE "tenantId" = ${tenantId}
      AND "type" = 'SECTION_129_NOTICE'::"ComplianceType"
      AND "referenceId" IN (${Prisma.join([...loanIds])})
    ORDER BY "referenceId", "createdAt" DESC
  `)
  const failures = new Map<string, Section129Failure>()
  for (const row of rows) {
    if (row.lifecycle !== "FAILED") continue
    failures.set(row.referenceId, {
      failedAt: row.failedAt ? new Date(row.failedAt) : row.createdAt,
      reason: row.failureReason?.trim() ? row.failureReason : "No reason was recorded.",
    })
  }
  return failures
}
