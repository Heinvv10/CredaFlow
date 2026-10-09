"use client"

import { useState } from "react"
import { Save } from "lucide-react"
import { toast } from "@/lib/toast"

interface MarketingPreferencesProps {
  initial: { smsMarketing: boolean; emailMarketing: boolean }
}

export function MarketingPreferences({ initial }: MarketingPreferencesProps) {
  const [smsMarketing, setSms] = useState(initial.smsMarketing)
  const [emailMarketing, setEmail] = useState(initial.emailMarketing)
  const [confirmedSms, setConfirmedSms] = useState(initial.smsMarketing)
  const [confirmedEmail, setConfirmedEmail] = useState(initial.emailMarketing)
  const [saving, setSaving] = useState(false)

  const dirty =
    smsMarketing !== confirmedSms ||
    emailMarketing !== confirmedEmail

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch("/api/portal/consent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smsMarketing, emailMarketing }),
      })
      if (res.ok) {
        setConfirmedSms(smsMarketing)
        setConfirmedEmail(emailMarketing)
        toast.success("Preferences updated", "Your marketing preferences have been saved.")
      } else {
        toast.error("Update failed", "Please try again later.")
      }
    } catch {
      toast.error("Network error", "Please check your connection.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
      <h2 className="text-sm font-bold text-gray-900 mb-1">Marketing Preferences</h2>
      <p className="text-xs text-gray-500 mb-4">
        These are separate from your loan-related consents — you can change them at any time.
      </p>

      <div className="space-y-3">
        <ToggleRow
          label="SMS messages from us"
          checked={smsMarketing}
          onChange={setSms}
        />
        <ToggleRow
          label="Email newsletters and product updates"
          checked={emailMarketing}
          onChange={setEmail}
        />
      </div>

      <div className="mt-5">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity disabled:opacity-50"
          style={{ backgroundColor: "#4338CA" }}
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save marketing preferences"}
        </button>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-sm text-gray-700">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-5 h-5 accent-amber-600 cursor-pointer"
      />
    </label>
  )
}
