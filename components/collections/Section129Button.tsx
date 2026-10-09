"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"
import Link from "next/link"

interface Props {
  loanId: string
  loanRef: string
  clientName: string
}

export function Section129Button({ loanId, loanRef, clientName }: Props) {
  const router = useRouter()
  const [state, setState] = useState<"idle" | "confirm" | "sending" | "sent" | "error" | "locked" | "reconcile">("idle")
  const [message, setMessage] = useState("")
  const [issuanceId, setIssuanceId] = useState<string | null>(null)

  async function send() {
    setState("sending")
    try {
      const res = await fetch("/api/loans/section129", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId }),
      })
      const data = await res.json() as {
        ok?: boolean
        message?: string
        error?: string
        issuanceId?: string
        reconciliationRequired?: boolean
        providerAccepted?: boolean
        providerOutcome?: "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
        dispatchState?: "KNOWN_NOT_SENT" | "DELIVERY_UNCERTAIN" | "LEGAL_RECORD_RECONCILIATION_REQUIRED" | "ISSUED"
        lifecycle?: string
        recoveryRequired?: boolean
      }
      if (data.ok) {
        setState("sent")
        setMessage(data.message ?? "Section 129 notice accepted by the email provider")
        toast.section129.sent()
        // Issuance updates collectionsStage server-side — refresh so the
        // CollectionsStagePanel on this page reflects it without a reload.
        router.refresh()
      } else {
        const requiresReconciliation = data.reconciliationRequired === true
        const serverBlockedRetry = typeof data.lifecycle === "string" || data.recoveryRequired === true
        setState(requiresReconciliation ? "reconcile" : serverBlockedRetry ? "locked" : "error")
        setMessage(data.error ?? data.message ?? "Failed")
        setIssuanceId(data.issuanceId ?? null)
        toast.section129.failed()
      }
    } catch {
      // A dropped HTTP response is ambiguous from the browser's perspective:
      // the provider and server may already have completed the issuance.
      setState("locked")
      setMessage("Request outcome unknown. Refresh the loan and compliance queue before any further action.")
      setIssuanceId(null)
      toast.section129.failed()
    }
  }

  if (state === "sent") {
    return (
      <div className="text-center">
        <span className="text-[11px] text-green-600 font-semibold" title={message}>✓ Provider accepted</span>
      </div>
    )
  }

  if (state === "error") {
    return (
      <div className="text-center">
        <span className="text-[11px] text-red-500 font-semibold" title={message}>✗ Failed</span>
        <br />
        <button onClick={() => setState("idle")} className="text-[10px] text-gray-400 hover:underline">retry</button>
      </div>
    )
  }

  if (state === "reconcile") {
    return (
      <div className="max-w-56 rounded border border-amber-300 bg-amber-50 p-2 text-left">
        <p className="text-[11px] font-semibold text-amber-900">Do not retry</p>
        <p className="mt-1 text-[10px] text-amber-800" title={message}>LOAN_ADMIN reconciliation required.</p>
        {issuanceId && <p className="mt-1 break-all font-mono text-[9px] text-amber-700">{issuanceId}</p>}
        <Link href="/compliance" className="mt-1 inline-block text-[10px] font-semibold text-amber-900 underline">
          Open compliance queue
        </Link>
      </div>
    )
  }

  if (state === "locked") {
    return (
      <div className="max-w-56 rounded border border-gray-300 bg-gray-50 p-2 text-left">
        <p className="text-[11px] font-semibold text-gray-700">Notice cannot be retried</p>
        <p className="mt-1 text-[10px] text-gray-600" title={message}>{message}</p>
        {issuanceId && <p className="mt-1 break-all font-mono text-[9px] text-gray-500">{issuanceId}</p>}
      </div>
    )
  }

  if (state === "confirm") {
    return (
      <div className="flex flex-col gap-1 items-center">
        <span className="text-[10px] text-red-600 font-semibold text-center">Send to {clientName.split(" ")[0]}?</span>
        <div className="flex gap-1">
          <button
            onClick={send}
            className="px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded hover:bg-red-700"
          >Send</button>
          <button
            onClick={() => setState("idle")}
            className="px-2 py-1 border border-gray-300 text-[10px] rounded hover:bg-gray-50"
          >Cancel</button>
        </div>
      </div>
    )
  }

  if (state === "sending") {
    return (
      <div className="text-center">
        <span className="text-[11px] text-gray-500">Sending…</span>
      </div>
    )
  }

  return (
    <button
      onClick={() => setState("confirm")}
      className="px-3 py-1.5 rounded text-[12px] font-semibold text-white transition-colors bg-red-600 hover:bg-red-700"
      title={`Send Section 129 notice for ${loanRef}`}
    >
      S.129<br />Notice
    </button>
  )
}
