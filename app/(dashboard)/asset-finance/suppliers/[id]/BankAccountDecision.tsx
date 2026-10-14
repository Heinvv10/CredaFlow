"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Approve or reject a pending supplier bank account. Rendered only for a user
 * with decide_asset_finance who did not request the account; the API enforces
 * both rules again, and the database enforces the second.
 */
export function BankAccountDecision({ accountId }: { accountId: string }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<"APPROVE" | "REJECT" | null>(null)

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setSaving(decision)
    setError(null)
    const result = await sendJson(`/api/asset-finance/suppliers/bank-accounts/${accountId}/decide`, "POST", { decision, note })
    setSaving(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
      <FormError message={error} />
      <Label htmlFor={`note-${accountId}`} className="text-xs text-[var(--cf-text-secondary)]">
        How did you verify this account? (to approve), or why reject it *
      </Label>
      <p className="text-xs text-[var(--cf-text-muted)]">
        Automated AVS cannot verify a company&apos;s account yet. Approve only against independent evidence, such as a
        bank-stamped confirmation letter, and say what you checked.
      </p>
      <Textarea id={`note-${accountId}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide("APPROVE")} disabled={saving !== null}>
          {saving === "APPROVE" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("REJECT")} disabled={saving !== null}>
          {saving === "REJECT" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Reject
        </Button>
      </div>
    </div>
  )
}
