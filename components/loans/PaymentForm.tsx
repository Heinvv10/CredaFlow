"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { toast } from "@/lib/toast"
import {
  beginPaymentAttempt,
  finishPaymentAttempt,
  PAYMENT_IDEMPOTENCY_HEADER,
  type PaymentAttempt,
} from "@/lib/payments/idempotency"
import {
  valueDatePayload,
  valueDatePrompt,
} from "@/lib/payments/value-date-payload"
import { VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS } from "@/lib/loan/value-date-limits"

interface PaymentFormProps {
  loanId: string
  /** cents payable TODAY — early settlement rebates unearned interest (s125) */
  settlementAmount: number
  /** cents owed at maturity, shown alongside so the two are never conflated */
  contractualBalance: number
  /** SAST calendar day the loan was disbursed — no money can have arrived before it */
  loanStartDay: string
  /**
   * Whether this user may authorise a back-date that writes off material
   * interest. COSMETIC ONLY — /api/payments re-checks the role and returns 403.
   * Never treat this as the authorisation itself.
   */
  canAuthoriseBackdate: boolean
  /** The label over `settlementAmount`; a lease says "Rentals outstanding" (it has no early settlement). */
  amountLabel?: string
  onSuccess?: () => void
}

export function PaymentForm({
  loanId,
  settlementAmount,
  contractualBalance,
  loanStartDay,
  canAuthoriseBackdate,
  amountLabel = "Settlement Amount Today",
  onSuccess,
}: PaymentFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [amountInput, setAmountInput] = useState("")
  // Controlled + reset on success: a stale back-dated value carried into the
  // next capture would under-accrue interest for the gap.
  const [receivedAt, setReceivedAt] = useState("")
  const [overrideReason, setOverrideReason] = useState("")
  const attemptRef = useRef<PaymentAttempt | null>(null)

  // en-CA yields YYYY-MM-DD, and the SAST zone stops a browser running behind
  // UTC offering tomorrow — or reading 00:00–01:59 SAST as yesterday.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })
  const prompt = valueDatePrompt({ receivedAt, canAuthoriseBackdate, today })

  // Anything above the settlement figure is money we will owe back, so say so
  // before staff commit rather than after.
  const enteredCents = Math.round(Number.parseFloat(amountInput) * 100)
  const refundDue = Number.isFinite(enteredCents) && enteredCents > settlementAmount
    ? enteredCents - settlementAmount
    : 0

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const amount = Math.round(Number.parseFloat(String(formData.get("amount"))) * 100)
    if (!Number.isInteger(amount) || amount <= 0) {
      setError("Enter a valid payment amount")
      return
    }
    const data = {
      loanId,
      amount,
      paymentMethod: formData.get("paymentMethod"),
      reference: formData.get("reference") || null,
      notes: formData.get("notes") || null,
      // Recomputed at submit, not reused from render: a form left open across
      // SAST midnight would otherwise judge "is this back-dated" against
      // yesterday and attach an override reason to a same-day capture.
      ...valueDatePayload({
        receivedAt,
        overrideReason,
        canAuthoriseBackdate,
        today: new Date().toLocaleDateString("en-CA", {
          timeZone: SAST_TIME_ZONE,
        }),
      }),
    }
    const idempotencyKey = beginPaymentAttempt(attemptRef, JSON.stringify(data))
    if (!idempotencyKey) return

    setLoading(true)
    setError("")
    let completed = false

    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PAYMENT_IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify(data),
      })

      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || "Failed to record payment")
      }

      completed = true
      const refundDue = body.refundDueAmount ?? 0
      if (refundDue >= data.amount) {
        // Nothing was owed, so no schedule was touched — saying otherwise would
        // tell staff the loan moved when the whole receipt is sitting unapplied.
        toast.payment.recordedFullyUnapplied(formatZAR(data.amount))
      } else if (refundDue > 0) {
        toast.payment.recordedWithRefund(formatZAR(data.amount), formatZAR(refundDue))
      } else {
        toast.payment.recorded(formatZAR(data.amount))
      }
      setAmountInput("")
      setReceivedAt("")
      setOverrideReason("")
      router.refresh()
      onSuccess?.()
    } catch (err) {
      toast.payment.failed()
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      finishPaymentAttempt(attemptRef, completed)
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</div>
      )}

      <div className="p-3 bg-gray-50 rounded-lg">
        <p className="text-sm text-gray-500">{amountLabel}</p>
        <p className="text-xl font-bold text-gray-900">{formatZAR(settlementAmount)}</p>
        {contractualBalance > settlementAmount && (
          <p className="mt-1 text-xs text-gray-500">
            {formatZAR(contractualBalance)} at maturity — settling early rebates
            the unearned interest (NCA s125).
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="amount">Payment Amount (R) *</Label>
        {/*
          Deliberately NOT capped at the settlement amount. The money has
          already arrived; a cap only stops staff recording it, leaving the
          deposit in the bank with nothing in the ledger to match it.
        */}
        <Input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          required
        />
        {refundDue > 0 && (
          <p className="mt-1 text-xs text-amber-700">
            {formatZAR(settlementAmount)} settles the loan. {formatZAR(refundDue)}{" "}
            will be recorded as a refund due to the client.
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="receivedAt">Date Received</Label>
        {/*
          The date the money reached us, not the date it is being captured.
          Interest accrues to THIS date (NCA s125(2)(b)), so a deposit banked
          last week must not be billed as if it arrived today. Blank = today.

          min/max mirror rejectImpossibleValueDate: nothing can arrive in the
          future, and nothing can arrive before the loan was disbursed. Both
          are re-checked server-side — this only saves a round trip.
        */}
        <Input
          id="receivedAt"
          name="receivedAt"
          type="date"
          value={receivedAt}
          min={loanStartDay}
          max={today}
          onChange={(e) => {
            setReceivedAt(e.target.value)
            // Drop any reason typed for a date that is no longer back-dated.
            // Left in state it survives the field unmounting, and a submit
            // after SAST midnight would re-attach an authorisation the user
            // had abandoned.
            if (
              valueDatePrompt({
                receivedAt: e.target.value,
                canAuthoriseBackdate,
                today,
              }) !== "override_reason"
            ) setOverrideReason("")
          }}
        />
        <p className="mt-1 text-xs text-gray-500">
          Leave blank if the money arrived today.
        </p>
        {prompt === "authorisation_warning" && (
          <p className="mt-1 text-xs text-amber-700">
            If back-dating this far writes off material interest, a loan
            administrator must record the reason.
          </p>
        )}
      </div>

      {prompt === "override_reason" && (
        <div>
          <Label htmlFor="valueDateOverrideReason">
            Reason for back-dating
          </Label>
          {/*
            Deliberately not required by the form. Most back-dating is an
            ordinary capture lag that stands unreviewed; only a materially
            interest-writing-off date needs this, and the rebate is not
            knowable until the server has priced the receipt. Predicting it
            here would duplicate the calculator and could disagree with it.
          */}
          <Textarea
            id="valueDateOverrideReason"
            name="valueDateOverrideReason"
            rows={2}
            value={overrideReason}
            minLength={VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500">
            Only needed if the write-off is large enough to require
            authorisation. You will be told if it is. At least{" "}
            {VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS} characters.
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="paymentMethod">Payment Method *</Label>
        <Select name="paymentMethod" defaultValue="EFT">
          <SelectTrigger>
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="EFT">EFT</SelectItem>
            <SelectItem value="CASH">Cash</SelectItem>
            <SelectItem value="DEBIT_ORDER">Debit Order</SelectItem>
            <SelectItem value="CARD">Card</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="reference">Reference Number</Label>
        <Input id="reference" name="reference" />
      </div>

      <div>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={2} />
      </div>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Recording..." : "Record Payment"}
      </Button>
    </form>
  )
}
