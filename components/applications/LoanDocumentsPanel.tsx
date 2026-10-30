"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, FileText, Loader2 } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

export interface LoanDocumentRow {
  kind: "KEY_FACTS_STATEMENT" | "LOAN_AGREEMENT"
  clientDocumentId: string
  pdfSha256: string
  templateVersion: number
  sample: boolean
  acknowledgedAt: string | null
}

interface Props {
  applicationId: string
  status: string
  signedAt: string | null
  documents: LoanDocumentRow[]
  /** Why the standing documents would not carry a signature now (the database's own test), or null. */
  signingProblem: string | null
  canIssue: boolean
}

const LABEL = { KEY_FACTS_STATEMENT: "Key facts statement", LOAN_AGREEMENT: "Loan agreement" } as const

/**
 * The key facts statement and loan agreement of a key-facts (non-NCA) application:
 * issued from the lender's current approved templates, read and acknowledged by the
 * borrower in the portal, signed there. Shows what stands and why a signature would
 * be refused; the database makes the same call.
 */
export function LoanDocumentsPanel({ applicationId, status, signedAt, documents, signingProblem, canIssue }: Props) {
  const router = useRouter()
  const [issuing, setIssuing] = useState(false)
  const issuable = status === "APPROVED" && !signedAt && canIssue

  async function issue() {
    setIssuing(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/non-nca-documents`, { method: "POST" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        toast.error?.("Could not issue the documents", data.error ?? "Try again")
        return
      }
      toast.success?.("Documents issued", "The borrower can now read and sign them in the portal.")
      router.refresh()
    } catch {
      toast.networkError?.()
    } finally {
      setIssuing(false)
    }
  }

  return (
    <DataPanel title="Key facts statement and loan agreement">
      <div className="space-y-4" data-testid="loan-documents-panel">
        <p className="text-sm text-[var(--cf-text-muted)]">
          This lender&rsquo;s loans are governed by a key facts statement and a loan agreement rendered from its own approved templates, not by the PASQ.
        </p>
        {documents.length === 0 ? (
          <p className="text-sm">{status === "APPROVED" ? "Nothing has been issued yet." : "Documents are issued once the application is approved."}</p>
        ) : (
          <ul className="divide-y divide-[var(--cf-border)] rounded-lg border border-[var(--cf-border)]">
            {documents.map((d) => (
              <li key={d.kind} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  <a className="font-medium underline" href={`/api/documents/${d.clientDocumentId}/view`} target="_blank" rel="noreferrer">{LABEL[d.kind]}</a>
                  <span className="text-[var(--cf-text-muted)]">template v{d.templateVersion}</span>
                  {d.sample && <span className="rounded border border-amber-600 px-1.5 text-xs font-semibold text-amber-700">SAMPLE</span>}
                </span>
                <span className="font-mono text-xs text-[var(--cf-text-muted)]">{d.pdfSha256.slice(0, 12)}</span>
                {d.kind === "KEY_FACTS_STATEMENT" && (
                  <span className={d.acknowledgedAt ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)]"}>
                    {d.acknowledgedAt ? "Acknowledged by the borrower" : "Awaiting the borrower"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {signedAt ? (
          <p className="flex items-center gap-2 text-sm text-[var(--cf-success)]"><CheckCircle className="h-4 w-4" />Signed by the borrower {new Date(signedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}</p>
        ) : documents.length > 0 && signingProblem ? (
          <p role="alert" className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-3 text-sm text-[var(--cf-danger)]">
            These documents would not carry a signature: {signingProblem}.
          </p>
        ) : null}
        {issuable && (
          <Button onClick={issue} disabled={issuing}>
            {issuing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Issuing</> : documents.length > 0 ? "Issue again from the current templates" : "Issue key facts statement and loan agreement"}
          </Button>
        )}
      </div>
    </DataPanel>
  )
}
