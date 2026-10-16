"use client"

import { useState } from "react"
import { PASSWORD_MIN_LENGTH } from "@/lib/security/password-policy"
import { useT } from "@/lib/i18n/client"

export function PasswordFields() {
  const t = useT("portalProfile")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(t("pwTooShort"))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t("pwMismatch"))
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/portal/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) {
        setError(json.error ?? t("pwFailed"))
        return
      }
      setSuccess(true)
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    } catch {
      setError(t("unexpected"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <div>
        <label className="text-xs text-gray-500 mb-1 block">{t("currentPassword")}</label>
        <input
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2"
          placeholder={t("currentPlaceholder")}
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 mb-1 block">{t("newPassword")}</label>
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2"
          placeholder={t("newPlaceholder")}
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 mb-1 block">{t("confirmPassword")}</label>
        <input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2"
          placeholder={t("confirmPlaceholder")}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-green-600">{t("pwUpdated")}</p>}

      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-opacity disabled:opacity-60"
        style={{ backgroundColor: "#4338CA" }}
      >
        {loading ? t("updating") : t("updatePassword")}
      </button>
    </form>
  )
}
