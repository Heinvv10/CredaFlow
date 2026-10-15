"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

// The tenant's bureau enquiry settings (app/api/settings/bureau). The server
// validates everything; this form only arranges it.

interface ProviderView {
  id: string
  displayName: string
  implemented: boolean
  approvalBureau: boolean
  credentialFields: string[]
  credentialsConfigured: boolean
}

interface SettingsView {
  bureauProviderOrder: string[]
  bureauMaxAgeDays: number
  credentialsReadable: boolean
  providers: ProviderView[]
}

type Message = { kind: "success" | "error"; text: string } | null

function MessageLine({ message }: { message: Message }) {
  if (!message) return null
  return (
    <span className={`text-sm ${message.kind === "success" ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>
      {message.text}
    </span>
  )
}

export function BureauSettingsForm() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [maxAge, setMaxAge] = useState("")
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [message, setMessage] = useState<Message>(null)
  const [saving, setSaving] = useState(false)

  const apply = useCallback((data: SettingsView) => {
    setView(data)
    setOrder(data.bureauProviderOrder)
    setMaxAge(String(data.bureauMaxAgeDays))
  }, [])

  useEffect(() => {
    fetch("/api/settings/bureau")
      .then(async (res) => (res.ok ? apply(await res.json()) : setMessage({ kind: "error", text: "Failed to load the bureau settings." })))
      .catch(() => setMessage({ kind: "error", text: "Failed to load the bureau settings." }))
  }, [apply])

  async function save(body: Record<string, unknown>, done: string) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/bureau", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        apply(data)
        setDrafts({})
        setMessage({ kind: "success", text: done })
      } else {
        setMessage({ kind: "error", text: data.error ?? "Failed to save the bureau settings." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the bureau settings." })
    } finally {
      setSaving(false)
    }
  }

  if (!view) {
    return message ? <MessageLine message={message} /> : <p className="text-sm text-[var(--cf-text-muted)]">Loading bureau settings…</p>
  }

  const byId = new Map(view.providers.map((p) => [p.id, p]))
  const available = view.providers.filter((p) => !order.includes(p.id))
  const move = (index: number, by: -1 | 1) => setOrder((current) => {
    const next = [...current]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item)
    return next
  })
  const withCredentials = view.providers.filter((p) => p.credentialFields.length > 0)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Credit bureaus</CardTitle>
          <CardDescription>
            The bureau asked first on every application, then the fallbacks in order when it fails or times out.
            Only bureaus marked “approval” can support an approval; the others are skipped for applications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-2">
            {order.map((id, index) => {
              const provider = byId.get(id)
              return (
                <li key={id} className="flex items-center gap-3 rounded-md border border-[var(--cf-border-subtle)] p-2">
                  <span className="w-20 text-xs text-[var(--cf-text-muted)]">{index === 0 ? "Primary" : `Fallback ${index}`}</span>
                  <span className="flex-1 text-sm text-[var(--cf-text)]">
                    {provider?.displayName ?? id}
                    {provider?.approvalBureau ? " · approval" : " · not used for applications"}
                    {provider && !provider.implemented ? " · awaiting specification" : ""}
                  </span>
                  <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>Up</Button>
                  <Button type="button" variant="outline" size="sm" disabled={index === order.length - 1} onClick={() => move(index, 1)}>Down</Button>
                  <Button type="button" variant="outline" size="sm" disabled={order.length === 1} onClick={() => setOrder(order.filter((x) => x !== id))}>Remove</Button>
                </li>
              )
            })}
          </ol>
          {available.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {available.map((p) => (
                <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => setOrder([...order, p.id])}>
                  Add {p.displayName}
                </Button>
              ))}
            </div>
          )}
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="bureauMaxAgeDays">Report freshness (days)</Label>
            <Input id="bureauMaxAgeDays" type="number" inputMode="numeric" min={1} max={60} step={1}
              value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />
            <p className="text-sm text-[var(--cf-text-muted)]">An older report cannot support approval, signing or payout. 1–60.</p>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={saving} onClick={() => save({ bureauProviderOrder: order, bureauMaxAgeDays: Number(maxAge) }, "Bureau settings saved.")}>
              {saving ? "Saving…" : "Save bureau settings"}
            </Button>
            <MessageLine message={message} />
          </div>
        </CardContent>
      </Card>

      {withCredentials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bureau credentials</CardTitle>
            <CardDescription>
              Stored encrypted and never shown again. Enter every field to replace a bureau’s credentials.
              {!view.credentialsReadable && " The stored credentials cannot be read on this server (encryption key missing)."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {withCredentials.map((p) => (
              <div key={p.id} className="space-y-3">
                <p className="text-sm font-medium text-[var(--cf-text)]">
                  {p.displayName} — {p.credentialsConfigured ? "credentials stored" : "no credentials"}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {p.credentialFields.map((field) => (
                    <div key={field} className="space-y-1">
                      <Label htmlFor={`${p.id}-${field}`}>{field}</Label>
                      <Input id={`${p.id}-${field}`} type="password" autoComplete="new-password"
                        value={drafts[p.id]?.[field] ?? ""}
                        onChange={(e) => setDrafts({ ...drafts, [p.id]: { ...drafts[p.id], [field]: e.target.value } })} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={() => save({ credentials: { [p.id]: drafts[p.id] ?? {} } }, `${p.displayName} credentials saved.`)}>
                    Save credentials
                  </Button>
                  {p.credentialsConfigured && (
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => save({ credentials: { [p.id]: null } }, `${p.displayName} credentials removed.`)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
