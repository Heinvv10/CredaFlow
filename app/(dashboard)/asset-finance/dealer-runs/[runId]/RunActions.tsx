"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Approve (not the creator), record as paid with the lender's EFT reference
 * (and, for a run with VAT, the dealer's own tax invoice number and date), or
 * cancel a run. The API and the database enforce every rule again.
 */
export function RunActions(props: { runId: string; status: string; canApprove: boolean; needsTaxInvoice: boolean }) {
  const router = useRouter()
  const [reference, setReference] = useState("")
  const [invoice, setInvoice] = useState("")
  const [invoiceDate, setInvoiceDate] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = `/api/asset-finance/dealer-runs/${props.runId}`

  const post = async (action: "approve" | "release" | "cancel", body: unknown = {}) => {
    if (action === "cancel" && !window.confirm("Cancel this run? Its lines become free for a new run.")) return
    setBusy(action)
    setError(null)
    const result = await sendJson(`${base}/${action}`, "POST", body)
    setBusy(null)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }
  const spinner = (action: string) => busy === action && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />

  return (
    <div className="space-y-3">
      <FormError message={error} />
      {props.status === "PENDING_APPROVAL" && (props.canApprove ? (
        <Button size="sm" disabled={busy !== null} onClick={() => post("approve")}>{spinner("approve")}Approve run</Button>
      ) : (
        <p className="text-xs text-[var(--cf-warning)]">You created this run; a different user must approve it.</p>
      ))}
      {props.status === "APPROVED" && (
        <div className="flex max-w-3xl flex-wrap items-end gap-2">
          <TextField id="release-reference" label="Your EFT reference for this payment" required value={reference} onChange={setReference} />
          {props.needsTaxInvoice && (
            <>
              <TextField id="release-tax-invoice" label="Dealer's tax invoice number" required value={invoice} onChange={setInvoice} />
              <TextField id="release-tax-invoice-date" label="Tax invoice date" type="date" required value={invoiceDate} onChange={setInvoiceDate} />
            </>
          )}
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => post("release", {
              releaseReference: reference,
              ...(props.needsTaxInvoice ? { taxInvoiceReference: invoice, taxInvoiceDate: invoiceDate } : {}),
            })}
          >
            {spinner("release")}Record as paid
          </Button>
        </div>
      )}
      {(props.status === "PENDING_APPROVAL" || props.status === "APPROVED") && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => post("cancel")}>{spinner("cancel")}Cancel run</Button>
      )}
    </div>
  )
}
