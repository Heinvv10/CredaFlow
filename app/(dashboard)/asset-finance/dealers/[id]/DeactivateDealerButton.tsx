"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

/** Deactivates the dealer: no new deals, every one of its users signed out. It cannot be reactivated. */
export function DeactivateDealerButton({ dealerId }: { dealerId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deactivate = async () => {
    if (!window.confirm("Deactivate this dealer? Every one of its users is signed out and it cannot originate deals. This cannot be undone.")) return
    setBusy(true)
    const result = await sendJson(`/api/asset-finance/dealers/${dealerId}`, "PATCH", { active: false })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={deactivate}>Deactivate dealer</Button>
      <FormError message={error} />
    </div>
  )
}
