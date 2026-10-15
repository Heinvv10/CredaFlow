"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

// POSTs one lease-servicing step (app/api/asset-finance/leases/[loanId]/...)
// and reads its answer. A refusal is 409/422 (or 403/400) JSON { error,
// reason }: `error` is shown inline by the caller, `reason` is the stable code.

export type LeaseActionResult = { ok: true } | { ok: false; error: string; reason: string | null }

export async function postLeaseAction(url: string, body: Record<string, unknown>): Promise<LeaseActionResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string }
    if (res.ok) return { ok: true }
    return { ok: false, error: data.error ?? `Request failed (${res.status})`, reason: data.reason ?? null }
  } catch {
    return { ok: false, error: "Network error — try again", reason: null }
  }
}

/** Runs a step, refreshes the page on success and keeps the refusal for the caller to show. */
export function useLeaseAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (url: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    const result = await postLeaseAction(url, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    router.refresh()
    return true
  }
  return { busy, error, setError, run }
}
