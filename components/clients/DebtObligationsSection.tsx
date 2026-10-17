"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus, Trash2 } from "lucide-react"
import {
  DEBT_ACCOUNT_TYPES,
  debtAccountTypeLabel,
  normaliseDebtAccountType,
  preserveOriginalDebtAccountType,
  captureOriginalDebtAccountTypes,
} from "@/lib/credit/debt-account-types"
import { formatRands } from "@/lib/utils"

interface DebtObligation {
  id?: string
  creditProvider: string
  accountType: string
  outstandingBalance: number
  monthlyInstalment: number
  notes?: string | null
}

interface DebtObligationsSectionProps {
  debts: DebtObligation[]
  onChange: (debts: DebtObligation[]) => void
}



export function DebtObligationsSection({ debts, onChange }: DebtObligationsSectionProps) {
  const totalMonthly = debts.reduce((sum, d) => sum + d.monthlyInstalment, 0)
  // The types as STORED, before this section rendered them canonically. The
  // stored string reaches the approval decisionFingerprint, so re-picking the
  // same meaning must round-trip byte-identical or an unrelated edit to this
  // form blocks payout on an already-approved loan.
  //
  // Keyed by row id, NOT by position: removing a row shifts every index after
  // it, so a positional key hands one row another row's original value. Rows
  // without an id are new and have no stored bytes to preserve.
  const [originalTypes] = useState<Map<string, string>>(
    () => captureOriginalDebtAccountTypes(
      debts.map((d) => ({ key: d.id, type: d.accountType })),
    ),
  )

  const addRow = () => {
    onChange([...debts, { creditProvider: "", accountType: "PERSONAL_LOAN", outstandingBalance: 0, monthlyInstalment: 0 }])
  }

  const removeRow = (index: number) => {
    onChange(debts.filter((_, i) => i !== index))
  }

  const updateRow = (index: number, field: keyof DebtObligation, value: string | number) => {
    const rowId = debts[index]?.id
    const next =
      field === "accountType" && typeof value === "string"
        ? preserveOriginalDebtAccountType(value, rowId ? originalTypes.get(rowId) : undefined)
        : value
    const updated = debts.map((d, i) => (i === index ? { ...d, [field]: next } : d))
    onChange(updated)
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Existing Debt Obligations</h3>
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
      </div>
      {debts.map((debt, index) => (
        <div key={debt.id ?? `new-${index}`} className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-3 p-3 bg-gray-50 rounded-lg items-end">
          <div>
            <Label>Credit Provider</Label>
            <Input
              value={debt.creditProvider}
              onChange={(e) => updateRow(index, "creditProvider", e.target.value)}
              placeholder="e.g. ABSA"
            />
          </div>
          <div>
            <Label>Account Type</Label>
            <Select value={normaliseDebtAccountType(debt.accountType) ?? ""} onValueChange={(v) => updateRow(index, "accountType", v)}>
              {/* An unplaceable value is named, not replaced by whatever the
                  trigger would otherwise render as a plausible answer. */}
              <SelectTrigger><SelectValue placeholder={debtAccountTypeLabel(debt.accountType)} /></SelectTrigger>
              <SelectContent>
                {DEBT_ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Balance (R)</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={debt.outstandingBalance || ""}
              onChange={(e) => updateRow(index, "outstandingBalance", parseFloat(e.target.value) || 0)}
            />
          </div>
          <div>
            <Label>Monthly (R)</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={debt.monthlyInstalment || ""}
              onChange={(e) => updateRow(index, "monthlyInstalment", parseFloat(e.target.value) || 0)}
            />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(index)} className="text-red-500">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {debts.length > 0 && (
        <div className="mt-4 p-3 bg-gray-50 rounded-lg">
          <p className="text-sm font-semibold text-gray-900">
            Total Monthly Debt Repayments: {formatRands(totalMonthly)}
          </p>
        </div>
      )}
    </div>
  )
}

export type { DebtObligation }
