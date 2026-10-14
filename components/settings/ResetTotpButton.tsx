"use client"

import { useState } from "react"
import { ShieldOff } from "lucide-react"
import { toast } from "@/lib/toast"
import { resetTotpConfirm, type SettingsUser } from "@/lib/settings-users"

/**
 * An admin clears another user's two-factor enrolment (a lost phone):
 * DELETE /api/settings/users/[id]/totp. The server decides (rank, TOTP-verified
 * session); the table shows this only when it would be allowed.
 */
export function ResetTotpButton({ user, staffTotpRequired, onDone }: { user: SettingsUser; staffTotpRequired: boolean; onDone: () => void }) {
  const [saving, setSaving] = useState(false)
  const name = user.name || user.email

  async function reset() {
    if (!confirm(resetTotpConfirm(name, staffTotpRequired))) return
    setSaving(true)
    try {
      const res = await fetch(`/api/settings/users/${user.id}/totp`, { method: "DELETE" })
      if (res.ok) {
        toast.success(`Two-factor authentication reset for ${name}.`)
        onDone()
      } else {
        const d = await res.json().catch(() => ({})) as { error?: string }
        toast.error(d.error ?? "Failed")
      }
    } catch {
      toast.error("Failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <button onClick={reset} disabled={saving} className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 text-gray-300 hover:text-gray-600" title="Reset 2FA">
      <ShieldOff className="h-4 w-4" />
    </button>
  )
}
