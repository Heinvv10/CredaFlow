import { createHash } from "crypto"
import type { ParsedStatementLine } from "./types"

export function computeDedupHash(line: ParsedStatementLine, tenantId: string): string {
  const basis = line.bankTxnId
    ? `${tenantId}|id|${line.bankTxnId}`
    : [
        tenantId,
        line.postedDate.toISOString().slice(0, 10),
        line.amountCents,
        (line.rawReference ?? "").trim().toLowerCase(),
        line.balanceCents ?? "",
      ].join("|")
  return createHash("sha256").update(basis).digest("hex")
}
