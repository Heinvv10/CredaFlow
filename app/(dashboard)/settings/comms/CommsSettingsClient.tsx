"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CannedRepliesTab } from "./CannedRepliesTab"
import { AgentRosterTab } from "./AgentRosterTab"
import type { CannedReplyDTO, RosterMember } from "../../inbox/types"

// Must stay in step with the TabsTrigger values below.
const TAB_VALUES = ["channel", "hours", "canned", "roster"]

/** Tabs that used to live here and now live elsewhere, so old deep links —
 *  including any already sent in bridge outage alert emails — still
 *  land on the screen they name. */
const LEGACY_TAB_REDIRECTS: Record<string, string> = {
  "wa-bridge": "/settings/whatsapp?tab=bridge",
}

export function legacyTabRedirect(requested: string | null): string | null {
  return (requested && LEGACY_TAB_REDIRECTS[requested]) ?? null
}

type Settings = {
  autoReplyEnabled: boolean
  autoReplyText: string
  businessHours: Record<string, unknown> | null
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export function CommsSettingsClient({ initial, cannedReplies, roster }: { initial: Settings; cannedReplies: CannedReplyDTO[]; roster: RosterMember[] }) {
  const [s, setS] = useState<Settings>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<null | "ok" | "err">(null)

  async function save(patch: Partial<Settings>) {
    setSaving(true)
    setSaved(null)
    try {
      const res = await fetch("/api/inbox/settings", { method: "PUT", body: JSON.stringify(patch) })
      if (!res.ok) throw new Error()
      setSaved("ok")
    } catch {
      setSaved("err")
    } finally {
      setSaving(false)
    }
  }

  const hours = (s.businessHours?.days as Record<string, { open: string; close: string } | null> | undefined) ?? {}
  const tz = (s.businessHours?.tz as string | undefined) ?? "Africa/Johannesburg"

  function setDay(day: string, field: "open" | "close", value: string) {
    const nextDays = { ...hours, [day]: { open: hours[day]?.open ?? "08:00", close: hours[day]?.close ?? "17:00", [field]: value } }
    setS((p) => ({ ...p, businessHours: { tz, days: nextDays } }))
  }
  function toggleDay(day: string, enabled: boolean) {
    const nextDays = { ...hours, [day]: enabled ? { open: "08:00", close: "17:00" } : null }
    setS((p) => ({ ...p, businessHours: { tz, days: nextDays } }))
  }

  // ?tab=<value> deep-links a tab. The outage alert email and the WhatsApp
  // Templates page both send staff straight to the bridge tab, and a link that
  // silently lands on the wrong tab is a false instruction. Unknown values fall
  // back to the default rather than rendering an empty panel.
  const requestedTab = useSearchParams()?.get("tab")
  const initialTab = TAB_VALUES.includes(requestedTab ?? "") ? (requestedTab as string) : "channel"
  const router = useRouter()
  const legacyTab = legacyTabRedirect(requestedTab)
  useEffect(() => {
    if (legacyTab) router.replace(legacyTab)
  }, [legacyTab, router])

  return (
    <Tabs defaultValue={initialTab}>
      <TabsList>
        <TabsTrigger value="channel">Auto-reply</TabsTrigger>
        <TabsTrigger value="hours">Business hours</TabsTrigger>
        <TabsTrigger value="canned">Canned replies</TabsTrigger>
        <TabsTrigger value="roster">Agent roster</TabsTrigger>
      </TabsList>

      <TabsContent value="channel" className="space-y-4 pt-4">
        <Row label="Out-of-hours auto-reply" hint="Sent at most once per window when a message arrives outside business hours.">
          <Switch checked={s.autoReplyEnabled} onCheckedChange={(v) => { setS((p) => ({ ...p, autoReplyEnabled: v })); save({ autoReplyEnabled: v }) }} />
        </Row>
        {s.autoReplyEnabled && (
          <div className="space-y-2">
            <Textarea value={s.autoReplyText} onChange={(e) => setS((p) => ({ ...p, autoReplyText: e.target.value }))} rows={3} placeholder="Thanks for your message — our team replies during business hours." />
            <Button size="sm" onClick={() => save({ autoReplyText: s.autoReplyText })} disabled={saving}>Save auto-reply</Button>
          </div>
        )}
        <SaveState saving={saving} saved={saved} />
      </TabsContent>

      <TabsContent value="hours" className="space-y-3 pt-4">
        <div className="flex items-center gap-2">
          <Label className="w-24">Timezone</Label>
          <Input value={tz} onChange={(e) => setS((p) => ({ ...p, businessHours: { tz: e.target.value, days: hours } }))} className="max-w-xs" />
        </div>
        {DAYS.map((day) => {
          const d = hours[day]
          return (
            <div key={day} className="flex items-center gap-3">
              <span className="w-12 text-sm capitalize">{day}</span>
              <Switch checked={d != null} onCheckedChange={(v) => toggleDay(day, v)} />
              {d != null && (
                <>
                  <Input type="time" value={d.open} onChange={(e) => setDay(day, "open", e.target.value)} className="w-32" />
                  <span className="text-gray-400">–</span>
                  <Input type="time" value={d.close} onChange={(e) => setDay(day, "close", e.target.value)} className="w-32" />
                </>
              )}
            </div>
          )
        })}
        <Button size="sm" onClick={() => save({ businessHours: { tz, days: hours } })} disabled={saving}>Save business hours</Button>
        <SaveState saving={saving} saved={saved} />
      </TabsContent>

      <TabsContent value="canned"><CannedRepliesTab initial={cannedReplies} /></TabsContent>
      <TabsContent value="roster"><AgentRosterTab initial={roster} /></TabsContent>
    </Tabs>
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
