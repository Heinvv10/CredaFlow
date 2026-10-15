"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { refusalText } from "./legal-matter-form"

// Also used by the recovery panel's writes.
// POSTs one legal-matter write (app/api/asset-finance/loans/[loanId]/legal-matter,
// legal-matters/[id]/...) and keeps a refusal (400/403/409 { error, fields }) for
// the form to show verbatim.

export type LegalSendResult = { ok: true } | { ok: false; error: string }

export async function sendLegal(url: string, body: FormData | Record<string, unknown>): Promise<LegalSendResult> {
  const multipart = body instanceof FormData
  try {
    const res = await fetch(url, multipart
      ? { method: "POST", body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    if (res.ok) return { ok: true }
    const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> }
    return { ok: false, error: refusalText(data.error ?? `Request failed (${res.status})`, data.fields ?? {}) }
  } catch {
    return { ok: false, error: "Network error — try again" }
  }
}

/** Runs a write, refreshes the page on success and returns whether it worked. */
export interface LegalCall { url: string; body: FormData | Record<string, unknown> }

export function useLegalAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (url: string, body: FormData | Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    const result = await sendLegal(url, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    router.refresh()
    return true
  }
  /** Runs the calls in order and stops at the first refusal (an s127 step goes through the surrender, then the recovery). */
  const runAll = async (calls: LegalCall[]): Promise<boolean> => {
    setBusy(true)
    setError(null)
    for (const call of calls) {
      const result = await sendLegal(call.url, call.body)
      if (!result.ok) {
        setBusy(false)
        setError(result.error)
        router.refresh()
        return false
      }
    }
    setBusy(false)
    router.refresh()
    return true
  }
  return { busy, error, setError, run, runAll }
}
