"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface Props {
  loanId: string
  loanRef: string
  clientName: string
}

type Section129Response = {
  ok?: boolean
  message?: string
  error?: string
  issuanceId?: string
  simulated?: boolean
  reconciliationRequired?: boolean
  lifecycle?: string
  recoveryRequired?: boolean
}

type State = "idle" | "sending" | "sent" | "simulated" | "error" | "locked" | "reconcile"

export function Section129Button({ loanId, loanRef, clientName }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>("idle")
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
      const data = await res.json().catch(() => ({})) as Section129Response
      setOpen(false)
      if (data.ok) {
        setState(data.simulated ? "simulated" : "sent")
        setMessage(data.message ?? "Section 129 notice accepted by the email provider")
        if (data.simulated) toast.section129.simulated()
        else toast.section129.sent()
        // Issuance updates collectionsStage server-side — refresh so the
        // CollectionsStagePanel on this page reflects it without a reload.
        router.refresh()
        return
      }
      const requiresReconciliation = data.reconciliationRequired === true
      const serverBlockedRetry = typeof data.lifecycle === "string" || data.recoveryRequired === true
      const reason = data.error ?? data.message ?? `The notice was not sent (HTTP ${res.status}).`
      setState(requiresReconciliation ? "reconcile" : serverBlockedRetry ? "locked" : "error")
      setMessage(reason)
      setIssuanceId(data.issuanceId ?? null)
      toast.section129.failed(reason)
      // A known-not-sent failure is recorded on the account; show it there too.
      router.refresh()
    } catch {
      // A dropped HTTP response is ambiguous from the browser's perspective:
      // the provider and server may already have completed the issuance.
      setOpen(false)
      setState("locked")
      setMessage("Request outcome unknown. Refresh the loan and compliance queue before any further action.")
      setIssuanceId(null)
      toast.section129.failed()
    }
  }

  if (state === "sent" || state === "simulated") {
    return (
      <div className="max-w-56 text-left">
        <span className="text-[11px] font-semibold text-green-600">
          {state === "simulated" ? "✓ Simulated (not sent)" : "✓ Provider accepted"}
        </span>
        <p className="mt-0.5 text-[10px] text-gray-500">{message}</p>
      </div>
    )
  }

  if (state === "error") {
    return (
      <div role="alert" className="max-w-56 rounded border border-red-200 bg-red-50 p-2 text-left">
        <p className="text-[11px] font-semibold text-red-700">Notice not sent</p>
        <p className="mt-1 text-[10px] text-red-700">{message}</p>
        <button onClick={() => setState("idle")} className="mt-1 text-[10px] font-semibold text-gray-600 underline">Try again</button>
      </div>
    )
  }

  if (state === "reconcile") {
    return (
      <div className="max-w-56 rounded border border-amber-300 bg-amber-50 p-2 text-left">
        <p className="text-[11px] font-semibold text-amber-900">Do not retry</p>
        <p className="mt-1 text-[10px] text-amber-800">LOAN_ADMIN reconciliation required. {message}</p>
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
        <p className="mt-1 text-[10px] text-gray-600">{message}</p>
        {issuanceId && <p className="mt-1 break-all font-mono text-[9px] text-gray-500">{issuanceId}</p>}
      </div>
    )
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={state === "sending"}
        className="px-3 py-1.5 rounded text-[12px] font-semibold text-white transition-colors bg-red-600 hover:bg-red-700 disabled:opacity-60"
        title={`Send Section 129 notice for ${loanRef}`}
      >
        {state === "sending" ? "Sending…" : <>S.129<br />Notice</>}
      </button>
      <Dialog open={open} onOpenChange={(next) => { if (state !== "sending") setOpen(next) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send a Section 129 notice?</DialogTitle>
            <DialogDescription>
              The statutory default notice for {loanRef} goes to {clientName} by email. It is a legal
              document: once sent it cannot be withdrawn.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={state === "sending"}>Cancel</Button>
            <Button onClick={send} disabled={state === "sending"} className="bg-red-600 text-white hover:bg-red-700">
              {state === "sending" ? "Sending…" : "Send notice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
