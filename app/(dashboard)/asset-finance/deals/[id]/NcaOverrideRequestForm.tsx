"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

const MIN_REASON = 10

/** Asks for the NCA → NON_NCA override with a reason; a second user decides it. */
export function NcaOverrideRequestForm({ applicationId }: { applicationId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (reason.trim().length < MIN_REASON) {
      setError(`Give the reason in at least ${MIN_REASON} characters`)
      return
    }
    setSaving(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/applications/${applicationId}/nca-overrides`, "POST", {
      toRegime: "NON_NCA",
      reason,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpen(false)
    setReason("")
    router.refresh()
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Request NCA regime override
      </Button>
    )
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
      <FormError message={error} />
      <Label htmlFor="override-reason" className="text-xs text-[var(--cf-text-secondary)]">
        Why is this deal outside the NCA? Name the evidence (e.g. audited turnover, Letters of Authority) *
      </Label>
      <Textarea id="override-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="text-xs text-[var(--cf-text-muted)]">
        The application stays NCA until a different user with the decide permission approves the request.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Request override to NON_NCA
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
