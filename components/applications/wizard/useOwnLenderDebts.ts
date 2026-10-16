"use client"

import { useEffect, useMemo, useState } from "react"
import type { ClientForAffordability } from "./Step3Affordability"

type OwnView = Pick<ClientForAffordability, "debtObligations" | "ownLenderArrears">

/**
 * The selected client's affordability inputs with their obligations to this
 * lender added (GET /api/clients/[id]/own-lender-debts), fetched for that
 * client only. Until it answers, the declared debts alone.
 */
export function useOwnLenderDebts(client: ClientForAffordability | null, clientId: string): ClientForAffordability | null {
  const [own, setOwn] = useState<{ clientId: string; view: OwnView } | null>(null)
  useEffect(() => {
    if (!clientId) return
    let current = true
    fetch(`/api/clients/${clientId}/own-lender-debts`)
      .then((res) => (res.ok ? res.json() as Promise<OwnView> : null))
      .then((view) => { if (current && view) setOwn({ clientId, view }) })
      .catch(() => { if (current) setOwn(null) })
    return () => { current = false }
  }, [clientId])
  // Stable identity: Step 3 re-runs its calculation whenever this changes.
  return useMemo(
    () => (client && own?.clientId === clientId ? { ...client, ...own.view } : client),
    [client, own, clientId],
  )
}
