"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { SigningOtpStep, type SigningOtpChannel } from "@/components/signing/SigningOtpStep"
import { toast } from "@/lib/toast"
import { LOAN_DOCUMENT_LABELS } from "@/lib/non-nca-documents/keys"
import type { LoanDocumentRow } from "./LoanDocumentsPanel"

interface Props {
  applicationId: string
  clientName: string
  documents: LoanDocumentRow[]
  channels: SigningOtpChannel[]
}

/**
 * A borrower in the branch: staff open the documents on this screen and the borrower reads them. The acceptance and
 * the signature are the borrower's: the one-time code goes to their own mailbox or phone and they type their own name.
 * The staff member is recorded as the witness (lib/non-nca-documents/branch-sign.ts), never as the signer.
 */
export function BranchSigningPanel({ applicationId, clientName, documents, channels }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [attested, setAttested] = useState(false)
  const [typedName, setTypedName] = useState("")
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const sha = (kind: LoanDocumentRow["kind"]) => documents.find((d) => d.kind === kind)?.pdfSha256 ?? ""
  const agreementSha = sha("LOAN_AGREEMENT")
  const ready = attested && typedName.trim().length > 2 && challengeId !== null && !busy

  async function record() {
    setBusy(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/loan-documents/branch-sign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          witnessAttested: attested, offerSha256: sha("OFFER_LETTER"), keyFactsSha256: sha("KEY_FACTS_STATEMENT"), agreementDocumentSha256: agreementSha,
          signature: typedName.trim(), signingOtpChallengeId: challengeId,
        }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; signingOtp?: string }
      if (!res.ok) {
        if (data.signingOtp) { setChallengeId(null); setAttempt((n) => n + 1) }
        toast.error?.("Could not record the signature", data.error ?? "Try again")
        return
      }
      toast.success?.("Signed by the borrower", "The offer, the key facts statement and the signature are recorded as the borrower's, with you as witness.")
      router.refresh()
    } catch {
      toast.networkError?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DataPanel title="Branch-assisted signing">
      <div className="space-y-4 text-sm" data-testid="branch-signing-panel">
        <p className="text-[var(--cf-text-muted)]">
          For a borrower here in person. They read the documents and do each step themselves: a code goes to their own mailbox or phone. You are recorded as the witness.
        </p>
        {!open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>Start branch-assisted signing</Button>
        ) : channels.length === 0 ? (
          <p role="alert" className="text-[var(--cf-danger)]">The borrower has no email address or WhatsApp number on file, so no code can reach them. Capture one first.</p>
        ) : (
          <>
            <ul className="list-disc pl-5">
              {documents.map((d) => (
                <li key={d.kind}><a className="underline" href={`/api/documents/${d.clientDocumentId}/view`} target="_blank" rel="noreferrer">{LOAN_DOCUMENT_LABELS[d.kind]}</a></li>
              ))}
            </ul>
            <label className="block">
              {clientName} types their full name
              <input
                type="text" value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={clientName}
                className="mt-1 w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2"
              />
            </label>
            <SigningOtpStep key={attempt} purpose="AGREEMENT" subjectId={applicationId} documentSha256={agreementSha} channels={channels} onVerified={setChallengeId} />
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1" />
              <span>I checked the borrower&rsquo;s identity document. They are here in person, read these documents, and are accepting and signing them themselves.</span>
            </label>
            <Button onClick={record} disabled={!ready}>
              {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Recording</> : "Record the borrower's acceptance and signature"}
            </Button>
          </>
        )}
      </div>
    </DataPanel>
  )
}
