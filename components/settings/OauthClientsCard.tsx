"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_SCOPE_LABELS, API_SCOPES, type ApiScope } from "@/lib/lender-api/scopes"

export interface OauthClientRow {
  id: string
  name: string
  clientId: string
  scopes: string[]
  state: "active" | "revoked" | "expired" | "suspended"
  requireMtls: boolean
  mtlsSubjectDn: string | null
  mtlsCertSha256: string | null
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
}

interface Props {
  clients: OauthClientRow[]
  canManage: boolean
}

const LIFETIMES = [30, 90, 180, 365] as const

const stateClass = (state: OauthClientRow["state"]) =>
  state === "active" ? "text-[var(--cf-success)]" : state === "suspended" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"

export function OauthClientsCard({ clients, canManage }: Props) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<ApiScope[]>(["applications:read", "loans:read"])
  const [lifetimeDays, setLifetimeDays] = useState<number>(365)
  const [requireMtls, setRequireMtls] = useState(false)
  const [subjectDn, setSubjectDn] = useState("")
  const [sha256, setSha256] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ name: string; clientId: string; clientSecret: string } | null>(null)

  const toggle = (scope: ApiScope) => setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]))

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/oauth-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes, lifetimeDays, requireMtls, mtlsSubjectDn: subjectDn, mtlsCertSha256: sha256 }),
      })
      const data = (await res.json().catch(() => ({}))) as { clientId?: string; clientSecret?: string; error?: string }
      if (!res.ok || !data.clientId || !data.clientSecret) {
        setError(data.error ?? "The client could not be created.")
        return
      }
      setCreated({ name, clientId: data.clientId, clientSecret: data.clientSecret })
      setName("")
      router.refresh()
    } catch {
      setError("The client could not be created.")
    } finally {
      setBusy(false)
    }
  }

  async function revoke(row: OauthClientRow) {
    if (!window.confirm(`Revoke "${row.name}" (${row.clientId})? Its access tokens stop working at once.`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/oauth-clients/${row.id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? "The client could not be revoked.")
        return
      }
      router.refresh()
    } catch {
      setError("The client could not be revoked.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>OAuth clients</CardTitle>
        <CardDescription>
          A system that signs in with OAuth 2.0 client credentials: it posts its client id and secret to <code>/api/auth/oauth/token</code> and
          receives a 15-minute bearer token for <code>/api/v1</code>, within the scopes you give it. The secret is shown once, when the client is created.
          A client can also be pinned to a TLS client certificate that your gateway verifies (mutual TLS).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="space-y-2 rounded-lg border border-[var(--cf-success)] bg-[var(--cf-surface-soft)] p-4" role="status">
            <p className="text-sm font-medium text-[var(--cf-text)]">Client &quot;{created.name}&quot; created. Copy the secret now: it will not be shown again.</p>
            <p className="text-sm text-[var(--cf-text)]">Client id <code className="break-all">{created.clientId}</code></p>
            <code className="block break-all rounded bg-[var(--cf-bg-subtle)] p-2 text-sm text-[var(--cf-text)]">{created.clientSecret}</code>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(created.clientSecret)}>Copy secret</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>I have stored it</Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--cf-text-muted)]">
              <tr>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Client id</th>
                <th className="py-2 pr-3 font-medium">Scopes</th>
                <th className="py-2 pr-3 font-medium">Mutual TLS</th>
                <th className="py-2 pr-3 font-medium">Expires</th>
                <th className="py-2 pr-3 font-medium">Last used</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="text-[var(--cf-text)]">
              {clients.length === 0 && <tr><td colSpan={8} className="py-3 text-[var(--cf-text-muted)]">No OAuth clients yet.</td></tr>}
              {clients.map((c) => (
                <tr key={c.id} className="border-t border-[var(--cf-border-subtle)] align-top">
                  <td className="py-2 pr-3">{c.name}<div className="text-xs text-[var(--cf-text-muted)]">{c.createdAt}</div></td>
                  <td className="py-2 pr-3"><code className="break-all">{c.clientId}</code></td>
                  <td className="py-2 pr-3 text-xs">{c.scopes.join(", ")}</td>
                  <td className="py-2 pr-3 text-xs break-all">{c.requireMtls ? (c.mtlsSubjectDn ?? `sha256 ${c.mtlsCertSha256}`) : "Not required"}</td>
                  <td className="py-2 pr-3">{c.expiresAt}</td>
                  <td className="py-2 pr-3">{c.lastUsedAt ?? "Never"}</td>
                  <td className={`py-2 pr-3 ${stateClass(c.state)}`} title={c.state === "suspended" ? "Its creator is no longer an active admin: the client is refused. Revoke it and register a new one." : undefined}>{c.state}</td>
                  <td className="py-2 text-right">
                    {canManage && (c.state === "active" || c.state === "suspended") && (
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(c)}>Revoke</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage ? (
          <form onSubmit={create} className="space-y-4 border-t border-[var(--cf-border-subtle)] pt-4">
            <div className="max-w-sm space-y-2">
              <Label htmlFor="oauthClientName">New client name</Label>
              <Input id="oauthClientName" value={name} maxLength={80} required placeholder="e.g. Core banking integration" onChange={(e) => setName(e.target.value)} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[var(--cf-text)]">Scopes</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
                  <input type="checkbox" className="mt-1 accent-[var(--cf-brand)]" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
                  <span><code>{scope}</code> <span className="text-[var(--cf-text-muted)]">{API_SCOPE_LABELS[scope]}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="max-w-xs space-y-2">
              <Label htmlFor="oauthClientLifetime">Secret expires after</Label>
              <select
                id="oauthClientLifetime" value={lifetimeDays} onChange={(e) => setLifetimeDays(Number(e.target.value))}
                className="w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-2 text-sm text-[var(--cf-text)]"
              >
                {LIFETIMES.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
              <input type="checkbox" className="mt-1 accent-[var(--cf-brand)]" checked={requireMtls} onChange={(e) => setRequireMtls(e.target.checked)} />
              <span>Require a pinned TLS client certificate (mutual TLS). Needs the gateway set up as in docs/SSO-AND-OAUTH.md; without it every request from this client is refused.</span>
            </label>
            {requireMtls && (
              <div className="grid max-w-xl gap-4">
                <div className="space-y-2">
                  <Label htmlFor="oauthClientSha">Certificate SHA-256 fingerprint (required)</Label>
                  <Input id="oauthClientSha" value={sha256} maxLength={95} required placeholder="64 hex characters" onChange={(e) => setSha256(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauthClientDn">Certificate subject DN (optional extra pin)</Label>
                  <Input id="oauthClientDn" value={subjectDn} maxLength={512} placeholder="CN=core-banking,O=Example Bank,C=LS" onChange={(e) => setSubjectDn(e.target.value)} />
                  <p className="text-xs text-[var(--cf-text-muted)]">Compared as one exact string, in the RFC 4514 form your gateway forwards. Reordered, slash-form or differently cased subjects do not match.</p>
                </div>
              </div>
            )}
            <Button type="submit" disabled={busy}>Register client</Button>
          </form>
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">Registering and revoking OAuth clients needs a Super Admin signed in with two-factor authentication.</p>
        )}
        {error && <p className="text-sm text-[var(--cf-danger)]" role="alert">{error}</p>}
      </CardContent>
    </Card>
  )
}
