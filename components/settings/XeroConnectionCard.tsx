"use client"

import { useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"

interface XeroStatus {
  configured: boolean
  status: "PENDING_AUTH" | "SELECT_ORGANISATION" | "CONNECTED" | "DISCONNECTED"
  organisationName: string | null
  organisations: Array<{ tenantId: string; tenantName: string }>
  connectedAt: string | null
}

const RETURN_MESSAGES: Record<string, string> = {
  connected: "Xero is connected.",
  select: "Choose which Xero organisation receives the journals.",
  error: "Xero did not connect. Nothing was changed; try again.",
}

/** Settings → Integrations → Xero (ADMIN). Not yet proven against a live Xero app. */
export function XeroConnectionCard({ returned }: { returned: string | null }) {
  const [state, setState] = useState<XeroStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(returned ? RETURN_MESSAGES[returned] ?? null : null)

  useEffect(() => {
    void fetch("/api/integrations/xero").then(async (res) => {
      if (res.ok) setState((await res.json()) as XeroStatus)
      else setMessage(res.status === 403 ? "Only an administrator can manage the Xero connection." : `Could not load Xero status (${res.status})`)
    })
  }, [])

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/integrations/xero", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as Partial<XeroStatus> & { url?: string; error?: string }
      if (!res.ok) return setMessage(json.error ?? `Failed (${res.status})`)
      if (json.url) {
        window.location.assign(json.url)
        return
      }
      setState(json as XeroStatus)
      setMessage(body.action === "disconnect" ? "Xero disconnected." : "Organisation selected.")
    } catch {
      setMessage("Network error; refresh to see the current state.")
    } finally {
      setBusy(false)
    }
  }

  const connected = state?.status === "CONNECTED"
  return (
    <DataPanel
      title="Xero"
      description="Push each closed month's journals to Xero as a draft manual journal (Reports → Accounting export)."
      actions={state && <StatusPill tone={connected ? "success" : "neutral"}>{connected ? "Connected" : state.status === "SELECT_ORGANISATION" ? "Choose organisation" : "Not connected"}</StatusPill>}
    >
      {state && !state.configured && (
        <InfoStrip variant="warning" className="mb-3">
          Xero is not set up on this deployment (XERO_CLIENT_ID and XERO_REDIRECT_URI). It needs a Xero developer app.
        </InfoStrip>
      )}
      {connected && <p className="mb-3 text-sm text-[var(--cf-text)]">Organisation: <span className="font-medium">{state.organisationName}</span></p>}
      {state?.status === "SELECT_ORGANISATION" && (
        <div className="mb-3 flex flex-wrap gap-2">
          {state.organisations.map((o) => (
            <Button key={o.tenantId} size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "select", xeroTenantId: o.tenantId })}>{o.tenantName}</Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !state?.configured} onClick={() => act({ action: "connect" })}>{connected ? "Reconnect Xero" : "Connect Xero"}</Button>
        {state && state.status !== "DISCONNECTED" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "disconnect" })}>Disconnect</Button>
        )}
      </div>
      {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </DataPanel>
  )
}
