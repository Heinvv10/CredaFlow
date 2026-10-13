import type { CreditCheck } from "@prisma/client"
import type { AuthenticityFacts, StatementRead } from "@/lib/statement-analysis/types"

/** One bank statement as the checks see it: its stored read, or why there is none. */
export interface StatementFacts {
  documentId: string
  /** StatementAnalysis.id of the read these facts come from. */
  analysisId: string | null
  /** The bytes that were read: with documentId, the identity of the evidence. */
  contentSha256: string | null
  state: "READ" | "UNREADABLE" | "UNSUPPORTED" | "PENDING"
  /** Why a PENDING statement has no read yet. */
  pendingReason?: "vlm" | "consent" | "file_missing"
  method: "TEXT" | "VLM" | null
  bank: string | null
  read: StatementRead | null
  balanceCheck: "PASS" | "FAIL" | "NOT_APPLICABLE" | null
  authenticity: AuthenticityFacts | null
}

export interface PayslipFacts {
  documentId: string
  /** Every money field passed applyPayslipPostProcessing (validated === true). */
  validated: boolean
  netPayCents: number | null
  payDate: string | null
}

export interface DebtFacts {
  name: string
  monthlyInstalmentCents: number
  source: "DECLARED" | "BUREAU"
}

export interface ApplicationFacts {
  applicationId: string
  /** YYYY-MM-DD: submitted, else created. */
  applicationDate: string
  clientName: string
  /** Validated net pay if there is one, else the client's captured income. */
  monthlyIncomeCents: number | null
  statements: StatementFacts[]
  payslip: PayslipFacts | null
  debts: DebtFacts[]
}

/**
 * The evidence key for a statement: its document and exact bytes. Not the
 * StatementAnalysis id, so re-reading the same bytes with a newer parser keeps
 * a cleared finding cleared.
 */
export function statementKey(s: Pick<StatementFacts, "documentId" | "contentSha256">): string {
  return `${s.documentId}:${s.contentSha256 ?? "unread"}`
}

export interface FlagCandidate {
  check: CreditCheck
  code: string
  /** What makes this flag this flag: hashed with the code into the fingerprint. */
  key: string
  summary: string
  evidence: Record<string, unknown>
}
