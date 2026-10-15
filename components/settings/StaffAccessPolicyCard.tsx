"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

const DAYS = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
] as const
type Day = (typeof DAYS)[number][0]
type Window = { start: string; end: string }
export type StaffAccessHoursValue = Record<Day, Window | null>

const DEFAULT_HOURS: StaffAccessHoursValue = {
  mon: { start: "08:00", end: "17:00" }, tue: { start: "08:00", end: "17:00" }, wed: { start: "08:00", end: "17:00" },
  thu: { start: "08:00", end: "17:00" }, fri: { start: "08:00", end: "17:00" }, sat: null, sun: null,
}

interface Props {
  hours: StaffAccessHoursValue | null
  ipAllowlist: string[]
  /** The viewer's address as callerIp() sees it; "unknown" without TRUSTED_PROXY. */
  callerIp: string
  canChange: boolean
  lastChange?: string | null
}

const timeInput =
  "w-28 rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 py-1 text-sm text-[var(--cf-text)] disabled:opacity-60"

export function StaffAccessPolicyCard({ hours, ipAllowlist, callerIp, canChange, lastChange = null }: Props) {
  const router = useRouter()
  const [restrictHours, setRestrictHours] = useState(hours !== null)
  const [week, setWeek] = useState<StaffAccessHoursValue>(hours ?? DEFAULT_HOURS)
  const [allowlist, setAllowlist] = useState(ipAllowlist.join("\n"))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const ipKnown = callerIp !== "unknown"

  const setDay = (day: Day, window: Window | null) => setWeek((w) => ({ ...w, [day]: window }))

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/staff-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffAccessHours: restrictHours ? week : null, staffIpAllowlist: allowlist }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ error: true, text: data.error ?? "Failed to save the access policy." })
        return
      }
      setAllowlist((data.staffIpAllowlist ?? []).join("\n"))
      setMessage({
        error: false,
        text: data.callerIpAllowed === false
          ? "Saved. Your own address is outside the allowlist: you keep access as a Super Admin, but colleagues on this network will be refused."
          : "Saved. Staff outside these rules are signed out on their next request.",
      })
      router.refresh()
    } catch {
      setMessage({ error: true, text: "Failed to save the access policy." })
    } finally {
      setSaving(false)
    }
  }

  const disabled = saving || !canChange
  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff access restrictions</CardTitle>
        <CardDescription>
          When staff may sign in and from where. Checked at sign-in and on every request; a Super Admin is never
          refused, but each time the rules would have refused one it is written to the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 max-w-xl">
            <div>
              <Label htmlFor="restrictHours">Restrict sign-in to working hours</Label>
              <p className="text-sm text-muted-foreground">
                South African time (SAST). A window closes at its end time; a closing time of 00:00 means midnight.
              </p>
            </div>
            <Switch id="restrictHours" checked={restrictHours} disabled={disabled} onCheckedChange={setRestrictHours} />
          </div>
          {restrictHours && (
            <div className="space-y-2">
              {DAYS.map(([day, label]) => {
                const window = week[day]
                return (
                  <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex w-32 items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-[var(--cf-brand)]"
                        checked={window !== null}
                        disabled={disabled}
                        onChange={(e) => setDay(day, e.target.checked ? { start: "08:00", end: "17:00" } : null)}
                      />
                      {label}
                    </label>
                    {window ? (
                      <>
                        <input type="time" aria-label={`${label} opens`} className={timeInput} value={window.start} disabled={disabled}
                          onChange={(e) => setDay(day, { ...window, start: e.target.value })} />
                        <span className="text-muted-foreground">to</span>
                        {/* A time input cannot hold 24:00; a closing time of 00:00 means midnight. */}
                        <input type="time" aria-label={`${label} closes`} className={timeInput} value={window.end === "24:00" ? "00:00" : window.end} disabled={disabled}
                          onChange={(e) => setDay(day, { ...window, end: e.target.value === "00:00" ? "24:00" : e.target.value })} />
                      </>
                    ) : (
                      <span className="text-muted-foreground">Closed</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-2 max-w-xl">
          <Label htmlFor="ipAllowlist">IP allowlist</Label>
          <p className="text-sm text-muted-foreground">
            One address or CIDR block per line (IPv4 or IPv6). Leave empty to allow any network.
          </p>
          <Textarea
            id="ipAllowlist"
            rows={4}
            value={allowlist}
            disabled={disabled}
            onChange={(e) => setAllowlist(e.target.value)}
            placeholder={"192.0.2.0/24\n2001:db8::/32"}
            className="font-mono text-sm"
          />
          <p className={`text-sm ${ipKnown ? "text-muted-foreground" : "text-[var(--cf-warning)]"}`}>
            {ipKnown
              ? `Your address as this server sees it: ${callerIp}`
              : "This deployment cannot see staff IP addresses (TRUSTED_PROXY is not set), so an allowlist cannot be saved."}
          </p>
        </div>

        <div className="flex items-center gap-4">
          <Button onClick={save} disabled={disabled}>{saving ? "Saving…" : "Save access restrictions"}</Button>
          {!canChange && <p className="text-sm text-muted-foreground">Only a Super Admin can change these.</p>}
        </div>
        <p className="text-sm text-muted-foreground">{lastChange ?? "Never changed."}</p>
        {message && (
          <p className={`text-sm ${message.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{message.text}</p>
        )}
      </CardContent>
    </Card>
  )
}
