"use client"

import { useEffect, useMemo, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { calculateLoan, type LoanCalcInput, type LoanCalcResult } from "@/lib/loan-calculator"
import { formatDate, formatZAR } from "@/lib/utils"

interface LoanProduct {
  id: string
  code: string
  name: string
  productType: string
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
}

interface LoanCalculatorProps {
  products: LoanProduct[]
  onCalculate?: (result: LoanCalcResult, productId: string, principal: number, termDays: number) => void
  initialProductId?: string
  initialAmount?: number
  initialTerm?: number
}

export function LoanCalculator({
  products,
  onCalculate,
  initialProductId,
  initialAmount,
  initialTerm,
}: LoanCalculatorProps) {
  const [selectedProductId, setSelectedProductId] = useState(initialProductId || "")
  const [principal, setPrincipal] = useState(initialAmount || 0)
  const [termDays, setTermDays] = useState(initialTerm || 0)

  const selectedProduct = products.find((p) => p.id === selectedProductId)

  const result = useMemo(() => {
    if (!selectedProduct || principal <= 0 || termDays <= 0) return null
    const input: LoanCalcInput = {
      principal,
      termDays,
      interestRatePm: selectedProduct.interestRatePm,
      productType: selectedProduct.productType,
      interestModel: selectedProduct.interestModel,
      initiationFeeModel: selectedProduct.initiationFeeModel,
      initiationFeePct: selectedProduct.initiationFeePct,
      initiationFeeMax: selectedProduct.initiationFeeMax,
      monthlyServiceFee: selectedProduct.monthlyServiceFee,
    }
    return calculateLoan(input)
  }, [selectedProduct, principal, termDays])

  useEffect(() => {
    if (result && selectedProduct && onCalculate) {
      onCalculate(result, selectedProduct.id, principal, termDays)
    }
  }, [result, selectedProduct, onCalculate, principal, termDays])

  useEffect(() => {
    if (!selectedProduct) return
    Promise.resolve().then(() => {
      if (principal < selectedProduct.minAmount) setPrincipal(selectedProduct.minAmount)
      else if (principal > selectedProduct.maxAmount) setPrincipal(selectedProduct.maxAmount)
      if (termDays < selectedProduct.minTermDays) setTermDays(selectedProduct.minTermDays)
      else if (termDays > selectedProduct.maxTermDays) setTermDays(selectedProduct.maxTermDays)
    })
  }, [selectedProduct, principal, termDays])

  return (
    <div className="space-y-6">
      <DataPanel title="Loan Calculator" description="Select the product, amount, and term before the compliance declarations.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="product">Loan Product</Label>
            <Select value={selectedProductId} onValueChange={setSelectedProductId}>
              <SelectTrigger>
                <SelectValue placeholder="Select product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="amount">
              Loan Amount (R){" "}
              {selectedProduct && (
                <span className="text-xs text-[var(--cf-text-muted)]">
                  ({formatZAR(selectedProduct.minAmount)} - {formatZAR(selectedProduct.maxAmount)})
                </span>
              )}
            </Label>
            <Input
              id="amount"
              type="number"
              value={principal / 100}
              onChange={(e) => setPrincipal(parseFloat(e.target.value) * 100 || 0)}
              min={selectedProduct ? selectedProduct.minAmount / 100 : 0}
              max={selectedProduct ? selectedProduct.maxAmount / 100 : 1000000}
            />
          </div>
          <div>
            <Label htmlFor="term">
              Term (days){" "}
              {selectedProduct && (
                <span className="text-xs text-[var(--cf-text-muted)]">
                  ({selectedProduct.minTermDays} - {selectedProduct.maxTermDays})
                </span>
              )}
            </Label>
            <Input
              id="term"
              type="number"
              value={termDays}
              onChange={(e) => setTermDays(parseInt(e.target.value) || 0)}
              min={selectedProduct?.minTermDays || 1}
              max={selectedProduct?.maxTermDays || 365}
            />
          </div>
        </div>

        {selectedProduct && (
          <div className="mt-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-3 text-sm text-[var(--cf-text-secondary)]">
            Interest Rate: {(selectedProduct.interestRatePm * 100).toFixed(1)}%{" "}
            per month / Model: {selectedProduct.interestModel.replace(/_/g, " ")} / Initiation Fee: {selectedProduct.initiationFeeModel === "NCA_REG42" ? "per NCA Reg 42" : `${(selectedProduct.initiationFeePct * 100).toFixed(1)}%`}
            {selectedProduct.initiationFeeMax > 0 && ` (max ${formatZAR(selectedProduct.initiationFeeMax)})`}
          </div>
        )}
      </DataPanel>

      {result && (
        <DataPanel title="Loan Summary" description="Projected cost of credit before final credit decision.">
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Principal" value={formatZAR(result.principal)} />
            <Metric label="Total Interest" value={formatZAR(result.totalInterest)} />
            <Metric label="Initiation Fee" value={formatZAR(result.initiationFee)} />
            <Metric label="Total Repayable" value={formatZAR(result.totalRepayable)} highlight />
          </div>

          <h4 className="mb-3 text-sm font-semibold text-[var(--cf-text)]">Repayment Schedule</h4>
          <div className="max-h-64 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Principal</TableHead>
                  <TableHead>Interest</TableHead>
                  <TableHead>Fees</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.schedule.map((item) => (
                  <TableRow key={item.installmentNo}>
                    <TableCell>{item.installmentNo}</TableCell>
                    <TableCell>{formatDate(item.dueDate)}</TableCell>
                    <TableCell>{formatZAR(item.principalDue)}</TableCell>
                    <TableCell>{formatZAR(item.interestDue)}</TableCell>
                    <TableCell>{formatZAR(item.feesDue)}</TableCell>
                    <TableCell className="font-medium">{formatZAR(item.totalDue)}</TableCell>
                    <TableCell>{formatZAR(item.closingBalance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DataPanel>
      )}
    </div>
  )
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.1)]" : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]"}`}>
      <p className={`text-sm ${highlight ? "text-[var(--cf-brand-soft)]" : "text-[var(--cf-text-muted)]"}`}>{label}</p>
      <p className="text-xl font-semibold text-[var(--cf-text)]">{value}</p>
    </div>
  )
}
