"use client"

import { useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"

interface PayoutSettings {
  payoutsEngineEnabled: boolean
  payoutProvider: string | null
  providers: Array<{ id: string; displayName: string; implemented: boolean; statusQuery: boolean }>
}

/** Settings → Integrations → Payouts (ADMIN): which channel pays disbursements, and whether it is on. */
export function PayoutSettingsCard() {
  const [settings, setSettings] = useState<PayoutSettings | null>(null)
  const [provider, setProvider] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void fetch("/api/settings/payouts").then(async (res) => {
      if (!res.ok) return setMessage(res.status === 403 ? "Only an administrator can manage payouts." : `Could not load payout settings (${res.status})`)
      const json = (await res.json()) as PayoutSettings
      setSettings(json)
      setProvider(json.payoutProvider ?? "")
    })
  }, [])

  async function save(enabled: boolean) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/payouts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payoutsEngineEnabled: enabled, payoutProvider: provider || null }),
      })
      const json = (await res.json().catch(() => ({}))) as PayoutSettings & { error?: string }
      if (res.ok) {
        setSettings(json)
        setMessage(enabled ? "Disbursements now pay out through the selected channel." : "Payout channel off: disbursements are recorded and paid outside the system, as before.")
      } else setMessage(json.error ?? `Failed (${res.status})`)
    } catch {
      setMessage("Network error; nothing was saved by this page.")
    } finally {
      setBusy(false)
    }
  }

  const on = settings?.payoutsEngineEnabled === true
  return (
    <DataPanel
      title="Payouts"
      description="When on, disbursing a loan sends the payout to the client's verified bank account through this channel. An unknown outcome is never retried; staff resolve it on the loan page."
      actions={settings && <StatusPill tone={on ? "success" : "neutral"}>{on ? "On" : "Off"}</StatusPill>}
    >
      {settings && (
        <div className="space-y-3">
          <label className="block text-sm text-[var(--cf-text)]" htmlFor="payout-provider">Channel</label>
          <select
            id="payout-provider"
            className="w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-2 text-sm text-[var(--cf-text)]"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">None</option>
            {settings.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.implemented}>{p.displayName}{p.implemented ? "" : " (not available yet)"}</option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !provider} onClick={() => save(true)}>{on ? "Save" : "Turn payouts on"}</Button>
            {on && <Button size="sm" variant="outline" disabled={busy} onClick={() => save(false)}>Turn off</Button>}
          </div>
        </div>
      )}
      {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </DataPanel>
  )
}
