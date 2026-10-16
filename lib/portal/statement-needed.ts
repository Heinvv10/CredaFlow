import type { prisma } from "@/lib/prisma"
import { statementWindowStart } from "@/lib/credit-checks/policy"

type Db = Pick<typeof prisma, "loanApplication" | "clientDocument">

/** Applications still waiting on a decision: the ones the credit checks will run for. */
const UNDECIDED = ["SUBMITTED", "UNDER_REVIEW"] as const

/**
 * When a client's undecided application has no bank statement in the window
 * its credit checks read (lib/credit-checks/load-facts.ts), the check raises
 * NO_STATEMENT and approval is blocked until one arrives. The portal must ask
 * for it rather than report the documents complete because an older statement
 * satisfied KYC (Fair Score audit 2026-10-16, a returning client).
 *
 * Returns the instant from which an upload satisfies every such application
 * (the latest window start), or null when none needs one.
 */
export async function recentStatementSince(db: Db, tenantId: string, clientId: string): Promise<Date | null> {
  const applications = await db.loanApplication.findMany({
    where: { tenantId, clientId, status: { in: [...UNDECIDED] } },
    select: { createdAt: true },
  })
  if (applications.length === 0) return null
  const statements = await db.clientDocument.findMany({
    where: { tenantId, clientId, docType: "BANK_STATEMENT", deletedAt: null },
    select: { createdAt: true },
  })
  const unmet = applications
    .map((application) => statementWindowStart(application.createdAt))
    .filter((since) => !statements.some((statement) => statement.createdAt >= since))
  if (unmet.length === 0) return null
  return new Date(Math.max(...unmet.map((since) => since.getTime())))
}
