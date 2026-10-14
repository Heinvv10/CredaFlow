"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS, type WebhookEventType } from "@/lib/lender-api/webhooks/events"

export interface WebhookEndpointRow {
  id: string
  url: string
  description: string | null
  events: string[]
  secretPrefix: string
  active: boolean
  createdAt: string
  pausedAt: string | null
  pausedReason: string | null
  consecutiveFailures: number
}

export interface WebhookDeliveryRow {
  id: string
  eventType: string
  endpointUrl: string
  status: string
  attempts: number
  lastResponseStatus: number | null
  lastError: string | null
  createdAt: string
  nextAttemptAt: string | null
}

function deliveryClass(status: string): string {
  if (status === "SUCCEEDED") return "text-[var(--cf-success)]"
  if (status === "FAILED") return "text-[var(--cf-danger)]"
  return "text-[var(--cf-warning)]"
}

interface Props {
  endpoints: WebhookEndpointRow[]
  deliveries: WebhookDeliveryRow[]
  canManage: boolean
}

export function WebhookEndpointsCard({ endpoints, deliveries, canManage }: Props) {
  const router = useRouter()
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENTS])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null)

  function toggle(event: WebhookEventType) {
    setEvents((s) => (s.includes(event) ? s.filter((x) => x !== event) : [...s, event]))
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, description, events }),
      })
      const data = (await res.json().catch(() => ({}))) as { secret?: string; error?: string }
      if (!res.ok || !data.secret) {
        setError(data.error ?? "The endpoint could not be added.")
        return
      }
      setCreated({ url, secret: data.secret })
      setUrl("")
      setDescription("")
      router.refresh()
    } catch {
      setError("The endpoint could not be added.")
    } finally {
      setBusy(false)
    }
  }

  async function change(row: WebhookEndpointRow, kind: "disable" | "resume") {
    const question = kind === "disable"
      ? `Stop sending events to ${row.url}? Deliveries still pending for it will fail.`
      : `Resume deliveries to ${row.url}? Its waiting deliveries are sent again.`
    if (!window.confirm(question)) return
    const failed = kind === "disable" ? "The endpoint could not be disabled." : "The endpoint could not be resumed."
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/webhooks/${row.id}`, kind === "disable"
        ? { method: "DELETE" }
        : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }) })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? failed)
        return
      }
      router.refresh()
    } catch {
      setError(failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          CredaFlow POSTs a signed JSON event to each endpoint when an application is created or changes status, a loan is
          disbursed, or a payment is received, and retries failures for about 45 hours. Verify the
          <code> CredaFlow-Signature</code> header with the endpoint&apos;s signing secret (see <code>/api/v1/openapi.json</code>).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="rounded-lg border border-[var(--cf-success)] bg-[var(--cf-surface-soft)] p-4 space-y-2" role="status">
            <p className="text-sm font-medium text-[var(--cf-text)]">Signing secret for {created.url}. Copy it now: it will not be shown again.</p>
            <code className="block break-all rounded bg-[var(--cf-bg-subtle)] p-2 text-sm text-[var(--cf-text)]">{created.secret}</code>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(created.secret)}>Copy</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>I have stored it</Button>
            </div>
          </div>
        )}

        <ul className="space-y-2">
          {endpoints.length === 0 && <li className="text-sm text-[var(--cf-text-muted)]">No endpoints yet.</li>}
          {endpoints.map((ep) => (
            <li key={ep.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-[var(--cf-border-subtle)] p-3 text-sm">
              <div className="space-y-1 text-[var(--cf-text)]">
                <p className="break-all font-medium">{ep.url}</p>
                {ep.description && <p className="text-[var(--cf-text-secondary)]">{ep.description}</p>}
                <p className="text-xs text-[var(--cf-text-muted)]">
                  {ep.events.join(", ")} · secret {ep.secretPrefix}… · added {ep.createdAt} · {ep.active ? (ep.pausedAt ? "paused" : "active") : "disabled"}
                </p>
                {ep.active && ep.pausedAt && (
                  <p className="text-xs text-[var(--cf-warning)]" role="status">
                    Paused {ep.pausedAt}: {ep.pausedReason ?? `${ep.consecutiveFailures} failed deliveries in a row`}. Deliveries wait until it is resumed.
                  </p>
                )}
              </div>
              {canManage && ep.active && (
                <div className="flex gap-2">
                  {ep.pausedAt && (
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change(ep, "resume")}>Resume</Button>
                  )}
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change(ep, "disable")}>Disable</Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {canManage ? (
          <form onSubmit={create} className="space-y-4 border-t border-[var(--cf-border-subtle)] pt-4">
            <div className="max-w-xl space-y-2">
              <Label htmlFor="webhookUrl">Endpoint URL (https)</Label>
              <Input id="webhookUrl" type="url" value={url} required placeholder="https://hooks.example.com/credaflow" onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="max-w-xl space-y-2">
              <Label htmlFor="webhookDescription">Description (optional)</Label>
              <Input id="webhookDescription" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[var(--cf-text)]">Events</legend>
              {WEBHOOK_EVENTS.map((event) => (
                <label key={event} className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
                  <input type="checkbox" className="mt-1 accent-[var(--cf-brand)]" checked={events.includes(event)} onChange={() => toggle(event)} />
                  <span><code>{event}</code> <span className="text-[var(--cf-text-muted)]">{WEBHOOK_EVENT_LABELS[event]}</span></span>
                </label>
              ))}
            </fieldset>
            {/* Enabled while incomplete: the required-field prompt and the server's
                message say what is missing; a disabled button looked faded and said nothing. */}
            <Button type="submit" disabled={busy}>Add endpoint</Button>
          </form>
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">Adding and disabling endpoints needs an Admin signed in with two-factor authentication.</p>
        )}
        {error && <p className="text-sm text-[var(--cf-danger)]" role="alert">{error}</p>}

        <div className="space-y-2 border-t border-[var(--cf-border-subtle)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--cf-text)]">Recent deliveries</h3>
          {deliveries.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">None yet.</p>
          ) : (
            <>
            <ul className="space-y-2 md:hidden">
              {deliveries.map((d) => (
                <li key={d.id} className="space-y-0.5 rounded-lg border border-[var(--cf-border-subtle)] p-2 text-xs text-[var(--cf-text)]">
                  <p className="flex justify-between gap-2"><code>{d.eventType}</code><span className={deliveryClass(d.status)}>{d.status}</span></p>
                  <p className="break-all text-[var(--cf-text-secondary)]">{d.endpointUrl}</p>
                  <p className="text-[var(--cf-text-muted)]">
                    {d.attempts} attempt(s) · {d.lastResponseStatus ?? d.lastError ?? "no response yet"} · {d.createdAt}{d.nextAttemptAt ? ` · next ${d.nextAttemptAt}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs">
                <thead className="text-left text-[var(--cf-text-muted)]">
                  <tr><th className="py-1 pr-3">Event</th><th className="py-1 pr-3">Endpoint</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Attempts</th><th className="py-1 pr-3">Last response</th><th className="py-1 pr-3">Created</th><th className="py-1">Next attempt</th></tr>
                </thead>
                <tbody className="text-[var(--cf-text)]">
                  {deliveries.map((d) => (
                    <tr key={d.id} className="border-t border-[var(--cf-border-subtle)]">
                      <td className="py-1 pr-3"><code>{d.eventType}</code></td>
                      <td className="py-1 pr-3 break-all">{d.endpointUrl}</td>
                      <td className={`py-1 pr-3 ${deliveryClass(d.status)}`}>{d.status}</td>
                      <td className="py-1 pr-3">{d.attempts}</td>
                      <td className="py-1 pr-3">{d.lastResponseStatus ?? d.lastError ?? "—"}</td>
                      <td className="py-1 pr-3">{d.createdAt}</td>
                      <td className="py-1">{d.nextAttemptAt ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
