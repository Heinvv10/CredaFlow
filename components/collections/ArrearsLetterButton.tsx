"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"

/** Issues and sends an arrears letter on a key-facts loan, from the lender's approved template (lib/non-nca-documents/arrears-letter.ts). */
export function ArrearsLetterButton({ loanId }: { loanId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function issue() {
    setBusy(true)
    try {
      const res = await fetch(`/api/loans/${loanId}/arrears-letter`, { method: "POST" })
      const data = await res.json().catch(() => ({})) as { error?: string; deliverySummary?: string }
      if (!res.ok) {
        toast.error?.("Could not issue the letter", data.error ?? "Try again")
        return
      }
      toast.success?.("Arrears letter issued", data.deliverySummary ?? "")
      router.refresh()
    } catch {
      toast.networkError?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={issue}
      disabled={busy}
      className="px-3 py-1.5 rounded text-[12px] font-semibold border border-red-300 text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-60"
      data-testid="arrears-letter-issue"
    >
      {busy ? "Issuing…" : "Issue arrears letter"}
    </button>
  )
}
