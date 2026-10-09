"use client"

import { useEffect, useState } from "react"
import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
import { duplicateNotice, type ClientLookupResult } from "@/lib/clients/duplicate-notice"

interface Props {
  idNumber: string
  /**
   * Staff only. The lookup requires CREDIT_OFFICER, so in portal mode this
   * would 403 on every keystroke — and a consumer-facing ID oracle is not
   * something to build by accident.
   */
  enabled: boolean
}

/**
 * Warns, while the operator is still on step 1, that this ID is already on the
 * book — instead of letting them fill in four steps and meet a conflict on
 * submit.
 *
 * Advisory ONLY. Two operators can pass this check in the same moment, so the
 * unique index and the 409 in POST /api/clients remain the authority. Nothing
 * here blocks the form.
 */
export function DuplicateIdWarning({ idNumber, enabled }: Props) {
  // The answer is stored WITH the ID it describes. An operator fixing a typo
  // can have several lookups in flight, and the reply for the number they have
  // already moved off must not be rendered against the one now in the box.
  // Pairing them also means the effect never has to clear state synchronously
  // to stay honest — a stale answer simply stops matching.
  const [entry, setEntry] = useState<{ idNumber: string; result: ClientLookupResult } | null>(null)

  useEffect(() => {
    if (!enabled || !isValidSaIdNumber(idNumber)) return

    let live = true
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/clients/lookup?idNumber=${encodeURIComponent(idNumber)}`)
        if (!res.ok) return
        const body = (await res.json()) as ClientLookupResult
        if (live) setEntry({ idNumber, result: body })
      } catch {
        // A failed lookup must stay silent. Claiming "already registered"
        // because the network blipped would stop a legitimate client being
        // captured, and the submit path catches the real case anyway.
      }
    }, 300)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [idNumber, enabled])

  const notice = duplicateNotice(entry && entry.idNumber === idNumber ? entry.result : null)
  if (!notice.show) return null

  return (
    <div
      role="status"
      className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      {notice.message}
      {notice.clientId && (
        <>
          {" "}
          <a href={`/clients/${notice.clientId}`} className="font-semibold underline">
            Open this client
          </a>
        </>
      )}
    </div>
  )
}
