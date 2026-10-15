"use client"

import { useState } from "react"
import { toast } from "@/lib/toast"
import { Save } from "lucide-react"
import { MarketingPreferences } from "@/components/portal/MarketingPreferences"
import { ConsentStatus } from "@/components/portal/ConsentStatus"
import type { ClientConsent } from "@prisma/client"
import { useT } from "@/lib/i18n/client"

interface ProfileFormProps {
  initialData: {
    phone: string
    whatsapp: string
    addressLine1: string
    suburb: string
    city: string
    province: string
    postalCode: string
  }
  consent: ClientConsent | null
}

export function ProfileForm({ initialData, consent }: ProfileFormProps) {
  const [data, setData] = useState(initialData)
  const [saving, setSaving] = useState(false)
  const t = useT("portalProfile")

  function handleChange(field: keyof typeof data, value: string) {
    setData((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch("/api/portal/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        toast.success(t("savedTitle"), t("savedBody"))
      } else {
        toast.error(t("failTitle"), t("failBody"))
      }
    } catch {
      toast.error(t("networkTitle"), t("networkBody"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* Contact details */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">
          {t("contactDetails")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            label={t("phone")}
            value={data.phone}
            onChange={(v) => handleChange("phone", v)}
          />
          <FormField
            label={t("whatsapp")}
            value={data.whatsapp}
            onChange={(v) => handleChange("whatsapp", v)}
          />
        </div>
        <p className="text-xs text-gray-400 mt-3">
          {t("emailNote")}
        </p>
      </div>

      {/* Address */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">
          {t("physicalAddress")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <FormField
              label={t("address1")}
              value={data.addressLine1}
              onChange={(v) => handleChange("addressLine1", v)}
            />
          </div>
          <FormField
            label={t("suburb")}
            value={data.suburb}
            onChange={(v) => handleChange("suburb", v)}
          />
          <FormField
            label={t("city")}
            value={data.city}
            onChange={(v) => handleChange("city", v)}
          />
          <FormField
            label={t("province")}
            value={data.province}
            onChange={(v) => handleChange("province", v)}
          />
          <FormField
            label={t("postalCode")}
            value={data.postalCode}
            onChange={(v) => handleChange("postalCode", v)}
          />
        </div>
      </div>

      {/* Save button */}
      <div className="mb-5">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity disabled:opacity-50"
          style={{ backgroundColor: "#4338CA" }}
        >
          <Save className="w-4 h-4" />
          {saving ? t("saving") : t("saveChanges")}
        </button>
      </div>

      <MarketingPreferences
        initial={{
          smsMarketing: consent?.smsMarketing ?? false,
          emailMarketing: consent?.emailMarketing ?? false,
        }}
      />

      <ConsentStatus consent={consent} />
    </>
  )
}

function FormField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <div>
      <label className="text-xs text-gray-500 mb-1 block">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
      />
    </div>
  )
}
