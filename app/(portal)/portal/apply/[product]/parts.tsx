"use client"

import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { formatZAR, maskIdNumber } from "@/lib/utils"
import { useT } from "@/lib/i18n/client"
import { richText } from "@/lib/i18n/rich"
import type { MessageKey } from "@/lib/i18n/translate"

export interface ClientInfo {
  firstName: string
  lastName: string
  idNumber: string
  phone: string
  email: string
  monthlyIncome: number   // cents
  monthlyExpenses: number // cents
  existingDebt: number    // cents
}

export const PURPOSE_CATEGORIES: ReadonlyArray<{ value: string; label: MessageKey<"portalApply"> }> = [
  { value: "DEBT_CONSOLIDATION", label: "purposeDebtConsolidation" },
  { value: "MEDICAL",            label: "purposeMedical" },
  { value: "EDUCATION",          label: "purposeEducation" },
  { value: "HOME_IMPROVEMENT",   label: "purposeHomeImprovement" },
  { value: "VEHICLE",            label: "purposeVehicle" },
  { value: "BUSINESS",           label: "purposeBusiness" },
  { value: "HOUSEHOLD",          label: "purposeHousehold" },
  { value: "FUNERAL",            label: "purposeFuneral" },
  { value: "OTHER",              label: "purposeOther" },
]

export function ProfileGapWarning({ client }: { client: ClientInfo }) {
  const t = useT("portalApply")
  const missing: string[] = []
  if (!client.idNumber) missing.push(t("missingId"))
  if (!client.phone) missing.push(t("missingPhone"))
  if (client.monthlyIncome <= 0) missing.push(t("missingIncome"))
  if (missing.length === 0) return null

  return (
    <div
      className="flex items-start gap-3 rounded-lg p-4 mb-6 text-sm"
      style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b", color: "var(--cf-text-secondary)" }}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
      <div>
        {richText(t("profileMissing", { fields: missing.join(", ") }), { b: (chunk) => <strong>{chunk}</strong> })}{" "}
        <Link href="/portal/profile" className="underline" style={{ color: "#4338CA" }}>
          {t("completeProfileLink")}
        </Link>
      </div>
    </div>
  )
}

export function ClientSummary({ client }: { client: ClientInfo }) {
  const t = useT("portalApply")
  const rows: ReadonlyArray<{ label: string; value: string }> = [
    { label: t("name"),            value: `${client.firstName} ${client.lastName}` },
    { label: t("idNumber"),        value: client.idNumber ? maskIdNumber(client.idNumber) : "—" },
    { label: t("phone"),           value: client.phone || "—" },
    { label: t("email"),           value: client.email },
    { label: t("monthlyIncome"),   value: formatZAR(client.monthlyIncome) },
    { label: t("monthlyExpenses"), value: formatZAR(client.monthlyExpenses) },
  ]

  return (
    <div className="mb-6 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-5 text-[var(--cf-text)]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--cf-text-secondary)]">{t("applyingAs")}</h2>
        <Link
          href="/portal/profile"
          className="text-xs underline"
          style={{ color: "#4338CA" }}
        >
          {t("updateProfile")}
        </Link>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {rows.map(({ label, value }) => (
          <div key={label}>
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
            <p className="font-semibold text-[var(--cf-text)]">{value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
