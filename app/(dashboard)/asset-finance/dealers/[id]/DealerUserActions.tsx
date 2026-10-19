"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"
import { OneTimeLink } from "./OneTimeLink"

/** Deactivate a dealer user, or issue a fresh set-password link; both end the user's sessions. */
export function DealerUserActions({ dealerId, userId }: { dealerId: string; userId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const base = `/api/asset-finance/dealers/${dealerId}/users/${userId}`

  const post = async (action: "deactivate" | "reset-link") => {
    if (action === "deactivate" && !window.confirm("Deactivate this dealer user? Their sessions end and they cannot sign in again.")) return
    setBusy(true)
    setError(null)
    const result = await sendJson(`${base}/${action}`, "POST", {})
    setBusy(false)
    if (!result.ok) return setError(result.error)
    if (action === "reset-link") {
      const body = result.body as { setPasswordUrl: string; expiresAt: string }
      setLink({ url: body.setPasswordUrl, expiresAt: body.expiresAt })
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => post("reset-link")}>New password link</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => post("deactivate")}>Deactivate</Button>
      </div>
      {link && <OneTimeLink url={link.url} expiresAt={link.expiresAt} />}
      <FormError message={error} />
    </div>
  )
}
