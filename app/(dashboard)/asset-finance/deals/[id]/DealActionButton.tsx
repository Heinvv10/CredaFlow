"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

/** POSTs an empty body to a deal action route (submit, bureau checks) and refreshes the page. */
export function DealActionButton(props: { url: string; label: string; busyLabel: string; variant?: "default" | "outline" }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(props.url, "POST", {})
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant={props.variant ?? "default"} onClick={run} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? props.busyLabel : props.label}
      </Button>
      <FormError message={error} />
    </div>
  )
}
