"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

const ACCOUNT_TYPES = { "": "Not specified", CHEQUE: "Cheque / current", SAVINGS: "Savings", TRANSMISSION: "Transmission" }
type AccountType = keyof typeof ACCOUNT_TYPES

/** `url`: the request route; default the supplier's (the dealer pages pass their own). */
export function BankAccountRequestForm({ supplierId, hasApproved, url }: { supplierId: string; hasApproved: boolean; url?: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [bankName, setBankName] = useState("")
  const [branchCode, setBranchCode] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [accountHolder, setAccountHolder] = useState("")
  const [accountType, setAccountType] = useState<AccountType>("")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {hasApproved ? "Request a change of bank account" : "Capture bank account"}
      </Button>
    )
  }

  const submit = async () => {
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(url ?? `/api/asset-finance/suppliers/${supplierId}/bank-accounts`, "POST", {
      bankName, branchCode, accountNumber, accountHolder, accountType: accountType || null,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setOpen(false)
    setBankName(""); setBranchCode(""); setAccountNumber(""); setAccountHolder(""); setAccountType("")
    router.refresh()
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">New bank account request</h3>
      <p className="text-xs text-[var(--cf-text-muted)]">
        The account cannot be paid into until a different user approves it.
      </p>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <TextField id="bankName" label="Bank" required value={bankName} onChange={setBankName} error={fields.bankName} />
        <TextField id="branchCode" label="Branch code" required inputMode="numeric" value={branchCode} onChange={setBranchCode} error={fields.branchCode} />
        <TextField id="accountNumber" label="Account number" required inputMode="numeric" value={accountNumber} onChange={setAccountNumber} error={fields.accountNumber} />
        <TextField id="accountHolder" label="Account holder" required value={accountHolder} onChange={setAccountHolder} error={fields.accountHolder} />
        <SelectField id="accountType" label="Account type" value={accountType} onChange={setAccountType} options={ACCOUNT_TYPES} error={fields.accountType} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? "Saving…" : "Submit for approval"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  )
}
