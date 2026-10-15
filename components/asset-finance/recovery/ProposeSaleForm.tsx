"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import type { RemarketingBuyerType, SaleChannel } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { MoneyField } from "@/components/asset-finance/MoneyField"
import { AreaField, ChoiceField } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"
import { BUYER_TYPE_LABELS, CHANNEL_LABELS, emptySaleForm, priceBelowValuation, saleBody, type SaleForm } from "./sale-model"

export interface ValuationOption { value: string; label: string; amountCents: number }

/** Propose a sale of the listed asset (POST .../recoveries/[id]/sales). It is screened for related parties on the server. */
export function ProposeSaleForm({ recoveryId, valuations }: { recoveryId: string; valuations: ValuationOption[] }) {
  const [form, setForm] = useState<SaleForm>(() => emptySaleForm(valuations[0]?.value ?? ""))
  const { busy, error, setError, run } = useLegalAction()
  const set = <K extends keyof SaleForm>(key: K, value: SaleForm[K]) => setForm((prev) => ({ ...prev, [key]: value }))
  const below = priceBelowValuation(form, valuations.map((v) => v.amountCents))

  if (valuations.length === 0) {
    return <p className="text-sm text-[var(--cf-text-muted)]">A sale rests on an independent (not internal) valuation of the asset: record one first.</p>
  }
  const submit = async () => {
    const built = saleBody(form, below)
    if ("error" in built) return setError(built.error)
    await run(`/api/asset-finance/recoveries/${recoveryId}/sales`, built.body)
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceField id="saleChannel" label="Channel" required value={form.channel} onChange={(v) => set("channel", v as SaleChannel)}
          options={(Object.keys(CHANNEL_LABELS) as SaleChannel[]).map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
        <MoneyField id="salePrice" label="Price incl. VAT (R)" required value={form.price} onChange={(v) => set("price", v)} />
        <ChoiceField id="saleValuation" label="Independent valuation relied on" required value={form.valuationId} onChange={(v) => set("valuationId", v)} options={valuations} />
        <ChoiceField id="saleBuyerType" label="Buyer is" required value={form.buyerType} onChange={(v) => set("buyerType", v as RemarketingBuyerType)}
          options={(Object.keys(BUYER_TYPE_LABELS) as RemarketingBuyerType[]).map((t) => ({ value: t, label: BUYER_TYPE_LABELS[t] }))} />
        <TextField id="saleBuyerName" label="Buyer name" required value={form.buyerName} onChange={(v) => set("buyerName", v)} />
        <TextField id="saleBuyerId" label={form.buyerType === "ENTITY" ? "Registration number" : "ID number"} required value={form.buyerIdentifier} onChange={(v) => set("buyerIdentifier", v)} />
        <TextField id="saleBuyerVat" label="Buyer VAT number (optional)" value={form.buyerVatNumber} onChange={(v) => set("buyerVatNumber", v)} />
      </div>
      <AreaField id="saleBuyerAddress" label="Buyer address" required value={form.buyerAddress} onChange={(v) => set("buyerAddress", v)} />
      {below && (
        <AreaField id="saleBelowReason" label="Why the price is under the highest valuation" required value={form.belowValuationReason} onChange={(v) => set("belowValuationReason", v)} />
      )}
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Proposing…" : "Propose sale"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
