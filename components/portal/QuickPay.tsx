"use client"

import { Copy } from "lucide-react"
import { toast } from "@/lib/toast"

interface QuickPayProps {
  loanReference: string
  bankName: string
  /** The lender's `identity.legalName`. */
  accountHolder: string
  bankAccountNumber: string
  bankBranchCode: string
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.copied(),
    () => toast.error("Failed to copy")
  )
}

export function QuickPay({
  loanReference,
  bankName,
  accountHolder,
  bankAccountNumber,
  bankBranchCode,
}: QuickPayProps) {
  const allDetails = [
    `Bank: ${bankName}`,
    `Account holder: ${accountHolder}`,
    `Account number: ${bankAccountNumber}`,
    `Branch code: ${bankBranchCode}`,
    `Reference: ${loanReference}`,
  ].join("\n")

  const rows: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Bank", value: bankName },
    { label: "Account holder", value: accountHolder },
    { label: "Account number", value: bankAccountNumber },
    { label: "Branch code", value: bankBranchCode },
    { label: "Reference", value: loanReference, bold: true },
  ]

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-5 py-3">
        <p className="text-sm font-semibold text-[var(--cf-text)]">
          EFT Payment Details
        </p>
      </div>

      {/* Details */}
      <div className="p-5 space-y-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between"
          >
            <span className="text-xs text-gray-500">{row.label}</span>
            <div className="flex items-center gap-2">
              <span
                className={`text-sm text-gray-900 ${row.bold ? "font-bold text-base" : ""}`}
                style={row.bold ? { color: "#4338CA" } : undefined}
              >
                {row.value}
              </span>
              {row.bold && (
                <button
                  onClick={() => copyToClipboard(row.value)}
                  className="p-1 rounded hover:bg-gray-100 transition-colors"
                  title="Copy reference"
                >
                  <Copy className="w-4 h-4 text-gray-400" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Copy all */}
      <div className="px-5 pb-4">
        <button
          onClick={() => copyToClipboard(allDetails)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-semibold transition-colors hover:bg-amber-50/50"
          style={{ borderColor: "#4338CA", color: "#4338CA" }}
        >
          <Copy className="w-4 h-4" />
          Copy all details
        </button>
      </div>
    </div>
  )
}
