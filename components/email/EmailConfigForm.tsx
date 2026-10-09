"use client"

import { useState, useEffect } from "react"
import { SAST_TIME_ZONE } from "@/lib/utils"

type Provider = "MSGRAPH" | "IMAP_SMTP"

interface Config {
  provider: Provider
  fromName: string
  fromAddress: string
  replyToAddress: string
  // MS Graph
  tenantAzureId: string
  clientId: string
  clientSecret: string
  // SMTP
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  // IMAP
  imapHost: string
  imapPort: number
  imapUser: string
  imapPass: string
  useTls: boolean
  active: boolean
  // meta
  lastTestedAt?: string
  lastTestOk?: boolean
  lastImapTestedAt?: string
  lastImapTestOk?: boolean
}

const DEFAULTS: Config = {
  provider: "IMAP_SMTP",
  fromName: "",
  fromAddress: "",
  replyToAddress: "",
  tenantAzureId: "", clientId: "", clientSecret: "",
  smtpHost: "", smtpPort: 587, smtpUser: "", smtpPass: "",
  imapHost: "", imapPort: 993, imapUser: "", imapPass: "",
  useTls: true, active: true,
}

const MS365_DEFAULTS = { smtpHost: "smtp.office365.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993 }
const GMAIL_DEFAULTS = { smtpHost: "smtp.gmail.com", smtpPort: 587, imapHost: "imap.gmail.com", imapPort: 993 }

export function EmailConfigForm() {
  const [cfg, setCfg] = useState<Config>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null)

  useEffect(() => {
    fetch("/api/email/config")
      .then(r => r.json())
      .then(data => {
        if (data) setCfg({ ...DEFAULTS, ...data })
        setLoading(false)
      })
      .catch(() => {
        setMsg({ type: "err", text: "Could not load email configuration." })
        setLoading(false)
      })
  }, [])

  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg(f => ({ ...f, [k]: v }))

  const applyPreset = (preset: "ms365" | "gmail") => {
    if (preset === "ms365") setCfg(f => ({ ...f, ...MS365_DEFAULTS, provider: "IMAP_SMTP" }))
    if (preset === "gmail") setCfg(f => ({ ...f, ...GMAIL_DEFAULTS, provider: "IMAP_SMTP" }))
  }

  // A rejected fetch (offline, DNS failure, aborted request) throws instead
  // of resolving — without a catch, the finally that clears saving/testing
  // never runs and the button stays disabled with no explanation.
  const NETWORK_ERROR_MSG = "Request failed — check your connection and try again."

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setMsg(null)
    try {
      const res = await fetch("/api/email/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) })
      if (res.ok) setMsg({ type: "ok", text: "Configuration saved successfully." })
      else {
        const data = await res.json().catch(() => null)
        setMsg({ type: "err", text: data?.error ?? "Save failed." })
      }
    } catch {
      setMsg({ type: "err", text: NETWORK_ERROR_MSG })
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true); setMsg({ type: "info", text: "Sending test email…" })
    try {
      const res = await fetch("/api/email/test", { method: "POST" })
      const data = await res.json()
      setMsg({ type: data.ok ? "ok" : "err", text: data.message })
    } catch {
      setMsg({ type: "err", text: NETWORK_ERROR_MSG })
    } finally {
      setTesting(false)
    }
  }

  async function testImap() {
    setTesting(true); setMsg({ type: "info", text: "Connecting to the IMAP mailbox…" })
    try {
      const res = await fetch("/api/email/test-imap", { method: "POST" })
      const data = await res.json()
      // The server-side message is already credential-redacted
      // (lib/email/inbound-poll.ts redactSecrets); render it verbatim.
      setMsg({ type: data.ok ? "ok" : "err", text: data.message })
    } catch {
      setMsg({ type: "err", text: NETWORK_ERROR_MSG })
    } finally {
      setTesting(false)
    }
  }

  async function pollInbox() {
    setTesting(true); setMsg({ type: "info", text: "Polling inbox for replies…" })
    try {
      const res = await fetch("/api/email/inbox", { method: "POST" })
      const data = await res.json()
      setMsg({ type: data.ok ? "ok" : "err", text: data.ok ? `Inbox checked: ${data.checked} messages, ${data.matched} replies matched` : data.message })
    } catch {
      setMsg({ type: "err", text: NETWORK_ERROR_MSG })
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <div className="p-8 text-gray-400 text-sm">Loading email configuration…</div>

  const inp = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]"
  const lbl = "block text-sm font-medium text-[#1b1d24] mb-1"

  return (
    <form onSubmit={save} className="space-y-6">
      {/* Status banner */}
      {msg && (
        <div className={`p-3 rounded-lg text-sm ${msg.type === "ok" ? "bg-green-50 text-green-700 border border-green-200" : msg.type === "err" ? "bg-red-50 text-red-700 border border-red-200" : "bg-blue-50 text-blue-700 border border-blue-200"}`}>
          {msg.text}
        </div>
      )}

      {/* Last test status */}
      {cfg.lastTestedAt && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${cfg.lastTestOk ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          <span>{cfg.lastTestOk ? "✅" : "❌"}</span>
          <span>Last test: {new Date(cfg.lastTestedAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })} — {cfg.lastTestOk ? "SUCCESS" : "FAILED"}</span>
        </div>
      )}

      {/* Last IMAP login check — distinct from the SMTP send test above. */}
      {cfg.lastImapTestedAt && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${cfg.lastImapTestOk ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          <span>{cfg.lastImapTestOk ? "✅" : "❌"}</span>
          <span>Last IMAP check: {new Date(cfg.lastImapTestedAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })} — {cfg.lastImapTestOk ? "SUCCESS" : "FAILED"}</span>
        </div>
      )}

      {/* Provider selection */}
      <div>
        <p className={lbl}>Email Provider</p>
        <div className="grid grid-cols-2 gap-3">
          {([["MSGRAPH", "Microsoft 365 (Graph API)", "App permissions — no password needed, most secure. Requires Azure App Registration."],
             ["IMAP_SMTP", "IMAP / SMTP", "Works with any mail server — Gmail, Outlook, custom domain."]] as const).map(([val, title, desc]) => (
            <label key={val} className={`cursor-pointer p-4 rounded-xl border-2 transition-colors ${cfg.provider === val ? "border-[#4F46E5] bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}>
              <input type="radio" name="provider" value={val} checked={cfg.provider === val} onChange={() => set("provider", val)} className="sr-only" />
              <p className="font-semibold text-sm text-[#1b1d24]">{title}</p>
              <p className="text-xs text-gray-500 mt-1">{desc}</p>
            </label>
          ))}
        </div>
      </div>

      {/* Sender identity */}
      <div className="border-t border-gray-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Sender Identity</p>
        <div className="grid grid-cols-2 gap-4">
          <div><label className={lbl}>From Name</label><input className={inp} value={cfg.fromName} onChange={e => set("fromName", e.target.value)} placeholder="Your company name" /></div>
          <div><label className={lbl}>From Email Address</label><input className={inp} type="email" value={cfg.fromAddress} onChange={e => set("fromAddress", e.target.value)} required placeholder="noreply@example.com" /></div>
        </div>
        <div className="mt-4">
          <label className={lbl}>Reply-To Email Address <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className={inp} type="email" value={cfg.replyToAddress} onChange={e => set("replyToAddress", e.target.value)} placeholder="support@example.com" />
          <p className="text-xs text-gray-400 mt-1">Where customer replies go. Leave blank to reply to the From address. Section 129 statutory notices are always sent without a Reply-To.</p>
        </div>
      </div>

      {/* MS Graph fields */}
      {cfg.provider === "MSGRAPH" && (
        <div className="border-t border-gray-100 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Microsoft Azure App Registration</p>
          <p className="text-xs text-gray-400 mb-4">
            Create an App Registration in Azure AD with <code>Mail.Send</code> application permission. {" "}
            <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps" target="_blank" rel="noreferrer" className="text-[#4F46E5] underline">Open Azure Portal →</a>
          </p>
          <div className="grid grid-cols-1 gap-4">
            <div><label className={lbl}>Azure Tenant ID (Directory ID)</label><input className={inp} value={cfg.tenantAzureId} onChange={e => set("tenantAzureId", e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
            <div><label className={lbl}>Application (Client) ID</label><input className={inp} value={cfg.clientId} onChange={e => set("clientId", e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
            <div><label className={lbl}>Client Secret</label><input className={inp} type="password" value={cfg.clientSecret} onChange={e => set("clientSecret", e.target.value)} placeholder="Your app secret value" /></div>
          </div>
        </div>
      )}

      {/* IMAP/SMTP fields */}
      {cfg.provider === "IMAP_SMTP" && (
        <div className="border-t border-gray-100 pt-5 space-y-5">
          {/* Quick presets */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Quick Presets</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => applyPreset("ms365")} className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">📧 Microsoft 365</button>
              <button type="button" onClick={() => applyPreset("gmail")} className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">📧 Gmail</button>
            </div>
          </div>

          {/* SMTP */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">SMTP (Outgoing Mail)</p>
            <div className="grid grid-cols-2 gap-4">
              <div><label className={lbl}>SMTP Host</label><input className={inp} value={cfg.smtpHost} onChange={e => set("smtpHost", e.target.value)} placeholder="smtp.office365.com" /></div>
              <div><label className={lbl}>SMTP Port</label><input className={inp} type="number" value={cfg.smtpPort} onChange={e => set("smtpPort", Number(e.target.value))} /></div>
              <div><label className={lbl}>SMTP Username</label><input className={inp} value={cfg.smtpUser} onChange={e => set("smtpUser", e.target.value)} placeholder="collections@example.com" /></div>
              <div><label className={lbl}>SMTP Password</label><input className={inp} type="password" value={cfg.smtpPass} onChange={e => set("smtpPass", e.target.value)} placeholder="App password or SMTP password" /></div>
            </div>
          </div>

          {/* IMAP */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">IMAP (Incoming Mail — for inbox tracking)</p>
            <div className="grid grid-cols-2 gap-4">
              <div><label className={lbl}>IMAP Host</label><input className={inp} value={cfg.imapHost} onChange={e => set("imapHost", e.target.value)} placeholder="outlook.office365.com" /></div>
              <div><label className={lbl}>IMAP Port</label><input className={inp} type="number" value={cfg.imapPort} onChange={e => set("imapPort", Number(e.target.value))} /></div>
              <div><label className={lbl}>IMAP Username</label><input className={inp} value={cfg.imapUser} onChange={e => set("imapUser", e.target.value)} placeholder="collections@example.com" /></div>
              <div><label className={lbl}>IMAP Password</label><input className={inp} type="password" value={cfg.imapPass} onChange={e => set("imapPass", e.target.value)} placeholder="App password or IMAP password" /></div>
            </div>
          </div>

          {/* TLS */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={cfg.useTls} onChange={e => set("useTls", e.target.checked)} className="h-4 w-4 rounded accent-[#4F46E5]" />
            <span className="text-sm text-[#1b1d24]">Use TLS / STARTTLS for SMTP (IMAP always uses TLS)</span>
          </label>
        </div>
      )}

      {/* Active toggle */}
      <label className="flex items-center gap-2 cursor-pointer pt-2 border-t border-gray-100">
        <input type="checkbox" checked={cfg.active} onChange={e => set("active", e.target.checked)} className="h-4 w-4 rounded accent-[#4F46E5]" />
        <span className="text-sm font-medium text-[#1b1d24]">Enable email sending for this tenant</span>
      </label>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-100">
        <div className="flex gap-2">
          <button type="button" onClick={testConnection} disabled={testing || saving}
            className="px-4 py-2 border border-[#4F46E5] text-[#4F46E5] text-sm font-semibold rounded-lg hover:bg-amber-50 disabled:opacity-50">
            {testing ? "Working…" : "🧪 Send Test Email"}
          </button>
          <button type="button" onClick={testImap} disabled={testing || saving}
            className="px-4 py-2 border border-[#4F46E5] text-[#4F46E5] text-sm font-semibold rounded-lg hover:bg-amber-50 disabled:opacity-50">
            🔌 Test IMAP
          </button>
          <button type="button" onClick={pollInbox} disabled={testing || saving}
            className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-50">
            📥 Poll Inbox
          </button>
        </div>
        <button type="submit" disabled={saving || testing}
          className="px-6 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50">
          {saving ? "Saving…" : "Save Configuration"}
        </button>
      </div>
    </form>
  )
}
