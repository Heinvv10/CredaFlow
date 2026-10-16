"use client"

import { useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface IsaFlowStatus {
  configured: boolean
  allowedOrigins: string[]
  status: "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED"
  baseUrl: string | null
  companyName: string | null
  connectedAt: string | null
  lastVerifiedAt: string | null
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : "never")

/** Settings → Integrations → IsaFlow. ADMIN sees it; a SUPER_ADMIN signed in with 2FA changes it. */
export function IsaFlowConnectionCard() {
  const [state, setState] = useState<IsaFlowStatus | null>(null)
  const [baseUrl, setBaseUrl] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void fetch("/api/integrations/isaflow").then(async (res) => {
      if (!res.ok) return setMessage(res.status === 403 ? "Only an administrator can see the IsaFlow connection." : `Could not load IsaFlow status (${res.status})`)
      const json = (await res.json()) as IsaFlowStatus
      setState(json)
      setBaseUrl(json.baseUrl ?? json.allowedOrigins[0] ?? "")
    })
  }, [])

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/integrations/isaflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as Partial<IsaFlowStatus> & { error?: string }
      if (!res.ok) return setMessage(res.status === 403 && !json.error ? "Only a SUPER_ADMIN signed in with two-factor authentication can change IsaFlow." : json.error ?? `Failed (${res.status})`)
      setState(json as IsaFlowStatus)
      setToken("")
      setMessage(done)
    } catch {
      setMessage("Network error; refresh to see the current state.")
    } finally {
      setBusy(false)
    }
  }

  const connected = state?.status === "CONNECTED"
  return (
    <DataPanel
      title="IsaFlow"
      description="Push each closed month's journals to IsaFlow as one draft journal (Reports → Accounting export). Nothing is posted in IsaFlow until your accountant posts it."
      actions={state && <StatusPill tone={connected ? "success" : state.status === "NEEDS_RECONNECT" ? "warning" : "neutral"}>{connected ? "Connected" : state.status === "NEEDS_RECONNECT" ? "Needs reconnect" : "Not connected"}</StatusPill>}
    >
      {state && !state.configured && (
        <InfoStrip variant="warning" className="mb-3">IsaFlow is not set up on this deployment (ISAFLOW_ALLOWED_ORIGINS).</InfoStrip>
      )}
      {state?.status === "NEEDS_RECONNECT" && (
        <InfoStrip variant="warning" className="mb-3">IsaFlow refused the token. Connect again with a new token; nothing is pushed until then.</InfoStrip>
      )}
      {connected && (
        <dl className="mb-3 grid gap-1 text-sm text-[var(--cf-text)] sm:grid-cols-[auto_1fr] sm:gap-x-4">
          <dt className="text-[var(--cf-text-muted)]">Company</dt><dd className="font-medium break-words">{state.companyName}</dd>
          <dt className="text-[var(--cf-text-muted)]">Address</dt><dd className="break-all">{state.baseUrl}</dd>
          <dt className="text-[var(--cf-text-muted)]">Last verified</dt><dd>{when(state.lastVerifiedAt)}</dd>
        </dl>
      )}
      {state?.configured && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input aria-label="IsaFlow address" placeholder="https://…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <Input aria-label="IsaFlow personal access token" type="password" autoComplete="off" placeholder="pat_… (write:journals, read:reports)" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !baseUrl.trim() || !token.trim()} onClick={() => act({ action: "connect", baseUrl, token }, "IsaFlow is connected.")}>
              {connected ? "Replace token" : "Connect IsaFlow"}
            </Button>
            {connected && <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "verify" }, "IsaFlow answered: the token still works.")}>Verify</Button>}
            {state.status !== "DISCONNECTED" && <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "disconnect" }, "IsaFlow disconnected. Revoke the token in IsaFlow too.")}>Disconnect</Button>}
          </div>
        </div>
      )}
      {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </DataPanel>
  )
}
