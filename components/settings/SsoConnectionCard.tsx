"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MAPPABLE_ROLE_LIST } from "@/lib/sso/groups"
import type { connectionView } from "@/lib/sso/connection"

type View = NonNullable<ReturnType<typeof connectionView>>

interface Props {
  initial: View | null
  /** Where the identity provider sends the browser back (OIDC redirect URI / SAML ACS URL). */
  redirectUri: string
  acsUrl: string
  canManage: boolean
}

const mapToText = (map: Record<string, string>) => Object.entries(map).map(([g, r]) => `${g}=${r}`).join("\n")

function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const eq = line.lastIndexOf("=")
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const list = (text: string) => text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)

export function SsoConnectionCard({ initial, redirectUri, acsUrl, canManage }: Props) {
  const router = useRouter()
  const [protocol, setProtocol] = useState<"OIDC" | "SAML">(initial?.protocol ?? "OIDC")
  const [enabled, setEnabled] = useState(initial?.enabled ?? false)
  const [issuer, setIssuer] = useState(initial?.oidc.issuer ?? "")
  const [clientId, setClientId] = useState(initial?.oidc.clientId ?? "")
  const [clientSecret, setClientSecret] = useState("")
  const [scopes, setScopes] = useState((initial?.oidc.scopes ?? ["openid", "email", "profile"]).join(" "))
  const [entityId, setEntityId] = useState(initial?.saml.entityId ?? "")
  const [idpEntityId, setIdpEntityId] = useState(initial?.saml.idpEntityId ?? "")
  const [idpSsoUrl, setIdpSsoUrl] = useState(initial?.saml.idpSsoUrl ?? "")
  const [idpCert, setIdpCert] = useState("")
  const [emailClaim, setEmailClaim] = useState(initial?.emailClaim ?? "email")
  const [groupsClaim, setGroupsClaim] = useState(initial?.groupsClaim ?? "groups")
  const [domains, setDomains] = useState((initial?.allowedEmailDomains ?? []).join(", "))
  const [groupMap, setGroupMap] = useState(mapToText(initial?.groupRoleMap ?? {}))
  const [jit, setJit] = useState(initial?.jitProvisioning ?? false)
  const [jitRole, setJitRole] = useState<string>(initial?.jitDefaultRole ?? "READONLY")
  const [trustMfa, setTrustMfa] = useState(initial?.trustIdpMfa ?? false)
  const [acr, setAcr] = useState((initial?.mfaAcrValues ?? []).join(", "))
  const [passwordOff, setPasswordOff] = useState(initial?.passwordLoginDisabled ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    const body = {
      protocol, enabled,
      ...(protocol === "OIDC"
        ? { oidc: { issuer, clientId, clientSecret, scopes: scopes.split(/\s+/).filter(Boolean) } }
        : { saml: { entityId, idpEntityId, idpSsoUrl, idpCert } }),
      emailClaim, groupsClaim, allowedEmailDomains: list(domains), groupRoleMap: textToMap(groupMap),
      jitProvisioning: jit, jitDefaultRole: jit ? jitRole : null, trustIdpMfa: trustMfa, mfaAcrValues: list(acr), passwordLoginDisabled: passwordOff,
    }
    try {
      const res = await fetch("/api/settings/sso", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? "The connection could not be saved.")
        return
      }
      setClientSecret("")
      setIdpCert("")
      setSaved(true)
      router.refresh()
    } catch {
      setError("The connection could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  const field = "w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-2 text-sm text-[var(--cf-text)]"
  const check = (id: string, checked: boolean, set: (v: boolean) => void, label: string, hint?: string) => (
    <label htmlFor={id} className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
      <input id={id} type="checkbox" className="mt-1 accent-[var(--cf-brand)]" checked={checked} disabled={!canManage} onChange={(e) => set(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-[var(--cf-text-muted)]">{hint}</span>}</span>
    </label>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Single sign-on</CardTitle>
        <CardDescription>
          Let staff sign in with the lender&apos;s identity provider (OpenID Connect or SAML 2.0). Staff must already have a CredaFlow account:
          they are matched by email. A Super Admin is never created or changed by the provider.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <div className="max-w-xs space-y-2">
            <Label htmlFor="ssoProtocol">Protocol</Label>
            <select id="ssoProtocol" className={field} value={protocol} disabled={!canManage} onChange={(e) => setProtocol(e.target.value as "OIDC" | "SAML")}>
              <option value="OIDC">OpenID Connect</option>
              <option value="SAML">SAML 2.0</option>
            </select>
          </div>

          {protocol === "OIDC" ? (
            <div className="grid max-w-xl gap-4">
              <p className="text-sm text-[var(--cf-text-secondary)]">Register this redirect URI at the provider: <code className="break-all">{redirectUri}</code></p>
              <div className="space-y-2"><Label htmlFor="ssoIssuer">Issuer URL</Label><Input id="ssoIssuer" value={issuer} disabled={!canManage} placeholder="https://login.example.com/realms/bank" onChange={(e) => setIssuer(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="ssoClientId">Client id</Label><Input id="ssoClientId" value={clientId} disabled={!canManage} onChange={(e) => setClientId(e.target.value)} /></div>
              <div className="space-y-2">
                <Label htmlFor="ssoClientSecret">Client secret</Label>
                <Input id="ssoClientSecret" type="password" autoComplete="off" value={clientSecret} disabled={!canManage} placeholder={initial?.oidc.hasClientSecret ? "Stored. Leave blank to keep it." : ""} onChange={(e) => setClientSecret(e.target.value)} />
              </div>
              <div className="space-y-2"><Label htmlFor="ssoScopes">Scopes</Label><Input id="ssoScopes" value={scopes} disabled={!canManage} onChange={(e) => setScopes(e.target.value)} /></div>
            </div>
          ) : (
            <div className="grid max-w-xl gap-4">
              <p className="text-sm text-[var(--cf-text-secondary)]">Give the provider this assertion consumer URL: <code className="break-all">{acsUrl}</code>. Sign-in starts from CredaFlow; provider-initiated sign-in is refused.</p>
              <div className="space-y-2"><Label htmlFor="ssoEntityId">Service provider entity id (audience)</Label><Input id="ssoEntityId" value={entityId} disabled={!canManage} placeholder="urn:credaflow:lender" onChange={(e) => setEntityId(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="ssoIdpEntityId">Identity provider entity id (issuer)</Label><Input id="ssoIdpEntityId" value={idpEntityId} disabled={!canManage} onChange={(e) => setIdpEntityId(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="ssoIdpUrl">Identity provider sign-in URL</Label><Input id="ssoIdpUrl" value={idpSsoUrl} disabled={!canManage} placeholder="https://idp.example.com/saml/sso" onChange={(e) => setIdpSsoUrl(e.target.value)} /></div>
              <div className="space-y-2">
                <Label htmlFor="ssoIdpCert">Identity provider signing certificate (PEM)</Label>
                <textarea id="ssoIdpCert" rows={5} className={field} value={idpCert} disabled={!canManage} placeholder={initial?.saml.hasIdpCert ? "Stored. Paste a new one to replace it (up to three, for key rollover)." : "-----BEGIN CERTIFICATE-----"} onChange={(e) => setIdpCert(e.target.value)} />
              </div>
            </div>
          )}

          <div className="grid max-w-xl gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="ssoEmailClaim">Email {protocol === "OIDC" ? "claim" : "attribute"}</Label><Input id="ssoEmailClaim" value={emailClaim} disabled={!canManage} onChange={(e) => setEmailClaim(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="ssoGroupsClaim">Groups {protocol === "OIDC" ? "claim" : "attribute"}</Label><Input id="ssoGroupsClaim" value={groupsClaim} disabled={!canManage} onChange={(e) => setGroupsClaim(e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ssoDomains">Allowed email domains (optional, comma separated)</Label>
              <Input id="ssoDomains" value={domains} disabled={!canManage} placeholder="bank.example.com" onChange={(e) => setDomains(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ssoGroupMap">Group to role mapping (one per line: group=ROLE)</Label>
              <textarea id="ssoGroupMap" rows={4} className={field} value={groupMap} disabled={!canManage} placeholder={"CredaFlow-Admins=ADMIN\nCredaFlow-Officers=CREDIT_OFFICER"} onChange={(e) => setGroupMap(e.target.value)} />
              <p className="text-xs text-[var(--cf-text-muted)]">Roles: {MAPPABLE_ROLE_LIST.join(", ")}. Super Admin cannot be mapped. A user in several mapped groups gets the highest role; a user in none keeps their role.</p>
            </div>
          </div>

          <div className="space-y-3">
            {check("ssoJit", jit, setJit, "Create staff accounts on first sign-in", "Off by default. New accounts get the mapped role, or the default below; never Super Admin.")}
            {jit && (
              <div className="max-w-xs space-y-2">
                <Label htmlFor="ssoJitRole">Default role for new accounts</Label>
                <select id="ssoJitRole" className={field} value={jitRole} disabled={!canManage} onChange={(e) => setJitRole(e.target.value)}>
                  {MAPPABLE_ROLE_LIST.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}
            {check("ssoTrustMfa", trustMfa, setTrustMfa, "Trust the provider's multi-factor authentication", "A user without CredaFlow two-factor is let in only when the provider reports MFA for that sign-in. A user who enrolled CredaFlow two-factor is still asked for the code.")}
            {trustMfa && (
              <div className="max-w-xl space-y-2">
                <Label htmlFor="ssoAcr">Extra values that mean MFA (acr / AuthnContext, comma separated)</Label>
                <Input id="ssoAcr" value={acr} disabled={!canManage} onChange={(e) => setAcr(e.target.value)} />
              </div>
            )}
            {check("ssoEnabled", enabled, setEnabled, "Single sign-on is on")}
            {check("ssoPasswordOff", passwordOff, setPasswordOff, "Turn off password sign-in", "Only while single sign-on is on. A Super Admin can still sign in with password and an authenticator code (break-glass).")}
          </div>

          {canManage ? (
            <Button type="submit" disabled={busy}>Save connection</Button>
          ) : (
            <p className="text-sm text-[var(--cf-text-muted)]">Changing single sign-on needs a Super Admin signed in with two-factor authentication.</p>
          )}
          {saved && <p className="text-sm text-[var(--cf-success)]" role="status">Saved.</p>}
          {error && <p className="text-sm text-[var(--cf-danger)]" role="alert">{error}</p>}
        </form>
      </CardContent>
    </Card>
  )
}
