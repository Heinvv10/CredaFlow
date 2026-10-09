"use client"

import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { formatZAR, maskIdNumber } from "@/lib/utils"

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

export const PURPOSE_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "DEBT_CONSOLIDATION", label: "Debt consolidation" },
  { value: "MEDICAL",            label: "Medical" },
  { value: "EDUCATION",          label: "Education" },
  { value: "HOME_IMPROVEMENT",   label: "Home improvement" },
  { value: "VEHICLE",            label: "Vehicle" },
  { value: "BUSINESS",           label: "Business" },
  { value: "HOUSEHOLD",          label: "Household" },
  { value: "FUNERAL",            label: "Funeral" },
  { value: "OTHER",              label: "Other" },
]

export function ProfileGapWarning({ client }: { client: ClientInfo }) {
  const missing: string[] = []
  if (!client.idNumber) missing.push("SA ID number")
  if (!client.phone) missing.push("phone number")
  if (client.monthlyIncome <= 0) missing.push("monthly income")
  if (missing.length === 0) return null

  return (
    <div
      className="flex items-start gap-3 rounded-lg p-4 mb-6 text-sm"
      style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b", color: "var(--cf-text-secondary)" }}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
      <div>
        Your profile is missing: <strong>{missing.join(", ")}</strong>. We need this
        before we can process an application.{" "}
        <Link href="/portal/profile" className="underline" style={{ color: "#4338CA" }}>
          Complete your profile →
        </Link>
      </div>
    </div>
  )
}

export function ClientSummary({ client }: { client: ClientInfo }) {
  const rows: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Name",             value: `${client.firstName} ${client.lastName}` },
    { label: "SA ID Number",     value: client.idNumber ? maskIdNumber(client.idNumber) : "—" },
    { label: "Phone",            value: client.phone || "—" },
    { label: "Email",            value: client.email },
    { label: "Monthly Income",   value: formatZAR(client.monthlyIncome) },
    { label: "Monthly Expenses", value: formatZAR(client.monthlyExpenses) },
  ]

  return (
    <div className="mb-6 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-5 text-[var(--cf-text)]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--cf-text-secondary)]">Applying as</h2>
        <Link
          href="/portal/profile"
          className="text-xs underline"
          style={{ color: "#4338CA" }}
        >
          Update profile
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
