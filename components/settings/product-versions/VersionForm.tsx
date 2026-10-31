"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { currencySymbol } from "@/lib/jurisdiction/money"
import { Label } from "@/components/ui/label"
import { FREQUENCIES, GRACE_KINDS, STRUCTURES, type Frequency, type GraceKind, type RepaymentStructure } from "@/lib/product-engine/types"
import { FREQUENCY_LABEL, GRACE_LABEL, STRUCTURE_LABEL } from "./labels"
import { api, controlClass, type ChangeRow, type EngineOverview, type ProductRow } from "./types"

/** What the form edits: text and numbers as typed (rand, percent), turned into the stored payload on submit. */
interface FormState {
  productId: string
  effectiveFrom: string
  reason: string
  minAmount: string
  maxAmount: string
  minTermDays: string
  maxTermDays: string
  ratePct: string
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  feeModel: "FLAT_PCT" | "NCA_REG42"
  feePct: string
  feeMax: string
  serviceFee: string
  structured: boolean
  frequency: Frequency
  structure: RepaymentStructure
  graceKind: GraceKind
  graceInstalments: string
  collateral: string
  minAge: string
  maxAge: string
  minIncome: string
  minEmploymentMonths: string
}

const cents = (rand: string) => Math.round(Number(rand) * 100)
const optionalInt = (text: string) => (text.trim() === "" ? null : Number(text))

