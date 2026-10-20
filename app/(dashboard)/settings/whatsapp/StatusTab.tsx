"use client"

import { useState } from "react"
import type { ReactNode } from "react"
import { CheckCircle, MessageCircle, XCircle } from "lucide-react"
import { Switch } from "@/components/ui/switch"

export type ChannelSettings = {
  whatsappEnabled: boolean
  botsEnabled: boolean
  chatAlertEmail: string | null
  waProvider: string
}

type ToggleKey = "whatsappEnabled" | "botsEnabled"

interface Props {
  waEnabled: boolean
  waSenderUrl: string | null
  providers: string[]
  initial: ChannelSettings
}

export function StatusTab({ waEnabled, waSenderUrl, providers, initial }: Props) {
  const [s, setS] = useState<ChannelSettings>(initial)
  const [alertEmail, setAlertEmail] = useState(initial.chatAlertEmail ?? "")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<null | "ok" | "err">(null)
  const [alertEmailError, setAlertEmailError] = useState<string | null>(null)

  // Partial patch, one key at a time — same writer the Comms Hub channel tab
  // used, so /api/inbox/settings still audits each change on its own.
  async function save(patch: Partial<ChannelSettings>): Promise<boolean> {
    setSaving(true)
    setSaved(null)
    setAlertEmailError(null)
    try {
      const res = await fetch("/api/inbox/settings", { method: "PUT", body: JSON.stringify(patch) })
      if (!res.ok) {
        // A refused address is the operator's to fix: say so at the field, not as a failed save.
        const fieldError = ((await res.json()) as { errors?: { chatAlertEmail?: string } }).errors?.chatAlertEmail
        if (!fieldError) throw new Error()
        setAlertEmailError(fieldError)
        return false
      }
      setSaved("ok")
      return true
    } catch {
      setSaved("err")
      return false
    } finally {
      setSaving(false)
    }
  }

  // On a rejected save, restore the previous value for this key — otherwise
  // the switch and the disagreement line above keep showing the unsaved
  // state, which the operator has no way to tell apart from a saved one.
  async function toggle(key: ToggleKey, value: boolean) {
    const previous = s[key]
    setS((p) => ({ ...p, [key]: value }))
    const ok = await save({ [key]: value } as Partial<ChannelSettings>)
    if (!ok) setS((p) => ({ ...p, [key]: previous }))
  }

  // WA_ENABLED gates the sender at the process level; whatsappEnabled gates it
  // in the database. Either one off means nothing goes out, and an operator
  // looking at one switch cannot see the other — so name the mismatch.
  const disagreement =
    waEnabled && !s.whatsappEnabled
      ? "WhatsApp is enabled on the server but switched off in settings — inbound capture and agent replies are blocked."
      : !waEnabled && s.whatsappEnabled
        ? "WhatsApp is switched on in settings but not enabled on the server — sends are blocked."
        : null

  return (
    <div className="space-y-6">
      {/* Deployment — reflects the running process, not something this page can change. */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: "#D1FAE5" }}>
              <MessageCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="font-semibold text-gray-900 text-sm">Deployment</p>
              <p className="text-xs text-gray-400">
                {waSenderUrl ? `WA_SENDER_URL — ${waSenderUrl}` : "No WA sender configured (WA_SENDER_URL is unset)"}
              </p>
            </div>
          </div>
          {waEnabled ? (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-green-600 bg-green-50 px-2.5 py-1 rounded-full">
              <CheckCircle className="h-3.5 w-3.5" /> WA_ENABLED
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-red-600 bg-red-50 px-2.5 py-1 rounded-full">
              <XCircle className="h-3.5 w-3.5" /> WA_ENABLED off
            </span>
          )}
        </div>
        {!waEnabled && (
          <p className="text-xs text-amber-700 mt-3">WA_ENABLED is set to something other than true in the server environment, which blocks all sending. Remove it or set it to true to allow sending.</p>
        )}
        <p className="text-[11px] text-gray-400 mt-3">
          <code className="font-mono">WA_ENABLED</code> and <code className="font-mono">WA_SENDER_URL</code> are set on the server; not editable here.
        </p>
      </div>

      {disagreement && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disagreement}</p>
      )}

      <div className="space-y-4">
        <Row label="WhatsApp channel" hint="Master switch — captures inbound + allows agent replies.">
          <Switch checked={s.whatsappEnabled} onCheckedChange={(v) => toggle("whatsappEnabled", v)} />
        </Row>
        <Row label="Chatbots" hint="Master switch for the website AI chat. Off hides the chat on the website and refuses new messages.">
          <Switch checked={s.botsEnabled} onCheckedChange={(v) => toggle("botsEnabled", v)} />
        </Row>
        <Row label="Alert email for unanswered chats" hint="Sent when nobody joins a handed-off website chat within 2 minutes, or after hours. Leave empty to send no email.">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              type="email"
              aria-label="Alert email for unanswered chats"
              aria-describedby={alertEmailError ? "chat-alert-email-error" : undefined}
              value={alertEmail}
              onChange={(e) => setAlertEmail(e.target.value)}
              className="w-64 rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              data-testid="chat-alert-email-save"
              disabled={saving}
              onClick={() => save({ chatAlertEmail: alertEmail })}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm"
            >
              Save
            </button>
            {alertEmailError && <p id="chat-alert-email-error" role="alert" className="w-full text-right text-xs text-red-600">{alertEmailError}</p>}
          </div>
        </Row>
        <Row label="Provider" hint="Transport. Swap to an official provider without a UI change.">
          <select
            value={s.waProvider}
            onChange={(e) => { setS((p) => ({ ...p, waProvider: e.target.value })); void save({ waProvider: e.target.value }) }}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          >
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Row>
        <SaveState saving={saving} saved={saved} />
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-gray-200 px-4 py-3">
      <div>
        <p className="font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-400">{hint}</p>
      </div>
      {children}
    </div>
  )
}

function SaveState({ saving, saved }: { saving: boolean; saved: null | "ok" | "err" }) {
  if (saving) return <p className="text-xs text-gray-400">Saving…</p>
  if (saved === "ok") return <p className="text-xs text-emerald-600">Saved.</p>
  if (saved === "err") return <p className="text-xs text-red-600">Save failed — check your role and try again.</p>
  return null
}
