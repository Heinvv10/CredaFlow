import { prisma } from "@/lib/prisma"
import { computeDedupHash } from "./dedup"
import type { MatchResult } from "./types"

function matchStatusFor(tier: MatchResult["tier"]): string {
  return tier === "NONE" ? "UNMATCHED" : "PROPOSED"
}

export interface PersistedTxn {
  id: string
  dedupHash: string
  matchedLoanId: string | null
  confidence: MatchResult["confidence"]
}

export async function persistTransactions(args: {
  tenantId: string
  importId: string
  results: MatchResult[]
}): Promise<{ newTxnCount: number; created: PersistedTxn[] }> {
  const created: PersistedTxn[] = []
  for (const r of args.results) {
    const dedupHash = computeDedupHash(r.line, args.tenantId)
    const existing = await prisma.bankTransaction.findUnique({
      where: { tenantId_dedupHash: { tenantId: args.tenantId, dedupHash } },
    })
    if (existing) continue
    const row = await prisma.bankTransaction.create({
      data: {
        tenantId: args.tenantId,
        importId: args.importId,
        postedDate: r.line.postedDate,
        valueDate: r.line.valueDate,
        amountCents: r.line.amountCents,
        direction: r.line.direction,
        rawReference: r.line.rawReference,
        counterparty: r.line.counterparty,
        balanceCents: r.line.balanceCents,
        bankTxnId: r.line.bankTxnId,
        dedupHash,
        matchStatus: matchStatusFor(r.tier),
        matchConfidence: r.confidence,
        matchedLoanId: r.matchedLoanId,
      },
    })
    created.push({ id: row.id, dedupHash, matchedLoanId: r.matchedLoanId, confidence: r.confidence })
  }
  return { newTxnCount: created.length, created }
}