/** The form's starting point: the version in effect for the product, else the product's own row. */
function initialState(product: ProductRow, overview: EngineOverview): FormState {
  const current = overview.versions.find((v) => v.productId === product.id && v.status === "IN_EFFECT")?.config
  const r = current?.repayment
  const tomorrow = new Date(Date.parse(`${overview.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return {
    productId: product.id, effectiveFrom: tomorrow, reason: "",
    minAmount: String((current?.minAmountCents ?? product.minAmount) / 100), maxAmount: String((current?.maxAmountCents ?? product.maxAmount) / 100),
    minTermDays: String(current?.minTermDays ?? product.minTermDays), maxTermDays: String(current?.maxTermDays ?? product.maxTermDays),
    ratePct: String(Math.round((current?.interestRatePm ?? product.interestRatePm) * 10_000) / 100), interestModel: current?.interestModel ?? product.interestModel,
    feeModel: current?.initiationFeeModel ?? product.initiationFeeModel, feePct: String(Math.round((current?.initiationFeePct ?? product.initiationFeePct) * 10_000) / 100),
    feeMax: String((current?.initiationFeeMaxCents ?? product.initiationFeeMax) / 100), serviceFee: String((current?.monthlyServiceFeeCents ?? product.monthlyServiceFee) / 100),
    structured: r !== undefined && r !== null, frequency: r?.frequency ?? "MONTHLY", structure: r?.structure ?? "AMORTISING", graceKind: r?.graceKind ?? "NONE", graceInstalments: String(r?.graceInstalments ?? 0),
    collateral: (current?.collateral ?? []).map((c) => `${c.code} | ${c.description} | ${c.required ? "required" : "optional"}`).join("\n"),
    minAge: String(current?.eligibility.minAge ?? ""), maxAge: String(current?.eligibility.maxAge ?? ""),
    minIncome: current?.eligibility.minMonthlyIncomeCents != null ? String(current.eligibility.minMonthlyIncomeCents / 100) : "", minEmploymentMonths: String(current?.eligibility.minEmploymentMonths ?? ""),
  }
}

function toPayload(s: FormState) {
  const collateral = s.collateral.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [code = "", description = "", flag = "required"] = line.split("|").map((p) => p.trim())
    return { code, description, required: flag.toLowerCase() !== "optional" }
  })
  return {
    productId: s.productId, effectiveFrom: s.effectiveFrom, reason: s.reason.trim(),
    config: {
      minAmountCents: cents(s.minAmount), maxAmountCents: cents(s.maxAmount), minTermDays: Number(s.minTermDays), maxTermDays: Number(s.maxTermDays),
      interestRatePm: Math.round(Number(s.ratePct) * 100) / 10_000, interestModel: s.interestModel, initiationFeeModel: s.feeModel,
      initiationFeePct: Math.round(Number(s.feePct) * 100) / 10_000, initiationFeeMaxCents: cents(s.feeMax), monthlyServiceFeeCents: cents(s.serviceFee),
      repayment: s.structured && s.interestModel !== "DAILY_ACCRUAL" ? { frequency: s.frequency, structure: s.structure, graceKind: s.graceKind, graceInstalments: s.graceKind === "NONE" ? 0 : Number(s.graceInstalments) } : null,
      collateral,
      eligibility: { minAge: optionalInt(s.minAge), maxAge: optionalInt(s.maxAge), minMonthlyIncomeCents: s.minIncome.trim() === "" ? null : cents(s.minIncome), minEmploymentMonths: optionalInt(s.minEmploymentMonths) },
    },
  }
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label>{children}</div>
}

/** Proposes a new version of a product: saved as a change request and submitted for a second person's approval. */
export function VersionForm({ overview, product, onDone, onCancel }: { overview: EngineOverview; product: ProductRow; onDone: () => void; onCancel: () => void }) {
  const [s, setS] = useState<FormState>(() => initialState(product, overview))
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [done, setDone] = useState<string | null>(null)
  const symbol = currencySymbol(overview.currency)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setS((cur) => ({ ...cur, [key]: value }))
  const text = (key: keyof FormState, id: string, label: string, props: { type?: string } = {}) => (
    <Field id={id} label={label}><Input id={id} type={props.type} value={String(s[key])} onChange={(e) => set(key, e.target.value as never)} /></Field>
  )

  async function submit() {
    setBusy(true)
    setProblems([])
    const title = `${product.code}: new version from ${s.effectiveFrom}`
    const created = await api<{ request: ChangeRow }>("/api/maker-checker", "POST", { kind: "PRODUCT_VERSION", title, payload: toPayload(s) })
    if (!created.ok || !created.data) {
      setBusy(false)
      setProblems(created.problems.length > 0 ? created.problems : [created.error ?? "Could not save."])
      return
    }
    const submitted = await api(`/api/maker-checker/${created.data.request.id}/submit`, "POST", {})
    setBusy(false)
    if (!submitted.ok) {
      // A draft the submit refused is withdrawn, so a refused proposal leaves nothing behind to resubmit by mistake.
      await api(`/api/maker-checker/${created.data.request.id}/withdraw`, "POST", {})
      setProblems(submitted.problems.length > 0 ? submitted.problems : [submitted.error ?? "Could not submit."])
      return
    }
    setDone("Submitted. A second person approves it under Approvals; it takes effect on the date you chose or the day it is approved, whichever is later.")
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New version of {product.name} ({product.code})</CardTitle>
        <CardDescription>
          The whole configuration is proposed as one version with an effective date. Loans already written keep the version they were written on.
          {overview.nca && " This lender is under the NCA: a weekly or fortnightly structure, interest-only, a bullet or a grace period needs its legal team's sign-off of the rendered documents first, and rates and fees are held to the statutory caps."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2">
          {text("effectiveFrom", "pv-date", "Effective from", { type: "date" })}
          {text("reason", "pv-reason", "Why the product changes (for the approver)")}
        </div>
        <fieldset className="space-y-3" aria-label="Limits"><legend className="font-semibold">Limits</legend>
          <div className="grid gap-3 md:grid-cols-4">
            {text("minAmount", "pv-minamt", `Minimum amount (${symbol})`)}{text("maxAmount", "pv-maxamt", `Maximum amount (${symbol})`)}
            {text("minTermDays", "pv-minterm", "Shortest term (days)")}{text("maxTermDays", "pv-maxterm", "Longest term (days)")}
          </div>
        </fieldset>
        <fieldset className="space-y-3" aria-label="Price"><legend className="font-semibold">Price</legend>
          <div className="grid gap-3 md:grid-cols-4">
            {text("ratePct", "pv-rate", "Interest rate (% a month)")}
            <Field id="pv-model" label="Interest basis">
              <select id="pv-model" className={`${controlClass} w-full`} value={s.interestModel} onChange={(e) => set("interestModel", e.target.value as FormState["interestModel"])}>
                <option value="REDUCING_BALANCE">Reducing balance</option><option value="FLAT">Flat</option><option value="DAILY_ACCRUAL">Daily accrual (single payment)</option>
              </select>
            </Field>
            {text("feePct", "pv-fee", "Initiation fee (% of principal)")}{text("feeMax", "pv-feemax", `Initiation fee cap (${symbol}, 0 = none)`)}
            {text("serviceFee", "pv-svc", `Monthly service fee (${symbol})`)}
          </div>
        </fieldset>
        <fieldset className="space-y-3" aria-label="Repayment"><legend className="font-semibold">Repayment</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.structured} disabled={s.interestModel === "DAILY_ACCRUAL"} onChange={(e) => set("structured", e.target.checked)} />
            Set a repayment structure (otherwise the product keeps its single payment or monthly instalments)
          </label>
          {s.structured && s.interestModel !== "DAILY_ACCRUAL" && (
            <div className="grid gap-3 md:grid-cols-4">
              <Field id="pv-freq" label="Frequency">
                <select id="pv-freq" className={`${controlClass} w-full`} value={s.frequency} onChange={(e) => set("frequency", e.target.value as Frequency)}>{FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}</select>
              </Field>
              <Field id="pv-struct" label="Structure">
                <select id="pv-struct" className={`${controlClass} w-full`} value={s.structure} onChange={(e) => set("structure", e.target.value as RepaymentStructure)}>{STRUCTURES.map((x) => <option key={x} value={x}>{STRUCTURE_LABEL[x]}</option>)}</select>
              </Field>
              <Field id="pv-grace" label="Grace">
                <select id="pv-grace" className={`${controlClass} w-full`} value={s.graceKind} onChange={(e) => set("graceKind", e.target.value as GraceKind)}>{GRACE_KINDS.map((g) => <option key={g} value={g}>{GRACE_LABEL[g]}</option>)}</select>
              </Field>
              {s.graceKind !== "NONE" && text("graceInstalments", "pv-graceper", "Grace periods")}
            </div>
          )}
        </fieldset>
        <fieldset className="space-y-3" aria-label="Collateral and eligibility"><legend className="font-semibold">Collateral and eligibility</legend>
          <Field id="pv-coll" label="Collateral requirements, one per line: CODE | description | required or optional">
            <textarea id="pv-coll" rows={3} className={`${controlClass} h-auto w-full py-2`} value={s.collateral} onChange={(e) => set("collateral", e.target.value)} />
          </Field>
          <div className="grid gap-3 md:grid-cols-4">
            {text("minAge", "pv-minage", "Minimum age")}{text("maxAge", "pv-maxage", "Maximum age")}{text("minIncome", "pv-income", `Minimum monthly income (${symbol})`)}{text("minEmploymentMonths", "pv-emp", "Minimum months employed")}
          </div>
        </fieldset>
        {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {done && <p role="status" className="text-sm text-[var(--cf-success)]">{done}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || done !== null} onClick={submit}>Submit for approval</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Close</Button>
        </div>
      </CardContent>
    </Card>
  )
}
