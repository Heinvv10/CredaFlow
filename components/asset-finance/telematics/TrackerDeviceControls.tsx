"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/** Register a tracker device on the asset (manage_asset_finance). The simulator is the only provider in this release. */
export function RegisterTrackerDevice({ assetId, providers }: { assetId: string; providers: { id: string; label: string }[] }) {
  const router = useRouter()
  const [provider, setProvider] = useState(providers[0]?.id ?? "")
  const [externalDeviceId, setExternalDeviceId] = useState("")
  const [installedOn, setInstalledOn] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(`/api/asset-finance/assets/${assetId}/tracker-devices`, "POST", { provider, externalDeviceId, installedOn })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setExternalDeviceId("")
    setInstalledOn("")
    router.refresh()
  }

  return (
    <div className="space-y-3 border-t border-[var(--cf-border-subtle)] pt-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">Register a tracker device</h3>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor="trackerProvider" className="text-sm font-medium text-[var(--cf-text)]">Provider</label>
          <select id="trackerProvider" value={provider} onChange={(e) => setProvider(e.target.value)}
            className="h-9 w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface)] px-2 text-sm text-[var(--cf-text)]">
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {fields.provider && <p className="text-xs text-[var(--cf-danger)]">{fields.provider}</p>}
        </div>
        <TextField id="externalDeviceId" label="Device id" required value={externalDeviceId} onChange={setExternalDeviceId} placeholder="SIM-STEADY-0001" error={fields.externalDeviceId} />
        <TextField id="installedOn" label="Installed on" type="date" required value={installedOn} onChange={setInstalledOn} error={fields.installedOn} />
      </div>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Registering…" : "Register device"}
      </Button>
    </div>
  )
}

/** Remove a live device today (once; audited). */
export function RemoveTrackerDevice({ deviceId }: { deviceId: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const remove = async () => {
    setSaving(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/tracker-devices/${deviceId}/remove`, "POST", {})
    setSaving(false)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={remove} disabled={saving}>{saving ? "Removing…" : "Remove"}</Button>
      {error && <span role="alert" className="text-xs text-[var(--cf-danger)]">{error}</span>}
    </span>
  )
}
