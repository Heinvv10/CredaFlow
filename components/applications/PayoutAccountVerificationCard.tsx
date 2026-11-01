"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, HelpCircle } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/utils"
import { toast } from "@/lib/toast"
import { PAYOUT_VERIFICATION_NOTE_MAX, payoutVerificationNote } from "@/lib/non-nca-documents/payout-terms"

interface Props {
  applicationId: string
  accountNumber: string | null
  /** When the account on record was confirmed; null when it never was, or it changed since. */
  confirmedAt: string | null
  confirmedByYou: boolean
  canConfirm: boolean
}

/** The second person of a key-facts payout (lib/non-nca-documents/payout-account.ts): whoever confirms the account cannot pay it out. */
export function PayoutAccountVerificationCard({ applicationId, accountNumber, confirmedAt, confirmedByYou, canConfirm }: Props) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [loading, setLoading] = useState(false)

  async function confirmAccount() {
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/payout-account-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) {
        toast.success("Payout account confirmed", "The person who confirmed it cannot pay it out.")
        setNote("")
        router.refresh()
        return
      }
      toast.error(body.error ?? `The confirmation failed (${res.status})`)
    } catch {
      toast.networkError()
    } finally {
      setLoading(false)
    }
  }

  return (
    <DataPanel
      title="Payout account confirmation"
      description={accountNumber ? `Account ending ${accountNumber.slice(-4)}` : "No bank account captured"}
      actions={confirmedAt
        ? <Badge variant="success"><CheckCircle className="mr-1 h-3.5 w-3.5" />Confirmed</Badge>
        : <Badge variant="neutral"><HelpCircle className="mr-1 h-3.5 w-3.5" />Not confirmed</Badge>}
    >
      <div className="space-y-3">
        <p className="text-sm text-[var(--cf-text-secondary)]">
          {confirmedAt
            ? `Confirmed ${formatDateTime(confirmedAt)}${confirmedByYou ? " by you: someone else must pay it out." : "."}`
            : "No account verification service covers this bank. A second staff member, not the one who pays out, confirms that the account on record is the borrower's."}
        </p>
        {canConfirm && (
          <>
            <label htmlFor="payout-verification-note" className="block text-xs font-medium text-[var(--cf-text-secondary)]">How was the account confirmed?</label>
            <textarea
              id="payout-verification-note" rows={2} maxLength={PAYOUT_VERIFICATION_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
              className="w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-2 text-sm text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)]"
            />
            <Button type="button" variant="outline" onClick={confirmAccount} disabled={loading || !accountNumber || !payoutVerificationNote(note)}>
              {loading ? "Saving…" : "Confirm payout account"}
            </Button>
          </>
        )}
      </div>
    </DataPanel>
  )
}
