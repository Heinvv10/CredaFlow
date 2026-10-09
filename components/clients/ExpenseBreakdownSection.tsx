"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface ExpenseBreakdownData {
  housing: number
  transport: number
  food: number
  education: number
  insurance: number
  clothing: number
  entertainment: number
  medical: number
  other: number
  belowMleJustification?: string
}

interface ExpenseBreakdownSectionProps {
  data: ExpenseBreakdownData
  onChange: (data: ExpenseBreakdownData) => void
}

const FIELDS: { key: keyof ExpenseBreakdownData; label: string }[] = [
  { key: "housing", label: "Housing/Rent (R)" },
  { key: "transport", label: "Transport (R)" },
  { key: "food", label: "Food & Groceries (R)" },
  { key: "education", label: "Education (R)" },
  { key: "insurance", label: "Insurance (R)" },
  { key: "clothing", label: "Clothing (R)" },
  { key: "entertainment", label: "Entertainment (R)" },
  { key: "medical", label: "Medical (R)" },
  { key: "other", label: "Other (R)" },
]

export function ExpenseBreakdownSection({ data, onChange }: ExpenseBreakdownSectionProps) {
  const total = FIELDS.reduce((sum, { key }) => sum + Number(data[key] || 0), 0)

  const handleChange = (key: keyof ExpenseBreakdownData, value: string) => {
    // parseFloat, not parseInt: the input accepts step="0.01", and parseInt
    // truncates the cents in component state before randsToCents can convert
    // them. Expense amounts are hashed into the same immutable approval
    // fingerprint income feeds, so a truncated cent invalidates an approval.
    onChange({ ...data, [key]: parseFloat(value) || 0 })
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Monthly Expense Breakdown</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {FIELDS.map(({ key, label }) => (
          <div key={key}>
            <Label htmlFor={`expense_${key}`}>{label}</Label>
            <Input
              id={`expense_${key}`}
              type="number"
              step="0.01"
              min={0}
              value={data[key] || ""}
              onChange={(e) => handleChange(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="mt-4 p-3 bg-gray-50 rounded-lg">
        <p className="text-sm font-semibold text-gray-900">
          Total Monthly Expenses: R {total.toLocaleString("en-ZA")}
        </p>
      </div>
      <div className="mt-4">
        <Label htmlFor="expense_below_mle_justification">
          Below-minimum living-expense justification (when applicable)
        </Label>
        <Textarea
          id="expense_below_mle_justification"
          value={data.belowMleJustification ?? ""}
          onChange={(event) => onChange({
            ...data,
            belowMleJustification: event.target.value,
          })}
          placeholder="Required when declared living expenses are below the regulatory floor"
        />
      </div>
    </div>
  )
}

export type { ExpenseBreakdownData }
