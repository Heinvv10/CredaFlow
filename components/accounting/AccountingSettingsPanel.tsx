"use client"

import { useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface Settings {
  mappingConfirmedAt: string | null
  goLiveMonth: string | null
  vatRegistered: boolean
  vatRateBps: number
}

/** Go-live month, VAT registration and the mapping confirmation: what must be settled before the first close. */
export function AccountingSettingsPanel({ canEdit, locked }: { canEdit: boolean; locked: boolean }) {
  const [s, setS] = useState<Settings | null>(null)
  const [goLive, setGoLive] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void fetch("/api/accounting/settings").then(async (res) => {
      if (!res.ok) return setMessage(`Could not load the settings (${res.status})`)
      const json = (await res.json()) as Settings
      setS(json)
      setGoLive(json.goLiveMonth ?? "")
    })
  }, [])

  async function send(method: "PUT" | "POST", body: Record<string, unknown>, done: string) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/accounting/settings", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as Settings & { error?: string }
      if (res.ok) {
        setS(json)
        setMessage(done)
      } else setMessage(json.error ?? `Failed (${res.status})`)
    } catch {
      setMessage("Network error; nothing was saved by this page.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DataPanel
      title="Before the first close"
      description="The go-live month (history before it posts as one opening entry), VAT, and your confirmation of the chart of accounts below."
      actions={s && <StatusPill tone={s.mappingConfirmedAt ? "success" : "warning"}>{s.mappingConfirmedAt ? "Mapping confirmed" : "Mapping not confirmed"}</StatusPill>}
    >
      {s && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-xs text-[var(--cf-text-muted)]">Go-live month</span>
              <Input id="go-live" type="month" value={goLive} disabled={!canEdit || locked} onChange={(e) => setGoLive(e.target.value)} className="w-44" />
            </label>
            {canEdit && !locked && (
              <Button size="sm" variant="outline" disabled={busy || !goLive} onClick={() => send("PUT", { goLiveMonth: goLive }, "Go-live month saved.")}>Save go-live month</Button>
            )}
            {locked && <span className="text-xs text-[var(--cf-text-muted)]">Fixed: a month has closed.</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[var(--cf-text)]">VAT-registered: {s.vatRegistered ? `yes, ${s.vatRateBps / 100}%` : "no"}</span>
            {canEdit && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => send("PUT", { vatRegistered: !s.vatRegistered, vatRateBps: 1500 }, s.vatRegistered ? "VAT split off." : "VAT-registered: fees marked VAT-inclusive split 15% to VAT output.")}>
                {s.vatRegistered ? "Turn VAT split off" : "Lender is VAT-registered"}
              </Button>
            )}
          </div>
          <p className="text-xs text-[var(--cf-text-muted)]">
            VAT is split only from fee accounts marked VAT-inclusive in the mapping. VAT credit notes (asset finance) are not exported yet.
          </p>
          {!s.mappingConfirmedAt && <InfoStrip variant="warning">No month closes until an administrator reviews the chart of accounts below and confirms it. Any later change to it needs confirming again.</InfoStrip>}
          {s.mappingConfirmedAt && <p className="text-[var(--cf-text)]">Mapping confirmed {new Date(s.mappingConfirmedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}.</p>}
          {canEdit && (
            <Button size="sm" disabled={busy} onClick={() => send("POST", { action: "confirm_mapping" }, "Mapping confirmed.")}>
              I have reviewed the mapping: confirm it
            </Button>
          )}
        </div>
      )}
      {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </DataPanel>
  )
}
