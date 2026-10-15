"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { ChoiceField } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import { emptyRefundForm, refundBody, REFUND_DOC_LABELS, type RefundDocType, type RefundForm as Form } from "./refund-model"

/** Create the surplus refund (multipart POST .../recoveries/[id]/refund): the account, evidenced by the bank's confirmation. */
export function RefundForm({ recoveryId }: { recoveryId: string }) {
  const [form, setForm] = useState<Form>(emptyRefundForm)
  const { busy, error, setError, run } = useLegalAction()
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }))

  const submit = async () => {
    const built = refundBody(form)
    if ("error" in built) return setError(built.error)
    await run(`/api/asset-finance/recoveries/${recoveryId}/refund`, built.body)
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="refundHolder" label="Account holder" required value={form.accountHolder} onChange={(v) => set("accountHolder", v)} />
        <TextField id="refundBank" label="Bank" required value={form.bankName} onChange={(v) => set("bankName", v)} />
        <TextField id="refundBranch" label="Branch code" required inputMode="numeric" value={form.branchCode} onChange={(v) => set("branchCode", v)} />
        <TextField id="refundAccount" label="Account number" required inputMode="numeric" value={form.accountNumber} onChange={(v) => set("accountNumber", v)} />
        <ChoiceField id="refundDocType" label="Bank verification is a" required value={form.docType} onChange={(v) => set("docType", v as RefundDocType)}
          options={(Object.keys(REFUND_DOC_LABELS) as RefundDocType[]).map((t) => ({ value: t, label: REFUND_DOC_LABELS[t] }))} />
        <div className="space-y-1.5">
          <Label htmlFor="refundFile" className="text-xs text-[var(--cf-text-secondary)]">Bank confirmation (PDF, JPEG, PNG or WebP) *</Label>
          <Input id="refundFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => set("file", e.target.files?.[0] ?? null)} />
        </div>
      </div>
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Creating…" : "Create refund"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
