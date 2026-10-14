"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_SCOPE_LABELS, API_SCOPES, type ApiScope } from "@/lib/lender-api/scopes"

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  state: "active" | "revoked" | "expired"
  createdBy: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
}

interface Props {
  keys: ApiKeyRow[]
  canManage: boolean
}

const LIFETIMES = [30, 90, 180, 365] as const

export function ApiKeysCard({ keys, canManage }: Props) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<ApiScope[]>(["applications:read", "loans:read"])
  const [lifetimeDays, setLifetimeDays] = useState<number>(365)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null)

  function toggle(scope: ApiScope) {
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]))
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes, lifetimeDays }),
      })
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string }
      if (!res.ok || !data.key) {
        setError(data.error ?? "The key could not be created.")
        return
      }
      setCreated({ name, key: data.key })
      setName("")
      router.refresh()
    } catch {
      setError("The key could not be created.")
    } finally {
      setBusy(false)
    }
  }

  async function revoke(row: ApiKeyRow) {
    if (!window.confirm(`Revoke "${row.name}" (${row.prefix})? Integrations using it stop working at once.`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/api-keys/${row.id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? "The key could not be revoked.")
        return
      }
      router.refresh()
    } catch {
      setError("The key could not be revoked.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          A key lets another system read this lender&apos;s records through the API at <code>/api/v1</code>, within the scopes you give it.
          The key is shown once, when it is created. Store it in that system&apos;s secret store.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="rounded-lg border border-[var(--cf-success)] bg-[var(--cf-surface-soft)] p-4 space-y-2" role="status">
            <p className="text-sm font-medium text-[var(--cf-text)]">Key &quot;{created.name}&quot; created. Copy it now: it will not be shown again.</p>
            <code className="block break-all rounded bg-[var(--cf-bg-subtle)] p-2 text-sm text-[var(--cf-text)]">{created.key}</code>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(created.key)}>Copy</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>I have stored it</Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--cf-text-muted)]">
              <tr>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Key</th>
                <th className="py-2 pr-3 font-medium">Scopes</th>
                <th className="py-2 pr-3 font-medium">Expires</th>
                <th className="py-2 pr-3 font-medium">Last used</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="text-[var(--cf-text)]">
              {keys.length === 0 && (
                <tr><td colSpan={7} className="py-3 text-[var(--cf-text-muted)]">No API keys yet.</td></tr>
              )}
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-[var(--cf-border-subtle)] align-top">
                  <td className="py-2 pr-3">{k.name}<div className="text-xs text-[var(--cf-text-muted)]">by {k.createdBy}, {k.createdAt}</div></td>
                  <td className="py-2 pr-3"><code>cfk_{k.prefix}_…</code></td>
                  <td className="py-2 pr-3 text-xs">{k.scopes.join(", ")}</td>
                  <td className="py-2 pr-3">{k.expiresAt}</td>
                  <td className="py-2 pr-3">{k.lastUsedAt ?? "Never"}</td>
                  <td className={`py-2 pr-3 ${k.state === "active" ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)]"}`}>{k.state}</td>
                  <td className="py-2 text-right">
                    {canManage && k.state === "active" && (
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(k)}>Revoke</Button>
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
              <Label htmlFor="apiKeyName">New key name</Label>
              <Input id="apiKeyName" value={name} maxLength={80} required placeholder="e.g. Reporting warehouse" onChange={(e) => setName(e.target.value)} />
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
              <Label htmlFor="apiKeyLifetime">Expires after</Label>
              <select
                id="apiKeyLifetime"
                value={lifetimeDays}
                onChange={(e) => setLifetimeDays(Number(e.target.value))}
                className="w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-2 text-sm text-[var(--cf-text)]"
              >
                {LIFETIMES.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>Create key</Button>
          </form>
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">Creating and revoking keys needs an Admin signed in with two-factor authentication.</p>
        )}
        {error && <p className="text-sm text-[var(--cf-danger)]" role="alert">{error}</p>}
      </CardContent>
    </Card>
  )
}
